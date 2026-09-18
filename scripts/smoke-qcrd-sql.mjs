// ยิงเข้าฐานจริง แล้วอ่านกลับมาดูว่าเข้าจริงไหม — เพิ่ม/แก้ไข/ปิดใช้งาน ทั้งเมนูและวัตถุดิบ
//
// ใช้ตรรกะชุดเดียวกับที่หน้าเว็บใช้ (lib/qcrdSql.mjs) ผ่านตัวต่อฐานเดียวกับสคริปต์ย้ายข้อมูล
// จึงเป็นการทดสอบ "ทางเดินจริง" ไม่ใช่การ INSERT ดิบ ๆ ที่ผ่านแล้วไม่ได้แปลว่าหน้าเว็บจะผ่าน
//
// ของทดสอบทุกชิ้นใช้รหัสขึ้นต้น ZZTEST- (เมนู) และ 999900x (วัตถุดิบ) แล้วลบทิ้งให้ตอนจบ
// ยกเลิกการลบด้วย --keep ถ้าอยากเปิดหน้าเว็บดูด้วยตา
//
//   npm install                        (ครั้งเดียว — ต้องมี package mssql)
//   node scripts/smoke-qcrd-sql.mjs
//   node scripts/smoke-qcrd-sql.mjs --keep
//
// รันจากเครื่องอื่นที่ไม่ใช่เครื่องออฟฟิศ ให้ตั้ง env ก่อน (ดู scripts/qcrdDb.mjs):
//   QCRD_DB_HOST=inventory.dyndns.tv  QCRD_DB_USER=...  QCRD_DB_PASSWORD=...
import process from 'node:process';
import { openPool, loadMssql, describeTarget } from './qcrdDb.mjs';
import { createQcrd } from '../lib/qcrdSql.mjs';

const KEEP = process.argv.includes('--keep');
const MENU = 'ZZTEST-QCRD';
const ITEM = '9999001';

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const r2 = (n) => Math.round(Number(n) * 100) / 100;

const pool = await openPool();
const mssql = await loadMssql();
console.log(`ต่อฐาน ${describeTarget()} ได้แล้ว${KEEP ? ' · โหมด --keep (ไม่ลบของทดสอบ)' : ''}\n`);

/** ตัวยิงคำสั่ง — รูปแบบเดียวกับ host-server/qcrd-db.js เป๊ะ */
const q = async (text, params = {}, tx = null) => {
  const req = tx ? new mssql.Request(tx) : pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
  return (await req.query(text)).recordset || [];
};
const withTx = async (fn) => {
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try { const out = await fn(tx); await tx.commit(); return out; }
  catch (err) { try { await tx.rollback(); } catch { /* ไม่มีอะไรให้ทำต่อ */ } throw err; }
};

const { readMenus, readBom, readItems, actions } = createQcrd({ q, withTx });

/** ล้างของทดสอบที่อาจค้างจากรอบก่อน — ไม่งั้น addItem จะฟ้องรหัสซ้ำแล้วจบตั้งแต่ข้อแรก */
async function cleanup(quiet = false) {
  await q('DELETE FROM dbo.qcrd_bom WHERE menu_code = @c', { c: MENU });
  await q('DELETE FROM dbo.qcrd_menu WHERE menu_code = @c', { c: MENU });
  await q('DELETE FROM dbo.stock_item_branch WHERE item_key = @k', { k: ITEM });
  await q('DELETE FROM dbo.stock_item WHERE item_key = @k', { k: ITEM });
  if (!quiet) console.log('\nลบของทดสอบออกจากฐานแล้ว');
}

try {
  await cleanup(true);

  const before = {
    menus: Number((await q('SELECT COUNT(*) AS n FROM dbo.qcrd_menu'))[0].n),
    items: Number((await q('SELECT COUNT(*) AS n FROM dbo.stock_item'))[0].n),
  };
  console.log(`ก่อนทดสอบ: เมนู ${before.menus.toLocaleString()} · วัตถุดิบ ${before.items.toLocaleString()}\n`);

  /* ───────────────── วัตถุดิบ ───────────────── */
  console.log('วัตถุดิบ');
  await actions.addItem({
    code: ITEM, name: 'ZZ ทดสอบระบบ (ลบได้)', price: 120, unit: 'กก.',
    converter: 1000, storeCategory: 'ของแห้ง', branches: ['narai'],
  });
  let item = (await readItems()).find(i => i.key === ITEM);
  check('เพิ่มวัตถุดิบแล้วอ่านกลับมาเจอ', Boolean(item));
  check('ราคาที่อ่านกลับมาตรงกับที่ส่งไป (120)', item?.price === 120, `ได้ ${item?.price}`);
  check('สาขาที่ใช้ถูกบันทึก', (item?.usedBranches || []).includes('NARAI'), (item?.usedBranches || []).join(','));

  await actions.saveItem({ code: ITEM, price: 150, unit: 'กก.' });
  item = (await readItems()).find(i => i.key === ITEM);
  check('แก้ราคาวัตถุดิบแล้วค่าเปลี่ยนจริง (150)', item?.price === 150, `ได้ ${item?.price}`);

  /* ───────────────── เมนู + สูตร ───────────────── */
  console.log('\nเมนูและสูตร');
  // 150 ÷ 1000 = 0.15 ต่อกรัม × 40 กรัม = 6.00
  const saved = await actions.saveMenu({
    code: MENU, name: 'ZZ เมนูทดสอบ (ลบได้)', price: 99,
    items: [{ itemCode: ITEM, itemName: 'ZZ ทดสอบระบบ (ลบได้)', qty: 40, converter: 1000 }],
  });
  let menu = (await readMenus()).find(m => m.code === MENU);
  check('เพิ่มเมนูแล้วอ่านกลับมาเจอ', Boolean(menu));
  check('ราคาขายที่อ่านกลับมาตรงกับที่ส่งไป (99)', menu?.price === 99, `ได้ ${menu?.price}`);
  check('ต้นทุนถูกคิดและบันทึกไว้ (0.15 × 40 = 6)', r2(menu?.cost) === 6, `ได้ ${menu?.cost}`);
  check('ต้นทุนที่คืนตอนบันทึกตรงกับที่อยู่ในฐาน', r2(saved.totalCost) === r2(menu?.cost));

  let bom = (await readBom())[MENU];
  check('สูตรถูกบันทึกลง qcrd_bom', (bom?.items || []).length === 1, `ได้ ${(bom?.items || []).length} แถว`);
  check('ยอดใช้ต่อจานตรง (40)', bom?.items?.[0]?.qty === 40, `ได้ ${bom?.items?.[0]?.qty}`);

  await actions.saveMenu({
    code: MENU, name: 'ZZ เมนูทดสอบ แก้ไขแล้ว', price: 129,
    items: [{ itemCode: ITEM, itemName: 'ZZ ทดสอบระบบ (ลบได้)', qty: 80, converter: 1000 }],
  });
  menu = (await readMenus()).find(m => m.code === MENU);
  bom = (await readBom())[MENU];
  check('แก้ชื่อเมนูแล้วเปลี่ยนจริง', menu?.name === 'ZZ เมนูทดสอบ แก้ไขแล้ว', menu?.name);
  check('แก้ราคาแล้วเปลี่ยนจริง (129)', menu?.price === 129, `ได้ ${menu?.price}`);
  check('แก้สูตรแล้วต้นทุนคิดใหม่ (0.15 × 80 = 12)', r2(menu?.cost) === 12, `ได้ ${menu?.cost}`);
  check('สูตรถูกแทนที่ทั้งชุด ไม่ใช่ต่อท้าย', (bom?.items || []).length === 1, `ได้ ${(bom?.items || []).length} แถว`);

  await actions.saveMenuStatus({ code: MENU, status: 'ปิดการใช้งาน' });
  menu = (await readMenus()).find(m => m.code === MENU);
  check('ปิดการใช้งานเมนูแล้วสถานะเปลี่ยน', menu?.status === 'ปิดการใช้งาน', menu?.status);

  /* ───────────────── ลบ ───────────────── */
  console.log('\nการลบ');
  const del = await actions.deleteItem({ code: ITEM });
  check('ลบวัตถุดิบได้', !(await readItems()).some(i => i.key === ITEM));
  check('เตือนว่ายังมีสูตรใช้วัตถุดิบนี้อยู่', del.usedInBom === 1, `ได้ ${del.usedInBom}`);

  if (!KEEP) await cleanup();
  else console.log(`\n--keep: ของทดสอบยังอยู่ในฐาน (เมนู ${MENU}) — เปิดหน้า QC/RD ดูได้ ลบเองเมื่อพอใจ`);
} catch (err) {
  console.error(`\n❌ พังกลางทาง: ${err.message}`);
  fails.push(`ข้อผิดพลาด: ${err.message}`);
  if (!KEEP) await cleanup().catch(() => {});
} finally {
  await pool.close();
}

console.log(`\n${fails.length ? '❌' : '✅'} ผ่าน ${pass} ข้อ · ไม่ผ่าน ${fails.length} ข้อ`);
if (fails.length) { fails.forEach(f => console.log(`   - ${f}`)); process.exit(1); }
