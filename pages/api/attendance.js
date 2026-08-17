// ประวัติสแกนหน้า/สแกนนิ้ว จากเครื่องสแกน ZKBio Time 9
//
//   GET /api/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&emp=รหัสพนักงาน]
//   → { status:'success', branch, start, end, count, truncated, source, data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }
//
// มีสองทางให้ดึง ลองทีละทางจนกว่าจะได้ (การเชื่อมต่อ/คิวรี่อยู่ใน lib/zkDb.js):
//   host API  — /zk/transactions บนเครื่องออฟฟิศเครื่องเดียวกับ SQL Server
//               ทางเดียวกับ /api/sales และ AI NARAI จึงไม่ต้องเปิดพอร์ต SQL ออกเน็ต
//   SQL ตรง   — ต่อ ZKBio9 ตรงจาก Vercel ใช้ได้เมื่อตั้ง ZK_DB_USER/ZK_DB_PASSWORD
//               และเปิดพอร์ต SQL ให้เข้าจากภายนอกได้
// ปกติเรียง host API ก่อน — ตั้ง env ZK_SOURCE=sql เพื่อให้เอา SQL ตรงขึ้นก่อน
import {
  fetchPunchesViaHost, fetchNamesViaHost, hasDirectDbConfig, preferDirectDb, ZK_API_BASE,
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

/** ทางที่ 1: ผ่าน host API บนเครื่องออฟฟิศ */
async function viaHostApi({ start, end, branch, emp }) {
  const [rows, nameOf] = await Promise.all([
    fetchPunchesViaHost({ start, end, branch, emp }),
    fetchNamesViaHost(), // ดึงชื่อไม่ได้ก็คืน {} ให้ ไม่ทำให้ทั้งคำขอล้ม
  ]);
  return { rows, nameOf, source: 'host-api' };
}

/** ทางที่ 2: ต่อ SQL Server ของ ZKBio ตรง (ต้องเปิดพอร์ตออกเน็ต + ตั้ง ZK_DB_USER/PASSWORD) */
async function viaSqlDirect({ start, end, branch, emp }) {
  const pool = await getZkPool();
  const [rows, nameOf] = await Promise.all([
    queryPunches(pool, { start, endExclusive: exclusiveEnd(end), branch, emp }),
    zkNameMap(pool),
  ]);
  return { rows, nameOf, source: 'sql-direct' };
}

/**
 * ดึงรายการสแกน — ลองทีละทางตามลำดับ ได้ทางไหนก่อนใช้ทางนั้น
 * ปกติเอา host API ก่อน (ไม่ต้องเปิดพอร์ต SQL ออกเน็ต) ตั้ง ZK_SOURCE=sql เพื่อสลับลำดับ
 * คืน { rows, nameOf, source } — source ไว้ดูว่าข้อมูลรอบนี้มาจากทางไหน
 * ถ้าล้มหมด โยน error ที่รวมสาเหตุของทุกทางไว้ เพื่อให้รู้ว่าต้องไปแก้ตรงไหน
 */
async function loadPunches(args) {
  const ways = [['host', viaHostApi]];
  if (hasDirectDbConfig()) {
    if (preferDirectDb()) ways.unshift(['sql', viaSqlDirect]);
    else ways.push(['sql', viaSqlDirect]);
  }

  const errs = {};
  for (const [name, run] of ways) {
    try {
      return await run(args);
    } catch (e) {
      errs[name] = e;
    }
  }

  const { host: hostErr, sql: dbErr } = errs;
  const parts = ways
    .map(([name]) => (name === 'host'
      ? `host API (${ZK_API_BASE}): ${hostErr.message}`
      : `ต่อ SQL ตรง: ${dbErr.message}`));

  // 404 = มีเซิร์ฟเวอร์ตอบ แต่ไม่รู้จัก /zk/* → คนละปัญหากับเครื่องปิด/เน็ตหลุด
  const code = hostErr.status === 404 ? 'ZK_HOST_OUTDATED' : 'ZK_HOST_UNREACHABLE';

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
