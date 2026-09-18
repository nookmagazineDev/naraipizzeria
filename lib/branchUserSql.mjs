// ผู้ใช้ฝั่งสาขา (narai_hr.dbo.hr_user) — ตรรกะฝั่ง SQL ที่ใช้ร่วมกันสองฝั่ง
//
// บัญชีพวกนี้คือที่สาขาใช้ล็อกอินเข้าระบบลงตารางงาน (โปรเจค Narai-branch)
// เดิมไม่มีหน้าจอจัดการเลย ต้องเปิด SSMS แล้ว UPDATE เอง — สภาพเดียวกับเป้ายอดสาขา
// ก่อนที่จะย้ายมา ตอนนี้แก้ได้จากหน้า HR > login สาขา ของแดชบอร์ดออฟฟิศ
//
// ⚠️ ตารางนี้อยู่คนละฐานกับตารางอื่นในโฟลเดอร์นี้ (narai_hr ไม่ใช่ InventoryNarai)
//    แต่อยู่บนอินสแตนซ์ SQL เดียวกัน จึงอ่าน/เขียนด้วยชื่อสามท่อนจากคอนเนกชันเดิมได้เลย
//    ไม่ต้องย้ายตาราง ไม่ต้องเปิด pool ที่สอง ไม่ต้องแตะโค้ดของ Narai-branch
//    ต้องให้สิทธิ์ข้ามฐานก่อน — docs/grant-hr-user.sql
//
// ⚠️⚠️ รหัสผ่านต้องเขียนด้วยรูปแบบของฝั่งตารางงาน (lib/hrUserHash.mjs) ไม่ใช่ของแดชบอร์ดนี้
//      คนที่ตรวจรหัสตอนสาขาล็อกอินคือ office-server ของอีกโปรเจค เขียนผิดรูปแบบ = ตั้งรหัสแล้ว
//      สาขาล็อกอินไม่ได้ และจะรู้ตัวตอนสาขาโทรมาเท่านั้น
//
// ⚠️ ห้ามคืน password_hash ออกไปจากไฟล์นี้เด็ดขาด ไม่ว่าทางไหน
import { hashHrPassword, validateHrPassword } from './hrUserHash.mjs';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const bad = (msg) => Object.assign(new Error(msg), { badRequest: true });

/** ชื่อฐานต้องเป็นตัวระบุล้วน ๆ — ค่านี้ถูกต่อเข้าไปในคำสั่งตรง ๆ (พารามิเตอร์ใช้แทนชื่อฐานไม่ได้) */
function safeDbName(name) {
  const n = str(name) || 'narai_hr';
  if (!/^[A-Za-z0-9_]{1,128}$/.test(n)) {
    throw new Error(`ชื่อฐานข้อมูลไม่ถูกต้อง: ${n} (ตั้ง HR_DB_NAME ให้เป็นตัวอักษร/ตัวเลข/ขีดล่างเท่านั้น)`);
  }
  return n;
}

/**
 * ช่อง "สาขา" ของบัญชีสาขา — เก็บได้หลายรหัสคั่นด้วยจุลภาค (เคสจริง: ผู้จัดการที่ดูแลสองร้าน
 * กรอกเป็น 'SUM, IPR') และมีค่าพิเศษ 'all' = เห็นได้ทุกสาขา
 * กติกาการแตกค่าต้องตรงกับ branchCodes() ใน Narai-branch/src/utils/branchAlias.js
 */
export const splitBranches = (v) =>
  str(v).toLowerCase().split(/[,/|;+&]+|\s+/).map((s) => s.trim()).filter(Boolean);

/** คืน '' ถ้าผ่าน หรือข้อความบอกสาเหตุ */
export function validateBranchField(v) {
  const codes = splitBranches(v);
  if (!codes.length) return 'ต้องระบุสาขาของบัญชีนี้ (หรือ all ถ้าให้เห็นทุกสาขา)';
  for (const c of codes) {
    if (c === 'all') continue;
    if (!/^[a-z0-9]{2,10}$/.test(c)) return `รหัสสาขา "${c}" ไม่ถูกต้อง — ต้องเป็นตัวอักษรอังกฤษหรือตัวเลข 2–10 ตัว`;
  }
  if (codes.length > 1 && codes.includes('all')) {
    return 'ใส่ all ปนกับรหัสสาขาอื่นไม่ได้ — all แปลว่าเห็นทุกสาขาอยู่แล้ว';
  }
  return '';
}

export function validateHrUsername(v) {
  const u = str(v);
  if (!u) return 'ต้องกรอกชื่อผู้ใช้';
  if (u.length > 100) return 'ชื่อผู้ใช้ยาวเกินไป (ไม่เกิน 100 ตัว)';
  if (/\s/.test(u)) return 'ชื่อผู้ใช้ต้องไม่มีช่องว่าง';
  return '';
}

/**
 * @param db.q     ยิง query: (text, params) => rows
 * @param db.hrDb  ชื่อฐานของระบบตารางงาน (ไม่ระบุ = narai_hr)
 */
export function createBranchUsers({ q, hrDb }) {
  const DB = safeDbName(hrDb || process.env.HR_DB_NAME);
  const TABLE = `${DB}.dbo.hr_user`;

  /* ไปถึงตารางได้ไหม — แคชยาวเมื่อเจอ สั้นเมื่อไม่เจอ (กติกาเดียวกับ lib/branchSql.mjs)
     ไม่เจอเกิดได้สองแบบ: ฐาน narai_hr ไม่มีบนอินสแตนซ์นี้ (เช่นรันจาก Vercel ที่ต่อคนละเครื่อง)
     หรือ login ที่ใช้อยู่ยังไม่ได้สิทธิ์ข้ามฐาน — ข้อความต้องบอกทั้งสองทาง ไม่งั้นไล่ผิดที่ */
  const READY_TTL_MS = 60 * 60 * 1000;
  const PENDING_TTL_MS = 30 * 1000;
  let cache = null;

  async function ready() {
    if (cache && Date.now() - cache.at < cache.ttl) return cache.value;
    const rows = await q(
      `SELECT CASE WHEN DB_ID(@db) IS NULL THEN 0 ELSE 1 END AS hasDb,
              CASE WHEN OBJECT_ID(@tbl, 'U') IS NULL THEN 0 ELSE 1 END AS hasTable`,
      { db: DB, tbl: TABLE }
    );
    const r = rows[0] || {};
    const value = { hasDb: Number(r.hasDb) === 1, hasTable: Number(r.hasTable) === 1 };
    cache = { at: Date.now(), ttl: value.hasTable ? READY_TTL_MS : PENDING_TTL_MS, value };
    return value;
  }

  async function requireTable() {
    const s = await ready();
    if (!s.hasDb) {
      throw bad(`ไม่พบฐาน ${DB} บนเครื่องที่ต่ออยู่ — ตารางผู้ใช้ฝั่งสาขาอยู่ที่เครื่องออฟฟิศ ` +
        'ต้องไปทางเครื่องนั้น (ตั้ง SHEETS_WRITE_KEY) ไม่ใช่ต่อ SQL ตรงจาก Vercel');
    }
    if (!s.hasTable) {
      throw bad(`มองไม่เห็นตาราง ${TABLE} — ถ้าตารางมีอยู่จริง แปลว่า login ที่แดชบอร์ดใช้ ` +
        'ยังไม่ได้สิทธิ์ข้ามฐาน รัน docs/grant-hr-user.sql ที่เครื่องออฟฟิศ');
    }
  }

  /**
   * แถวในฐาน -> รูปแบบที่หน้าเว็บใช้
   * ⚠️ ไม่มี password_hash และห้ามเพิ่มเข้ามา — บอกได้แค่ว่า "เข้ารหัสไว้แล้วหรือยัง"
   */
  const rowToUser = (r) => ({
    username: str(r.username),
    branch: str(r.branch),
    outletId: str(r.outlet_id),
    displayName: str(r.display_name),
    isActive: r.is_active === true || r.is_active === 1,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    hasPassword: Number(r.has_password) === 1,
    // false = รหัสยังเก็บเป็นข้อความล้วน (ของที่ตกค้างจากตอนย้ายมาจากชีท) ต้องตั้งใหม่
    passwordHashed: Number(r.pwd_hashed) === 1,
  });

  async function readBranchUsers() {
    await requireTable();
    const rows = await q(
      `SELECT username, branch, outlet_id, display_name, is_active, last_login_at,
              CASE WHEN LEN(ISNULL(password_hash, N'')) > 0 THEN 1 ELSE 0 END AS has_password,
              CASE WHEN password_hash LIKE N'scrypt$%' THEN 1 ELSE 0 END      AS pwd_hashed
         FROM ${TABLE}
        ORDER BY branch, username`
    );
    return rows.map(rowToUser);
  }

  /**
   * เพิ่มหรือแก้บัญชีสาขา — username เป็นคีย์ แก้ไม่ได้ (สร้างใหม่แล้วปิดตัวเก่าแทน)
   *
   * รหัสผ่านเป็นของไม่บังคับ: ส่งมา = ตั้งใหม่ · ไม่ส่งมา = ไม่แตะของเดิม
   * ตอนเพิ่มบัญชีใหม่ต้องส่งมาเสมอ ไม่งั้นจะได้บัญชีที่ล็อกอินไม่ได้และไม่มีอะไรบอก
   *
   * ⚠️ ไม่แตะ last_login_at — ต่างจาก upsertUser ของ office-server ที่ตั้งเป็นเวลาปัจจุบัน
   *    เพราะของเขาถูกเรียกตอนล็อกอินสำเร็จจริง ส่วนนี่คือแอดมินแก้ข้อมูล ไม่ใช่การล็อกอิน
   *    เขียนทับไปจะทำให้คอลัมน์นั้นตอบคำถาม "บัญชีนี้ยังมีคนใช้อยู่ไหม" ไม่ได้อีกเลย
   */
  async function saveBranchUser(body) {
    await requireTable();

    // ไม่แปลงเป็นตัวพิมพ์เล็ก — ฝั่งตารางงานเก็บตามที่พิมพ์มา (trim อย่างเดียว) และเทียบแบบ
    // ไม่สนตัวพิมพ์ด้วย collation ของฐาน แปลงที่นี่ฝ่ายเดียวจะทำให้ตัวสะกดในตารางเพี้ยนไป
    const username = str(body?.username);
    let err = validateHrUsername(username);
    if (err) throw bad(err);

    const branch = str(body?.branch);
    err = validateBranchField(branch);
    if (err) throw bad(err);

    const password = str(body?.password);
    const isNew = !(await q(`SELECT username FROM ${TABLE} WHERE username = @username`, { username })).length;
    if (isNew && !password) throw bad('บัญชีใหม่ต้องตั้งรหัสผ่านด้วย');
    if (password) {
      err = validateHrPassword(password);
      if (err) throw bad(err);
    }

    const params = {
      username,
      branch,
      outletId: str(body?.outletId),
      displayName: str(body?.displayName),
      isActive: body?.isActive === false ? 0 : 1,
    };

    /* ไม่ได้ส่งรหัสมา = แก้ข้อมูลของบัญชีที่มีอยู่แล้ว ใช้ UPDATE ล้วน ๆ
       ห้ามใช้ MERGE ตัวเดียวกันแล้วตัดแค่ท่อน SET ออก เพราะท่อน INSERT ยังอ้าง @hash อยู่
       SQL Server ตรวจตัวแปรตอน compile ไม่ใช่ตอนรัน — ถึงกิ่งนั้นจะไม่ทำงานก็ยังฟ้อง
       "Must declare the scalar variable @hash" ทุกครั้งที่แก้บัญชีโดยไม่เปลี่ยนรหัส */
    if (!password) {
      const rows = await q(
        `UPDATE ${TABLE}
            SET branch       = @branch,
                outlet_id    = NULLIF(@outletId, N''),
                display_name = NULLIF(@displayName, N''),
                is_active    = @isActive,
                updated_at   = SYSDATETIME()
          OUTPUT inserted.username AS username
          WHERE username = @username`,
        params
      );
      // ถูกลบไประหว่างที่เช็กกับที่เขียน — เกิดยากแต่ต้องไม่ตอบว่าบันทึกสำเร็จ
      if (!rows.length) throw bad(`ไม่พบบัญชี ${username} แล้ว (อาจถูกลบไประหว่างที่แก้อยู่)`);
      return { username, created: false };
    }

    params.hash = hashHrPassword(password);
    await q(
      `MERGE ${TABLE} WITH (HOLDLOCK) AS t
         USING (SELECT @username AS username) AS s
            ON t.username = s.username
       WHEN MATCHED THEN UPDATE SET
            password_hash = @hash,
            branch        = @branch,
            outlet_id     = NULLIF(@outletId, N''),
            display_name  = NULLIF(@displayName, N''),
            is_active     = @isActive,
            updated_at    = SYSDATETIME()
       WHEN NOT MATCHED THEN
            INSERT (username, password_hash, branch, outlet_id, display_name, is_active)
            VALUES (@username, @hash, @branch, NULLIF(@outletId, N''), NULLIF(@displayName, N''), @isActive);`,
      params
    );
    return { username, created: isNew };
  }

  /** ตั้งรหัสใหม่อย่างเดียว — ไม่แตะช่องอื่น */
  async function setBranchUserPassword(body) {
    await requireTable();
    const username = str(body?.username);
    let err = validateHrUsername(username);
    if (err) throw bad(err);

    const password = str(body?.password);
    err = validateHrPassword(password);
    if (err) throw bad(err);

    const rows = await q(
      `UPDATE ${TABLE}
          SET password_hash = @hash, updated_at = SYSDATETIME()
        OUTPUT inserted.username AS username
        WHERE username = @username`,
      { username, hash: hashHrPassword(password) }
    );
    if (!rows.length) throw bad(`ไม่พบบัญชี ${username}`);
    return { username };
  }

  /**
   * ลบบัญชีถาวร — ปกติควรใช้ "ปิดการใช้งาน" (is_active = 0) แทน
   * บันทึกการแก้ตารางงาน (hr_timesheet_log.actor) เก็บ username ไว้เป็นข้อความ
   * ลบแถวนี้ไม่ได้ลบบันทึกพวกนั้น แต่จะไม่เหลืออะไรบอกว่าชื่อนั้นเคยเป็นใคร
   */
  async function deleteBranchUser(body) {
    await requireTable();
    const username = str(body?.username);
    if (!username) throw bad('ต้องระบุชื่อผู้ใช้ที่จะลบ');
    const rows = await q(
      `DELETE FROM ${TABLE} OUTPUT deleted.username AS username WHERE username = @username`,
      { username }
    );
    if (!rows.length) throw bad(`ไม่พบบัญชี ${username}`);
    return { username };
  }

  return {
    readBranchUsers,
    hrDbName: () => DB,
    actions: { saveBranchUser, setBranchUserPassword, deleteBranchUser },
  };
}
