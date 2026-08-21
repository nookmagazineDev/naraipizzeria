// ต่อ SQL Server ของ QC/RD ตรงจาก Vercel — ฐาน InventoryNarai
//
// เครื่องเดียวกับที่หน้า "ดูสแกนหน้า" (ZKBio9) และตารางงาน (narai_hr) ใช้อยู่แล้ว
// คือ NARAI-PIZZARIA\SQLEXPRESS ที่ inventory.dyndns.tv ซึ่งตรึง TCP 1433 ไว้และเปิดออกเน็ตแล้ว
// (Narai-branch ต่อตรงแบบนี้กับ narai_hr มาตลอด — ดู lib/mssql.js ของรีโปนั้น)
// จึงไม่ต้องรอ host-server/tunnel ก็อ่าน-เขียน QC/RD ได้
//
// env บน Vercel (ห้ามฝังรหัสผ่านในโค้ด — repo เป็น public):
//   QCRD_DB_HOST      (ไม่ตั้ง = HR_DB_HOST หรือ inventory.dyndns.tv)
//   QCRD_DB_PORT      (ไม่ตั้ง = HR_DB_PORT หรือ 1433)
//   QCRD_DB_NAME      (ไม่ตั้ง = InventoryNarai)
//   QCRD_DB_USER / QCRD_DB_PASSWORD   ไม่ตั้ง = ใช้ HR_DB_USER / HR_DB_PASSWORD ชุดเดียวกับตารางงาน
//                                     ไม่มีทั้งคู่ = ไม่ใช้ทางนี้ (ถอยไปใช้ host API หรือชีท)
//   QCRD_DB_ENCRYPT=1 เมื่อเปิด TLS ที่ SQL Server แล้ว
//
// ⚠️ login ที่ใช้ต้องมีสิทธิ์ในฐาน InventoryNarai ด้วย ไม่ใช่แค่ narai_hr
//    (ส่วนให้สิทธิ์อยู่ท้าย docs/schema-qcrd.sql — ลืมแล้วจะต่อติดแต่ query ไม่ผ่าน)
import sql from 'mssql';
import { createQcrd } from './qcrdSql.mjs';

// Vercel ใช้ container ซ้ำระหว่าง request — เก็บ pool ไว้บน globalThis ให้ hot start ไม่ต้องต่อใหม่
const g = globalThis;
g.__qcrdPool = g.__qcrdPool || null;

function buildConfig() {
  return {
    server: process.env.QCRD_DB_HOST || process.env.HR_DB_HOST || 'inventory.dyndns.tv',
    port: Number(process.env.QCRD_DB_PORT || process.env.HR_DB_PORT) || 1433,
    database: process.env.QCRD_DB_NAME || 'InventoryNarai',
    user: process.env.QCRD_DB_USER || process.env.HR_DB_USER,
    password: process.env.QCRD_DB_PASSWORD || process.env.HR_DB_PASSWORD,
    connectionTimeout: 15000,
    requestTimeout: 25000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: String(process.env.QCRD_DB_ENCRYPT || process.env.HR_DB_ENCRYPT || '') === '1',
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    // named instance ต้องถาม SQL Browser ที่ UDP 1434 ก่อน ซึ่งจากนอกออฟฟิศไม่ติด
    // อินสแตนซ์นี้ตรึงพอร์ต 1433 อยู่แล้ว จึงต่อพอร์ตตรงเสมอ (เหมือน lib/mssql.js ของ Narai-branch)
  };
}

/** ปลายทางที่กำลังจะต่อ — แนบท้าย error ได้ ไม่มี user/password อยู่ในนี้ */
export function describeTarget() {
  const c = buildConfig();
  return `${c.server}:${c.port}/${c.database}`;
}

/** ตั้ง user/password มาแล้วหรือยัง — ไม่ตั้ง = ไม่ต้องลองทางนี้เลย */
export function isConfigured() {
  const c = buildConfig();
  return Boolean(c.user && c.password);
}

async function getPool() {
  if (!g.__qcrdPool) {
    g.__qcrdPool = new sql.ConnectionPool(buildConfig()).connect().catch((err) => {
      g.__qcrdPool = null;   // ต่อไม่ติด อย่าจำ promise ที่พังไว้ ครั้งหน้าจะได้ลองใหม่จริง ๆ
      throw new Error(`ต่อ SQL Server (${describeTarget()}) ไม่ได้: ${err.message}`);
    });
  }
  const pool = await g.__qcrdPool;
  if (!pool.connected && !pool.connecting) {
    g.__qcrdPool = null;
    return getPool();
  }
  return pool;
}

async function resetPool() {
  const p = g.__qcrdPool;
  g.__qcrdPool = null;
  try { await (await p)?.close(); } catch { /* pool พังอยู่แล้ว ปิดไม่ได้ก็ช่างมัน */ }
}

// error ที่แปลว่า "การเชื่อมต่อเดิมใช้ไม่ได้แล้ว" — เกิดประจำเมื่อ Vercel ปลุกฟังก์ชันที่ถูกแช่แข็งไว้
// แล้ว socket เดิมถูก NAT ฝั่งปลายทางตัดทิ้งไปแล้ว (อาการ: ครั้งแรกพัง กดซ้ำอีกทีติด)
const RECOVERABLE = new Set(['ESOCKET', 'ECONNCLOSED', 'ENOCONN', 'ETIMEOUT', 'ECONNRESET', 'EPIPE']);
const isRecoverable = (err) =>
  RECOVERABLE.has(err?.code) || /connection is closed|not connected/i.test(err?.message || '');

async function runQuery(text, params = {}, tx = null) {
  const exec = async () => {
    const req = tx ? new sql.Request(tx) : (await getPool()).request();
    for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
    const r = await req.query(text);
    return r.recordset || [];
  };
  try {
    return await exec();
  } catch (err) {
    // ใน transaction ต่อ pool ใหม่ไม่ได้ (transaction ผูกกับ connection เดิม) ต้องปล่อยให้ rollback
    if (tx || !isRecoverable(err)) throw err;
    await resetPool();
    return exec();
  }
}

async function withTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (err) {
    try { await tx.rollback(); } catch { /* rollback ล้มก็ไม่มีอะไรให้ทำต่อ */ }
    if (isRecoverable(err)) await resetPool();
    throw err;
  }
}

/** ตรรกะ QC/RD ชุดเดียวกับที่ host-server ใช้ ผูกกับ pool ตัวนี้ */
export const qcrd = createQcrd({ q: runQuery, withTx: withTransaction });
