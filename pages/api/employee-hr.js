// พนักงาน (ฝั่งออฟฟิศ): ข้อมูลส่วนตัว / ประวัติพนักงานเข้า-ออก / นำเข้าข้อมูลเดิมจากชีท
//
//   GET  /api/employee-hr?view=profiles
//        → { data:[{ hrCode, phone, address, idCard, birthday, lineId, nationality, documents, attachments[] }] }
//   GET  /api/employee-hr?view=movements&start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=sum]
//        → { data:[{ kind:'in'|'out', hrCode, fullName, branch, ..., recordedAt }] }   ดูอย่างเดียว
//   POST /api/employee-hr { action:'saveProfile', hrCode, phone, address, idCard, birthday, lineId } → { profile }
//   POST /api/employee-hr { action:'import', kind:'employees'|'movements', rows:[...], reset? }
//
// ข้อมูลอยู่ที่ SQL (ตารางเดียวกับเว็บสาขา) ตรรกะทั้งหมดอยู่ที่ office-server/employee-hr.js ของรีโป Narai-branch
// ที่นี่ส่งต่อคำสั่งด้วยสิทธิ์ all (ทางเดียวกับ /api/hr-schedule) — คำสั่งชุดนี้ office-server ให้เฉพาะสิทธิ์ all
import { callSchedule } from '../../lib/hrSchedule';
import { sessionFromRequest } from '../../lib/authToken';
import { hasPerm } from '../../lib/permissions';

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '4mb' } } };

const txt = (v) => (v == null ? '' : String(v).trim());

function failed(res, err) {
  const message = err?.message || 'ทำรายการไม่สำเร็จ';
  console.error('employee-hr API error:', message);
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
  if (!hasPerm(me, 'employeeList')) {
    return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์ดูข้อมูลพนักงาน (ต้องมีสิทธิ์เมนู "รายชื่อพนักงาน")' });
  }
  const as = me.displayName || me.username;

  if (req.method === 'GET') {
    const view = txt(req.query.view);
    try {
      if (view === 'profiles') {
        const out = await callSchedule('getEmployeeProfiles', {}, { what: 'ดึงข้อมูลส่วนตัวพนักงาน', as });
        return res.status(200).json({ status: 'success', ready: out?.ready !== false, data: out?.data || [] });
      }
      if (view === 'movements') {
        const out = await callSchedule('getEmployeeMovements', {
          start: txt(req.query.start), end: txt(req.query.end), branch: txt(req.query.branch),
        }, { what: 'ดึงประวัติพนักงานเข้า-ออก', as });
        return res.status(200).json({ status: 'success', ready: out?.ready !== false, data: out?.data || [] });
      }
    } catch (err) {
      return failed(res, err);
    }
    return res.status(400).json({ status: 'error', message: 'view ต้องเป็น profiles หรือ movements' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ status: 'error', message: 'รองรับเฉพาะ GET และ POST' });
  }
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    if (b.action === 'saveProfile') {
      const data = await callSchedule('saveEmployeeProfile', {
        hrCode: txt(b.hrCode), phone: txt(b.phone), address: txt(b.address),
        idCard: txt(b.idCard), birthday: txt(b.birthday), lineId: txt(b.lineId),
      }, { what: 'บันทึกข้อมูลส่วนตัวพนักงาน', as });
      return res.status(200).json({ status: 'success', data, message: data?.message });
    }
    if (b.action === 'import') {
      const data = await callSchedule('importEmployeeSheet', {
        kind: txt(b.kind), rows: Array.isArray(b.rows) ? b.rows : [], reset: b.reset === true,
      }, { what: 'นำเข้าข้อมูลพนักงาน', as });
      return res.status(200).json({ status: 'success', data });
    }
  } catch (err) {
    return failed(res, err);
  }
  return res.status(400).json({ status: 'error', message: `unknown action: ${b.action}` });
}
