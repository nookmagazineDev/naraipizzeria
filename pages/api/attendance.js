// ประวัติสแกนหน้า/สแกนนิ้ว — ต่อฐาน ZKBio Time 9 (SQL Server) โดยตรง
// ข้อมูลชุดเดียวกับหน้า "สแกนเข้า-ออก" ของโปรเจค Narai-branch (ที่นั่น office-server เป็นตัวต่อ DB ให้)
//
//   GET /api/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&emp=รหัสพนักงาน]
//   → { status:'success', branch, start, end, count, truncated, data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }
//
// การเชื่อมต่อ/คิวรี่อยู่ใน lib/zkDb.js (ตั้งค่าผ่าน env ZK_DB_*)
//
// ดึงผ่าน host API (/zk/transactions) ที่รันบนเครื่องออฟฟิศเครื่องเดียวกับ SQL Server
// เป็นทางหลัก — ทางเดียวกับ /api/sales และ AI NARAI ที่ใช้งานได้อยู่แล้ว จึงไม่ต้อง
// เปิดพอร์ต SQL ออกอินเทอร์เน็ต ถ้ามีการตั้ง ZK_DB_USER/ZK_DB_PASSWORD ไว้
// จะลองต่อ SQL ตรงเป็นทางสำรองให้อีกชั้น
import {
  fetchPunchesViaHost, fetchNamesViaHost, hasDirectDbConfig, ZK_API_BASE,
  getZkPool, zkNameMap, queryPunches, ZK_ROW_CAP,
} from '../../lib/zkDb';

// ช่วงกว้างๆ ทุกสาขาใช้เวลาหลายสิบวินาที — เผื่อเวลาให้พอเหมือน /api/sales
export const config = { maxDuration: 60 };

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

/** error ที่ติด code มาด้วย เพื่อให้หน้าเว็บขึ้นคำแนะนำได้ตรงสาเหตุ */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * ดึงรายการสแกน: host API ก่อน ถ้าไม่ได้ค่อยลองต่อ SQL ตรง (เมื่อตั้งรหัสไว้)
 * คืน { rows, nameOf, source } — source ไว้ดูว่าข้อมูลรอบนี้มาจากทางไหน
 * โยน error ที่รวมสาเหตุของทั้งสองทางไว้ เพื่อให้รู้ว่าต้องไปแก้ตรงไหน
 */
async function loadPunches({ start, end, branch, emp }) {
  let hostErr;
  try {
    const [rows, nameOf] = await Promise.all([
      fetchPunchesViaHost({ start, end, branch, emp }),
      fetchNamesViaHost(), // ดึงชื่อไม่ได้ก็คืน {} ให้ ไม่ทำให้ทั้งคำขอล้ม
    ]);
    return { rows, nameOf, source: 'host-api' };
  } catch (e) {
    hostErr = e;
  }

  // 404 = มีเซิร์ฟเวอร์ตอบ แต่ไม่รู้จัก /zk/* → คนละปัญหากับเครื่องปิด/เน็ตหลุด
  const hostCode = hostErr.status === 404 ? 'ZK_HOST_OUTDATED' : 'ZK_HOST_UNREACHABLE';

  if (!hasDirectDbConfig()) {
    throw fail(hostCode,
      `ต่อ host API (${ZK_API_BASE}/zk/transactions) ไม่ได้: ${hostErr.message}`
    );
  }

  try {
    const pool = await getZkPool();
    const [rows, nameOf] = await Promise.all([
      queryPunches(pool, { start, endExclusive: exclusiveEnd(end), branch, emp }),
      zkNameMap(pool),
    ]);
    return { rows, nameOf, source: 'sql-direct' };
  } catch (dbErr) {
    // ล้มทั้งคู่ — คำแนะนำยังยึดตามสาเหตุฝั่ง host API ซึ่งเป็นทางที่ควรใช้
    throw fail(hostCode,
      `ดึงข้อมูลการสแกนไม่สำเร็จทั้งสองทาง — host API (${ZK_API_BASE}): ${hostErr.message} · ` +
      `ต่อ SQL ตรง: ${dbErr.message}`
    );
  }
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
    const { rows, nameOf, source } = await loadPunches({ start, end, branch, emp });

    // เกินเพดาน = ช่วงวันที่กว้างไป ตัดให้เหลือรายการล่าสุดแล้วเตือนผู้ใช้
    const truncated = rows.length >= ZK_ROW_CAP;
    const data = mapPunchRows(truncated ? rows.slice(0, ZK_ROW_CAP) : rows, nameOf);

    return res.status(200).json({
      status: 'success',
      branch, start, end,
      count: data.length,
      truncated,
      source,
      ...(truncated ? { message: `ข้อมูลถูกตัดที่ ${ZK_ROW_CAP.toLocaleString()} รายการ — ช่วงวันที่กว้างเกินไป กรุณาแคบช่วงลงหรือเลือกสาขา` } : {}),
      data,
    });
  } catch (err) {
    console.error('attendance API error:', err.message);
    // แยกสาเหตุให้หน้าเว็บขึ้นวิธีแก้ถูกจุด: host API ล่ม vs ต่อ SQL ตรงไม่ได้
    const code = err.code || 'ZK_CONNECT_FAILED';
    return res.status(502).json({ status: 'error', code, message: err.message || 'ดึงข้อมูลการสแกนไม่สำเร็จ' });
  }
}
