// เข้าสู่ระบบ / ออกจากระบบ / ถามว่าตอนนี้เป็นใคร
//
//   GET  /api/auth                 -> { user, setupMode, weakSecret, tableReady }
//   POST /api/auth  action=login   -> { username, password }  ตั้งคุกกี้ตั๋วให้
//   POST /api/auth  action=logout  -> ล้างคุกกี้
//   POST /api/auth  action=changePassword -> { currentPassword, newPassword } (ของตัวเองเท่านั้น)
//
// เส้นนี้เป็นเส้นเดียวที่ middleware.js ปล่อยผ่านโดยไม่ต้องมีตั๋ว — ไม่งั้นก็ล็อกอินไม่ได้
//
// คืน 200 พร้อม status:'error' เหมือน /api/branches และ /api/qcrd-save (หน้าเว็บอ่านข้อความไปแสดงตรง ๆ)
// ยกเว้น 401 ตอนถามข้อมูลของคนที่ยังไม่ได้ล็อกอิน ซึ่งหน้าเว็บใช้แยกว่า "ให้เด้งไปหน้าล็อกอิน"
import {
  authenticate, changeOwnPassword, hasDirectDb, setupModeActive, tableIsReady,
} from '../../lib/authUsers';
import {
  clearSessionCookie, secretIsWeak, sessionCookie, sessionFromRequest, signSession,
} from '../../lib/authToken';
import { validatePassword } from '../../lib/permissions';

export const config = { maxDuration: 30 };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * กันเดารหัสผ่านรัว ๆ — นับความพยายามที่ล้มเหลวต่อชื่อผู้ใช้ไว้ในหน่วยความจำของ container
 *
 * ⚠️ ไม่ใช่การกันแบบจริงจัง: Vercel มีหลาย container และปลุก-ดับตลอด ตัวนับจึงรีเซ็ตเอง
 *    ได้ตลอดเวลา แต่ก็พอทำให้สคริปต์ยิงรัวจากที่เดียวช้าลงมาก โดยไม่ต้องเพิ่มตารางหรือบริการใหม่
 *    จะเอาจริงต้องไปทำที่ชั้นหน้าเว็บ (Vercel WAF / Cloudflare)
 */
const g = globalThis;
g.__authThrottle = g.__authThrottle || new Map();
const MAX_FAILS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function throttleCheck(key) {
  const rec = g.__authThrottle.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) return null;
  if (rec.count < MAX_FAILS) return null;
  const waitMin = Math.ceil((WINDOW_MS - (Date.now() - rec.first)) / 60000);
  return `ลองผิดหลายครั้งเกินไป — รออีกประมาณ ${waitMin} นาทีแล้วค่อยลองใหม่`;
}

function throttleFail(key) {
  const rec = g.__authThrottle.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    g.__authThrottle.set(key, { first: Date.now(), count: 1 });
  } else {
    rec.count++;
  }
}

/** สถานะการตั้งค่าที่หน้าเว็บเอาไปขึ้นแถบเตือน (ไม่มีอะไรลับอยู่ในนี้) */
async function setupState() {
  const tableReady = await tableIsReady();
  return {
    tableReady,
    hasDb: hasDirectDb(),
    setupMode: setupModeActive({ tableReady }),
    weakSecret: secretIsWeak(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const user = await sessionFromRequest(req);
    // ตอนยังไม่ได้ล็อกอินยังต้องบอกสถานะการตั้งค่าได้ — หน้าล็อกอินเอาไปขึ้นแถบเตือน
    // ว่ายังไม่ได้สร้างตาราง/ยังใช้รหัสตั้งต้นอยู่ ไม่งั้นคนตั้งระบบครั้งแรกจะงงว่าเข้าด้วยอะไร
    return res.status(200).json({ status: 'success', data: { user, ...(await setupState()) } });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'GET หรือ POST เท่านั้น' });
  }

  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })()
    : (req.body || {});
  const action = str(body.action);

  if (action === 'logout') {
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    return res.status(200).json({ status: 'success', data: { user: null } });
  }

  if (action === 'login') {
    const username = str(body.username).toLowerCase();
    // นับแยกตาม "ชื่อผู้ใช้ + ที่มา" ไม่ใช่ชื่อผู้ใช้อย่างเดียว — ไม่งั้นใครก็ยิงรหัสมั่ว ๆ
    // ใส่ชื่อคนอื่นเพื่อล็อกเขาไม่ให้เข้างานได้ (Vercel เป็นคนใส่ x-forwarded-for ให้)
    const from = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const throttleKey = `${username}|${from}`;
    const blocked = throttleCheck(throttleKey);
    if (blocked) return res.status(200).json({ status: 'error', message: blocked });

    try {
      const out = await authenticate(username, body.password);
      if (!out.ok) {
        throttleFail(throttleKey);
        return res.status(200).json({ status: 'error', message: out.message });
      }
      g.__authThrottle.delete(throttleKey);
      res.setHeader('Set-Cookie', sessionCookie(await signSession(out.user), { req }));
      return res.status(200).json({
        status: 'success',
        data: { user: out.user, ...(await setupState()) },
      });
    } catch (err) {
      console.error('auth: login ไม่สำเร็จ:', err.message);
      return res.status(200).json({ status: 'error', message: err.message });
    }
  }

  if (action === 'changePassword') {
    const me = await sessionFromRequest(req);
    if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });

    const bad = validatePassword(body.newPassword);
    if (bad) return res.status(200).json({ status: 'error', message: bad });

    try {
      await changeOwnPassword(me.username, str(body.currentPassword), String(body.newPassword));
      // เปลี่ยนรหัสแล้วออกตั๋วใหม่ให้ทันที — ตั๋วเดิมยังใช้ได้จนหมดอายุอยู่ดี (เรียกคืนไม่ได้)
      // แต่การต่ออายุตรงนี้ทำให้คนที่เพิ่งเปลี่ยนรหัสไม่โดนเด้งออกกลางคัน
      res.setHeader('Set-Cookie', sessionCookie(await signSession(me), { req }));
      return res.status(200).json({ status: 'success', data: { username: me.username } });
    } catch (err) {
      return res.status(200).json({ status: 'error', message: err.message });
    }
  }

  return res.status(200).json({ status: 'error', message: `ไม่รู้จักคำสั่ง ${action || '(ว่าง)'}` });
}
