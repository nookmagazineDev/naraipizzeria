// นำเข้าสูตรฝั่ง POS (แท็บ RcpDtls) เข้าฐาน InventoryNarai
//
//   node scripts/migrate-rcp.mjs Kios_Dtls.xlsx              นำเข้าจริง
//   node scripts/migrate-rcp.mjs Kios_Dtls.xlsx --dry-run    อ่าน+ตรวจอย่างเดียว ไม่แตะฐาน
//   node scripts/migrate-rcp.mjs Kios_Dtls.xlsx --tab RcpDtls
//   node scripts/migrate-rcp.mjs Kios_Dtls.xlsx --emit-sql out.sql   ปั้นเป็นไฟล์ .sql ไม่ต่อฐานเอง
//        (ไว้ใช้กับ sqlcmd -E เมื่อเข้า SQL ด้วยสิทธิ์ Windows ได้ แต่ไม่มีรหัส SQL login)
//
// รันจากเครื่องที่ต่อ SQL Server ได้ (ค่าเริ่มต้นคือเครื่องออฟฟิศ localhost\SQLEXPRESS)
// ต่อฐานด้วย scripts/qcrdDb.mjs ตัวเดียวกับ migrate-qcrd.mjs — env ชุดเดิม ไม่ต้องตั้งเพิ่ม
// ต้องรัน docs/schema-rcp.sql สร้างตารางก่อน (สคริปต์จะตรวจให้ ถ้ายังไม่มีจะบอกแล้วหยุด)
//
// วิธีทำงาน: ชีทเป็น "ต้นทาง" เสมอ ตัวนำเข้าจึงล้างของเดิมแล้วใส่ใหม่ทั้งชุดในทรานแซกชันเดียว
// (ไม่ใช่ MERGE ทีละแถว) เพราะไฟล์ที่ export มาคือภาพรวมทั้งหมด ถ้า MERGE อย่างเดียว
// สูตรที่ถูกลบออกจากชีทแล้วจะค้างอยู่ในฐานตลอดไป — ล้มกลางทางก็ rollback ของเดิมยังอยู่ครบ
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as XLSX from 'xlsx';
import { openPool, describeTarget, DEFAULT_DB } from './qcrdDb.mjs';
import { rcpNameKey, rcpNameKeyLoose, rcpItemKey } from '../lib/rcpMatch.js';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const optVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = flag('--dry-run');
const EMIT = optVal('--emit-sql', '');   // เขียนเป็นไฟล์ .sql แทนการต่อฐานเอง (ดูหมายเหตุตรงที่ใช้)
const TAB = optVal('--tab', 'RcpDtls');
const FILE = argv.find((a) => !a.startsWith('--') && /\.xlsx?$/i.test(a));

const die = (msg) => { console.error(`\n❌ ${msg}\n`); process.exit(1); };

if (!FILE) die('ต้องระบุไฟล์ .xlsx\n   ตัวอย่าง: node scripts/migrate-rcp.mjs Kios_Dtls.xlsx');
if (!fs.existsSync(FILE)) die(`ไม่พบไฟล์ ${path.resolve(FILE)}`);

const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
const int = (v) => { const n = parseInt(String(v).replace(/,/g, ''), 10); return Number.isFinite(n) ? n : null; };
const dec = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

// ── อ่านชีท ──────────────────────────────────────────────────────────────────
console.log(`\nอ่าน ${path.resolve(FILE)} แท็บ "${TAB}"`);
// build ESM ของ SheetJS 0.18 ไม่มี readFile (ผูก fs ไม่ได้) — อ่านเป็น buffer เองแทน
const wb = XLSX.read(fs.readFileSync(FILE), { type: 'buffer' });
if (!wb.SheetNames.includes(TAB)) {
  die(`ไม่มีแท็บ "${TAB}" ในไฟล์นี้ — แท็บที่มี: ${wb.SheetNames.join(', ')}`);
}
const rows = XLSX.utils.sheet_to_json(wb.Sheets[TAB], { header: 1, raw: false, defval: '' });

// หาแถวหัวตารางจากชื่อคอลัมน์ ไม่ hard-code เลขแถว เผื่อมีคนแทรกแถวข้างบนเพิ่ม
const headerAt = rows.findIndex((r) => r.some((c) => /^\s*Rts\s*Id\s*$/i.test(s(c))));
if (headerAt < 0) die(`หาแถวหัวตารางไม่เจอ (มองหาคอลัมน์ชื่อ "Rts Id" ในแท็บ ${TAB})`);
const header = rows[headerAt].map(s);
const colOf = (re, dflt) => { const i = header.findIndex((h) => re.test(h)); return i >= 0 ? i : dflt; };
const C = {
  salesItemId: colOf(/^Lnk\s*Salesitmid$/i, 0),
  rtsId: colOf(/^Rts\s*Id$/i, 1),
  name: colOf(/^Name$/i, 2),
  seq: colOf(/^Rts\s*Seq$/i, 3),
  itemCode: colOf(/^Itm\s*Code$/i, 4),
  itemName: colOf(/^Itm\s*Name$/i, 5),
  netQty: colOf(/^Rts\s*Netqty$/i, 6),
  rcpQty: colOf(/^Rcp\s*Qty$/i, 7),
  portion: colOf(/^Itm\s*Rcpportion$/i, 8),
};
console.log(`  หัวตารางอยู่แถวที่ ${headerAt + 1} · คอลัมน์ที่ใช้:`,
  Object.entries(C).map(([k, v]) => `${k}=${String.fromCharCode(65 + v)}`).join(' '));

const recipes = new Map();   // rts_id -> หัวสูตร
const lines = [];
let skipped = 0, nameConflict = 0;

for (const r of rows.slice(headerAt + 1)) {
  const rtsId = int(r[C.rtsId]);
  const name = s(r[C.name]);
  if (rtsId === null || !name) { skipped++; continue; }

  const prev = recipes.get(rtsId);
  if (!prev) {
    recipes.set(rtsId, {
      rtsId, name,
      nameKey: rcpNameKey(name),
      nameLoose: rcpNameKeyLoose(name),
      salesItemId: int(r[C.salesItemId]),
      lineCount: 0,
    });
  } else {
    if (prev.name !== name) nameConflict++;
    // Lnk Salesitmid ใส่ไว้เฉพาะแถวแรกของสูตรในชีท — เก็บค่าแรกที่เจอ
    if (prev.salesItemId === null) prev.salesItemId = int(r[C.salesItemId]);
  }

  const rec = recipes.get(rtsId);
  rec.lineCount++;
  const itemCode = s(r[C.itemCode]);
  lines.push({
    rtsId,
    lineNo: rec.lineCount,          // ลำดับตามชีท — กัน (rts_id, seq) ที่ซ้ำกันทับกันเอง
    seq: int(r[C.seq]),
    itemCode: itemCode || null,
    itemKey: itemCode ? rcpItemKey(itemCode) : null,
    itemName: s(r[C.itemName]) || null,
    netQty: dec(r[C.netQty]),
    rcpQty: dec(r[C.rcpQty]),
    portion: dec(r[C.portion]),
  });
}

const dupKeys = (() => {
  const c = new Map();
  for (const r of recipes.values()) c.set(r.nameKey, (c.get(r.nameKey) || 0) + 1);
  return [...c.values()].filter((n) => n > 1).length;
})();

console.log(`\nอ่านได้`);
console.log(`  สูตร            ${recipes.size.toLocaleString()}`);
console.log(`  บรรทัดวัตถุดิบ    ${lines.length.toLocaleString()}`);
console.log(`  บรรทัดที่ไม่มีรหัสวัตถุดิบ ${lines.filter((l) => !l.itemCode).length.toLocaleString()} (เก็บไว้ตามชีท)`);
console.log(`  ข้ามแถวที่ไม่มี Rts Id/ชื่อ ${skipped.toLocaleString()}`);
if (nameConflict) console.log(`  ⚠ Rts Id ที่มีชื่อไม่ตรงกันในสูตรเดียว ${nameConflict} แถว (ใช้ชื่อแรกที่เจอ)`);
if (dupKeys) console.log(`  ⚠ ชื่อ (หลัง normalize) ที่ซ้ำกันข้ามสูตร ${dupKeys} ชื่อ — หน้าเว็บจะเลือกสูตรที่มีบรรทัดมากที่สุด`);

if (!recipes.size) die('ไม่มีข้อมูลให้นำเข้า');

if (DRY) {
  console.log('\n--dry-run: ไม่ได้แตะฐานข้อมูล\n');
  console.log('ตัวอย่าง 3 สูตรแรก');
  for (const rec of [...recipes.values()].slice(0, 3)) {
    console.log(`  [${rec.rtsId}] ${rec.name}  (${rec.lineCount} บรรทัด)`);
    console.log(`        name_key = ${rec.nameKey}`);
    for (const l of lines.filter((l) => l.rtsId === rec.rtsId).slice(0, 3)) {
      console.log(`        #${l.lineNo} seq=${l.seq} ${l.itemCode} ${l.itemName} qty=${l.netQty}`);
    }
  }
  console.log('');
  process.exit(0);
}

// ── เขียนเป็นไฟล์ .sql (ไม่ต้องมี user/รหัสของ SQL) ──────────────────────────
//
// มีไว้สำหรับเครื่องที่ล็อกอิน Windows เข้า SQL Server ได้อยู่แล้ว แต่ไม่มีใครจำรหัส
// SQL login ได้ — driver ที่ node ใช้ (tedious) ต่อแบบ Windows Authentication ไม่ได้
// แต่ sqlcmd -E ต่อได้ จึงให้ node ปั้นคำสั่งออกมาเป็นไฟล์แล้วให้ sqlcmd เอาไปรันแทน
//   node scripts/migrate-rcp.mjs <ไฟล์.xlsx> --emit-sql rcp-import.sql
//   sqlcmd -S "localhost\SQLEXPRESS" -E -d InventoryNarai -i rcp-import.sql
const qStr = (v) => (v === null || v === undefined || v === ''
  ? 'NULL'
  // ' ต้องกลายเป็น '' และตัดอักขระควบคุมที่ทำให้ sqlcmd อ่านไฟล์เพี้ยน
  : `N'${String(v).replace(/'/g, "''").replace(/[\u0000-\u001f]/g, ' ')}'`);
const qNum = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 'NULL' : String(Number(v)));

if (EMIT) {
  const out = [];
  out.push('SET NOCOUNT ON;');
  out.push('SET XACT_ABORT ON;   -- แถวไหนพังให้ยกเลิกทั้งก้อน ไม่ปล่อยให้ค้างครึ่ง ๆ กลาง ๆ');
  out.push('BEGIN TRANSACTION;');
  out.push('DELETE FROM dbo.rcp_line;');
  out.push('DELETE FROM dbo.rcp_recipe;');

  // SQL Server รับได้สูงสุด 1000 แถวต่อคำสั่ง INSERT ... VALUES — กันไว้ที่ 500
  const CHUNK = 500;
  const recArr = [...recipes.values()];
  for (let i = 0; i < recArr.length; i += CHUNK) {
    const vals = recArr.slice(i, i + CHUNK).map((r) =>
      `(${qNum(r.rtsId)},${qStr(r.name.slice(0, 200))},${qStr(r.nameKey.slice(0, 200))},` +
      `${qStr(r.nameLoose.slice(0, 200))},${qNum(r.salesItemId)},${qNum(r.lineCount)},SYSDATETIME())`);
    out.push('INSERT INTO dbo.rcp_recipe (rts_id,name,name_key,name_loose,sales_item_id,line_count,updated_at) VALUES');
    out.push(`${vals.join(',\n')};`);
  }
  for (let i = 0; i < lines.length; i += CHUNK) {
    const vals = lines.slice(i, i + CHUNK).map((l) =>
      `(${qNum(l.rtsId)},${qNum(l.lineNo)},${qNum(l.seq)},${qStr(l.itemCode && l.itemCode.slice(0, 32))},` +
      `${qStr(l.itemKey && l.itemKey.slice(0, 32))},${qStr(l.itemName && l.itemName.slice(0, 200))},` +
      `${qNum(l.netQty)},${qNum(l.rcpQty)},${qNum(l.portion)})`);
    out.push('INSERT INTO dbo.rcp_line (rts_id,line_no,seq,item_code,item_key,item_name,net_qty,rcp_qty,portion) VALUES');
    out.push(`${vals.join(',\n')};`);
  }

  out.push('COMMIT TRANSACTION;');
  out.push("PRINT N'นำเข้าเรียบร้อย';");
  out.push('SELECT (SELECT COUNT(*) FROM dbo.rcp_recipe) AS recipes, (SELECT COUNT(*) FROM dbo.rcp_line) AS lines_;');
  out.push('GO');

  fs.writeFileSync(EMIT, `\uFEFF${out.join('\n')}`, 'utf8');   // BOM ให้ sqlcmd รู้ว่าเป็น UTF-8
  const mb = (fs.statSync(EMIT).size / 1048576).toFixed(1);
  console.log(`\n✅ เขียนไฟล์คำสั่งแล้ว: ${path.resolve(EMIT)}  (${mb} MB)`);
  console.log('\nเอาไปรันด้วย sqlcmd โดยไม่ต้องใช้รหัส SQL:');
  console.log(`   sqlcmd -S "localhost\\SQLEXPRESS" -E -d InventoryNarai -i ${EMIT}\n`);
  process.exit(0);
}

// ── เขียนลงฐาน ───────────────────────────────────────────────────────────────
console.log(`\nต่อฐาน ${describeTarget()}`);
const mssql = (await import('mssql')).default;
const pool = await openPool(DEFAULT_DB);

const exists = await pool.request().query(
  "SELECT CASE WHEN OBJECT_ID('dbo.rcp_recipe','U') IS NULL THEN 0 ELSE 1 END AS a," +
  "       CASE WHEN OBJECT_ID('dbo.rcp_line','U')   IS NULL THEN 0 ELSE 1 END AS b"
);
if (!exists.recordset[0].a || !exists.recordset[0].b) {
  await pool.close();
  die('ยังไม่มีตาราง rcp_recipe / rcp_line — รัน docs/schema-rcp.sql ก่อน\n' +
      `   sqlcmd -S ${describeTarget().split('/')[0]} -d ${DEFAULT_DB} -i docs\\schema-rcp.sql`);
}

const tx = new mssql.Transaction(pool);
await tx.begin();
try {
  // ล้างของเดิมทั้งชุด (ชีทเป็นต้นทาง) — ลบ line ก่อนแม้จะมี ON DELETE CASCADE
  // เพื่อให้จำนวนแถวที่ลบออกมาแสดงได้ และไม่ต้องพึ่งพฤติกรรม cascade
  const delL = await new mssql.Request(tx).query('DELETE FROM dbo.rcp_line');
  const delR = await new mssql.Request(tx).query('DELETE FROM dbo.rcp_recipe');
  console.log(`  ล้างของเดิม: สูตร ${delR.rowsAffected[0]} · บรรทัด ${delL.rowsAffected[0]}`);

  const tRec = new mssql.Table('dbo.rcp_recipe');
  tRec.columns.add('rts_id', mssql.Int, { nullable: false });
  tRec.columns.add('name', mssql.NVarChar(200), { nullable: false });
  tRec.columns.add('name_key', mssql.NVarChar(200), { nullable: false });
  tRec.columns.add('name_loose', mssql.NVarChar(200), { nullable: false });
  tRec.columns.add('sales_item_id', mssql.Int, { nullable: true });
  tRec.columns.add('line_count', mssql.Int, { nullable: false });
  tRec.columns.add('updated_at', mssql.DateTime2(0), { nullable: false });
  const now = new Date();
  for (const r of recipes.values()) {
    tRec.rows.add(r.rtsId, r.name.slice(0, 200), r.nameKey.slice(0, 200),
      r.nameLoose.slice(0, 200), r.salesItemId, r.lineCount, now);
  }

  const tLine = new mssql.Table('dbo.rcp_line');
  tLine.columns.add('rts_id', mssql.Int, { nullable: false });
  tLine.columns.add('line_no', mssql.Int, { nullable: false });
  tLine.columns.add('seq', mssql.Int, { nullable: true });
  tLine.columns.add('item_code', mssql.NVarChar(32), { nullable: true });
  tLine.columns.add('item_key', mssql.NVarChar(32), { nullable: true });
  tLine.columns.add('item_name', mssql.NVarChar(200), { nullable: true });
  tLine.columns.add('net_qty', mssql.Decimal(18, 4), { nullable: true });
  tLine.columns.add('rcp_qty', mssql.Decimal(18, 4), { nullable: true });
  tLine.columns.add('portion', mssql.Decimal(18, 4), { nullable: true });
  for (const l of lines) {
    tLine.rows.add(l.rtsId, l.lineNo, l.seq,
      l.itemCode && l.itemCode.slice(0, 32), l.itemKey && l.itemKey.slice(0, 32),
      l.itemName && l.itemName.slice(0, 200), l.netQty, l.rcpQty, l.portion);
  }

  await new mssql.Request(tx).bulk(tRec);
  console.log(`  ใส่หัวสูตร   ${recipes.size.toLocaleString()}`);
  await new mssql.Request(tx).bulk(tLine);
  console.log(`  ใส่บรรทัด    ${lines.length.toLocaleString()}`);

  await tx.commit();
} catch (err) {
  await tx.rollback().catch(() => {});
  await pool.close().catch(() => {});
  die(`นำเข้าไม่สำเร็จ ของเดิมในฐานยังอยู่ครบ (rollback แล้ว)\n   ${err.message}`);
}

const chk = await pool.request().query(
  'SELECT (SELECT COUNT(*) FROM dbo.rcp_recipe) AS r, (SELECT COUNT(*) FROM dbo.rcp_line) AS l'
);
console.log(`\n✅ เสร็จแล้ว — ในฐานตอนนี้: สูตร ${chk.recordset[0].r.toLocaleString()} · บรรทัด ${chk.recordset[0].l.toLocaleString()}\n`);
await pool.close();
