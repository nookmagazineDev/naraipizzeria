// ข้อมูลร้านเฟรนไชส์ (ฐาน Aoringo) มาจากไหน — ลองต่อ SQL ตรงก่อน ต่อไม่ติดค่อยถอยไป host API
//
// กติกาเดียวกับหน้า "ดูข้อมูลปิดรอบเดือน" (lib/sheetsSource.js) เพราะปัญหาเดียวกันเป๊ะ:
//   ที่ร้านเปิดไฟร์วอลล์ให้เฉพาะ IP ในไทย Vercel จึงต่อ 203.154.185.48:1433 ตรงไม่ติดเป็นปกติ
//   แต่ host-server ที่เครื่องออฟฟิศเปิด tunnel ขาออกไว้ ทางนั้นยังใช้ได้อยู่
//
//   1) ต่อ SQL ตรง (lib/aoringoPool.js) — เร็วที่สุด ใช้เมื่อพอร์ตเปิดและตั้งรหัสฐานไว้แล้ว
//   2) host API /aoringo/* (host-server/aoringo-db.js) — ผ่าน tunnel ของเครื่องออฟฟิศ
//
// ถอยเฉพาะ error ที่แปลว่า "ไปไม่ถึงเครื่อง" เท่านั้น — error แบบไม่มีสิทธิ์/หาตารางไม่เจอ
// ต้องเด้งขึ้นไปให้คนอ่านแก้ ไม่ใช่กลบด้วยการถอยไปอีกทางแล้วพังเหมือนกัน
import { isConfigured as hasDirectDb, describeTarget, aoringo as direct } from './aoringoPool';
import { isUnreachable, directDown, markDirectDown, clearDirectDown, explainHostError } from './directRoute';

export { hasDirectDb, describeTarget };

export const AORINGO_API_BASE = (
  process.env.AORINGO_API_BASE || process.env.SHEETS_API_BASE || process.env.QCRD_API_BASE ||
  process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com'
).replace(/\/+$/, '');

// host API วิ่งผ่าน tunnel ช้ากว่าต่อตรงเป็นปกติ และคำสั่งชุดนี้ดึงทั้งเดือน — ให้เวลามากกว่าหน้าอื่น
const HOST_TIMEOUT = 50000;

/** ทางที่จะใช้จริง — ไว้บอกในหน้าเว็บว่าข้อมูลชุดนี้มาจากไหน */
export const route = () =>
  (hasDirectDb() ? `ต่อ SQL ตรง (${describeTarget()})` : `host API (${AORINGO_API_BASE})`);

async function getFromHost(path, { timeoutMs = HOST_TIMEOUT } = {}) {
  const res = await fetch(`${AORINGO_API_BASE}/aoringo/${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  }).catch((err) => { throw explainHostError(err, { base: AORINGO_API_BASE, timeoutMs }); });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error(
      `host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server ที่เครื่องออฟฟิศรันอยู่ไหม ` +
      'และเป็นเวอร์ชันที่มี /aoringo/* แล้วหรือยัง (git pull แล้ว start-narai.ps1 -Restart)');
  }
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

/** ลองต่อตรงก่อน ต่อไม่ติดค่อยถอยไป host API — คืนทางที่ใช้จริงมาด้วย */
async function read(runDirect, hostPath) {
  const hostRoute = `host API (${AORINGO_API_BASE})`;
  const fromHost = (note) => getFromHost(hostPath)
    .then((data) => ({ data, route: note ? `${hostRoute} — ${note}` : hostRoute }));

  if (!hasDirectDb()) return fromHost();
  if (directDown()) return fromHost('ต่อ SQL ตรงไม่ติดเมื่อครู่ จึงข้ามมาทางนี้เลย');

  try {
    const data = await runDirect();
    clearDirectDown();
    return { data, route: `ต่อ SQL ตรง (${describeTarget()})` };
  } catch (err) {
    if (!isUnreachable(err.message)) throw err;
    markDirectDown();
    console.error(`aoringo: ต่อ SQL ตรงไม่ได้ (${describeTarget()}) — ถอยไปเรียก host API:`, err.message);
    try {
      return await fromHost('ต่อ SQL ตรงไม่ได้จึงถอยมาทางนี้');
    } catch (hostErr) {
      // พังทั้งสองทาง — บอกทั้งคู่ ไม่งั้นจะเห็นแค่ทางหลังแล้วไล่ผิดจุด
      throw new Error(
        `ต่อ SQL ตรงไม่ได้: ${err.message}\n` +
        `→ ถอยไปเรียก ${hostRoute} ก็ไม่ได้: ${hostErr.message}`);
    }
  }
}

const rangeQs = ({ start, end, outlet, limit }) => {
  const p = new URLSearchParams({ start, end });
  if (outlet) p.set('outlet', String(outlet));
  if (limit) p.set('limit', String(limit));
  return p.toString();
};

/** บิลขายในช่วงวันที่ */
export const readBills = (opt) => read(() => direct.readBills(opt), `sales?${rangeQs(opt)}`);

/** รายการสินค้าในบิล ช่วงวันที่เดียวกัน */
export const readItems = (opt) => read(() => direct.readItems(opt), `detail?${rangeQs(opt)}`);

/** รายจ่ายในช่วงวันที่ */
export const readExpenses = (opt) => read(() => direct.readExpenses(opt), `expense?${rangeQs(opt)}`);

/** ประวัติออเดอร์ (OrderActivity) ช่วงวันที่เดียวกับบิล */
export const readActivities = (opt) => read(() => direct.readActivities(opt), `activity?${rangeQs(opt)}`);

/** ตาราง/คอลัมน์ที่จับคู่ได้ในฐาน Aoringo — ไว้ไล่ดูเวลาชื่อไม่ตรงกับที่เดาไว้ */
export const readLayout = () => read(() => direct.readLayout({ force: true }), 'schema');

/** ต่อฐานได้ไหม + จับคู่ตารางได้ครบไหม */
export const ping = () => read(() => direct.ping(), 'ping');
