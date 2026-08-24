// ต้นทางฝั่งชีท ของชุดข้อมูลที่กำลังย้ายเข้า SQL (แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน)
//
// รวมไว้ที่เดียวเพราะมีคนใช้สองฝั่ง แล้วต้องอ่านได้ผลตรงกันเสมอ:
//   pages/api/plan.js, stock-closing.js, expense-gas.js, stock-gas.js  ← ทางถอยเมื่อ SQL ล่ม
//   pages/api/sheets-migrate.js                                        ← ตอนย้ายข้อมูลเก่าเข้า SQL
//   scripts/migrate-sheets.mjs                                         ← ตอนย้ายจากเครื่องออฟฟิศ (CLI)
//
// ตั้งชื่อเป็น .mjs เพื่อให้ node เรียกจากสคริปต์ CLI ได้ตรง ๆ (แพ็กเกจนี้ไม่ได้ตั้ง type:module
// ไฟล์ .js จึงถูกมองเป็น CommonJS แล้ว import ไม่ได้) ฝั่ง Next.js import .mjs ได้อยู่แล้ว
//
// แพลน/ปิดรอบอ่านจากชีทตรง ๆ ส่วนค่าใช้จ่าย/พนักงานอ่านผ่าน Apps Script เดิม
// เพราะสองแท็บนั้นจับคอลัมน์จาก "ชื่อหัวตาราง" ไม่ใช่ตำแหน่ง — ให้ GAS แปลงให้เหมือนที่หน้าเว็บเห็น
// จะได้ไม่มีตัวอ่านคนละชุดที่ตีความชีทไม่ตรงกัน

export const STOCK_SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
export const PLAN_GID = '571271047';
export const CLOSING_TAB = 'ปิดรอบสิ้นเดือน';

// Apps Script ของสต๊อก (แท็บ DATA พนักงานอยู่ในสคริปต์ตัวนี้ด้วย)
export const STOCK_GAS_URL =
  process.env.STOCK_GAS_URL ||
  'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

// Apps Script ของชีทค่าใช้จ่ายอื่นๆ (1YXOaA…)
export const EXPENSE_GAS_URL =
  process.env.EXPENSE_GAS_URL ||
  'https://script.google.com/macros/s/AKfycbwcRP65mAO0jWusYr1OfcgxpW8GU7yv0t85VcnQ3ShTjEROaXCF2d3MNo_VffNho6Y/exec';

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** เรียก Apps Script แล้วคืน data — โยน error พร้อมข้อความไทยถ้าตอบไม่ใช่ JSON */
export async function callGas(url, payload, { timeoutMs = 45000 } = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`ตอบกลับจาก Apps Script ไม่ใช่ JSON (HTTP ${r.status})`); }
  if (json.status !== 'success') throw new Error(json.message || `Apps Script HTTP ${r.status}`);
  return json.data;
}

/* ------------------------------- แพลนสั่งของ ------------------------------- */

const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };

/**
 * แท็บ plan — คืนรูปแบบเดียวกับที่ /api/plan เคยตอบทุกช่อง
 * (หา index จากชื่อหัวคอลัมน์ กันชีทสลับตำแหน่งคอลัมน์ในอนาคต)
 */
export async function fetchPlanRows() {
  const url = `https://docs.google.com/spreadsheets/d/${STOCK_SHEET_ID}/export?format=csv&gid=${PLAN_GID}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status}`);
  const rows = parseCSV(await r.text());
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim());
  const col = name => header.indexOf(name);
  const c = {
    orderDate: col('วันที่สั่ง'),
    recordTime: col('เวลาบันทึก'),
    branch: col('สาขา'),
    outletId: col('รหัสสาขา'),
    orderNo: col('เลขที่ใบสั่ง'),
    seq: col('ลำดับ'),
    receiveDate: col('วันที่รับ'),
    itemId: col('itemId'),
    itemCode: col('รหัสสินค้า'),
    itemName: col('ชื่อสินค้า'),
    qty: col('จำนวน'),
    unit: col('หน่วย'),
    unitPrice: col('ราคา/หน่วย'),
    total: col('มูลค่ารวม'),
    type: col('ประเภท'),
    recordedBy: col('ผู้บันทึก'),
  };

  return rows.slice(1)
    .filter(r2 => r2.some(x => String(x).trim()))
    .map(r2 => ({
      orderDate: (r2[c.orderDate] || '').trim(),       // DD/MM/YYYY — วันที่คีย์ข้อมูล
      recordTime: (r2[c.recordTime] || '').trim(),     // HH:MM:SS — เวลาคีย์ข้อมูล
      branch: (r2[c.branch] || '').trim().toUpperCase(),
      outletId: (r2[c.outletId] || '').trim(),
      orderNo: (r2[c.orderNo] || '').trim(),
      seq: (r2[c.seq] || '').trim(),
      receiveDate: (r2[c.receiveDate] || '').trim(),   // YYYY-MM-DD — วันที่รับของ
      itemId: (r2[c.itemId] || '').trim(),
      itemCode: (r2[c.itemCode] || '').trim(),
      itemName: (r2[c.itemName] || '').trim(),
      qty: num(r2[c.qty]),
      unit: (r2[c.unit] || '').trim(),
      unitPrice: num(r2[c.unitPrice]),
      total: num(r2[c.total]),
      type: (r2[c.type] || '').trim(),
      recordedBy: (r2[c.recordedBy] || '').trim(),
    }))
    .filter(r2 => r2.itemCode);
}

/* ------------------------------ ปิดรอบสิ้นเดือน ------------------------------ */

// ดึงเฉพาะคอลัมน์ที่ใช้เพื่อลดขนาดที่ต้องโหลด — ถ้า gviz ไม่รับ query ถอยไปดึงทั้งชีท
// (ตอนย้ายข้อมูลต้องใช้ครบทุกคอลัมน์ จึงมีชุด full ไว้ให้เลือกด้วย)
const CLOSING_LAYOUTS = {
  lite: [
    { tq: 'select A,B,C,E,F,J', col: { date: 0, branch: 1, item: 2, unit: 3, balance: 4, recorded: 5 } },
    { tq: '', col: { date: 0, branch: 1, item: 2, unit: 4, balance: 5, recorded: 9 } },
  ],
  full: [
    { tq: '', col: { date: 0, branch: 1, item: 2, name: 3, unit: 4, balance: 5, unitValue: 6, totalValue: 7, by: 8, recorded: 9 } },
  ],
};

const pad2 = n => String(n).padStart(2, '0');

export const normalizeId = id => String(id ?? '').replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

/** รับได้ทั้ง 'YYYY-MM-DD' และ 'DD/MM/YYYY' (พร้อมเวลาต่อท้ายหรือไม่ก็ได้) -> 'YYYY-MM-DD' */
export function toISODate(value) {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return '';
}

/** 'DD/MM/YYYY HH:mm:ss' -> 'YYYY-MM-DD HH:mm:ss' สำหรับใช้เรียงลำดับแบบ string */
export function toSortableStamp(value) {
  const s = String(value || '').trim();
  const date = toISODate(s);
  if (!date) return '';
  const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return `${date} ${t ? `${pad2(t[1])}:${t[2]}:${t[3] || '00'}` : '00:00:00'}`;
}

function parseClosingRows(text, col) {
  const rows = [];
  parseCSV(text).forEach((rw, idx) => {
    const date = toISODate(rw[col.date]);
    const branch = String(rw[col.branch] || '').trim().toLowerCase();
    const itemId = normalizeId(rw[col.item]);
    const balance = parseFloat(String(rw[col.balance] ?? '').replace(/,/g, ''));
    // ตัดหัวตาราง/แถวว่าง/แถวที่ยอดไม่ใช่ตัวเลข ออกไปในตัว
    if (!date || !branch || !itemId || isNaN(balance)) return;
    const pick = k => (col[k] === undefined ? '' : String(rw[col[k]] || '').trim());
    const money = k => {
      if (col[k] === undefined) return null;
      const n = parseFloat(String(rw[col[k]] ?? '').replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    rows.push({
      date,
      branch,
      itemId,
      itemCode: String(rw[col.item] || '').trim(),
      itemName: pick('name'),
      balance,
      unit: pick('unit'),
      unitValue: money('unitValue'),
      totalValue: money('totalValue'),
      recordedBy: pick('by'),
      recordedAt: pick('recorded'),
      sortKey: `${date}|${toSortableStamp(rw[col.recorded])}|${String(idx).padStart(6, '0')}`,
    });
  });
  return rows;
}

// แถวปิดรอบทั้งชีท (cache 5 นาที — สาขาไหนเรียกก็ใช้ชุดเดียวกัน)
let closingCache = { rows: null, at: 0, shape: '' };

/** shape = 'lite' (เท่าที่หน้าเว็บใช้) | 'full' (ครบทุกคอลัมน์ ใช้ตอนย้ายข้อมูล) */
export async function fetchClosingRows(shape = 'lite') {
  if (closingCache.rows && closingCache.shape === shape && Date.now() - closingCache.at < 5 * 60 * 1000) {
    return closingCache.rows;
  }

  const base = `https://docs.google.com/spreadsheets/d/${STOCK_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CLOSING_TAB)}`;
  let lastError = null;

  for (const layout of CLOSING_LAYOUTS[shape]) {
    try {
      const r = await fetch(layout.tq ? `${base}&tq=${encodeURIComponent(layout.tq)}` : base,
        { cache: 'no-store', redirect: 'follow' });
      if (!r.ok) throw new Error(`ชีทปิดรอบสิ้นเดือน HTTP ${r.status}`);
      const rows = parseClosingRows(await r.text(), layout.col);
      if (rows.length === 0) throw new Error('ไม่พบข้อมูลในชีทปิดรอบสิ้นเดือน');
      closingCache = { rows, at: Date.now(), shape };
      return rows;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/* --------------------------- ค่าใช้จ่ายอื่นๆ / พนักงาน --------------------------- */

export const fetchExpenseRefs = () => callGas(EXPENSE_GAS_URL, { action: 'getExpenseRefs' });
export const fetchExpenses = () => callGas(EXPENSE_GAS_URL, { action: 'getExpenses' });
// อ่านรายชื่อจาก "ชีท" ตรง ๆ — ไม่มีใครเรียกในโค้ดหลักแล้ว (รายชื่อจริงอยู่ narai_hr.dbo.hr_employee)
// เก็บไว้ให้เอาไปเทียบย้อนหลังว่าชีทเก่ากับฐานต่างกันตรงไหน อย่าเอาไปเขียนทับตารางจริง
export const fetchEmployees = () => callGas(STOCK_GAS_URL, { action: 'getEmployees', branch: 'all' });
