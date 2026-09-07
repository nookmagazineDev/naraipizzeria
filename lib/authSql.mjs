// คลังผู้ใช้ฝั่ง SQL — ตรรกะชุดเดียวที่ทั้งสองทางไปถึงฐานใช้ร่วมกัน
//
// ทางไปถึงฐาน InventoryNarai มีสองทาง เหมือนที่ QC/RD ใช้ (ดู lib/qcrdSource.js):
//   1) ต่อ SQL ตรงจาก Vercel  — lib/authUsers.js ส่ง runQuery ของ lib/qcrdPool.js เข้ามา
//   2) host API ที่เครื่องออฟฟิศ — host-server/auth-db.js ส่ง q ของตัวเองเข้ามา
// ทั้งสองทางจึงเห็นตาราง ตรรกะกันไม่ให้เหลือผู้ดูแลศูนย์คน และการเข้ารหัสผ่านชุดเดียวกัน
//
// ⚠️ ไฟล์นี้ห้าม import lib/qcrdPool.js หรืออะไรที่ผูกกับฝั่งใดฝั่งหนึ่ง — รับ q เข้ามาอย่างเดียว
//    (กติกาเดียวกับ lib/qcrdSql.mjs)
import { hashPassword, verifyPassword } from './authHash.mjs';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const lower = (v) => str(v).toLowerCase();

export const ROLE_ADMIN = 'admin';
export const ROLE_USER = 'user';
export const STATUS_ACTIVE = 'ใช้งาน';
export const STATUS_INACTIVE = 'ปิดการใช้งาน';

/** error ที่แปลว่า "ยังไม่ได้สร้างตาราง" — คนละเรื่องกับต่อเครื่องไม่ถึง */
export const isMissingTable = (msg) => /Invalid object name .*app_user/i.test(msg || '');

const SELECT_COLS =
  'username, display_name, role, status, branch_code, perms, note, last_login_at, updated_at';

/** แถวในฐาน -> รูปแบบที่หน้าเว็บใช้ (ไม่มี hash รหัสผ่านติดมาด้วย) */
export function rowToUser(r) {
  let perms = [];
  const raw = r.perms;
  if (Array.isArray(raw)) perms = raw;
  else if (str(raw)) { try { perms = JSON.parse(raw); } catch { perms = str(raw).split(','); } }
  return {
    username: lower(r.username),
    displayName: str(r.display_name),
    role: str(r.role) === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER,
    status: str(r.status) || STATUS_ACTIVE,
    branchCode: str(r.branch_code),
    perms: Array.isArray(perms) ? perms.map(str).filter(Boolean) : [],
    note: str(r.note),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/**
 * สร้างชุดคำสั่งคลังผู้ใช้ที่ผูกกับทางต่อฐานทางหนึ่ง
 * @param {{ q: (text: string, params?: object) => Promise<any[]> }} deps
 */
export function createAuthStore({ q }) {
  /** มีตารางและอ่านได้จริงไหม (ต่อไม่ถึงเครื่องจะโยน error ออกไปให้ผู้เรียกแยกกรณีเอง) */
  async function tableIsReady() {
    try {
      await q('SELECT TOP 1 1 AS ok FROM dbo.app_user');
      return true;
    } catch (err) {
      if (isMissingTable(err.message)) return false;
      throw err;
    }
  }

  /** รายชื่อผู้ใช้ทั้งหมด เรียงตามชื่อผู้ใช้ */
  async function listUsers() {
    const rows = await q(`SELECT ${SELECT_COLS} FROM dbo.app_user`);
    return rows.map(rowToUser).sort((a, b) => a.username.localeCompare(b.username));
  }

  /** ผู้ใช้หนึ่งคนพร้อม hash — ใช้ตอนตรวจรหัสผ่านเท่านั้น ห้ามส่งออกไปนอกเครื่อง */
  async function findUserWithHash(username) {
    const rows = await q(
      `SELECT ${SELECT_COLS}, password_hash FROM dbo.app_user WHERE username = @username`,
      { username: lower(username) }
    );
    if (!rows.length) return null;
    return { ...rowToUser(rows[0]), passwordHash: str(rows[0].password_hash) };
  }

  /** จำนวนผู้ดูแลที่ยังเปิดใช้งาน (ไม่นับคนที่กำลังแก้) — กันถอด admin คนสุดท้าย */
  async function activeAdminCount(excludeUsername = null) {
    const rows = await q(
      `SELECT COUNT(*) AS n FROM dbo.app_user
        WHERE role = @role AND status = @status AND username <> @exclude`,
      { role: ROLE_ADMIN, status: STATUS_ACTIVE, exclude: lower(excludeUsername) || ' ' }
    );
    return Number(rows[0]?.n) || 0;
  }

  /**
   * ตรวจชื่อผู้ใช้+รหัสผ่าน คืน { ok, user } หรือ { ok:false, reason }
   * reason: 'wrong' = ไม่มีชื่อนี้/รหัสผิด · 'inactive' = บัญชีถูกปิด
   * ข้อความที่เอาไปแสดงให้ผู้เรียกเป็นคนแต่ง — ที่นี่บอกแค่เหตุผลเชิงเทคนิค
   */
  async function verifyLogin(username, password) {
    const u = lower(username);
    const found = await findUserWithHash(u);
    if (!found) return { ok: false, reason: 'wrong' };
    if (found.status === STATUS_INACTIVE) return { ok: false, reason: 'inactive' };
    if (!verifyPassword(password, found.passwordHash)) return { ok: false, reason: 'wrong' };

    // อัปเดตเวลาล็อกอินล้มเหลวไม่ควรไปขวางการเข้าระบบ (เป็นแค่ข้อมูลประกอบ)
    try {
      await q('UPDATE dbo.app_user SET last_login_at = SYSDATETIME() WHERE username = @username',
        { username: u });
    } catch (err) {
      console.error('auth: บันทึกเวลาล็อกอินไม่สำเร็จ:', err.message);
    }
    const { passwordHash, ...safe } = found;
    return { ok: true, user: safe };
  }

  /**
   * เพิ่มหรือแก้ผู้ใช้หนึ่งคน — ชื่อผู้ใช้เป็นคีย์ เปลี่ยนชื่อไม่ได้
   * password เว้นว่างตอนแก้ = ไม่แตะรหัสผ่านเดิม / ตอนเพิ่มใหม่ = ต้องกรอก
   */
  async function saveUser(body, { actor } = {}) {
    const username = lower(body.username);
    const role = str(body.role) === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER;
    const status = str(body.status) === STATUS_INACTIVE ? STATUS_INACTIVE : STATUS_ACTIVE;
    const perms = Array.isArray(body.perms) ? body.perms.map(str).filter(Boolean) : [];
    const existing = await findUserWithHash(username);

    if (!existing && !body.password) throw new Error('ผู้ใช้ใหม่ต้องตั้งรหัสผ่านด้วย');

    // ห้ามถอด/ปิดผู้ดูแลคนสุดท้าย — ไม่งั้นไม่มีใครเข้ามาแก้สิทธิ์ได้อีกเลย
    if (existing?.role === ROLE_ADMIN && existing.status !== STATUS_INACTIVE
        && (role !== ROLE_ADMIN || status === STATUS_INACTIVE)
        && (await activeAdminCount(username)) === 0) {
      throw new Error('เหลือผู้ดูแลระบบคนเดียว — ตั้งคนอื่นเป็นผู้ดูแลก่อนจึงจะลดสิทธิ์คนนี้ได้');
    }

    const passwordHash = body.password ? hashPassword(body.password) : existing?.passwordHash || '';

    await q(
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
        actor: lower(actor),
      }
    );
    return { username, isNew: !existing };
  }

  async function deleteUser(username, { actor } = {}) {
    const u = lower(username);
    if (!u) throw new Error('ต้องระบุชื่อผู้ใช้ที่จะลบ');
    if (u === lower(actor)) throw new Error('ลบบัญชีตัวเองไม่ได้');

    const existing = await findUserWithHash(u);
    if (!existing) throw new Error(`ไม่พบผู้ใช้ ${u}`);
    if (existing.role === ROLE_ADMIN && (await activeAdminCount(u)) === 0) {
      throw new Error('เหลือผู้ดูแลระบบคนเดียว — ตั้งคนอื่นเป็นผู้ดูแลก่อนจึงจะลบคนนี้ได้');
    }

    await q('DELETE FROM dbo.app_user WHERE username = @username', { username: u });
    return { username: u };
  }

  /** ตั้งรหัสผ่านใหม่ให้คนหนึ่ง — ใช้ตอนผู้ดูแลรีเซ็ตรหัสให้ */
  async function setPassword(username, password, { actor } = {}) {
    const u = lower(username);
    const rows = await q(
      `UPDATE dbo.app_user
          SET password_hash = @hash, updated_at = SYSDATETIME(), updated_by = @actor
        OUTPUT inserted.username AS username
        WHERE username = @username`,
      { username: u, hash: hashPassword(password), actor: lower(actor) }
    );
    if (!rows.length) throw new Error(`ไม่พบผู้ใช้ ${u}`);
    return { username: u };
  }

  /** ตรวจรหัสผ่านเดิมก่อนให้เปลี่ยนเป็นอันใหม่ (ผู้ใช้เปลี่ยนรหัสตัวเอง) */
  async function changeOwnPassword(username, currentPassword, newPassword) {
    const u = lower(username);
    const found = await findUserWithHash(u);
    if (!found) throw new Error('บัญชีนี้ไม่ได้เก็บในฐานข้อมูล (ผู้ดูแลสำรอง) — เปลี่ยนรหัสที่ค่า env แทน');
    if (!verifyPassword(currentPassword, found.passwordHash)) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
    return setPassword(u, newPassword, { actor: u });
  }

  /**
   * สร้างตารางจากข้อความสคีมา (docs/schema-app-user.sql) — รันซ้ำได้ ไม่ทับข้อมูลเดิม
   * ผู้เรียกเป็นคนอ่านไฟล์มาเอง เพราะสองฝั่งหาไฟล์คนละที่
   */
  async function createTable(sqlText) {
    const batches = String(sqlText).split(/^\s*GO\s*;?\s*$/gim).map((b) => b.trim()).filter(Boolean);
    // ชุด CREATE DATABASE/USE รันจากคอนเนกชันที่ชี้ฐานนั้นอยู่แล้วไม่ได้ (และไม่จำเป็น)
    const runnable = batches.filter((b) => !/CREATE\s+DATABASE|^\s*USE\s+/im.test(b));
    let ran = 0;
    for (const b of runnable) { await q(b); ran++; }
    return { ran, of: runnable.length };
  }

  return {
    tableIsReady, listUsers, findUserWithHash, activeAdminCount,
    verifyLogin, saveUser, deleteUser, setPassword, changeOwnPassword, createTable,
  };
}
