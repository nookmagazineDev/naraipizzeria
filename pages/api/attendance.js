// ประวัติสแกนหน้า/สแกนนิ้ว จากเครื่องสแกน ZKBio Time 9
//
//   GET /api/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&emp=รหัสพนักงาน]
//   → { status:'success', branch, start, end, from, count, truncated, missing, source,
//       data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }
//
// ช่วงที่ยาวกว่า CHUNK_DAYS วัน จะถูกหั่นเป็นก้อนละไม่กี่วันแล้วยิงทีละก้อน (ดู runInChunks)
// เพราะต้นทางแต่ละทางมีเพดานแถวของตัวเอง — ขอทีเดียวทั้งเดือนแล้วชนเพดานเมื่อไหร่
// จะมี "ทั้งวัน" หายไปเงียบๆ โดยที่เราไม่รู้ว่ามันตัดวันต้นช่วงหรือวันท้ายช่วงทิ้ง
//
// มีสามทางให้ดึง ลองทีละทางจนกว่าจะได้ (การเชื่อมต่อ/คิวรี่อยู่ใน lib/zkDb.js):
//   office-server — /attendance (ไล่ลองหลาย base: Cloudflare Tunnel, เครื่องคลาวด์, เครื่องเดิม)
//                   ทางเดียวกับที่ Narai-branch ใช้ — ตั้ง ZK_OFFICE_API_BASE ทับได้
//   host API      — /zk/transactions ที่ api.khanoykorshabu.com
//   SQL ตรง       — ต่อ ZKBio9 ตรงจาก Vercel ใช้ได้เมื่อตั้ง ZK_DB_USER/ZK_DB_PASSWORD
//                   และเปิดพอร์ต SQL ให้เข้าจากภายนอกได้
// เลือกทางที่ลองก่อนได้ด้วย env ZK_SOURCE = office (default) | host | sql
import {
  fetchAttendanceViaOffice,
  fetchPunchesViaHost, fetchNamesViaHost, ZK_API_BASE,
  hasDirectDbConfig, preferredSource,
  getZkPool, zkNameMap, queryPunches, ZK_ROW_CAP,
} from '../../lib/zkDb';
// ตัวช่วยชุดเดียวกับที่ /api/hr-schedule ใช้ — ทั้งสองฝั่งของหน้านี้เจอปัญหาเพดานแถวเหมือนกัน
import { dateChunks, capByDay, missingDates, dayOf } from '../../lib/dateRange';

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

/** วันของแถว — ทาง office ส่ง date มาให้แล้ว ทางอื่นตัดเอาจาก time */
const rowDate = (r) => txt(r.date) || dayOf(r.time);

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
  office: { run: viaOfficeServer, label: () => 'office-server', code: 'ZK_OFFICE_UNREACHABLE' },
  host:   { run: viaHostApi,      label: () => `host API (${ZK_API_BASE})`,             code: 'ZK_HOST_UNREACHABLE' },
  sql:    { run: viaSqlDirect,    label: () => 'ต่อ SQL ตรง',                            code: 'ZK_CONNECT_FAILED' },
};

// ── หั่นช่วงวันที่เป็นก้อน ──────────────────────────────────────────────
// เพดานแถวของต้นทาง (office-server / host API / TOP ของ SQL) ทำให้ขอทีเดียวทั้งเดือน
// แบบทุกสาขาแล้วได้ข้อมูลไม่ครบ — และวันที่หายคือ "หายทั้งวัน" ไม่ใช่หายบางคน
// ขอเป็นก้อนละสัปดาห์ก้อนละไม่กี่พันแถว จึงไม่มีก้อนไหนชนเพดานของใครเลย

/** ขนาดก้อน (วัน) — สัปดาห์ละก้อน: ทุกสาขา 7 วัน ≈ 8 พันแถว ยังห่างเพดานทุกทาง */
export const CHUNK_DAYS = 7;
/** ยิงพร้อมกันกี่ก้อน — เท่าที่เร็วขึ้นโดยไม่ไปแย่งคอนเนคชันของเครื่องที่ออฟฟิศ */
const CHUNK_CONCURRENCY = 2;

/** กันแถวซ้ำตอนรวมก้อน (ก้อนไม่ทับกันอยู่แล้ว แต่ต้นทางอาจส่งซ้ำเอง) */
const rowKey = (r) => `${txt(r.empCode)}|${txt(r.time)}|${txt(r.state)}|${txt(r.terminal)}`;

/** รวมผลทุกก้อน ตัดตัวซ้ำ แล้วเรียงใหม่→เก่า (ลำดับที่หน้าเว็บคาดหวัง) */
export function mergePunches(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const r of list || []) {
      const k = rowKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out.sort((a, b) => txt(b.time).localeCompare(txt(a.time)));
}

/**
 * ยิงทางหนึ่งทางให้ครบทุกก้อน — ก้อนไหนล้ม = ทางนี้ล้มทั้งทาง แล้วไปลองทางถัดไป
 * (ยอมล้มดีกว่าคืนข้อมูลครึ่งๆ ที่ดูเหมือนครบ)
 *
 * ก้อนแรกที่ล้มจะหยุดก้อนที่เหลือทันที — ทางที่ติดต่อไม่ได้จะค้างจน timeout ทุกก้อน
 * ปล่อยให้ยิงต่อจะกินเวลาจนชน maxDuration ก่อนได้ลองทางสำรอง
 */
async function runInChunks(run, args) {
  const chunks = dateChunks(args.start, args.end, CHUNK_DAYS);
  if (chunks.length === 1) return mergePunches([await run(args)]);

  const queue = [...chunks];
  const lists = [];
  let failed = null;
  const worker = async () => {
    for (let c = queue.shift(); c !== undefined && !failed; c = queue.shift()) {
      try {
        lists.push(await run({ ...args, start: c.start, end: c.end }));
      } catch (e) {
        failed = failed || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, queue.length) }, worker));
  if (failed) throw failed;
  return mergePunches(lists);
}

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
      return { data: await runInChunks(WAYS[name].run, args), source: name };
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

    // เกินเพดาน = ช่วงวันที่กว้างไป ตัดวันเก่าสุดทิ้งทีละทั้งวันแล้วบอกผู้ใช้ว่าเหลือตั้งแต่วันไหน
    const { data, truncated, from } = capByDay(all, ZK_ROW_CAP, rowDate);

    // วันที่ไม่มีสแกนเลย — นับเฉพาะช่วงที่ส่งกลับไปจริง (ถ้าถูกตัด วันก่อนหน้านั้นไม่ใช่ "ขาด")
    const missing = missingDates(data, truncated ? from : start, end, rowDate);

    return res.status(200).json({
      status: 'success',
      branch, start, end,
      from: truncated ? from : start,
      count: data.length,
      truncated,
      missing,
      source,
      ...(truncated
        ? { message: `ข้อมูลเกิน ${ZK_ROW_CAP.toLocaleString()} รายการ — แสดงตั้งแต่วันที่ ${from} ถึง ${end} เท่านั้น กรุณาแคบช่วงวันที่ลงหรือเลือกสาขา` }
        : {}),
      data,
    });
  } catch (err) {
    console.error('attendance API error:', err.message);
    // แยกสาเหตุให้หน้าเว็บขึ้นวิธีแก้ถูกจุด: host API ล่ม vs ต่อ SQL ตรงไม่ได้
    const code = err.code || 'ZK_CONNECT_FAILED';
    return res.status(502).json({ status: 'error', code, message: err.message || 'ดึงข้อมูลการสแกนไม่สำเร็จ' });
  }
}
