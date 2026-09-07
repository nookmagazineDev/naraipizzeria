// ผู้ใช้และสิทธิ์เมนู — อ่าน/เขียนตาราง InventoryNarai.dbo.app_user
//
//   GET  /api/users     -> รายชื่อผู้ใช้ทั้งหมด + สถานะการตั้งค่า
//   POST /api/users     -> { action: 'saveUser' | 'deleteUser' | 'resetPassword' | 'createTable', ... }
//
// ⚠️ ผู้ดูแลระบบ (role='admin') เท่านั้น — เส้นนี้แจกสิทธิ์เข้าถึงทุกเมนูของแดชบอร์ดได้
//    ต่างจาก /api/branches ที่ไม่ได้กันอะไรไว้เลย เพราะแค่แก้ทะเบียนสาขา
//
// ต่อฐานด้วย pool เดียวกับ QC/RD (lib/qcrdPool.js) ซึ่งชี้ InventoryNarai อยู่แล้ว
// คืน 200 พร้อม status:'error' เหมือน /api/branches ยกเว้น 401/403 ที่หน้าเว็บใช้แยกกรณี
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runQuery } from '../../lib/qcrdPool';
import {
  deleteUser, explainUserError, hasDirectDb, hasEnvAdmin, listUsers,
  saveUser, setPassword, setupModeActive, tableIsReady,
} from '../../lib/authUsers';
import { secretIsWeak, sessionFromRequest } from '../../lib/authToken';
import { ROLE_ADMIN, validatePassword, validateUsername } from '../../lib/permissions';

export const config = { maxDuration: 60 };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** สร้างตารางจาก docs/schema-app-user.sql (รันซ้ำได้ ไม่ทับข้อมูลเดิม) */
async function createTable() {
  // next.config.js สั่งแนบไฟล์นี้ไปกับฟังก์ชัน ไม่งั้นบน Vercel จะขึ้น ENOENT
  const file = path.join(process.cwd(), 'docs', 'schema-app-user.sql');
  const sqlText = await readFile(file, 'utf8');
  const batches = sqlText.split(/^\s*GO\s*;?\s*$/gim).map((b) => b.trim()).filter(Boolean);
  // ชุด CREATE DATABASE/USE รันจากคอนเนกชันที่ชี้ฐานนั้นอยู่แล้วไม่ได้ (และไม่จำเป็น)
  const runnable = batches.filter((b) => !/CREATE\s+DATABASE|^\s*USE\s+/im.test(b));
  let ran = 0;
  for (const b of runnable) { await runQuery(b); ran++; }
  return { ran, of: runnable.length };
}

async function stateOf() {
  const tableReady = await tableIsReady();
  return {
    tableReady,
    hasDb: hasDirectDb(),
    canWrite: hasDirectDb(),
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
        warning: hasDirectDb()
          ? 'ยังไม่ได้สร้างตารางผู้ใช้ — กดปุ่ม "สร้างตาราง" เพื่อเริ่มใช้งาน'
          : 'ยังไม่ได้ตั้งรหัสฐานข้อมูลบน Vercel (QCRD_DB_USER/QCRD_DB_PASSWORD) — ' +
            'เก็บผู้ใช้ลงฐานยังไม่ได้ ตอนนี้เข้าระบบได้ด้วยบัญชีสำรองเท่านั้น',
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

  if (!hasDirectDb()) {
    return res.status(200).json({
      status: 'error',
      message: 'แก้คลังผู้ใช้ไม่ได้ — ยังไม่ได้ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD บน Vercel ' +
        '(หรือ ZK_DB_* / HR_DB_* ที่มีสิทธิ์ในฐาน InventoryNarai)',
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
