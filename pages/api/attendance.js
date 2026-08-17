// ประวัติสแกนหน้า/สแกนนิ้ว จากเครื่องสแกน ZKBio Time 9
//
//   GET /api/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&emp=รหัสพนักงาน]
//   → { status:'success', branch, start, end, count, truncated, source, data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }
//
// มีสามทางให้ดึง ลองทีละทางจนกว่าจะได้ (การเชื่อมต่อ/คิวรี่อยู่ใน lib/zkDb.js):
//   office-server — /attendance ที่ storenarai.dyndns.tv:8787 ← ทางหลัก
//                   ตัวเดียวกับที่หน้า usage ใช้ และเป็นทางที่ Narai-branch ใช้มาตลอด
//   host API      — /zk/transactions ที่ api.khanoykorshabu.com
//   SQL ตรง       — ต่อ ZKBio9 ตรงจาก Vercel ใช้ได้เมื่อตั้ง ZK_DB_USER/ZK_DB_PASSWORD
//                   และเปิดพอร์ต SQL ให้เข้าจากภายนอกได้
// เลือกทางที่ลองก่อนได้ด้วย env ZK_SOURCE = office (default) | host | sql
import {
  fetchAttendanceViaOffice, ZK_OFFICE_API_BASE,
  fetchPunchesViaHost, fetchNamesViaHost, ZK_API_BASE,
  hasDirectDbConfig, preferredSource,
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

/** ทางที่ 1: office-server /attendance — ฝั่งนั้นแปลงรูปมาให้ครบแล้ว ใช้ได้เลย */
async function viaOfficeServer(args) {
  return fetchAttendanceViaOffice(args);
}

/** ทางที่ 2: host API /zk/transactions (ได้แถวดิบ + ชื่อพนักงานแยกกัน) */
async function viaHostApi({ start, end, branch, emp }) {
  const [rows, nameOf] = await Promise.all([
    fetchPunchesViaHost({ start, end, branch, emp }),
    fetchNamesViaHost(), // ดึงชื่อไม่ได้ก็คืน {} ให้ ไม่ทำให้ทั้งคำขอล้ม
  ]);
  return mapPunchRows(rows, nameOf);
}

/** ทางที่ 3: ต่อ SQL Server ของ ZKBio ตรง (ต้องเปิดพอร์ตออกเน็ต + ตั้ง ZK_DB_USER/PASSWORD) */
async function viaSqlDirect({ start, end, branch, emp }) {
  const pool = await getZkPool();
  const [rows, nameOf] = await Promise.all([
    queryPunches(pool, { start, endExclusive: exclusiveEnd(end), branch, emp }),
    zkNameMap(pool),
  ]);
  return mapPunchRows(rows, nameOf);
}

// ชื่อทาง -> ตัวรัน, ป้ายที่ใช้ในข้อความ error และ error code ที่คู่กัน
const WAYS = {
  office: { run: viaOfficeServer, label: () => `office-server (${ZK_OFFICE_API_BASE})`, code: 'ZK_OFFICE_UNREACHABLE' },
  host:   { run: viaHostApi,      label: () => `host API (${ZK_API_BASE})`,             code: 'ZK_HOST_UNREACHABLE' },
  sql:    { run: viaSqlDirect,    label: () => 'ต่อ SQL ตรง',                            code: 'ZK_CONNECT_FAILED' },
};

/**
 * ดึงรายการสแกน — ลองทีละทางตามลำดับ ได้ทางไหนก่อนใช้ทางนั้น
 * ทางแรกเลือกด้วย env ZK_SOURCE (default office) ที่เหลือเป็นทางสำรองเรียงตามเดิม
 * คืน { data, source } — source ไว้ดูว่าข้อมูลรอบนี้มาจากทางไหน
 * ถ้าล้มหมด โยน error ที่รวมสาเหตุของทุกทางไว้ เพื่อให้รู้ว่าต้องไปแก้ตรงไหน
 */
async function loadPunches(args) {
  const first = preferredSource();
  const order = ['office', 'host', 'sql'].filter((n) => n !== first);
  order.unshift(first);
  // ต่อ SQL ตรงต้องมีรหัสก่อน ไม่งั้นข้ามไปเลย จะได้ไม่ขึ้น error เรื่อง env ที่ไม่เกี่ยว
  const names = order.filter((n) => n !== 'sql' || hasDirectDbConfig());

  const errs = {};
  for (const name of names) {
    try {
      return { data: await WAYS[name].run(args), source: name };
    } catch (e) {
      errs[name] = e;
    }
  }

  // คำแนะนำยึดตามทางแรกที่ตั้งไว้ เพราะนั่นคือทางที่ตั้งใจให้ใช้จริง
  const firstErr = errs[names[0]];
  const code = firstErr.status === 404 && names[0] === 'host'
    ? 'ZK_HOST_OUTDATED'  // มีเซิร์ฟเวอร์ตอบ แต่ไม่รู้จัก /zk/* = server.js เก่า
    : WAYS[names[0]].code;

  const parts = names.map((n) => `${WAYS[n].label()}: ${errs[n].message}`);
  throw fail(code, `ดึงข้อมูลการสแกนไม่สำเร็จ — ${parts.join(' · ')}`);
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
    const { data: all, source } = await loadPunches({ start, end, branch, emp });

    // เกินเพดาน = ช่วงวันที่กว้างไป ตัดให้เหลือรายการล่าสุดแล้วเตือนผู้ใช้
    const truncated = all.length >= ZK_ROW_CAP;
    const data = truncated ? all.slice(0, ZK_ROW_CAP) : all;

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
