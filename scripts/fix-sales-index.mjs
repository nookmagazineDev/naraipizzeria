#!/usr/bin/env node
/**
 * แก้ปัญหา "หน้าแดชบอร์ดดึงยอดขายไม่ขึ้น / ขึ้น HTTP 500" ที่ต้นเหตุ —
 * สร้าง index ตามวันที่ให้ตาราง Cpaid/Ctrans บนฐาน NaraiPos
 *
 * ทำไมต้องมี: query ของ /cpaidbetweendate กับ /ctranbetweendate กรองด้วยคอลัมน์วันที่
 * ที่ไม่มี index เลย SQL Server จึงต้องสแกนทั้งตารางทุกครั้ง (Cpaid 3.4 แสนแถว ·
 * Ctrans 7.5 ล้านแถว) วันเดียวใช้เวลาถึง 125 วิ แล้วโดนตัดทิ้งกลางทาง
 * รายละเอียดการวัดผลอยู่ใน docs/fix-slow-sales-index.sql (ไฟล์นี้คือตัวเดียวกัน
 * แต่รันด้วย node ได้เลย ไม่ต้องเปิด SSMS)
 *
 *   node scripts/fix-sales-index.mjs            → เช็กสถานะ + สร้าง IX_Cpaid_Date (เร็ว เสี่ยงน้อย)
 *   node scripts/fix-sales-index.mjs --check    → ดูอย่างเดียว ไม่สร้างอะไร
 *   node scripts/fix-sales-index.mjs --ctrans   → สร้าง IX_Ctrans_PostTime ด้วย (⚠️ ล็อกตารางหลายนาที)
 *   node scripts/fix-sales-index.mjs --date=2026-09-09   → วันที่ที่ใช้จับเวลา (ค่าเริ่มต้น = เมื่อวาน)
 *
 * ⚠️ ขั้น --ctrans ต้องทำตอน "ปิดร้าน" เท่านั้น SQL Server Express สร้าง index แบบ ONLINE ไม่ได้
 *    ระหว่างสร้างตารางจะถูกล็อก = POS ทุกสาขาขายไม่ได้
 *
 * ค่าเชื่อมต่อใช้ env ชุดเดียวกับ host-server/server.js (โหลดจาก host-server/db.env.ps1 ได้):
 *   DB_SERVER (มี \instance ได้ · ค่าเริ่มต้น localhost) · DB_PORT · DB_NAME (NaraiPos)
 *   DB_USER · DB_PASSWORD
 */
import process from 'node:process';
import { loadMssql } from './qcrdDb.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const CHECK_ONLY = has('--check');
const DO_CTRANS = has('--ctrans');

const dateArg = args.find((a) => a.startsWith('--date='));
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const PROBE_DATE = dateArg ? dateArg.slice(7) : yesterday;
if (!/^\d{4}-\d{2}-\d{2}$/.test(PROBE_DATE)) {
  console.error(`รูปแบบวันที่ไม่ถูกต้อง: ${PROBE_DATE} (ต้องเป็น YYYY-MM-DD)`);
  process.exit(1);
}

const RAW_SERVER = process.env.SALES_DB_SERVER || process.env.DB_SERVER || 'localhost';
const DB_NAME = process.env.DB_NAME || 'NaraiPos';
const [host, instance] = RAW_SERVER.split('\\');

/** index ที่ต้องมี — ชื่อ · ตาราง · คอลัมน์ที่ query ใช้กรองจริง */
const PLAN = [
  {
    key: 'cpaid',
    index: 'IX_Cpaid_Date',
    table: 'dbo.Cpaid',
    column: '[Date]',
    note: 'ยอดบิล (/cpaidbetweendate) — ตารางเล็ก สร้างเสร็จในไม่กี่วินาที',
    heavy: false,
  },
  {
    key: 'ctrans',
    index: 'IX_Ctrans_PostTime',
    table: 'dbo.Ctrans',
    column: 'PostTime',
    note: 'รายการไอเทม (/ctranbetweendate) — 7.5 ล้านแถว ล็อกตารางหลายนาที ต้องทำตอนปิดร้าน',
    heavy: true,
  },
];

const fmtSecs = (ms) => `${(ms / 1000).toFixed(1)} วิ`;

async function openPool() {
  const mssql = await loadMssql();
  const config = {
    server: host,
    database: DB_NAME,
    user: process.env.DB_USER || 'SA',
    password: process.env.DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
      ...(instance ? { instanceName: instance } : {}),
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    // สร้าง index บน Ctrans ใช้เวลาหลายนาที — ห้ามให้ driver ตัดทิ้งกลางทาง
    requestTimeout: 60 * 60 * 1000,
    connectionTimeout: 20000,
  };
  if (!instance) config.port = Number(process.env.DB_PORT) || 1433;
  try {
    const pool = await new mssql.ConnectionPool(config).connect();
    pool.__mssql = mssql;
    return pool;
  } catch (err) {
    throw new Error(
      `ต่อ SQL Server (${RAW_SERVER}/${DB_NAME}) ไม่ได้: ${err.message}\n` +
      '  · รันสคริปต์นี้ที่ "เครื่องออฟฟิศ" ที่มี SQL Server อยู่\n' +
      '  · named instance ต้องเปิด service "SQL Server Browser" ด้วย\n' +
      '  · ยังไม่ได้ตั้งรหัส ให้ตั้ง $env:DB_PASSWORD หรือใช้ scripts\\fix-sales-index.ps1 ซึ่งโหลดให้เอง'
    );
  }
}

/** index นี้มีอยู่แล้วไหม */
async function indexExists(pool, table, index) {
  const r = await pool.request()
    .input('t', pool.__mssql.VarChar, table)
    .input('i', pool.__mssql.VarChar, index)
    .query('SELECT 1 AS ok FROM sys.indexes WHERE name = @i AND object_id = OBJECT_ID(@t)');
  return r.recordset.length > 0;
}

/** จำนวนแถวของตาราง (อ่านจาก metadata — ไม่ต้องสแกนตาราง) */
async function rowCount(pool, table) {
  const r = await pool.request()
    .input('t', pool.__mssql.VarChar, table)
    .query(
      'SELECT SUM(row_count) AS n FROM sys.dm_db_partition_stats ' +
      'WHERE object_id = OBJECT_ID(@t) AND index_id IN (0, 1)'
    );
  return Number(r.recordset[0]?.n || 0);
}

/** จับเวลา query จริงที่หน้าเว็บใช้ (นับแถวของวันเดียว) */
async function timeProbe(pool, table, column) {
  const t0 = Date.now();
  const r = await pool.request()
    .input('s', pool.__mssql.VarChar, `${PROBE_DATE} 00:00:00`)
    .input('e', pool.__mssql.VarChar, `${PROBE_DATE} 23:59:59`)
    .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= @s AND ${column} <= @e`);
  return { ms: Date.now() - t0, rows: Number(r.recordset[0]?.n || 0) };
}

const pool = await openPool();
console.log(`ปลายทาง: ${RAW_SERVER}/${DB_NAME}  (user: ${process.env.DB_USER || 'SA'})`);
console.log(`วันที่ที่ใช้จับเวลา: ${PROBE_DATE}\n`);

let created = 0;
let skippedHeavy = false;
try {
  for (const step of PLAN) {
    const exists = await indexExists(pool, step.table, step.index);
    const rows = await rowCount(pool, step.table);
    console.log(`── ${step.table} (${rows.toLocaleString('en-US')} แถว)`);
    console.log(`   ${step.note}`);
    console.log(`   ${step.index}: ${exists ? '✓ มีอยู่แล้ว' : '✗ ยังไม่มี'}`);

    // จับเวลาด้วย query แบบเดียวกับที่หน้าเว็บใช้ — ตอนยังไม่มี index ขั้นนี้เองก็ช้า
    if (!exists) console.log('   ⏱  กำลังจับเวลาก่อนแก้ (ยังไม่มี index ขั้นนี้อาจกินเวลาหลายนาที) ...');
    const before = await timeProbe(pool, step.table, step.column);
    console.log(`   เวลาดึงข้อมูลวันเดียวตอนนี้: ${fmtSecs(before.ms)} (${before.rows.toLocaleString('en-US')} แถว)`);

    if (exists) { console.log(''); continue; }
    if (CHECK_ONLY) { console.log('   (โหมด --check ไม่สร้างให้)\n'); continue; }
    if (step.heavy && !DO_CTRANS) {
      skippedHeavy = true;
      console.log('   ⏭  ข้ามไว้ก่อน — ขั้นนี้ล็อกตารางหลายนาที ใส่ --ctrans ตอนปิดร้านถึงจะสร้างให้\n');
      continue;
    }

    console.log(`   ▶ กำลังสร้าง ${step.index} ...${step.heavy ? ' (ใช้เวลาหลายนาที อย่าปิดหน้าต่างนี้)' : ''}`);
    const t0 = Date.now();
    await pool.request().batch(
      `CREATE NONCLUSTERED INDEX ${step.index} ON ${step.table} (${step.column})`
    );
    created++;
    console.log(`   ✓ สร้างเสร็จใน ${fmtSecs(Date.now() - t0)}`);

    const after = await timeProbe(pool, step.table, step.column);
    console.log(`   เวลาดึงข้อมูลวันเดียวหลังแก้: ${fmtSecs(after.ms)} (เดิม ${fmtSecs(before.ms)})\n`);
  }
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  await pool.close();
  process.exit(1);
}

await pool.close();

if (CHECK_ONLY) {
  console.log('เช็กอย่างเดียว ยังไม่ได้แก้อะไร — เอา --check ออกเพื่อสร้าง index จริง');
} else if (created) {
  console.log(`เสร็จแล้ว — สร้าง index ใหม่ ${created} ตัว ลองกด "ค้นหาข้อมูล" ที่หน้าแดชบอร์ดอีกครั้ง`);
} else {
  console.log('index ที่ต้องมีครบแล้ว — ถ้ายังช้าอยู่ ให้ดู docs/check-slow-sales.sql ต่อ');
}
if (skippedHeavy) {
  console.log('ยังเหลือ IX_Ctrans_PostTime (หน้ารายละเอียดรายการ) — รันซ้ำด้วย --ctrans ตอนปิดร้าน');
}
