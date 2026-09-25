// ตรรกะฝั่ง SQL ของหน้า HR → "ยูนิฟอร์ม" (ฐาน InventoryNarai — ตาราง dbo.UniformBranch)
//
// แนวเดียวกับ lib/monthEndSql.mjs — ไฟล์นี้ไม่รู้ว่า "ต่อฐานยังไง" รับตัวยิง query (q) เข้ามา
// แล้วคืนชุดฟังก์ชันให้ จึงใช้ร่วมกันได้ทั้งสองฝั่ง:
//   lib/sheetsSource.js      ฝั่ง Vercel ที่ต่อ SQL ตรง (pool ใน lib/qcrdPool.js)
//   host-server/sheets-db.js ฝั่งเครื่องออฟฟิศ ที่เปิดเป็น /sheets/uniform-branch ให้เรียกผ่าน tunnel
//
// ⚠️ ตารางนี้ "ไม่ได้" ถูกสร้างโดยรีโปนี้ — มีอยู่แล้วในฐาน จึงไม่รู้ชื่อคอลัมน์แน่ชัด
//    ตัวนี้อ่านชื่อคอลัมน์จริงจาก INFORMATION_SCHEMA ก่อน แล้วจับคู่กับชื่อที่รู้จัก
//    (UNIFORM_COLUMNS ข้างล่าง) ส่วนแถวส่งกลับไป "ครบทุกคอลัมน์" ตามที่อยู่ในตาราง
//    หน้าเว็บจึงแสดงได้ทุกช่อง และให้ผู้ใช้เปลี่ยนคอลัมน์ที่ใช้จัดกลุ่ม/รวมยอดเองได้
//    ชื่อจริงไม่ตรงกับที่เดาไว้ = รายงานยังใช้ได้ แค่ค่าเริ่มต้นของตัวเลือกไม่ตรง (เพิ่ม alias ที่นี่ได้)
//
// ดูอย่างเดียว — ไม่มีฝั่งเขียนโดยตั้งใจ

export const UNIFORM_TABLE = 'dbo.UniformBranch';

/** เพดานแถวที่ลากมาต่อครั้ง — ตารางเบิกยูนิฟอร์มไม่ได้โตเร็ว แต่กันไว้ไม่ให้ฟังก์ชันบวม */
export const UNIFORM_DEFAULT_LIMIT = 20000;
export const UNIFORM_MAX_LIMIT = 50000;

/**
 * ชื่อคอลัมน์ที่ยอมรับของแต่ละช่อง — เทียบแบบไม่สนตัวพิมพ์/ขีดล่าง/ช่องว่าง
 * เรียงจากตัวที่น่าจะใช่ที่สุดก่อน คอลัมน์หนึ่งถูกใช้ได้ช่องเดียว (จับคู่ตามลำดับช่องข้างล่าง)
 */
export const UNIFORM_COLUMNS = {
  branch:   ['branch_code', 'branch', 'branchname', 'branch_name', 'store', 'store_code', 'outlet', 'outlet_code', 'สาขา'],
  item:     ['uniform_name', 'uniformname', 'uniform', 'uniform_type', 'item_name', 'itemname', 'item',
    'product_name', 'product', 'type', 'name', 'description', 'รายการ', 'ชื่อ'],
  size:     ['size', 'uniform_size', 'ไซส์', 'ขนาด'],
  qty:      ['qty', 'quantity', 'uniform_qty', 'total_qty', 'count', 'num', 'จำนวน', 'amount'],
  price:    ['unit_price', 'price', 'unit_cost', 'cost', 'ราคา'],
  total:    ['total_price', 'total_amount', 'total_value', 'total', 'net', 'value', 'ยอดรวม'],
  date:     ['issued_at', 'issue_date', 'request_date', 'doc_date', 'uniform_date', 'date', 'created_date', 'create_date',
    'created_at', 'updated_at', 'วันที่'],
  employee: ['employee_name', 'emp_name', 'empname', 'employee', 'staff_name', 'staff', 'พนักงาน'],
  empCode:  ['hr_code', 'emp_code', 'emp_id', 'employee_id', 'employee_code', 'รหัสพนักงาน'],
  itemCode: ['item_code', 'product_code', 'uniform_code', 'รหัสสินค้า'],
  status:   ['status', 'สถานะ'],
};

const DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);
const NUMBER_TYPES = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney']);
// อ่านมาแสดงไม่ได้/ไม่มีประโยชน์บนหน้ารายงาน — ตัดออกตั้งแต่ใน SELECT
const SKIP_TYPES = new Set(['binary', 'varbinary', 'image', 'timestamp', 'rowversion', 'geography', 'geometry', 'hierarchyid', 'sql_variant', 'xml']);

const pad2 = (n) => String(n).padStart(2, '0');
const key = (v) => String(v ?? '').toLowerCase().replace(/[\s_\-.]/g, '');
const bracket = (name) => `[${String(name).replace(/]/g, ']]')}]`;

/** DATE/DATETIME -> 'YYYY-MM-DD' หรือ 'YYYY-MM-DD HH:mm' (mssql คืนค่าเป็น Date ที่ตั้งเป็น UTC) */
function dateText(value, type) {
  const d = `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  if (type === 'date') return d;
  const hm = `${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}`;
  return hm === '00:00' ? d : `${d} ${hm}`;
}

/**
 * ไอเทมไหนนับเป็นยูนิฟอร์ม (ใช้คัดใบขอเบิกใน dbo.stock_request)
 *   1) item_key ที่เคยถูกแจกใน dbo.UniformBranch แล้ว
 *   2) รหัสสินค้าในทะเบียน dbo.stock_item ขึ้นต้นด้วยตัวนี้ (ยูนิฟอร์มใช้รหัสชุด 8000xxxx)
 * ยูนิฟอร์มตัวใหม่ที่ยังไม่เคยแจกและรหัสไม่ได้ขึ้นต้นแบบนี้ จะไม่โผล่ — เพิ่มกติกาที่นี่
 */
export const UNIFORM_ITEM_CODE_PREFIX = '8000';

/**
 * สถานะใบขอเบิกยูนิฟอร์ม — เก็บแยกใน dbo.uniform_request_status (ผูกด้วย request_id)
 * ไม่เพิ่มคอลัมน์ใน dbo.stock_request เพราะตารางนั้นเป็นของระบบสาขา (Narai-branch)
 * ไม่มีแถวในตารางสถานะ = ยังรออนุมัติ ; กดย้อนกลับเป็น "รออนุมัติ" = ลบแถวทิ้ง
 */
export const UNIFORM_REQUEST_STATUS = {
  pending: 'รออนุมัติ',
  waiting_order: 'อนุมัติแล้ว · รอสั่งสินค้า',
  shipping: 'อนุมัติแล้ว · กำลังจัดส่ง',
};
const STATUS_TABLE = 'dbo.uniform_request_status';

const bad = (msg) => Object.assign(new Error(msg), { badRequest: true });

/**
 * @param db.q  ยิง query: (text, params) => rows
 * คืน: readUniformBranch / readUniformRequests
 */
export function createUniform({ q }) {
  // ผังคอลัมน์เปลี่ยนก็ต่อเมื่อมีคน ALTER TABLE — จำไว้สั้น ๆ พอ
  let cache = { at: 0, layout: null };

  async function readLayout() {
    if (cache.layout && Date.now() - cache.at < 5 * 60 * 1000) return cache.layout;

    const cols = await q(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'UniformBranch'
      ORDER BY ORDINAL_POSITION`);

    if (!cols.length) {
      throw new Error(
        `ไม่พบตาราง ${UNIFORM_TABLE} ในฐานข้อมูล — ตรวจว่าต่อไปฐานถูกตัวไหม ` +
        'และ login ที่ใช้มีสิทธิ์เห็นตารางนี้หรือยัง');
    }

    const usable = cols.filter((c) => !SKIP_TYPES.has(String(c.DATA_TYPE).toLowerCase()));
    const columns = usable.map((c) => {
      const type = String(c.DATA_TYPE).toLowerCase();
      return {
        name: c.COLUMN_NAME,
        type,
        kind: DATE_TYPES.has(type) ? 'date' : NUMBER_TYPES.has(type) ? 'number' : 'text',
      };
    });

    const byKey = new Map(columns.map((c) => [key(c.name), c]));
    const taken = new Set();
    const fields = {};
    Object.entries(UNIFORM_COLUMNS).forEach(([field, aliases]) => {
      const hit = aliases.map((a) => byKey.get(key(a))).find((c) => c && !taken.has(c.name));
      if (!hit) return;
      // จับคู่ผิดตัวก็ไม่พัง — เป็นแค่ค่าเริ่มต้นของตัวเลือกบนหน้าเว็บ ผู้ใช้เปลี่ยนเองได้
      fields[field] = hit.name;
      taken.add(hit.name);
    });

    const dateCol = columns.find((c) => c.name === fields.date);
    // มีวันที่ = ใหม่ก่อน ; ไม่มี = เรียงตามคอลัมน์แรก (มักเป็นเลขที่แถว) ถอยหลัง
    const orderBy = dateCol
      ? `${bracket(dateCol.name)} DESC`
      : `${bracket(columns[0].name)} DESC`;

    const layout = {
      columns,
      fields,
      orderBy,
      skipped: cols.filter((c) => SKIP_TYPES.has(String(c.DATA_TYPE).toLowerCase())).map((c) => c.COLUMN_NAME),
    };
    cache = { at: Date.now(), layout };
    return layout;
  }

  /**
   * แถวทั้งหมด (ไม่เกิน limit) ครบทุกคอลัมน์ — สรุปรายสาขา/รายการ/ไซส์ทำที่หน้าเว็บ
   * เพราะผู้ใช้เปลี่ยนคอลัมน์ที่ใช้จัดกลุ่มได้ ไม่ต้องยิงฐานซ้ำทุกครั้งที่เปลี่ยน
   */
  async function readUniformBranch({ limit } = {}) {
    const layout = await readLayout();
    const cap = Math.min(Math.max(Number(limit) || UNIFORM_DEFAULT_LIMIT, 1), UNIFORM_MAX_LIMIT);

    const select = layout.columns.map((c) => bracket(c.name)).join(', ');
    const [countRow] = await q(`SELECT COUNT(*) AS n FROM ${UNIFORM_TABLE}`);
    const raw = await q(`SELECT TOP (${cap}) ${select} FROM ${UNIFORM_TABLE} ORDER BY ${layout.orderBy}`);

    const typeOf = new Map(layout.columns.map((c) => [c.name, c.type]));
    const rows = raw.map((r) => {
      const out = {};
      Object.entries(r).forEach(([k, v]) => {
        if (v instanceof Date) out[k] = dateText(v, typeOf.get(k));
        else if (typeof v === 'string') out[k] = v.trim();
        else if (typeof v === 'bigint') out[k] = Number(v);
        else out[k] = v;
      });
      return out;
    });

    const total = Number(countRow?.n) || rows.length;
    return {
      rows,
      total,
      truncated: total > rows.length,
      limit: cap,
      layout: {
        table: UNIFORM_TABLE,
        columns: layout.columns,
        fields: layout.fields,
        skipped: layout.skipped,
      },
    };
  }

  /* ตารางสถานะมีหรือยัง — จำไว้เมื่อมีแล้ว (ตารางไม่หายไปเอง) ยังไม่มีถามใหม่ทุกครั้ง */
  let statusReady = false;
  async function hasStatusTable() {
    if (statusReady) return true;
    const [r] = await q(`SELECT CASE WHEN OBJECT_ID('${STATUS_TABLE}', 'U') IS NULL THEN 0 ELSE 1 END AS ok`);
    statusReady = Number(r?.ok) === 1;
    return statusReady;
  }

  /** สร้างตารางสถานะตอนกดอนุมัติครั้งแรก — สคริปต์เดียวกับ docs/schema-uniform-request-status.sql */
  async function ensureStatusTable() {
    if (await hasStatusTable()) return;
    await q(`
      IF OBJECT_ID('${STATUS_TABLE}', 'U') IS NULL
      CREATE TABLE ${STATUS_TABLE} (
        request_id  BIGINT        NOT NULL PRIMARY KEY,
        status      NVARCHAR(20)  NOT NULL,
        updated_by  NVARCHAR(100) NULL,
        updated_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_uniform_request_status_updated_at DEFAULT SYSDATETIME()
      )`);
    statusReady = true;
  }

  /**
   * ใบขอเบิกยูนิฟอร์มของสาขา — ตารางเดียวกับที่หน้า "นับสต๊อกและขอเบิก" ของสาขาเขียนลง
   * (dbo.stock_request: branch · item_key · qty · requester · saved_at) ผูกชื่อ/รหัสจาก dbo.stock_item
   * เอาเฉพาะแถวที่ขอจริง (qty > 0) — ตอนกดบันทึกใบเบิก ไอเทมที่ไม่ได้ขอก็ถูกบันทึกเป็น 0 ด้วย
   */
  async function readUniformRequests({ limit } = {}) {
    const cap = Math.min(Math.max(Number(limit) || UNIFORM_DEFAULT_LIMIT, 1), UNIFORM_MAX_LIMIT);
    const withStatus = await hasStatusTable();
    const rows = await q(`
      SELECT TOP (${cap}) r.request_id, r.branch, r.item_key, i.item_code, i.item_name, i.unit,
             r.qty, r.requester, CONVERT(nvarchar(16), r.saved_at, 120) AS saved_text
             ${withStatus ? `, s.status, s.updated_by, CONVERT(nvarchar(16), s.updated_at, 120) AS status_text` : ''}
        FROM dbo.stock_request r
        LEFT JOIN dbo.stock_item i ON i.item_key = r.item_key
        ${withStatus ? `LEFT JOIN ${STATUS_TABLE} s ON s.request_id = r.request_id` : ''}
       WHERE r.qty > 0
         AND (r.item_key IN (SELECT DISTINCT CONVERT(nvarchar(100), item_key)
                               FROM ${UNIFORM_TABLE} WHERE item_key IS NOT NULL)
              OR i.item_code LIKE @prefix)
       ORDER BY r.request_id DESC`, { prefix: `${UNIFORM_ITEM_CODE_PREFIX}%` });

    return {
      rows: rows.map((r) => ({
        requestId: Number(r.request_id) || 0,
        branch: String(r.branch ?? '').trim().toUpperCase(),
        itemKey: String(r.item_key ?? '').trim(),
        itemCode: String(r.item_code ?? r.item_key ?? '').trim(),
        itemName: String(r.item_name ?? '').trim(),
        unit: String(r.unit ?? '').trim(),
        qty: Number(r.qty) || 0,
        requester: String(r.requester ?? '').trim(),
        savedAt: String(r.saved_text ?? '').trim(),
        status: UNIFORM_REQUEST_STATUS[String(r.status ?? '').trim()] ? String(r.status).trim() : 'pending',
        statusBy: String(r.updated_by ?? '').trim(),
        statusAt: String(r.status_text ?? '').trim(),
      })),
      limit: cap,
      truncated: rows.length >= cap,
      itemCodePrefix: UNIFORM_ITEM_CODE_PREFIX,
    };
  }

  /**
   * ตั้งสถานะใบขอเบิก (ทีละหลายใบได้) — { requestIds: [..], status, by }
   * status = pending | waiting_order | shipping
   */
  async function setUniformRequestStatus(body = {}) {
    const status = String(body.status ?? '').trim();
    if (!UNIFORM_REQUEST_STATUS[status]) throw bad(`สถานะ "${status}" ไม่ถูกต้อง`);
    const ids = [...new Set((Array.isArray(body.requestIds) ? body.requestIds : [body.requestId])
      .map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw bad('ต้องระบุใบขอเบิกอย่างน้อยหนึ่งใบ');
    if (ids.length > 1000) throw bad('ตั้งสถานะได้ครั้งละไม่เกิน 1000 ใบ');
    const by = String(body.by ?? '').trim().slice(0, 100) || null;

    await ensureStatusTable();
    for (const id of ids) {
      if (status === 'pending') {
        await q(`DELETE FROM ${STATUS_TABLE} WHERE request_id = @id`, { id });
      } else {
        await q(`
          UPDATE ${STATUS_TABLE} SET status = @status, updated_by = @by, updated_at = SYSDATETIME()
           WHERE request_id = @id;
          IF @@ROWCOUNT = 0
            INSERT INTO ${STATUS_TABLE} (request_id, status, updated_by) VALUES (@id, @status, @by);`,
        { id, status, by });
      }
    }
    return { requestIds: ids, status, label: UNIFORM_REQUEST_STATUS[status] };
  }

  return { readUniformBranch, readUniformRequests, actions: { setUniformRequestStatus } };
}
