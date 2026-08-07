// ประวัติสแกนหน้า/สแกนนิ้ว (ZKBio Time 9) — ข้อมูลชุดเดียวกับหน้า "สแกนเข้า-ออก" ของโปรเจค Narai-branch
//
//   GET /api/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&emp=รหัสพนักงาน]
//   → { status:'success', source, branch, start, end, count, data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }
//
// มี upstream 2 ทาง ลองไล่ตามลำดับ:
//   1) office-server (203.154.185.48:14322) — endpoint /attendance ที่ต่อฐาน ZKBio9 อยู่จริง
//      เป็นทางหลัก (คนละเครื่อง/คนละพอร์ตกับ usage API ที่ usagemenu/usagebytable เรียก)
//      ตั้ง env ATTENDANCE_API_BASE ทับได้เวลา IP/พอร์ตเปลี่ยน
//   2) host API ของร้าน (api.khanoykorshabu.com) — endpoint /zk/* ใน host-server/server.js ของ repo นี้
//      ใช้เป็นทางสำรอง เผื่อวันหน้าเครื่องออฟฟิศปิด แต่เครื่องร้านอัปเดต server.js แล้ว
//
// สองทางนี้คืนคนละรูปแบบ จึงแปลงให้เป็นรูปเดียวกันก่อนส่งออก

const OFFICE_API = process.env.ATTENDANCE_API_BASE || 'http://203.154.185.48:14322';
const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

// ป้ายกำกับตามมาตรฐาน ZKTeco — แต่ละเครื่องตั้งค่าปุ่มไม่เหมือนกัน หน้าเว็บจึงคิด "เข้า/ออก"
// จากลำดับเวลาสแกนของวันด้วย ไม่ได้อิง punch_state อย่างเดียว (ดู lib/attendance.js)
const PUNCH_LABEL = { '0': 'เข้างาน', '1': 'ออกงาน', '2': 'พักออก', '3': 'พักเข้า', '4': 'OT เข้า', '5': 'OT ออก' };

// เพดานแถวของ upstream (office-server = 20000, host API รุ่นปัจจุบัน = 100000)
// ได้จำนวนแถวเท่ากับเพดานพอดี = ข้อมูลถูกตัด ต้องบอกผู้ใช้ให้แคบช่วงวันที่/เลือกสาขา
const ROW_CAPS = [20000, 100000];

const UPSTREAM_TIMEOUT_MS = 25000;

const txt = (v) => (v == null ? '' : String(v).trim());

// upstream คืนเวลาเป็น 'YYYY-MM-DD HH:mm:ss' อยู่แล้ว แต่เผื่อรุ่นที่คืนเป็น ISO ('...T...Z')
// ตัดเอาเฉพาะส่วนวัน-เวลา ไม่แปลง timezone (ค่าที่เก็บใน DB คือเวลาหน้าเครื่องสแกนอยู่แล้ว)
function normalizeTime(v) {
  const s = txt(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

// เครื่องออฟฟิศ/เครื่องร้านปิดอยู่ หรือ dyndns เพิ่งเปลี่ยน IP -> fetch ค้างจนฟังก์ชันหมดเวลา
// ตัดเองที่ UPSTREAM_TIMEOUT_MS เพื่อให้ยังเหลือเวลาไปลอง upstream ตัวถัดไป
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${new URL(url).host} ไม่ตอบภายใน ${UPSTREAM_TIMEOUT_MS / 1000} วินาที`);
    throw new Error(`ต่อ ${new URL(url).host} ไม่ได้: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── ทางที่ 1: office-server /attendance (รูปแบบเดียวกับที่หน้าเว็บต้องใช้อยู่แล้ว) ──
async function fromOfficeServer({ start, end, branch, emp }) {
  const params = new URLSearchParams({ start, end });
  if (branch) params.set('branch', branch);
  if (emp) params.set('emp', emp);
  const { ok, status, json } = await fetchJson(`${OFFICE_API}/attendance?${params.toString()}`);
  if (!ok || !json || json.status !== 'success') {
    const why = (json && json.message) || `HTTP ${status}`;
    throw new Error(status === 404 ? 'office-server ยังไม่มี endpoint /attendance' : why);
  }
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows.map((r) => {
    const time = normalizeTime(r.time);
    const state = txt(r.state);
    return {
      empCode: txt(r.empCode),
      name: txt(r.name),
      time,
      date: txt(r.date) || time.slice(0, 10),
      state,
      stateLabel: txt(r.stateLabel) || PUNCH_LABEL[state] || '',
      area: txt(r.area),
      terminal: txt(r.terminal),
    };
  });
}

// ── ทางที่ 2: host API /zk/* (ข้อมูลดิบจากตาราง iclock_transaction + ชื่อจาก personnel_employee) ──
async function fromStoreHost({ start, end, branch, emp }) {
  const qs = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
    (emp ? `&emp=${encodeURIComponent(emp)}` : '') +
    (branch ? `&area=${encodeURIComponent(branch)}` : '');

  const zk = async (path) => {
    const { ok, status, json } = await fetchJson(`${STORE_API}${path}`);
    if (!ok) {
      // 404 = host ตอบได้ แต่ไม่รู้จัก route /zk/* → server.js ที่เครื่องร้านเป็นรุ่นเก่า
      // (คนละเรื่องกับ "ต่อฐานข้อมูล ZKBio ไม่ได้" ซึ่ง host จะตอบ 500 พร้อมสาเหตุจริง)
      if (status === 404) throw new Error(`เครื่องร้านยังไม่มี endpoint ${path.split('?')[0]} (server.js เป็นรุ่นเก่า)`);
      throw new Error((json && json.error) || `host API HTTP ${status}`);
    }
    return Array.isArray(json) ? json : (json && json.data) || [];
  };

  const [punches, emps] = await Promise.all([
    zk(`/zk/transactions?${qs}`),
    zk('/zk/employees').catch(() => []), // ชื่อพนักงานเป็นของแถม ดึงไม่ได้ก็ยังใช้งานได้
  ]);

  const nameOf = {};
  emps.forEach((e) => {
    const code = txt(e.emp_code);
    if (code) nameOf[code] = `${txt(e.first_name)} ${txt(e.last_name)}`.trim();
  });

  return punches.map((p) => {
    const time = normalizeTime(p.punch_time);
    const code = txt(p.emp_code);
    const state = txt(p.punch_state);
    return {
      empCode: code,
      name: nameOf[code] || '',
      time,
      date: time.slice(0, 10),
      state,
      stateLabel: PUNCH_LABEL[state] || '',
      area: txt(p.area_alias),
      terminal: txt(p.terminal_alias),
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ status: 'error', message: 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD' });
  }
  if (start > end) {
    return res.status(400).json({ status: 'error', message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
  }

  const args = { start, end, branch, emp };
  const attempts = [
    { source: 'office-server', run: () => fromOfficeServer(args) },
    { source: 'store-host', run: () => fromStoreHost(args) },
  ];

  const failures = [];
  for (const { source, run } of attempts) {
    let data;
    try {
      data = await run();
    } catch (err) {
      console.error(`attendance via ${source} ไม่สำเร็จ:`, err.message);
      failures.push(`${source}: ${err.message}`);
      continue;
    }

    const rawCount = data.length;
    // กรองสาขาซ้ำฝั่งนี้ เผื่อ upstream ไม่ได้กรองให้ (host API รุ่นเก่ายังไม่รู้จัก area)
    // ZKBio เก็บรหัสสาขาไว้ที่ area_alias — เทียบตรงตัวเหมือนที่ Narai-branch ทำ
    if (branch) data = data.filter((r) => r.area.toUpperCase() === branch);
    data.sort((a, b) => b.time.localeCompare(a.time)); // ล่าสุดก่อน

    const truncated = ROW_CAPS.includes(rawCount);
    return res.status(200).json({
      status: 'success',
      source,
      branch, start, end,
      count: data.length,
      truncated,
      ...(truncated ? { message: `ข้อมูลถูกตัดที่ ${rawCount.toLocaleString()} รายการ — ช่วงวันที่กว้างเกินไป กรุณาแคบช่วงลงหรือเลือกสาขา` } : {}),
      data,
    });
  }

  // ทั้งสองทางไม่ผ่าน — บอกให้ครบว่าลองอะไรไปแล้วบ้าง จะได้ไล่ถูกจุด
  return res.status(502).json({
    status: 'error',
    code: 'ZK_UPSTREAM_FAILED',
    message: `ดึงข้อมูลการสแกนไม่สำเร็จ — ${failures.join(' · ')}`,
  });
}
