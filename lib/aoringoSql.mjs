// ตรรกะดึงข้อมูลร้านเฟรนไชส์จากฐาน "Aoringo" (SQL Server เครื่องเดียวกับ InventoryNarai — 203.154.185.48)
//
// ไฟล์นี้ไม่รู้จักวิธีต่อฐานข้อมูล รับ "ตัวยิงคำสั่ง" เข้ามาแทน เพื่อให้ใช้ได้ทั้งสองทางที่หน้าเว็บมี
// เหมือนกติกาของ lib/qcrdSql.mjs — ต่อ SQL ตรงจาก Vercel (lib/aoringoPool.js) และผ่าน host API
// (host-server/aoringo-db.js) โดยตรรกะการอ่าน/จับคู่คอลัมน์เป็นชุดเดียวกันเป๊ะ
//
//   db.q(text, params)  ยิง 1 คำสั่ง คืน recordset (array)
//
// ── ทำไมต้องจับคู่คอลัมน์ตอนรัน ────────────────────────────────────────────
// ฐาน Aoringo เป็นของร้านเฟรนไชส์ ไม่ใช่ NaraiPos จึงไม่มีใครรับประกันว่าชื่อตาราง/คอลัมน์
// จะตรงกับ dbo.Cpaid / dbo.Ctrans ที่ host-server ใช้อยู่ ถ้าเขียนชื่อตายตัวแล้วชื่อไม่ตรง
// หน้าเว็บจะขึ้น "Invalid object name" เฉย ๆ โดยไม่มีใครรู้ว่าต้องไปแก้ตรงไหน
//
// จึงอ่าน INFORMATION_SCHEMA ตอนรันแล้วให้คะแนนหาตารางที่ "หน้าตาเหมือน" บิล/รายการสินค้า/รายจ่าย
// (ชื่อตารางเป็นตัวช่วย ไม่ใช่ตัวตัดสิน — ตัวตัดสินคือมีคอลัมน์ครบตามบทบาทไหม)
// แล้วเลือกคอลัมน์ตามรายการชื่อที่เป็นไปได้ ช่องไหนไม่มีในตารางก็ปล่อยว่าง ไม่ล้มทั้งหน้า
//
// ตั้งทับได้ทุกจุดด้วย env เมื่อเดาผิด (ชื่อจริงรู้แล้วให้ตั้งทับ จะได้ไม่ต้องเดาอีก):
//   AORINGO_BILL_TABLE / AORINGO_ITEM_TABLE / AORINGO_EXPENSE_TABLE       เช่น 'dbo.Cpaid'
//   AORINGO_BILL_DATE_COL / AORINGO_ITEM_DATE_COL / AORINGO_EXPENSE_DATE_COL
// ดูว่าตอนนี้จับคู่ได้อะไรบ้าง: /api/franchise?view=schema

/* ── helpers ────────────────────────────────────────────────────────── */
export const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
export const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const pad = (n) => String(n).padStart(2, '0');

// datetime → 'YYYY-MM-DD HH:mm:ss' ด้วยค่า UTC (ตรงกับค่าที่เก็บใน DB — mssql อ่านมาแบบ useUTC)
// ต้องฟอร์แมตในนี้ ไม่ใช่ปล่อยให้ JSON.stringify ทำ เพราะสองทาง (ต่อตรง/host API) จะได้คนละรูปแบบ
export const fmtDateTime = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

const fmtVal = (v) => (v instanceof Date ? fmtDateTime(v) : v);

/** 'YYYY-MM-DD HH:mm:ss' → 'YYYY-MM-DD' (ใช้จัดกลุ่มรายวัน) */
export const dayOf = (v) => str(v).slice(0, 10);

/** ชื่อตาราง/คอลัมน์ที่ได้มาจาก INFORMATION_SCHEMA เท่านั้น — กันไว้อีกชั้นก่อนต่อเป็นคำสั่ง */
const ident = (s) => String(s).replace(/[^A-Za-z0-9_ #$@]/g, '');
const bracket = (s) => `[${ident(s)}]`;

/* ── รายชื่อคอลัมน์ที่เป็นไปได้ของแต่ละช่อง ─────────────────────────────
   เรียงจาก "ชื่อที่ NaraiPos ใช้" ก่อน แล้วค่อยชื่อทั่วไปที่ POS ยี่ห้ออื่นชอบใช้
   ตัวแรกที่มีอยู่จริงในตารางคือตัวที่ถูกเลือก                                */
const BILL_FIELDS = {
  date:      ['Date', 'PaidDate', 'BillDate', 'PostTime', 'CloseTime', 'DocDate', 'SaleDate', 'TransDate', 'CreatedAt', 'CreateDate'],
  checkId:   ['CheckID', 'BillNo', 'BillID', 'ReceiptNo', 'DocNo', 'InvoiceNo', 'TransNo', 'RefNo'],
  billTotal: ['BillTotal', 'NetTotal', 'NetAmount', 'GrandTotal', 'TotalAmount', 'Total', 'Amount'],
  amount:    ['Amount', 'SubTotal', 'GrossAmount', 'GrossTotal'],
  vat:       ['Vat', 'VatAmount', 'Tax', 'TaxAmount'],
  nonvat:    ['Nonvat', 'NonVat', 'NoVat'],
  discount:  ['Discount', 'DiscountAmount', 'Disc', 'DiscAmount'],
  serviceChg:['ServiceCharge', 'Service', 'SvcCharge', 'ServiceChg'],
  cover:     ['CoverAll', 'Cover', 'Pax', 'Person', 'Persons', 'Guest', 'Customer', 'CustomerQty'],
  paidType:  ['PaidType', 'PayType', 'PaymentType', 'PaidBy', 'Payment', 'PayMethod'],
  cashier:   ['CashierName', 'Cashier', 'UserName', 'StaffName', 'EmpName', 'CreatedBy'],
  tableId:   ['TableID', 'TableNo', 'TableName', 'Table'],
  outletId:  ['OutletID', 'BranchID', 'ShopID', 'StoreID', 'Outlet', 'Branch'],
  startTime: ['StartTime', 'OpenTime', 'InTime'],
  memberTel: ['MemberTel', 'MemberNo', 'MemberID', 'CustomerTel'],
  note:      ['PaidNote', 'Note', 'Remark', 'CheckDesc'],
  voided:    ['Void', 'IsVoid', 'Cancel', 'Canceled', 'Cancelled'],
  // ช่องทางชำระเงิน — NaraiPos เก็บเป็น _Cash/_Credit/... POS อื่นมักเก็บชื่อตรง ๆ
  cash:      ['_Cash', 'Cash', 'CashAmount'],
  credit:    ['_Credit', 'Credit', 'CreditCard', 'CreditAmount'],
  qr:        ['_QR', 'QR', 'QRCode', 'PromptPay', 'Transfer'],
  qrCredit:  ['_QRcredit', 'QRCredit', 'QRCreditCard'],
  alipay:    ['_Alipay', 'Alipay'],
  weChat:    ['_WeChat', 'WeChat', 'Wechat'],
  voucher:   ['_Voucher', 'Voucher'],
  oc:        ['_OC', 'OC', 'OnCredit'],
  delivery:  ['Delivery', 'DeliveryAmount', 'Grab', 'LineMan'],
};

const ITEM_FIELDS = {
  date:      ['PostTime', 'OrderTime', 'Date', 'TransDate', 'SaleDate', 'CreatedAt', 'StartTime'],
  checkId:   ['ChkCheckID', 'CheckID', 'BillNo', 'BillID', 'DocNo', 'ReceiptNo', 'OrderID'],
  orderId:   ['OrderID', 'OrderNo', 'LineID', 'SeqNo', 'Seq'],
  itemCode:  ['ItemCode', 'ProductCode', 'MenuCode', 'SKU', 'ItemID', 'Code'],
  itemName:  ['NameThai', 'ItemName', 'ProductName', 'MenuName', 'NameEng', 'Name', 'Description'],
  groupName: ['GroupName', 'ItemGroup', 'MenuGroup', 'Category', 'CategoryName', 'DeptName', 'Dept'],
  quantity:  ['Quantity', 'Qty', 'QTY', 'Amount1'],
  unitPrice: ['UnitPrice', 'Price', 'SellPrice', 'ItemPrice'],
  grossPrice:['GrossPrice', 'LineTotal', 'TotalPrice', 'NetPrice', 'Total', 'Amount'],
  tax:       ['Tax', 'Vat', 'VatAmount'],
  tableId:   ['TableID', 'TableNo', 'TableName'],
  outletId:  ['OutletID', 'BranchID', 'ShopID', 'StoreID'],
  waiter:    ['WaiterName', 'Waiter', 'StaffName', 'UserName', 'EmpName'],
  voided:    ['Void', 'IsVoid', 'Cancel', 'Canceled'],
  voidTime:  ['VoidTime', 'CancelTime'],
};

const EXPENSE_FIELDS = {
  date:      ['Date', 'ExpenseDate', 'PayDate', 'DocDate', 'PostTime', 'TransDate', 'CreatedAt', 'CreateDate'],
  category:  ['ExpenseType', 'Type', 'Category', 'CategoryName', 'GroupName', 'Head', 'ExpenseGroup'],
  detail:    ['Detail', 'Description', 'ExpenseName', 'Note', 'Remark', 'Name', 'ItemName', 'Item'],
  amount:    ['Amount', 'ExpenseAmount', 'Total', 'TotalAmount', 'NetAmount', 'Value', 'Cost', 'Price'],
  quantity:  ['Quantity', 'Qty', 'QTY'],
  vendor:    ['Vendor', 'Supplier', 'PayTo', 'Shop', 'SupplierName'],
  payType:   ['PaidType', 'PayType', 'PaymentType', 'PayMethod', 'Method'],
  ref:       ['DocNo', 'RefNo', 'Ref', 'InvoiceNo', 'BillNo', 'No'],
  user:      ['UserName', 'CreatedBy', 'Cashier', 'EmpName', 'StaffName'],
  outletId:  ['OutletID', 'BranchID', 'ShopID', 'StoreID'],
  note:      ['Note', 'Remark', 'Comment'],
};

/* ── ตัวช่วยเลือกตาราง ────────────────────────────────────────────────── */
const ROLES = {
  bill:    { fields: BILL_FIELDS,    hint: /cpaid|paid|bill|check|receipt|invoice|sale|pos|trans/i,
             required: ['date', 'billTotal'],
             weighted: { checkId: 3, paidType: 3, cover: 2, cashier: 2, cash: 3, credit: 2, tableId: 1, outletId: 1 } },
  item:    { fields: ITEM_FIELDS,    hint: /ctran|tran|detail|item|line|order|menu|product/i,
             required: ['date', 'itemName'],
             weighted: { itemCode: 3, quantity: 3, unitPrice: 2, grossPrice: 3, checkId: 2, groupName: 1 } },
  expense: { fields: EXPENSE_FIELDS, hint: /expense|expence|payout|cost|spend|disburse|รายจ่าย/i,
             required: ['date', 'amount'],
             weighted: { category: 3, detail: 2, vendor: 2, ref: 1, payType: 1 },
             // "มีวันที่ + มียอดเงิน" อย่างเดียวยังไม่พอ — ตารางบิลขายก็เข้าเงื่อนไขนั้นเหมือนกัน
             // ถ้าปล่อยไว้ ฐานที่ไม่มีตารางรายจ่ายจะเอาบิลขายมาโชว์เป็นรายจ่ายโดยไม่มีใครรู้
             // ต้องมีอย่างน้อยอย่างหนึ่ง: ชื่อตารางบอกว่าเป็นรายจ่าย หรือมีช่องประเภท/รายละเอียดของรายจ่ายจริง
             gate: (map, table) => ROLES.expense.hint.test(table.name) ||
               (Boolean(map.category) && Boolean(map.detail || map.vendor)) },
};

/** คอลัมน์ที่มีอยู่จริง (เทียบชื่อแบบไม่สนตัวพิมพ์) → ชื่อจริงในตาราง */
function pickColumn(columns, candidates) {
  const lower = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]));
  for (const cand of candidates) {
    const hit = lower.get(cand.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** ให้คะแนนว่าตารางนี้ "เป็น" บทบาทนั้นแค่ไหน — คืน null ถ้าขาดคอลัมน์ที่ขาดไม่ได้ */
function scoreTable(table, role) {
  const spec = ROLES[role];
  const map = {};
  for (const [field, candidates] of Object.entries(spec.fields)) {
    map[field] = pickColumn(table.columns, candidates);
  }
  if (spec.required.some((f) => !map[f])) return null;
  if (spec.gate && !spec.gate(map, table)) return null;
  let score = spec.required.length * 4;
  for (const [field, weight] of Object.entries(spec.weighted)) if (map[field]) score += weight;
  if (spec.hint.test(table.name)) score += 5;
  // ตารางที่ชื่อบอกว่าเป็นของเก่า/สำรอง/ชั่วคราว ให้หลบตารางตัวจริงเสมอ
  if (/(_|\b)(bak|backup|old|tmp|temp|log|history|archive)(_|\b|\d)/i.test(table.name)) score -= 12;
  return { score, columns: map };
}

/** 'dbo.Cpaid' / 'Cpaid' ที่ตั้งมาทาง env → หาตารางตัวนั้นในรายการที่อ่านมา */
function findByName(tables, wanted) {
  const want = str(wanted).replace(/[[\]]/g, '').toLowerCase();
  if (!want) return null;
  return tables.find((t) => t.full.toLowerCase() === want || t.name.toLowerCase() === want) || null;
}

/**
 * ผูกตรรกะฝั่งเฟรนไชส์เข้ากับตัวยิงคำสั่งชุดหนึ่ง
 * คืน: readLayout / readBills / readItems / readExpenses
 */
export function createAoringo(db) {
  const { q } = db;

  /** อ่านโครงฐานทั้งหมดครั้งเดียวแล้วจำไว้ — ทุก request ถัดไปไม่ต้องถาม INFORMATION_SCHEMA ซ้ำ */
  let layoutCache = null;
  let layoutAt = 0;
  const LAYOUT_TTL_MS = 10 * 60 * 1000;

  async function readTables() {
    const rows = await q(`
      SELECT c.TABLE_SCHEMA AS s, c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS d
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES tb
          ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
       WHERE tb.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
    const byTable = new Map();
    for (const r of rows) {
      const full = `${r.s}.${r.t}`;
      if (!byTable.has(full)) byTable.set(full, { schema: r.s, name: r.t, full, columns: [] });
      byTable.get(full).columns.push({ name: r.c, type: r.d });
    }
    return [...byTable.values()];
  }

  /** ตารางที่จะใช้ของแต่ละบทบาท + คอลัมน์ที่จับคู่ได้ (ตั้งทับด้วย env ได้) */
  async function readLayout({ force = false } = {}) {
    if (!force && layoutCache && Date.now() - layoutAt < LAYOUT_TTL_MS) return layoutCache;
    const tables = await readTables();
    const overrides = {
      bill:    { table: process.env.AORINGO_BILL_TABLE,    date: process.env.AORINGO_BILL_DATE_COL },
      item:    { table: process.env.AORINGO_ITEM_TABLE,    date: process.env.AORINGO_ITEM_DATE_COL },
      expense: { table: process.env.AORINGO_EXPENSE_TABLE, date: process.env.AORINGO_EXPENSE_DATE_COL },
    };

    const out = { tableCount: tables.length, roles: {} };
    // เลือกบิลก่อน แล้วรายการสินค้า แล้วรายจ่าย — ตารางที่ถูกใช้ไปแล้วห้ามถูกเลือกซ้ำอีกบทบาท
    // (ตารางบิลมีทั้งวันที่และยอดเงิน จึงเข้าเกณฑ์ของบทบาทอื่นได้ถ้าไม่กันไว้)
    const claimed = new Set();
    for (const role of Object.keys(ROLES)) {
      const forced = findByName(tables, overrides[role].table);
      let chosen = null;
      const ranked = [];
      for (const t of tables) {
        if (claimed.has(t.full)) continue;
        const s = scoreTable(t, role);
        if (s) ranked.push({ table: t, ...s });
      }
      ranked.sort((a, b) => b.score - a.score);
      if (forced) {
        // ตั้ง env มาแล้วต้องใช้ตัวนั้น ถึงแม้คะแนนจะแพ้ตัวอื่น (คนตั้งย่อมรู้ดีกว่าตัวให้คะแนน)
        const s = scoreTable(forced, role);
        chosen = { table: forced, score: s ? s.score : 0, columns: s ? s.columns : {}, forced: true };
        if (!s) {
          const map = {};
          for (const [f, cands] of Object.entries(ROLES[role].fields)) map[f] = pickColumn(forced.columns, cands);
          chosen.columns = map;
        }
      } else {
        chosen = ranked[0] || null;
      }
      if (chosen && overrides[role].date) {
        const dc = pickColumn(chosen.table.columns, [overrides[role].date]);
        if (dc) chosen.columns = { ...chosen.columns, date: dc };
      }
      if (chosen) claimed.add(chosen.table.full);
      out.roles[role] = chosen
        ? {
            table: chosen.table.full,
            score: chosen.score,
            forced: Boolean(chosen.forced),
            columns: chosen.columns,
            matched: Object.entries(chosen.columns).filter(([, v]) => v).map(([k, v]) => `${k} ← ${v}`),
            missing: Object.entries(chosen.columns).filter(([, v]) => !v).map(([k]) => k),
            others: ranked.filter((r) => r.table.full !== chosen.table.full).slice(0, 4)
              .map((r) => `${r.table.full} (${r.score})`),
          }
        : null;
    }
    out.tables = tables.map((t) => ({ name: t.full, columns: t.columns.length }));
    layoutCache = out;
    layoutAt = Date.now();
    return out;
  }

  /** ลืมสิ่งที่จำไว้ — ใช้ตอนตั้ง env ใหม่แล้วอยากให้จับคู่ใหม่ทันที */
  function forgetLayout() { layoutCache = null; layoutAt = 0; }

  const roleOrThrow = (layout, role, what) => {
    const r = layout.roles[role];
    if (!r) {
      const need = role === 'expense'
        ? 'ต้องมีคอลัมน์วันที่ + คอลัมน์จำนวนเงิน และต้องดูออกว่าเป็นรายจ่าย (ชื่อตารางบอก ' +
          'หรือมีคอลัมน์ประเภท/รายละเอียดของรายจ่าย) ไม่งั้นจะไปหยิบตารางบิลขายมาแสดงผิด ๆ'
        : 'ต้องมีทั้งคอลัมน์วันที่และคอลัมน์ยอด';
      throw new Error(
        `หาตาราง${what}ในฐาน Aoringo ไม่เจอ — ไม่มีตารางไหนมีคอลัมน์ครบพอจะเป็น${what}ได้ ` +
        `(${need}) ดูรายชื่อตารางทั้งหมดที่ /api/franchise?view=schema ` +
        `แล้วตั้ง env AORINGO_${role.toUpperCase()}_TABLE เป็นชื่อตารางที่ถูกต้อง`
      );
    }
    return r;
  };

  /** ต่อ SELECT จากคอลัมน์ที่จับคู่ได้ — ช่องที่ตารางไม่มีจะเป็น NULL ให้ฝั่งหน้าเว็บอ่านง่ายเหมือนกันหมด */
  const selectList = (columns) =>
    Object.entries(columns)
      .map(([field, col]) => (col ? `${bracket(col)} AS ${bracket(field)}` : `NULL AS ${bracket(field)}`))
      .join(',\n             ');

  const mapRow = (row) => {
    const out = {};
    for (const k in row) out[k] = fmtVal(row[k]);
    return out;
  };

  const rangeParams = (start, end) => ({ start: `${start} 00:00:00`, end: `${end} 23:59:59` });

  function assertRange(start, end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(str(end))) {
      throw new Error('ต้องส่ง start และ end เป็นวันที่รูปแบบ YYYY-MM-DD');
    }
  }

  /** เพดานแถวกันดึงทั้งฐานมาทีเดียว (ช่วงวันที่กว้างเกินไป) — ตัวเลขล้วน ต่อเข้าคำสั่งได้ */
  const topOf = (limit, fallback) => Math.max(1, Math.min(200000, parseInt(limit, 10) || fallback));

  async function runRange(role, what, { start, end, outlet, limit } = {}, fallbackTop) {
    assertRange(start, end);
    const layout = await readLayout();
    const r = roleOrThrow(layout, role, what);
    const cols = r.columns;
    let where = `WHERE ${bracket(cols.date)} >= @start AND ${bracket(cols.date)} <= @end`;
    const params = rangeParams(start, end);
    if (cols.outletId && str(outlet) !== '') {
      where += ` AND ${bracket(cols.outletId)} = @outlet`;
      params.outlet = str(outlet);
    }
    const rows = await q(
      `SELECT TOP ${topOf(limit, fallbackTop)}
              ${selectList(cols)}
         FROM ${r.table}
         ${where}
        ORDER BY ${bracket(cols.date)}`,
      params
    );
    return { rows: rows.map(mapRow), table: r.table, dateColumn: cols.date, missing: r.missing };
  }

  /** บิล/การชำระเงิน (ตารางแบบ Cpaid) */
  const readBills = (opt) => runRange('bill', 'บิลขาย', opt, 100000);

  /** รายการสินค้าในบิล (ตารางแบบ Ctrans) */
  const readItems = (opt) => runRange('item', 'รายการสินค้า', opt, 150000);

  /** รายจ่าย */
  const readExpenses = (opt) => runRange('expense', 'รายจ่าย', opt, 50000);

  /** เช็กว่าต่อฐานได้ไหม + จับคู่ตารางได้ครบไหม */
  async function ping() {
    const one = await q('SELECT DB_NAME() AS db, GETDATE() AS now');
    const layout = await readLayout();
    return {
      ok: true,
      database: str(one[0]?.db),
      serverTime: fmtVal(one[0]?.now),
      tableCount: layout.tableCount,
      roles: Object.fromEntries(
        Object.entries(layout.roles).map(([k, v]) => [k, v ? { table: v.table, dateColumn: v.columns.date } : null])
      ),
    };
  }

  return { readLayout, forgetLayout, readBills, readItems, readExpenses, ping };
}
