// คลังผู้ใช้ — ตาราง InventoryNarai.dbo.app_user
//
// ⚠️ ฝั่งเซิร์ฟเวอร์เท่านั้น (ลาก mssql มาผ่าน lib/qcrdPool.js) ห้าม import จากคอมโพเนนต์
//    ของที่หน้าเว็บใช้ร่วมกันอยู่ที่ lib/permissions.js
//
// มีสองทางไปถึงฐาน เหมือนที่ QC/RD และหน้าปิดรอบเดือนใช้ (ดู lib/qcrdSource.js):
//   1) ต่อ SQL ตรงจาก Vercel (lib/qcrdPool.js) — เร็วกว่า แต่ที่ร้านเปิดพอร์ตให้เฉพาะ
//      IP ในไทย ทางนี้จึงล้มเป็นปกติ
//   2) host API /auth/* ที่เครื่องออฟฟิศ (host-server/auth-db.js) — ทางที่ใช้ได้จริง
//      ต้องตั้ง AUTH_API_KEY (หรือ QCRD_WRITE_KEY) ให้ตรงกันทั้งสองฝั่ง
// ตรรกะ SQL ทั้งหมดอยู่ที่ lib/authSql.mjs ชุดเดียว ทั้งสองทางเรียกตัวเดียวกัน
//
// ทางถอยชั้นสุดท้ายเมื่อไปไม่ถึงฐานทั้งสองทาง — จงใจให้มี ไม่งั้น "เครื่องออฟฟิศดับ"
// = ทุกคนเข้าระบบไม่ได้เลยแม้แต่ผู้ดูแล:
//   1) APP_ADMIN_USER / APP_ADMIN_PASSWORD บน Vercel (ผู้ดูแลสำรองหนึ่งคน)
//   2) โหมดตั้งค่า: admin / admin1234 พร้อมแถบเตือนสีแดงคาหน้าจอ
// ข้อ 2 ปิดตัวเองทันทีที่อ่านตารางผู้ใช้ได้ หรือตั้งผู้ดูแลสำรองไว้แล้ว (ดู setupModeActive)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isConfigured as hasDirectDb, runQuery, describeTarget } from './qcrdPool';
import { isUnreachable, directDown, markDirectDown, clearDirectDown, explainHostError } from './directRoute';
import { createAuthStore, isMissingTable } from './authSql.mjs';
import { plainEquals } from './authHash.mjs';
import {
  ROLE_ADMIN, STATUS_ACTIVE, ALL_MENU_KEYS, normalizePerms, normalizeUsername,
} from './permissions';

export { hasDirectDb, isMissingTable };

/* ─────────────────────── ทางไปถึงฐาน ─────────────────────── */

/** ทางต่อตรง — ตรรกะเดียวกับที่เครื่องออฟฟิศใช้ ต่างแค่ตัวยิง query */
const direct = createAuthStore({ q: runQuery });

export const AUTH_API_BASE = (
  process.env.AUTH_API_BASE || process.env.QCRD_API_BASE || process.env.STORE_API_BASE
  || 'https://api.khanoykorshabu.com'
).replace(/\/+$/, '');

// กุญแจของ QC/RD ใช้แทนได้ถ้ายังไม่ได้ตั้งของตัวเอง — เครื่องเดียวกัน ความเชื่อใจระดับเดียวกัน
// (ฝั่ง host-server/auth-db.js ถอยแบบเดียวกันเป๊ะ จะได้ไม่ต้องตั้ง env เพิ่มตอนเริ่มใช้)
const apiKey = () => process.env.AUTH_API_KEY || process.env.QCRD_WRITE_KEY || '';

/** ทาง host API ใช้ได้ไหม — ไม่มีกุญแจ ฝั่งโน้นก็ปิดไว้อยู่แล้ว ไม่ต้องเสียเวลายิง */
export const hasHostRoute = () => Boolean(apiKey());

/** มีทางไปถึงฐานสักทางไหม — ไม่มีเลย = แก้คลังผู้ใช้ไม่ได้ ต้องไปตั้งค่าก่อน */
export const hasAnyRoute = () => hasDirectDb() || hasHostRoute();

async function hostCall(pathname, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const key = apiKey();
  if (!key) {
    throw new Error(
      'ยังไม่ได้ตั้ง AUTH_API_KEY (หรือ QCRD_WRITE_KEY) บน Vercel — ' +
      'ทาง host API ที่เครื่องออฟฟิศจึงใช้ไม่ได้ ดู docs/login-permissions.md'
    );
  }
  const res = await fetch(`${AUTH_API_BASE}${pathname}`, {
    method,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'x-api-key': key,
      'ngrok-skip-browser-warning': 'true',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch((err) => { throw explainHostError(err, { base: AUTH_API_BASE, timeoutMs }); });

  if (res.status === 404) {
    throw new Error(
      'host API ยังไม่มี /auth/* (HTTP 404) — เครื่องออฟฟิศรันโค้ดเก่าอยู่ ' +
      'ที่เครื่องนั้นสั่ง git pull แล้วรัน start-narai.ps1 -Restart'
    );
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error(
      `host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ` +
      'เครื่องออฟฟิศอาจยังรัน host-server เวอร์ชันเก่าที่ยังไม่มี /auth/*'
    );
  }
  if (json?.status !== 'success') {
    throw new Error(json?.message || `host API ตอบผิดพลาด (HTTP ${res.status})`);
  }
  return json.data;
}

/**
 * ลองต่อ SQL ตรงก่อน ไปไม่ถึงค่อยถอยไป host API — กติกาเดียวกับ viaDirectOrHost ของ QC/RD
 * ถอยเฉพาะ error ที่แปลว่า "ไปไม่ถึงเครื่อง" เท่านั้น
 * ตารางไม่มี/ไม่มีสิทธิ์/ข้อมูลไม่ถูก ต้องเด้งขึ้นไปให้คนอ่านแก้ ห้ามกลบด้วยการถอย
 */
async function viaDirectOrHost(label, runDirect, runHost) {
  if (!hasDirectDb() || directDown()) return runHost();

  try {
    const out = await runDirect();
    clearDirectDown();
    return out;
  } catch (err) {
    if (!isUnreachable(err.message)) throw err;
    markDirectDown();
    console.error(`auth ${label}: ต่อ SQL ตรงไม่ได้ (${describeTarget()}) — ถอยไปเรียก host API:`, err.message);
    try {
      return await runHost();
    } catch (hostErr) {
      // พังทั้งสองทาง — บอกทั้งคู่ ไม่งั้นจะเห็นแค่ทางหลังแล้วไล่ผิดจุด
      throw new Error(
        `ต่อ SQL ตรงไม่ได้: ${err.message}\n` +
        `→ ถอยไปเรียก host API (${AUTH_API_BASE}) ก็ไม่ได้: ${hostErr.message}`
      );
    }
  }
}

/** error ที่แปลว่า "ยังไม่มีคลังผู้ใช้ให้ตรวจ" — ต่างจาก "ตรวจแล้วรหัสผิด" */
const HOST_DOWN = /host API|ยังไม่ได้ตั้ง AUTH_API_KEY|x-api-key|เครื่องออฟฟิศ/i;
const noStoreAvailable = (msg) => isMissingTable(msg) || isUnreachable(msg) || HOST_DOWN.test(msg || '');

/* ─────────────────── ผู้ดูแลสำรอง / โหมดตั้งค่า ─────────────────── */

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
 * เปิดก็ต่อเมื่อ "ไม่มีคลังผู้ใช้ที่ใช้ได้เลย" — ทั้งไม่ได้ตั้งผู้ดูแลสำรองและอ่านตารางไม่ได้
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

/* ───────────────────── อ่าน/เขียนคลังผู้ใช้ ───────────────────── */

/**
 * มีตารางและอ่านได้จริงไหม — ใช้ตัดสินว่าจะเปิดโหมดตั้งค่าหรือยัง
 * ไปไม่ถึงฐานทั้งสองทางถือว่า "ยังไม่พร้อม" ไม่ใช่ error (หน้าล็อกอินต้องขึ้นได้เสมอ)
 */
export async function tableIsReady() {
  if (!hasAnyRoute()) return false;
  try {
    return await viaDirectOrHost('tableIsReady',
      () => direct.tableIsReady(),
      async () => Boolean((await hostCall('/auth/ping')).tableReady));
  } catch {
    return false;
  }
}

/** รายชื่อผู้ใช้ทั้งหมด (ไม่มี hash รหัสผ่านติดมาด้วยเด็ดขาด) */
export function listUsers() {
  return viaDirectOrHost('listUsers',
    () => direct.listUsers(),
    () => hostCall('/auth/users'));
}

/** สร้างตาราง — ทางตรงอ่านไฟล์สคีมาที่ Vercel แนบมา ทาง host อ่านไฟล์ที่เครื่องออฟฟิศเอง */
export function createTable() {
  return viaDirectOrHost('createTable',
    async () => {
      // next.config.js สั่งแนบไฟล์นี้ไปกับฟังก์ชัน ไม่งั้นบน Vercel จะขึ้น ENOENT
      const file = path.join(process.cwd(), 'docs', 'schema-app-user.sql');
      return direct.createTable(await readFile(file, 'utf8'));
    },
    () => hostCall('/auth/save', { method: 'POST', body: { action: 'createTable' } }));
}

export function saveUser(body, { actor } = {}) {
  const payload = {
    ...body,
    username: normalizeUsername(body.username),
    perms: normalizePerms(body.perms),
  };
  return viaDirectOrHost('saveUser',
    () => direct.saveUser(payload, { actor }),
    () => hostCall('/auth/save', { method: 'POST', body: { action: 'saveUser', actor, ...payload } }));
}

export function deleteUser(username, { actor } = {}) {
  const u = normalizeUsername(username);
  return viaDirectOrHost('deleteUser',
    () => direct.deleteUser(u, { actor }),
    () => hostCall('/auth/save', { method: 'POST', body: { action: 'deleteUser', actor, username: u } }));
}

export function setPassword(username, password, { actor } = {}) {
  const u = normalizeUsername(username);
  return viaDirectOrHost('resetPassword',
    () => direct.setPassword(u, password, { actor }),
    () => hostCall('/auth/save', {
      method: 'POST', body: { action: 'resetPassword', actor, username: u, password },
    }));
}

export function changeOwnPassword(username, currentPassword, newPassword) {
  const u = normalizeUsername(username);
  return viaDirectOrHost('changeOwnPassword',
    () => direct.changeOwnPassword(u, currentPassword, newPassword),
    () => hostCall('/auth/save', {
      method: 'POST',
      body: { action: 'changeOwnPassword', username: u, currentPassword, newPassword },
    }));
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

  let noStore = '';   // เหตุผลที่ไปไม่ถึงคลังผู้ใช้ — ไว้บอกสาเหตุจริงท้ายฟังก์ชัน
  if (hasAnyRoute()) {
    try {
      const out = await viaDirectOrHost('verifyLogin',
        () => direct.verifyLogin(u, p),
        () => hostCall('/auth/verify', { method: 'POST', body: { username: u, password: p } }));

      if (out.ok) return { ok: true, user: { ...out.user, source: 'sql' } };
      if (out.reason === 'inactive') {
        return { ok: false, message: 'บัญชีนี้ถูกปิดการใช้งาน — ติดต่อผู้ดูแลระบบ' };
      }
      // ตรวจกับคลังผู้ใช้จริงแล้วไม่ผ่าน — โหมดตั้งค่าปิดไปแล้ว ไม่ต้องตกไปข้างล่าง
      return WRONG;
    } catch (err) {
      if (!noStoreAvailable(err.message)) {
        console.error('auth: ตรวจผู้ใช้ไม่สำเร็จ:', err.message);
        return { ok: false, message: `ตรวจสอบผู้ใช้กับฐานข้อมูลไม่ได้ (${err.message})` };
      }
      // ยังไม่ได้สร้างตาราง / ไปไม่ถึงฐานทั้งสองทาง — ตกไปใช้โหมดตั้งค่าด้านล่าง
      noStore = err.message;
    }
  }

  if (!env && u === SETUP_USER && plainEquals(p, SETUP_PASSWORD)) {
    return { ok: true, user: adminUser(SETUP_USER, 'โหมดตั้งค่า — ยังไม่มีคลังผู้ใช้จริง') };
  }

  // ไปไม่ถึงคลังผู้ใช้ แล้วชื่อที่กรอกก็ไม่ใช่บัญชีสำรอง — บอกสาเหตุจริง
  // อย่าตอบ "รหัสผิด" ให้เขานั่งลองรหัสซ้ำ ๆ ทั้งที่ปัญหาอยู่ที่ทางไปฐาน
  if (noStore && !isMissingTable(noStore)) {
    return {
      ok: false,
      message: `ตอนนี้ยังไปถึงคลังผู้ใช้ไม่ได้ จึงตรวจรหัสผ่านของบัญชีนี้ไม่ได้ (${noStore})`,
    };
  }
  return WRONG;
}

/** แปลง error ของ SQL/host API ที่ผู้ใช้แก้เองได้ ให้เป็นข้อความที่บอกวิธีแก้ */
export function explainUserError(err) {
  const msg = err?.message || String(err);
  if (isMissingTable(msg)) {
    return 'ยังไม่ได้สร้างตารางผู้ใช้ — กดปุ่ม "สร้างตาราง" ที่หัวหน้านี้ ' +
      'หรือรัน docs/schema-app-user.sql ที่เครื่องออฟฟิศ';
  }
  return msg;
}
