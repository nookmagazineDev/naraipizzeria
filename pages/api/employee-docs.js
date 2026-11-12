// สัญชาติ + เอกสารพนักงานต่างชาติ — หน้า HR → "รายชื่อพนักงาน" (กดที่ชื่อ / กล่องแจ้งเตือนวันหมดอายุ)
//
//   GET  /api/employee-docs
//        → { status:'success', data:[{ docId, branch, hrCode, fullName, natType, country, ...เอกสาร+วันหมดอายุ }] } ทุกสาขา
//   POST /api/employee-docs { action, ...payload }
//        action = save   { hrCode | docId, branch, fullName, natType, ...ช่องข้อมูล }  → { doc }
//                 link   { docId, hrCode }     ผูกแถวจาก Excel ที่ชื่อไม่ตรง เข้ากับพนักงานในระบบ
//                 delete { docId }             ลบแถวที่ยังไม่ได้ผูก
//                 import { rows:[...] }        นำเข้าทั้งไฟล์ Excel "DATA พนักงานต่างชาติ"
//
// ข้อมูลอยู่ที่ dbo.employee_doc ตารางเดียวกับที่เว็บสาขา (Narai-branch) อ่าน-เขียน ตรรกะทั้งหมดอยู่ที่
// office-server/employee-doc.js ของรีโปนั้น ที่นี่แค่ส่งต่อคำสั่งด้วยสิทธิ์ all (ทางเดียวกับ /api/hr-schedule)
//   เบราว์เซอร์ -> /api/employee-docs -> office-server :8787/schedule -> SQL Server
// สาขาแก้ที่เว็บสาขา ออฟฟิศแก้ที่นี่ — เห็นค่าเดียวกันทันทีที่โหลดหน้า
import { callSchedule } from '../../lib/hrSchedule';
import { sessionFromRequest } from '../../lib/authToken';
import { hasPerm } from '../../lib/permissions';

// นำเข้าทั้งไฟล์ (ร้อยกว่าแถวใน transaction เดียว) ใช้เวลานานกว่าคำสั่งทั่วไป
export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '2mb' } } };

const ACTIONS = {
  save: 'saveEmployeeDoc',
  link: 'linkEmployeeDoc',
  delete: 'deleteEmployeeDoc',
  import: 'importEmployeeDocs',
};

function failed(res, err, what) {
  const message = err?.message || `${what}ไม่สำเร็จ`;
  console.error('employee-docs API error:', message);
  const status = err?.status && err.status < 500 ? err.status : 502;
  return res.status(status).json({
    status: 'error',
    message,
    hint: /ไม่รู้จักคำสั่ง/.test(message)
      ? 'office-server ที่ออฟฟิศยังเป็นรุ่นเก่า — อัปเดตด้วย update-office-server.bat (รีโป Narai-branch) แล้วลองใหม่'
      : undefined,
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const me = await sessionFromRequest(req);
  if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });
  // เลขพาสปอร์ต/เลขบัญชีเป็นข้อมูลส่วนบุคคล — ให้เฉพาะคนที่มีสิทธิ์เมนู "รายชื่อพนักงาน"
  if (!hasPerm(me, 'employeeList')) {
    return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์ดูข้อมูลพนักงาน (ต้องมีสิทธิ์เมนู "รายชื่อพนักงาน")' });
  }
  const as = me.displayName || me.username;

  if (req.method === 'GET') {
    try {
      const out = await callSchedule('getEmployeeDocs', { branch: 'all' }, { what: 'ดึงข้อมูลเอกสารพนักงาน', as });
      return res.status(200).json({ status: 'success', ready: out?.ready !== false, data: out?.data || [] });
    } catch (err) {
      return failed(res, err, 'ดึงข้อมูลเอกสารพนักงาน');
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ status: 'error', message: 'รองรับเฉพาะ GET และ POST' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = ACTIONS[String(body.action || '').trim()];
  if (!action) return res.status(400).json({ status: 'error', message: `unknown action: ${body.action}` });

  // ไม่ส่ง action/_user ของฝั่งเบราว์เซอร์ต่อไป — _user ต้องเป็นตัวที่ callSchedule แนบให้เท่านั้น
  const { action: _a, _user: _u, ...payload } = body;
  try {
    const data = await callSchedule(action, payload, { what: 'บันทึกข้อมูลเอกสารพนักงาน', as });
    return res.status(200).json({ status: 'success', data, message: data?.message });
  } catch (err) {
    return failed(res, err, 'บันทึกข้อมูลเอกสารพนักงาน');
  }
}
