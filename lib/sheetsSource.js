// ชุดข้อมูลที่เหลือ (แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ) เอามาจากไหน
//
// หมายเหตุ: พนักงานถอยกลับไปใช้ชีท DATA ผ่าน Apps Script แล้ว (ดู pages/api/stock-gas.js)
// readEmployees/saveEmployee ข้างล่างเหลือไว้ให้ host-server กับสคริปต์ย้ายข้อมูลใช้เท่านั้น
//
//   SHEETS_SOURCE = sheet (ค่าเริ่มต้น) | sql
//
// โหมด sql มีสองทางไปถึงฐาน InventoryNarai ลองตามลำดับนี้:
//   1) ต่อ SQL ตรงจาก Vercel (lib/qcrdPool.js) — เร็วที่สุด ใช้เมื่อ SQL เปิดพอร์ตออกเน็ตให้ต่อได้
//      และตั้งรหัสฐาน (QCRD_DB_USER/PASSWORD หรือ ZK_DB_/HR_DB_) ไว้แล้ว
//   2) host API /sheets/* (host-server/sheets-db.js) — สำหรับตอนที่ SQL ไม่ได้เปิดออกเน็ต
//      วิ่งผ่าน tunnel ที่เครื่องออฟฟิศเปิดขาออกไว้ จึงไม่ต้องแตะ router เลย
//      ตั้ง SHEETS_API_BASE (ไม่ตั้ง = ใช้ QCRD_API_BASE / STORE_API_BASE) และกุญแจเขียนสำหรับฝั่งเขียน
//
// ที่ร้านตอนนี้ใช้ทางที่ 2 เพราะ probe แล้วพบว่า SQL ไม่ได้เปิดพอร์ตออกเน็ตสักตัว
// (ดู docs/sheets-sql-migration.md) แต่ถ้าวันหลังเปิดพอร์ตได้ โค้ดจะสลับไปทางที่ 1 ให้เองทันที
//
// ฝั่งอ่าน ถ้าไปไม่ถึงฐานจะถอยไปอ่านชีทให้ พร้อมแนบ warning (หน้าเว็บยังทำงานต่อได้)
// ฝั่งเขียนไม่ถอยไปชีท — เขียนสองที่สลับกันแปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น
import { isConfigured as hasDirectDb, describeTarget, runQuery } from './qcrdPool';
import { createSheets } from './sheetsSql.mjs';

export { hasDirectDb, describeTarget };

export const SHEETS_API_BASE = (
  process.env.SHEETS_API_BASE || process.env.QCRD_API_BASE || process.env.STORE_API_BASE ||
  'https://api.khanoykorshabu.com'
).replace(/\/+$/, '');

export const sheetsSource = () => (String(process.env.SHEETS_SOURCE || '').toLowerCase() === 'sql' ? 'sql' : 'sheet');

/** เปิดโหมด sql ไว้ไหม — ทางไปถึงฐานเลือกให้เองทีหลัง (ต่อตรง หรือ host API) */
export const usingSql = () => sheetsSource() === 'sql';

/** ทางที่จะใช้จริงในโหมด sql — ไว้บอกในข้อความ error/log */
export const sqlRoute = () =>
  (hasDirectDb() ? `ต่อ SQL ตรง (${describeTarget()})` : `host API (${SHEETS_API_BASE})`);

/** ตรรกะชุดเดียวกับที่ host-server ใช้ ผูกกับ pool ของ Vercel */
const direct = createSheets({ q: runQuery });

/** เรียก host API ฝั่งอ่าน */
async function getFromHost(path, { timeoutMs = 20000 } = {}) {
  const res = await fetch(`${SHEETS_API_BASE}/sheets/${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error(
      `host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server ที่เครื่องออฟฟิศรันอยู่ไหม ` +
      'และเป็นเวอร์ชันที่มี /sheets/* แล้วหรือยัง (git pull แล้วรีสตาร์ท)');
  }
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

/** เรียก host API ฝั่งเขียน — ต้องมีกุญแจให้ตรงกับเครื่องโฮสต์ */
async function postToHost(body, { timeoutMs = 60000 } = {}) {
  const key = process.env.SHEETS_WRITE_KEY || process.env.QCRD_WRITE_KEY || '';
  if (!key) {
    throw new Error(
      'โหมด SQL ยังเขียนไม่ได้ — ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (ต่อ SQL ตรง) ' +
      'หรือ SHEETS_WRITE_KEY/QCRD_WRITE_KEY ให้ตรงกับเครื่องโฮสต์ (ผ่าน host API) อย่างใดอย่างหนึ่งบน Vercel');
  }
  const res = await fetch(`${SHEETS_API_BASE}/sheets/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

/* ------------------------------- ฝั่งอ่าน ------------------------------- */

export const readPlan = () =>
  (hasDirectDb() ? direct.readPlan() : getFromHost('plan'));

export const readClosing = (branchKey) =>
  (hasDirectDb() ? direct.readClosing(branchKey) : getFromHost(`closing?branch=${encodeURIComponent(branchKey)}`));

export const readExpenseRefs = () =>
  (hasDirectDb() ? direct.readExpenseRefs() : getFromHost('expense-ref'));

export const readExpenses = () =>
  (hasDirectDb() ? direct.readExpenses() : getFromHost('expense'));

// หน้าเว็บไม่ได้เรียกตัวนี้แล้ว — เหลือไว้ให้ host API /sheets/employee กับสคริปต์ย้ายข้อมูล
export const readEmployees = () =>
  (hasDirectDb() ? direct.readEmployees() : getFromHost('employee'));

/* ------------------------------- ฝั่งเขียน ------------------------------- */

/** body เดียวกับที่เคยส่งไป Apps Script ทุกช่อง — action = saveOtherExpense | bulkImport | deleteExpenseByMonth | saveEmployee */
export async function saveSheets(action, body) {
  if (hasDirectDb()) {
    const fn = direct.actions[action];
    if (!fn) throw new Error(`unknown action: ${action}`);
    return fn(body);
  }
  return postToHost({ ...body, action });
}

export const saveOtherExpense = (body) => saveSheets('saveOtherExpense', body);
export const bulkImportExpenses = (body) => saveSheets('bulkImport', body);
export const deleteExpenseByMonth = (body) => saveSheets('deleteExpenseByMonth', body);
export const saveEmployee = (body) => saveSheets('saveEmployee', body);
