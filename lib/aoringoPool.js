// ต่อ SQL Server ของร้านเฟรนไชส์ตรงจาก Vercel — ฐาน Aoringo
//
// เครื่องเดียวกับที่ QC/RD (InventoryNarai) กับหน้าสแกนหน้า (ZKBio9) ใช้อยู่แล้ว คือ 203.154.185.48
// (ชื่อโดเมนเดิมคือ inventory.dyndns.tv) ต่างกันแค่ "ฐานข้อมูล" เท่านั้น จึงใช้ทางเดิมได้เลย
//
// ไม่ต้องตั้ง env ใหม่ก็ได้ ถ้า login เดิมมีสิทธิ์อ่านฐาน Aoringo ด้วย
// ลำดับการเลือกค่า (ตัวไหนตั้งไว้ก่อนใช้ตัวนั้น):
//   ผู้ใช้:     AORINGO_DB_USER/PASSWORD -> QCRD_DB_USER/PASSWORD -> ZK_DB_USER/PASSWORD -> HR_DB_USER/PASSWORD
//   เครื่อง:    AORINGO_DB_HOST -> QCRD_DB_HOST -> HR_DB_HOST -> ZK_DB_HOST -> 203.154.185.48
//   พอร์ต:     AORINGO_DB_PORT -> QCRD_DB_PORT -> HR_DB_PORT -> ZK_DB_PORT -> 1433
//   ฐานข้อมูล:  AORINGO_DB_NAME (ค่าเริ่มต้น Aoringo)
//   AORINGO_DB_ENCRYPT=1 เมื่อเปิด TLS ที่ SQL Server แล้ว
// ไม่มี user/password สักชุด = ไม่ใช้ทางนี้ (ถอยไป host API — ดู lib/aoringoSource.js)
//
// ⚠️ login ที่ใช้ต้องได้สิทธิ์ในฐาน Aoringo ด้วย ไม่ใช่แค่ InventoryNarai
//    ยังไม่ได้ให้สิทธิ์ = ต่อติดแต่ query ไม่ผ่าน ขึ้นว่า "is not able to access the database"
//    (ที่เครื่อง SQL:  USE Aoringo; CREATE USER [<login>] FOR LOGIN [<login>];
//                      ALTER ROLE db_datareader ADD MEMBER [<login>];  — หน้านี้อ่านอย่างเดียว)
import sql from 'mssql';
import { createAoringo } from './aoringoSql.mjs';

// Vercel ใช้ container ซ้ำระหว่าง request — เก็บ pool ไว้บน globalThis ให้ hot start ไม่ต้องต่อใหม่
const g = globalThis;
g.__aoringoPool = g.__aoringoPool || null;

const DEFAULT_HOST = '203.154.185.48';
const DEFAULT_DB = 'Aoringo';

/** ชุด user/password ที่จะใช้ + มาจาก env ตัวไหน (ไว้บอกใน /api/franchise?view=diag) */
export function credentials() {
  const pick = [
    ['AORINGO_DB', process.env.AORINGO_DB_USER, process.env.AORINGO_DB_PASSWORD],
    ['QCRD_DB', process.env.QCRD_DB_USER, process.env.QCRD_DB_PASSWORD],
    ['ZK_DB', process.env.ZK_DB_USER, process.env.ZK_DB_PASSWORD],
    ['HR_DB', process.env.HR_DB_USER, process.env.HR_DB_PASSWORD],
  ].find(([, u, p]) => u && p);
  return pick ? { from: pick[0], user: pick[1], password: pick[2] } : { from: null };
}

function buildConfig() {
  const c = credentials();
  return {
    server: process.env.AORINGO_DB_HOST || process.env.QCRD_DB_HOST || process.env.HR_DB_HOST ||
            process.env.ZK_DB_HOST || DEFAULT_HOST,
    port: Number(process.env.AORINGO_DB_PORT || process.env.QCRD_DB_PORT ||
                 process.env.HR_DB_PORT || process.env.ZK_DB_PORT) || 1433,
    database: process.env.AORINGO_DB_NAME || DEFAULT_DB,
    user: c.user,
    password: c.password,
    // ต่อไม่ติดยิ่งรู้เร็วยิ่งดี — เวลาที่เหลือเอาไว้ให้ทางถอย (host API) ซึ่งช้ากว่าอยู่แล้ว
    connectionTimeout: Number(process.env.AORINGO_DB_CONNECT_TIMEOUT) || 8000,
    requestTimeout: 40000,   // ดึงบิลทั้งเดือนหนักกว่าคำสั่งของ QC/RD ที่ทีละไม่กี่ร้อยแถว
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: String(process.env.AORINGO_DB_ENCRYPT || process.env.QCRD_DB_ENCRYPT || '') === '1',
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    // ต่อพอร์ตตรงเสมอ ไม่ใช้ instanceName เพราะ named instance ต้องถาม SQL Browser ที่ UDP 1434
    // ซึ่งจากนอกออฟฟิศไม่ติด (อาการคือหมดเวลาทั้งที่ SQL ปกติดี)
  };
}

/** ปลายทางที่กำลังจะต่อ — แนบท้าย error ได้ ไม่มี user/password อยู่ในนี้ */
export function describeTarget() {
  const c = buildConfig();
  const from = credentials().from;
  return `${c.server}:${c.port}/${c.database}${from ? ` (ใช้ ${from}_USER)` : ''}`;
}

/** มี user/password สักชุดไหม — ไม่มี = ไม่ต้องลองทางนี้เลย */
export function isConfigured() {
  return Boolean(credentials().from);
}

/** แปล error ของ SQL Server ที่เจอบ่อยให้บอกวิธีแก้ได้เลย */
export function explainDbError(err) {
  const msg = err?.message || String(err);
  const dbName = process.env.AORINGO_DB_NAME || DEFAULT_DB;
  if (/is not able to access the database|Cannot open database/i.test(msg)) {
    const from = credentials().from;
    return `${msg}\n→ login ที่ใช้ (${from}_USER) ยังไม่มีสิทธิ์ในฐาน ${dbName} ` +
      `— ที่เครื่อง SQL สั่ง: USE ${dbName}; CREATE USER [<login>] FOR LOGIN [<login>]; ` +
      'ALTER ROLE db_datareader ADD MEMBER [<login>];';
  }
  if (/Invalid object name/i.test(msg)) {
    return `${msg}\n→ ชื่อตารางในฐาน ${dbName} ไม่ตรงกับที่จับคู่ไว้ — ดู /api/franchise?view=schema ` +
      'แล้วตั้ง env AORINGO_BILL_TABLE / AORINGO_ITEM_TABLE / AORINGO_EXPENSE_TABLE ทับ';
  }
  return msg;
}

async function getPool() {
  if (!g.__aoringoPool) {
    g.__aoringoPool = new sql.ConnectionPool(buildConfig()).connect().catch((err) => {
      g.__aoringoPool = null;   // ต่อไม่ติด อย่าจำ promise ที่พังไว้ ครั้งหน้าจะได้ลองใหม่จริง ๆ
      throw new Error(`ต่อ SQL Server (${describeTarget()}) ไม่ได้: ${explainDbError(err)}`);
    });
  }
  const pool = await g.__aoringoPool;
  if (!pool.connected && !pool.connecting) {
    g.__aoringoPool = null;
    return getPool();
  }
  return pool;
}

async function resetPool() {
  const p = g.__aoringoPool;
  g.__aoringoPool = null;
  try { await (await p)?.close(); } catch { /* pool พังอยู่แล้ว ปิดไม่ได้ก็ช่างมัน */ }
}

// error ที่แปลว่า "การเชื่อมต่อเดิมใช้ไม่ได้แล้ว" — เกิดประจำเมื่อ Vercel ปลุกฟังก์ชันที่ถูกแช่แข็งไว้
// แล้ว socket เดิมถูก NAT ฝั่งปลายทางตัดทิ้งไปแล้ว (อาการ: ครั้งแรกพัง กดซ้ำอีกทีติด)
const RECOVERABLE = new Set(['ESOCKET', 'ECONNCLOSED', 'ENOCONN', 'ETIMEOUT', 'ECONNRESET', 'EPIPE']);
const isRecoverable = (err) =>
  RECOVERABLE.has(err?.code) || /connection is closed|not connected/i.test(err?.message || '');

export async function runQuery(text, params = {}) {
  const exec = async () => {
    const req = (await getPool()).request();
    for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
    const r = await req.query(text);
    return r.recordset || [];
  };
  try {
    return await exec();
  } catch (err) {
    if (!isRecoverable(err)) throw new Error(explainDbError(err));
    await resetPool();
    return exec();
  }
}

/** ตรรกะเฟรนไชส์ชุดเดียวกับที่ host-server ใช้ ผูกกับ pool ตัวนี้ */
export const aoringo = createAoringo({ q: runQuery });
