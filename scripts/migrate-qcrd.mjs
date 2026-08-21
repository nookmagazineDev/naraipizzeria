#!/usr/bin/env node
/**
 * ย้ายข้อมูล QC/RD จาก Google Sheets (ชีทต้นทุนเมนู 1v8WRT…) เข้า MS SQL Server
 * ปลายทาง: ฐานข้อมูล InventoryNarai — ตัวเดียวกับที่หน้านับสต๊อกใช้ (dbo.stock_*)
 *
 * ย้าย 4 ชุด — โครงตารางและที่มาของแต่ละคอลัมน์อยู่ใน docs/schema-qcrd.sql
 *   group  ชีท 'menucodegroup' -> dbo.qcrd_menu_group
 *   menu   ชีท 'menu'          -> dbo.qcrd_menu
 *   bom    ชีท 'BOM'           -> dbo.qcrd_bom
 *   item   ชีท 'item'          -> dbo.stock_item (+ stock_item_branch) ในคอลัมน์ฝั่ง QC/RD
 *
 * วิธีใช้ (รันบนเครื่องที่ต่อ SQL Server ได้ — เครื่องเดียวกับที่รัน host-server)
 *   1) สร้างตารางก่อน:  sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัส>' -i docs\schema-qcrd.sql
 *   2) ตั้ง env การเชื่อมต่อ (ดูหัวข้อด้านล่าง)
 *   3) ดูก่อนว่าคอลัมน์ตรงกับที่โค้ดคาดไว้ไหม (ไม่แตะฐานข้อมูล):
 *        node scripts/migrate-qcrd.mjs --inspect
 *   4) ลองแบบไม่เขียนจริง:  node scripts/migrate-qcrd.mjs --dry-run
 *   5) ย้ายจริง:            node scripts/migrate-qcrd.mjs
 *   6) ตรวจว่าครบ:         node scripts/migrate-qcrd.mjs --verify
 *
 * env ที่ใช้ (ถ้าไม่ตั้ง จะไล่ใช้ค่าของ host-server ที่ตั้งไว้อยู่แล้ว)
 *   QCRD_DB_SERVER   (หรือ DB_SERVER)    ค่าเริ่มต้น 'localhost\SQLEXPRESS'
 *   QCRD_DB_NAME     (หรือ STOCK_DB_NAME) ค่าเริ่มต้น 'InventoryNarai'
 *   QCRD_DB_USER     (หรือ DB_USER)
 *   QCRD_DB_PASSWORD (หรือ DB_PASSWORD)
 *
 * ตัวเลือก
 *   --dry-run          อ่านชีทและสรุปผลอย่างเดียว ไม่เขียนลงฐานข้อมูล
 *   --inspect          พิมพ์แถวแรก ๆ ของทุกชีทออกมาดิบ ๆ + รายงานรหัสวัตถุดิบซ้ำ
 *   --verify           เทียบจำนวนแถวในชีทกับที่อยู่ใน SQL แล้วบอกว่าตรงไหมทีละชุด
 *   --only=menu,bom    ย้ายเฉพาะบางชุด (group,menu,bom,item)
 *   --db=InventoryNarai ฐานข้อมูลปลายทาง
 *   --gid-menu=0       ระบุ gid ของแท็บเอง (มีครบ: --gid-menu --gid-bom --gid-item --gid-group)
 *
 * ข้อควรรู้
 * - อ่านชีทผ่าน export?format=csv เหมือน lib/qcrdSheet.js (ไม่ใช้ gviz เพราะ gviz เดาชนิดคอลัมน์
 *   แล้วทิ้งค่าที่ไม่ตรงชนิด เช่น รหัสเมนูที่เป็นข้อความในคอลัมน์ที่ส่วนใหญ่เป็นตัวเลข)
 * - รันซ้ำได้ ไม่เกิดข้อมูลซ้ำ: ทุกชุดเป็นทะเบียน ใช้ MERGE ทับของเดิม
 *   ส่วน qcrd_bom ลบสูตรเดิมของเมนูนั้นทั้งชุดก่อนใส่ใหม่ (เหมือน replaceMenuBomRows_)
 * - รหัสวัตถุดิบ/รหัสเมนูเทียบกันด้วยค่าที่ normalize แล้ว (ตัด 0 นำหน้า + ตัวพิมพ์เล็ก)
 *   เหมือน Apps Script ไม่งั้น '00123' กับ '123' จะกลายเป็นคนละตัว
 * - ชีท item มีรหัสซ้ำได้ (หน้า QC/RD ขึ้นเตือน "รหัสซ้ำ") แต่ SQL คีย์ด้วย item_key
 *   รหัสที่ซ้ำกันจะยุบเหลือแถวเดียว (แถวท้ายสุดของชีทชนะ) — --inspect บอกจำนวนให้ก่อนย้าย
 */

import process from 'node:process';
import { openPool, describeTarget } from './qcrdDb.mjs';
import {
  mapGroups, mapMenus, mapBomByMenu, mapItems,
  groupStmt, menuStmt, bomStmt, itemStmt, itemBranchStmt,
  str, normCode,
} from '../lib/qcrdMigrate.mjs';

/* ---- ต้นทาง: ชีทต้นทุนเมนู (ค่าตรงกับ lib/qcrdSheet.js) ---- */
const QCRD_SS = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const INSPECT = args.includes('--inspect');
const VERIFY = args.includes('--verify');
const DB_NAME = argVal('db', process.env.QCRD_DB_NAME || process.env.STOCK_DB_NAME || 'InventoryNarai');
const ONLY = String(argVal('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const wants = (part) => ONLY.length === 0 || ONLY.includes(part);

const SOURCES = {
  group: { sheet: 'menucodegroup', gid: argVal('gid-group', '1491689317') },
  menu: { sheet: 'menu', gid: argVal('gid-menu', '0') },
  bom: { sheet: 'BOM', gid: argVal('gid-bom', '419926693') },
  item: { sheet: 'item', gid: argVal('gid-item', '302875824') },
};

/* การจับคอลัมน์ชีท -> เรคคอร์ด -> คำสั่ง SQL อยู่ใน lib/qcrdMigrate.mjs
   ใช้ร่วมกับ /api/qcrd-migrate (ตัวย้ายข้อมูลฝั่ง Vercel) จะได้ไม่มีสองสำเนาให้แก้ตามกัน */

/* --------------------------- อ่านชีทผ่าน export CSV --------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadSheet(part) {
  const src = SOURCES[part];
  const url = `https://docs.google.com/spreadsheets/d/${QCRD_SS}/export?format=csv&gid=${encodeURIComponent(src.gid)}`;
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  const text = await res.text();
  if (!res.ok || /^\s*</.test(text)) {
    throw new Error(
      `อ่านชีท ${src.sheet} ไม่ได้ (HTTP ${res.status}) — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`
    );
  }
  const rows = parseCsv(text);
  return rows.slice(1);   // ทุกแท็บมีหัวตารางแถวเดียว (ฝั่งอ่านของเว็บก็ตัดแถวแรกเหมือนกัน)
}

/* ------------------------------ ต่อฐานข้อมูล ------------------------------ */

let pool = null;
async function getPool() {
  if (!pool) pool = await openPool(DB_NAME);
  return pool;
}

/** ยิงคำสั่งเดียวพร้อมพารามิเตอร์ — ปล่อยให้ driver เดาชนิดจากค่า (เหมือน request().input(k, v)) */
async function run(text, params = {}) {
  const p = await getPool();
  const req = p.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
  return req.query(text);
}

async function runBatch(label, rows, buildStatement) {
  if (rows.length === 0) { console.log(`  ${label}: ไม่มีข้อมูล`); return; }
  if (DRY_RUN) {
    console.log(`  ${label}: ${rows.length} แถว (dry-run ไม่ได้เขียนลงฐานข้อมูล)`);
    console.log(`    ตัวอย่าง: ${JSON.stringify(rows[0])}`);
    return;
  }
  let done = 0;
  for (const row of rows) {
    const { text, params } = buildStatement(row);
    await run(text, params);
    done++;
    if (done % 50 === 0 || done === rows.length) process.stdout.write(`\r  ${label}: ${done}/${rows.length} แถว`);
  }
  console.log('');
}

/* --------------------------- ส่วนที่ย้ายแต่ละชุด --------------------------- */

async function migrateGroups() {
  const { rows } = mapGroups(await loadSheet('group'));
  await runBatch('qcrd_menu_group', rows, (g) => groupStmt(g));
}

async function migrateMenus() {
  const { rows, stats } = mapMenus(await loadSheet('menu'));
  if (stats.duplicateCodes) {
    console.log(`  ⚠️ รหัสเมนูซ้ำในชีท ${stats.duplicateCodes} แถว — แถวท้ายสุดจะทับแถวก่อนหน้า`);
  }
  await runBatch('qcrd_menu', rows, (m) => menuStmt(m));
}

async function migrateBom() {
  const { rows, stats } = mapBomByMenu(await loadSheet('bom'));
  if (stats.skipped) console.log(`  ข้ามแถว BOM ที่ไม่มีรหัสเมนูหรือรหัสวัตถุดิบ ${stats.skipped} แถว`);
  console.log(`  qcrd_bom: ${rows.length} เมนู / ${stats.bomRows} แถว`);
  await runBatch('qcrd_bom', rows, (m) => bomStmt(m));
}

async function migrateItems() {
  const { rows, stats } = mapItems(await loadSheet('item'));
  if (stats.skipped) console.log(`  ข้ามแถวที่ไม่มีรหัสวัตถุดิบ ${stats.skipped} แถว`);
  if (stats.duplicateCodes) {
    console.log(`  ⚠️ รหัสวัตถุดิบซ้ำ (หลัง normalize) ${stats.duplicateCodes} แถว — ยุบเหลือแถวท้ายสุดของแต่ละรหัส`);
  }
  await runBatch('stock_item (คอลัมน์ฝั่ง QC/RD)', rows, (it) => itemStmt(it));
  // สาขาที่ใช้วัตถุดิบ — เขียนใหม่ทั้งชุดต่อรหัส
  await runBatch('stock_item_branch', rows.filter((it) => it.branches.length > 0), (it) => itemBranchStmt(it));
}

/* ------------------------------- โหมดตรวจ ------------------------------- */

async function inspectSheets() {
  for (const part of Object.keys(SOURCES)) {
    if (!wants(part)) continue;
    const rows = await loadSheet(part);
    console.log(`\n=== ${part} (${SOURCES[part].sheet}) — ${rows.length} แถว ===`);
    rows.slice(0, 3).forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r.slice(0, 20))}`));
  }

  // รหัสซ้ำเป็นเรื่องที่ต้องรู้ก่อนย้าย เพราะ SQL คีย์ด้วย item_key จะยุบให้เหลือแถวเดียว
  if (wants('item')) {
    const rows = await loadSheet('item');
    const count = new Map();
    rows.forEach((r) => {
      const k = normCode(r[0]);
      if (k) count.set(k, (count.get(k) || 0) + 1);
    });
    const dups = [...count.entries()].filter(([, n]) => n > 1);
    console.log(`\n=== รหัสวัตถุดิบซ้ำ (หลัง normalize) ${dups.length} รหัส ===`);
    dups.slice(0, 20).forEach(([k, n]) => console.log(`  ${k} × ${n}`));
    if (dups.length > 20) console.log(`  … อีก ${dups.length - 20} รหัส`);
  }

  // สูตรที่อ้างวัตถุดิบซึ่งไม่มีในชีท item — ย้ายไปแล้วจะกลายเป็นแถวที่ join ไม่เจอ
  if (wants('bom') && wants('item')) {
    const [bomRows, itemRows] = await Promise.all([loadSheet('bom'), loadSheet('item')]);
    const known = new Set(itemRows.map((r) => normCode(r[0])).filter(Boolean));
    const missing = new Set();
    bomRows.forEach((r) => {
      const k = normCode(r[3]);
      if (k && !known.has(k)) missing.add(k);
    });
    console.log(`\n=== วัตถุดิบในสูตรที่ไม่มีในชีท item: ${missing.size} รหัส ===`);
    [...missing].slice(0, 20).forEach((k) => console.log(`  ${k}`));
  }
}

/* ------------------------------- โหมดตรวจครบ ------------------------------- */

/**
 * เทียบ "จำนวนของจริงในชีท" กับ "จำนวนที่อยู่ใน SQL" ทีละชุด
 * ใช้หลังย้ายเสร็จ เพื่อยืนยันว่าไม่มีอะไรตกหล่นก่อนไปเปิด QCRD_SOURCE=sql
 */
async function verify() {
  console.log(`เทียบชีทกับ ${describeTarget(DB_NAME)}\n`);
  const one = async (label, sheetCount, sqlText) => {
    const rows = await run(sqlText);
    const n = Number(rows.recordset?.[0]?.n) || 0;
    const same = n === sheetCount;
    console.log(`  ${same ? '✔' : '⚠️'} ${label}: ชีท ${sheetCount} · SQL ${n}${same ? '' : `  (ต่างกัน ${n - sheetCount})`}`);
    return same;
  };

  let allOk = true;
  if (wants('group')) {
    const rows = await loadSheet('group');
    const n = rows.filter((r) => str(r[0]) && str(r[1])).length;
    if (!await one('หมวดหมู่เมนู', n, 'SELECT COUNT(*) AS n FROM dbo.qcrd_menu_group')) allOk = false;
  }
  if (wants('menu')) {
    const rows = await loadSheet('menu');
    const codes = new Set(rows.map((r) => str(r[0])).filter(Boolean));
    if (!await one('เมนู', codes.size, 'SELECT COUNT(*) AS n FROM dbo.qcrd_menu')) allOk = false;
  }
  if (wants('bom')) {
    const rows = await loadSheet('bom');
    const n = rows.filter((r) => str(r[0]) && str(r[3])).length;
    if (!await one('แถวสูตร BOM', n, 'SELECT COUNT(*) AS n FROM dbo.qcrd_bom')) allOk = false;
  }
  if (wants('item')) {
    const rows = await loadSheet('item');
    const keys = new Set(rows.map((r) => normCode(r[0])).filter(Boolean));
    // ตารางนี้ฝั่งสต๊อกก็เขียนด้วย SQL จึงอาจมีมากกว่าชีทได้ (ไม่ใช่ความผิดพลาด)
    const rowsSql = await run('SELECT COUNT(*) AS n FROM dbo.stock_item');
    const inSql = Number(rowsSql.recordset?.[0]?.n) || 0;
    console.log(`  ${inSql >= keys.size ? '✔' : '⚠️'} วัตถุดิบ: ชีท ${keys.size} รหัส (ไม่ซ้ำ) · SQL ${inSql} แถว` +
      (inSql > keys.size ? '  — SQL มากกว่าได้ ถ้าฝั่งสต๊อกเพิ่มไว้' : ''));
    if (inSql < keys.size) allOk = false;

    // ช่องที่เพิ่งเพิ่มเข้ามา ถ้าว่างทั้งตารางแปลว่ายังไม่ได้ย้ายชุด item
    const filled = await run(`
      SELECT SUM(CASE WHEN converter IS NOT NULL THEN 1 ELSE 0 END) AS conv,
             SUM(CASE WHEN item_type IS NOT NULL THEN 1 ELSE 0 END) AS itype,
             SUM(CASE WHEN sub_item1 IS NOT NULL THEN 1 ELSE 0 END) AS sub1
      FROM dbo.stock_item`);
    const f = filled.recordset?.[0] || {};
    console.log(`     คอลัมน์ที่เพิ่มใหม่ที่มีค่าแล้ว: ตัวแปลงหน่วย ${f.conv || 0} · ประเภท ${f.itype || 0} · ไอเทมทดแทน ${f.sub1 || 0}`);
  }

  // สูตรที่อ้างวัตถุดิบซึ่งไม่มีในทะเบียน — ต้นทุนของแถวพวกนี้จะเป็น 0 เวลาบันทึกใหม่
  if (wants('bom')) {
    const orphan = await run(`
      SELECT COUNT(DISTINCT b.item_key) AS n
      FROM dbo.qcrd_bom b LEFT JOIN dbo.stock_item i ON i.item_key = b.item_key
      WHERE i.item_key IS NULL`);
    const n = Number(orphan.recordset?.[0]?.n) || 0;
    console.log(`  ${n ? '⚠️' : '✔'} วัตถุดิบในสูตรที่ไม่มีในทะเบียน: ${n} รหัส`);
  }

  console.log(allOk ? '\n✅ ครบ — เปิด QCRD_SOURCE=sql ได้' : '\n⚠️ มีชุดที่จำนวนไม่ตรง ดูรายละเอียดข้างบนก่อนเปิดใช้');
}

/* --------------------------------- main --------------------------------- */

async function main() {
  console.log(`ต้นทาง: ชีท ${QCRD_SS}`);
  if (INSPECT) { await inspectSheets(); return; }
  if (VERIFY) { await verify(); return; }
  console.log(`ปลายทาง: ${DB_NAME}${DRY_RUN ? ' (dry-run)' : ''}`);

  if (wants('group')) { console.log('\n[หมวดหมู่เมนู]'); await migrateGroups(); }
  if (wants('menu')) { console.log('\n[เมนู]'); await migrateMenus(); }
  if (wants('bom')) { console.log('\n[สูตร BOM]'); await migrateBom(); }
  if (wants('item')) { console.log('\n[วัตถุดิบ]'); await migrateItems(); }

  console.log('\nเสร็จแล้ว');
}

main()
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(async () => { if (pool) await pool.close(); });
