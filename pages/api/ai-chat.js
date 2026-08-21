// AI NARAI — แชท AI (Gemini) ที่ดึงข้อมูลจริงจาก SQL Server ผ่าน host API
// แหล่งข้อมูล: NaraiPos (ยอดขาย POS), ZKBio Time บน SQLEXPRESS (สแกนนิ้ว — endpoint /zk/*), Google Sheet
// สถาปัตยกรรม: หน้าเว็บ → /api/ai-chat → Gemini (function calling) ⇄ เครื่องมือ read-only
// เครื่องมือทุกตัวเรียก host API (Cloudflare tunnel → server.js → SQL Server) แล้ว aggregate
// ฝั่งนี้ก่อนส่งให้ AI (กัน token บวม + AI ไม่มีสิทธิ์ยิง SQL ตรง)
//
// ต้องตั้ง env: GEMINI_API_KEY (ขอฟรีที่ https://aistudio.google.com/apikey)
// เลือกโมเดลผ่าน env GEMINI_MODEL — ถ้าไม่ตั้ง จะใช้ค่า default ในบรรทัด GEMINI_MODEL ด้านล่าง
// (คำตอบจาก /api/ai-chat มีฟิลด์ model บอกว่ารอบนั้นตอบด้วยโมเดลไหนจริง ๆ)

// ค่าใช้จ่ายอื่นๆ / พนักงาน / แพลนสั่งของ ย้ายเข้า SQL แล้ว (SHEETS_SOURCE=sql)
// เครื่องมือของ AI ต้องอ่านที่เดียวกับหน้าเว็บ ไม่งั้นหลังย้ายเสร็จ AI จะยังตอบจากชีทที่หยุดอัปเดตไปแล้ว
import { usingSql as usingSheetsSql, readExpenses, readEmployees, readPlan } from '../../lib/sheetsSource';

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';
// GAS ค่าใช้จ่าย/พนักงาน (ตัวเดียวกับ proxy) — ส่วนชีท Google อยู่ในทะเบียน SHEETS ด้านล่าง
const EXPENSE_GAS = process.env.EXPENSE_GAS_URL || 'https://script.google.com/macros/s/AKfycbwcRP65mAO0jWusYr1OfcgxpW8GU7yv0t85VcnQ3ShTjEROaXCF2d3MNo_VffNho6Y/exec';
const HR_GAS = 'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// ลำดับ fallback เมื่อโมเดลหลักโควตาเต็ม (429) — เริ่มใหม่ทั้งบทสนทนากับโมเดลถัดไป
// (thoughtSignature ผูกกับโมเดล ใช้ข้ามรุ่นไม่ได้ จึงต้อง restart ไม่ใช่สลับกลางคัน)
const MODEL_CHAIN = [...new Set([GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest'])];

const OUTLETS = {
  7: 'SJP', 12: 'CRM', 19: 'XCM', 37: 'SLR', 51: 'SUM',
  59: 'XUM', 61: 'SCS', 63: 'SMP', 67: 'XSB', 72: 'XHH',
  78: 'HRS', 79: 'CLK', 80: 'P90', 109: 'HPS', 400: 'ZBW',
  401: 'ZPT', 500: 'NPT', 501: 'WRM', 503: 'WMT', 904: 'IPR', 906: 'ZK3',
};
const BRANCH_TO_OUTLET = Object.fromEntries(
  Object.entries(OUTLETS).map(([id, name]) => [name.toUpperCase(), parseInt(id)])
);

// กติกาเดียวกับหน้าเว็บ: ตัดโต๊ะ 600, ไอเทมเตรียมของ, บิลยอดเหมาข้าวกล่อง
const EXCLUDE_TABLES = [600];
const EXCLUDE_ITEMS = [206001, 290016];
const isExcludedItem = c => {
  const ic = parseInt(c);
  return EXCLUDE_ITEMS.includes(ic) || (ic >= 500002 && ic <= 500026);
};

const num = v => parseFloat(v) || 0;
const r2 = v => Math.round(v * 100) / 100;
const txt = v => String(v ?? '').trim();
// ตัวเลขจากชีท: อาจมี comma คั่นหลัก ("1,234.5") ซึ่ง parseFloat ตรง ๆ จะได้ 1 → ต้องตัดออกก่อน
const snum = v => { const n = parseFloat(txt(v).replace(/,/g, '')); return isNaN(n) ? null : n; };

// เพดานจำนวนแถวที่ส่งให้ AI
// ทำไมต้องมี: ผลลัพธ์เครื่องมือถูกแนบกลับเข้าบทสนทนาและส่งซ้ำ "ทุกรอบ" ที่โมเดลเรียกเครื่องมือ
// (สูงสุด 6 รอบ) ก้อนใหญ่จึงกินโควตาแบบทวีคูณ ไม่ใช่แค่ครั้งเดียว — ที่ผ่านมาเจอ 429 บ่อย
// จนต้องมี MODEL_CHAIN ไว้สำรอง จึงตั้ง default เล็กไว้ก่อน
// แต่ไม่ได้ล็อกตายอีกต่อไป: ส่ง limit=0 = เอาทั้งหมด (ยังมีเพดานแข็ง MAX_ROWS กันอุบัติเหตุ)
const MAX_ROWS = 5000;
const rowCap = (limit, dflt = 50) => {
  const n = Number(limit);
  if (n === 0) return MAX_ROWS;
  return Math.min(n > 0 ? n : dflt, MAX_ROWS);
};

// เพดานช่วงวันที่: ถามยาวได้ถึง 1 ปีสำหรับข้อมูลสรุป (ตัวที่คืนรายแถวดิบมีเพดานของตัวเอง)
// ฝั่ง host API ยังถูกยิงทีละ ≤31 วันเสมอ (ดู splitRange) ช่วงยาวแค่แบ่งก้อนให้อัตโนมัติ
const MAX_DAYS = 366;

function assertRange(start, end, maxDays = MAX_DAYS) {
  const d1 = new Date(start), d2 = new Date(end);
  if (isNaN(d1) || isNaN(d2)) throw new Error('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  const days = (d2 - d1) / 86400000 + 1;
  if (days < 1) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (days > maxDays) throw new Error(`ช่วงวันที่ยาวเกินไป (สูงสุด ${maxDays} วัน) — แบ่งช่วงถามเป็นช่วงย่อย`);
  return Math.round(days);
}

// แบ่งช่วงวันที่ยาว ๆ เป็นก้อนละ ≤31 วัน — host API ถูกยิงด้วยขนาดเดิมที่พิสูจน์แล้วว่าไหว
// ถามทั้งปีจึงกลายเป็น 12 คำขอย่อยที่วิ่งขนานกัน แทนที่จะต้องบอกผู้ใช้ให้ถามทีละเดือนเอง
const CHUNK_DAYS = 31;
function splitRange(start, end, size = CHUNK_DAYS) {
  const out = [];
  const day = 86400000;
  let s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  while (s <= e) {
    const cEnd = Math.min(s + (size - 1) * day, e);
    out.push([new Date(s).toISOString().slice(0, 10), new Date(cEnd).toISOString().slice(0, 10)]);
    s = cEnd + day;
  }
  return out;
}

// วิ่งงานพร้อมกันได้ไม่เกิน n งาน (กันยิง host API รัวเกินจนหลุด/ช้า)
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
const FETCH_CONCURRENCY = 4;

// แคชผลอ่านจาก host API ไว้ในหน่วยความจำของ instance
// ทำไม: AI มักถามต่อเนื่องบนช่วงเดียวกัน (ยอดขาย → เมนูขายดี → ต้นทุน) ถ้าไม่แคชคือดึงซ้ำทุกครั้ง
// คุมหน่วยความจำด้วยงบจำนวนแถวรวม — เกินงบไล่ลบก้อนที่เก่าที่สุดก่อน (Map เรียงตามลำดับที่ใส่)
const ROW_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_ROW_BUDGET = 250000;
let cacheRows = 0;

async function fetchRows(path) {
  const hit = ROW_CACHE.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const r = await fetch(`${STORE_API}${path}`);
  if (!r.ok) throw new Error(`host API HTTP ${r.status}`);
  const j = await r.json();
  const rows = Array.isArray(j) ? j : j.data || [];
  if (hit) cacheRows -= hit.rows.length;
  ROW_CACHE.delete(path);
  ROW_CACHE.set(path, { rows, at: Date.now() });
  cacheRows += rows.length;
  while (cacheRows > CACHE_ROW_BUDGET && ROW_CACHE.size > 1) {
    const oldest = ROW_CACHE.keys().next().value;
    cacheRows -= ROW_CACHE.get(oldest).rows.length;
    ROW_CACHE.delete(oldest);
  }
  return rows;
}

function outletParam(branch) {
  if (!branch) return '';
  const oid = BRANCH_TO_OUTLET[String(branch).toUpperCase().trim()];
  if (!oid) throw new Error(`ไม่รู้จักสาขา "${branch}" — สาขาที่มี: ${Object.values(OUTLETS).join(', ')}`);
  return `&outlet=${oid}`;
}

// บิล/รายการอาหาร: ช่วงยาวถูกหั่นเป็นก้อนละ ≤31 วันแล้วดึงขนานกัน + ผ่านแคช
async function fetchSales(start, end, branch) {
  const outlet = outletParam(branch);
  const parts = await mapLimit(splitRange(start, end), FETCH_CONCURRENCY,
    ([s, e]) => fetchRows(`/cpaidbetweendate?start=${s}&end=${e}${outlet}`));
  return parts.flat().filter(b => !EXCLUDE_TABLES.includes(parseInt(b.tableID)));
}

async function fetchDetails(start, end, branch) {
  const outlet = outletParam(branch);
  const parts = await mapLimit(splitRange(start, end), FETCH_CONCURRENCY,
    ([s, e]) => fetchRows(`/ctranbetweendate?start=${s}&end=${e}${outlet}`));
  return parts.flat();
}

// เรียก endpoint /zk/* (ฐานข้อมูล ZKBio Time — เครื่องสแกนนิ้ว) ผ่าน host API ตัวเดียวกัน
// ต่อไม่ได้/ยังไม่ตั้งค่า → โยน error พร้อมข้อความจริงจาก host ให้ AI บอกผู้ใช้ตรง ๆ
async function fetchZk(path) {
  const r = await fetch(`${STORE_API}${path}`);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `host API HTTP ${r.status} (${path})`);
  return Array.isArray(j) ? j : j?.data || [];
}

// ── เครื่องมือที่เปิดให้ AI เรียก (read-only ทั้งหมด) ──
const TOOL_HANDLERS = {
  // ยอดขายสรุป — เลือกได้ว่าจะรวบเป็นรายวัน/รายเดือน/รายสาขา (ถามยาวได้ถึง 1 ปี)
  async get_daily_sales({ start_date, end_date, branch, group_by }) {
    const days = assertRange(start_date, end_date);
    const rows = await fetchSales(start_date, end_date, branch);

    const GROUPS = ['day', 'month', 'branch', 'day_branch', 'month_branch'];
    // ช่วงยาวเกิน ~2 เดือนแล้วไม่ระบุ → รวบเป็นรายเดือน×สาขาให้เอง (รายวันจะได้เป็นพันแถว AI อ่านไม่ไหว)
    let gb = GROUPS.includes(group_by) ? group_by : (days > 62 ? 'month_branch' : 'day_branch');

    const agg = mode => {
      const g = {};
      rows.forEach(b => {
        let bt = num(b.billTotal) - num(b.voucher1);
        if (bt < 0) bt = 0;
        const date = String(b.startTime || b.date || '').slice(0, 10);
        const month = date.slice(0, 7);
        const name = OUTLETS[b.outletID] || String(b.outletID);
        const f = mode === 'day' ? { date }
          : mode === 'month' ? { month }
          : mode === 'branch' ? { branch: name }
          : mode === 'month_branch' ? { month, branch: name }
          : { date, branch: name };
        const k = Object.values(f).join('|');
        if (!g[k]) g[k] = { ...f, bills: 0, gross: 0, vat: 0 };
        g[k].bills++;
        g[k].gross += bt;
        g[k].vat += bt > 0 ? num(b.vat) : 0;
      });
      return Object.values(g)
        .map(x => ({ ...x, gross: r2(x.gross), vat: r2(x.vat), net: r2(x.gross - x.vat) }))
        .sort((a, b) => String(a.date || a.month || a.branch).localeCompare(String(b.date || b.month || b.branch))
          || String(a.branch || '').localeCompare(String(b.branch || '')));
    };

    let out = agg(gb);
    let extra = '';
    // กันผลลัพธ์บวมจนกิน token: เกิน 1,200 แถวให้ไล่รวบขึ้นทีละขั้น
    for (const next of ['month_branch', 'branch']) {
      if (out.length <= 1200) break;
      gb = next; out = agg(gb);
      extra = ` · ผลลัพธ์เยอะเกินจึงรวบเป็น ${gb} ให้อัตโนมัติ (อยากได้ละเอียดกว่านี้ให้ถามทีละเดือน)`;
    }

    const total = out.reduce((t, x) => ({
      bills: t.bills + x.bills, gross: r2(t.gross + x.gross), net: r2(t.net + x.net),
    }), { bills: 0, gross: 0, net: 0 });

    return {
      range: { start: start_date, end: end_date, days }, group_by: gb, rows: out, total,
      note: 'gross รวม VAT แล้ว, net = ก่อน VAT, ตัดโต๊ะ 600 และหักวอเชอร์แล้ว' + extra,
    };
  },

  // รายการขายดี (Top N) ตามยอดเงินหรือจำนวน
  async get_top_items({ start_date, end_date, branch, limit = 20, by = 'amount' }) {
    assertRange(start_date, end_date, 366);
    const rows = await fetchDetails(start_date, end_date, branch);
    const g = {};
    rows.forEach(r => {
      if (r.void) return;
      if (EXCLUDE_TABLES.includes(parseInt(r.tableID))) return;
      if (isExcludedItem(r.itemCode)) return;
      const k = String(r.itemCode);
      if (!g[k]) g[k] = { itemCode: k, name: String(r.nameThai || '').trim(), qty: 0, amount: 0 };
      g[k].qty += num(r.quantity);
      g[k].amount += num(r.grossPrice);
    });
    const sorted = Object.values(g).sort((a, b) => by === 'qty' ? b.qty - a.qty : b.amount - a.amount);
    const top = sorted.slice(0, rowCap(limit, 20)).map(x => ({ ...x, qty: r2(x.qty), amount: r2(x.amount) }));
    return { items: top, totalItems: sorted.length, note: 'amount = ยอดก่อน VAT, ไม่รวมรายการ void/ไอเทมเตรียมของ' };
  },

  // สรุปช่องทางการชำระเงิน
  async get_payment_summary({ start_date, end_date, branch }) {
    assertRange(start_date, end_date);
    const rows = await fetchSales(start_date, end_date, branch);
    const sum = { cash: 0, credit: 0, qr: 0, qrCredit: 0, grab: 0, lineMan: 0, shopee: 0, robinhood: 0, other: 0 };
    rows.forEach(b => {
      const bt = num(b.billTotal) - num(b.voucher1);
      if (bt <= 0) return;
      const pt = String(b.paidType || '').toUpperCase();
      if (num(b.cash)) sum.cash += num(b.cash);
      else if (num(b.credit)) sum.credit += num(b.credit);
      else if (num(b.qr)) sum.qr += num(b.qr);
      else if (num(b.qrCredit)) sum.qrCredit += num(b.qrCredit);
      else if (pt.includes('GRAB')) sum.grab += bt;
      else if (pt.includes('LINE')) sum.lineMan += bt;
      else if (pt.includes('SHOPEE')) sum.shopee += bt;
      else if (pt.includes('ROBINHOOD')) sum.robinhood += bt;
      else sum.other += bt;
    });
    Object.keys(sum).forEach(k => { sum[k] = r2(sum[k]); });
    return { payments: sum, bills: rows.length };
  },

  // รายละเอียดบิลหนึ่งใบ (บิล + รายการอาหาร)
  async get_bill_detail({ check_id, branch, date }) {
    if (!branch || !date) throw new Error('ต้องระบุ branch และ date (วันที่ของบิล YYYY-MM-DD)');
    const [sales, dets] = await Promise.all([
      fetchSales(date, date, branch),
      fetchDetails(date, date, branch),
    ]);
    const bill = sales.find(b => String(b.checkID) === String(check_id));
    if (!bill) return { found: false, message: `ไม่พบบิล ${check_id} สาขา ${branch} วันที่ ${date}` };
    const lines = dets.filter(r => String(r.chkCheckID) === String(check_id))
      .map(r => ({ itemCode: r.itemCode, name: r.nameThai, qty: num(r.quantity), gross: num(r.grossPrice), void: !!r.void }));
    return {
      found: true,
      bill: {
        checkID: bill.checkID, date: bill.date, startTime: bill.startTime, tableID: bill.tableID,
        billTotal: num(bill.billTotal), vat: num(bill.vat), paidType: bill.paidType,
        cash: num(bill.cash), credit: num(bill.credit), qr: num(bill.qr),
      },
      lines,
    };
  },

  // รายชื่อสาขาทั้งหมด
  async get_branches() {
    return { branches: Object.entries(OUTLETS).map(([id, name]) => ({ outletID: parseInt(id), code: name })) };
  },

  // รายการบิลแบบแยกรายใบ (เลขบิล เวลา โต๊ะ ยอด ช่องทางจ่าย)
  async get_bills({ start_date, end_date, branch, limit = 100 }) {
    assertRange(start_date, end_date, 31); // รายใบข้อมูลเยอะ จำกัด 31 วันต่อครั้ง
    const rows = await fetchSales(start_date, end_date, branch);
    const bills = rows.map(b => ({
      checkID: b.checkID,
      branch: OUTLETS[b.outletID] || String(b.outletID),
      time: String(b.startTime || b.date || '').slice(0, 16),
      table: b.tableID,
      total: r2(num(b.billTotal) - num(b.voucher1)),
      paidType: b.paidType || '',
    })).sort((a, b) => a.time.localeCompare(b.time));
    const cap = rowCap(limit, 100);
    return {
      totalBills: bills.length,
      sumTotal: r2(bills.reduce((s, b) => s + b.total, 0)),
      bills: bills.slice(0, cap),
      truncated: bills.length > cap ? `แสดง ${cap} จาก ${bills.length} ใบ` : undefined,
    };
  },

  // เจาะยอดขายของเมนูเดียว (ค้นด้วยรหัสหรือชื่อ) แยกตามวันหรือตามสาขา
  async get_item_sales({ item, start_date, end_date, branch, group_by = 'day' }) {
    if (!item) throw new Error('ต้องระบุ item (รหัสหรือบางส่วนของชื่อเมนู)');
    assertRange(start_date, end_date, 366);
    const rows = await fetchDetails(start_date, end_date, branch);
    const kw = String(item).trim().toLowerCase();
    const hit = rows.filter(r => {
      if (r.void) return false;
      if (EXCLUDE_TABLES.includes(parseInt(r.tableID))) return false;
      if (isExcludedItem(r.itemCode)) return false;
      return String(r.itemCode) === kw || String(r.nameThai || '').toLowerCase().includes(kw);
    });
    if (!hit.length) {
      // ไม่เจอ → แนะนำชื่อใกล้เคียง (คำแรกของ keyword)
      const first = kw.slice(0, 4);
      const sug = [...new Set(rows.filter(r => String(r.nameThai || '').toLowerCase().includes(first))
        .map(r => `${r.itemCode} ${String(r.nameThai).trim()}`))].slice(0, 10);
      return { found: false, message: `ไม่พบเมนูที่ตรงกับ "${item}" ในช่วงนี้`, suggestions: sug };
    }
    const matched = [...new Set(hit.map(r => `${r.itemCode} ${String(r.nameThai).trim()}`))].slice(0, 10);
    const g = {};
    const field = group_by === 'branch' ? 'branch' : group_by === 'month' ? 'month' : 'date';
    hit.forEach(r => {
      const date = String(r.prtOrdTime || r.startTime || '').slice(0, 10);
      const key = field === 'branch' ? (OUTLETS[r.outletID] || String(r.outletID))
        : field === 'month' ? date.slice(0, 7) : date;
      if (!g[key]) g[key] = { [field]: key, qty: 0, amount: 0 };
      g[key].qty += num(r.quantity);
      g[key].amount += num(r.grossPrice);
    });
    const out = Object.values(g).map(x => ({ ...x, qty: r2(x.qty), amount: r2(x.amount) }))
      .sort((a, b) => String(a.date || a.month || a.branch).localeCompare(String(b.date || b.month || b.branch)));
    return {
      found: true, matchedItems: matched,
      totalQty: r2(hit.reduce((s, r) => s + num(r.quantity), 0)),
      totalAmount: r2(hit.reduce((s, r) => s + num(r.grossPrice), 0)),
      rows: out,
      note: 'amount = ยอดก่อน VAT ไม่รวม void',
    };
  },

  // ต้นทุน/กำไร: ยอดขายก่อน VAT − ต้นทุนจากชีทต้นทุนเมนู แยกรายวันหรือรายสาขา
  async get_cost_profit({ start_date, end_date, branch, group_by = 'branch' }) {
    assertRange(start_date, end_date, 366);
    const [rows, costMap] = await Promise.all([fetchDetails(start_date, end_date, branch), fetchCostMap()]);
    const g = {};
    rows.forEach(r => {
      if (r.void) return;
      const tid = parseInt(r.tableID);
      if (EXCLUDE_TABLES.includes(tid)) return;
      if (isExcludedItem(r.itemCode)) return;
      const date = String(r.prtOrdTime || r.startTime || '').slice(0, 10);
      const field = group_by === 'day' ? 'date' : group_by === 'month' ? 'month' : 'branch';
      const key = field === 'date' ? date : field === 'month' ? date.slice(0, 7)
        : (OUTLETS[r.outletID] || String(r.outletID));
      if (!g[key]) g[key] = { [field]: key, netSales: 0, cost: 0, prepCost: 0 };
      const unitCost = costMap[String(r.itemCode)] || costMap[String(r.itemCode).replace(/^0+/, '')] || 0;
      // โต๊ะ 500 = เตรียมของ (ไม่มียอดขาย) — แยกเป็น prepCost ไม่รวมในต้นทุนขาย (ตรงกับหน้ารายงาน)
      if (tid === 500) { g[key].prepCost += num(r.quantity) * unitCost; return; }
      g[key].netSales += num(r.grossPrice);
      g[key].cost += num(r.quantity) * unitCost;
    });
    const out = Object.values(g).map(x => ({
      ...x, netSales: r2(x.netSales), cost: r2(x.cost), prepCost: r2(x.prepCost),
      profit: r2(x.netSales - x.cost),
      costPct: x.netSales > 0 ? r2((x.cost / x.netSales) * 100) : 0,
    })).sort((a, b) => String(a.date || a.month || a.branch).localeCompare(String(b.date || b.month || b.branch)));
    return {
      rows: out,
      total: {
        netSales: r2(out.reduce((s, x) => s + x.netSales, 0)),
        cost: r2(out.reduce((s, x) => s + x.cost, 0)),
        profit: r2(out.reduce((s, x) => s + x.profit, 0)),
      },
      note: 'netSales = ยอดก่อน VAT · cost จากชีทต้นทุนเมนู (เมนูที่ไม่มีต้นทุนในชีทคิดเป็น 0) · costPct = ต้นทุน%',
    };
  },

  // รายการยกเลิก (void): สรุปต่อสาขา + เมนูที่โดน void บ่อย
  async get_voids({ start_date, end_date, branch }) {
    assertRange(start_date, end_date, 366);
    const rows = await fetchDetails(start_date, end_date, branch);
    const voided = rows.filter(r => r.void && !EXCLUDE_TABLES.includes(parseInt(r.tableID)));
    const byBranch = {}, byItem = {}, byType = {};
    voided.forEach(r => {
      const b = OUTLETS[r.outletID] || String(r.outletID);
      if (!byBranch[b]) byBranch[b] = { branch: b, lines: 0, qty: 0, value: 0 };
      byBranch[b].lines++; byBranch[b].qty += num(r.quantity); byBranch[b].value += num(r.grossPrice);
      const ik = `${r.itemCode} ${String(r.nameThai || '').trim()}`;
      if (!byItem[ik]) byItem[ik] = { item: ik, lines: 0, qty: 0 };
      byItem[ik].lines++; byItem[ik].qty += num(r.quantity);
      const vt = String(r.voidType || 'ไม่ระบุ').trim() || 'ไม่ระบุ';
      byType[vt] = (byType[vt] || 0) + 1;
    });
    return {
      totalLines: voided.length,
      totalValue: r2(voided.reduce((s, r) => s + num(r.grossPrice), 0)),
      byBranch: Object.values(byBranch).map(x => ({ ...x, qty: r2(x.qty), value: r2(x.value) }))
        .sort((a, b) => b.value - a.value),
      topItems: Object.values(byItem).sort((a, b) => b.lines - a.lines).slice(0, 10),
      byVoidType: byType,
    };
  },

  // จำนวนลูกค้า (หัว) + ยอดใช้จ่ายต่อหัว — นับจากจานบุฟเฟต์ที่จ่ายจริง (สาขา WRM/WMT ใช้ coverAll)
  async get_covers({ start_date, end_date, branch, group_by = 'branch' }) {
    assertRange(start_date, end_date, 366);
    const BUFFET = ['101001', '101002', '101003', '101004', '101107'];
    const COVERALL_OUTLETS = [501, 503];
    const [dets, sales] = await Promise.all([
      fetchDetails(start_date, end_date, branch),
      fetchSales(start_date, end_date, branch),
    ]);
    const field = group_by === 'day' ? 'date' : group_by === 'month' ? 'month' : 'branch';
    const keyOf = (dateStr, outletID) => field === 'date' ? dateStr
      : field === 'month' ? dateStr.slice(0, 7)
      : (OUTLETS[outletID] || String(outletID));
    const g = {};
    dets.forEach(r => {
      if (r.void) return;
      if (!BUFFET.includes(String(r.itemCode))) return;
      if (COVERALL_OUTLETS.includes(parseInt(r.outletID))) return;
      const k = keyOf(String(r.prtOrdTime || r.startTime || '').slice(0, 10), r.outletID);
      if (!g[k]) g[k] = { [field]: k, covers: 0, netSales: 0 };
      g[k].covers += num(r.quantity);
    });
    // สาขาที่ใช้ coverAll จากบิล + ยอดขายจากบิล (ก่อน VAT)
    sales.forEach(b => {
      const bt = num(b.billTotal) - num(b.voucher1);
      if (bt < 0) return;
      const k = keyOf(String(b.startTime || b.date || '').slice(0, 10), b.outletID);
      if (!g[k]) g[k] = { [field]: k, covers: 0, netSales: 0 };
      g[k].netSales += bt - num(b.vat);
      if (COVERALL_OUTLETS.includes(parseInt(b.outletID))) g[k].covers += num(b.coverAll);
    });
    const out = Object.values(g).map(x => ({
      ...x, covers: r2(x.covers), netSales: r2(x.netSales),
      spendPerHead: x.covers > 0 ? r2(x.netSales / x.covers) : null,
    })).sort((a, b) => String(a.date || a.month || a.branch).localeCompare(String(b.date || b.month || b.branch)));
    return { rows: out, note: 'covers = จานบุฟเฟต์ที่จ่ายจริง (ไม่รวมเด็กฟรี) · spendPerHead = ยอดก่อน VAT ÷ หัว' };
  },

  // ยอดขายรายชั่วโมง — ช่วงเวลาไหนขายดี
  async get_hourly_sales({ start_date, end_date, branch }) {
    const days = assertRange(start_date, end_date, 366);
    const rows = await fetchSales(start_date, end_date, branch);
    const g = {};
    rows.forEach(b => {
      const bt = num(b.billTotal) - num(b.voucher1);
      if (bt <= 0) return;
      const hh = String(b.startTime || b.date || '').slice(11, 13);
      if (!hh) return;
      const k = `${hh}:00`;
      if (!g[k]) g[k] = { hour: k, bills: 0, total: 0 };
      g[k].bills++; g[k].total += bt;
    });
    const out = Object.values(g).map(x => ({ ...x, total: r2(x.total) })).sort((a, b) => a.hour.localeCompare(b.hour));
    return { rows: out, days, note: 'อิงเวลาเปิดบิล ยอดรวม VAT · หารด้วย days = ค่าเฉลี่ยต่อวัน' };
  },

  // ค่าใช้จ่ายอื่นๆ (ค่าเช่า/ไฟ/น้ำ/แก๊ส/โทรศัพท์) เท่าที่ทีมบันทึกไว้ (dbo.expense_entry — เดิมคือชีท 1YXOaA…)
  async get_expenses({ month, branch }) {
    const list = await pickSource(() => readExpenses(), () => gasPost(EXPENSE_GAS, { action: 'getExpenses' }));
    let rows = list || [];
    if (month) rows = rows.filter(r => String(r.month) === String(month));
    if (branch) rows = rows.filter(r => String(r.branch).toUpperCase() === String(branch).toUpperCase());
    if (!rows.length) return { found: false, message: 'ไม่มีข้อมูลค่าใช้จ่ายตามเงื่อนไข', months: [...new Set((list || []).map(r => r.month))].sort() };
    const g = {};
    rows.forEach(r => {
      const k = `${r.month}|${r.branch}|${r.type}`;
      if (!g[k]) g[k] = { month: r.month, branch: r.branch, type: r.type, total: 0 };
      g[k].total += num(r.total);
    });
    const out = Object.values(g).map(x => ({ ...x, total: r2(x.total) }))
      .sort((a, b) => a.month.localeCompare(b.month) || a.branch.localeCompare(b.branch));
    return {
      rows: out.slice(0, 200),
      grandTotal: r2(out.reduce((s, x) => s + x.total, 0)),
      note: 'ประเภท: ค่าเช่าพื้นที่/ไฟฟ้า/น้ำประปา/แก๊ส/tel — ข้อมูลเท่าที่ทีมบันทึกในระบบ',
    };
  },

  // สรุปจำนวนพนักงาน (นับจำนวน ไม่เปิดเผยข้อมูลส่วนตัว) — dbo.hr_employee เดิมคือชีทแท็บ DATA
  async get_employees_summary({ branch }) {
    const list = await pickSource(() => readEmployees(), () => gasPost(HR_GAS, { action: 'getEmployees', branch: 'all' }));
    let emps = (list || []).filter(e => e.hrCode && String(e.fullName || '').trim() !== 'ชื่อ - สกุล');
    if (branch) emps = emps.filter(e => String(e.branch).toUpperCase() === String(branch).toUpperCase());
    const byBranch = {};
    emps.forEach(e => {
      const b = String(e.branch || '-').toUpperCase();
      if (!byBranch[b]) byBranch[b] = { branch: b, active: 0, resigned: 0 };
      if (e.status === 'ลาออก') byBranch[b].resigned++; else byBranch[b].active++;
    });
    return {
      total: emps.length,
      active: emps.filter(e => e.status !== 'ลาออก').length,
      resigned: emps.filter(e => e.status === 'ลาออก').length,
      byBranch: Object.values(byBranch).sort((a, b) => b.active - a.active),
    };
  },

  // ── ข้อมูลจากเครื่องสแกนนิ้ว ZKBio Time 9 (ผ่าน host API → SQLEXPRESS) ──

  // เวลาเข้า-ออกงานจากการสแกนนิ้ว: สแกนแรก/สแกนสุดท้ายของแต่ละคนต่อวัน
  async get_attendance({ start_date, end_date, employee, limit = 100 }) {
    assertRange(start_date, end_date, 92);
    const [punches, emps] = await Promise.all([
      fetchZk(`/zk/transactions?start=${start_date}&end=${end_date}`),
      fetchZk('/zk/employees').catch(() => []), // ดึงชื่อไม่ได้ก็ยังตอบด้วยรหัสพนักงานได้
    ]);
    const nameOf = {};
    emps.forEach(e => { nameOf[txt(e.emp_code)] = `${txt(e.first_name)} ${txt(e.last_name)}`.trim(); });
    let rows = punches;
    if (employee) {
      const kw = txt(employee).toLowerCase();
      rows = rows.filter(p => {
        const code = txt(p.emp_code);
        return code.toLowerCase() === kw || (nameOf[code] || '').toLowerCase().includes(kw);
      });
      if (!rows.length) return { found: false, message: `ไม่พบการสแกนของ "${employee}" ในช่วง ${start_date} ถึง ${end_date}` };
    }
    const g = {};
    rows.forEach(p => {
      const code = txt(p.emp_code);
      const t = txt(p.punch_time);
      const date = t.slice(0, 10), hm = t.slice(11, 16);
      const k = `${code}|${date}`;
      if (!g[k]) g[k] = { empCode: code, name: nameOf[code] || '', date, firstIn: hm, lastOut: hm, punches: 0, terminal: txt(p.terminal_alias || p.area_alias) };
      if (hm < g[k].firstIn) g[k].firstIn = hm;
      if (hm > g[k].lastOut) g[k].lastOut = hm;
      g[k].punches++;
    });
    const out = Object.values(g).sort((a, b) => a.date.localeCompare(b.date) || a.empCode.localeCompare(b.empCode));
    const cap = rowCap(limit, 100);
    return {
      totalPunches: rows.length,
      totalRows: out.length,
      rows: out.slice(0, cap),
      truncated: out.length > cap ? `แสดง ${cap} จาก ${out.length} แถว — ระบุ employee หรือช่วงวันที่แคบลง` : undefined,
      note: 'firstIn/lastOut = เวลาสแกนแรก/สุดท้ายของวันจากเครื่องสแกนนิ้ว ZKBio Time · สแกนครั้งเดียว = firstIn เท่ากับ lastOut (อาจลืมสแกนออก)',
    };
  },

  // รายชื่อพนักงานที่ลงทะเบียนในเครื่องสแกนนิ้ว + แผนก
  async get_zk_employees({ search, limit = 50 }) {
    const emps = await fetchZk('/zk/employees');
    let list = emps.map(e => ({
      empCode: txt(e.emp_code),
      name: `${txt(e.first_name)} ${txt(e.last_name)}`.trim(),
      department: txt(e.dept_name),
      hireDate: txt(e.hire_date).slice(0, 10),
    }));
    const kw = txt(search).toLowerCase();
    if (kw) list = list.filter(e => e.empCode.toLowerCase() === kw || e.name.toLowerCase().includes(kw) || e.department.toLowerCase().includes(kw));
    const cap = rowCap(limit);
    return {
      totalEmployees: list.length,
      employees: list.slice(0, cap),
      truncated: list.length > cap ? `แสดง ${cap} จาก ${list.length} คน — ใส่ search เพื่อกรอง` : undefined,
      note: 'รายชื่อจากฐานข้อมูลเครื่องสแกนนิ้ว ZKBio Time (คนละชุดกับทะเบียนพนักงานในชีท HR)',
    };
  },

  // ── ข้อมูลจาก Google Sheet (อ่านอย่างเดียวทั้งหมด) ──

  // สารบัญชีท: มีชีทอะไร แท็บอะไรบ้าง — ใช้ก่อน read_sheet เมื่อไม่มีเครื่องมือเฉพาะรองรับ
  async list_sheets() {
    return {
      sheets: Object.entries(SHEETS).map(([key, s]) => ({
        sheet: key, title: s.title, tabs: Object.keys(s.tabs), about: s.about,
      })),
      note: 'ข้อมูลที่ใช้บ่อยมีเครื่องมือเฉพาะแล้ว (get_menu_costs, get_menu_recipe, get_raw_materials, get_stock_counts, get_purchase_plan, get_branch_requisition, get_material_usage) ให้เลือกใช้ตัวเฉพาะก่อน — read_sheet ไว้ใช้กับข้อมูลที่ไม่มีเครื่องมือรองรับเท่านั้น',
    };
  },

  // อ่านแท็บใดก็ได้ในทะเบียนแบบดิบ — ตัวช่วยครอบจักรวาลสำหรับคำถามที่เครื่องมือเฉพาะไม่ครอบคลุม
  async read_sheet({ sheet, tab, search, limit = 50 }) {
    if (!sheet || !tab) throw new Error('ต้องระบุ sheet และ tab (ดูรายการที่มีจาก list_sheets)');
    const rows = await fetchTab(sheet, tab);
    if (!rows.length) return { sheet, tab, totalRows: 0, rows: [] };
    // จำกัด 24 คอลัมน์แรก กัน token บวมจากชีทที่มีคอลัมน์สูตรพ่วงท้ายเยอะ
    const headers = (rows[0] || []).slice(0, 24).map((h, i) => txt(h) || `col${i + 1}`);
    let body = rows.slice(1).filter(r => r.some(x => txt(x)));
    const kw = txt(search).toLowerCase();
    if (kw) body = body.filter(r => r.some(x => txt(x).toLowerCase().includes(kw)));
    const cap = rowCap(limit);
    return {
      sheet, tab, headers, totalRows: body.length,
      rows: body.slice(0, cap).map(r => Object.fromEntries(headers.map((h, i) => [h, txt(r[i])]))),
      truncated: body.length > cap ? `แสดง ${cap} จาก ${body.length} แถว — ใส่ search เพื่อกรองให้แคบลง` : undefined,
      note: 'แถวแรกถูกใช้เป็นหัวคอลัมน์ — แท็บ "ใบเบิก" ไม่มีหัวคอลัมน์จริง ให้ใช้ get_branch_requisition แทน',
    };
  },

  // เมนูขายทั้งหมด: ราคา ต้นทุน ต้นทุน% หมวด สถานะ (ชีท qcrd/menu)
  async get_menu_costs({ search, missing_cost_only, limit = 50 }) {
    const [rows, groupRows] = await Promise.all([fetchTab('qcrd', 'menu'), fetchTab('qcrd', 'menucodegroup')]);
    const groupName = {};
    groupRows.slice(1).forEach(r => { const c = txt(r[0]); if (c) groupName[c] = txt(r[1]); });
    let list = rows.slice(1).filter(r => txt(r[0])).map(r => {
      const price = snum(r[3]) || 0, cost = snum(r[4]) || 0;
      return {
        code: txt(r[0]), name: txt(r[1]),
        group: groupName[txt(r[2])] || txt(r[2]),
        price: r2(price), cost: r2(cost),
        costPct: price > 0 ? r2((cost / price) * 100) : null,
        status: txt(r[5]) || 'ใช้งาน',
      };
    });
    const kw = txt(search).toLowerCase();
    if (kw) list = list.filter(m => m.code.toLowerCase() === kw || m.name.toLowerCase().includes(kw) || m.group.toLowerCase().includes(kw));
    if (missing_cost_only) list = list.filter(m => !m.cost);
    const cap = rowCap(limit);
    return {
      totalMenus: list.length,
      menus: list.slice(0, cap),
      truncated: list.length > cap ? `แสดง ${cap} จาก ${list.length} เมนู` : undefined,
      note: 'cost = ต้นทุนวัตถุดิบต่อจานจากสูตร BOM · costPct = ต้นทุน ÷ ราคาขาย × 100 · ต้นทุน 0 = ยังไม่ได้ทำสูตรในชีท',
    };
  },

  // สูตรวัตถุดิบของเมนู (ชีท qcrd/BOM) — ค้นด้วยรหัสเมนูหรือบางส่วนของชื่อ
  async get_menu_recipe({ menu }) {
    if (!menu) throw new Error('ต้องระบุ menu (รหัสเมนูหรือบางส่วนของชื่อเมนู)');
    const rows = await fetchTab('qcrd', 'BOM');
    const kw = txt(menu).toLowerCase();
    const hit = rows.slice(1).filter(r => txt(r[0]).toLowerCase() === kw || txt(r[1]).toLowerCase().includes(kw));
    if (!hit.length) return { found: false, message: `ไม่พบสูตรของ "${menu}" ในชีท BOM` };
    const byMenu = {};
    hit.forEach(r => {
      const code = txt(r[0]);
      if (!byMenu[code]) byMenu[code] = { menuCode: code, menuName: txt(r[1]), items: [], totalCost: 0 };
      const lineCost = snum(r[13]) || 0;
      byMenu[code].items.push({
        seq: txt(r[2]), itemCode: txt(r[3]), itemName: txt(r[4]),
        qtyPerServe: snum(r[5]), converter: snum(r[7]),
        itemPrice: snum(r[9]), lineCost: r2(lineCost),
      });
      byMenu[code].totalCost += lineCost;
    });
    const menus = Object.values(byMenu).map(m => ({ ...m, totalCost: r2(m.totalCost) }));
    return {
      found: true, matched: menus.length, menus: menus.slice(0, 10),
      note: 'qtyPerServe = ยอดใช้ต่อ 1 จาน (หน่วยเล็ก เช่น กรัม) · converter = หน่วยเล็กต่อ 1 หน่วยซื้อ · lineCost = ต้นทุนวัตถุดิบตัวนั้นต่อจาน',
    };
  },

  // วัตถุดิบทั้งหมด (ชีท qcrd/item): รหัส ชื่อ ราคา หน่วย ตัวแปลง สาขาที่ใช้ หมวดสโตร์ สถานะ
  async get_raw_materials({ search, store_category, branch, status, limit = 50 }) {
    const rows = await fetchTab('qcrd', 'item');
    let list = rows.slice(1).filter(r => txt(r[0])).map(r => ({
      code: txt(r[0]), name: txt(r[1]),
      price: snum(r[2]), unit: txt(r[3]),
      status: txt(r[4]) || 'ใช้งาน',
      subs: [r[5], r[6], r[7]].map(txt).filter(Boolean),
      converter: snum(r[8]),
      usedBranches: txt(r[9]).split(',').map(s => s.trim()).filter(Boolean),
      storeCategory: txt(r[13]),
    }));
    const kw = txt(search).toLowerCase();
    if (kw) list = list.filter(i => i.code.toLowerCase() === kw || i.code.replace(/^0+/, '') === kw.replace(/^0+/, '') || i.name.toLowerCase().includes(kw));
    if (store_category) list = list.filter(i => i.storeCategory === txt(store_category));
    if (branch) list = list.filter(i => i.usedBranches.some(b => b.toUpperCase() === txt(branch).toUpperCase()));
    if (status) list = list.filter(i => i.status === txt(status));
    const cap = rowCap(limit);
    return {
      totalItems: list.length,
      items: list.slice(0, cap),
      storeCategories: [...new Set(rows.slice(1).map(r => txt(r[13])).filter(Boolean))],
      truncated: list.length > cap ? `แสดง ${cap} จาก ${list.length} รายการ — ใส่ search เพื่อกรองให้แคบลง` : undefined,
      note: 'price = ราคาต่อหน่วยซื้อ · converter = หน่วยเล็กต่อ 1 หน่วยซื้อ · storeCategory = ตำแหน่งจัดเก็บ · subs = รหัสไอเทมทดแทน',
    };
  },

  // วัตถุดิบตัวนี้ถูกใช้ในเมนูอะไรบ้าง (ค้นย้อนจากชีท qcrd/BOM)
  async which_menus_use_item({ item, limit = 50 }) {
    if (!item) throw new Error('ต้องระบุ item (รหัสหรือบางส่วนของชื่อวัตถุดิบ)');
    const rows = await fetchTab('qcrd', 'BOM');
    const kw = txt(item).toLowerCase();
    const hit = rows.slice(1).filter(r => {
      const code = txt(r[3]).toLowerCase();
      return code === kw || code.replace(/^0+/, '') === kw.replace(/^0+/, '') || txt(r[4]).toLowerCase().includes(kw);
    });
    if (!hit.length) return { found: false, message: `ไม่มีเมนูไหนใช้วัตถุดิบ "${item}" ในชีท BOM` };
    const cap = rowCap(limit);
    return {
      found: true,
      matchedItems: [...new Set(hit.map(r => `${txt(r[3])} ${txt(r[4])}`))].slice(0, 10),
      totalMenus: hit.length,
      menus: hit.slice(0, cap).map(r => ({
        menuCode: txt(r[0]), menuName: txt(r[1]),
        itemCode: txt(r[3]), itemName: txt(r[4]),
        qtyPerServe: snum(r[5]), lineCost: r2(snum(r[13]) || 0),
      })),
      truncated: hit.length > cap ? `แสดง ${cap} จาก ${hit.length} เมนู` : undefined,
    };
  },

  // ยอดคงเหลือสต๊อกล่าสุดต่อสาขา (จาก Apps Script สต๊อก)
  async get_stock_counts({ branch, search, limit = 50 }) {
    const list = await gasPost(HR_GAS, { action: 'getStockTotal', endDate: '' });
    const kw = txt(search).toLowerCase();
    const bq = txt(branch).toUpperCase();
    let items = (list || []).map(it => {
      let details = (it.branchDetails || []).map(bd => ({
        branch: txt(bd.branch).toUpperCase(),
        remaining: snum(bd.remaining) || 0,
        countedAt: txt(bd.date).split(' ')[0],
      }));
      if (bq) details = details.filter(d => d.branch === bq);
      return {
        code: txt(it.productId), name: txt(it.name),
        unit: txt(it.unit), storeCategory: txt(it.storageCat),
        totalRemaining: r2(details.reduce((s, d) => s + d.remaining, 0)),
        branches: details,
      };
    });
    if (bq) items = items.filter(i => i.branches.length);
    if (kw) items = items.filter(i => i.code.toLowerCase() === kw || i.name.toLowerCase().includes(kw) || i.storeCategory.toLowerCase().includes(kw));
    const cap = rowCap(limit);
    return {
      totalItems: items.length,
      items: items.slice(0, cap),
      truncated: items.length > cap ? `แสดง ${cap} จาก ${items.length} รายการ — ใส่ search หรือ branch เพื่อกรองให้แคบลง` : undefined,
      note: 'remaining = ยอดคงเหลือจากการนับครั้งล่าสุดของสาขานั้น (countedAt = วันที่นับ) ไม่ใช่ยอด real-time',
    };
  },

  // ประวัติการสั่งของแต่ละสาขา (dbo.stock_plan — เดิมคือชีท stock/plan)
  async get_purchase_plan({ branch, start_date, end_date, search, group_by, limit = 50 }) {
    // ทั้งสองทางเก็บวันที่สั่งเป็น DD/MM/YYYY — แปลงเป็น YYYY-MM-DD ก่อนเทียบช่วง
    const toYMD = s => {
      const m = txt(s).split(' ')[0].split('/');
      return m.length === 3 ? `${m[2]}-${m[1].padStart(2, '0')}-${m[0].padStart(2, '0')}` : '';
    };
    const fromSheet = async () => {
      const rows = await fetchTab('stock', 'plan');
      const col = colFinder(rows[0]);
      const c = {
        orderDate: col('วันที่สั่ง'), branch: col('สาขา'), orderNo: col('เลขที่ใบสั่ง'),
        receiveDate: col('วันที่รับ'), itemCode: col('รหัสสินค้า'), itemName: col('ชื่อสินค้า'),
        qty: col('จำนวน'), unit: col('หน่วย'), unitPrice: col('ราคา/หน่วย'),
        total: col('มูลค่ารวม'), type: col('ประเภท'),
      };
      return rows.slice(1).filter(r => txt(r[c.itemCode])).map(r => ({
        orderDate: r[c.orderDate], branch: r[c.branch], orderNo: r[c.orderNo],
        receiveDate: r[c.receiveDate], itemCode: r[c.itemCode], itemName: r[c.itemName],
        qty: r[c.qty], unit: r[c.unit], unitPrice: r[c.unitPrice], total: r[c.total], type: r[c.type],
      }));
    };
    const raw = await pickSource(() => readPlan(), fromSheet);
    let list = raw.filter(r => txt(r.itemCode)).map(r => ({
      orderDate: toYMD(r.orderDate),
      branch: txt(r.branch).toUpperCase(),
      orderNo: txt(r.orderNo), receiveDate: txt(r.receiveDate),
      itemCode: txt(r.itemCode), itemName: txt(r.itemName),
      qty: snum(r.qty) || 0, unit: txt(r.unit),
      unitPrice: snum(r.unitPrice) || 0, total: snum(r.total) || 0,
      type: txt(r.type),
    }));
    if (branch) list = list.filter(x => x.branch === txt(branch).toUpperCase());
    if (start_date) list = list.filter(x => x.orderDate && x.orderDate >= start_date);
    if (end_date) list = list.filter(x => x.orderDate && x.orderDate <= end_date);
    const kw = txt(search).toLowerCase();
    if (kw) list = list.filter(x => x.itemCode.toLowerCase() === kw || x.itemName.toLowerCase().includes(kw));
    const grandTotal = r2(list.reduce((s, x) => s + x.total, 0));

    // สรุปรวมแทนการไล่รายแถว เมื่อผู้ใช้ถามภาพรวม (ประหยัด token กว่ามาก)
    if (group_by === 'branch' || group_by === 'item') {
      const g = {};
      list.forEach(x => {
        const k = group_by === 'branch' ? x.branch : `${x.itemCode}|${x.itemName}`;
        if (!g[k]) g[k] = group_by === 'branch'
          ? { branch: k, orders: 0, qty: 0, total: 0 }
          : { itemCode: x.itemCode, itemName: x.itemName, orders: 0, qty: 0, total: 0 };
        g[k].orders++; g[k].qty += x.qty; g[k].total += x.total;
      });
      const out = Object.values(g).map(x => ({ ...x, qty: r2(x.qty), total: r2(x.total) }))
        .sort((a, b) => b.total - a.total);
      return { groupedBy: group_by, rows: out.slice(0, 100), grandTotal, totalRows: list.length };
    }

    const cap = rowCap(limit);
    return {
      totalRows: list.length, grandTotal,
      rows: list.slice(0, cap),
      truncated: list.length > cap ? `แสดง ${cap} จาก ${list.length} แถว — ใช้ group_by หรือใส่ตัวกรองเพิ่ม` : undefined,
      note: 'total = มูลค่ารวมของแถวนั้น · ใช้ group_by="branch" หรือ "item" เพื่อดูภาพรวมแทนรายแถว',
    };
  },

  // ใบเบิกของสาขา (ชีท requisition/ใบเบิก + ข้อมูลไอเทมจากแท็บ data)
  async get_branch_requisition({ branch, month, search, group_by, limit = 50 }) {
    const [reqRows, dataRows] = await Promise.all([
      fetchTab('requisition', 'ใบเบิก'),
      fetchTab('requisition', 'data'),
    ]);
    const col = colFinder(dataRows[0]);
    const c = { code: col('รหัสอุปกรณ์ใหม่'), name: col('รายการสินค้า'), unit: col('หน่วย'), price: col('ราคา'), supplier: col('ซัพฯ') };
    const info = {};
    dataRows.slice(1).forEach(r => {
      const n = txt(r[c.name]);
      if (n) info[n] = { code: txt(r[c.code]), unit: txt(r[c.unit]), price: snum(r[c.price]), supplier: txt(r[c.supplier]) };
    });
    // แท็บ "ใบเบิก" ไม่มีหัวคอลัมน์ — เรียงตายตัว: เวลาบันทึก(DD/MM/YYYY HH:MM:SS), สาขา, ชื่อสินค้า, จำนวน
    let logs = reqRows.filter(r => r.some(x => txt(x))).map(r => {
      const ts = txt(r[0]);
      const d = ts.split(' ')[0].split('/');
      return {
        date: d.length === 3 ? `${d[2]}-${d[1].padStart(2, '0')}-${d[0].padStart(2, '0')}` : '',
        branch: txt(r[1]).toUpperCase(), itemName: txt(r[2]), qty: snum(r[3]) || 0,
      };
    }).filter(x => x.itemName && x.branch);
    if (branch) logs = logs.filter(x => x.branch === txt(branch).toUpperCase());
    if (month) logs = logs.filter(x => x.date.slice(0, 7) === txt(month));
    const kw = txt(search).toLowerCase();
    if (kw) logs = logs.filter(x => x.itemName.toLowerCase().includes(kw));
    const withInfo = logs.map(x => ({ ...x, ...(info[x.itemName] || {}), value: r2(x.qty * (info[x.itemName]?.price || 0)) }));

    if (group_by === 'branch' || group_by === 'item') {
      const g = {};
      withInfo.forEach(x => {
        const k = group_by === 'branch' ? x.branch : x.itemName;
        if (!g[k]) g[k] = group_by === 'branch' ? { branch: k, times: 0, qty: 0, value: 0 } : { itemName: k, unit: x.unit || '', times: 0, qty: 0, value: 0 };
        g[k].times++; g[k].qty += x.qty; g[k].value += x.value;
      });
      const out = Object.values(g).map(x => ({ ...x, qty: r2(x.qty), value: r2(x.value) })).sort((a, b) => b.qty - a.qty);
      return { groupedBy: group_by, rows: out.slice(0, 100), totalRows: withInfo.length };
    }

    const cap = rowCap(limit);
    return {
      totalRows: withInfo.length,
      branches: [...new Set(logs.map(x => x.branch))].sort(),
      rows: withInfo.slice(0, cap),
      truncated: withInfo.length > cap ? `แสดง ${cap} จาก ${withInfo.length} แถว — ใช้ group_by หรือใส่ month/branch` : undefined,
      note: 'value = จำนวน × ราคาต่อหน่วยจากแท็บ data (ไอเทมที่ไม่มีราคาในชีทคิดเป็น 0)',
    };
  },

  // ยอดใช้วัตถุดิบตามที่ระบบบันทึกไว้ในชีท (recipe/UsageHistory)
  async get_material_usage({ start_date, end_date, branch, item, limit = 50 }) {
    const rows = await fetchTab('recipe', 'UsageHistory');
    // A=วันที่ B=เลขสาขา C=ชื่อสาขา D=รหัสสินค้า F=จำนวนที่ใช้ไป
    let list = rows.slice(1).filter(r => txt(r[3])).map(r => ({
      date: txt(r[0]).slice(0, 10),
      branch: txt(r[2]).toUpperCase(),
      itemCode: txt(r[3]),
      qty: snum(r[5]) || 0,
    }));
    if (start_date) list = list.filter(x => x.date >= start_date);
    if (end_date) list = list.filter(x => x.date <= end_date);
    if (branch) list = list.filter(x => x.branch === txt(branch).toUpperCase());
    if (item) {
      const kw = txt(item).toLowerCase().replace(/^0+/, '');
      list = list.filter(x => x.itemCode.toLowerCase().replace(/^0+/, '') === kw);
    }
    const cap = rowCap(limit);
    return {
      totalRows: list.length,
      totalQty: r2(list.reduce((s, x) => s + x.qty, 0)),
      rows: list.slice(0, cap),
      truncated: list.length > cap ? `แสดง ${cap} จาก ${list.length} แถว` : undefined,
      note: 'ชีท UsageHistory หยุดอัปเดตแล้ว — ถ้าต้องการยอดใช้วัตถุดิบปัจจุบัน ให้คำนวณจาก get_top_items (ยอดขาย) × get_menu_recipe (สูตร BOM) แทน และบอกผู้ใช้ด้วยว่าข้อมูลชีทนี้เก่า',
    };
  },
};

// ── ตัวช่วยดึงข้อมูลภายนอก ──

// ทะเบียนชีท Google ทั้งหมดที่ AI เข้าถึงได้ (whitelist — อ่านอย่างเดียว ไม่มีทางเขียน)
// ค่าของ tab = gid → อ่านผ่าน export?format=csv (ได้ค่าดิบตรงตามชีท ไม่โดน gviz เดาชนิดคอลัมน์)
//              null → ชีทนั้นไม่รู้ gid ใช้ชื่อแท็บผ่าน gviz แทน
const SHEETS = {
  qcrd: {
    id: '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw',
    title: 'ต้นทุนเมนู QC/RD',
    tabs: { menu: '0', BOM: '419926693', item: '302875824', menucodegroup: '1491689317' },
    about: 'menu = เมนูขาย ราคา ต้นทุน · BOM = สูตรวัตถุดิบต่อเมนู · item = วัตถุดิบทั้งหมด · menucodegroup = ชื่อหมวดเมนู',
  },
  stock: {
    id: '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ',
    title: 'สต๊อก / แพลนสั่งของ',
    tabs: { plan: '571271047' },
    about: 'plan = ประวัติการสั่งของแต่ละสาขา (วันที่สั่ง สาขา สินค้า จำนวน มูลค่า)',
  },
  requisition: {
    id: '12Wb7tMXfT548XvK1H0Cp6uOysjS8ksmMFzQZ-Rpay2k',
    title: 'ใบเบิกของสาขา (จัดซื้อ)',
    tabs: { 'ใบเบิก': null, data: null },
    about: 'ใบเบิก = log ทุกครั้งที่สาขากดเบิก (ไม่มีหัวคอลัมน์ เรียงตายตัว: เวลา, สาขา, ชื่อสินค้า, จำนวน) · data = ข้อมูลไอเทม (รหัส หน่วย ราคา ซัพพลายเออร์)',
  },
  extraOrders: {
    id: '1gijgBrK56bsjR7-R5NVWiTGTcxM57wjuYR3FUpl3EDQ',
    title: 'ออเดอร์เพิ่มเติม (สั่งอาหารภายนอก)',
    tabs: { orders: '255916825', PaymentSummary: null },
    about: 'orders = รายการออเดอร์ที่สั่งนอกระบบ POS · PaymentSummary = ช่องทางจ่ายต่อออเดอร์',
  },
  recipe: {
    id: '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg',
    title: 'สูตรเมนู / ยอดใช้วัตถุดิบ',
    tabs: { RcpDtls: null, UsageHistory: null },
    about: 'RcpDtls = สูตรเมนูฝั่ง POS (A=รหัสเมนู C=ชื่อเมนู E=รหัสวัตถุดิบ) · UsageHistory = ยอดใช้วัตถุดิบที่ระบบบันทึก (ชีทนี้หยุดอัปเดตแล้ว ยอดใช้ปัจจุบันคำนวณจากยอดขาย × BOM แทน)',
  },
};

function parseCSV(text) {
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

// อ่านแท็บจากชีทในทะเบียน + cache 10 นาที (คำถามเดียวมักเรียกหลายเครื่องมือที่ใช้ชีทเดียวกัน)
const sheetCache = {};
async function fetchTab(sheetKey, tabName) {
  const src = SHEETS[sheetKey];
  if (!src) throw new Error(`ไม่รู้จักชีท "${sheetKey}" — ที่มี: ${Object.keys(SHEETS).join(', ')}`);
  if (!(tabName in src.tabs)) {
    throw new Error(`ชีท "${sheetKey}" ไม่มีแท็บ "${tabName}" — ที่มี: ${Object.keys(src.tabs).join(', ')}`);
  }
  const key = `${sheetKey}|${tabName}`;
  const hit = sheetCache[key];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.rows;
  const gid = src.tabs[tabName];
  const url = gid
    ? `https://docs.google.com/spreadsheets/d/${src.id}/export?format=csv&gid=${gid}`
    : `https://docs.google.com/spreadsheets/d/${src.id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status} (${sheetKey}/${tabName})`);
  const rows = parseCSV(await r.text());
  sheetCache[key] = { rows, at: Date.now() };
  return rows;
}

// หา index คอลัมน์จากชื่อหัวตาราง (กันชีทสลับตำแหน่งคอลัมน์ในอนาคต)
const colFinder = headerRow => {
  const header = (headerRow || []).map(h => txt(h));
  return name => header.indexOf(name);
};

// ต้นทุนต่อเมนูจากชีท menu (A=รหัส, E=ต้นทุน) — ใช้คำนวณกำไรใน get_cost_profit
async function fetchCostMap() {
  const rows = await fetchTab('qcrd', 'menu');
  const map = {};
  rows.slice(1).forEach(r => {
    const code = txt(r[0]);
    const cost = snum(r[4]);
    if (code && cost !== null && !(code in map)) map[code] = cost;
  });
  return map;
}

// อ่านจาก SQL ก่อนเมื่อเปิด SHEETS_SOURCE=sql — ฐานล่มค่อยถอยไปอ่านชีท/GAS
// (เครื่องมือของ AI เป็นแบบอ่านอย่างเดียว การถอยจึงแค่ทำให้ข้อมูลเก่าลง ไม่ทำให้ข้อมูลสองที่เพี้ยน)
async function pickSource(fromSql, fromSheet) {
  if (usingSheetsSql()) {
    try { return await fromSql(); }
    catch (err) { console.error('ai-chat: อ่าน SQL ไม่ได้ — ถอยไปอ่านชีท:', err.message); }
  }
  return fromSheet();
}

async function gasPost(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const j = await r.json();
  if (j.status !== 'success') throw new Error(j.message || 'GAS error');
  return j.data;
}

// ── นิยามเครื่องมือให้ Gemini ──
const TOOL_DECLARATIONS = [
  {
    name: 'get_daily_sales',
    description: 'ยอดขายสรุป (จำนวนบิล, ยอดรวม VAT, VAT, ยอดก่อน VAT) จากฐานข้อมูลจริง — ถามช่วงยาวได้ถึง 366 วัน ' +
      'เช่น ทั้งปี/หลายเดือนรวดเดียว ระบบหั่นดึงเป็นก้อนให้เอง คืนยอดรวมทั้งช่วงมาในฟิลด์ total ด้วย',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (สูงสุด 366 วัน)' },
        branch: { type: 'STRING', description: 'รหัสสาขา เช่น SJP, XUM (ไม่ระบุ = ทุกสาขา)' },
        group_by: {
          type: 'STRING',
          description: 'ระดับการรวบ: "day_branch" รายวัน×สาขา (default เมื่อช่วง ≤62 วัน), ' +
            '"month_branch" รายเดือน×สาขา (default เมื่อช่วงยาวกว่านั้น), "day", "month", "branch" — ' +
            'ถามหลายเดือนให้ใช้ month หรือ month_branch จะได้ตารางอ่านง่าย',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_top_items',
    description: 'ดึงรายการอาหาร/สินค้าขายดี Top N ในช่วงวันที่ (จำนวนและยอดเงินต่อเมนู) — ถามยาวได้ถึง 366 วัน',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        limit: { type: 'NUMBER', description: 'จำนวนอันดับ (default 20) — ใส่ 0 = ทุกเมนูที่ขายได้ในช่วงนั้น' },
        by: { type: 'STRING', description: '"amount" เรียงตามยอดเงิน หรือ "qty" เรียงตามจำนวน' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_payment_summary',
    description: 'สรุปยอดตามช่องทางการชำระเงิน (เงินสด เครดิต QR Grab ฯลฯ) ในช่วงวันที่',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' }, end_date: { type: 'STRING' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_bill_detail',
    description: 'ดูรายละเอียดบิลใบเดียว: ยอด, ช่องทางจ่าย, รายการอาหารทุกบรรทัด',
    parameters: {
      type: 'OBJECT',
      properties: {
        check_id: { type: 'STRING', description: 'เลขบิล (checkID)' },
        branch: { type: 'STRING', description: 'รหัสสาขา เช่น SJP' },
        date: { type: 'STRING', description: 'วันที่ของบิล YYYY-MM-DD' },
      },
      required: ['check_id', 'branch', 'date'],
    },
  },
  { name: 'get_branches', description: 'รายชื่อสาขาทั้งหมดพร้อม outletID', parameters: { type: 'OBJECT', properties: {} } },
  {
    name: 'get_bills',
    description: 'รายการบิลแบบแยกรายใบ (เลขบิล เวลา โต๊ะ ยอด ช่องทางจ่าย) สูงสุด 31 วันต่อครั้ง — ใช้เมื่อผู้ใช้อยากไล่ดูบิลทีละใบ',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (ห่างกันไม่เกิน 31 วัน)' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        limit: { type: 'NUMBER', description: 'จำนวนบิลสูงสุดที่แสดง (default 100) — ใส่ 0 = ทุกใบในช่วงนั้น' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_item_sales',
    description: 'เจาะยอดขายของเมนูเดียว ค้นด้วยรหัสหรือบางส่วนของชื่อ แยกเป็นรายวันหรือรายสาขา — ใช้เมื่อถามถึงเมนูเฉพาะเจาะจง เช่น "เนื้อริบอายขายวันไหนเท่าไหร่"',
    parameters: {
      type: 'OBJECT',
      properties: {
        item: { type: 'STRING', description: 'รหัสเมนู หรือบางส่วนของชื่อเมนู เช่น "ริบอาย"' },
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (สูงสุด 366 วัน)' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        group_by: { type: 'STRING', description: '"day" รายวัน (default), "month" รายเดือน (แนะนำเมื่อถามหลายเดือน), "branch" รายสาขา' },
      },
      required: ['item', 'start_date', 'end_date'],
    },
  },
  {
    name: 'get_cost_profit',
    description: 'วิเคราะห์ต้นทุนและกำไร: ยอดขายก่อน VAT, ต้นทุนวัตถุดิบ (จากชีทต้นทุนเมนู), กำไร, ต้นทุน% แยกรายวัน/รายเดือน/รายสาขา',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 366 วัน' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        group_by: { type: 'STRING', description: '"branch" (default), "day" หรือ "month"' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_voids',
    description: 'วิเคราะห์รายการยกเลิก (void): จำนวน/มูลค่าต่อสาขา เมนูที่โดน void บ่อย และประเภทการ void',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 366 วัน' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_covers',
    description: 'จำนวนลูกค้า (หัว/จานบุฟเฟต์ที่จ่ายจริง) และยอดใช้จ่ายเฉลี่ยต่อหัว แยกรายวันหรือรายสาขา',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 366 วัน' },
        branch: { type: 'STRING' },
        group_by: { type: 'STRING', description: '"branch" (default), "day" หรือ "month"' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_hourly_sales',
    description: 'ยอดขายแยกรายชั่วโมง (ช่วงเวลาไหนขายดี/บิลเยอะ) อิงเวลาเปิดบิล',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 366 วัน' },
        branch: { type: 'STRING' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_expenses',
    description: 'ค่าใช้จ่ายอื่นๆ ที่ทีมบันทึกไว้ (ค่าเช่าพื้นที่ ไฟฟ้า น้ำประปา แก๊ส โทรศัพท์) ต่อเดือนต่อสาขา',
    parameters: {
      type: 'OBJECT',
      properties: {
        month: { type: 'STRING', description: 'เดือน YYYY-MM (ไม่ระบุ = ทุกเดือน)' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
      },
    },
  },
  {
    name: 'get_employees_summary',
    description: 'สรุปจำนวนพนักงาน: ทั้งหมด/ทำงานอยู่/ลาออก แยกรายสาขา',
    parameters: {
      type: 'OBJECT',
      properties: { branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' } },
    },
  },
  {
    name: 'get_menu_costs',
    description: 'รายการเมนูขายทั้งหมดจากชีทต้นทุนเมนู: ราคาขาย ต้นทุนวัตถุดิบต่อจาน ต้นทุน% หมวดเมนู สถานะ — ใช้เมื่อถามถึง "ต้นทุนเมนู" "เมนูไหนกำไรดี" "เมนูที่ยังไม่มีต้นทุน"',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: { type: 'STRING', description: 'รหัสเมนู ชื่อเมนู หรือชื่อหมวด (ไม่ระบุ = ทั้งหมด)' },
        missing_cost_only: { type: 'BOOLEAN', description: 'true = เอาเฉพาะเมนูที่ยังไม่มีต้นทุนในชีท' },
        limit: { type: 'NUMBER', description: 'จำนวนสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
    },
  },
  {
    name: 'get_menu_recipe',
    description: 'สูตรวัตถุดิบของเมนู (BOM): ใช้วัตถุดิบอะไรบ้าง อย่างละเท่าไหร่ต่อจาน ต้นทุนแต่ละตัว — ใช้เมื่อถาม "เมนูนี้ใช้อะไรบ้าง" "สูตรเมนู…"',
    parameters: {
      type: 'OBJECT',
      properties: { menu: { type: 'STRING', description: 'รหัสเมนู หรือบางส่วนของชื่อเมนู' } },
      required: ['menu'],
    },
  },
  {
    name: 'get_raw_materials',
    description: 'วัตถุดิบทั้งหมดจากชีท item: รหัส ชื่อ ราคาต้นทุน หน่วย ตัวแปลงหน่วย สาขาที่ใช้ หมวดสโตร์ สถานะ ไอเทมทดแทน — ใช้เมื่อถามถึงราคา/ข้อมูลวัตถุดิบ',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: { type: 'STRING', description: 'รหัสหรือบางส่วนของชื่อวัตถุดิบ' },
        store_category: { type: 'STRING', description: 'หมวดสโตร์ (ตำแหน่งจัดเก็บ) เช่น ของแห้ง' },
        branch: { type: 'STRING', description: 'เอาเฉพาะวัตถุดิบที่สาขานี้ใช้' },
        status: { type: 'STRING', description: '"ใช้งาน" หรือ "ปิดการใช้งาน"' },
        limit: { type: 'NUMBER', description: 'จำนวนสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
    },
  },
  {
    name: 'which_menus_use_item',
    description: 'ค้นย้อนว่าวัตถุดิบตัวหนึ่งถูกใช้ในเมนูอะไรบ้าง พร้อมปริมาณต่อจาน — ใช้เมื่อถาม "วัตถุดิบนี้ใช้เมนูไหนบ้าง" หรือประเมินผลกระทบเวลาราคาวัตถุดิบขึ้น',
    parameters: {
      type: 'OBJECT',
      properties: {
        item: { type: 'STRING', description: 'รหัสหรือบางส่วนของชื่อวัตถุดิบ' },
        limit: { type: 'NUMBER', description: 'จำนวนสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
      required: ['item'],
    },
  },
  {
    name: 'get_stock_counts',
    description: 'ยอดคงเหลือสต๊อกจากการนับครั้งล่าสุดของแต่ละสาขา (รหัส ชื่อ หน่วย หมวดสโตร์ ยอดคงเหลือ วันที่นับ) — ใช้เมื่อถาม "ของเหลือเท่าไหร่" "สาขาไหนของใกล้หมด"',
    parameters: {
      type: 'OBJECT',
      properties: {
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        search: { type: 'STRING', description: 'รหัส/ชื่อวัตถุดิบ หรือหมวดสโตร์' },
        limit: { type: 'NUMBER', description: 'จำนวนสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
    },
  },
  {
    name: 'get_purchase_plan',
    description: 'ประวัติการสั่งของ (แพลนสินค้า) ของแต่ละสาขาจากชีท plan: วันที่สั่ง สินค้า จำนวน มูลค่า — ใช้เมื่อถาม "สาขาไหนสั่งของเท่าไหร่" "สั่งอะไรบ่อย" "ยอดสั่งซื้อเดือนนี้"',
    parameters: {
      type: 'OBJECT',
      properties: {
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        start_date: { type: 'STRING', description: 'วันที่สั่งตั้งแต่ YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันที่สั่งถึง YYYY-MM-DD' },
        search: { type: 'STRING', description: 'รหัสหรือชื่อสินค้า' },
        group_by: { type: 'STRING', description: '"branch" หรือ "item" = สรุปรวมแทนรายแถว (แนะนำเมื่อถามภาพรวม)' },
        limit: { type: 'NUMBER', description: 'จำนวนแถวสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
    },
  },
  {
    name: 'get_branch_requisition',
    description: 'ใบเบิกของสาขา (จัดซื้อ): สาขาไหนเบิกอะไร เท่าไหร่ เมื่อไหร่ พร้อมมูลค่า — ใช้เมื่อถามถึงการเบิกของ/อุปกรณ์',
    parameters: {
      type: 'OBJECT',
      properties: {
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        month: { type: 'STRING', description: 'เดือน YYYY-MM' },
        search: { type: 'STRING', description: 'ชื่อสินค้า' },
        group_by: { type: 'STRING', description: '"branch" หรือ "item" = สรุปรวมแทนรายแถว' },
        limit: { type: 'NUMBER', description: 'จำนวนแถวสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
    },
  },
  {
    name: 'get_material_usage',
    description: 'ยอดใช้วัตถุดิบตามที่บันทึกในชีท UsageHistory (ข้อมูลเก่า หยุดอัปเดตแล้ว) — ใช้เฉพาะเมื่อผู้ใช้ถามถึงชีทนี้ตรง ๆ ถ้าอยากได้ยอดใช้ปัจจุบันให้คำนวณจากยอดขาย × สูตร BOM แทน',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'YYYY-MM-DD' },
        branch: { type: 'STRING', description: 'รหัสสาขา' },
        item: { type: 'STRING', description: 'รหัสวัตถุดิบ' },
        limit: { type: 'NUMBER', description: 'จำนวนแถวสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
    },
  },
  {
    name: 'get_attendance',
    description: 'เวลาเข้า-ออกงานจากเครื่องสแกนนิ้ว (ZKBio Time): เวลาสแกนแรก/สุดท้ายของแต่ละคนต่อวัน จำนวนครั้งที่สแกน — ใช้เมื่อถาม "ใครมากี่โมง" "ใครมาสาย" "วันนี้ใครสแกนเข้างานบ้าง"',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (สูงสุด 92 วัน)' },
        employee: { type: 'STRING', description: 'รหัสพนักงานหรือบางส่วนของชื่อ (ไม่ระบุ = ทุกคน)' },
        limit: { type: 'NUMBER', description: 'จำนวนแถวสูงสุด (default 100) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_zk_employees',
    description: 'รายชื่อพนักงานที่ลงทะเบียนในเครื่องสแกนนิ้ว ZKBio Time (รหัส ชื่อ แผนก วันเริ่มงาน) — ใช้หารหัส/ชื่อก่อนเจาะ get_attendance รายคน',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: { type: 'STRING', description: 'รหัส ชื่อ หรือแผนก' },
        limit: { type: 'NUMBER', description: 'จำนวนสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด' },
      },
    },
  },
  {
    name: 'list_sheets',
    description: 'สารบัญ Google Sheet ทั้งหมดที่เข้าถึงได้ (ชื่อชีท แท็บ และคำอธิบายว่าแต่ละแท็บเก็บอะไร) — เรียกก่อนใช้ read_sheet เมื่อไม่มีเครื่องมือเฉพาะรองรับคำถาม',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'read_sheet',
    description: 'อ่านแท็บใดก็ได้ในชีทที่อนุญาตแบบดิบ (คืนแถวเป็น key-value ตามหัวคอลัมน์) — ใช้เป็นทางเลือกสุดท้ายเมื่อเครื่องมือเฉพาะไม่ครอบคลุมข้อมูลที่ถาม ต้องเรียก list_sheets ก่อนเพื่อดูชื่อ sheet/tab ที่ถูกต้อง',
    parameters: {
      type: 'OBJECT',
      properties: {
        sheet: { type: 'STRING', description: 'คีย์ชีทจาก list_sheets เช่น qcrd, stock, requisition, extraOrders, recipe' },
        tab: { type: 'STRING', description: 'ชื่อแท็บจาก list_sheets เช่น menu, BOM, item, plan, PaymentSummary' },
        search: { type: 'STRING', description: 'กรองเฉพาะแถวที่มีคำนี้อยู่ในช่องใดช่องหนึ่ง' },
        limit: { type: 'NUMBER', description: 'จำนวนแถวสูงสุด (default 50) — ใส่ 0 = เอาทั้งหมด (เพดาน 5000 แถว)' },
      },
      required: ['sheet', 'tab'],
    },
  },
];

// ถามข้ามหลายเดือน = ยิง host API หลายก้อน — ต้องขอเวลาทำงานยาวกว่าค่า default ของ Vercel (10 วิ)
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!GEMINI_KEY) {
    return res.status(503).json({
      error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY — ขอ key ฟรีที่ aistudio.google.com/apikey แล้วใส่ใน Environment Variables ของ Vercel',
    });
  }

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'ต้องส่ง messages' });
    }

    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // เวลาไทย
    const systemText =
      `คุณคือ "AI NARAI" ผู้ช่วยวิเคราะห์ข้อมูลร้านอาหาร Narai Pizzeria ตอบเป็นภาษาไทย กระชับ ชัดเจน ` +
      `วันนี้คือ ${today} (ปี ค.ศ.) ข้อมูลทั้งหมดต้องมาจากเครื่องมือที่ให้ไว้เท่านั้น ห้ามเดาตัวเลขเอง ` +
      `ถ้าผู้ใช้ไม่ระบุช่วงวันที่ ให้ตีความอย่างสมเหตุผล (เช่น "เดือนนี้" = วันที่ 1 ของเดือนถึงวันนี้) และบอกช่วงที่ใช้ในคำตอบ ` +
      `สาขาที่มี: ${Object.values(OUTLETS).join(', ')} ` +
      `เมื่อแสดงตัวเลขเงินให้ใส่ comma และหน่วยบาท ถ้าเหมาะสมให้จัดเป็นตาราง markdown\n\n` +
      `แหล่งข้อมูล: (1) ยอดขายจริงจากฐานข้อมูล POS (2) Google Sheet ของทีม — ต้นทุนเมนู/สูตร BOM/วัตถุดิบ, ` +
      `สต๊อกคงเหลือ, แพลนสั่งของ, ใบเบิกสาขา, ค่าใช้จ่าย, พนักงาน ` +
      `(3) เครื่องสแกนนิ้ว ZKBio Time — เวลาสแกนเข้า-ออกงาน (get_attendance, get_zk_employees) ` +
      `ถ้าเครื่องมือสแกนนิ้วตอบ error แปลว่าฝั่งเซิร์ฟเวอร์ร้านยังไม่ได้ตั้งค่าเชื่อม ZKBio ให้บอกผู้ใช้ตามข้อความ error ` +
      `ถ้าคำถามเกี่ยวกับข้อมูลในชีทที่ไม่มีเครื่องมือเฉพาะ ให้เรียก list_sheets ดูสารบัญก่อน แล้วใช้ read_sheet อ่านแท็บที่ต้องการ ` +
      `ช่วงวันที่: เครื่องมือยอดขาย/ต้นทุน/ลูกค้า ถามยาวได้ถึง 366 วันในครั้งเดียว (เช่น ทั้งปี หรือ ม.ค.–มิ.ย.) ` +
      `ห้ามตอบว่า "ดึงได้ทีละเดือน" หรือให้ผู้ใช้แบ่งช่วงเอง — ถามยาวไปเลยแล้วเลือก group_by ให้เหมาะ ` +
      `(หลายเดือน → group_by "month" หรือ "month_branch", ในเดือนเดียว → "day_branch") ` +
      `ยกเว้น get_bills (บิลรายใบ) สูงสุด 31 วัน และ get_attendance สูงสุด 92 วัน ` +
      `ถ้าผู้ใช้ถามถึงหลายเดือน ให้ดึงทั้งช่วงในครั้งเดียวแล้วสรุปเทียบให้เลย ไม่ต้องถามกลับ ` +
      `ปกติให้ใส่ตัวกรอง (search/branch/ช่วงวันที่) หรือ group_by ก่อน จะได้คำตอบเร็วและตรงกว่า ` +
      `แต่ถ้าผู้ใช้ขอ "ทั้งหมด/ทุกรายการ/ครบทุกตัว" หรือคำถามต้องใช้ข้อมูลทั้งชุดจริง ๆ ` +
      `(เช่น หาผิดปกติทั้งชีท, รวมยอดทุกแถว) ให้ส่ง limit=0 เพื่อดึงทั้งหมด อย่าตอบว่าดึงไม่ได้ ` +
      `ถ้าผลลัพธ์ยังมีฟิลด์ truncated แปลว่าชนเพดาน 5000 แถว ให้บอกผู้ใช้ตามตรงแล้วแนะนำให้แบ่งช่วงถาม\n\n` +
      `การแสดงกราฟ: ถ้าคำตอบเหมาะกับกราฟ (เปรียบเทียบ/จัดอันดับ/แนวโน้มตามเวลา/สัดส่วน) ` +
      `หรือผู้ใช้ขอ "กราฟ/ชาร์ต/รูป/ภาพ" ให้แทรกบล็อกนี้ (JSON ล้วน ห้ามมีคอมเมนต์):\n` +
      '```chart\n{"type":"bar","title":"ชื่อกราฟ","xKey":"label","series":[{"key":"value","name":"ยอดขาย (บาท)"}],"data":[{"label":"XSB","value":1166937}]}\n```\n' +
      `กติกากราฟ: type = "bar" (อันดับ/เปรียบเทียบ), "line" (แนวโน้มรายวัน — xKey เป็นวันที่), "pie" (สัดส่วน ≤8 ชิ้น) · ` +
      `ตัวเลขใน data ต้องมาจากเครื่องมือเท่านั้น เป็น number ล้วน (ห้าม comma) สูงสุด 31 จุด · ` +
      `เทียบหลายค่าได้ด้วยหลาย series เช่น [{"key":"xum","name":"XUM"},{"key":"sjp","name":"SJP"}] แล้ว data แต่ละจุดมี key ครบ · ` +
      `เขียนสรุปข้อความสั้น ๆ ประกอบกราฟด้วยเสมอ`;

    // แปลงบทสนทนาจากหน้าเว็บเป็น contents ของ Gemini
    // กันสาเหตุยอดฮิตของ 400 "Request contains an invalid argument.":
    //   1) part ที่ข้อความว่าง (Gemini ไม่รับ text: "")
    //   2) ประวัติที่ถูกตัดหัวจนเริ่มด้วยฝั่ง model — ต้องเริ่มด้วย user เสมอ
    function buildContents() {
      const c = messages
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'model',
          text: String(m.text ?? '').trim(),
        }))
        .filter(m => m.text);
      while (c.length && c[0].role !== 'user') c.shift();
      if (!c.length) throw new Error('ไม่มีข้อความให้ AI อ่าน — พิมพ์คำถามใหม่อีกครั้งครับ');
      return c.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
    }

    // รันบทสนทนากับโมเดลหนึ่งตัว — คืน { text, toolCalls } หรือ throw
    // (e.rateLimited = โควตาเต็ม, e.badRequest = โมเดลไม่รับคำขอ/พารามิเตอร์)
    // noThinkingConfig = true → ไม่ส่ง thinkingConfig (โมเดลบางรุ่นปิดโหมดคิดไม่ได้ จะตอบ 400)
    async function runChat(model, noThinkingConfig = false) {
      const contents = buildContents();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const toolCalls = [];

      // วนจนกว่า Gemini จะตอบข้อความ (จำกัด 10 รอบเครื่องมือ — คำถามข้ามหลายเดือน/หลายแหล่งต้องใช้หลายรอบ)
      for (let round = 0; round < 10; round++) {
        const body = {
          systemInstruction: { parts: [{ text: systemText }] },
          contents,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          // thinkingBudget 0 = ปิดโหมด "คิดก่อนตอบ" (เร็วขึ้น + กัน thought ภาษาอังกฤษหลุดมาในคำตอบ
          // และกันความคิดกินโควตา token จนคำตอบจริงถูกตัด)
          // แต่บางรุ่น (เช่นสายที่บังคับให้คิด) ไม่รับค่านี้ แล้วตอบ 400 invalid argument
          // → ชั้นบนจะสั่งให้ลองซ้ำแบบไม่ส่ง thinkingConfig
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192,
            ...(noThinkingConfig ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
          },
        };
        const gr = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const gj = await gr.json();
        if (!gr.ok) {
          const err = new Error(gj?.error?.message || `Gemini HTTP ${gr.status}`);
          err.status = gr.status;
          err.rateLimited = gr.status === 429;
          // 400 = คำขอไม่ผ่าน (พารามิเตอร์/ประวัติสนทนา), 404 = ไม่มีโมเดลนี้ → ลองรุ่นถัดไปได้
          err.badRequest = gr.status === 400 || gr.status === 404;
          console.error(`Gemini ${model} HTTP ${gr.status}: ${err.message}`);
          throw err;
        }

        const parts = gj?.candidates?.[0]?.content?.parts || [];
        const fnCalls = parts.filter(p => p.functionCall);

        if (fnCalls.length === 0) {
          // ตัดส่วน "ความคิด" (thought) ของโมเดลออก เอาเฉพาะคำตอบจริง
          const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim() || '(ไม่มีคำตอบ)';
          return { text, toolCalls };
        }

        // มีการเรียกเครื่องมือ → รันแล้วส่งผลกลับ
        // ต้องส่ง parts กลับตามที่โมเดลส่งมาทั้งก้อน (รวม thoughtSignature) ไม่งั้นโมเดลรุ่นใหม่จะ error
        contents.push({ role: 'model', parts });
        const responses = [];
        for (const p of fnCalls) {
          const { name, args } = p.functionCall;
          toolCalls.push({ name, args });
          let result;
          try {
            const fn = TOOL_HANDLERS[name];
            result = fn ? await fn(args || {}) : { error: `ไม่รู้จักเครื่องมือ ${name}` };
          } catch (e) {
            result = { error: e.message };
          }
          // แนบ id กลับถ้าโมเดลส่งมา (Gemini 3.x ผูกคำตอบเครื่องมือกับ id ของ functionCall)
          const fr = { name, response: { result } };
          if (p.functionCall.id) fr.id = p.functionCall.id;
          responses.push({ functionResponse: fr });
        }
        contents.push({ role: 'user', parts: responses });
      }
      return { text: 'ขออภัย คำถามนี้ต้องดึงข้อมูลหลายรอบเกินกำหนด (10 รอบ) ลองแบ่งถามเป็นส่วนย่อยครับ', toolCalls };
    }

    // ลองตามลำดับโมเดล — โควตาเต็ม (429) หรือโมเดลไม่รับคำขอ (400/404) ค่อยขยับไปตัวถัดไป
    // 400 ครั้งแรกของแต่ละโมเดล ลองซ้ำแบบไม่ส่ง thinkingConfig ก่อน (บางรุ่นปิดโหมดคิดไม่ได้)
    let lastErr = null;
    for (const model of MODEL_CHAIN) {
      for (const noThinkingConfig of [false, true]) {
        try {
          const out = await runChat(model, noThinkingConfig);
          return res.status(200).json({ ...out, model });
        } catch (e) {
          lastErr = e;
          if (e.badRequest && !noThinkingConfig) continue;   // ลองรุ่นเดิมอีกครั้งแบบไม่ปิดโหมดคิด
          if (e.rateLimited || e.badRequest) break;          // ไปโมเดลถัดไป
          throw e;
        }
      }
    }
    return res.status(502).json({ error: friendlyError(lastErr) });
  } catch (err) {
    console.error('AI chat error:', err.message);
    return res.status(502).json({ error: friendlyError(err) });
  }
}

// แปลง error ดิบจาก Gemini เป็นข้อความที่ผู้ใช้อ่านแล้วรู้ว่าต้องทำอะไรต่อ
// (เดิมโชว์ดิบ ๆ อย่าง "Request contains an invalid argument." ซึ่งไม่บอกอะไรเลย)
function friendlyError(err) {
  const msg = String(err?.message || 'เกิดข้อผิดพลาดที่ไม่รู้จัก');
  if (err?.rateLimited || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) {
    return 'โควตา AI เต็มชั่วคราวทุกโมเดล — รอสัก 1 นาทีแล้วถามใหม่ครับ';
  }
  if (/invalid argument|INVALID_ARGUMENT|400/i.test(msg)) {
    return 'AI ไม่รับคำขอนี้ (invalid argument) — มักเกิดตอนบทสนทนายาวมากหรือคำตอบก่อนหน้ามีตารางใหญ่ ' +
      `ลองกด "ล้างบทสนทนา" แล้วถามใหม่เป็นคำถามเดียวจบครับ (รายละเอียด: ${msg})`;
  }
  if (/not found|NOT_FOUND|404/i.test(msg)) {
    return `ไม่พบโมเดล AI ที่ตั้งไว้ — ตรวจค่า GEMINI_MODEL ใน Environment Variables ครับ (รายละเอียด: ${msg})`;
  }
  return msg;
}
