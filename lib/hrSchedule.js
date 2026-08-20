// ตารางงานที่สาขาลงไว้ (ฐานข้อมูล narai_hr — ตาราง dbo.hr_timesheet)
//
// ข้อมูลชุดนี้ไม่ได้อยู่ที่เดียวกับข้อมูลสแกนหน้า:
//   สแกนหน้า   = ZKBio9 (เครื่องสแกน) — ดู lib/zkDb.js
//   ตารางงาน   = narai_hr (คนลงตารางที่หน้า "ลงตารางรายสัปดาห์" ของโปรเจค Narai-branch)
//
// ทั้งคู่อยู่หลัง office-server ตัวเดียวกัน (พอร์ต 8787) จึงใช้รายการ base เดียวกันกับ
// lib/zkDb.js ต่างกันแค่ /attendance เป็น GET ส่วนตารางงานเป็น POST /schedule
// แบบ { action, ...payload } ตามที่ office-server/schedule.js ของ Narai-branch กำหนดไว้
//
//   เบราว์เซอร์ -> /api/hr-schedule -> office-server :8787/schedule -> SQL Server narai_hr
//
// action ที่ใช้ (อ่านอย่างเดียวทั้งคู่ — หน้านี้ไม่แก้ตารางงานของสาขา):
//   getBranches     -> [{ name, fullName, outletId }]
//   getHistoryData  -> [{ workDate, branch, hrCode, name, checkIn, checkOut, breakTime, breakTimeRange, ... }]
//
// ตั้งค่าผ่าน env บน Vercel:
//   ZK_OFFICE_API_BASE / USAGE_API_BASE  URL ของ office-server (ไม่ตั้ง = ไล่ลองตามรายการใน lib/zkDb.js)
//   USAGE_API_TOKEN                      ใส่เมื่อฝั่งออฟฟิศตั้ง API_TOKEN ไว้
//   HR_SCHEDULE_USER                     ชื่อผู้ใช้ที่แนบไปกับคำสั่ง (ไม่ตั้ง = 'naraipizzeria')
import { ZK_OFFICE_API_BASES } from './zkDb';

const g = globalThis;
g.__hrBaseOk = g.__hrBaseOk || null;      // base ที่ใช้ได้ล่าสุด — ลองตัวนี้ก่อนเสมอ
g.__hrBranchCache = g.__hrBranchCache || null;

/** ต่ำกว่า maxDuration ของ route เพื่อให้ได้ error ชัดๆ ก่อนโดน platform ตัด */
const REQUEST_TIMEOUT_MS = 20000;

/**
 * office-server ตรวจว่ามี _user มาด้วยไหม ไม่มี = ตอบ 401 ทันที (ดู sessionOf ใน schedule.js)
 * ที่นั่นออกแบบไว้ให้หน้าเว็บของสาขาแนบ user ที่ล็อกอินไว้มาเอง เพื่อจำกัดว่าดูได้เฉพาะสาขาตัวเอง
 *
 * แดชบอร์ดตัวนี้เป็นระบบหลังบ้านของออฟฟิศ (ไม่มีล็อกอินรายสาขา และดูได้ทุกสาขาอยู่แล้ว)
 * จึงแนบ user สิทธิ์ 'all' ไปแบบคงที่ — เท่ากับสิทธิ์ที่แอดมินของ Narai-branch ใช้
 * ตรงนี้ไม่ได้ทำให้ข้อมูลรั่วเพิ่ม เพราะฝั่งนั้นก็เชื่อค่าที่หน้าเว็บส่งมาเหมือนกัน (เขียนไว้ในคอมเมนต์ของเขาเอง)
 * และคำสั่งที่หน้านี้เรียกเป็นคำสั่งอ่านทั้งหมด
 */
const scheduleUser = () => ({
  username: process.env.HR_SCHEDULE_USER || 'naraipizzeria',
  branch: 'all',
  name: 'NARAI OFFICE',
});

/** ยิง POST /schedule ไปที่ base หนึ่งตัว — โยน error พร้อม status เมื่อฝั่งนั้นตอบว่าทำไม่ได้ */
async function postSchedule(base, action, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.USAGE_API_TOKEN) headers['x-api-token'] = process.env.USAGE_API_TOKEN;

  const r = await fetch(`${base}/schedule`, {
    method: 'POST',
    cache: 'no-store',
    headers,
    body: JSON.stringify({ action, ...payload, _user: scheduleUser() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status !== 'success') {
    // บิลด์เก่าของ office-server ยังไม่มี route /schedule -> express ตอบ 404 เป็น HTML (j เป็น null)
    const e = new Error(
      (j && j.message) ||
      `ตอบ HTTP ${r.status}${r.status === 404 ? ' (บิลด์เก่ายังไม่มี /schedule)' : ''}`
    );
    e.status = r.status;
    throw e;
  }
  return j.data;
}

/**
 * เรียก action หนึ่งคำสั่ง — ไล่ลอง base ตามรายการเดียวกับที่ /api/attendance ใช้
 * base ที่สำเร็จจะถูกจำไว้ แล้วลองตัวนั้นก่อนในครั้งถัดไป (base ที่เข้าไม่ได้ค้างจน timeout
 * การจำไว้จึงตัดเวลารอทิ้งไปได้มากเมื่อต้องยิงหลายสาขาติดกัน)
 */
export async function callSchedule(action, payload = {}) {
  const bases = g.__hrBaseOk
    ? [g.__hrBaseOk, ...ZK_OFFICE_API_BASES.filter((b) => b !== g.__hrBaseOk)]
    : [...ZK_OFFICE_API_BASES];

  const fails = [];
  for (const base of bases) {
    try {
      const data = await postSchedule(base, action, payload);
      g.__hrBaseOk = base;
      return data;
    } catch (e) {
      // ฝั่งนั้นรับคำสั่งแล้วแต่ปฏิเสธ (ข้อมูลไม่ครบ/ไม่มีสิทธิ์/ยังไม่ได้ตั้ง .env)
      // = base ตัวนี้ใช้ได้ ลองตัวอื่นไปก็ได้คำตอบเดิม จึงหยุดแล้วบอกเหตุผลจริงไปเลย
      if (e.status && e.status !== 404 && e.status < 500) {
        g.__hrBaseOk = base;
        throw e;
      }
      fails.push(`${base} → ${e.message}`);
    }
  }
  g.__hrBaseOk = null;
  throw new Error(`ดึงตารางงานไม่สำเร็จ — ${fails.join(' · ')}`);
}

/**
 * รายชื่อสาขาในฐานข้อมูล HR — คืน [{ name, fullName }] ตามตัวสะกดที่เก็บจริงในตาราง
 * แคชไว้ 10 นาที (รายชื่อสาขาแทบไม่เปลี่ยน แต่ต้องเรียกทุกครั้งที่ดูแบบ "ทุกสาขา")
 */
export async function fetchScheduleBranches() {
  const cache = g.__hrBranchCache;
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;

  const rows = await callSchedule('getBranches', {});
  const list = (Array.isArray(rows) ? rows : [])
    .map((b) => ({ name: String(b?.name || '').trim(), fullName: String(b?.fullName || b?.name || '').trim() }))
    .filter((b) => b.name && b.name.toLowerCase() !== 'all');

  g.__hrBranchCache = { at: Date.now(), list };
  return list;
}

/** ตารางงานของสาขาเดียวในช่วงวันที่ — คืนแถวตามรูปที่ office-server แปลงมาให้แล้ว */
export async function fetchTimesheet({ branch, start, end }) {
  const rows = await callSchedule('getHistoryData', { branch, startDate: start, endDate: end });
  return Array.isArray(rows) ? rows : [];
}

/**
 * ดึงตารางงานหลายสาขาพร้อมกัน — office-server อ่านได้ทีละสาขา (getHistoryData รับ branch เดียว)
 * จึงต้องยิงหลายครั้ง แต่ยิงรวดเดียวทั้ง 21 สาขาจะไปแย่งคอนเนคชันกับตอนสาขากดบันทึกตาราง
 * (ปัญหาเดียวกับที่ Narai-branch เจอตอน syncEmployees) จึงจำกัดให้วิ่งพร้อมกันทีละไม่กี่สาขา
 *
 * คืน { rows, failed } — สาขาไหนดึงไม่ได้ก็ยังได้ของสาขาที่เหลือ ตารางงานเป็นข้อมูลเสริม
 * ไม่ควรทำให้ทั้งหน้าใช้ไม่ได้
 */
export async function fetchTimesheetMany({ branches, start, end, concurrency = 4 }) {
  const queue = [...branches];
  const rows = [];
  const failed = [];

  const worker = async () => {
    for (let b = queue.shift(); b !== undefined; b = queue.shift()) {
      try {
        rows.push(...(await fetchTimesheet({ branch: b, start, end })));
      } catch (e) {
        failed.push({ branch: b, message: e.message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { rows, failed };
}
