// ชุดข้อมูลที่เหลือ (แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ) เอามาจากไหน
//
// ท้ายไฟล์มี "เวลาสแกนนิ้วที่แก้ด้วยมือ" (dbo.attendance_edit) พ่วงมาด้วย เพราะอยู่ฐาน
// InventoryNarai เดียวกัน จึงใช้ทางไปถึงฐาน/กุญแจเขียนชุดเดียวกันเป๊ะ ต่างกันแค่ไม่มีชีทให้ถอยกลับ
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
import { isUnreachable, directDown, markDirectDown, clearDirectDown } from './directRoute';
import { createSheets } from './sheetsSql.mjs';
import { createScanEdits } from './scanEditSql.mjs';
import { createMonthEnd } from './monthEndSql.mjs';

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

/** เวลาสแกนที่แก้ด้วยมือ (dbo.attendance_edit) — อยู่ฐานเดียวกัน ใช้ทางไปถึงฐานชุดเดียวกัน */
const directScanEdits = createScanEdits({ q: runQuery });

/** ข้อมูลปิดรอบเดือน (dbo.stock_month_end) — อยู่ฐานเดียวกันอีกตัว ใช้ทางไปถึงฐานชุดเดียวกัน */
const directMonthEnd = createMonthEnd({ q: runQuery });

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

/* -------------------- ข้อมูลปิดรอบเดือน (dbo.stock_month_end) -------------------- */
//
// คนละตัวกับ dbo.stock_closing ที่ย้ายมาจากชีท — ตารางนี้มีอยู่ในฐานอยู่แล้ว หน้าเว็บแค่มาดู
// ไม่มีทางถอยไปชีท (ข้อมูลชุดนี้ไม่เคยอยู่ในชีท) แต่ถอยจาก "ต่อ SQL ตรง" ไป host API ได้
//
// ที่ร้าน SQL Server ไม่ได้เปิดพอร์ตออกเน็ต (ดู docs/sheets-sql-migration.md) แต่ Vercel
// ตั้ง QCRD_DB_USER/PASSWORD ไว้เพื่อใช้กับหน้าอื่น — hasDirectDb() จึงเป็น true และ
// การอ่านจะไปตายที่ "Failed to connect to inventory.dyndns.tv:1433 in 15000ms" ทั้งที่
// ทาง host API ใช้ได้อยู่ ตัวอ่านชุดนี้เลยลองต่อตรงก่อนแล้วถอยไป host API ให้เองเมื่อ
// ต่อไม่ติด — เฉพาะ error ที่แปลว่า "ไปไม่ถึงเครื่อง" เท่านั้น
// ส่วน error แบบตารางไม่มี/ไม่มีสิทธิ์/จับคู่คอลัมน์ไม่ได้ ต้องเด้งขึ้นไปให้คนอ่านแก้ ไม่ใช่กลบด้วยการถอย

// ตัวรู้จำ error "ไปไม่ถึงเครื่อง" กับที่จำว่าเพิ่งต่อตรงไม่ติด อยู่ที่ lib/directRoute.js
// ใช้ร่วมกับฝั่ง QC/RD — ต่อตรงพังทางหนึ่ง อีกทางจะได้ข้ามไป host API เลยโดยไม่ต้องรอ timeout ซ้ำ

// host API วิ่งผ่าน tunnel ที่เครื่องออฟฟิศ ช้ากว่าต่อตรงเป็นปกติ — ให้เวลามากกว่าค่าเริ่มต้น
// (ฟังก์ชันตั้ง maxDuration ไว้ 60 วิ ยังเหลือที่ให้รอต่อตรงก่อนหน้าอีก 15 วิ)
const MONTH_END_HOST_TIMEOUT = 40000;

/** ลองต่อ SQL ตรงก่อน ต่อไม่ติดค่อยถอยไป host API — คืนทางที่ใช้จริงมาด้วย ไว้บอกในหน้าเว็บ */
async function monthEndRead(runDirect, hostPath) {
  const hostRoute = `host API (${SHEETS_API_BASE})`;
  const fromHost = (note) => getFromHost(hostPath, { timeoutMs: MONTH_END_HOST_TIMEOUT })
    .then((data) => ({ data, route: note ? `${hostRoute} — ${note}` : hostRoute }));

  if (!hasDirectDb()) return fromHost();
  if (directDown()) return fromHost('ต่อ SQL ตรงไม่ติดเมื่อครู่ จึงข้ามมาทางนี้เลย');

  try {
    const data = await runDirect();
    clearDirectDown();
    return { data, route: `ต่อ SQL ตรง (${describeTarget()})` };
  } catch (err) {
    if (!isUnreachable(err.message)) throw err;
    markDirectDown();
    console.error(`month-end: ต่อ SQL ตรงไม่ได้ (${describeTarget()}) — ถอยไปเรียก host API:`, err.message);
    try {
      return await fromHost('ต่อ SQL ตรงไม่ได้จึงถอยมาทางนี้');
    } catch (hostErr) {
      // พังทั้งสองทาง — บอกทั้งคู่ ไม่งั้นจะเห็นแค่ทางหลังแล้วไล่ผิดจุด
      throw new Error(
        `ต่อ SQL ตรงไม่ได้: ${err.message}\n` +
        `→ ถอยไปเรียก ${hostRoute} ก็ไม่ได้: ${hostErr.message}`);
    }
  }
}

/** สรุปรายสาขา: ปิดยอดรอบล่าสุดถึงวันไหน (หน้าแรกของเมนู "ดูข้อมูลปิดรอบเดือน") */
export async function readMonthEndSummary() {
  const { data, route } = await monthEndRead(
    () => directMonthEnd.readMonthEndSummary(), 'month-end-summary');
  return { ...data, source: route };
}

/** แถวปิดรอบของเดือนหนึ่ง (ไม่ระบุเดือน = เดือนล่าสุดที่มีข้อมูล) */
export async function readMonthEnd({ month, branch } = {}) {
  const p = new URLSearchParams();
  if (month) p.set('month', month);
  if (branch) p.set('branch', branch);
  const qs = p.toString();
  const { data, route } = await monthEndRead(
    () => directMonthEnd.readMonthEnd({ month, branch }),
    `month-end${qs ? `?${qs}` : ''}`);
  return { ...data, source: route };
}

/** เดือนที่มีข้อมูลปิดรอบ ('YYYY-MM' ใหม่ก่อน) */
export async function readMonthEndMonths() {
  const { data } = await monthEndRead(() => directMonthEnd.readMonthEndMonths(), 'month-end-months');
  return data;
}

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

/* ------------------- แก้เวลาสแกนนิ้ว (dbo.attendance_edit) ------------------- */
//
// ไม่มีทางถอยไปชีท — ข้อมูลชุดนี้ไม่เคยอยู่ในชีท เกิดจากการกดแก้บนหน้าเว็บโดยตรง
// ต่อฐานไม่ได้ = หน้า "ดูสแกนหน้า" แสดงเวลาสแกนดิบตามปกติ แล้วขึ้นหมายเหตุว่าอ่านตัวแก้ไม่ได้

/** เวลาที่ถูกแก้ไว้ในช่วงวันที่ (แถวล่าสุดของแต่ละช่อง) */
export const readScanEdits = ({ start, end, branch }) => {
  if (hasDirectDb()) return directScanEdits.readScanEdits({ start, end, branch });
  const p = new URLSearchParams({ start, end });
  if (branch) p.set('branch', branch);
  return getFromHost(`scan-edit?${p.toString()}`);
};

/** ประวัติการแก้ของคนหนึ่งในวันหนึ่ง (ทุกครั้งที่กดบันทึก) */
export const readScanEditHistory = ({ date, empCode }) => {
  if (hasDirectDb()) return directScanEdits.readScanEditHistory({ date, empCode });
  const p = new URLSearchParams({ date, emp: empCode });
  return getFromHost(`scan-edit-history?${p.toString()}`);
};

/** บันทึกการแก้หนึ่งช่อง — เป็นการบันทึกแถวใหม่เสมอ ไม่ทับของเดิม */
export const saveScanEdit = (body) => {
  if (hasDirectDb()) return directScanEdits.actions.saveScanEdit(body);
  return postToHost({ ...body, action: 'saveScanEdit' });
};
