// วัตถุดิบที่ "มีอยู่จริงในข้อมูลที่ใช้งานอยู่" แต่ยังไม่มีในทะเบียนวัตถุดิบ
// ไว้ให้หน้า QC/RD > วัตถุดิบ หยิบมาเพิ่มเข้าทะเบียนได้ทีเดียว ไม่ต้องพิมพ์รหัส/ชื่อเอง
//
// ทุกต้นทางอยู่ในฐาน InventoryNarai ฐานเดียวกับทะเบียนวัตถุดิบ (dbo.stock_item)
// จึงอ่านจากการเชื่อมต่อเดิมได้เลย ไม่ต้องข้ามฐานเหมือนฝั่งเมนู (lib/menuSourceSql.mjs):
//
//   bom     dbo.qcrd_bom      วัตถุดิบที่สูตรในหน้าเมนูใช้อยู่จริง  ← ค่าเริ่มต้น
//   plan    dbo.stock_plan    ของที่สาขาสั่งจริงในแพลนสั่งของ
//   closing dbo.stock_closing ของที่สาขานับ/ปิดยอดจริงตอนสิ้นเดือน
//
// ทั้งสามตารางเก็บ item_key (รหัสที่ตัด 0 นำหน้า) ไว้จับคู่กับ stock_item อยู่แล้ว
// จึงคัดเฉพาะรหัสที่ "ไม่มีในทะเบียน" ด้วย NOT EXISTS ที่ฝั่ง SQL — ไม่ลากทั้งตารางกลับมาให้
// หน้าเว็บกรองเอง (stock_plan มีหลักหมื่นแถว และทางกลับต้องผ่าน tunnel ของเครื่องที่ร้าน)
//
// ⚠️ โหมดชีท (QCRD_SOURCE=sheet) ทะเบียนตัวจริงคือชีท item ไม่ใช่ stock_item
//    ตัวกรองนี้จึงเป็นแค่ตัวช่วยคร่าว ๆ ในโหมดนั้น — หน้าเว็บกรองซ้ำด้วยรายการที่โหลดมาจริงอีกชั้น

/** ทะเบียนต้นทาง — ชื่อตารางในนี้เท่านั้นที่ถูกต่อเข้าไปในคำสั่ง SQL ค่าที่ผู้ใช้พิมพ์เป็นพารามิเตอร์ล้วน */
export const ITEM_SOURCES = [
  {
    id: 'bom',
    label: 'สูตรเมนู',
    table: 'qcrd_bom',
    note: 'วัตถุดิบที่สูตรในหน้าเมนูใช้อยู่ แต่ยังไม่มีในทะเบียน',
    codeCol: 'item_code',
    nameCol: 'item_name',
  },
  {
    id: 'plan',
    label: 'แพลนสั่งของ',
    table: 'stock_plan',
    note: 'ของที่สาขาสั่งจริง แต่ยังไม่มีในทะเบียน',
    codeCol: 'item_code',
    nameCol: 'item_name',
  },
  {
    id: 'closing',
    label: 'ปิดรอบสิ้นเดือน',
    table: 'stock_closing',
    note: 'ของที่สาขานับและปิดยอดจริง แต่ยังไม่มีในทะเบียน',
    codeCol: 'item_code',
    nameCol: 'item_name',
  },
];

export const findItemSource = (id) => ITEM_SOURCES.find(s => s.id === String(id || '').trim()) || null;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** DATE จาก mssql -> 'YYYY-MM-DD' (คืนมาเป็น Date ที่ตั้งเป็น UTC เที่ยงคืน) */
function ymd(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}`;
  }
  return String(value).slice(0, 10);
}

/** เงื่อนไข "ยังไม่มีในทะเบียนวัตถุดิบ" — ใช้ร่วมกันทุกต้นทาง */
const notInRegistry = (alias) =>
  `NOT EXISTS (SELECT 1 FROM dbo.stock_item i WHERE i.item_key = ${alias}.item_key)`;

/**
 * คำสั่งค้นของแต่ละต้นทาง
 *   bom     รวมตามรหัส เอาชื่อ/converter/ราคาล่าสุดที่บันทึกไว้ในสูตร + นับว่าใช้ในกี่เมนู
 *   plan    แถวล่าสุดของรหัสนั้น (หน่วย/ราคาที่สั่งครั้งหลังสุด) + นับว่าสั่งมากี่ครั้ง
 *   closing แถวล่าสุดของรหัสนั้น (หน่วย/มูลค่าต่อหน่วยที่ปิดยอดครั้งหลังสุด)
 * ทุกตัวคืนคอลัมน์ชุดเดียวกัน หน้าเว็บจึงแสดงผลด้วยโค้ดชุดเดียว
 */
function buildQuery(src, { top, keyword }) {
  const kw = keyword ? ` AND (s.${src.codeCol} LIKE @kw OR s.${src.nameCol} LIKE @kw)` : '';

  if (src.id === 'bom') {
    return `
      SELECT TOP (${top})
             s.item_key                       AS [key],
             MIN(s.item_code)                 AS code,
             MAX(s.item_name)                 AS name,
             NULL                             AS unit,
             MAX(s.item_price)                AS price,
             MAX(s.converter)                 AS converter,
             MAX(s.tag)                       AS item_type,
             COUNT(DISTINCT s.menu_code)      AS uses,
             NULL                             AS seen
        FROM dbo.qcrd_bom s
       WHERE LTRIM(RTRIM(s.item_key)) <> '' AND ${notInRegistry('s')}${kw}
       GROUP BY s.item_key
       ORDER BY COUNT(DISTINCT s.menu_code) DESC, MIN(s.item_code)`;
  }

  // plan / closing — โครงเดียวกัน ต่างแค่คอลัมน์วันที่/ราคา
  const dateCol = src.id === 'plan' ? 'order_date' : 'close_date';
  const priceCol = src.id === 'plan' ? 'unit_price' : 'unit_value';
  return `
    WITH cand AS (
      SELECT s.item_key, s.item_code, s.item_name, s.unit,
             s.${priceCol} AS price, s.${dateCol} AS seen,
             ROW_NUMBER() OVER (PARTITION BY s.item_key
                                ORDER BY s.${dateCol} DESC, s.updated_at DESC) AS rn,
             COUNT(*)    OVER (PARTITION BY s.item_key) AS uses
        FROM dbo.${src.table} s
       WHERE LTRIM(RTRIM(s.item_key)) <> '' AND ${notInRegistry('s')}${kw}
    )
    SELECT TOP (${top})
           item_key AS [key], item_code AS code, item_name AS name, unit, price,
           NULL AS converter, NULL AS item_type, uses, seen
      FROM cand
     WHERE rn = 1
     ORDER BY seen DESC, item_code`;
}

/** จำนวนรหัสที่ยังไม่มีในทะเบียนของต้นทางนั้น — ไว้ขึ้นบนแท็บว่าเหลือให้เพิ่มกี่ตัว */
const countQuery = (src) => `
  SELECT COUNT(*) AS n FROM (
    SELECT DISTINCT s.item_key
      FROM dbo.${src.table} s
     WHERE LTRIM(RTRIM(s.item_key)) <> '' AND ${notInRegistry('s')}
  ) x`;

/**
 * ตัวอ่านต้นทางวัตถุดิบ — รับ q (ตัวยิงคำสั่ง) มาจากผู้เรียกเหมือน createQcrd/createMenuSource
 * ฝั่ง host-server ส่ง q ของ pool InventoryNarai มา ฝั่ง Vercel ส่ง runQuery ของ lib/qcrdPool
 */
export function createItemSource({ q }) {
  /** ตารางนั้นมีอยู่จริงไหม — ไม่มี = บอกชื่อไปตรง ๆ ดีกว่าปล่อย error ดิบว่า Invalid object name */
  async function ensureTable(src) {
    const rows = await q('SELECT OBJECT_ID(@t) AS id', { t: `dbo.${src.table}` });
    if (!rows[0]?.id) {
      throw new Error(`ไม่พบตาราง dbo.${src.table} ในฐานนี้ — ต้องรัน docs/schema-qcrd.sql / docs/schema-sheets.sql ก่อน`);
    }
  }

  /** ต้นทางไหนอ่านได้บ้าง + เหลือให้เพิ่มกี่ตัว (ต้นทางเดียวล้ม ไม่ทำให้ตัวอื่นพัง) */
  async function schema() {
    // เหมือนฝั่งเมนู: ต้องแยก "ต่อฐานไม่ได้" ออกจาก "ต้นทางนี้มีปัญหา" ไม่งั้นตอนต่อ SQL ตรงไม่ติด
    // จะได้ ok:false ทั้งแถวแล้ว "สำเร็จ" กลับไป ผู้เรียกไม่รู้ว่าต้องถอยไปทาง host API
    await q('SELECT 1 AS ok');

    return Promise.all(ITEM_SOURCES.map(async (src) => {
      const base = { id: src.id, label: src.label, note: src.note, table: `dbo.${src.table}` };
      try {
        await ensureTable(src);
        const rows = await q(countQuery(src));
        return { ...base, ok: true, missing: Number(rows[0]?.n) || 0 };
      } catch (err) {
        return { ...base, ok: false, error: err.message };
      }
    }));
  }

  /** ค้นวัตถุดิบในต้นทางหนึ่ง — ค้นที่ฝั่ง SQL เสมอ */
  async function search(srcId, { q: keyword = '', limit = 50 } = {}) {
    const src = findItemSource(srcId);
    if (!src) throw Object.assign(new Error(`ไม่รู้จักต้นทาง ${srcId}`), { badRequest: true });
    await ensureTable(src);

    const top = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const kw = String(keyword || '').trim();
    const params = kw ? { kw: `%${kw}%` } : {};
    const rows = await q(buildQuery(src, { top, keyword: kw }), params);

    return {
      source: { id: src.id, label: src.label, note: src.note, table: `dbo.${src.table}` },
      rows: rows.map(r => ({
        key: str(r.key),
        code: str(r.code) || str(r.key),
        name: str(r.name),
        unit: str(r.unit),
        price: numOrNull(r.price),
        converter: numOrNull(r.converter),
        itemType: str(r.item_type),
        uses: Number(r.uses) || 0,
        seen: ymd(r.seen),
      })),
      limited: rows.length >= top,   // ชนเพดาน = ยังมีอีก ให้พิมพ์ค้นให้แคบลง
    };
  }

  return { schema, search };
}
