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
// UniformBranch ดูอย่างเดียว ; คำขอเบิก (dbo.UniformRequest) ออฟฟิศเปลี่ยนสถานะ/ออกใบเบิกได้

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
 * คำขอเบิกยูนิฟอร์ม — dbo.UniformRequest (สร้างจาก docs/schema-uniform.sql ของรีโป Narai-branch)
 * สาขาส่งคำขอ (pending) -> ออฟฟิศกดที่นี่ -> สาขากด "ได้รับของแล้ว" (received)
 * คีย์ต้องตรงกับ UNIFORM_REQUEST_STATUS ใน office-server/uniform.js ของ Narai-branch
 */
export const UNIFORM_REQUEST_STATUS = {
  pending: 'กำลังรออนุมัติ',
  waiting_stock: 'รอสินค้าเข้า',
  approved: 'อนุมัติเบิก',
  shipping: 'กำลังรอจัดส่ง',
  received: 'ได้รับของแล้ว',
};

/** ออฟฟิศตั้งสถานะไหนได้ จากสถานะไหน — received เป็นของสาขาเท่านั้น */
const STATUS_FROM = {
  pending: ['waiting_stock'],                 // ยกเลิก "รอสินค้าเข้า" กลับไปรออนุมัติ
  waiting_stock: ['pending'],
  approved: ['pending', 'waiting_stock'],     // เปลี่ยนสถานะอย่างเดียว ยังไม่ส่งคลัง
  shipping: ['approved'],                     // ส่งใบเบิกไปคลัง (ลง dbo.stock_request) ตอนนี้
};
const REQUEST_TABLE = 'dbo.UniformRequest';

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

  /* ตาราง dbo.UniformRequest สร้างจากฝั่งสาขา (Narai-branch) — ยังไม่มีให้บอกวิธีสร้าง ไม่ใช่ error ดิบ */
  let requestReady = false;
  async function requireRequestTable() {
    if (requestReady) return;
    const [r] = await q(`SELECT CASE WHEN OBJECT_ID('${REQUEST_TABLE}', 'U') IS NULL THEN 0 ELSE 1 END AS ok`);
    if (Number(r?.ok) !== 1) {
      throw new Error(`ยังไม่มีตาราง ${REQUEST_TABLE} — ที่เครื่องออฟฟิศ โฟลเดอร์ Narai-branch/office-server ` +
        'รัน node scripts/setup-uniform-db.mjs (ไม่มีสิทธิ์สร้างตารางให้ใส่ --user=sa --password=...)');
    }
    requestReady = true;
  }

  /** คำขอเบิกยูนิฟอร์มจากทุกสาขา ใหม่ก่อน */
  async function readUniformRequests({ limit } = {}) {
    await requireRequestTable();
    const cap = Math.min(Math.max(Number(limit) || UNIFORM_DEFAULT_LIMIT, 1), UNIFORM_MAX_LIMIT);
    const rows = await q(`
      SELECT TOP (${cap}) request_id, branch, hr_code, emp_name, item_key, item_code, item_name, unit, qty,
             want_date, status, doc_no, requested_by, status_by, received_by,
             CONVERT(nvarchar(16), requested_at, 120) AS requested_text,
             CONVERT(nvarchar(16), status_at, 120)    AS status_text,
             CONVERT(nvarchar(16), received_at, 120)  AS received_text
        FROM ${REQUEST_TABLE}
       ORDER BY request_id DESC`);

    const t = (v) => String(v ?? '').trim();
    return {
      rows: rows.map((r) => ({
        requestId: Number(r.request_id) || 0,
        branch: t(r.branch).toUpperCase(),
        hrCode: t(r.hr_code),
        requester: t(r.emp_name),
        itemKey: t(r.item_key),
        itemCode: t(r.item_code) || t(r.item_key),
        itemName: t(r.item_name),
        unit: t(r.unit),
        qty: Number(r.qty) || 0,
        wantDate: t(r.want_date),
        savedAt: t(r.requested_text),
        requestedBy: t(r.requested_by),
        status: UNIFORM_REQUEST_STATUS[t(r.status)] ? t(r.status) : 'pending',
        statusBy: t(r.status_by),
        statusAt: t(r.status_text),
        docNo: t(r.doc_no),
        receivedBy: t(r.received_by),
        receivedAt: t(r.received_text),
      })),
      limit: cap,
      truncated: rows.length >= cap,
    };
  }

  /**
   * กำลังรอจัดส่ง = ส่งใบเบิกไปคลัง (ลง dbo.stock_request) ใบละ 1 พนักงาน (สาขาเดียวกัน)
   * เหมือนตอนสาขากดสั่งของในหน้านับสต๊อกและขอเบิก — โกดังเห็นในใบเบิกชุดเดียวกัน
   * เลขที่ใบเบิกรูปแบบเดียวกับ saveStock ของ Narai-branch: 3 ตัวแรกของสาขา + ปี 2 หลัก + เดือน + ลำดับ 3 หลัก
   * (CRM2610001) คิดเดือน/ปีจากเวลาของ SQL Server (เครื่องออฟฟิศ) ไม่ใช่ของ Vercel ที่เป็น UTC
   * แยกใบตามพนักงานเพราะ stock_request ห้าม doc_no + item_key ซ้ำ และใบเบิกมีช่องผู้ขอได้คนเดียว
   * ทั้งใบอยู่ใน transaction เดียว — UPDLOCK/HOLDLOCK กันสองคนกดพร้อมกันได้เลขซ้ำหรืออนุมัติซ้ำ
   */
  async function shipGroup(branch, ids, by) {
    const params = { branch, by };
    const list = ids.map((id, i) => { params[`id${i}`] = id; return `@id${i}`; }).join(', ');
    const [r] = await q(`
      SET NOCOUNT ON; SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @ids TABLE (id INT PRIMARY KEY);
      INSERT INTO @ids (id)
        SELECT request_id FROM ${REQUEST_TABLE} WITH (UPDLOCK, HOLDLOCK)
         WHERE request_id IN (${list}) AND branch = @branch AND status = N'approved';
      IF NOT EXISTS (SELECT 1 FROM @ids)
      BEGIN
        COMMIT;
        SELECT CAST(NULL AS nvarchar(50)) AS doc_no, 0 AS n;
        RETURN;
      END
      DECLARE @now DATETIME2(0) = SYSDATETIME();
      DECLARE @prefix NVARCHAR(20) = UPPER(LEFT(@branch, 3))
        + RIGHT(CONVERT(nvarchar(4), YEAR(@now)), 2) + RIGHT(N'0' + CONVERT(nvarchar(2), MONTH(@now)), 2);
      DECLARE @next INT = (
        SELECT ISNULL(MAX(TRY_CONVERT(INT, SUBSTRING(doc_no, LEN(@prefix) + 1, 10))), 0) + 1
          FROM dbo.stock_request WITH (UPDLOCK, HOLDLOCK)
         WHERE branch = @branch AND doc_no LIKE @prefix + N'%');
      DECLARE @doc NVARCHAR(50) = @prefix
        + CASE WHEN @next < 1000 THEN RIGHT(N'00' + CONVERT(nvarchar(10), @next), 3) ELSE CONVERT(nvarchar(10), @next) END;
      INSERT INTO dbo.stock_request (doc_no, saved_at, branch, item_key, item_code, item_name, unit, qty, request_date, requester)
        SELECT @doc, @now, @branch, u.item_key, MAX(u.item_code), MAX(u.item_name), MAX(u.unit),
               SUM(u.qty), MAX(u.want_date), MAX(u.emp_name)
          FROM ${REQUEST_TABLE} u JOIN @ids i ON i.id = u.request_id
         GROUP BY u.item_key;
      UPDATE u SET status = N'shipping', doc_no = @doc, status_by = @by, status_at = @now
        FROM ${REQUEST_TABLE} u JOIN @ids i ON i.id = u.request_id;
      COMMIT;
      SELECT @doc AS doc_no, (SELECT COUNT(*) FROM @ids) AS n;`, params);
    return { docNo: r?.doc_no ? String(r.doc_no) : '', count: Number(r?.n) || 0 };
  }

  /**
   * ตั้งสถานะคำขอ (ทีละหลายรายการได้) — { requestIds: [..], status, by }
   * แถวที่สถานะปัจจุบันไม่อยู่ใน STATUS_FROM ของสถานะใหม่จะถูกข้าม (เช่นมีคนกดไปก่อนแล้ว)
   */
  async function setUniformRequestStatus(body = {}) {
    const status = String(body.status ?? '').trim();
    if (!STATUS_FROM[status]) throw bad(`สถานะ "${status}" ไม่ถูกต้อง`);
    const ids = [...new Set((Array.isArray(body.requestIds) ? body.requestIds : [body.requestId])
      .map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw bad('ต้องระบุคำขออย่างน้อยหนึ่งรายการ');
    if (ids.length > 500) throw bad('ตั้งสถานะได้ครั้งละไม่เกิน 500 รายการ');
    const by = String(body.by ?? '').trim().slice(0, 100) || null;
    await requireRequestTable();

    const params = {};
    const list = ids.map((id, i) => { params[`id${i}`] = id; return `@id${i}`; }).join(', ');
    const from = STATUS_FROM[status].map((st) => `N'${st}'`).join(', ');

    if (status === 'shipping') {
      const rows = await q(`
        SELECT request_id, branch, hr_code FROM ${REQUEST_TABLE}
         WHERE request_id IN (${list}) AND status IN (${from})`, params);
      const groups = new Map();
      rows.forEach((r) => {
        const k = `${r.branch}\u0000${r.hr_code}`;
        const g = groups.get(k) || { branch: String(r.branch), ids: [] };
        g.ids.push(Number(r.request_id));
        groups.set(k, g);
      });
      const docs = [];
      let count = 0;
      for (const g of groups.values()) {
        const out = await shipGroup(g.branch, g.ids, by);
        if (out.docNo) docs.push(out.docNo);
        count += out.count;
      }
      if (!count) throw bad('ไม่มีรายการที่ส่งไปคลังได้ (อาจมีคนกดไปก่อนแล้ว — ลองโหลดใหม่)');
      return { status, label: UNIFORM_REQUEST_STATUS[status], count, docs };
    }

    const out = await q(`
      SET NOCOUNT ON;
      UPDATE ${REQUEST_TABLE} SET status = @status, status_by = @by, status_at = SYSDATETIME()
       WHERE request_id IN (${list}) AND status IN (${from});
      SELECT @@ROWCOUNT AS n;`, { ...params, status, by });
    const count = Number(out[0]?.n) || 0;
    if (!count) throw bad('ไม่มีรายการที่เปลี่ยนสถานะได้ (อาจมีคนกดไปก่อนแล้ว — ลองโหลดใหม่)');
    return { status, label: UNIFORM_REQUEST_STATUS[status], count, docs: [] };
  }

  return { readUniformBranch, readUniformRequests, actions: { setUniformRequestStatus } };
}
