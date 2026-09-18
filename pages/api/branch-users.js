// login ของสาขา — อ่าน/เขียนตาราง narai_hr.dbo.hr_user (ฐานของระบบลงตารางงาน)
//
//   GET  /api/branch-users   -> รายชื่อบัญชีสาขาทั้งหมด (ไม่มีรหัสผ่านติดมาไม่ว่าทางไหน)
//   POST /api/branch-users   -> { action: 'saveBranchUser' | 'setBranchUserPassword' | 'deleteBranchUser', ... }
//
// ⚠️ ผู้ดูแลระบบ (role='admin') เท่านั้น — เส้นนี้ตั้งรหัสผ่านให้บัญชีสาขาได้
//    ซึ่งแปลว่าเข้าระบบลงตารางงานในนามสาขานั้นได้ กติกาเดียวกับ /api/users
//    (ต่างจาก /api/branches ที่ไม่ได้กันอะไร เพราะแค่แก้ทะเบียนสาขา)
//
// ⚠️ ตารางนี้อยู่คนละฐานกับทุกอย่างในโฟลเดอร์นี้ (narai_hr ไม่ใช่ InventoryNarai)
//    แต่อยู่บนอินสแตนซ์ SQL เดียวกัน จึงยิงด้วยชื่อสามท่อนจากคอนเนกชันเดิมได้
//    ไม่ได้ย้ายตาราง ไม่ได้แตะโค้ดของ Narai-branch — ฝั่งนั้นยังอ่านเขียนตารางเดิมต่อไปตามปกติ
//    ต้องให้สิทธิ์ข้ามฐานก่อน: docs/grant-hr-user.sql
//
// ทางไปถึงฐานใช้ชุดเดียวกับ /api/branches (lib/sheetsSource.js เลือกให้) แต่ในทางปฏิบัติ
// ใช้ได้ทางเดียวคือ host API ที่เครื่องออฟฟิศ เพราะฐาน narai_hr อยู่บนเครื่องนั้น
import {
  readBranchUsers, saveBranchUserRow, setBranchUserPasswordRow, deleteBranchUserRow,
} from '../../lib/sheetsSource';
import { sessionFromRequest } from '../../lib/authToken';
import { ROLE_ADMIN } from '../../lib/permissions';

export const config = { maxDuration: 60 };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** แปลง error ที่ผู้ใช้แก้เองได้ ให้เป็นข้อความที่บอกวิธีแก้ */
function explain(err) {
  const msg = err?.message || String(err);
  if (/permission was denied|SELECT permission|principal.*not able to access/i.test(msg)) {
    return 'login ที่แดชบอร์ดใช้ยังไม่มีสิทธิ์อ่าน/เขียนฐาน narai_hr — ' +
      'รัน docs/grant-hr-user.sql ที่เครื่องออฟฟิศ';
  }
  if (/Invalid object name .*hr_user/i.test(msg)) {
    return 'มองไม่เห็นตาราง narai_hr.dbo.hr_user — ตรวจว่ารันอยู่บนเครื่องที่มีฐานนั้น ' +
      'และให้สิทธิ์ข้ามฐานแล้ว (docs/grant-hr-user.sql)';
  }
  return msg;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const me = await sessionFromRequest(req);
  if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });
  if (me.role !== ROLE_ADMIN) {
    return res.status(403).json({
      status: 'error',
      message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการ login ของสาขาได้',
    });
  }

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ status: 'success', data: await readBranchUsers() });
    } catch (err) {
      console.error('branch-users: อ่านรายชื่อบัญชีสาขาไม่ได้:', err.message);
      // ⭐ ต่างจาก /api/branches ตรงที่ "ไม่มีรายชื่อสำรอง" ให้ถอยไปใช้ — บัญชีล็อกอิน
      //    จะเดาหรือฝังไว้ในโค้ดไม่ได้ อ่านไม่ได้ต้องบอกตรง ๆ ว่าอ่านไม่ได้
      //    ตอบลิสต์ว่างพร้อม warning ดีกว่าจอแดง เพราะ "ยังไม่มีบัญชีสักคน" ก็หน้าตาแบบนี้
      return res.status(200).json({
        status: 'success', data: [], tableReady: false,
        warning: `อ่านรายชื่อบัญชีสาขาไม่ได้ (${explain(err)})`,
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

  const WRITERS = {
    saveBranchUser: saveBranchUserRow,
    setBranchUserPassword: setBranchUserPasswordRow,
    deleteBranchUser: deleteBranchUserRow,
  };
  const write = WRITERS[action];
  if (!write) {
    return res.status(200).json({ status: 'error', message: `ไม่รู้จักคำสั่ง ${action || '(ว่าง)'}` });
  }

  try {
    const out = await write(body);
    // ⚠️ อย่าเอา body ลง log — มี password อยู่ในนั้น บันทึกของ Vercel เก็บไว้หลายวัน
    console.info(`branch-users: ${action} ${str(body.username)} โดย ${me.username}`);
    return res.status(200).json({ status: 'success', data: out });
  } catch (err) {
    console.error(`branch-users: ${action} ไม่สำเร็จ:`, err.message);
    return res.status(200).json({ status: 'error', message: explain(err) });
  }
}
