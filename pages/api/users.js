// ผู้ใช้และสิทธิ์เมนู — อ่าน/เขียนตาราง InventoryNarai.dbo.app_user
//
//   GET  /api/users     -> รายชื่อผู้ใช้ทั้งหมด + สถานะการตั้งค่า
//   POST /api/users     -> { action: 'saveUser' | 'deleteUser' | 'resetPassword' | 'createTable', ... }
//
// ⚠️ ผู้ดูแลระบบ (role='admin') เท่านั้น — เส้นนี้แจกสิทธิ์เข้าถึงทุกเมนูของแดชบอร์ดได้
//    ต่างจาก /api/branches ที่ไม่ได้กันอะไรไว้เลย เพราะแค่แก้ทะเบียนสาขา
//
// ไปถึงฐานสองทาง (ต่อ SQL ตรง หรือ host API ที่เครื่องออฟฟิศ) — lib/authUsers.js เป็นคนเลือกให้
// คืน 200 พร้อม status:'error' เหมือน /api/branches ยกเว้น 401/403 ที่หน้าเว็บใช้แยกกรณี
import {
  createTable, deleteUser, explainUserError, hasAnyRoute, hasDirectDb, hasEnvAdmin,
  hasHostRoute, listUsers, saveUser, setPassword, setupModeActive, tableIsReady,
} from '../../lib/authUsers';
import { secretIsWeak, sessionFromRequest } from '../../lib/authToken';
import { ROLE_ADMIN, validatePassword, validateUsername } from '../../lib/permissions';

export const config = { maxDuration: 60 };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

async function stateOf() {
  const tableReady = await tableIsReady();
  return {
    tableReady,
    hasDb: hasDirectDb(),
    hasHost: hasHostRoute(),
    // เขียนได้ถ้ามีทางไปถึงฐานสักทาง — ต่อ SQL ตรงจาก Vercel หรือผ่าน host API ที่ออฟฟิศ
    canWrite: hasAnyRoute(),
    setupMode: setupModeActive({ tableReady }),
    weakSecret: secretIsWeak(),
    hasEnvAdmin: hasEnvAdmin(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const me = await sessionFromRequest(req);
  if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });
  if (me.role !== ROLE_ADMIN) {
    return res.status(403).json({ status: 'error', message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการผู้ใช้ได้' });
  }

  if (req.method === 'GET') {
    const state = await stateOf();
    if (!state.tableReady) {
      // ยังไม่มีตาราง = ยังไม่มีผู้ใช้สักคน — ตอบรายการว่างพร้อมคำเตือน ไม่ใช่ error
      // (หน้าเว็บจะได้ขึ้นปุ่ม "สร้างตาราง" ให้กด แทนที่จะโชว์แดงแล้วจบ)
      return res.status(200).json({
        status: 'success', data: [], ...state,
        warning: hasAnyRoute()
          ? 'ยังไม่ได้สร้างตารางผู้ใช้ หรือยังไปถึงฐานไม่ได้ — กดปุ่ม "สร้างตาราง" เพื่อเริ่มใช้งาน'
          : 'ยังไม่มีทางไปถึงฐานข้อมูลผู้ใช้ — ตั้ง AUTH_API_KEY (หรือ QCRD_WRITE_KEY) บน Vercel ' +
            'ให้ตรงกับเครื่องออฟฟิศ ตอนนี้เข้าระบบได้ด้วยบัญชีสำรองเท่านั้น',
      });
    }
    try {
      return res.status(200).json({ status: 'success', data: await listUsers(), ...state });
    } catch (err) {
      console.error('users: อ่านคลังผู้ใช้ไม่ได้:', err.message);
      return res.status(200).json({
        status: 'success', data: [], ...state, tableReady: false,
        warning: `อ่านคลังผู้ใช้จากฐานไม่ได้ (${explainUserError(err)})`,
      });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'GET หรือ POST เท่านั้น' });
  }

  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })()
    : (req.body || {});
  const action = str(body.action);

  if (!hasAnyRoute()) {
    return res.status(200).json({
      status: 'error',
      message: 'แก้คลังผู้ใช้ไม่ได้ — ยังไม่มีทางไปถึงฐาน InventoryNarai สักทาง ' +
        'ตั้ง AUTH_API_KEY (หรือ QCRD_WRITE_KEY) บน Vercel ให้ตรงกับที่ตั้งไว้บนเครื่องออฟฟิศ ' +
        'หรือตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD ถ้าเปิดพอร์ต SQL ออกเน็ตแล้ว',
    });
  }

  try {
    if (action === 'createTable') {
      const out = await createTable();
      return res.status(200).json({ status: 'success', data: out });
    }

    if (action === 'saveUser') {
      const bad = validateUsername(body.username);
      if (bad) return res.status(200).json({ status: 'error', message: bad });
      if (body.password) {
        const badPwd = validatePassword(body.password);
        if (badPwd) return res.status(200).json({ status: 'error', message: badPwd });
      }
      const out = await saveUser(body, { actor: me.username });
      return res.status(200).json({ status: 'success', data: out });
    }

    if (action === 'deleteUser') {
      const out = await deleteUser(body.username, { actor: me.username });
      return res.status(200).json({ status: 'success', data: out });
    }

    if (action === 'resetPassword') {
      const bad = validatePassword(body.password);
      if (bad) return res.status(200).json({ status: 'error', message: bad });
      const out = await setPassword(body.username, body.password, { actor: me.username });
      return res.status(200).json({ status: 'success', data: out });
    }

    return res.status(200).json({ status: 'error', message: `ไม่รู้จักคำสั่ง ${action || '(ว่าง)'}` });
  } catch (err) {
    console.error(`users: ${action} ไม่สำเร็จ:`, err.message);
    return res.status(200).json({ status: 'error', message: explainUserError(err) });
  }
}
