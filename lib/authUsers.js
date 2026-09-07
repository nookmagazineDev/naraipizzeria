// คลังผู้ใช้ — อ่าน/เขียนตาราง InventoryNarai.dbo.app_user
//
// ⚠️ ฝั่งเซิร์ฟเวอร์เท่านั้น (import mssql ผ่าน lib/qcrdPool.js และ node:crypto)
//    ห้าม import จากคอมโพเนนต์ — ของที่หน้าเว็บใช้ร่วมกันอยู่ที่ lib/permissions.js
//
// ต่อฐานด้วย pool เดียวกับ QC/RD และทะเบียนสาขา (ชี้ InventoryNarai อยู่แล้ว)
//
// ทางถอยเมื่อยังต่อฐานไม่ได้ — จงใจให้มี ไม่งั้น "ต่อ SQL ไม่ติด" = ทุกคนเข้าระบบไม่ได้เลย
// ทั้งที่หน้าอื่น ๆ ของแดชบอร์ดยังทำงานได้ (หน้าพวกนั้นมีทางถอยไป host API/ชีทของตัวเอง)
//   1) ตาราง dbo.app_user (ของจริง — แก้สิทธิ์จากหน้าเว็บได้)
//   2) APP_ADMIN_USER / APP_ADMIN_PASSWORD บน Vercel (ผู้ดูแลสำรองหนึ่งคน)
//   3) โหมดตั้งค่า: admin / admin1234 พร้อมแถบเตือนสีแดงคาหน้าจอ
// ทางถอยข้อ 3 มีไว้ให้เข้าไปตั้งค่าครั้งแรกเท่านั้น — ตั้ง APP_ADMIN_PASSWORD
// หรือสร้างตารางแล้วมันจะปิดตัวเองทันที (ดู setupModeActive)
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { isConfigured as hasDirectDb, runQuery } from './qcrdPool';
import {
  ROLE_ADMIN, ROLE_USER, STATUS_ACTIVE, STATUS_INACTIVE,
  ALL_MENU_KEYS, normalizePerms, normalizeUsername,
} from './permissions';

export { hasDirectDb };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/* ─────────────────────────── รหัสผ่าน ─────────────────────────── */

// scrypt ของ node ล้วน ๆ — ไม่เพิ่ม dependency (bcrypt/argon2 ต้อง build native บน Vercel)
// N=16384 คือค่ามาตรฐานที่ node แนะนำ ใช้เวลาราว 50–100 มิลลิวินาทีต่อครั้ง
const SCRYPT_N = 16384;
const KEY_LEN = 32;

/** เก็บเป็นข้อความบรรทัดเดียว: scrypt$<N>$<salt hex>$<key hex> */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** เทียบรหัสผ่านกับค่าที่เก็บไว้ — รูปแบบแปลก/ว่าง = ไม่ผ่าน (ไม่โยน error) */
export function verifyPassword(password, stored) {
  const parts = str(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  try {
    const n = Number(parts[1]) || SCRYPT_N;
    const salt = Buffer.from(parts[2], 'hex');
    const want = Buffer.from(parts[3], 'hex');
    const got = scryptSync(String(password), salt, want.length, { N: n, r: 8, p: 1 });
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** เทียบรหัสผ่านล้วน (ทางถอยที่อ่านจาก env) แบบไม่ให้เวลาฟ้องความยาวที่ตรงกัน */
function plainEquals(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/* ─────────────────────── ผู้ดูแลสำรอง / โหมดตั้งค่า ─────────────────────── */

const SETUP_USER = 'admin';
const SETUP_PASSWORD = 'admin1234';

/** ผู้ดูแลสำรองที่ตั้งไว้บน Vercel — ตั้งครบทั้งคู่เท่านั้นจึงจะใช้ได้ */
function envAdmin() {
  const user = normalizeUsername(process.env.APP_ADMIN_USER);
  const password = process.env.APP_ADMIN_PASSWORD || '';
  return user && password ? { username: user, password } : null;
}

export const hasEnvAdmin = () => Boolean(envAdmin());

/**
 * โหมดตั้งค่ายังเปิดอยู่ไหม (admin/admin1234 ใช้ได้)
 * เปิดก็ต่อเมื่อ "ไม่มีคลังผู้ใช้ที่ใช้ได้เลย" — ทั้งไม่ได้ตั้ง env และตารางยังใช้ไม่ได้
 */
export function setupModeActive({ tableReady }) {
  return !envAdmin() && !tableReady;
}

const adminUser = (username, note) => ({
  username,
  displayName: 'ผู้ดูแลระบบ',
  role: ROLE_ADMIN,
  status: STATUS_ACTIVE,
  branchCode: '',
  perms: [...ALL_MENU_KEYS],
  note: note || '',
  source: 'env',
});

/* ───────────────────────────── ตาราง ───────────────────────────── */

export const isMissingTable = (msg) => /Invalid object name .*app_user/i.test(msg || '');

const rowToUser = (r) => ({
  username: normalizeUsername(r.username),
  displayName: str(r.display_name),
  role: str(r.role) === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER,
  status: str(r.status) || STATUS_ACTIVE,
  branchCode: str(r.branch_code),
  perms: normalizePerms(r.perms),
  note: str(r.note),
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  source: 'sql',
});

const SELECT_COLS = 'username, display_name, role, status, branch_code, perms, note, last_login_at, updated_at';

/** รายชื่อผู้ใช้ทั้งหมด (ไม่มี hash รหัสผ่านติดมาด้วยเด็ดขาด) */
export async function listUsers() {
  const rows = await runQuery(`SELECT ${SELECT_COLS} FROM dbo.app_user`);
  return rows.map(rowToUser).sort((a, b) => a.username.localeCompare(b.username));
}

/** ผู้ใช้หนึ่งคนพร้อม hash — ใช้ตอนตรวจรหัสผ่านเท่านั้น */
async function findUserWithHash(username) {
  const rows = await runQuery(
    `SELECT ${SELECT_COLS}, password_hash FROM dbo.app_user WHERE username = @username`,
    { username: normalizeUsername(username) }
  );
  if (!rows.length) return null;
  return { ...rowToUser(rows[0]), passwordHash: str(rows[0].password_hash) };
}

/** มีตารางและอ่านได้จริงไหม — ใช้ตัดสินว่าจะเปิดโหมดตั้งค่าหรือยัง */
export async function tableIsReady() {
  if (!hasDirectDb()) return false;
  try {
    await runQuery('SELECT TOP 1 1 AS ok FROM dbo.app_user');
    return true;
  } catch {
    return false;
  }
}

/** จำนวน admin ที่ยังเปิดใช้งานอยู่ (ไม่นับคนที่กำลังแก้) — กันถอด admin คนสุดท้าย */
async function activeAdminCount(excludeUsername = null) {
  const rows = await runQuery(
    `SELECT COUNT(*) AS n FROM dbo.app_user
      WHERE role = @role AND status = @status AND username <> @exclude`,
    { role: ROLE_ADMIN, status: STATUS_ACTIVE, exclude: normalizeUsername(excludeUsername) || ' ' }
  );
  return Number(rows[0]?.n) || 0;
}

/* ─────────────────────────── เข้าสู่ระบบ ─────────────────────────── */

/**
 * ตรวจชื่อผู้ใช้+รหัสผ่าน คืน { ok, user } หรือ { ok:false, message }
 * ข้อความตอนไม่ผ่านจงใจไม่แยกว่า "ไม่มีชื่อนี้" หรือ "รหัสผิด"
 * (บอกแยกเท่ากับบอกคนนอกว่าชื่อไหนมีอยู่จริง)
 */
export async function authenticate(username, password) {
  const u = normalizeUsername(username);
  const p = String(password ?? '');
  const WRONG = { ok: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  if (!u || !p) return WRONG;

  // ผู้ดูแลสำรองจาก env มาก่อนเสมอ — ต่อให้ฐานล่มก็ยังเข้าไปดูได้ว่าเกิดอะไรขึ้น
  const env = envAdmin();
  if (env && u === env.username) {
    return plainEquals(p, env.password)
      ? { ok: true, user: adminUser(env.username, 'ผู้ดูแลสำรองจาก APP_ADMIN_USER') }
      : WRONG;
  }

  if (hasDirectDb()) {
    try {
      const found = await findUserWithHash(u);
      if (found) {
        if (found.status === STATUS_INACTIVE) {
          return { ok: false, message: 'บัญชีนี้ถูกปิดการใช้งาน — ติดต่อผู้ดูแลระบบ' };
        }
        if (!verifyPassword(p, found.passwordHash)) return WRONG;
        // อัปเดตเวลาล็อกอินล้มเหลวไม่ควรไปขวางการเข้าระบบ (เป็นแค่ข้อมูลประกอบ)
        try {
          await runQuery(
            'UPDATE dbo.app_user SET last_login_at = SYSDATETIME() WHERE username = @username',
            { username: u }
          );
        } catch (err) {
          console.error('auth: บันทึกเวลาล็อกอินไม่สำเร็จ:', err.message);
        }
        const { passwordHash, ...safe } = found;
        return { ok: true, user: safe };
      }
      // มีตารางแล้วแต่ไม่มีชื่อนี้ — โหมดตั้งค่าปิดไปแล้ว
      return WRONG;
    } catch (err) {
      if (!isMissingTable(err.message)) {
        console.error('auth: อ่านคลังผู้ใช้ไม่ได้:', err.message);
        return { ok: false, message: `ตรวจสอบผู้ใช้กับฐานข้อมูลไม่ได้ (${err.message})` };
      }
      // ยังไม่ได้สร้างตาราง — ตกไปใช้โหมดตั้งค่าด้านล่าง
    }
  }

  if (!env && u === SETUP_USER && plainEquals(p, SETUP_PASSWORD)) {
    return { ok: true, user: adminUser(SETUP_USER, 'โหมดตั้งค่า — ยังไม่มีคลังผู้ใช้จริง') };
  }
  return WRONG;
}

/* ──────────────────────── แก้ไขคลังผู้ใช้ ──────────────────────── */

/**
 * เพิ่มหรือแก้ผู้ใช้หนึ่งคน — ชื่อผู้ใช้เป็นคีย์ เปลี่ยนชื่อไม่ได้
 * (เปลี่ยนแล้วประวัติที่อ้างชื่อเดิมจะกำพร้า — จะเปลี่ยนจริงให้เพิ่มคนใหม่แล้วปิดตัวเก่า)
 * password เว้นว่างตอนแก้ = ไม่แตะรหัสผ่านเดิม / ตอนเพิ่มใหม่ = ต้องกรอก
 */
export async function saveUser(body, { actor } = {}) {
  const username = normalizeUsername(body.username);
  const role = str(body.role) === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER;
  const status = str(body.status) === STATUS_INACTIVE ? STATUS_INACTIVE : STATUS_ACTIVE;
  // admin เห็นทุกเมนูอยู่แล้ว แต่ยังเก็บรายการที่ติ๊กไว้ตามจริง — วันหลังลดสิทธิ์เป็น user
  // จะได้ไม่กลายเป็นเห็นทุกเมนูต่อ หรือไม่เห็นอะไรเลยแบบไม่ตั้งใจ
  const perms = normalizePerms(body.perms);
  const existing = await findUserWithHash(username);

  if (!existing && !body.password) throw new Error('ผู้ใช้ใหม่ต้องตั้งรหัสผ่านด้วย');

  // ห้ามถอด/ปิด admin คนสุดท้าย — ไม่งั้นไม่มีใครเข้ามาแก้สิทธิ์ได้อีกเลย
  if (existing?.role === ROLE_ADMIN && existing.status !== STATUS_INACTIVE
      && (role !== ROLE_ADMIN || status === STATUS_INACTIVE)) {
    if ((await activeAdminCount(username)) === 0) {
      throw new Error('เหลือผู้ดูแลระบบคนเดียว — ตั้งคนอื่นเป็นผู้ดูแลก่อนจึงจะลดสิทธิ์คนนี้ได้');
    }
  }

  const passwordHash = body.password ? hashPassword(body.password) : existing?.passwordHash || '';

  await runQuery(
    `MERGE dbo.app_user AS t
     USING (SELECT @username AS username) AS s
        ON t.username = s.username
     WHEN MATCHED THEN UPDATE SET
        display_name = @displayName, password_hash = @passwordHash, role = @role,
        status = @status, branch_code = @branchCode, perms = @perms, note = @note,
        updated_at = SYSDATETIME(), updated_by = @actor
     WHEN NOT MATCHED THEN
        INSERT (username, display_name, password_hash, role, status, branch_code, perms, note, updated_by)
        VALUES (@username, @displayName, @passwordHash, @role, @status, @branchCode, @perms, @note, @actor);`,
    {
      username,
      displayName: str(body.displayName) || username,
      passwordHash,
      role,
      status,
      branchCode: str(body.branchCode).toUpperCase(),
      perms: JSON.stringify(perms),
      note: str(body.note),
      actor: normalizeUsername(actor) || '',
    }
  );
  return { username, isNew: !existing };
}

export async function deleteUser(username, { actor } = {}) {
  const u = normalizeUsername(username);
  if (!u) throw new Error('ต้องระบุชื่อผู้ใช้ที่จะลบ');
  if (u === normalizeUsername(actor)) throw new Error('ลบบัญชีตัวเองไม่ได้');

  const existing = await findUserWithHash(u);
  if (!existing) throw new Error(`ไม่พบผู้ใช้ ${u}`);
  if (existing.role === ROLE_ADMIN && (await activeAdminCount(u)) === 0) {
    throw new Error('เหลือผู้ดูแลระบบคนเดียว — ตั้งคนอื่นเป็นผู้ดูแลก่อนจึงจะลบคนนี้ได้');
  }

  await runQuery('DELETE FROM dbo.app_user WHERE username = @username', { username: u });
  return { username: u };
}

/** ตั้งรหัสผ่านใหม่ให้คนหนึ่ง — ใช้ตอนผู้ดูแลรีเซ็ตรหัสให้ */
export async function setPassword(username, password, { actor } = {}) {
  const u = normalizeUsername(username);
  const rows = await runQuery(
    `UPDATE dbo.app_user
        SET password_hash = @hash, updated_at = SYSDATETIME(), updated_by = @actor
      OUTPUT inserted.username AS username
      WHERE username = @username`,
    { username: u, hash: hashPassword(password), actor: normalizeUsername(actor) || '' }
  );
  if (!rows.length) throw new Error(`ไม่พบผู้ใช้ ${u}`);
  return { username: u };
}

/** ตรวจรหัสผ่านเดิมก่อนให้เปลี่ยนเป็นอันใหม่ (ผู้ใช้เปลี่ยนรหัสตัวเอง) */
export async function changeOwnPassword(username, currentPassword, newPassword) {
  const u = normalizeUsername(username);
  const found = await findUserWithHash(u);
  if (!found) throw new Error('บัญชีนี้ไม่ได้เก็บในฐานข้อมูล (ผู้ดูแลสำรอง) — เปลี่ยนรหัสที่ค่า env แทน');
  if (!verifyPassword(currentPassword, found.passwordHash)) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  return setPassword(u, newPassword, { actor: u });
}

/** แปลง error ของ SQL ที่ผู้ใช้แก้เองได้ ให้เป็นข้อความที่บอกวิธีแก้ */
export function explainUserError(err) {
  const msg = err?.message || String(err);
  if (isMissingTable(msg)) {
    return 'ยังไม่ได้สร้างตารางผู้ใช้ — กดปุ่ม "สร้างตาราง" ที่หัวหน้านี้ ' +
      'หรือรัน docs/schema-app-user.sql ที่เครื่องออฟฟิศ';
  }
  return msg;
}
