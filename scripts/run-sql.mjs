#!/usr/bin/env node
/**
 * รันไฟล์ .sql ลง SQL Server ด้วย node — ใช้แทน sqlcmd บนเครื่องที่ไม่ได้ลง sqlcmd ไว้
 *
 *   node scripts/run-sql.mjs docs/schema-qcrd.sql
 *   node scripts/run-sql.mjs docs/schema-qcrd.sql --db=InventoryNarai
 *
 * ตั้งค่าเชื่อมต่อผ่าน env ชุดเดียวกับ migrate-qcrd.mjs (ดู scripts/qcrdDb.mjs)
 *
 * ตัดคำสั่งเป็นชุดตามบรรทัด GO เหมือนที่ sqlcmd ทำ (T-SQL หลายคำสั่ง เช่น CREATE DATABASE
 * กับ USE ต้องอยู่คนละชุด ส่งไปทีเดียวทั้งไฟล์จะ error)
 * ชุดแรกที่เป็น CREATE DATABASE/USE จะรันบนฐาน master ให้อัตโนมัติ
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { openPool, describeTarget, DEFAULT_DB } from './qcrdDb.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dbArg = args.find((a) => a.startsWith('--db='));
const DB_NAME = dbArg ? dbArg.slice(5) : DEFAULT_DB;

if (!file) {
  console.error('ใช้: node scripts/run-sql.mjs <ไฟล์.sql> [--db=InventoryNarai]');
  process.exit(1);
}

/** ตัดไฟล์เป็นชุดคำสั่งตามบรรทัดที่มีแค่ GO (ไม่สนใจ GO ที่อยู่กลางข้อความ) */
function splitBatches(sqlText) {
  return sqlText
    .split(/^\s*GO\s*;?\s*$/gim)
    .map((b) => b.trim())
    .filter(Boolean);
}

const text = readFileSync(file, 'utf8');
const batches = splitBatches(text);
console.log(`รัน ${file} → ${describeTarget(DB_NAME)} (${batches.length} ชุดคำสั่ง)`);

// CREATE DATABASE / USE ต้องรันจาก master — ถ้าฐานปลายทางยังไม่มี ต่อตรงเข้าไปเลยจะไม่ติด
const needsMaster = /CREATE\s+DATABASE|^\s*USE\s+/im.test(text);
let pool;
try {
  pool = await openPool(needsMaster ? 'master' : DB_NAME);
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}

let ok = 0;
try {
  for (const [i, batch] of batches.entries()) {
    try {
      const r = await pool.request().batch(batch);
      (r.recordsets || []).forEach((rs) => {
        if (rs?.length) console.log(`  ${JSON.stringify(rs.slice(0, 5))}`);
      });
      ok++;
    } catch (err) {
      console.error(`\n❌ ชุดที่ ${i + 1} ล้มเหลว: ${err.message}`);
      console.error(`   คำสั่ง: ${batch.slice(0, 200).replace(/\s+/g, ' ')}…`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await pool.close();
}
console.log(`\nสำเร็จ ${ok}/${batches.length} ชุดคำสั่ง`);
