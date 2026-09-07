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

/* ══════════════════════════════════════════════════════════════════════
   โครง "แอปร้านอาหาร" — SaleOrder / SaleOrderItem / OrderPayment / Expense
   (โครงจริงของฐาน Aoringo ที่ร้านใช้อยู่ ตรวจด้วย sys.tables เมื่อ 2026-09)

   ต่างจาก NaraiPos ตรงที่ข้อมูลกระจายหลายตาราง ตัวจับคู่แบบ "ตารางเดียวจบ"
   ข้างบนจึงใช้ไม่ได้ (เคยเดาไปหยิบ dbo.Expense มาเป็นตารางบิล):
     · SaleOrderItem ไม่มีคอลัมน์วันที่เลย ต้อง join SaleOrder เอา
     · ชื่อ/หมวดของเมนู อยู่ที่ MenuItem → Category
     · ช่องทางชำระเงินอยู่ที่ OrderPayment (หลายบรรทัดต่อบิล) ต้องยุบเป็นบิลละแถวก่อน
     · บิลที่ยกเลิกดูจาก Status (ข้อความ) ไม่ใช่ธง 0/1

   ทุกคอลัมน์ยังเช็กก่อนใช้ว่ามีจริงไหม — แอปเวอร์ชันหน้าเพิ่ม/ตัดคอลัมน์แล้วต้องไม่พังทั้งหน้า
   ══════════════════════════════════════════════════════════════════════ */

/** คำที่บอกว่าบิลนี้ไม่ใช่ยอดขายจริง (Status เป็นข้อความ ไม่ใช่ 0/1) */
const VOID_WORDS = ['void', 'cancel', 'refund', 'ยกเลิก', 'คืนเงิน'];

/** จัดช่องทางจ่ายเข้าถังที่หน้าเว็บรู้จัก — ดูจากชื่อ/รหัสวิธีจ่ายที่บันทึกไว้จริง
    เรียงจากเจาะจงไปกว้าง (qrCredit ต้องมาก่อน qr และ credit ไม่งั้นถูกนับซ้ำ) */
const PAY_BUCKETS = [
  ['qrCredit', ["m LIKE '%qr%' AND m LIKE '%credit%'"]],
  ['cash',     ["m LIKE '%cash%'", "m LIKE N'%เงินสด%'"]],
  ['qr',       ["m LIKE '%qr%'", "m LIKE '%promptpay%'", "m LIKE '%transfer%'", "m LIKE N'%โอน%'", "m LIKE N'%พร้อมเพย์%'"]],
  ['credit',   ["m LIKE '%credit%'", "m LIKE '%card%'", "m LIKE N'%บัตร%'"]],
  ['voucher',  ["m LIKE '%voucher%'", "m LIKE N'%คูปอง%'"]],
  ['delivery', ["m LIKE '%grab%'", "m LIKE '%line%man%'", "m LIKE '%delivery%'", "m LIKE '%shopee%'",
                "m LIKE '%robinhood%'", "m LIKE '%foodpanda%'", "m LIKE '%panda%'"]],
];

/** หาตารางจากชื่อ (ไม่สนตัวพิมพ์ ไม่สน schema) */
const table1 = (tables, name) => tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;

/** ชื่อจริงของคอลัมน์ในตาราง (ตัวพิมพ์ตามที่ฐานเก็บ) — ไม่มีคืน null */
const colOf = (t, name) => (t ? pickColumn(t.columns, [name]) : null);

/** `alias.[Col]` ถ้ามีคอลัมน์นั้น ไม่มีคืน null */
const ref = (t, alias, name) => {
  const c = colOf(t, name);
  return c ? `${alias}.${bracket(c)}` : null;
};

/** เลือกคอลัมน์แรกที่มีจริง แล้วคืนเป็น `expr AS [ชื่อกลาง]` — ไม่มีสักตัวก็ NULL ให้หน้าเว็บอ่านเหมือนกันหมด */
const pickAs = (t, alias, names, out) => {
  for (const n of names) {
    const e = ref(t, alias, n);
    if (e) return `${e} AS ${bracket(out)}`;
  }
  return `NULL AS ${bracket(out)}`;
};

/** ตรวจว่าฐานนี้เป็นโครงแอปร้านอาหาร (มีทั้งบิลและรายการในบิล) */
export function detectAppSchema(tables) {
  const orders = table1(tables, 'SaleOrder');
  const items = table1(tables, 'SaleOrderItem');
  if (!orders || !items) return null;
  if (!colOf(items, 'OrderId') || !colOf(orders, 'OrderId')) return null;
  return {
    orders,
    items,
    payments: table1(tables, 'OrderPayment'),
    menu: table1(tables, 'MenuItem'),
    category: table1(tables, 'Category'),
    expense: table1(tables, 'Expense'),
    users: table1(tables, 'AppUser'),
  };
}

/** วันที่ของบิล — ปิดบิลเมื่อไหร่คือเวลาที่ยอดถูกนับ ยังไม่ปิดค่อยใช้เวลาที่เปิดออร์เดอร์
    (ตั้งทับด้วย AORINGO_BILL_DATE_COL ได้ ถ้าอยากยึดคอลัมน์เดียวตายตัว) */
function orderDateExpr(orders) {
  const forced = process.env.AORINGO_BILL_DATE_COL;
  if (forced) {
    const e = ref(orders, 'o', forced);
    if (e) return { expr: e, label: forced };
  }
  const parts = ['PaidAt', 'OrderDate', 'OpenedAt'].map((n) => ref(orders, 'o', n)).filter(Boolean);
  if (!parts.length) return null;
  return {
    expr: parts.length > 1 ? `COALESCE(${parts.join(', ')})` : parts[0],
    label: parts.length > 1 ? `COALESCE(${['PaidAt', 'OrderDate', 'OpenedAt'].filter((n) => colOf(orders, n)).join(', ')})` : parts[0].slice(2),
  };
}

/** บิลที่ยกเลิก/คืนเงิน → 1 ที่เหลือ → 0 (หน้าเว็บตัดบิลที่เป็น 1 ออกจากยอดขาย) */
function voidExpr(orders) {
  const st = ref(orders, 'o', 'Status');
  if (!st) return '0';
  const conds = VOID_WORDS.map((w) => `LOWER(${st}) LIKE N'%${w}%'`).join(' OR ');
  return `CASE WHEN ${conds} THEN 1 ELSE 0 END`;
}

/** ยอดแยกช่องทางจ่ายต่อบิล — ยุบ OrderPayment (หลายบรรทัดต่อบิล) ให้เหลือบิลละแถว */
function paymentJoin(app) {
  const p = app.payments;
  if (!p || !colOf(p, 'OrderId') || !colOf(p, 'Amount')) return null;
  const method = ['MethodName', 'PaymentMethod', 'Code'].map((n) => ref(p, 'x', n)).filter(Boolean);
  if (!method.length) return null;
  const m = `LOWER(COALESCE(${method.join(', ')}, ''))`;
  const buckets = PAY_BUCKETS.map(([key, conds]) => `WHEN ${conds.join(' OR ')} THEN '${key}'`).join('\n                 ');
  const sums = PAY_BUCKETS
    .map(([key]) => `SUM(CASE WHEN bucket = '${key}' THEN amt ELSE 0 END) AS ${bracket(key)}`)
    .join(',\n               ');
  // ต้องซ้อน 3 ชั้น: ชั้นในสุดคิดชื่อวิธีจ่ายเป็นตัวพิมพ์เล็ก (m) · ชั้นกลางแปลง m เป็นถัง ·
  // ชั้นนอกรวมยอดต่อบิล — T-SQL อ้าง alias ของคอลัมน์ใน SELECT เดียวกันไม่ได้ ต้องแยกชั้นแบบนี้
  return {
    sql: `LEFT JOIN (
        SELECT OrderId, ${sums},
               MAX(methodName) AS ${bracket('methodName')}
          FROM (SELECT OrderId, amt, methodName,
                       CASE ${buckets}
                            ELSE 'other' END AS bucket
                  FROM (SELECT ${ref(p, 'x', 'OrderId')} AS OrderId,
                               ${ref(p, 'x', 'Amount')} AS amt,
                               COALESCE(${method.join(', ')}) AS methodName,
                               ${m} AS m
                          FROM ${p.full} x) p0) b
         GROUP BY OrderId
      ) pay ON pay.OrderId = ${ref(app.orders, 'o', 'OrderId')}`,
    keys: PAY_BUCKETS.map(([k]) => k),
  };
}

/** ชื่อคนปิดบิล — join ตารางผู้ใช้ให้ถ้าโครงตรง (ชื่อคอลัมน์ต่างเวอร์ชันกันได้) */
function cashierJoin(app) {
  const u = app.users;
  const fk = ref(app.orders, 'o', 'PaidByUserId') || ref(app.orders, 'o', 'OpenedByUserId');
  if (!u || !fk) return null;
  const pk = colOf(u, 'UserId') || colOf(u, 'Id') || colOf(u, 'AppUserId');
  const nameCol = colOf(u, 'DisplayName') || colOf(u, 'FullName') || colOf(u, 'Name') || colOf(u, 'Username');
  if (!pk || !nameCol) return null;
  return { sql: `LEFT JOIN ${u.full} u ON u.${bracket(pk)} = ${fk}`, expr: `u.${bracket(nameCol)}` };
}

/**
 * สร้างคำสั่งอ่านข้อมูลของโครงแอปร้านอาหาร
 * คืนรูปแบบเดียวกับทางจับคู่อัตโนมัติ (rows/table/dateColumn/missing) หน้าเว็บจึงไม่ต้องรู้ว่ามาจากทางไหน
 */
export function buildAppPlan(app) {
  const o = app.orders;
  const d = orderDateExpr(o);
  if (!d) return null;
  const pay = paymentJoin(app);
  const cashier = cashierJoin(app);
  const voided = voidExpr(o);

  /* ── บิล ── */
  const billCols = [
    `${d.expr} AS ${bracket('date')}`,
    pickAs(o, 'o', ['OrderNo', 'OrderId'], 'checkId'),
    pickAs(o, 'o', ['Total', 'GrandTotal', 'NetTotal'], 'billTotal'),
    pickAs(o, 'o', ['SubTotal'], 'amount'),
    pickAs(o, 'o', ['VatAmount'], 'vat'),
    `NULL AS ${bracket('nonvat')}`,
    pickAs(o, 'o', ['DiscountAmount'], 'discount'),
    pickAs(o, 'o', ['ServiceChargeAmount'], 'serviceChg'),
    pickAs(o, 'o', ['GuestCount'], 'cover'),
    pay ? `COALESCE(pay.${bracket('methodName')}, ${ref(o, 'o', 'PaymentMethod') || "''"}) AS ${bracket('paidType')}`
        : pickAs(o, 'o', ['PaymentMethod'], 'paidType'),
    cashier ? `${cashier.expr} AS ${bracket('cashier')}` : `NULL AS ${bracket('cashier')}`,
    pickAs(o, 'o', ['TableName', 'TableId'], 'tableId'),
    `NULL AS ${bracket('outletId')}`,
    pickAs(o, 'o', ['OpenedAt'], 'startTime'),
    `NULL AS ${bracket('memberTel')}`,
    pickAs(o, 'o', ['Note'], 'note'),
    `${voided} AS ${bracket('voided')}`,
    pickAs(o, 'o', ['OrderType'], 'orderType'),
    pickAs(o, 'o', ['Status'], 'status'),
    // ช่องทางจ่าย: ไม่มีตาราง OrderPayment ก็ปล่อยเป็น 0 ทั้งแถว หน้าเว็บจะถอยไปแจกแจงตาม paidType เอง
    ...['cash', 'credit', 'qr', 'qrCredit', 'alipay', 'weChat', 'voucher', 'oc', 'delivery'].map((k) =>
      (pay && pay.keys.includes(k) ? `COALESCE(pay.${bracket(k)}, 0) AS ${bracket(k)}` : `NULL AS ${bracket(k)}`)),
  ];

  const bill = {
    table: o.full + (pay ? ' + OrderPayment' : ''),
    dateColumn: d.label,
    sql: (top) => `SELECT TOP ${top}
             ${billCols.join(',\n             ')}
        FROM ${o.full} o
        ${pay ? pay.sql : ''}
        ${cashier ? cashier.sql : ''}
       WHERE ${d.expr} >= @start AND ${d.expr} <= @end
       ORDER BY ${d.expr}`,
  };

  /* ── รายการสินค้าในบิล (ไม่มีวันที่ในตัวเอง ต้อง join บิล) ── */
  const it = app.items;
  const menu = app.menu && colOf(app.menu, 'MenuItemId') && colOf(it, 'MenuItemId') ? app.menu : null;
  const cat = menu && app.category && colOf(app.category, 'CategoryId') && colOf(menu, 'CategoryId') ? app.category : null;
  const itemName = [ref(it, 'i', 'MenuName'), menu ? ref(menu, 'mi', 'Name') : null].filter(Boolean);

  const itemCols = [
    `${d.expr} AS ${bracket('date')}`,
    pickAs(o, 'o', ['OrderNo', 'OrderId'], 'checkId'),
    pickAs(it, 'i', ['OrderItemId'], 'orderId'),
    menu ? pickAs(menu, 'mi', ['Code', 'MenuItemId'], 'itemCode') : pickAs(it, 'i', ['MenuItemId'], 'itemCode'),
    itemName.length ? `COALESCE(${itemName.join(', ')}) AS ${bracket('itemName')}` : `NULL AS ${bracket('itemName')}`,
    cat ? `${ref(cat, 'c', 'Name')} AS ${bracket('groupName')}` : `NULL AS ${bracket('groupName')}`,
    pickAs(it, 'i', ['Qty', 'Quantity'], 'quantity'),
    pickAs(it, 'i', ['UnitPrice'], 'unitPrice'),
    pickAs(it, 'i', ['LineTotal'], 'grossPrice'),
    `NULL AS ${bracket('tax')}`,
    pickAs(o, 'o', ['TableName', 'TableId'], 'tableId'),
    `NULL AS ${bracket('outletId')}`,
    cashier ? `${cashier.expr} AS ${bracket('waiter')}` : `NULL AS ${bracket('waiter')}`,
    `${voided} AS ${bracket('voided')}`,
    `NULL AS ${bracket('voidTime')}`,
  ];

  const item = {
    table: `${it.full} + ${o.name}${menu ? ` + ${menu.name}` : ''}${cat ? ` + ${cat.name}` : ''}`,
    dateColumn: d.label,
    sql: (top) => `SELECT TOP ${top}
             ${itemCols.join(',\n             ')}
        FROM ${it.full} i
        JOIN ${o.full} o ON ${ref(o, 'o', 'OrderId')} = ${ref(it, 'i', 'OrderId')}
        ${menu ? `LEFT JOIN ${menu.full} mi ON ${ref(menu, 'mi', 'MenuItemId')} = ${ref(it, 'i', 'MenuItemId')}` : ''}
        ${cat ? `LEFT JOIN ${cat.full} c ON ${ref(cat, 'c', 'CategoryId')} = ${ref(menu, 'mi', 'CategoryId')}` : ''}
        ${cashier ? cashier.sql : ''}
       WHERE ${d.expr} >= @start AND ${d.expr} <= @end
       ORDER BY ${d.expr}`,
  };

  /* ── รายจ่าย ── */
  let expense = null;
  const e = app.expense;
  const eDate = e && (ref(e, 'e', process.env.AORINGO_EXPENSE_DATE_COL || 'ExpenseDate') || ref(e, 'e', 'CreatedAt'));
  if (e && eDate) {
    const amount = ref(e, 'e', 'Amount');
    const qty = ref(e, 'e', 'Qty');
    const unit = ref(e, 'e', 'UnitPrice');
    // บางแถวกรอกแต่จำนวน×ราคา/หน่วย ไม่ได้กรอกยอดรวมมา — คิดให้เองจะได้ไม่หายไปจากยอดรวม
    const amountExpr = amount && qty && unit ? `COALESCE(${amount}, ${qty} * ${unit})` : (amount || (qty && unit ? `${qty} * ${unit}` : null));
    if (amountExpr) {
      const expCols = [
        `${eDate} AS ${bracket('date')}`,
        pickAs(e, 'e', ['CategoryName', 'Category'], 'category'),
        pickAs(e, 'e', ['ItemName', 'Detail', 'Description'], 'detail'),
        `${amountExpr} AS ${bracket('amount')}`,
        pickAs(e, 'e', ['Qty', 'Quantity'], 'quantity'),
        `NULL AS ${bracket('vendor')}`,
        `NULL AS ${bracket('payType')}`,
        pickAs(e, 'e', ['ExpenseId'], 'ref'),
        pickAs(e, 'e', ['CreatedBy'], 'user'),
        `NULL AS ${bracket('outletId')}`,
        pickAs(e, 'e', ['Note'], 'note'),
        pickAs(e, 'e', ['Unit'], 'unit'),
        pickAs(e, 'e', ['UnitPrice'], 'unitPrice'),
      ];
      expense = {
        table: e.full,
        dateColumn: colOf(e, process.env.AORINGO_EXPENSE_DATE_COL || 'ExpenseDate') || colOf(e, 'CreatedAt'),
        sql: (top) => `SELECT TOP ${top}
             ${expCols.join(',\n             ')}
        FROM ${e.full} e
       WHERE ${eDate} >= @start AND ${eDate} <= @end
       ORDER BY ${eDate}`,
      };
    }
  }

  return { mode: 'app', bill, item, expense };
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

    // ฐาน Aoringo ที่ร้านใช้เป็นโครงแอปร้านอาหาร (SaleOrder/SaleOrderItem/OrderPayment/Expense)
    // ซึ่งกระจายข้อมูลหลายตาราง — ตัวจับคู่แบบ "ตารางเดียวจบ" ข้างล่างอ่านไม่ได้ ต้องใช้ตัวเฉพาะ
    // ตั้ง AORINGO_*_TABLE เมื่อไหร่ = สั่งให้ใช้ตัวจับคู่อัตโนมัติแทน (คนตั้งย่อมรู้ว่าจะเอาตารางไหน)
    const forcedTables = Boolean(process.env.AORINGO_BILL_TABLE || process.env.AORINGO_ITEM_TABLE ||
      process.env.AORINGO_EXPENSE_TABLE);
    const mode = String(process.env.AORINGO_SCHEMA_MODE || '').toLowerCase();
    if (mode !== 'generic' && !forcedTables) {
      const app = detectAppSchema(tables);
      const plan = app && buildAppPlan(app);
      if (plan) {
        layoutCache = {
          mode: 'app',
          tableCount: tables.length,
          // แนบคำสั่งที่จะยิงจริงมาด้วย (แบบ TOP 5) — เวลาตัวเลขไม่ตรงจะได้เอาไปรันดูเองที่ SSMS ได้เลย
          roles: {
            bill: { table: plan.bill.table, dateColumn: plan.bill.dateColumn, sqlPreview: plan.bill.sql(5) },
            item: { table: plan.item.table, dateColumn: plan.item.dateColumn, sqlPreview: plan.item.sql(5) },
            expense: plan.expense
              ? { table: plan.expense.table, dateColumn: plan.expense.dateColumn, sqlPreview: plan.expense.sql(5) }
              : null,
          },
          plan,
          tables: tables.map((t) => ({ name: t.full, columns: t.columns.length })),
          note: 'อ่านแบบโครงแอปร้านอาหาร (SaleOrder/SaleOrderItem/OrderPayment/Expense) — ' +
            'อยากให้กลับไปใช้ตัวจับคู่อัตโนมัติให้ตั้ง env AORINGO_SCHEMA_MODE=generic',
        };
        layoutAt = Date.now();
        return layoutCache;
      }
    }

    const overrides = {
      bill:    { table: process.env.AORINGO_BILL_TABLE,    date: process.env.AORINGO_BILL_DATE_COL },
      item:    { table: process.env.AORINGO_ITEM_TABLE,    date: process.env.AORINGO_ITEM_DATE_COL },
      expense: { table: process.env.AORINGO_EXPENSE_TABLE, date: process.env.AORINGO_EXPENSE_DATE_COL },
    };

    const out = { mode: 'generic', tableCount: tables.length, roles: {} };
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

    if (layout.mode === 'app') {
      const step = layout.plan[role];
      if (!step) {
        throw new Error(
          `ฐาน Aoringo ไม่มีตาราง${what}ที่อ่านได้ — โครงนี้เก็บ${what}ไว้ที่ไหน ให้ตั้ง env ` +
          `AORINGO_${role.toUpperCase()}_TABLE ชี้ตารางนั้น (ดูรายชื่อตารางที่ /api/franchise?view=schema)`);
      }
      const rows = await q(step.sql(topOf(limit, fallbackTop)), rangeParams(start, end));
      return { rows: rows.map(mapRow), table: step.table, dateColumn: step.dateColumn, missing: [] };
    }

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
      mode: layout.mode,
      roles: Object.fromEntries(
        Object.entries(layout.roles).map(([k, v]) => [
          k, v ? { table: v.table, dateColumn: v.columns ? v.columns.date : v.dateColumn } : null,
        ])
      ),
    };
  }

  return { readLayout, forgetLayout, readBills, readItems, readExpenses, ping };
}
