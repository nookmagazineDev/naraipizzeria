// AI NARAI — แชท AI (Gemini) ที่ดึงข้อมูลจริงจาก SQL Server ผ่าน host API
// สถาปัตยกรรม: หน้าเว็บ → /api/ai-chat → Gemini (function calling) ⇄ เครื่องมือ read-only
// เครื่องมือทุกตัวเรียก host API (Cloudflare tunnel → server.js → SQL Server) แล้ว aggregate
// ฝั่งนี้ก่อนส่งให้ AI (กัน token บวม + AI ไม่มีสิทธิ์ยิง SQL ตรง)
//
// ต้องตั้ง env: GEMINI_API_KEY (ขอฟรีที่ https://aistudio.google.com/apikey)
// เลือกโมเดลผ่าน env GEMINI_MODEL (default: gemini-2.0-flash)

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';
// ชีทต้นทุนเมนู (ตัวเดียวกับ /api/cost) + GAS ค่าใช้จ่าย/พนักงาน (ตัวเดียวกับ proxy)
const COST_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw/export?format=csv&gid=0';
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

function assertRange(start, end, maxDays = 62) {
  const d1 = new Date(start), d2 = new Date(end);
  if (isNaN(d1) || isNaN(d2)) throw new Error('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  const days = (d2 - d1) / 86400000 + 1;
  if (days < 1) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (days > maxDays) throw new Error(`ช่วงวันที่ยาวเกินไป (สูงสุด ${maxDays} วัน) — แบ่งช่วงถามทีละเดือน`);
}

function outletParam(branch) {
  if (!branch) return '';
  const oid = BRANCH_TO_OUTLET[String(branch).toUpperCase().trim()];
  if (!oid) throw new Error(`ไม่รู้จักสาขา "${branch}" — สาขาที่มี: ${Object.values(OUTLETS).join(', ')}`);
  return `&outlet=${oid}`;
}

async function fetchSales(start, end, branch) {
  const r = await fetch(`${STORE_API}/cpaidbetweendate?start=${start}&end=${end}${outletParam(branch)}`);
  if (!r.ok) throw new Error(`host API HTTP ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : j.data || [])
    .filter(b => !EXCLUDE_TABLES.includes(parseInt(b.tableID)));
}

async function fetchDetails(start, end, branch) {
  const r = await fetch(`${STORE_API}/ctranbetweendate?start=${start}&end=${end}${outletParam(branch)}`);
  if (!r.ok) throw new Error(`host API HTTP ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : j.data || []);
}

// ── เครื่องมือที่เปิดให้ AI เรียก (read-only ทั้งหมด) ──
const TOOL_HANDLERS = {
  // ยอดขายสรุปรายวัน/รายสาขา
  async get_daily_sales({ start_date, end_date, branch }) {
    assertRange(start_date, end_date);
    const rows = await fetchSales(start_date, end_date, branch);
    const g = {};
    rows.forEach(b => {
      let bt = num(b.billTotal) - num(b.voucher1);
      if (bt < 0) bt = 0;
      const date = String(b.startTime || b.date || '').slice(0, 10);
      const name = OUTLETS[b.outletID] || String(b.outletID);
      const k = `${date}|${name}`;
      if (!g[k]) g[k] = { date, branch: name, bills: 0, gross: 0, vat: 0 };
      g[k].bills++;
      g[k].gross += bt;
      g[k].vat += bt > 0 ? num(b.vat) : 0;
    });
    const out = Object.values(g).map(x => ({ ...x, gross: r2(x.gross), vat: r2(x.vat), net: r2(x.gross - x.vat) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.branch.localeCompare(b.branch));
    return { rows: out, note: 'gross รวม VAT แล้ว, net = ก่อน VAT, ตัดโต๊ะ 600 และหักวอเชอร์แล้ว' };
  },

  // รายการขายดี (Top N) ตามยอดเงินหรือจำนวน
  async get_top_items({ start_date, end_date, branch, limit = 20, by = 'amount' }) {
    assertRange(start_date, end_date, 31);
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
    const top = sorted.slice(0, Math.min(limit, 50)).map(x => ({ ...x, qty: r2(x.qty), amount: r2(x.amount) }));
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
    assertRange(start_date, end_date, 7); // รายใบข้อมูลเยอะ จำกัด 7 วันต่อครั้ง
    const rows = await fetchSales(start_date, end_date, branch);
    const bills = rows.map(b => ({
      checkID: b.checkID,
      branch: OUTLETS[b.outletID] || String(b.outletID),
      time: String(b.startTime || b.date || '').slice(0, 16),
      table: b.tableID,
      total: r2(num(b.billTotal) - num(b.voucher1)),
      paidType: b.paidType || '',
    })).sort((a, b) => a.time.localeCompare(b.time));
    const cap = Math.min(limit, 300);
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
    assertRange(start_date, end_date, 31);
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
    hit.forEach(r => {
      const key = group_by === 'branch'
        ? (OUTLETS[r.outletID] || String(r.outletID))
        : String(r.prtOrdTime || r.startTime || '').slice(0, 10);
      if (!g[key]) g[key] = { [group_by === 'branch' ? 'branch' : 'date']: key, qty: 0, amount: 0 };
      g[key].qty += num(r.quantity);
      g[key].amount += num(r.grossPrice);
    });
    const out = Object.values(g).map(x => ({ ...x, qty: r2(x.qty), amount: r2(x.amount) }))
      .sort((a, b) => String(a.date || a.branch).localeCompare(String(b.date || b.branch)));
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
    assertRange(start_date, end_date, 31);
    const [rows, costMap] = await Promise.all([fetchDetails(start_date, end_date, branch), fetchCostMap()]);
    const g = {};
    rows.forEach(r => {
      if (r.void) return;
      const tid = parseInt(r.tableID);
      if (EXCLUDE_TABLES.includes(tid)) return;
      if (isExcludedItem(r.itemCode)) return;
      const key = group_by === 'day'
        ? String(r.prtOrdTime || r.startTime || '').slice(0, 10)
        : (OUTLETS[r.outletID] || String(r.outletID));
      if (!g[key]) g[key] = { [group_by === 'day' ? 'date' : 'branch']: key, netSales: 0, cost: 0, prepCost: 0 };
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
    })).sort((a, b) => String(a.date || a.branch).localeCompare(String(b.date || b.branch)));
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
    assertRange(start_date, end_date, 31);
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
    assertRange(start_date, end_date, 31);
    const BUFFET = ['101001', '101002', '101003', '101004', '101107'];
    const COVERALL_OUTLETS = [501, 503];
    const [dets, sales] = await Promise.all([
      fetchDetails(start_date, end_date, branch),
      fetchSales(start_date, end_date, branch),
    ]);
    const keyOfD = r => group_by === 'day'
      ? String(r.prtOrdTime || r.startTime || '').slice(0, 10)
      : (OUTLETS[r.outletID] || String(r.outletID));
    const g = {};
    dets.forEach(r => {
      if (r.void) return;
      if (!BUFFET.includes(String(r.itemCode))) return;
      if (COVERALL_OUTLETS.includes(parseInt(r.outletID))) return;
      const k = keyOfD(r);
      if (!g[k]) g[k] = { [group_by === 'day' ? 'date' : 'branch']: k, covers: 0, netSales: 0 };
      g[k].covers += num(r.quantity);
    });
    // สาขาที่ใช้ coverAll จากบิล + ยอดขายจากบิล (ก่อน VAT)
    sales.forEach(b => {
      const bt = num(b.billTotal) - num(b.voucher1);
      if (bt < 0) return;
      const k = group_by === 'day'
        ? String(b.startTime || b.date || '').slice(0, 10)
        : (OUTLETS[b.outletID] || String(b.outletID));
      if (!g[k]) g[k] = { [group_by === 'day' ? 'date' : 'branch']: k, covers: 0, netSales: 0 };
      g[k].netSales += bt - num(b.vat);
      if (COVERALL_OUTLETS.includes(parseInt(b.outletID))) g[k].covers += num(b.coverAll);
    });
    const out = Object.values(g).map(x => ({
      ...x, covers: r2(x.covers), netSales: r2(x.netSales),
      spendPerHead: x.covers > 0 ? r2(x.netSales / x.covers) : null,
    })).sort((a, b) => String(a.date || a.branch).localeCompare(String(b.date || b.branch)));
    return { rows: out, note: 'covers = จานบุฟเฟต์ที่จ่ายจริง (ไม่รวมเด็กฟรี) · spendPerHead = ยอดก่อน VAT ÷ หัว' };
  },

  // ยอดขายรายชั่วโมง — ช่วงเวลาไหนขายดี
  async get_hourly_sales({ start_date, end_date, branch }) {
    assertRange(start_date, end_date, 31);
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
    return { rows: out, note: 'อิงเวลาเปิดบิล ยอดรวม VAT' };
  },

  // ค่าใช้จ่ายอื่นๆ (ค่าเช่า/ไฟ/น้ำ/แก๊ส/โทรศัพท์) จากชีทที่ทีมบันทึก
  async get_expenses({ month, branch }) {
    const list = await gasPost(EXPENSE_GAS, { action: 'getExpenses' });
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

  // สรุปจำนวนพนักงาน (นับจำนวน ไม่เปิดเผยข้อมูลส่วนตัว)
  async get_employees_summary({ branch }) {
    const list = await gasPost(HR_GAS, { action: 'getEmployees', branch: 'all' });
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
};

// ── ตัวช่วยดึงข้อมูลภายนอก ──
let costCache = { map: null, at: 0 };
async function fetchCostMap() {
  if (costCache.map && Date.now() - costCache.at < 10 * 60 * 1000) return costCache.map; // cache 10 นาที
  const r = await fetch(COST_SHEET_CSV, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`cost sheet HTTP ${r.status}`);
  const lines = (await r.text()).split('\n');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const code = (cols[0] || '').replace(/"/g, '').trim();
    const cost = parseFloat((cols[4] || '').replace(/"/g, ''));
    if (code && !isNaN(cost) && !(code in map)) map[code] = cost;
  }
  costCache = { map, at: Date.now() };
  return map;
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
    description: 'ดึงยอดขายสรุปรายวันต่อสาขา (จำนวนบิล, ยอดรวม VAT, VAT, ยอดก่อน VAT) จากฐานข้อมูลจริง',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD' },
        branch: { type: 'STRING', description: 'รหัสสาขา เช่น SJP, XUM (ไม่ระบุ = ทุกสาขา)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_top_items',
    description: 'ดึงรายการอาหาร/สินค้าขายดี Top N ในช่วงวันที่ (จำนวนและยอดเงินต่อเมนู) สูงสุด 31 วันต่อครั้ง',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        limit: { type: 'NUMBER', description: 'จำนวนอันดับ (default 20, สูงสุด 50)' },
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
    description: 'รายการบิลแบบแยกรายใบ (เลขบิล เวลา โต๊ะ ยอด ช่องทางจ่าย) สูงสุด 7 วันต่อครั้ง — ใช้เมื่อผู้ใช้อยากไล่ดูบิลทีละใบ',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (ห่างกันไม่เกิน 7 วัน)' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        limit: { type: 'NUMBER', description: 'จำนวนบิลสูงสุดที่แสดง (default 100, สูงสุด 300)' },
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
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD (สูงสุด 31 วัน)' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        group_by: { type: 'STRING', description: '"day" แยกรายวัน (default) หรือ "branch" แยกรายสาขา' },
      },
      required: ['item', 'start_date', 'end_date'],
    },
  },
  {
    name: 'get_cost_profit',
    description: 'วิเคราะห์ต้นทุนและกำไร: ยอดขายก่อน VAT, ต้นทุนวัตถุดิบ (จากชีทต้นทุนเมนู), กำไร, ต้นทุน% แยกรายวันหรือรายสาขา',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 31 วัน' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        group_by: { type: 'STRING', description: '"branch" (default) หรือ "day"' },
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
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 31 วัน' },
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
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 31 วัน' },
        branch: { type: 'STRING' },
        group_by: { type: 'STRING', description: '"branch" (default) หรือ "day"' },
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
        start_date: { type: 'STRING' }, end_date: { type: 'STRING', description: 'สูงสุด 31 วัน' },
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
];

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
      `การแสดงกราฟ: ถ้าคำตอบเหมาะกับกราฟ (เปรียบเทียบ/จัดอันดับ/แนวโน้มตามเวลา/สัดส่วน) ` +
      `หรือผู้ใช้ขอ "กราฟ/ชาร์ต/รูป/ภาพ" ให้แทรกบล็อกนี้ (JSON ล้วน ห้ามมีคอมเมนต์):\n` +
      '```chart\n{"type":"bar","title":"ชื่อกราฟ","xKey":"label","series":[{"key":"value","name":"ยอดขาย (บาท)"}],"data":[{"label":"XSB","value":1166937}]}\n```\n' +
      `กติกากราฟ: type = "bar" (อันดับ/เปรียบเทียบ), "line" (แนวโน้มรายวัน — xKey เป็นวันที่), "pie" (สัดส่วน ≤8 ชิ้น) · ` +
      `ตัวเลขใน data ต้องมาจากเครื่องมือเท่านั้น เป็น number ล้วน (ห้าม comma) สูงสุด 31 จุด · ` +
      `เทียบหลายค่าได้ด้วยหลาย series เช่น [{"key":"xum","name":"XUM"},{"key":"sjp","name":"SJP"}] แล้ว data แต่ละจุดมี key ครบ · ` +
      `เขียนสรุปข้อความสั้น ๆ ประกอบกราฟด้วยเสมอ`;

    // รันบทสนทนากับโมเดลหนึ่งตัว — คืน { text, toolCalls } หรือ throw (e.rateLimited = โควตาเต็ม)
    async function runChat(model) {
      const contents = messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: String(m.text || '') }],
      }));
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const toolCalls = [];

      // วนจนกว่า Gemini จะตอบข้อความ (จำกัด 6 รอบเครื่องมือ)
      for (let round = 0; round < 6; round++) {
        const body = {
          systemInstruction: { parts: [{ text: systemText }] },
          contents,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          // thinkingBudget 0 = ปิดโหมด "คิดก่อนตอบ" (เร็วขึ้น + กัน thought ภาษาอังกฤษหลุดมาในคำตอบ
          // และกันความคิดกินโควตา token จนคำตอบจริงถูกตัด)
          generationConfig: { temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
        };
        const gr = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const gj = await gr.json();
        if (!gr.ok) {
          const err = new Error(gj?.error?.message || `Gemini HTTP ${gr.status}`);
          err.rateLimited = gr.status === 429;
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
      return { text: 'ขออภัย คำถามนี้ซับซ้อนเกินไป (เรียกข้อมูลหลายรอบเกินกำหนด) ลองแบ่งถามเป็นส่วนย่อยครับ', toolCalls };
    }

    // ลองตามลำดับโมเดล — โควตาเต็ม (429) ค่อยขยับไปตัวถัดไป
    let lastErr = null;
    for (const model of MODEL_CHAIN) {
      try {
        const out = await runChat(model);
        return res.status(200).json({ ...out, model });
      } catch (e) {
        if (e.rateLimited) { lastErr = e; continue; }
        throw e;
      }
    }
    return res.status(502).json({ error: 'โควตา AI เต็มชั่วคราวทุกโมเดล — รอสัก 1 นาทีแล้วลองใหม่ครับ' + (lastErr ? '' : '') });
  } catch (err) {
    console.error('AI chat error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
