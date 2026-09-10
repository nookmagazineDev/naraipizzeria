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
// ทั้งอ่านและเขียน ถ้าทางที่ 1 ต่อไม่ติดจะถอยไปทางที่ 2 ให้เอง (ปลายทางเป็นฐานตัวเดียวกัน)
// ฝั่งอ่าน ถ้าไปไม่ถึงฐานทั้งสองทาง ตัวเรียกจะถอยไปอ่านชีทต่อ พร้อมแนบ warning (หน้าเว็บยังทำงานต่อได้)
// ฝั่งเขียนไม่ถอยไปชีท — เขียนลงชีทบ้างลงฐานบ้าง แปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น
import { isConfigured as hasDirectDb, describeTarget, runQuery } from './qcrdPool';
import { isUnreachable, directDown, markDirectDown, clearDirectDown, explainHostError } from './directRoute';
import { createSheets } from './sheetsSql.mjs';
import { createScanEdits } from './scanEditSql.mjs';
import { createMonthEnd, cycleMonth, CYCLE_PREV_MONTH_UNTIL_DAY } from './monthEndSql.mjs';
import { createBranches } from './branchSql.mjs';
import { createStockCount } from './stockCountSql.mjs';

export { hasDirectDb, describeTarget };

export const SHEETS_API_BASE = (
  process.env.SHEETS_API_BASE || process.env.QCRD_API_BASE || process.env.STORE_API_BASE ||
  'https://api.khanoykorshabu.com'
).replace(/\/+$/, '');

export const sheetsSource = () => (String(process.env.SHEETS_SOURCE || '').toLowerCase() === 'sql' ? 'sql' : 'sheet');

/** เปิดโหมด sql ไว้ไหม — ทางไปถึงฐานเลือกให้เองทีหลัง (ต่อตรง หรือ host API) */
export const usingSql = () => sheetsSource() === 'sql';

/** ทางที่จะใช้จริงในโหมด sql — ไว้บอกในข้อความ error/log (ต่อตรงไม่ติดจะถอยไป host API ให้เอง) */
export const sqlRoute = () =>
  (hasDirectDb() && !directDown()
    ? `ต่อ SQL ตรง (${describeTarget()}) แล้วถอยไป host API (${SHEETS_API_BASE}) ถ้าต่อไม่ติด`
    : `host API (${SHEETS_API_BASE})`);

/** ตรรกะชุดเดียวกับที่ host-server ใช้ ผูกกับ pool ของ Vercel */
const direct = createSheets({ q: runQuery });

/** เวลาสแกนที่แก้ด้วยมือ (dbo.attendance_edit) — อยู่ฐานเดียวกัน ใช้ทางไปถึงฐานชุดเดียวกัน */
const directScanEdits = createScanEdits({ q: runQuery });

/** ข้อมูลปิดรอบเดือน (dbo.stock_month_end) — อยู่ฐานเดียวกันอีกตัว ใช้ทางไปถึงฐานชุดเดียวกัน */
const directMonthEnd = createMonthEnd({ q: runQuery });

/** ทะเบียนสาขา (dbo.hr_branch) — ฐานเดียวกันอีกตัว ทุกหน้าที่มี dropdown สาขากินข้อมูลชุดนี้ */
const directBranches = createBranches({ q: runQuery });

/** หน้านับสต๊อก (dbo.stock_count/stock_balance/stock_request) — ฐานเดียวกัน ดู lib/stockCountSql.mjs */
const directStock = createStockCount({ q: runQuery });

/** เรียก host API ฝั่งอ่าน */
async function getFromHost(path, { timeoutMs = 20000 } = {}) {
  const res = await fetch(`${SHEETS_API_BASE}/sheets/${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  }).catch((err) => { throw explainHostError(err, { base: SHEETS_API_BASE, timeoutMs }); });
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
  }).catch((err) => { throw explainHostError(err, { base: SHEETS_API_BASE, timeoutMs }); });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

/* --------------------- เลือกทาง: ต่อตรงก่อน ไม่ติดค่อยถอยไป host API --------------------- */
//
// ที่ร้าน SQL Server ไม่ได้เปิดพอร์ตออกเน็ต แต่บน Vercel ตั้ง QCRD_DB_USER/PASSWORD ไว้ใช้กับ
// หน้าอื่น hasDirectDb() จึงเป็น true เสมอ — ถ้าเลือกทางด้วย hasDirectDb() เฉย ๆ ทุกคำสั่งจะไปตายที่
// "ต่อ SQL Server (inventory.dyndns.tv:1433/InventoryNarai) ไม่ได้: Failed to connect ... in 8000ms"
// ทั้งที่ทาง host API (tunnel ขาออกของเครื่องออฟฟิศ) ยังใช้ได้อยู่ — อาการที่หน้า "ค่าใช้จ่ายอื่นๆ"
// กรอกแล้วกดบันทึกไม่ขึ้น เพราะฝั่งเขียนห้ามถอยไปชีท เลยเด้ง error ออกมาอย่างเดียว
//
// ถอยเฉพาะ error ที่แปลว่า "ไปไม่ถึงเครื่อง" เท่านั้น — ตารางไม่มี/ไม่มีสิทธิ์/ข้อมูลไม่ถูก
// ต้องเด้งขึ้นไปให้คนอ่านแก้ ห้ามกลบด้วยการถอย
//
// ทั้งสองทางเขียน/อ่านฐาน InventoryNarai ตัวเดียวกัน (host-server/sheets-db.js ใช้ createSheets
// ชุดเดียวกันนี้) การถอยจึงไม่ทำให้ข้อมูลไปอยู่คนละที่ — ต่างจากการถอยไปชีทที่ห้ามทำ

/** ลองต่อ SQL ตรงก่อน ต่อไม่ติดค่อยถอยไป host API — คืนทางที่ใช้จริงมาด้วย ไว้บอกในหน้าเว็บ/log */
export async function viaDirectOrHost(label, runDirect, runHost) {
  const hostRoute = `host API (${SHEETS_API_BASE})`;
  const fromHost = async (note) => ({
    data: await runHost(),
    route: note ? `${hostRoute} — ${note}` : hostRoute,
  });

  if (!hasDirectDb()) return fromHost();
  if (directDown()) return fromHost('ต่อ SQL ตรงไม่ติดเมื่อครู่ จึงข้ามมาทางนี้เลย');

  try {
    const data = await runDirect();
    clearDirectDown();
    return { data, route: `ต่อ SQL ตรง (${describeTarget()})` };
  } catch (err) {
    if (!isUnreachable(err.message)) throw err;
    markDirectDown();
    console.error(`sheets ${label}: ต่อ SQL ตรงไม่ได้ (${describeTarget()}) — ถอยไปเรียก host API:`, err.message);
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

/** เหมือน viaDirectOrHost แต่คืนแค่ข้อมูล (ตัวเรียกส่วนใหญ่ไม่ได้ใช้ชื่อทาง) */
const pickRoute = async (label, runDirect, runHost) =>
  (await viaDirectOrHost(label, runDirect, runHost)).data;

/* ------------------------------- ฝั่งอ่าน ------------------------------- */

export const readPlan = () =>
  pickRoute('อ่านแพลนสั่งของ', () => direct.readPlan(), () => getFromHost('plan'));

export const readClosing = (branchKey) =>
  pickRoute('อ่านยอดปิดรอบ', () => direct.readClosing(branchKey),
    () => getFromHost(`closing?branch=${encodeURIComponent(branchKey)}`));

/* ---------------------- หน้านับสต๊อกและขอเบิก (ยอดนับจริงของสาขา) ---------------------- */
//
// ต่างจากชุดอื่นในไฟล์นี้ตรงที่ "ไม่มีชีทให้ถอยกลับแล้ว" — หน้าสาขา (narai-branch.vercel.app/stock/list)
// ย้ายทั้งอ่านและเขียนไปอยู่บน SQL ตั้งแต่กลางปี ชีท 'ข้อมูลนับสตอค' จึงไม่มียอดนับใหม่เข้าอีกเลย
// ฝั่งนี้ถ้ายังอ่านชีทอยู่จะเห็นข้อมูลค้างอยู่เดือนสิงหา ทั้งที่สาขานับกันทุกวัน
// จึงตั้งค่าเริ่มต้นเป็นอ่าน SQL (ตั้ง STOCK_SOURCE=sheet เพื่อกลับไปอ่านชีทชั่วคราวได้)

/** หน้านับสต๊อกอ่านจาก SQL ไหม (ค่าเริ่มต้น = อ่าน) */
export const usingStockSql = () => String(process.env.STOCK_SOURCE || 'sql').toLowerCase() !== 'sheet';

export const readStockItems = (branchKey) =>
  pickRoute('อ่านรายการนับสต๊อกของสาขา', () => directStock.readStockItems(branchKey),
    () => getFromHost(`stock-items?branch=${encodeURIComponent(branchKey)}`));

export const readStockTotal = (endDate) =>
  pickRoute('อ่านยอดรวมสต๊อกทุกสาขา', () => directStock.readStockTotal(endDate),
    () => getFromHost(`stock-total${endDate ? `?endDate=${encodeURIComponent(endDate)}` : ''}`));

export const readExpenseRefs = () =>
  pickRoute('อ่านข้อมูลอ้างอิงค่าใช้จ่าย', () => direct.readExpenseRefs(), () => getFromHost('expense-ref'));

export const readExpenses = () =>
  pickRoute('อ่านค่าใช้จ่ายอื่นๆ', () => direct.readExpenses(), () => getFromHost('expense'));

// หน้าเว็บไม่ได้เรียกตัวนี้แล้ว — เหลือไว้ให้ host API /sheets/employee กับสคริปต์ย้ายข้อมูล
export const readEmployees = () =>
  pickRoute('อ่านข้อมูลพนักงาน', () => direct.readEmployees(), () => getFromHost('employee'));

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
// (ฟังก์ชันตั้ง maxDuration ไว้ 60 วิ ต่อตรงก่อนหน้าใช้ไปไม่เกิน 8 วิ ดู connectionTimeout ใน qcrdPool)
const MONTH_END_HOST_TIMEOUT = 45000;

/** ลองต่อ SQL ตรงก่อน ต่อไม่ติดค่อยถอยไป host API — คืนทางที่ใช้จริงมาด้วย ไว้บอกในหน้าเว็บ */
const monthEndRead = (runDirect, hostPath) =>
  viaDirectOrHost('อ่านปิดรอบเดือน', runDirect,
    () => getFromHost(hostPath, { timeoutMs: MONTH_END_HOST_TIMEOUT }));

/* ---- โหมดเข้ากันได้กับ host-server เวอร์ชันเก่า ----
 *
 * ตรรกะ "รอบเดือน" (ปิดวันที่ 1–10 = รอบของเดือนก่อน) อยู่ใน lib/monthEndSql.mjs ซึ่ง
 * **รันที่เครื่องออฟฟิศ** เมื่อ Vercel ต่อ SQL ตรงไม่ได้ — deploy เว็บอย่างเดียวจึงไม่มีผล
 * จนกว่าเครื่องนั้นจะ git pull + รีสตาร์ท ซึ่งช้ากว่าเว็บเสมอและมีคนต้องไปกดเอง
 *
 * ข้างล่างนี้คือชั้นแปลงฝั่ง Vercel: ถ้าคำตอบมาจาก host เวอร์ชันเก่า (ไม่มี layout.cycleCutoffDay)
 * จะคิดรอบเดือนใหม่ให้เองจากวันที่ปิดยอดที่ติดมากับแถวอยู่แล้ว หน้าเว็บจึงถูกต้องทันที
 * โดยไม่ต้องรอเครื่องออฟฟิศ — และไม่กระทบชุดข้อมูลอื่นในไฟล์นี้ (แพลน/ปิดรอบชีท/ค่าใช้จ่าย/สแกน)
 *
 * host เวอร์ชันใหม่ไม่ต้องแปลงอะไร ปล่อยผ่านตรง ๆ (แปลงซ้ำก็ได้ผลเท่าเดิม แต่เสียเที่ยวยิงเปล่า)
 */
const isLegacyHost = (data) => !data?.layout || data.layout.cycleCutoffDay === undefined;

/** 'YYYY-MM' บวก/ลบเดือน */
function shiftMonth(ym, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** ปะข้อมูลผังคอลัมน์ให้บอกว่ารอบเดือนถูกคิดที่ฝั่งเว็บ (หน้าเว็บเอาไปขึ้นหมายเหตุ) */
const patchLayout = (layout) => ({
  ...(layout || {}),
  cycleCutoffDay: CYCLE_PREV_MONTH_UNTIL_DAY,
  hostLegacy: true,   // = เว็บคิดรอบเดือนให้เอง เพราะเครื่องออฟฟิศยังรันโค้ดเก่า
});

/** สรุปรายสาขา: ปิดยอดรอบล่าสุดถึงวันไหน (หน้าแรกของเมนู "ดูข้อมูลปิดรอบเดือน") */
export async function readMonthEndSummary() {
  const { data, route } = await monthEndRead(
    () => directMonthEnd.readMonthEndSummary(), 'month-end-summary');
  if (!isLegacyHost(data)) return { ...data, source: route };

  // สรุปรายสาขาแปลงได้ครบโดยไม่ต้องยิงซ้ำ — รอบเดือนคิดจาก date ของแต่ละสาขาที่ติดมาอยู่แล้ว
  const branches = (data.branches || []).map((b) => ({ ...b, month: cycleMonth(b.date) }));
  return {
    ...data,
    branches,
    latestMonth: branches.reduce((a, b) => (b.month > a ? b.month : a), ''),
    layout: patchLayout(data.layout),
    source: route,
  };
}

/** ยิง host/ฐานเอาแถวของ "เดือนปฏิทิน" หนึ่งเดือน (ใช้เฉพาะโหมดเข้ากันได้) */
function readCalendarMonth(month, branch) {
  const p = new URLSearchParams();
  if (month) p.set('month', month);
  if (branch) p.set('branch', branch);
  const qs = p.toString();
  return monthEndRead(
    () => directMonthEnd.readMonthEnd({ month, branch }),
    `month-end${qs ? `?${qs}` : ''}`);
}

/**
 * แถวปิดรอบของเดือนหนึ่ง (ไม่ระบุเดือน = รอบล่าสุดที่มีข้อมูล)
 *
 * โหมดเข้ากันได้: host เก่าคัดแถวตาม "เดือนปฏิทิน" ของวันที่ปิดยอด แต่รอบหนึ่งกินสองเดือนปฏิทิน
 * (เช่นรอบสิงหาคม = 11 ส.ค. ถึง 10 ก.ย.) จึงต้องดึงเดือนถัดไปมารวมแล้วคัดใหม่ด้วยกติกาของเว็บ
 * ยิงสองเดือนพร้อมกันเพื่อไม่ให้เวลารวมเกินเพดานฟังก์ชัน
 */
export async function readMonthEnd({ month, branch } = {}) {
  const first = await readCalendarMonth(month, branch);
  if (!isLegacyHost(first.data)) return { ...first.data, source: first.route };

  const rowsOf = (d) => (d?.rows || []);
  // ไม่ได้ระบุเดือนมา = host เลือกเดือนปฏิทินล่าสุดให้ → รอบที่ต้องการคือรอบล่าสุดของแถวชุดนั้น
  const target = month || rowsOf(first.data).reduce((a, r) => {
    const m = cycleMonth(r.date);
    return m > a ? m : a;
  }, '');

  if (!target) return { ...first.data, rows: [], layout: patchLayout(first.data.layout), source: first.route };

  // รอบ target กินแถวจากเดือนปฏิทิน target (วันที่ 11 เป็นต้นไป) กับเดือนถัดไป (วันที่ 1–10)
  const need = [target, shiftMonth(target, 1)];
  const fetched = await Promise.all(need.map(async (m) => {
    if (m === month) return first;                    // เดือนที่ยิงไปแล้วรอบแรก ไม่ต้องยิงซ้ำ
    try { return await readCalendarMonth(m, branch); }
    catch { return { data: { rows: [] }, route: first.route }; }   // เดือนที่ยังไม่มีข้อมูลไม่ถือว่าพัง
  }));

  const seen = new Set();
  const rows = [first, ...fetched]
    .flatMap((r) => rowsOf(r.data))
    .filter((r) => cycleMonth(r.date) === target)
    .filter((r) => {
      // เดือนที่ยิงไปแล้วรอบแรกอาจถูกนับซ้ำ — คัดด้วยคีย์เดียวกับที่ตารางใช้
      const key = `${r.branch}|${r.itemKey || r.itemCode}|${r.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({ ...r, month: target }));

  // รายการเดือนของ host เก่าเป็นเดือนปฏิทิน — รอบที่มีจริงคือเดือนนั้นหรือเดือนก่อนหน้า เอามาทั้งคู่
  const months = [...new Set((first.data.months || []).flatMap((m) => [m, shiftMonth(m, -1)]))]
    .filter(Boolean).sort().reverse();

  return {
    ...first.data,
    month: target,
    months,
    branches: [...new Set(rows.map((r) => r.branch))].sort(),
    rows,
    layout: patchLayout(first.data.layout),
    source: first.route,
  };
}

/** เดือนที่มีข้อมูลปิดรอบ ('YYYY-MM' ใหม่ก่อน) */
export async function readMonthEndMonths() {
  const { data } = await monthEndRead(() => directMonthEnd.readMonthEndMonths(), 'month-end-months');
  return data;
}

/* ------------------------------- ฝั่งเขียน ------------------------------- */

/**
 * body เดียวกับที่เคยส่งไป Apps Script ทุกช่อง — action = saveOtherExpense | bulkImport | deleteExpenseByMonth | saveEmployee
 *
 * ต่อ SQL ตรงไม่ติด (พอร์ตไม่ได้เปิดออกเน็ต) จะถอยไปเขียนผ่าน host API ให้ — ปลายทางเป็นฐาน
 * InventoryNarai ตัวเดียวกัน ไม่ใช่การถอยไปเขียนชีท ข้อมูลจึงยังอยู่ที่เดียวกับที่หน้าเว็บอ่าน
 */
export async function saveSheets(action, body) {
  const fn = direct.actions[action];
  if (!fn) throw new Error(`unknown action: ${action}`);
  return pickRoute(`บันทึก ${action}`, () => fn(body), () => postToHost({ ...body, action }));
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
  const p = new URLSearchParams({ start, end });
  if (branch) p.set('branch', branch);
  return pickRoute('อ่านตัวแก้เวลาสแกน',
    () => directScanEdits.readScanEdits({ start, end, branch }),
    () => getFromHost(`scan-edit?${p.toString()}`));
};

/** ประวัติการแก้ของคนหนึ่งในวันหนึ่ง (ทุกครั้งที่กดบันทึก) */
export const readScanEditHistory = ({ date, empCode }) => {
  const p = new URLSearchParams({ date, emp: empCode });
  return pickRoute('อ่านประวัติการแก้เวลาสแกน',
    () => directScanEdits.readScanEditHistory({ date, empCode }),
    () => getFromHost(`scan-edit-history?${p.toString()}`));
};

/** บันทึกการแก้หนึ่งช่อง — เป็นการบันทึกแถวใหม่เสมอ ไม่ทับของเดิม */
export const saveScanEdit = (body) =>
  pickRoute('บันทึกการแก้เวลาสแกน',
    () => directScanEdits.actions.saveScanEdit(body),
    () => postToHost({ ...body, action: 'saveScanEdit' }));

/* ------------------------ ทะเบียนสาขา (dbo.hr_branch) ------------------------ */
//
// ตารางนี้เป็นต้นทางของ dropdown สาขาทุกหน้า และของตารางแมป outletID ฝั่ง API (lib/branchRegistry.js)
// ไม่มีทางถอยไปชีท — ข้อมูลชุดนี้ไม่เคยอยู่ในชีท ถอยได้แค่จาก "ต่อ SQL ตรง" ไป host API
// (ตัวเรียกอย่าง /api/branches ถอยต่อไปใช้รายชื่อสำรองใน lib/branchCore.mjs ได้อีกชั้น)

export const readBranchRegistry = () =>
  pickRoute('อ่านทะเบียนสาขา', () => directBranches.readBranches(), () => getFromHost('branch'));

export const saveBranchRow = (body) =>
  pickRoute('บันทึกสาขา',
    () => directBranches.actions.saveBranch(body),
    () => postToHost({ ...body, action: 'saveBranch' }));

export const deleteBranchRow = (body) =>
  pickRoute('ลบสาขา',
    () => directBranches.actions.deleteBranch(body),
    () => postToHost({ ...body, action: 'deleteBranch' }));
