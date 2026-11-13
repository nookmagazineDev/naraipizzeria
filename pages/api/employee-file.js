// ไฟล์แนบเอกสาร/รูปพนักงานที่เก็บบนเครื่องออฟฟิศ — GET /api/employee-file?path=attachments/xxx.pdf
//
// ไฟล์ย้ายจาก Google Drive มาเก็บที่ office-server (ดู office-server/employee-hr.js ของ Narai-branch)
// ในฐานข้อมูลเก็บเป็น 'file:<path>' หน้าเว็บแปลงเป็นลิงก์มาที่นี่
// ไฟล์แนบเป็นข้อมูลส่วนบุคคล (สำเนาบัตร/สมุดบัญชี) — ต้องมีสิทธิ์เมนู "รายชื่อพนักงาน"
import { fetchOfficeFile } from '../../lib/hrSchedule';
import { sessionFromRequest } from '../../lib/authToken';
import { hasPerm } from '../../lib/permissions';

export const config = { maxDuration: 30, api: { responseLimit: '20mb' } };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: 'error', message: 'GET เท่านั้น' });
  const me = await sessionFromRequest(req);
  if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });
  if (!hasPerm(me, 'employeeList')) {
    return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์ดูไฟล์พนักงาน (ต้องมีสิทธิ์เมนู "รายชื่อพนักงาน")' });
  }
  const path = String(req.query.path || '');
  if (!/^(photos|attachments)\/[^/\\]+$/.test(path) || path.includes('..')) {
    return res.status(400).json({ status: 'error', message: 'path ไม่ถูกต้อง' });
  }
  try {
    const r = await fetchOfficeFile(path);
    if (!r.ok) return res.status(r.status).json({ status: 'error', message: 'ไม่พบไฟล์ (อาจถูกลบไปแล้ว)' });
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error('employee-file:', err.message);
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
