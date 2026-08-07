// ประวัติสแกนหน้า/สแกนนิ้ว — ต่อฐาน ZKBio Time 9 (SQL Server) โดยตรง
// ข้อมูลชุดเดียวกับหน้า "สแกนเข้า-ออก" ของโปรเจค Narai-branch (ที่นั่น office-server เป็นตัวต่อ DB ให้)
//
//   GET /api/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&emp=รหัสพนักงาน]
//   → { status:'success', branch, start, end, count, truncated, data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }
//
// การเชื่อมต่อ/คิวรี่อยู่ใน lib/zkDb.js (ตั้งค่าผ่าน env ZK_DB_*)
import { getZkPool, zkNameMap, queryPunches, ZK_ROW_CAP } from '../../lib/zkDb';

// ป้ายกำกับตามมาตรฐาน ZKTeco — แต่ละเครื่องตั้งค่าปุ่มไม่เหมือนกัน หน้าเว็บจึงคิด "เข้า/ออก"
// จากลำดับเวลาสแกนของวันด้วย ไม่ได้อิง punch_state อย่างเดียว (ดู lib/attendance.js)
const PUNCH_LABEL = { '0': 'เข้างาน', '1': 'ออกงาน', '2': 'พักออก', '3': 'พักเข้า', '4': 'OT เข้า', '5': 'OT ออก' };

const txt = (v) => (v == null ? '' : String(v).trim());

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** end คือวันสุดท้ายที่ต้องการ -> เทียบแบบ < วันถัดไป เพื่อให้ครอบคลุมทั้งวัน */
export function exclusiveEnd(end) {
  const d = new Date(end + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** แปลงแถวดิบจาก SQL + ชื่อพนักงาน ให้เป็นรูปที่หน้าเว็บใช้ */
export function mapPunchRows(rows, nameOf = {}) {
  return (rows || []).map((r) => {
    const code = txt(r.empCode);
    const time = txt(r.time);
    const state = txt(r.state);
    return {
      empCode: code,
      name: nameOf[code] || '',
      time,
      date: time.slice(0, 10),
      state,
      stateLabel: PUNCH_LABEL[state] || '',
      area: txt(r.area),
      terminal: txt(r.terminal),
    };
  });
}

export default async function handler(req, res) {
  const start = txt(req.query.start);
  const end = txt(req.query.end);
  const branch = txt(req.query.branch).toUpperCase();
  const emp = txt(req.query.emp);

  if (!start || !end) {
    return res.status(400).json({ status: 'error', message: 'ต้องระบุ start และ end' });
  }
  if (!isYmd(start) || !isYmd(end)) {
    return res.status(400).json({ status: 'error', message: 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD' });
  }
  if (start > end) {
    return res.status(400).json({ status: 'error', message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
  }

  try {
    const pool = await getZkPool();
    const [rows, nameOf] = await Promise.all([
      queryPunches(pool, { start, endExclusive: exclusiveEnd(end), branch, emp }),
      zkNameMap(pool),
    ]);

    const data = mapPunchRows(rows, nameOf);
    const truncated = rows.length >= ZK_ROW_CAP;

    return res.status(200).json({
      status: 'success',
      branch, start, end,
      count: data.length,
      truncated,
      ...(truncated ? { message: `ข้อมูลถูกตัดที่ ${ZK_ROW_CAP.toLocaleString()} รายการ — ช่วงวันที่กว้างเกินไป กรุณาแคบช่วงลงหรือเลือกสาขา` } : {}),
      data,
    });
  } catch (err) {
    console.error('attendance API error:', err.message);
    // ยังไม่ได้ตั้ง env = ปัญหาคนละแบบกับต่อ DB ไม่ได้ แยก code ให้หน้าเว็บขึ้นวิธีแก้ถูก
    const code = /ยังไม่ได้ตั้งค่า/.test(err.message) ? 'ZK_NOT_CONFIGURED' : 'ZK_CONNECT_FAILED';
    return res.status(502).json({ status: 'error', code, message: err.message || 'ดึงข้อมูลการสแกนไม่สำเร็จ' });
  }
}
