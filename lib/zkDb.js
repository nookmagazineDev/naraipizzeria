import { STORE_API_BASE, fetchUpstream } from './upstream.mjs';

// ดึงข้อมูลการสแกน (ZKBio Time 9) มาให้ /api/attendance ใช้ — มีสามทาง ลองไล่ตามลำดับ
//
//   1) office-server /attendance  ← ทางหลัก (ทางที่ Narai-branch ใช้ดึงหน้า "สแกนเข้า-ออก")
//      ไล่ลองหลาย base ให้ เพราะเซิร์ฟเวอร์ตัวนี้ย้ายที่รันมาหลายรอบ — ดูรายละเอียดที่
//      OFFICE_FALLBACK_BASES ด้านล่าง
//   2) host API /zk/transactions ที่ api.khanoykorshabu.com (host-server/server.js)
//   3) ต่อ SQL Server ของ ZKBio ตรงจาก Vercel — ใช้เมื่อตั้ง ZK_DB_USER/ZK_DB_PASSWORD
//      และเปิดพอร์ต SQL ออกเน็ตแล้วเท่านั้น (ไม่เปิด = connect timeout)
//
// เหตุที่เอา HTTP มาก่อนต่อ SQL ตรง: การต่อตรงต้องเปิดพอร์ต 14322 ของเครื่องออฟฟิศ
// ออกอินเทอร์เน็ต ซึ่งปกติ firewall/เราเตอร์ปิดอยู่ และ SQL Server ที่เปิดออกเน็ต
// ก็เสี่ยงโดนสุ่มรหัส SA ด้วย
//
// ตั้งค่าผ่าน env บน Vercel (ห้ามฝังรหัสผ่านในโค้ด — repo เป็น public):
//   ZK_OFFICE_API_BASE  URL ของ office-server (ไม่ตั้ง = ใช้ USAGE_API_BASE หรือค่า default)
//   ZK_API_BASE         URL ของ host API (ไม่ตั้ง = ใช้ STORE_API_BASE ตัวเดียวกับหน้ายอดขาย)
//   ZK_SOURCE           เลือกทางที่จะลองก่อน: office (default) | host | sql
//   ── ด้านล่างนี้ใช้กับการต่อ SQL ตรง ──
//   ZK_DB_HOST      (default 203.154.185.48)
//   ZK_DB_PORT      (default 14322)
//   ZK_DB_NAME      (default ZKBio9)
//   ZK_DB_USER / ZK_DB_PASSWORD   ← ไม่ตั้ง = ไม่ใช้ทางนี้เลย
//   ZK_DB_INSTANCE  (ไม่บังคับ — ใส่เมื่อเป็น named instance เช่น SQLEXPRESS)
import sql from 'mssql';

// Vercel ใช้ container ซ้ำระหว่าง request — เก็บ pool/แคชชื่อไว้บน globalThis
// เพื่อไม่ให้ต่อ DB ใหม่ทุกครั้ง (hot start จะได้เร็ว) และไม่หายตอน module ถูกโหลดซ้ำ
const g = globalThis;
g.__zkPool = g.__zkPool || null;
g.__zkNameCache = g.__zkNameCache || null;

/** ตั้งไว้ต่ำกว่า maxDuration ของ route (60s) เพื่อให้ได้ error ชัดๆ ก่อนโดน platform ตัด */
const HTTP_TIMEOUT_MS = 50000;

// ════════════ ทางหลัก: office-server /attendance ════════════

// Narai Usage API (office-server) — ตัวที่โปรเจค Narai-branch ใช้ดึงหน้า "สแกนเข้า-ออก"
// ผ่าน /attendance มาตลอด (ไม่ใช่ข้อมูลลับ — เป็น dyndns สาธารณะ)
//
// office-server ย้ายที่รันมาหลายรอบ (ดู office-server/README.md ของ Narai-branch)
// ยังไม่มีทางรู้จากในโค้ดว่าตอนนี้อยู่ที่ไหน จึงไล่ลองตามลำดับความน่าจะเป็น:
//
//   1) usage.khanoykorshabu.com — Cloudflare Tunnel ที่ README แนะนำให้ใช้
//      เครื่องคลาวด์อยู่หลัง NAT (IP ภายใน 172.28.1.48) พอร์ต 8787 จึงเข้าตรงไม่ได้
//      แต่ tunnel ต่อ "ออก" ไปหา Cloudflare เอง — api.khanoykorshabu.com ก็วิ่งทางนี้
//   2) inventory.dyndns.tv:8787 — เครื่องคลาวด์ตรงๆ (ใช้ได้ถ้ามีการ forward พอร์ตแล้ว)
//   3) storenarai.dyndns.tv:8787 — เครื่องออฟฟิศเดิม ยังเปิดอยู่แต่เป็นบิลด์ก่อนมี /attendance
//
// ตั้ง env ZK_OFFICE_API_BASE (หรือ USAGE_API_BASE) เมื่อรู้ค่าที่ถูกแล้ว จะได้ไม่ต้องไล่เดา
const OFFICE_FALLBACK_BASES = [
  'https://usage.khanoykorshabu.com',
  'http://inventory.dyndns.tv:8787',
  'http://storenarai.dyndns.tv:8787',
];

/** ตั้ง env มา = เชื่อค่านั้นค่าเดียว ไม่ไล่เดา */
export const ZK_OFFICE_API_BASES = (() => {
  const pinned = process.env.ZK_OFFICE_API_BASE || process.env.USAGE_API_BASE;
  return pinned ? [pinned.replace(/\/+$/, '')] : OFFICE_FALLBACK_BASES;
})();

// base ที่เข้าไม่ได้จะค้างจน timeout — หารเวลาที่มีให้พอทุกตัว ไม่งั้นชน maxDuration ของ Vercel
// (ตัวที่ใช้ได้จริงตอบภายในไม่กี่วินาที การหารจึงไม่ทำให้ตัวที่ถูกต้องพลาด)
const OFFICE_TRY_MS = Math.floor(HTTP_TIMEOUT_MS / ZK_OFFICE_API_BASES.length);

async function officeGetAttendance(base, qs) {
  // ไม่ลองใหม่ตรงนี้ — ตัวเรียกไล่ base สำรองอยู่แล้ว การลองซ้ำจะกินเวลาของ base ตัวถัดไป
  const r = await fetchUpstream(`${base}/attendance?${qs}`, { timeoutMs: OFFICE_TRY_MS, retries: 0 });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status !== 'success') {
    // บิลด์เก่าไม่มี route นี้ -> express ตอบ 404 เป็น HTML (j เป็น null)
    const e = new Error((j && j.message) || `ตอบ HTTP ${r.status}${r.status === 404 ? ' (บิลด์เก่ายังไม่มี /attendance)' : ''}`);
    e.status = r.status;
    throw e;
  }
  return j.data || [];
}

/**
 * ดึงจาก office-server /attendance — ฝั่งนั้นแปลงชื่อพนักงาน/ป้ายกำกับ/วันที่มาให้เรียบร้อย
 * จึงคืนรูปที่หน้าเว็บใช้ได้เลย (เรียงใหม่→เก่า และตัดที่ 20,000 แถวมาแล้วเหมือนกัน)
 */
export async function fetchAttendanceViaOffice({ start, end, branch, emp }) {
  const p = new URLSearchParams({ start, end });
  if (branch) p.set('branch', branch);
  if (emp) p.set('emp', emp);
  const qs = p.toString();

  const fails = [];
  for (const base of ZK_OFFICE_API_BASES) {
    try {
      return await officeGetAttendance(base, qs);
    } catch (e) {
      fails.push(`${base} → ${e.message}`);
    }
  }
  throw new Error(fails.join(' · '));
}

// ════════════ ทางสำรอง 1: host API (HTTPS) ════════════

/** URL ของ host API — ตัวเดียวกับที่ /api/sales และ /api/ai-chat ใช้ */
export const ZK_API_BASE = process.env.ZK_API_BASE || STORE_API_BASE;

async function hostGet(path) {
  // ทางสำรองชั้นที่ 1 — ยังมีชั้นถัดไปรออยู่ จึงไม่ลองใหม่ให้เสียเวลาเปล่า
  // (fetchUpstream ใส่ header ngrok-skip-browser-warning ให้เองแล้ว เผื่อยังชี้ผ่าน ngrok free)
  const r = await fetchUpstream(`${ZK_API_BASE}${path}`, { timeoutMs: HTTP_TIMEOUT_MS, retries: 0 });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    // ติด status ไปด้วย เพราะ 404 (มีคนตอบ แต่ไม่รู้จัก path) คนละปัญหากับต่อไม่ติด
    const e = new Error((j && j.error) || `host API ตอบ HTTP ${r.status} (${path})`);
    e.status = r.status;
    throw e;
  }
  return Array.isArray(j) ? j : (j && j.data) || [];
}

/** เวลาจาก host API มาเป็น 'YYYY-MM-DD HH:mm:ss' อยู่แล้ว — กัน ISO เผื่อรุ่นอื่นส่งมาไม่เหมือนกัน */
const hostTime = (v) => String(v ?? '').replace('T', ' ').slice(0, 19);

/**
 * ดึงรายการสแกนผ่าน host API — คืนรูปเดียวกับ queryPunches() (ล่าสุดก่อน)
 * end ที่ส่งไปคือ "วันสุดท้ายที่ต้องการ" เพราะฝั่ง host เติม 23:59:59 ให้เอง
 */
export async function fetchPunchesViaHost({ start, end, branch, emp }) {
  const p = new URLSearchParams({ start, end });
  if (branch) p.set('area', branch);
  if (emp) p.set('emp', emp);
  const rows = await hostGet(`/zk/transactions?${p.toString()}`);
  return rows
    .map((r) => ({
      empCode: r.emp_code,
      time: hostTime(r.punch_time),
      state: r.punch_state,
      area: r.area_alias,
      terminal: r.terminal_alias,
    }))
    .sort((a, b) => b.time.localeCompare(a.time)); // host เรียงเก่า→ใหม่ หน้าเว็บอยากได้ใหม่ก่อน
}

/** ชื่อพนักงานผ่าน host API — ใช้แคชชุดเดียวกับทาง SQL ตรง (10 นาที) */
export async function fetchNamesViaHost() {
  const cache = g.__zkNameCache;
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.map;
  const map = {};
  try {
    for (const row of await hostGet('/zk/employees')) {
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      if (row.emp_code) map[String(row.emp_code).trim()] = name;
    }
  } catch (e) {
    // ชื่อเป็นของแถม — ดึงไม่ได้ก็ยังแสดงรายการสแกนด้วยรหัสพนักงานได้
    // ไม่แคชผลที่ล้มเหลว ไม่งั้นชื่อจะหายไปอีก 10 นาทีหลัง host กลับมา
    console.log('อ่านชื่อพนักงานจาก host API ไม่ได้ (จะแสดงเฉพาะรหัส): ' + e.message);
    return {};
  }
  g.__zkNameCache = { at: Date.now(), map };
  return map;
}

// ════════════ ทางสำรอง: ต่อ SQL Server ตรง ════════════

/** ตั้งรหัส SQL ไว้ = อนุญาตให้ต่อตรงได้ */
export const hasDirectDbConfig = () => Boolean(process.env.ZK_DB_USER && process.env.ZK_DB_PASSWORD);

/**
 * ทางที่จะลองก่อนตาม env ZK_SOURCE — 'office' (default) | 'host' | 'sql'
 * ทางที่เหลือยังเป็นทางสำรองให้อยู่ ไม่ได้ตัดทิ้ง
 */
export function preferredSource() {
  const v = String(process.env.ZK_SOURCE || '').toLowerCase();
  if (v.startsWith('sql')) return 'sql';
  if (v.startsWith('host')) return 'host';
  return 'office';
}

export const ZK_CONFIG = {
  server: process.env.ZK_DB_HOST || '203.154.185.48',
  database: process.env.ZK_DB_NAME || 'ZKBio9',
  user: process.env.ZK_DB_USER || '',
  password: process.env.ZK_DB_PASSWORD || '',
  options: {
    encrypt: false,                  // ต่อภายในวง/ผ่าน IP ตรง ไม่ได้ใช้ TLS ฝั่ง SQL
    trustServerCertificate: true,
    ...(process.env.ZK_DB_INSTANCE ? { instanceName: process.env.ZK_DB_INSTANCE } : {}),
  },
  ...(process.env.ZK_DB_INSTANCE ? {} : { port: Number(process.env.ZK_DB_PORT) || 14322 }),
  // serverless: แต่ละ instance รับทีละ request อยู่แล้ว pool เล็กพอ
  pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 25000,
  connectionTimeout: 12000,
};

// ค่าที่ถูกต้องบนเครื่องออฟฟิศ (ที่ SQL อยู่เครื่องเดียวกัน) แต่ใช้บน Vercel ไม่ได้
// เจอบ่อยเพราะคัดลอกทั้งบล็อกมาจาก .env ของ office-server — บอกให้ชัดดีกว่าปล่อยให้ timeout งงๆ
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

export async function getZkPool() {
  if (!ZK_CONFIG.user || !ZK_CONFIG.password) {
    throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ ZKBio — ต้องตั้ง env ZK_DB_USER และ ZK_DB_PASSWORD บน Vercel');
  }
  if (LOCAL_HOSTS.includes(String(ZK_CONFIG.server).toLowerCase())) {
    throw new Error(
      `ZK_DB_HOST ตั้งเป็น "${ZK_CONFIG.server}" ไม่ได้ — โค้ดนี้รันบน Vercel ไม่ได้อยู่เครื่องเดียวกับ SQL Server ` +
      '(ค่า localhost ใช้ได้เฉพาะบน office-server) ให้ลบ ZK_DB_HOST ออกเพื่อใช้ค่า default 203.154.185.48 หรือใส่ IP จริง'
    );
  }
  if (g.__zkPool && g.__zkPool.connected) return g.__zkPool;
  if (g.__zkPool) { try { await g.__zkPool.close(); } catch { /* pool เดิมตายไปแล้ว */ } }
  try {
    const pool = await new sql.ConnectionPool(ZK_CONFIG).connect();
    pool.on('error', () => { g.__zkPool = null; }); // ต่อหลุด -> สร้างใหม่รอบหน้า
    g.__zkPool = pool;
    return pool;
  } catch (e) {
    g.__zkPool = null;
    throw new Error(`ต่อฐานข้อมูล ZKBio (${ZK_CONFIG.server}:${ZK_CONFIG.port || ZK_CONFIG.options.instanceName}/${ZK_CONFIG.database}) ไม่ได้: ${e.message}`);
  }
}

// ชื่อพนักงาน — เป็นของแถม ถ้าตารางคนละโครงก็ยังคืนรายการสแกนได้ตามปกติ
// ชื่อเปลี่ยนน้อย แคชไว้ 10 นาทีพอ (เหมือน office-server)
export async function zkNameMap(pool) {
  const cache = g.__zkNameCache;
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.map;
  const map = {};
  try {
    const r = await pool.request().query('SELECT emp_code, first_name, last_name FROM dbo.personnel_employee');
    for (const row of r.recordset) {
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      if (row.emp_code) map[String(row.emp_code).trim()] = name;
    }
  } catch (e) {
    console.log('อ่านชื่อพนักงานจาก personnel_employee ไม่ได้ (จะแสดงเฉพาะรหัส): ' + e.message);
  }
  g.__zkNameCache = { at: Date.now(), map };
  return map;
}

/** จำนวนแถวสูงสุดต่อการดึงหนึ่งครั้ง — ชนเพดานเมื่อไหร่ = ช่วงวันที่กว้างเกิน */
export const ZK_ROW_CAP = 20000;

/**
 * ดึงรายการสแกนดิบจากตาราง iclock_transaction
 * คืน [{ empCode, time, state, area, terminal }] เรียงเวลาล่าสุดก่อน
 *
 * แปลงเวลาเป็นข้อความฝั่ง SQL (style 120 = yyyy-mm-dd hh:mi:ss)
 * กันปัญหา timezone เพี้ยนตอน JS แปลงเป็น Date แล้วส่งเป็น JSON
 */
export async function queryPunches(pool, { start, endExclusive, branch, emp }) {
  const rq = pool.request()
    .input('start', sql.VarChar(10), start)
    .input('endEx', sql.VarChar(10), endExclusive);

  let where = 'punch_time >= CONVERT(datetime2, @start, 23) AND punch_time < CONVERT(datetime2, @endEx, 23)';
  if (branch) {
    rq.input('branch', sql.NVarChar(64), branch);
    where += ' AND UPPER(area_alias) = @branch';
  }
  if (emp) {
    rq.input('emp', sql.NVarChar(64), emp);
    where += ' AND emp_code = @emp';
  }

  const r = await rq.query(`
    SELECT TOP (${ZK_ROW_CAP})
      emp_code                              AS empCode,
      CONVERT(varchar(19), punch_time, 120) AS time,
      punch_state                           AS state,
      area_alias                            AS area,
      terminal_alias                        AS terminal
    FROM dbo.iclock_transaction
    WHERE ${where}
    ORDER BY punch_time DESC`);

  return r.recordset;
}
