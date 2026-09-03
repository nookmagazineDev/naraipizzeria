// ตรรกะฝั่ง SQL ของหน้า "ดูข้อมูลปิดรอบเดือน" (ฐาน InventoryNarai — ตาราง dbo.stock_month_end)
//
// แนวเดียวกับ lib/sheetsSql.mjs และ lib/scanEditSql.mjs — ไฟล์นี้ไม่รู้ว่า "ต่อฐานยังไง"
// รับตัวยิง query (q) เข้ามาแล้วคืนชุดฟังก์ชันให้ จึงใช้ร่วมกันได้ทั้งสองฝั่ง:
//   lib/sheetsSource.js      ฝั่ง Vercel ที่ต่อ SQL ตรง (pool ใน lib/qcrdPool.js)
//   host-server/sheets-db.js ฝั่งเครื่องออฟฟิศ ที่เปิดเป็น /sheets/month-end ให้เรียกผ่าน tunnel
//
// ⚠️ ตารางนี้ "ไม่ได้" ถูกสร้างโดยรีโปนี้ (คนละตัวกับ dbo.stock_closing ใน docs/schema-sheets.sql
//    ที่ย้ายมาจากชีท "ปิดรอบสิ้นเดือน") — เป็นตารางที่มีอยู่แล้วในฐาน จึงไม่รู้ชื่อคอลัมน์แน่ชัด
//    ตัวนี้เลยอ่านชื่อคอลัมน์จริงจาก INFORMATION_SCHEMA ก่อน แล้วจับคู่กับชื่อที่รู้จัก
//    (ตาราง MONTH_END_COLUMNS ข้างล่าง) ชื่อคอลัมน์ต่างจากที่เดาไว้ก็แค่เพิ่ม alias ที่ไฟล์นี้
//    ไฟล์เดียว ไม่ต้องไล่แก้ API/หน้าเว็บตามกันทีหลัง — และหน้าเว็บจะขึ้นข้อความบอกด้วยว่า
//    ตารางมีคอลัมน์อะไรบ้าง เวลาจับคู่ไม่ได้ จะได้รู้ว่าต้องเพิ่ม alias ตัวไหน
//
// หน้าเว็บใช้แบบ "ดูอย่างเดียว" — ไม่มีฝั่งเขียนโดยตั้งใจ ข้อมูลปิดรอบเป็นตัวตั้งต้นของยอดยกมา
// รอบถัดไป แก้จากหน้าจอดูข้อมูลไม่ได้

export const MONTH_END_TABLE = 'dbo.stock_month_end';

/**
 * ชื่อคอลัมน์ที่ยอมรับของแต่ละช่อง — เทียบแบบไม่สนตัวพิมพ์/ขีดล่าง/ช่องว่าง
 * (close_date, CloseDate, [close date] ถือว่าตัวเดียวกัน) เรียงจากตัวที่น่าจะใช่ที่สุดก่อน
 */
export const MONTH_END_COLUMNS = {
  date:       ['closing_date', 'close_date', 'month_end_date', 'end_date', 'stock_date', 'doc_date', 'period', 'month', 'date'],
  branch:     ['branch', 'branch_code', 'store', 'store_code', 'outlet', 'outlet_code'],
  itemCode:   ['item_code', 'product_code', 'product_id', 'item_id', 'code', 'sku'],
  itemKey:    ['item_key', 'product_key'],
  itemName:   ['item_name', 'product_name', 'name', 'description'],
  balance:    ['balance', 'qty', 'end_qty', 'closing_qty', 'quantity', 'stock_qty', 'remaining', 'remain'],
  unit:       ['unit', 'unit_name', 'uom'],
  unitValue:  ['unit_price', 'unit_value', 'unit_cost', 'cost', 'price'],
  totalValue: ['amount', 'total_value', 'total_cost', 'total_amount', 'total'],
  recordedBy: ['recorder', 'recorded_by', 'created_by', 'updated_by', 'user_name', 'username'],
  recordedAt: ['saved_at', 'recorded_at', 'record_time', 'created_at', 'updated_at'],
  // เลขที่แถว (closing_id ฯลฯ) ไม่ได้เอาไปแสดง แต่ใช้เรียงลำดับตอนวันที่/รหัสเท่ากันได้
  rowId:      ['closing_id', 'month_end_id', 'id'],
};

/**
 * รอบเดือนเรียกตาม "เดือนที่ปิด" ไม่ใช่เดือนของวันที่ที่ไปนับ
 *
 * ที่ร้านนับสต๊อกปิดรอบคาบเกี่ยวสิ้นเดือน/ต้นเดือน (30–31 ส.ค. บ้าง 1–2 ก.ย. บ้าง) แต่ทั้งหมดนั้น
 * คือ "รอบสิงหาคม" ชุดเดียวกัน — จัดกลุ่มตามเดือนของวันที่ปิดยอดตรง ๆ จะได้สองรอบทันที
 * ที่สาขาหนึ่งนับ 31 แล้วอีกสาขานับ 1 แถมรอบที่ปิดต้นเดือนยังไปใช้ชื่อเดือนถัดไปซึ่งไม่ตรงกับที่เรียกกัน
 *
 * เขียนเป็น "ถอย 2 วันแล้วดูว่าตกเดือนไหน" ทีเดียวจบ ไม่ต้องเช็กว่าเดือนนั้นมีกี่วัน
 *   31 ส.ค. − 2 = 29 ส.ค. -> รอบ ส.ค.   |   1 ก.ย. − 2 = 30 ส.ค. -> รอบ ส.ค.
 *   2 ก.ย.  − 2 = 31 ส.ค. -> รอบ ส.ค.   |   3 ก.ย. − 2 = 1 ก.ย.  -> รอบ ก.ย.
 *   2 มี.ค. − 2 = 28 ก.พ. -> รอบ ก.พ. (ปีอธิกสุรทินก็ถูก ไม่ต้องนับวันในเดือนเอง)
 * แก้เลขตัวเดียวตรงนี้ถ้าวันหลังเปลี่ยนกติกาเป็น 1 หรือ 3 วัน (ฝั่ง SQL ใช้ค่าเดียวกัน)
 * ค่าบวก = เลื่อนไปข้างหน้า (วันท้ายเดือนกลายเป็นรอบเดือนถัดไป) — ตอนนี้ใช้ค่าลบ
 */
export const CYCLE_SHIFT_DAYS = -2;

/** 'YYYY-MM-DD' -> รอบเดือน 'YYYY-MM' ตามกติกาข้างบน */
export function cycleMonth(isoDate) {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(isoDate || '').slice(0, 7);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + CYCLE_SHIFT_DAYS));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** ขาดช่องพวกนี้ = อ่านมาแสดงไม่ได้จริง ๆ (ไม่รู้ว่าแถวไหนของเดือนไหน ของอะไร เท่าไหร่) */
const REQUIRED = ['date', 'balance'];

const DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const pad2 = (n) => String(n).padStart(2, '0');
const key = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const badRequest = (message) => Object.assign(new Error(message), { badRequest: true });

/** DATE/DATETIME จาก SQL -> 'YYYY-MM-DD' (mssql คืน DATE มาเป็น Date ที่ตั้งเป็น UTC เที่ยงคืน) */
function ymd(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  return String(value).slice(0, 10);
}

/** DATETIME -> 'YYYY-MM-DD HH:mm' ; ข้อความปล่อยตามที่เก็บไว้ */
function stamp(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${ymd(value)} ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}`;
  }
  return String(value).replace('T', ' ').trim();
}

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** รหัสสินค้าแบบตัด 0 นำหน้า — กติกาเดียวกับ normalizeId ใน lib/sheetsSheet.mjs (ใช้จับคู่ข้ามหน้า) */
export const normalizeId = (id) => String(id ?? '').replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

/** ชื่อคอลัมน์ -> [ชื่อ] ที่ใส่ใน SQL ได้ (ปิด ] ซ้อนตามกติกา T-SQL) */
const bracket = (name) => `[${String(name).replace(/]/g, ']]')}]`;

export const isMissingTable = (msg) => /Invalid object name .*stock_month_end/i.test(msg || '');

/**
 * @param db.q  ยิง query: (text, params) => rows
 * คืน: readMonthEndSummary / readMonthEndMonths / readMonthEnd
 */
export function createMonthEnd({ q }) {
  // ผังคอลัมน์เปลี่ยนก็ต่อเมื่อมีคน ALTER TABLE — จำไว้สั้น ๆ พอ ไม่ต้องถาม INFORMATION_SCHEMA ทุกครั้ง
  let cache = { at: 0, layout: null };

  async function readLayout() {
    if (cache.layout && Date.now() - cache.at < 5 * 60 * 1000) return cache.layout;

    const cols = await q(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'stock_month_end'
      ORDER BY ORDINAL_POSITION`);

    if (!cols.length) {
      throw new Error(
        `ไม่พบตาราง ${MONTH_END_TABLE} ในฐานข้อมูล — ตรวจว่าต่อไปฐานถูกตัวไหม ` +
        'และ login ที่ใช้มีสิทธิ์เห็นตารางนี้หรือยัง');
    }

    const byKey = new Map(cols.map((c) => [key(c.COLUMN_NAME), c]));
    const found = {};
    Object.entries(MONTH_END_COLUMNS).forEach(([field, aliases]) => {
      const hit = aliases.map((a) => byKey.get(key(a))).find(Boolean);
      if (hit) found[field] = { name: hit.COLUMN_NAME, type: String(hit.DATA_TYPE).toLowerCase() };
    });

    const missing = REQUIRED.filter((f) => !found[f]);
    if (missing.length) {
      throw new Error(
        `จับคู่คอลัมน์ของ ${MONTH_END_TABLE} ไม่ได้ (ขาด: ${missing.join(', ')}) — ` +
        `ตารางนี้มีคอลัมน์ ${cols.map((c) => c.COLUMN_NAME).join(', ')} ` +
        'ถ้าชื่อไม่ตรงกับที่รู้จัก ให้เพิ่มชื่อจริงลงใน MONTH_END_COLUMNS ที่ lib/monthEndSql.mjs');
    }

    // รอบเดือนของแถว = เดือนของ (วันที่ปิดยอด ถอย 2 วัน) ตามกติกาข้างบน
    // คอลัมน์ที่เก็บเป็นข้อความเลื่อนวันแบบนี้ไม่ได้ (ไม่รู้ว่าเขียนรูปแบบไหน) จึงตัด 7 ตัวหน้าตามเดิม
    const dateCol = bracket(found.date.name);
    const isDate = DATE_TYPES.has(found.date.type);
    const monthExpr = isDate
      ? `CONVERT(char(7), DATEADD(day, ${CYCLE_SHIFT_DAYS}, ${dateCol}), 126)`
      : `LEFT(CONVERT(nvarchar(20), ${dateCol}), 7)`;

    const layout = {
      columns: found,
      monthExpr,
      isDateColumn: isDate,
      // ฝั่งข้อความเลื่อนวันไม่ได้ — หน้าเว็บจะได้ไม่ไปบอกผู้ใช้ว่าใช้กติกานี้อยู่ทั้งที่ไม่ได้ใช้
      cycleShiftDays: isDate ? CYCLE_SHIFT_DAYS : 0,
      tableColumns: cols.map((c) => c.COLUMN_NAME),
    };
    cache = { at: Date.now(), layout };
    return layout;
  }

  /**
   * สรุปรายสาขา: ปิดยอดรอบล่าสุดไปถึงวันไหน มีกี่รายการ ยอด/มูลค่ารวมเท่าไหร่
   * เป็นหน้าแรกของเมนูนี้ — คำถามแรกของออฟฟิศคือ "สาขาไหนยังไม่ปิดรอบ" ไม่ใช่ตัวเลขรายไอเทม
   *
   * ให้ฐานสรุปมาให้เลย (GROUP BY) ไม่ลากทั้งตารางมานับข้างนอก — ตารางมีหมื่นกว่าแถวและโตทุกเดือน
   * นับเฉพาะแถวของ "วันที่ปิดล่าสุดของสาขานั้น" เท่านั้น เดือนก่อน ๆ ไม่ถูกนับรวมเข้ามาด้วย
   */
  async function readMonthEndSummary() {
    const { columns, monthExpr } = await readLayout();

    const dateCol = bracket(columns.date.name);
    const branchExpr = columns.branch
      ? `LOWER(CONVERT(nvarchar(50), ${bracket(columns.branch.name)}))`
      : `''`;
    // คอลัมน์ที่ตารางไม่มี = ตัดออกจากคำสั่งไปเลย (SUM ของค่าคงที่ NULL สั่งไม่ได้)
    const valueCol = columns.totalValue ? `CONVERT(decimal(38,6), ${bracket(columns.totalValue.name)})` : null;
    const recCol = columns.recordedAt ? bracket(columns.recordedAt.name) : null;

    const rows = await q(`
      WITH src AS (
        SELECT ${branchExpr} AS b, ${dateCol} AS d,
               CONVERT(decimal(38,6), ${bracket(columns.balance.name)}) AS q
               ${valueCol ? `, ${valueCol} AS v` : ''}
               ${recCol ? `, ${recCol} AS r` : ''}
        FROM ${MONTH_END_TABLE}
        WHERE ${dateCol} IS NOT NULL
      ), latest AS (
        SELECT b, MAX(d) AS d FROM src GROUP BY b
      )
      SELECT s.b AS branch, s.d AS lastDate, COUNT(*) AS items, SUM(s.q) AS balance
             ${valueCol ? ', SUM(s.v) AS value' : ''}
             ${recCol ? ', MAX(s.r) AS recordedAt' : ''}
      FROM src s
      INNER JOIN latest l ON s.b = l.b AND s.d = l.d
      GROUP BY s.b, s.d
      ORDER BY s.b`);

    const branches = rows.map((r) => {
      const date = ymd(r.lastDate) || str(r.lastDate);
      return {
        branch: str(r.branch).toUpperCase(),
        date,
        month: cycleMonth(date),
        items: Number(r.items) || 0,
        balance: numOrNull(r.balance) ?? 0,
        value: numOrNull(r.value),
        recordedAt: stamp(r.recordedAt),
      };
    });

    // รอบล่าสุดของทั้งระบบ ไว้ให้หน้าเว็บชี้ว่าสาขาไหน "ตามหลัง" ชาวบ้าน
    // เทียบด้วยรอบเดือน ไม่ใช่วันที่ — สาขาที่นับ 31 ส.ค. กับ 1 ก.ย. อยู่รอบเดียวกัน ไม่ถือว่าใครตามหลัง
    const latestDate = branches.reduce((a, b) => (b.date > a ? b.date : a), '');
    const latestMonth = branches.reduce((a, b) => (b.month > a ? b.month : a), '');
    return { branches, latestDate, latestMonth, layout: describe(await readLayout()) };
  }

  /** เดือนที่มีข้อมูลปิดรอบ ('YYYY-MM' ใหม่ก่อน) — เอาไปเติม dropdown เลือกเดือน */
  async function readMonthEndMonths() {
    const { monthExpr } = await readLayout();
    const rows = await q(`
      SELECT DISTINCT ${monthExpr} AS m
      FROM ${MONTH_END_TABLE}
      WHERE ${monthExpr} IS NOT NULL AND ${monthExpr} <> ''
      ORDER BY m DESC`);
    return rows.map((r) => str(r.m)).filter(Boolean);
  }

  /**
   * แถวปิดรอบของเดือนหนึ่ง (ทุกสาขา หรือเฉพาะสาขาที่เลือก)
   * ไม่ระบุเดือน = เดือนล่าสุดที่มีข้อมูล — เปิดหน้ามาแล้วต้องเห็นของทันที ไม่ใช่ตารางว่าง
   */
  async function readMonthEnd({ month, branch, limit = 5000 } = {}) {
    const wantMonth = str(month);
    if (wantMonth && !/^\d{4}-\d{2}$/.test(wantMonth)) {
      throw badRequest(`เดือน "${wantMonth}" ไม่ถูกต้อง — ต้องเป็นรูปแบบ YYYY-MM เช่น 2026-08`);
    }

    const layout = await readLayout();
    const { columns, monthExpr } = layout;

    const months = await readMonthEndMonths();
    const useMonth = wantMonth || months[0] || '';
    if (!useMonth) {
      return { month: '', months, rows: [], branches: [], layout: describe(layout) };
    }

    const select = Object.entries(columns)
      .map(([field, c]) => `${bracket(c.name)} AS ${bracket(field)}`)
      .join(', ');

    const params = { month: useMonth, limit: Math.max(1, Math.min(Number(limit) || 5000, 20000)) };
    let where = `${monthExpr} = @month`;
    const branchKey = str(branch).toLowerCase();
    if (branchKey && branchKey !== 'all' && columns.branch) {
      params.branch = branchKey;
      where += ` AND LOWER(CONVERT(nvarchar(50), ${bracket(columns.branch.name)})) = @branch`;
    }

    // เรียงจากฐานเลย หน้าเว็บจะได้ไม่ต้องรอเรียงเองก่อนวาดครั้งแรก
    // ต่อท้ายด้วยเลขที่แถว เพื่อให้ลำดับคงที่ทุกครั้งเมื่อสาขา/ไอเทมเดียวกันมีหลายแถวในเดือนเดียว
    const orderBy = [
      columns.branch && bracket(columns.branch.name),
      columns.itemCode && bracket(columns.itemCode.name),
      columns.itemName && bracket(columns.itemName.name),
      columns.rowId && bracket(columns.rowId.name),
    ].filter(Boolean).join(', ') || bracket(columns.date.name);

    const rows = await q(`
      SELECT TOP (@limit) ${select}
      FROM ${MONTH_END_TABLE}
      WHERE ${where}
      ORDER BY ${orderBy}`, params);

    // รายชื่อสาขาที่มีข้อมูลในเดือนนั้นจริง ๆ — dropdown สาขาจะได้ไม่มีตัวเลือกที่กดแล้วว่าง
    let branches = [];
    if (columns.branch) {
      const b = await q(`
        SELECT DISTINCT LOWER(CONVERT(nvarchar(50), ${bracket(columns.branch.name)})) AS b
        FROM ${MONTH_END_TABLE}
        WHERE ${monthExpr} = @month AND ${bracket(columns.branch.name)} IS NOT NULL
        ORDER BY b`, { month: useMonth });
      branches = b.map((r) => str(r.b).toUpperCase()).filter(Boolean);
    }

    return {
      month: useMonth,
      months,
      branches,
      rows: rows.map(mapRow),
      layout: describe(layout),
    };
  }

  return { readMonthEndSummary, readMonthEndMonths, readMonthEnd, readLayout };
}

/** ผังคอลัมน์ในรูปที่ส่งกลับหน้าเว็บได้ — ไว้บอกว่าคอลัมน์ไหนของตารางถูกใช้เป็นช่องอะไร */
function describe(layout) {
  return {
    table: MONTH_END_TABLE,
    mapped: Object.fromEntries(Object.entries(layout.columns).map(([f, c]) => [f, c.name])),
    tableColumns: layout.tableColumns,
    // 0 = คอลัมน์วันที่เป็นข้อความ เลื่อนวันไม่ได้ จึงจัดกลุ่มตามเดือนของวันที่ปิดยอดตรง ๆ
    cycleShiftDays: layout.cycleShiftDays,
  };
}

/** แถวจากฐาน -> รูปที่หน้าเว็บใช้ (ช่องที่ตารางไม่มี = ค่าว่าง/null ไม่ใช่ undefined) */
function mapRow(r) {
  const itemCode = str(r.itemCode);
  const date = ymd(r.date) || str(r.date);
  return {
    date,
    month: cycleMonth(date),
    branch: str(r.branch).toUpperCase(),
    itemCode,
    itemKey: str(r.itemKey) || normalizeId(itemCode),
    itemName: str(r.itemName),
    unit: str(r.unit),
    balance: numOrNull(r.balance) ?? 0,
    unitValue: numOrNull(r.unitValue),
    totalValue: numOrNull(r.totalValue),
    recordedBy: str(r.recordedBy),
    recordedAt: stamp(r.recordedAt),
  };
}
