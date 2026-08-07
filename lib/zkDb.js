// ต่อฐานข้อมูล ZKBio Time 9 (SQL Server) โดยตรงจาก API route
// ใช้ค่า config/คิวรี่ชุดเดียวกับ office-server ของโปรเจค Narai-branch ที่ใช้งานจริงอยู่
//
// ตั้งค่าผ่าน env บน Vercel (ห้ามฝังรหัสผ่านในโค้ด — repo เป็น public):
//   ZK_DB_HOST      (default 203.154.185.48)
//   ZK_DB_PORT      (default 14322)
//   ZK_DB_NAME      (default ZKBio9)
//   ZK_DB_USER / ZK_DB_PASSWORD   ← ต้องตั้งเอง ไม่มีค่า default
//   ZK_DB_INSTANCE  (ไม่บังคับ — ใส่เมื่อเป็น named instance เช่น SQLEXPRESS)
import sql from 'mssql';

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

// Vercel ใช้ container ซ้ำระหว่าง request — เก็บ pool/แคชชื่อไว้บน globalThis
// เพื่อไม่ให้ต่อ DB ใหม่ทุกครั้ง (hot start จะได้เร็ว) และไม่หายตอน module ถูกโหลดซ้ำ
const g = globalThis;
g.__zkPool = g.__zkPool || null;
g.__zkNameCache = g.__zkNameCache || null;

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
