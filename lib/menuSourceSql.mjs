// ทะเบียนเมนูของ POS ฐานอื่น — ไว้ให้หน้า QC/RD > เมนู หยิบมาเพิ่มเข้าทะเบียนหลัก
//
// สามต้นทาง อยู่บน SQL Server เครื่องเดียวกับ InventoryNarai (NARAI-PIZZARIA\SQLEXPRESS)
// จึงอ่านข้ามฐานด้วยชื่อสามท่อน [ฐาน].[dbo].[ตาราง] จากการเชื่อมต่อเดิมได้เลย ไม่ต้องเปิด pool ใหม่:
//
//   Aoringo   > dbo.MenuItem   รหัสที่บันทึกลงทะเบียนหลักเติม 'AO' นำหน้า
//   HumlaiPOS > dbo.Menu       เติม 'HM' นำหน้า
//   NaraiPos  > dbo.Item       ใช้รหัสเดิม ไม่เติมอะไร (เป็น POS ของนารายณ์เอง)
//
// ⚠️ ทำไมไม่ฮาร์ดโค้ดชื่อคอลัมน์: ทั้งสามฐานเป็นของคนละแอป ไม่มีใครรับประกันว่าคอลัมน์รหัส
//    ชื่อว่า Code เหมือนกันหมด และเดาผิดจะได้ตารางว่างเปล่าแบบไม่มีอะไรฟ้อง (อาการเดียวกับ
//    เคส {"data":[]} ที่เสียเวลาไล่กันทั้งเช้า) จึงอ่าน INFORMATION_SCHEMA ตอนรันแล้วจับคู่
//    ชื่อคอลัมน์จากรายการที่เป็นไปได้ เหมือนที่ lib/aoringoSql.mjs ทำกับฐานเฟรนไชส์
//    และเปิดผลการจับคู่ออกทาง /qcrd/menu-source-schema ให้ตรวจด้วยตาได้ว่าจับถูกตัวไหม
//
// ⚠️ ทุกชื่อฐาน/ตาราง/คอลัมน์ที่เอาไปต่อเป็นคำสั่ง SQL ต้องมาจากทะเบียนในไฟล์นี้หรือจาก
//    INFORMATION_SCHEMA เท่านั้น (ผ่าน safeIdent อีกชั้น) ค่าที่ผู้ใช้พิมพ์เข้ามาไปเป็น
//    พารามิเตอร์ล้วน — ตารางเหล่านี้เป็นฐานของจริงที่ร้าน พลาดทีเดียวไม่คุ้ม

const env = (k, fallback) => {
  const v = typeof process !== 'undefined' ? process.env?.[k] : '';
  return String(v || '').trim() || fallback;
};

/** ชื่อฐาน/ตาราง/คอลัมน์ที่ยอมให้ต่อเข้าไปในคำสั่ง — กันชื่อแปลก ๆ ตั้งแต่ต้นทาง */
const safeIdent = (name, what) => {
  const s = String(name || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`ชื่อ${what}ใช้ไม่ได้: ${name}`);
  return s;
};
const bracket = (name, what) => `[${safeIdent(name, what)}]`;

/**
 * ผู้สมัครของแต่ละช่อง เรียงจาก "น่าจะใช่ที่สุด" ไปหาน้อยสุด
 * เอาชื่อที่สื่อความหมายไว้ก่อนเสมอ แล้วค่อยตกไปที่คอลัมน์ id — เพราะรหัสที่คนใช้จริง
 * (Code/ItemCode) มีค่ามากกว่าเลข identity ที่ไม่มีใครจำได้ ถ้าจับได้แต่ id ก็ยังใช้งานได้
 * แต่รหัสเมนูที่บันทึกจะเป็นตัวเลขรันนิ่ง ซึ่งผู้ใช้เห็นก่อนกดบันทึกอยู่แล้ว
 */
const FIELDS = {
  code: ['Code', 'ItemCode', 'MenuCode', 'ProductCode', 'PLU', 'SKU', 'Barcode',
    'MenuItemCode', 'ItemNo', 'MenuId', 'MenuItemId', 'ItemId', 'ItemID', 'Id'],
  name: ['NameThai', 'ItemNameThai', 'Name', 'ItemName', 'MenuName', 'ProductName',
    'Name1', 'ItemName1', 'Title', 'Description', 'Descript', 'ItemDesc'],
  price: ['Price', 'UnitPrice', 'SalePrice', 'SellPrice', 'MenuPrice', 'ItemPrice',
    'DefaultPrice', 'Price1', 'PriceA', 'StdPrice'],
  // NaraiPos.dbo.Item เก็บรหัสหมวดเมนูไว้ที่ MenuCode ซึ่งตรงกับ qcrd_menu.group_code พอดี
  // (ทะเบียนเมนู QC/RD เดิมลอกมาจากตารางนี้ — ชีท menu คอลัมน์ C ก็คือคอลัมน์นี้)
  group: ['CategoryName', 'GroupName', 'MenuGroupName', 'ItemGroupName',
    'MenuCode', 'CategoryCode', 'GroupCode', 'MenuGroup', 'ItemGroup',
    'MainGrp', 'ItemGrp', 'ItmGrp', 'SubGrp', 'Category', 'CategoryId'],
  status: ['IsActive', 'Active', 'Enabled', 'IsEnabled', 'UseStatus', 'ItemStatus',
    'Status', 'IsDeleted', 'Deleted', 'IsDisabled', 'Disabled', 'Inactive'],
};

/** คอลัมน์สถานะที่ความหมาย "กลับด้าน" — ค่าจริง = ถูกปิด/ลบ ไม่ใช่ใช้งานอยู่ */
const NEGATIVE_STATUS = /^(isdeleted|deleted|isdisabled|disabled|inactive|isinactive)$/i;

/** ข้อความ/ตัวเลขที่แปลว่า "ไม่" — ครอบคลุมทั้งธง 0/1 และสถานะที่เก็บเป็นคำ */
const isFalsy = (v) => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v === 0;
  const s = String(v).trim();
  if (s === '') return false;
  return /^(0|n|no|f|false|inactive|disable[d]?|ปิด|ปิดการใช้งาน|ยกเลิก|ไม่ใช้|ไม่ใช้งาน)$/i.test(s);
};

/** ต้นทางทั้งหมด — ตั้งชื่อฐานทับได้ด้วย env เผื่อเครื่องไหนตั้งชื่อฐานไม่เหมือนกัน */
export function menuSources() {
  return [
    {
      id: 'aoringo',
      label: 'Aoringo',
      prefix: 'AO',
      db: env('AORINGO_DB_NAME', 'Aoringo'),
      table: env('AORINGO_MENU_TABLE', 'MenuItem'),
    },
    {
      id: 'humlai',
      label: 'HumlaiPOS',
      prefix: 'HM',
      db: env('HUMLAI_DB_NAME', 'HumlaiPOS'),
      table: env('HUMLAI_MENU_TABLE', 'Menu'),
    },
    {
      id: 'naraipos',
      label: 'NaraiPos',
      prefix: '',          // POS ของนารายณ์เอง — รหัสต้องตรงกับที่บิลส่งมา ห้ามเติมตัวนำหน้า
      db: env('POS_DB_NAME', env('DB_NAME', 'NaraiPos')),
      table: env('POS_MENU_TABLE', 'Item'),
    },
  ];
}

export const findSource = (id) => menuSources().find(s => s.id === String(id || '').trim());

/** รหัสที่จะบันทึกลงทะเบียนหลัก = ตัวนำหน้าของต้นทาง + รหัสต้นทาง */
export const withPrefix = (src, code) => `${src.prefix}${String(code ?? '').trim()}`;

/**
 * เลือกคอลัมน์ตัวแรกที่มีจริงในตาราง (เทียบแบบไม่สนตัวพิมพ์)
 * used = คอลัมน์ที่ช่องก่อนหน้าจองไปแล้ว ห้ามหยิบซ้ำ — ชื่ออย่าง MenuCode อยู่ในรายการของทั้ง
 * ช่อง "รหัส" และช่อง "หมวด" ถ้าไม่กันไว้ ตารางที่มีแต่ MenuCode จะเอาคอลัมน์เดียวไปเป็นสองช่อง
 */
function pickColumn(columns, candidates, used = new Set()) {
  const lower = new Map(columns.map(c => [c.toLowerCase(), c]));
  for (const cand of candidates) {
    const key = cand.toLowerCase();
    if (used.has(key)) continue;
    const hit = lower.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * ตัวอ่านทะเบียนเมนูของต้นทาง — รับ q (ตัวยิงคำสั่ง) มาจากผู้เรียก
 * ฝั่ง host-server ส่ง q ของ pool InventoryNarai มา ส่วนฝั่ง Vercel ส่ง runQuery ของ lib/qcrdPool
 * ตรรกะจึงเป็นชุดเดียวกันทั้งสองทาง ไม่ต้องมีสองสำเนาให้แก้ตามกัน
 */
export function createMenuSource({ q }) {
  const schemaCache = new Map();   // id -> ผลการจับคู่ (ฐานไม่ได้เปลี่ยนคอลัมน์ระหว่างวัน)

  /** อ่านคอลัมน์จริงของตารางต้นทาง แล้วจับคู่เข้ากับช่องที่หน้าเว็บต้องใช้ */
  async function detect(src, { fresh = false } = {}) {
    if (!fresh && schemaCache.has(src.id)) return schemaCache.get(src.id);

    const db = bracket(src.db, 'ฐานข้อมูล');
    const rows = await q(
      `SELECT COLUMN_NAME, DATA_TYPE
         FROM ${db}.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @t
        ORDER BY ORDINAL_POSITION`,
      { t: src.table }
    );
    if (!rows.length) {
      throw new Error(
        `ไม่พบตาราง ${src.db}.dbo.${src.table} (หรือ login นี้ไม่มีสิทธิ์อ่านฐาน ${src.db}) ` +
        `— ถ้าฐานนี้อยู่คนละ SQL instance ต้องต่อแยก ยังไม่รองรับทางนี้`
      );
    }

    const columns = rows.map(r => r.COLUMN_NAME);
    const map = {};
    const used = new Set();   // ช่องที่จองคอลัมน์ไปแล้ว (เรียง code → name → price → group → status)
    for (const [field, cands] of Object.entries(FIELDS)) {
      map[field] = pickColumn(columns, cands, used);
      if (map[field]) used.add(map[field].toLowerCase());
    }
    if (!map.code) throw new Error(`ตาราง ${src.db}.dbo.${src.table} หาคอลัมน์รหัสไม่เจอ (มี: ${columns.join(', ')})`);
    if (!map.name) throw new Error(`ตาราง ${src.db}.dbo.${src.table} หาคอลัมน์ชื่อเมนูไม่เจอ (มี: ${columns.join(', ')})`);

    const out = { ...src, columns, map, statusNegative: Boolean(map.status && NEGATIVE_STATUS.test(map.status)) };
    schemaCache.set(src.id, out);
    return out;
  }

  /** ผลการจับคู่ของทุกต้นทาง — ต้นทางไหนอ่านไม่ได้ก็บอกเหตุผลไป ไม่ทำให้ตัวอื่นพัง */
  async function schema({ fresh = false } = {}) {
    return Promise.all(menuSources().map(async (src) => {
      try {
        const s = await detect(src, { fresh });
        const count = await q(`SELECT COUNT_BIG(*) AS n FROM ${bracket(s.db, 'ฐานข้อมูล')}.[dbo].${bracket(s.table, 'ตาราง')}`);
        return {
          id: s.id, label: s.label, prefix: s.prefix, table: `${s.db}.dbo.${s.table}`,
          ok: true, rows: Number(count[0]?.n) || 0, map: s.map, columns: s.columns,
        };
      } catch (err) {
        return {
          id: src.id, label: src.label, prefix: src.prefix, table: `${src.db}.dbo.${src.table}`,
          ok: false, error: err.message,
        };
      }
    }));
  }

  /**
   * ค้นหาเมนูในต้นทางหนึ่ง — ค้นที่ฝั่ง SQL เสมอ ไม่ลากทั้งตารางกลับมาให้หน้าเว็บกรองเอง
   * (ตารางเมนูของ POS มีได้หลักพันแถว และทางกลับต้องผ่าน tunnel ของเครื่องที่ร้าน)
   */
  async function search(srcId, { q: keyword = '', limit = 50, includeInactive = false } = {}) {
    const src = findSource(srcId);
    if (!src) throw Object.assign(new Error(`ไม่รู้จักต้นทาง ${srcId}`), { badRequest: true });

    const s = await detect(src);
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const col = (f) => bracket(s.map[f], 'คอลัมน์');

    const cols = [
      `${col('code')} AS code`,
      `${col('name')} AS name`,
      s.map.price ? `${col('price')} AS price` : 'NULL AS price',
      s.map.group ? `${col('group')} AS [group]` : 'NULL AS [group]',
      s.map.status ? `${col('status')} AS status_raw` : 'NULL AS status_raw',
    ];

    const where = [`${col('code')} IS NOT NULL`, `LTRIM(RTRIM(${col('name')})) <> ''`];
    const params = {};
    const kw = String(keyword || '').trim();
    if (kw) {
      params.kw = `%${kw}%`;
      // รหัสบางฐานเป็นตัวเลข (int) ต่อ LIKE ตรง ๆ ไม่ได้ — แปลงเป็นข้อความก่อนเทียบ
      where.push(`(CAST(${col('code')} AS NVARCHAR(100)) LIKE @kw OR ${col('name')} LIKE @kw)`);
    }

    const rows = await q(
      `SELECT TOP (${n}) ${cols.join(', ')}
         FROM ${bracket(s.db, 'ฐานข้อมูล')}.[dbo].${bracket(s.table, 'ตาราง')}
        WHERE ${where.join(' AND ')}
        ORDER BY ${col('name')}`,
      params
    );

    const mapped = rows.map(r => {
      // ไม่มีคอลัมน์สถานะ หรือค่าว่าง = ถือว่าใช้งานอยู่ (ไม่ซ่อนของที่อาจยังขายอยู่)
      // คอลัมน์แบบกลับด้าน (IsDeleted/Disabled) ค่า "จริง" แปลว่าถูกปิด จึงสลับผลกัน
      const blank = r.status_raw === null || r.status_raw === undefined || String(r.status_raw).trim() === '';
      const falsy = isFalsy(r.status_raw);
      const active = (!s.map.status || blank) ? true : (s.statusNegative ? falsy : !falsy);
      return {
        code: String(r.code ?? '').trim(),
        newCode: withPrefix(src, r.code),
        name: String(r.name ?? '').trim(),
        price: r.price === null || r.price === undefined ? null : Number(r.price),
        group: r.group === null || r.group === undefined ? '' : String(r.group).trim(),
        active,
        statusRaw: r.status_raw === null || r.status_raw === undefined ? '' : String(r.status_raw).trim(),
      };
    });

    const kept = includeInactive ? mapped : mapped.filter(r => r.active);
    return {
      source: { id: s.id, label: s.label, prefix: s.prefix, table: `${s.db}.dbo.${s.table}`, map: s.map },
      rows: kept,
      hiddenInactive: mapped.length - kept.length,
      limited: rows.length >= n,   // ชนเพดาน = ยังมีอีก ให้ผู้ใช้พิมพ์ค้นให้แคบลง
    };
  }

  return { schema, search, detect };
}
