// ประวัติสแกนหน้า/สแกนนิ้ว (ZKBio Time 9) — ทำงานแบบเดียวกับ endpoint /attendance ของโปรเจค Narai-branch
// เส้นทาง: หน้าเว็บ → /api/attendance → host API (/zk/transactions + /zk/employees) → SQL Server (ZKBio9)
//
//   GET /api/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&emp=รหัสพนักงาน]
//   → { status:'success', branch, start, end, count, data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }
//
// รวมชื่อพนักงานจาก /zk/employees ให้แล้ว (ดึงชื่อไม่ได้ก็ยังคืนรายการสแกนโดยแสดงเฉพาะรหัส)

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

// ป้ายกำกับตามมาตรฐาน ZKTeco — แต่ละเครื่องตั้งค่าปุ่มไม่เหมือนกัน หน้าเว็บจึงคิด "เข้า/ออก"
// จากลำดับเวลาสแกนของวันด้วย ไม่ได้อิง punch_state อย่างเดียว (ดู lib/attendance.js)
const PUNCH_LABEL = { '0': 'เข้างาน', '1': 'ออกงาน', '2': 'พักออก', '3': 'พักเข้า', '4': 'OT เข้า', '5': 'OT ออก' };

const txt = (v) => (v == null ? '' : String(v).trim());

// เพดานแถวที่ /zk/transactions ของ host ใช้ (20000 = host รุ่นเก่า, 100000 = รุ่นปัจจุบัน)
// ได้จำนวนแถวเท่ากับเพดานพอดี = ข้อมูลถูกตัด ต้องบอกผู้ใช้ให้แคบช่วงวันที่/เลือกสาขา
const ZK_ROW_CAPS = [20000, 100000];

// host API คืน punch_time เป็น 'YYYY-MM-DD HH:mm:ss' อยู่แล้ว แต่เผื่อรุ่นที่คืนเป็น ISO ('...T...Z')
// ตัดเอาเฉพาะส่วนวัน-เวลา ไม่แปลง timezone (ค่าที่เก็บใน DB คือเวลาหน้าเครื่องสแกนอยู่แล้ว)
function normalizeTime(v) {
  const s = txt(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

async function fetchZk(path) {
  const r = await fetch(`${STORE_API}${path}`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `host API HTTP ${r.status} (${path})`);
  return Array.isArray(j) ? j : j?.data || [];
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

  try {
    // ส่ง area ให้ host กรองที่ SQL (ลดข้อมูลที่ส่งกลับ) — host รุ่นเก่าที่ยังไม่รู้จัก area
    // จะคืนทุกสาขามา จึงกรองซ้ำอีกชั้นด้านล่างด้วย
    const qs = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
      (emp ? `&emp=${encodeURIComponent(emp)}` : '') +
      (branch ? `&area=${encodeURIComponent(branch)}` : '');
    const [punches, emps] = await Promise.all([
      fetchZk(`/zk/transactions?${qs}`),
      fetchZk('/zk/employees').catch(() => []), // ชื่อพนักงานเป็นของแถม ดึงไม่ได้ก็ยังใช้งานได้
    ]);

    const nameOf = {};
    emps.forEach((e) => {
      const code = txt(e.emp_code);
      if (code) nameOf[code] = `${txt(e.first_name)} ${txt(e.last_name)}`.trim();
    });

    let data = punches.map((p) => {
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

    // กรองสาขาซ้ำฝั่งนี้: ZKBio เก็บรหัสสาขาไว้ที่ area_alias (เช่น SUM/XCM/ZBW ตรงกับรหัสที่เว็บใช้)
    // เทียบแบบตรงตัวเหมือนที่ Narai-branch ทำ — ไม่เดาจากชื่อเครื่อง เพราะเครื่องคนละสาขาตั้งชื่อซ้ำกันได้
    if (branch) data = data.filter((r) => r.area.toUpperCase() === branch);

    data.sort((a, b) => b.time.localeCompare(a.time)); // ล่าสุดก่อน (เหมือนหน้าสแกนของ Narai-branch)

    const truncated = ZK_ROW_CAPS.includes(punches.length);
    return res.status(200).json({
      status: 'success',
      branch, start, end,
      count: data.length,
      truncated,
      ...(truncated ? { message: `ข้อมูลถูกตัดที่ ${punches.length.toLocaleString()} รายการ — ช่วงวันที่กว้างเกินไป กรุณาแคบช่วงลงหรือเลือกสาขา` } : {}),
      data,
    });
  } catch (err) {
    console.error('attendance API error:', err.message);
    return res.status(502).json({ status: 'error', message: err.message || 'ดึงข้อมูลการสแกนไม่สำเร็จ' });
  }
}
