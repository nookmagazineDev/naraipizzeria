// แปลงแถวจากชีท -> เรคคอร์ด + คำสั่ง SQL สำหรับย้าย แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน
//
// แยกออกมาจาก pages/api/sheets-migrate.js เพื่อให้ "การจับคอลัมน์" อยู่ที่เดียว
// (แบบเดียวกับ lib/qcrdMigrate.mjs ที่ฝั่ง QC/RD ใช้ร่วมกันระหว่าง API กับสคริปต์ CLI)
// โครงตารางปลายทางอยู่ใน docs/schema-sheets.sql — แก้ที่นั่นแล้วต้องแก้ตรงนี้ให้ตรงกัน

export const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
export const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
/* ต้องให้ผลตรงกับ normalizeId() ฝั่งชีท และ normCode() ของ qcrdMigrate.mjs */
export const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

const pad2 = (n) => String(n).padStart(2, '0');

/** รับได้ทั้ง 'YYYY-MM-DD' และ 'DD/MM/YYYY' -> 'YYYY-MM-DD' (คืน null ถ้าอ่านไม่ออก) */
export function isoDate(value) {
  const s = str(value);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return null;
}

/** เดือนของค่าใช้จ่าย -> 'YYYY-MM' (ชีทเขียนมาทั้ง '2026-05', '05/2026' และวันที่เต็ม) */
export function isoMonth(value) {
  const s = str(value);
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}`;
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${pad2(m[1])}`;
  const d = isoDate(s);
  return d ? d.slice(0, 7) : '';
}

/* ---------------------------- แปลงแถว -> เรคคอร์ด ---------------------------- */

/**
 * แพลนสั่งของ — คีย์เป็น (เลขที่ใบสั่ง, ลำดับ)
 * ใบเก่าบางใบไม่มีเลขที่/ลำดับ สร้างให้แทน ไม่งั้นแถวพวกนั้นจะทับกันเองจนเหลือใบเดียว
 */
export function mapPlan(rows) {
  const out = [];
  let noOrderNo = 0;
  let skipped = 0;
  const seen = new Map();   // เลขที่ใบสั่ง -> ลำดับที่ใช้ไปแล้ว (กันลำดับซ้ำในใบเดียวกัน)

  rows.forEach((r, index) => {
    const itemKey = normCode(r.itemCode);
    if (!itemKey) { skipped++; return; }

    const branch = str(r.branch).toLowerCase();
    const orderDate = isoDate(r.orderDate);
    let orderNo = str(r.orderNo);
    if (!orderNo) {
      orderNo = `${branch || 'na'}${(orderDate || '').replace(/-/g, '') || 'x'}`;
      noOrderNo++;
    }

    // ลำดับในชีทว่าง/ซ้ำได้ — ไล่หาเลขว่างถัดไปในใบนั้นแทน (คีย์ต้องไม่ชนกัน)
    const used = seen.get(orderNo) || new Set();
    let seq = Number(str(r.seq));
    if (!Number.isInteger(seq) || seq <= 0 || used.has(seq)) {
      seq = used.size + 1;
      while (used.has(seq)) seq++;
    }
    used.add(seq);
    seen.set(orderNo, used);

    out.push({
      orderNo,
      seq,
      orderDate,
      recordTime: str(r.recordTime) || null,
      branch: branch || 'na',
      outletId: str(r.outletId) || null,
      receiveDate: isoDate(r.receiveDate),
      posItemId: str(r.itemId) || null,
      itemCode: str(r.itemCode) || null,
      itemKey,
      itemName: str(r.itemName) || null,
      qty: num(r.qty),
      unit: str(r.unit) || null,
      unitPrice: num(r.unitPrice),
      total: num(r.total),
      orderType: str(r.type) || null,
      recordedBy: str(r.recordedBy) || null,
      sortOrder: index,
    });
  });

  return { rows: out, stats: { generatedOrderNo: noOrderNo, skippedNoItemCode: skipped } };
}

/**
 * ปิดรอบสิ้นเดือน — คีย์เป็น (วันที่ปิดยอด, สาขา, ไอเทม)
 * ปิดยอดวันเดียวกันซ้ำหลายรอบในชีท ให้ยึดแถวที่บันทึกทีหลัง (sortKey มากกว่า) เหมือนที่หน้าเว็บทำ
 */
export function mapClosing(rows) {
  const best = new Map();
  let dup = 0;
  rows.forEach((r) => {
    const key = `${r.date}|${r.branch}|${r.itemId}`;
    const cur = best.get(key);
    if (cur) {
      dup++;
      if (r.sortKey <= cur.sortKey) return;
    }
    best.set(key, r);
  });

  const out = [...best.values()].map((r) => ({
    closeDate: r.date,
    branch: r.branch,
    itemKey: r.itemId,
    itemCode: str(r.itemCode) || null,
    itemName: str(r.itemName) || null,
    unit: str(r.unit) || null,
    balance: Number(r.balance),
    unitValue: r.unitValue ?? null,
    totalValue: r.totalValue ?? null,
    recordedBy: str(r.recordedBy) || null,
    recordedAt: str(r.recordedAt) || null,
    sortKey: r.sortKey,
  }));

  return { rows: out, stats: { duplicateRowsInSheet: dup } };
}

/** รหัสค่าใช้จ่าย (ประเภท/สาขา/รหัส) — แถวที่ไม่มีประเภทหรือสาขาไม่เอา */
export function mapExpenseRefs(refs) {
  const out = [];
  const seen = new Set();
  let dup = 0;
  refs.forEach((r, index) => {
    const type = str(r.type);
    const branch = str(r.branch);
    if (!type || !branch) return;
    const code = str(r.code);
    const key = `${type}|${branch}|${code}`;
    if (seen.has(key)) { dup++; return; }
    seen.add(key);
    out.push({ type, branch, code, sortOrder: index });
  });
  return { rows: out, stats: { duplicateRefs: dup } };
}

/**
 * ค่าใช้จ่ายที่บันทึกแล้ว — คีย์เป็น (เดือน, ประเภท, สาขา, รหัส)
 * ชุดเดียวกับที่ saveOtherExpense ของ Apps Script ใช้ตัดสินว่าเป็นแถวเดิม
 * แถวเดือนซ้ำในชีทให้ยึดแถวหลังสุด (ชีท append ต่อท้าย แถวหลังคือค่าที่แก้ล่าสุด)
 */
export function mapExpenses(list) {
  const best = new Map();
  let dup = 0;
  let noMonth = 0;
  list.forEach((r) => {
    const period = isoMonth(r.month);
    const type = str(r.type);
    const branch = str(r.branch);
    if (!period) { noMonth++; return; }
    if (!type && !branch) return;
    const code = str(r.code);
    const key = `${period}|${type}|${branch}|${code}`;
    if (best.has(key)) dup++;
    best.set(key, {
      period,
      type,
      branch,
      code,
      meterStart: num(r.start),
      meterEnd: num(r.end),
      qty: num(r.qty),
      unitPrice: num(r.price),
      total: num(r.total),
      savedAt: str(r.savedAt) || null,
    });
  });
  return { rows: [...best.values()], stats: { duplicateEntries: dup, skippedNoMonth: noMonth } };
}

/** พนักงาน — คีย์เป็นรหัส HR; แถวหัวตาราง/แถวว่างที่ปนมากับชีทตัดทิ้ง (เหมือนที่หน้าเว็บกรอง) */
const HEADER_HRCODES = new Set(['รหัส hr', 'รหัส', 'hrcode']);

export function mapEmployees(list) {
  const out = [];
  const seen = new Set();
  let dup = 0;
  let skipped = 0;
  list.forEach((e, index) => {
    const hrCode = str(e.hrCode);
    const fullName = str(e.fullName);
    if (!hrCode || HEADER_HRCODES.has(hrCode.toLowerCase()) || fullName === 'ชื่อ - สกุล') { skipped++; return; }
    if (seen.has(hrCode)) { dup++; return; }
    seen.add(hrCode);
    out.push({
      hrCode,
      fullName: fullName || null,
      branch: str(e.branch) || null,
      empType: str(e.type) || null,
      status: str(e.status) || null,
      position: str(e.position) || null,
      startDate: str(e.startDate) || null,
      loga: str(e.loga) || null,
      newCode: str(e.newCode) || null,
      photoUrl: str(e.photoUrl) || null,
      sortOrder: index,
    });
  });
  return { rows: out, stats: { duplicateHrCodes: dup, skippedRows: skipped } };
}

/* ------------------------------ คำสั่ง SQL ------------------------------ */

export function planStmt(p, suffix = '') {
  const k = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.stock_plan AS t
      USING (SELECT ${k('order_no')} AS order_no, ${k('seq')} AS seq) AS s
        ON t.order_no = s.order_no AND t.seq = s.seq
      WHEN MATCHED THEN UPDATE SET
        order_date = ${k('order_date')}, record_time = ${k('record_time')}, branch = ${k('branch')},
        outlet_id = ${k('outlet_id')}, receive_date = ${k('receive_date')}, pos_item_id = ${k('pos_item_id')},
        item_code = ${k('item_code')}, item_key = ${k('item_key')}, item_name = ${k('item_name')},
        qty = ${k('qty')}, unit = ${k('unit')}, unit_price = ${k('unit_price')}, total = ${k('total')},
        order_type = ${k('order_type')}, recorded_by = ${k('recorded_by')}, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (order_no, seq, order_date, record_time, branch, outlet_id, receive_date, pos_item_id,
         item_code, item_key, item_name, qty, unit, unit_price, total, order_type, recorded_by)
        VALUES (${k('order_no')}, ${k('seq')}, ${k('order_date')}, ${k('record_time')}, ${k('branch')},
                ${k('outlet_id')}, ${k('receive_date')}, ${k('pos_item_id')}, ${k('item_code')},
                ${k('item_key')}, ${k('item_name')}, ${k('qty')}, ${k('unit')}, ${k('unit_price')},
                ${k('total')}, ${k('order_type')}, ${k('recorded_by')});`,
    params: {
      [`order_no${suffix}`]: p.orderNo,
      [`seq${suffix}`]: p.seq,
      [`order_date${suffix}`]: p.orderDate,
      [`record_time${suffix}`]: p.recordTime,
      [`branch${suffix}`]: p.branch,
      [`outlet_id${suffix}`]: p.outletId,
      [`receive_date${suffix}`]: p.receiveDate,
      [`pos_item_id${suffix}`]: p.posItemId,
      [`item_code${suffix}`]: p.itemCode,
      [`item_key${suffix}`]: p.itemKey,
      [`item_name${suffix}`]: p.itemName,
      [`qty${suffix}`]: p.qty,
      [`unit${suffix}`]: p.unit,
      [`unit_price${suffix}`]: p.unitPrice,
      [`total${suffix}`]: p.total,
      [`order_type${suffix}`]: p.orderType,
      [`recorded_by${suffix}`]: p.recordedBy,
    },
  };
}

export function closingStmt(c, suffix = '') {
  const k = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.stock_closing AS t
      USING (SELECT ${k('close_date')} AS close_date, ${k('branch')} AS branch, ${k('item_key')} AS item_key) AS s
        ON t.close_date = s.close_date AND t.branch = s.branch AND t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = ${k('item_code')}, item_name = ${k('item_name')}, unit = ${k('unit')},
        balance = ${k('balance')}, unit_value = ${k('unit_value')}, total_value = ${k('total_value')},
        recorded_by = ${k('recorded_by')}, recorded_at = ${k('recorded_at')}, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (close_date, branch, item_key, item_code, item_name, unit, balance, unit_value, total_value,
         recorded_by, recorded_at)
        VALUES (${k('close_date')}, ${k('branch')}, ${k('item_key')}, ${k('item_code')}, ${k('item_name')},
                ${k('unit')}, ${k('balance')}, ${k('unit_value')}, ${k('total_value')},
                ${k('recorded_by')}, ${k('recorded_at')});`,
    params: {
      [`close_date${suffix}`]: c.closeDate,
      [`branch${suffix}`]: c.branch,
      [`item_key${suffix}`]: c.itemKey,
      [`item_code${suffix}`]: c.itemCode,
      [`item_name${suffix}`]: c.itemName,
      [`unit${suffix}`]: c.unit,
      [`balance${suffix}`]: c.balance,
      [`unit_value${suffix}`]: c.unitValue,
      [`total_value${suffix}`]: c.totalValue,
      [`recorded_by${suffix}`]: c.recordedBy,
      [`recorded_at${suffix}`]: c.recordedAt,
    },
  };
}

export function expenseRefStmt(r, suffix = '') {
  const k = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.expense_ref AS t
      USING (SELECT ${k('exp_type')} AS exp_type, ${k('branch')} AS branch, ${k('code')} AS code) AS s
        ON t.exp_type = s.exp_type AND t.branch = s.branch AND t.code = s.code
      WHEN MATCHED THEN UPDATE SET sort_order = ${k('sort_order')}, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (exp_type, branch, code, sort_order)
        VALUES (${k('exp_type')}, ${k('branch')}, ${k('code')}, ${k('sort_order')});`,
    params: {
      [`exp_type${suffix}`]: r.type,
      [`branch${suffix}`]: r.branch,
      [`code${suffix}`]: r.code,
      [`sort_order${suffix}`]: r.sortOrder,
    },
  };
}

export function expenseStmt(e, suffix = '') {
  const k = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.expense_entry AS t
      USING (SELECT ${k('period')} AS period, ${k('exp_type')} AS exp_type,
                    ${k('branch')} AS branch, ${k('code')} AS code) AS s
        ON t.period = s.period AND t.exp_type = s.exp_type AND t.branch = s.branch AND t.code = s.code
      WHEN MATCHED THEN UPDATE SET
        meter_start = ${k('meter_start')}, meter_end = ${k('meter_end')}, qty = ${k('qty')},
        unit_price = ${k('unit_price')}, total = ${k('total')}, saved_at = ${k('saved_at')},
        updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (period, exp_type, branch, code, meter_start, meter_end, qty, unit_price, total, saved_at)
        VALUES (${k('period')}, ${k('exp_type')}, ${k('branch')}, ${k('code')}, ${k('meter_start')},
                ${k('meter_end')}, ${k('qty')}, ${k('unit_price')}, ${k('total')}, ${k('saved_at')});`,
    params: {
      [`period${suffix}`]: e.period,
      [`exp_type${suffix}`]: e.type,
      [`branch${suffix}`]: e.branch,
      [`code${suffix}`]: e.code,
      [`meter_start${suffix}`]: e.meterStart,
      [`meter_end${suffix}`]: e.meterEnd,
      [`qty${suffix}`]: e.qty,
      [`unit_price${suffix}`]: e.unitPrice,
      [`total${suffix}`]: e.total,
      [`saved_at${suffix}`]: e.savedAt,
    },
  };
}

export function employeeStmt(e, suffix = '') {
  const k = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.hr_employee AS t
      USING (SELECT ${k('hr_code')} AS hr_code) AS s ON t.hr_code = s.hr_code
      WHEN MATCHED THEN UPDATE SET
        full_name = ${k('full_name')}, branch = ${k('branch')}, emp_type = ${k('emp_type')},
        status = ${k('status')}, position = ${k('position')}, start_date = ${k('start_date')},
        loga = ${k('loga')}, new_code = ${k('new_code')}, photo_url = ${k('photo_url')},
        sort_order = ${k('sort_order')}, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (hr_code, full_name, branch, emp_type, status, position, start_date, loga, new_code, photo_url, sort_order)
        VALUES (${k('hr_code')}, ${k('full_name')}, ${k('branch')}, ${k('emp_type')}, ${k('status')},
                ${k('position')}, ${k('start_date')}, ${k('loga')}, ${k('new_code')}, ${k('photo_url')},
                ${k('sort_order')});`,
    params: {
      [`hr_code${suffix}`]: e.hrCode,
      [`full_name${suffix}`]: e.fullName,
      [`branch${suffix}`]: e.branch,
      [`emp_type${suffix}`]: e.empType,
      [`status${suffix}`]: e.status,
      [`position${suffix}`]: e.position,
      [`start_date${suffix}`]: e.startDate,
      [`loga${suffix}`]: e.loga,
      [`new_code${suffix}`]: e.newCode,
      [`photo_url${suffix}`]: e.photoUrl,
      [`sort_order${suffix}`]: e.sortOrder,
    },
  };
}
