// ตรรกะฝั่ง SQL ของ แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน
// (ฐาน InventoryNarai — โครงตารางอยู่ใน docs/schema-sheets.sql)
//
// ไฟล์นี้ไม่รู้จักว่า "ต่อฐานยังไง" — รับตัวยิง query (q) เข้ามาแล้วคืนชุดฟังก์ชันให้
// จึงใช้ร่วมกันได้ทั้งสองฝั่งโดยไม่ต้องมีสองสำเนาให้แก้ตามกันทีหลัง:
//   lib/sheetsSource.js      ฝั่ง Vercel ที่ต่อ SQL ตรง (ผูกกับ pool ใน lib/qcrdPool.js)
//   host-server/sheets-db.js ฝั่งเครื่องออฟฟิศ ที่เปิดเป็น endpoint /sheets/* ให้เรียกผ่าน tunnel
//
// แนวเดียวกับ lib/qcrdSql.mjs ที่ฝั่ง QC/RD ใช้อยู่ — actions ตั้งชื่อให้ตรงกับที่หน้าเว็บ
// เคยยิงไป Apps Script ทุกตัว (saveOtherExpense · bulkImport · deleteExpenseByMonth · saveEmployee)
import { isoMonth, num, str } from './sheetsMigrate.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

/** DATE จาก SQL -> 'YYYY-MM-DD' (mssql คืนมาเป็น Date ที่ตั้งเป็น UTC เที่ยงคืน) */
function ymd(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  return String(value).slice(0, 10);
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' (รูปแบบที่หน้าแพลนสินค้าใช้แสดงและเรียง) */
function thaiSlash(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

const dec = (v) => (v === null || v === undefined ? 0 : Number(v));

// ตัวคูณหน่วยไฟฟ้ารายสาขา — มิเตอร์บางสาขาอ่านค่าไม่เท่าหน่วยไฟจริง ต้องคูณแปลงก่อน (สาขาอื่น ×1)
// ต้องแก้ให้ตรงกันทั้ง components/OtherExpense.jsx และ expense-apps-script.gs ทุกครั้ง
const ELECTRIC_UNIT_MULTIPLIERS = { XUM: 40, ZPT: 1000, ZBW: 2.5, RCH: 1000, IPR: 45 };
const unitMultiplier = (type, branch) =>
  str(type).startsWith('ไฟ') ? (ELECTRIC_UNIT_MULTIPLIERS[str(branch).toUpperCase()] || 1) : 1;

/** 'yyyy-MM-dd HH:mm' ตามเวลาไทย — รูปแบบเดียวกับที่ Apps Script ประทับไว้ในคอลัมน์ J */
function stampNow() {
  const t = new Date(Date.now() + 7 * 60 * 60 * 1000);   // ทั้ง Vercel และ node บนเครื่องโฮสต์อาจรันเป็น UTC
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ` +
    `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}

/**
 * หนึ่งแถวค่าใช้จ่าย — คิด จำนวน/ผลรวม ด้วยสูตรเดียวกับ buildRow_ ของ Apps Script
 * (จำนวน = (สิ้นสุด − เริ่มต้น) × ตัวคูณหน่วย ; ผลรวม = total ที่ส่งมา หรือ จำนวน × ราคา)
 * ไม่มีค่า = null ไม่ใช่ 0 — แถวที่นำเข้ายอดเงินรวมมาตรง ๆ ไม่มีเลขมิเตอร์ให้คิด
 */
function buildExpenseRow(month, branch, it) {
  const start = num(it.start);
  const end = num(it.end);
  const price = num(it.price);
  const qty = (start !== null && end !== null) ? (end - start) * unitMultiplier(it.type, branch) : null;
  const given = num(it.total);
  const total = given !== null ? given : (qty !== null && price !== null ? qty * price : null);
  return {
    period: isoMonth(month),
    type: str(it.type),
    branch: str(branch),
    code: str(it.code),
    meterStart: start,
    meterEnd: end,
    qty,
    unitPrice: price,
    total,
    savedAt: stampNow(),
  };
}

// ฟิลด์พนักงานที่แก้ได้จากหน้าเว็บ -> คอลัมน์ในตาราง (hrCode เป็นคีย์ ไม่ให้แก้)
const EMP_COLUMNS = {
  fullName: 'full_name', branch: 'branch', type: 'emp_type', status: 'status',
  position: 'position', startDate: 'start_date', loga: 'loga',
  newCode: 'new_code', photoUrl: 'photo_url',
};

/**
 * @param db.q  ยิง query: (text, params) => rows
 * คืน: readPlan / readClosing / readExpenseRefs / readExpenses / readEmployees + actions
 */
export function createSheets({ q }) {
  /* ─────────────────────────── อ่านข้อมูล ─────────────────────────── */

  /** แพลนสั่งของ — คืนรูปแบบเดียวกับที่ /api/plan เคยตอบจากชีททุกช่อง */
  async function readPlan() {
    const rows = await q(`
      SELECT order_no, seq, order_date, record_time, branch, outlet_id, receive_date, pos_item_id,
             item_code, item_name, qty, unit, unit_price, total, order_type, recorded_by
      FROM dbo.stock_plan
      ORDER BY order_date, order_no, seq`);
    return rows.map((r) => ({
      orderDate: thaiSlash(ymd(r.order_date)),
      recordTime: str(r.record_time),
      branch: str(r.branch).toUpperCase(),
      outletId: str(r.outlet_id),
      orderNo: str(r.order_no),
      seq: str(r.seq),
      receiveDate: ymd(r.receive_date),
      itemId: str(r.pos_item_id),
      itemCode: str(r.item_code),
      itemName: str(r.item_name),
      qty: dec(r.qty),
      unit: str(r.unit),
      unitPrice: dec(r.unit_price),
      total: dec(r.total),
      type: str(r.order_type),
      recordedBy: str(r.recorded_by),
    }));
  }

  /**
   * ยอดยกมาของสาขาหนึ่ง = ยอดปิดรอบ "ล่าสุด" ของแต่ละไอเทม
   * ให้ฐานคัดแถวล่าสุดมาให้เลย (ROW_NUMBER) จะได้ไม่ต้องลากทั้งตารางมาคัดข้างนอกเหมือนตอนอ่านชีท
   *
   * ตัวตัดสินคือ close_date อย่างเดียว ไม่ต้องดู recorded_at ต่อเหมือนฝั่งชีท เพราะคีย์ของตาราง
   * คือ (close_date, branch, item_key) — ปิดยอดวันเดียวกันซ้ำถูกยุบเหลือแถวเดียวไปแล้วตั้งแต่ตอนเขียน
   */
  async function readClosing(branchKey) {
    const rows = await q(`
      SELECT item_key, balance, close_date, unit, recorded_at
      FROM (
        SELECT item_key, balance, close_date, unit, recorded_at,
               ROW_NUMBER() OVER (PARTITION BY item_key ORDER BY close_date DESC) AS rn
        FROM dbo.stock_closing
        WHERE branch = @branch
      ) x
      WHERE rn = 1`, { branch: str(branchKey).toLowerCase() });

    const data = {};
    let latestDate = '';
    rows.forEach((r) => {
      const date = ymd(r.close_date);
      data[str(r.item_key)] = {
        balance: Number(dec(r.balance).toFixed(2)),
        date,
        unit: str(r.unit),
        recordedAt: str(r.recorded_at),
      };
      if (date > latestDate) latestDate = date;
    });
    return { data, latestDate };
  }

  async function readExpenseRefs() {
    const rows = await q(`
      SELECT exp_type, branch, code FROM dbo.expense_ref
      ORDER BY sort_order, exp_type, branch, code`);
    return rows.map((r) => ({ type: str(r.exp_type), branch: str(r.branch), code: str(r.code) }));
  }

  async function readExpenses() {
    const rows = await q(`
      SELECT period, exp_type, branch, code, meter_start, meter_end, qty, unit_price, total, saved_at
      FROM dbo.expense_entry
      ORDER BY period, exp_type, branch, code`);
    return rows.map((r) => ({
      month: str(r.period),
      type: str(r.exp_type),
      branch: str(r.branch),
      code: str(r.code),
      start: r.meter_start === null ? '' : Number(r.meter_start),
      end: r.meter_end === null ? '' : Number(r.meter_end),
      qty: r.qty === null ? '' : Number(r.qty),
      price: r.unit_price === null ? '' : Number(r.unit_price),
      total: r.total === null ? '' : Number(r.total),
      savedAt: str(r.saved_at),
    }));
  }

  async function readEmployees() {
    const rows = await q(`
      SELECT hr_code, full_name, branch, emp_type, status, position, start_date, loga, new_code, photo_url
      FROM dbo.hr_employee
      ORDER BY sort_order, hr_code`);
    return rows.map((r) => ({
      hrCode: str(r.hr_code),
      fullName: str(r.full_name),
      branch: str(r.branch),
      type: str(r.emp_type),
      status: str(r.status),
      position: str(r.position),
      startDate: str(r.start_date),
      loga: str(r.loga),
      newCode: str(r.new_code),
      photoUrl: str(r.photo_url),
    }));
  }

  /* ─────────────────────────── เขียนข้อมูล ─────────────────────────── */

  /** upsert ทีละแถว แล้วนับว่าอันไหนเพิ่มใหม่/อันไหนทับของเดิม (ตัวเลขที่หน้าเว็บเอาไปขึ้น toast) */
  async function upsertExpenses(records) {
    let appended = 0;
    let updated = 0;
    for (const e of records) {
      if (!e.period) throw Object.assign(new Error('ไม่ได้ระบุเดือน (month) ที่จะบันทึก'), { badRequest: true });
      const rows = await q(`
        MERGE dbo.expense_entry AS t
        USING (SELECT @period AS period, @exp_type AS exp_type, @branch AS branch, @code AS code) AS s
          ON t.period = s.period AND t.exp_type = s.exp_type AND t.branch = s.branch AND t.code = s.code
        WHEN MATCHED THEN UPDATE SET
          meter_start = @meter_start, meter_end = @meter_end, qty = @qty,
          unit_price = @unit_price, total = @total, saved_at = @saved_at, updated_at = SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT
          (period, exp_type, branch, code, meter_start, meter_end, qty, unit_price, total, saved_at)
          VALUES (@period, @exp_type, @branch, @code, @meter_start, @meter_end, @qty, @unit_price, @total, @saved_at)
        OUTPUT $action AS act;`, {
        period: e.period, exp_type: e.type, branch: e.branch, code: e.code,
        meter_start: e.meterStart, meter_end: e.meterEnd, qty: e.qty,
        unit_price: e.unitPrice, total: e.total, saved_at: e.savedAt,
      });
      if (str(rows[0]?.act).toUpperCase() === 'INSERT') appended++;
      else updated++;
    }
    return { appended, updated };
  }

  /** บันทึกจากฟอร์ม — body เดียวกับที่เคยส่งไป Apps Script ทุกช่อง */
  async function saveOtherExpense(body) {
    const month = isoMonth(body?.month);
    const branch = str(body?.branch);
    const items = Array.isArray(body?.items) ? body.items : [];
    return upsertExpenses(items.map((it) => buildExpenseRow(month, branch, it)));
  }

  /** นำเข้าหลายแถวรวดเดียว — rows: [{month,type,branch,code,start,end,price,total}] */
  async function bulkImport(body) {
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const r = await upsertExpenses(rows.map((x) => buildExpenseRow(x.month, x.branch, x)));
    // ฝั่งชีท append อย่างเดียวจึงคืนแค่ appended — คืนทั้งคู่ให้เห็นว่ามีกี่แถวที่ไปทับของเดิม
    return { appended: r.appended + r.updated, inserted: r.appended, updated: r.updated };
  }

  async function deleteExpenseByMonth(body) {
    const period = isoMonth(body?.month);
    if (!period) throw Object.assign(new Error('ไม่ได้ระบุเดือนที่จะลบ'), { badRequest: true });
    const rows = await q(
      'DELETE FROM dbo.expense_entry WHERE period = @period; SELECT @@ROWCOUNT AS n;', { period });
    return { deleted: Number(rows[0]?.n) || 0 };
  }

  /** แก้ข้อมูลพนักงาน — เขียนเฉพาะฟิลด์ที่ส่งมา ฟิลด์อื่นไม่แตะ (เหมือน saveEmployee_ ฝั่ง Apps Script) */
  async function saveEmployee(body) {
    const hrCode = str(body?.hrCode);
    if (!hrCode) throw Object.assign(new Error('ไม่ได้ระบุรหัสพนักงาน (hrCode)'), { badRequest: true });

    const sets = [];
    const params = { hr_code: hrCode };
    Object.entries(EMP_COLUMNS).forEach(([field, column]) => {
      if (body[field] === undefined) return;
      sets.push(`${column} = @${column}`);
      params[column] = str(body[field]);
    });
    if (!sets.length) return { hrCode, updated: 0, note: 'ไม่มีฟิลด์ที่ต้องแก้' };

    const rows = await q(
      `UPDATE dbo.hr_employee SET ${sets.join(', ')}, updated_at = SYSDATETIME() WHERE hr_code = @hr_code;
       SELECT @@ROWCOUNT AS n;`, params);
    const updated = Number(rows[0]?.n) || 0;
    if (!updated) {
      throw Object.assign(new Error(`ไม่พบพนักงานรหัส ${hrCode} ในฐานข้อมูล`), { badRequest: true });
    }
    return { hrCode, updated, fields: sets.length };
  }

  const ACTIONS = { saveOtherExpense, bulkImport, deleteExpenseByMonth, saveEmployee };

  return { readPlan, readClosing, readExpenseRefs, readExpenses, readEmployees, actions: ACTIONS };
}
