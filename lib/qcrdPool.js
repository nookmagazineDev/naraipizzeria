// ต่อ SQL Server ของ QC/RD ตรงจาก Vercel — ฐาน InventoryNarai
//
// เครื่องเดียวกับที่หน้า "ดูสแกนหน้า" (ZKBio9) และตารางงาน (narai_hr) ใช้อยู่แล้ว
// คือ NARAI-PIZZARIA\SQLEXPRESS ที่ inventory.dyndns.tv ซึ่งตรึง TCP 1433 ไว้และเปิดออกเน็ตแล้ว
// (Narai-branch ต่อตรงแบบนี้กับ narai_hr มาตลอด — ดู lib/mssql.js ของรีโปนั้น)
// จึงไม่ต้องรอ host-server/tunnel ก็อ่าน-เขียน QC/RD ได้
//
// ไม่ต้องตั้ง env ใหม่ก็ได้ — ใช้ชุดที่โปรเจกต์นี้มีอยู่แล้วต่อได้เลย เพราะเป็น SQL Server เครื่องเดียวกัน
// ลำดับการเลือกค่า (ตัวไหนตั้งไว้ก่อนใช้ตัวนั้น):
//   ผู้ใช้:     QCRD_DB_USER/PASSWORD -> ZK_DB_USER/PASSWORD (หน้าสแกนหน้า) -> HR_DB_USER/PASSWORD (ตารางงาน)
//   เครื่อง:    QCRD_DB_HOST -> HR_DB_HOST -> ZK_DB_HOST -> inventory.dyndns.tv (ชี้ไป 203.154.185.48)
//   พอร์ต:     QCRD_DB_PORT -> HR_DB_PORT -> ZK_DB_PORT -> 1433
//              ต่อไม่ติดให้เรียก /api/qcrd-migrate?...&step=probe ดูว่าพอร์ตไหนเปิดจริง แล้วตั้งทับ
//   ฐานข้อมูล:  QCRD_DB_NAME (ค่าเริ่มต้น InventoryNarai)
//   QCRD_DB_ENCRYPT=1 เมื่อเปิด TLS ที่ SQL Server แล้ว
// ไม่มี user/password สักชุด = ไม่ใช้ทางนี้ (ถอยไปใช้ host API หรือชีท)
//
// ⚠️ login ที่ใช้ต้องได้สิทธิ์ในฐาน InventoryNarai ด้วย — ZK_DB_USER เดิมมีสิทธิ์แค่ใน ZKBio9
//    ถ้ายังไม่ได้ให้สิทธิ์ จะต่อติดแต่ query ไม่ผ่าน ขึ้นว่า "is not able to access the database"
//    (คำสั่งให้สิทธิ์อยู่ท้าย docs/schema-qcrd.sql)
import sql from 'mssql';
import { createQcrd } from './qcrdSql.mjs';

// Vercel ใช้ container ซ้ำระหว่าง request — เก็บ pool ไว้บน globalThis ให้ hot start ไม่ต้องต่อใหม่
const g = globalThis;
g.__qcrdPool = g.__qcrdPool || null;

/** ชุด user/password ที่จะใช้ + มาจาก env ตัวไหน (ไว้บอกใน /api/qcrd-migrate?step=check) */
export function credentials() {
  const pick = [
    ['QCRD_DB', process.env.QCRD_DB_USER, process.env.QCRD_DB_PASSWORD],
    ['ZK_DB', process.env.ZK_DB_USER, process.env.ZK_DB_PASSWORD],
    ['HR_DB', process.env.HR_DB_USER, process.env.HR_DB_PASSWORD],
  ].find(([, u, p]) => u && p);
  return pick ? { from: pick[0], user: pick[1], password: pick[2] } : { from: null };
}

function buildConfig() {
  const c = credentials();
  return {
    // ค่าเริ่มต้นเป็นพอร์ต SQL มาตรฐาน 1433 ของเครื่องเดียวกัน (inventory.dyndns.tv ชี้ไป 203.154.185.48)
    // ไม่ใช้ 14322 เป็นค่าเริ่มต้นแล้ว — พอร์ตนั้นที่เครื่องนี้คือ Remote Desktop ไม่ใช่ SQL
    // ถ้าปลายทางจริงใช้พอร์ตอื่น ให้หาด้วย /api/qcrd-migrate?...&step=probe แล้วตั้ง QCRD_DB_HOST/PORT
    server: process.env.QCRD_DB_HOST || process.env.HR_DB_HOST || process.env.ZK_DB_HOST || 'inventory.dyndns.tv',
    port: Number(process.env.QCRD_DB_PORT || process.env.HR_DB_PORT || process.env.ZK_DB_PORT) || 1433,
    database: process.env.QCRD_DB_NAME || 'InventoryNarai',
    user: c.user,
    password: c.password,
    // ต่อไม่ติดยิ่งรู้เร็วยิ่งดี — เวลาที่เหลือเอาไว้ให้ทางถอย (host API) ซึ่งช้ากว่าอยู่แล้ว
    // ที่ร้านเปิดไฟร์วอลล์ให้เฉพาะ IP ในไทย Vercel จึงต่อตรงไม่ติดเป็นปกติ รอ 15 วิทุกครั้ง
    // แปลว่ากินงบเวลาของฟังก์ชัน (60 วิ) ไปหนึ่งในสี่ฟรี ๆ — ปลายทางที่ต่อติดใช้เวลาไม่ถึงวินาที
    // ยืดได้ด้วย QCRD_DB_CONNECT_TIMEOUT (มิลลิวินาที) ถ้าวันหลังเปิดพอร์ตแล้วเน็ตอืด
    connectionTimeout: Number(process.env.QCRD_DB_CONNECT_TIMEOUT) || 8000,
    requestTimeout: 25000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: String(process.env.QCRD_DB_ENCRYPT || process.env.HR_DB_ENCRYPT || '') === '1',
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    // ต่อพอร์ตตรงเสมอ ไม่ใช้ instanceName เพราะ named instance ต้องถาม SQL Browser ที่ UDP 1434
    // ซึ่งจากนอกออฟฟิศไม่ติด (เป็นบั๊กที่หาสาเหตุยาก — อาการคือหมดเวลาทั้งที่ SQL ปกติดี)
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

/** แปลง error ของ SQL Server ที่เจอบ่อยให้บอกวิธีแก้ได้เลย */
export function explainDbError(err) {
  const msg = err?.message || String(err);
  if (/is not able to access the database|Cannot open database/i.test(msg)) {
    const from = credentials().from;
    return `${msg}\n→ login ที่ใช้ (${from}_USER) ยังไม่มีสิทธิ์ในฐาน ${process.env.QCRD_DB_NAME || 'InventoryNarai'} ` +
      '— ให้สิทธิ์ด้วยคำสั่งท้ายไฟล์ docs/schema-qcrd.sql (CREATE USER + db_datareader/db_datawriter, ' +
      'และ db_ddladmin ถ้าจะให้สร้างตารางจากหน้าเว็บด้วย)';
  }
  if (/Invalid object name 'dbo\.qcrd_/i.test(msg)) {
    return `${msg}\n→ ยังไม่ได้สร้างตาราง — รัน /api/qcrd-migrate?...&step=schema&confirm=1 ก่อน ` +
      '(หรือรัน docs/schema-qcrd.sql ที่เครื่องออฟฟิศ)';
  }
  if (/permission was denied|CREATE TABLE permission/i.test(msg)) {
    return `${msg}\n→ login นี้สร้างตารางไม่ได้ — เพิ่ม db_ddladmin ให้ก่อน หรือรัน docs/schema-qcrd.sql ` +
      'ที่เครื่องออฟฟิศด้วย sa ครั้งเดียวแล้วข้าม step=schema ไป';
  }
  return msg;
}

async function getPool() {
  if (!g.__qcrdPool) {
    g.__qcrdPool = new sql.ConnectionPool(buildConfig()).connect().catch((err) => {
      g.__qcrdPool = null;   // ต่อไม่ติด อย่าจำ promise ที่พังไว้ ครั้งหน้าจะได้ลองใหม่จริง ๆ
      throw new Error(`ต่อ SQL Server (${describeTarget()}) ไม่ได้: ${explainDbError(err)}`);
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

export async function runQuery(text, params = {}, tx = null) {
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
    if (tx || !isRecoverable(err)) throw new Error(explainDbError(err));
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
