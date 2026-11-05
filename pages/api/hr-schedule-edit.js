// ออฟฟิศแก้ "ตารางงานที่ลงไว้" — ช่องฝั่งซ้ายของตารางในหน้า "ดูสแกนหน้า"
//
//   POST /api/hr-schedule-edit
//        { workDate, branch, hrCode, checkIn, checkOut, breakMinutes, breakStart, leaveNote, unpaidLeave }
//        → { status:'success', data:{ ...แถวตารางงานหลังแก้ (รูปเดียวกับ /api/hr-schedule) } }
//
// branch = รหัสที่เก็บจริงในแถว (plan.storedBranch) · leaveNote/unpaidLeave = รหัสลา (ว่างทั้งคู่ = มาทำงาน)
// breakMinutes '' = ไม่ได้ลงเบรค, 0 = ไม่เบรค, 30/60/... นาที
//
// เขียนทับแถวเดียวกับที่หน้าลงตารางของสาขา (Narai-branch) อ่าน สาขาจึงเห็นค่าใหม่ทันทีที่โหลดหน้า
// office-server คิดค่าแรงใหม่ด้วยสูตรเดียวกับหน้าสาขา และไม่ติดล็อกตารางงาน (ออฟฟิศแก้หลังปิดงวดได้)
// แก้ได้เฉพาะผู้ใช้ที่มีสิทธิ์เมนู "ดูสแกนหน้า" (หรือผู้ดูแลระบบ)
import { editScheduleEntry } from '../../lib/hrSchedule';
import { sessionFromRequest } from '../../lib/authToken';
import { hasPerm } from '../../lib/permissions';

export const config = { maxDuration: 30 };

const txt = (v) => (v == null ? '' : String(v).trim());

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ status: 'error', message: 'รองรับเฉพาะ POST' });
  }

  const me = await sessionFromRequest(req);
  if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });
  if (!hasPerm(me, 'attendance')) {
    return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์แก้ตารางงาน (ต้องมีสิทธิ์เมนู "ดูสแกนหน้า")' });
  }

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const entry = {
    workDate: txt(b.workDate),
    branch: txt(b.branch),
    hrCode: txt(b.hrCode),
    checkIn: txt(b.checkIn),
    checkOut: txt(b.checkOut),
    breakMinutes: txt(b.breakMinutes),
    breakStart: txt(b.breakStart),
    leaveNote: txt(b.leaveNote),
    unpaidLeave: txt(b.unpaidLeave),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.workDate) || !entry.branch || !entry.hrCode) {
    return res.status(400).json({ status: 'error', message: 'ระบุวันที่/สาขา/รหัสพนักงานไม่ครบ' });
  }

  try {
    const data = await editScheduleEntry(entry, me.displayName || me.username);
    return res.status(200).json({ status: 'success', data });
  } catch (err) {
    const message = err?.message || 'แก้ตารางงานไม่สำเร็จ';
    console.error('hr-schedule-edit API error:', message);
    const status = err?.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({
      status: 'error',
      message,
      hint: /ไม่รู้จักคำสั่ง/.test(message)
        ? 'office-server ที่ออฟฟิศยังเป็นรุ่นเก่า — อัปเดตด้วย update-office-server.bat แล้วลองใหม่'
        : undefined,
    });
  }
}
