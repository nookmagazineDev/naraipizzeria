// ตั๋วเข้าระบบ (session token) — เซ็นด้วย HMAC-SHA256 เก็บในคุกกี้ httpOnly
//
// ทำไมไม่เก็บ session ไว้ในฐาน: แดชบอร์ดตัวนี้รันบน Vercel ที่ปลุก-ดับฟังก์ชันตลอด
// การเก็บสถานะไว้ในหน่วยความจำจึงหายทุกครั้ง และการยิงฐานทุก request แค่เพื่อเช็ก session
// จะไปแย่งเวลาต่อ SQL ที่ช้าอยู่แล้ว (ดูคอมเมนต์เรื่อง connectionTimeout ใน lib/qcrdPool.js)
// ตั๋วที่เซ็นแล้วพกข้อมูลที่จำเป็นไปเอง เช็กได้โดยไม่ต้องแตะฐานเลย
//
// ⚠️ ใช้ Web Crypto (globalThis.crypto.subtle) ไม่ใช่ node:crypto เพราะ middleware.js
//    รันบน Edge runtime ซึ่งไม่มีโมดูลของ Node — ไฟล์นี้ต้องใช้ได้ทั้งสองฝั่ง
//
// ข้อจำกัดที่ยอมรับ: ตั๋วที่ออกไปแล้วเรียกคืนก่อนหมดอายุไม่ได้ ปิดการใช้งานผู้ใช้กลางคัน
// แล้วเขายังใช้ต่อได้จนตั๋วหมดอายุ (สูงสุด 12 ชม.) — จึงตั้งอายุสั้นไว้แทนที่จะเป็นหลายวัน

export const COOKIE_NAME = 'narai_session';

/** อายุตั๋ว 12 ชั่วโมง — ครอบกะทำงานหนึ่งกะพอดี ไม่ต้องล็อกอินกลางวัน */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * กุญแจที่ใช้เซ็น: AUTH_SECRET ก่อน ถ้าไม่มีก็ถอยไปใช้รหัสฐานข้อมูลที่ตั้งไว้แล้ว
 * (ค่าลับที่มีอยู่แล้วบน Vercel — ไม่ต้องตั้ง env ใหม่ก็ใช้งานได้ กติกาเดียวกับ lib/qcrdPool.js)
 * ไม่มีสักตัว = ระบบยังไม่ได้ตั้งค่า ใช้กุญแจตั้งต้นไปก่อนพร้อมเตือน (ดู secretIsWeak)
 */
function secretText() {
  return process.env.AUTH_SECRET
    || process.env.QCRD_DB_PASSWORD
    || process.env.ZK_DB_PASSWORD
    || process.env.HR_DB_PASSWORD
    || '';
}

/** true = ยังไม่ได้ตั้งค่าลับใด ๆ ตั๋วจึงปลอมได้ — หน้าเว็บเอาไปขึ้นแถบเตือนสีแดง */
export function secretIsWeak() {
  return !secretText();
}

const FALLBACK_SECRET = 'narai-office-setup-mode';

const enc = new TextEncoder();

let keyPromise = null;
let keyForSecret = null;

function hmacKey() {
  const s = secretText() || FALLBACK_SECRET;
  // กุญแจถูกใช้ทุก request — cache ไว้ แต่ถ้า env เปลี่ยน (deploy ใหม่) ต้องสร้างใหม่
  if (!keyPromise || keyForSecret !== s) {
    keyForSecret = s;
    keyPromise = crypto.subtle.importKey(
      'raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );
  }
  return keyPromise;
}

const b64urlEncode = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (text) => {
  const pad = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** เทียบสองสตริงแบบไม่ให้เวลาที่ใช้ฟ้องว่าตรงกันกี่ตัว (กันเดาลายเซ็นทีละไบต์) */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * ออกตั๋วให้ผู้ใช้หนึ่งคน
 * เก็บเฉพาะสิ่งที่หน้าเว็บต้องใช้ตัดสินใจ — ไม่มีรหัสผ่านหรือ hash อยู่ในตั๋ว
 */
export async function signSession(user, ttl = SESSION_TTL_SECONDS) {
  const payload = {
    u: user.username,
    n: user.displayName || user.username,
    r: user.role,
    p: user.perms || [],
    b: user.branchCode || '',
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * ตรวจตั๋ว — คืนข้อมูลผู้ใช้ หรือ null ถ้าลายเซ็นไม่ตรง/หมดอายุ/อ่านไม่ออก
 * ไม่โยน error เด็ดขาด: ตั๋วเสียคือ "ยังไม่ได้ล็อกอิน" ไม่ใช่ระบบพัง
 */
export async function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expect = b64urlEncode(new Uint8Array(
      await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body))
    ));
    if (!timingSafeEqual(sig, expect)) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload?.u || !payload?.exp) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return {
      username: payload.u,
      displayName: payload.n || payload.u,
      role: payload.r,
      perms: Array.isArray(payload.p) ? payload.p : [],
      branchCode: payload.b || '',
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

/** อ่านตั๋วจากหัว Cookie ดิบ (ใช้ได้ทั้ง req.headers.cookie และ Request ของ Edge) */
export function readTokenFromCookieHeader(header) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return '';
}

/**
 * อ่านตั๋วจาก request ของ API route — คืนข้อมูลผู้ใช้ หรือ null ถ้ายังไม่ได้ล็อกอิน
 * ใช้ร่วมกันทุกเส้นที่ต้องรู้ว่า "ตอนนี้เป็นใคร"
 */
export async function sessionFromRequest(req) {
  return verifySession(readTokenFromCookieHeader(req?.headers?.cookie));
}

/**
 * เข้ามาทาง https หรือเปล่า — ดูจาก x-forwarded-proto ที่ Vercel (และ reverse proxy ทั่วไป) แนบมา
 * ใช้ตัดสินว่าจะติดธง Secure ให้คุกกี้ไหม ไม่ใช่ NODE_ENV เพราะเครื่องที่ออฟฟิศก็รัน
 * `next start` (NODE_ENV=production) แต่เปิดผ่าน http ในวง LAN — ติด Secure ไปเบราว์เซอร์
 * จะทิ้งคุกกี้เงียบ ๆ แล้วกลายเป็นล็อกอินไม่ติดทั้งที่รหัสถูก
 */
const isHttps = (req) =>
  String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

/** ค่า Set-Cookie สำหรับตั๋วใหม่ — httpOnly กัน JS ในหน้าอ่านไปได้ */
export function sessionCookie(token, { req = null, maxAge = SESSION_TTL_SECONDS } = {}) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(req)) bits.push('Secure');
  return bits.join('; ');
}

/** ค่า Set-Cookie สำหรับล้างตั๋ว (ออกจากระบบ) */
export function clearSessionCookie(req = null) {
  return sessionCookie('', { req, maxAge: 0 });
}
