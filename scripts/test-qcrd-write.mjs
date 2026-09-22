// ทดสอบฝั่ง "เขียน" ของ QC/RD บน SQL — ว่าแต่ละ action ลงตารางไหน ด้วยค่าอะไร
//
// ไม่ต่อฐานข้อมูลจริง ไม่ต้อง npm install — ใส่ตัวยิงคำสั่งปลอมเข้าไปแทน แล้วดักดูว่า
// lib/qcrdSql.mjs สั่ง SQL อะไรออกมาบ้าง จึงรันที่ไหนก็ได้ รวมทั้งบน CI ที่ไปไม่ถึงเครื่องออฟฟิศ
//
// ตอบคำถาม "บันทึก/แก้ไข/เพิ่ม เมนูกับวัตถุดิบ แล้วเข้าตารางไหน" ได้โดยไม่ต้องแตะข้อมูลจริง
// ส่วนการยิงเข้าฐานจริงให้ใช้ scripts/smoke-qcrd-sql.mjs (ต้องต่อฐานได้)
//
//   node scripts/test-qcrd-write.mjs
import { createQcrd } from '../lib/qcrdSql.mjs';
import { QCRD_ROW_MAPPERS } from '../lib/qcrdRows.mjs';
import { patchSavedMenu, bomRowsFromForm } from '../lib/qcrdPatch.mjs';

/* ─────────────── ตัวยิงคำสั่งปลอม: จำทุกคำสั่ง + ตอบค่าที่ตรรกะต้องใช้ ─────────────── */
function fakeDb({ menus = [], items = {}, useUnitCol = true } = {}) {
  const log = [];
  const menuSet = new Set(menus);

  const q = async (text, params = {}) => {
    const t = String(text).replace(/\s+/g, ' ').trim();
    log.push({ sql: t, params });

    // ราคาวัตถุดิบ — ตรรกะคิดต้นทุนอ่านตัวนี้ก่อนเสมอ
    if (t.startsWith('SELECT item_key, price FROM dbo.stock_item')) {
      return Object.entries(items).map(([item_key, price]) => ({ item_key, price }));
    }
    if (t.startsWith('SELECT menu_code FROM dbo.qcrd_menu WHERE menu_code'))
      return menuSet.has(params.c) ? [{ menu_code: params.c }] : [];
    if (t.startsWith('SELECT menu_name FROM dbo.qcrd_menu WHERE menu_code'))
      return [{ menu_name: `ชื่อของ ${params.c ?? params.src}` }];
    if (t.includes('MAX(sort_order) AS s FROM dbo.qcrd_menu')) return [{ s: 5474 }];
    if (t.includes('MAX(sort_order) AS s FROM dbo.stock_item')) return [{ s: 3000 }];
    // คอลัมน์ use_unit ถูกเพิ่มทีหลังด้วย docs/schema-qcrd.sql — ฐานที่ยังไม่ได้รันตอบ NULL
    if (t.includes("COL_LENGTH('dbo.stock_item', 'use_unit')")) return [{ n: useUnitCol ? 50 : null }];
    if (t.includes('FROM dbo.qcrd_bom b WHERE b.src_code')) return [];          // ไม่มีเมนูไหนดึงสูตรต่อ
    if (t.startsWith('SELECT item_key FROM dbo.stock_item WHERE item_key'))
      return params.k in items ? [{ item_key: params.k }] : [];
    if (t.startsWith('SELECT item_code FROM dbo.stock_item WHERE item_key'))
      return params.k in items ? [{ item_code: params.k }] : [];
    if (t.includes('COUNT(*) AS n FROM dbo.qcrd_bom WHERE item_key')) return [{ n: 2 }];
    if (t.includes('@@ROWCOUNT AS n')) return [{ n: 1 }];
    if (t.startsWith('SELECT group_code, group_name FROM dbo.qcrd_menu_group')) return [];
    return [];
  };

  return { db: { q, withTx: (fn) => fn({ tx: true }) }, log };
}

/* ─────────────────────────────── ตัวช่วยตรวจ ─────────────────────────────── */
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
/** คำสั่งที่ "เขียน" ทั้งหมด (ตัด SELECT ที่เป็นแค่การอ่านประกอบทิ้ง) */
const writes = (log) => log.map(l => l.sql).filter(s => /^(INSERT|UPDATE|DELETE|MERGE)\b/i.test(s));
const hit = (log, re) => log.find(l => re.test(l.sql));

/* ══════════════════════════ 1) วัตถุดิบ ══════════════════════════ */
console.log('\nวัตถุดิบ (หน้า QC/RD > ไอเทม)');

{
  const { db, log } = fakeDb({ items: {} });
  const { actions } = createQcrd(db);
  const out = await actions.addItem({
    code: '00099001', name: 'ทดสอบ เพิ่มวัตถุดิบ', price: 250, unit: 'กก.',
    converter: 1000, storeCategory: 'ของแห้ง', branches: ['narai', 'NK'],
  });
  const ins = hit(log, /^INSERT INTO dbo\.stock_item/i);
  check('addItem → INSERT INTO dbo.stock_item', Boolean(ins));
  check('addItem → รหัสถูก normalize เป็น item_key', out.key === '99001', `ได้ ${out.key}`);
  check('addItem → ราคา/หน่วย/ตัวแปลง ส่งครบ',
    ins?.params.price === 250 && ins?.params.unit === 'กก.' && ins?.params.conv === 1000);
  check('addItem → เขียนสาขาลง dbo.stock_item_branch',
    log.filter(l => /INSERT INTO dbo\.stock_item_branch/i.test(l.sql)).length === 2);
  check('addItem → ไม่ไปแตะตารางเมนู', !writes(log).some(s => /qcrd_menu|qcrd_bom/i.test(s)));
}

{
  // หน่วยใช้ (คอลัมน์ที่เพิ่มทีหลัง) — ฐานที่รันสคีมาแล้วต้องเขียนลงไป
  const { db, log } = fakeDb({ items: {} });
  const { actions } = createQcrd(db);
  await actions.addItem({ code: '00099002', name: 'ทดสอบ หน่วยใช้', unit: 'ขวด', converter: 750, useUnit: 'มล.' });
  const ins = hit(log, /^INSERT INTO dbo\.stock_item/i);
  check('addItem → มีคอลัมน์ use_unit ในคำสั่ง', /use_unit/.test(ins?.sql || ''));
  check('addItem → ส่งค่าหน่วยใช้ไปด้วย', ins?.params.uunit === 'มล.');
}

{
  // ฐานที่ยังไม่ได้รัน docs/schema-qcrd.sql — ต้องยังเพิ่มของได้ตามปกติ ไม่ใช่ล้มทั้งหน้า
  const { db, log } = fakeDb({ items: {}, useUnitCol: false });
  const { actions } = createQcrd(db);
  await actions.addItem({ code: '00099003', name: 'ทดสอบ ฐานยังไม่มีคอลัมน์', unit: 'ขวด' });
  const ins = hit(log, /^INSERT INTO dbo\.stock_item/i);
  check('ฐานยังไม่มีคอลัมน์ → เพิ่มวัตถุดิบได้ตามปกติ', Boolean(ins));
  check('ฐานยังไม่มีคอลัมน์ → ไม่ใส่ use_unit ลงคำสั่ง', !/use_unit/.test(ins?.sql || ''));

  // แต่ถ้ามีคนกรอกหน่วยใช้มาจริง ต้องฟ้อง ไม่ใช่เงียบแล้วทิ้งค่าที่เขาพิมพ์
  let msg = '';
  try {
    await actions.addItem({ code: '00099004', name: 'ทดสอบ ฟ้อง', useUnit: 'กรัม' });
  } catch (err) { msg = err.message; }
  check('ฐานยังไม่มีคอลัมน์ + กรอกหน่วยใช้ → บอกให้ไปรันสคีมา', /schema-qcrd\.sql/.test(msg), msg || 'ไม่ฟ้องเลย');
}

{
  const { db, log } = fakeDb({ items: { 99001: 250 } });
  const { actions } = createQcrd(db);
  await actions.saveItem({ code: '00099001', price: 275, unit: 'กก.', status: 'ใช้งาน' });
  const upd = hit(log, /^UPDATE dbo\.stock_item SET/i);
  check('saveItem → UPDATE dbo.stock_item', Boolean(upd));
  check('saveItem → ราคาใหม่ถูกส่งไป', Object.values(upd?.params || {}).includes(275));
  check('saveItem → กรองด้วย item_key ไม่ใช่รหัสดิบ', /WHERE item_key = @k/.test(upd?.sql || ''));
}

{
  // รอบ "บันทึกสาขา -> อ่านกลับ" บนฐานปลอมที่เก็บแถวจริง — เคสที่คนใช้เจอว่า
  // กดบันทึกแล้วชิปสาขาในตารางไม่เปลี่ยน ต้องพิสูจน์ได้ว่าของที่คืนกลับมาคือของในฐานจริง
  let branchRows = ['crm', 'hps', 'hrs', 'p90'].map(b => ({ item_key: '11000265', branch: b }));
  const item = {
    item_key: '11000265', item_code: '11000265', item_name: 'นมสด', price: 39, unit: 'ลิตร',
    status: 'ใช้งาน', store_cat: null, converter: null, sub_item1: null, sub_item2: null,
    sub_item3: null, item_type: 'วัตถุดิบ', used_when: null, pos_item_id: '4120', request_unit: '2',
  };
  const q = async (text, params = {}) => {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (t.startsWith('SELECT item_key FROM dbo.stock_item WHERE item_key')) return [{ item_key: params.k }];
    if (t.startsWith('SELECT item_key, item_code')) return [item];
    if (t.startsWith('SELECT item_key, branch FROM dbo.stock_item_branch')) return branchRows;
    if (t.startsWith('SELECT branch FROM dbo.stock_item_branch WHERE item_key')) {
      return branchRows.filter(r => r.item_key === params.k)
        .map(r => ({ branch: r.branch })).sort((a, b) => a.branch.localeCompare(b.branch));
    }
    if (t.startsWith('DELETE FROM dbo.stock_item_branch')) {
      branchRows = branchRows.filter(r => r.item_key !== params.k); return [];
    }
    if (t.startsWith('INSERT INTO dbo.stock_item_branch')) {
      branchRows.push({ item_key: params.k, branch: params.b }); return [];
    }
    return [];
  };
  const core = createQcrd({ q, withTx: (fn) => fn({ tx: true }) });

  // เอา HPS (สาขาที่ปิดกิจการแล้ว) ออก แล้วเพิ่ม WMT
  const out = await core.actions.saveItem({
    code: '11000265', name: 'นมสด', status: 'ใช้งาน', subs: [], price: '39', unit: 'ลิตร',
    converter: '', branches: ['CRM', 'HRS', 'P90', 'WMT'], storeCategory: '',
    posItemId: '4120', requestUnit: '2', itemType: 'วัตถุดิบ', usedWhen: '',
  });
  const want = ['CRM', 'HRS', 'P90', 'WMT'];
  check('saveItem → คืนสาขาที่อ่านกลับจากฐานหลังเขียนเสร็จ',
    JSON.stringify(out.branches) === JSON.stringify(want), `ได้ ${JSON.stringify(out.branches)}`);
  const back = (await core.readItems())[0].usedBranches;
  check('saveItem → อ่านทะเบียนใหม่แล้วได้สาขาชุดที่เพิ่งบันทึก',
    JSON.stringify([...back].sort()) === JSON.stringify(want), `ได้ ${JSON.stringify(back)}`);
  check('saveItem → สาขาที่ถอดออกหายไปจริง', !back.includes('HPS'));

  // อ่านกลับเฉพาะรหัสเดียว (?code=) — ตัวที่ทำให้การตรวจหลังบันทึกไม่ต้องลากทะเบียน 1.17 MB กลับมา
  const sqlLog = [];
  const spy = async (text, params) => { sqlLog.push(String(text).replace(/\s+/g, ' ').trim()); return q(text, params); };
  const spied = createQcrd({ q: spy, withTx: (fn) => fn({ tx: true }) });
  const one = await spied.readItems(['011000265']);   // มี 0 นำหน้า ต้อง normalize ให้ตรง item_key
  check('readItems(codes) → คืนเฉพาะรหัสที่ขอ', one.length === 1 && one[0].code === '11000265');
  check('readItems(codes) → กรองด้วย IN (...) แบบผูกพารามิเตอร์',
    sqlLog.every(t => !t.includes('WHERE item_key IN (11')) && sqlLog.some(t => /WHERE item_key IN \(@k0\)/.test(t)));
  check('readItems(codes) → ตารางสาขาก็ถูกกรองด้วย ไม่ได้ลากมาทั้งตาราง',
    sqlLog.some(t => /stock_item_branch WHERE item_key IN/.test(t)));
  sqlLog.length = 0;
  await spied.readItems();
  check('readItems() → ไม่ส่งรหัส = ทั้งทะเบียน (ไม่มี WHERE)',
    sqlLog.every(t => !/WHERE item_key IN/.test(t)));
  sqlLog.length = 0;
  check('readItems([]) → ไม่ยิงคำสั่งเลย', (await spied.readItems([])).length === 0 && sqlLog.length === 0);
}

{
  const { db, log } = fakeDb({ items: { 99001: 250 } });
  const { actions } = createQcrd(db);
  const out = await actions.deleteItem({ code: '00099001' });
  check('deleteItem → DELETE FROM dbo.stock_item', Boolean(hit(log, /^DELETE FROM dbo\.stock_item WHERE/i)));
  check('deleteItem → ลบสาขาของไอเทมนั้นด้วย', Boolean(hit(log, /^DELETE FROM dbo\.stock_item_branch/i)));
  check('deleteItem → บอกจำนวนสูตรที่ยังใช้ไอเทมนี้', out.usedInBom === 2, `ได้ ${out.usedInBom}`);
}

/* ══════════════════════════ 2) เมนู + สูตร ══════════════════════════ */
console.log('\nเมนูและสูตร BOM (หน้า QC/RD > เมนู)');

{
  // ราคา 120/หน่วยซื้อ ÷ ตัวแปลง 1000 = 0.12 ต่อกรัม × 50 กรัม = 6
  // ราคา 60/หน่วยซื้อ  ÷ ตัวแปลง 1000 = 0.06 ต่อกรัม × 25 กรัม = 1.5   รวม 7.5
  const { db, log } = fakeDb({ menus: [], items: { 99001: 120, 99002: 60 } });
  const { actions } = createQcrd(db);
  const out = await actions.saveMenu({
    code: 'TEST9001', name: 'ทดสอบ เมนูใหม่', price: 199, group: '11',
    items: [
      { itemCode: '00099001', itemName: 'วัตถุดิบ ก', qty: 50, converter: 1000 },
      { itemCode: '00099002', itemName: 'วัตถุดิบ ข', qty: 25, converter: 1000 },
    ],
  });
  check('saveMenu (เมนูใหม่) → INSERT INTO dbo.qcrd_menu', Boolean(hit(log, /^INSERT INTO dbo\.qcrd_menu \(/i)));
  check('saveMenu → ล้างสูตรเดิมก่อนใส่ใหม่', Boolean(hit(log, /^DELETE FROM dbo\.qcrd_bom WHERE menu_code/i)));
  check('saveMenu → INSERT INTO dbo.qcrd_bom ครบทุกแถว',
    log.filter(l => /^INSERT INTO dbo\.qcrd_bom/i.test(l.sql)).length === 2);
  check('saveMenu → คิดต้นทุนรวมถูก (6 + 1.5 = 7.5)', out.totalCost === 7.5, `ได้ ${out.totalCost}`);
  check('saveMenu → คืนจำนวนแถวสูตรถูก', out.bomRows === 2, `ได้ ${out.bomRows}`);

  const line = hit(log, /^INSERT INTO dbo\.qcrd_bom/i);
  check('saveMenu → แถวสูตรเก็บ item_key ที่ normalize แล้ว', line?.params.item_key === '99001');
  check('saveMenu → ต้นทุนต่อหน่วยเล็ก = ราคา ÷ ตัวแปลง', line?.params.unit_cost === 0.12);
}

{
  const { db, log } = fakeDb({ menus: ['TEST9001'], items: { 99001: 120 } });
  const { actions } = createQcrd(db);
  await actions.saveMenu({
    code: 'TEST9001', name: 'ทดสอบ แก้ไขเมนู', price: 249,
    items: [{ itemCode: '00099001', itemName: 'วัตถุดิบ ก', qty: 50, converter: 1000 }],
  });
  const upd = hit(log, /^UPDATE dbo\.qcrd_menu SET/i);
  check('saveMenu (เมนูเดิม) → UPDATE ไม่ใช่ INSERT',
    Boolean(upd) && !hit(log, /^INSERT INTO dbo\.qcrd_menu \(/i));
  check('saveMenu (เมนูเดิม) → ชื่อกับราคาใหม่ถูกส่งไป',
    upd?.params.name === 'ทดสอบ แก้ไขเมนู' && upd?.params.price === 249);
}

{
  const { db, log } = fakeDb({ menus: ['TEST9001'] });
  const { actions } = createQcrd(db);
  const out = await actions.saveMenuStatus({ code: 'TEST9001', status: 'ปิดการใช้งาน' });
  check('saveMenuStatus → UPDATE dbo.qcrd_menu SET status', Boolean(hit(log, /UPDATE dbo\.qcrd_menu SET status/i)));
  check('saveMenuStatus → คืนสถานะใหม่', out.status === 'ปิดการใช้งาน');
}

{
  const { db, log } = fakeDb();
  const { actions } = createQcrd(db);
  await actions.saveMenuGroup({ code: '', name: 'หมวดทดสอบ' });
  check('saveMenuGroup → INSERT INTO dbo.qcrd_menu_group', Boolean(hit(log, /INSERT INTO dbo\.qcrd_menu_group/i)));
}

/* ══════════════════════════ 3) ไม่มีอะไรวิ่งไปชีท ══════════════════════════ */
console.log('\nที่เก็บปลายทาง');
{
  const { db, log } = fakeDb({ items: { 99001: 120 } });
  const { actions } = createQcrd(db);
  await actions.saveMenu({ code: 'TEST9002', name: 'ตรวจปลายทาง', items: [{ itemCode: '00099001', qty: 1 }] });
  const tables = [...new Set(writes(log)
    .map(s => s.match(/(?:INTO|UPDATE|FROM|MERGE)\s+(dbo\.\w+)/i)?.[1])
    .filter(Boolean))].sort();
  check('เขียนลง dbo.* เท่านั้น ไม่มีการเรียก Google Sheets',
    tables.every(t => t.startsWith('dbo.')), tables.join(', '));
  console.log(`    ตารางที่ saveMenu แตะ: ${tables.join(', ')}`);
}

/* ══════════ 4) AI อ่าน QC/RD จาก SQL ได้ตรงตำแหน่งคอลัมน์เดิมของชีท ══════════
   pages/api/ai-chat.js อ่านด้วย r[n] ตามตำแหน่งคอลัมน์ของชีท เลื่อนไปช่องเดียว
   AI จะตอบผิดโดยไม่มีอะไรฟ้อง — จำลองวิธีอ่านของเครื่องมือแต่ละตัวมาตรวจตรงนี้ */
console.log('\nAI อ่าน QC/RD จาก SQL (lib/qcrdRows.mjs)');
{
  // get_menu_costs อ่าน: r[0]=รหัส r[1]=ชื่อ r[2]=รหัสหมวด r[3]=ราคา r[4]=ต้นทุน r[5]=สถานะ
  const [, row] = QCRD_ROW_MAPPERS.menu.map([{
    code: '11004', name: 'สลัดปู', group: '11', price: 259, cost: 45.45,
    status: 'ใช้งาน', yieldQty: 1, yieldUnit: 'จาน',
  }]);
  check('menu → get_menu_costs อ่านครบทุกช่อง',
    row[0] === '11004' && row[1] === 'สลัดปู' && row[2] === '11'
    && row[3] === 259 && row[4] === 45.45 && row[5] === 'ใช้งาน',
    JSON.stringify(row.slice(0, 6)));

  // get_menu_recipe อ่าน: r[0]=รหัสเมนู r[1]=ชื่อเมนู r[2]=ลำดับ r[3]=รหัสวัตถุดิบ
  //                        r[4]=ชื่อวัตถุดิบ r[5]=ยอดใช้ r[7]=ตัวแปลง r[9]=ราคา r[13]=ต้นทุนแถว
  const [, b] = QCRD_ROW_MAPPERS.BOM.map({
    11004: {
      name: 'สลัดปู',
      items: [{
        seq: '1', itemCode: '00099001', itemName: 'ปูอัด', qty: 50, converter: 1000,
        itemPrice: 120, unitCost: 0.12, lineCost: 6, srcCode: '', srcName: '',
        srcFactor: null, srcBase: null, tag: 'วัตถุดิบ', noDeduct: false,
      }],
    },
  });
  check('BOM → get_menu_recipe อ่านครบทุกช่อง',
    b[0] === '11004' && b[1] === 'สลัดปู' && b[2] === '1' && b[3] === '00099001'
    && b[4] === 'ปูอัด' && b[5] === 50 && b[7] === 1000 && b[9] === 120 && b[13] === 6,
    JSON.stringify(b));
  check('BOM → ช่อง G กับ L ที่ชีทไม่ได้ใช้ ยังกันที่ไว้ให้คอลัมน์หลังไม่เลื่อน',
    b.length === 20 && b[6] === 1 && b[11] === '');

  // get_raw_materials อ่าน: r[0]=รหัส r[1]=ชื่อ r[2]=ราคา r[3]=หน่วย r[4]=สถานะ
  //                          r[5..7]=ทดแทน r[8]=ตัวแปลง r[9]=สาขา(คั่นด้วยจุลภาค) r[13]=หมวดสโตร์
  const [, i] = QCRD_ROW_MAPPERS.item.map([{
    code: '00099001', name: 'ปูอัด', price: 120, unit: 'กก.', status: 'ใช้งาน',
    subs: ['00099002'], converter: 1000, usedBranches: ['NARAI', 'NK'],
    storeCategory: 'ของแช่แข็ง', itemType: 'วัตถุดิบ', usedWhen: 'ทั้งสอง',
    posItemId: '9001', requestUnit: 'กก.',
  }]);
  check('item → get_raw_materials อ่านครบทุกช่อง',
    i[0] === '00099001' && i[1] === 'ปูอัด' && i[2] === 120 && i[3] === 'กก.'
    && i[4] === 'ใช้งาน' && i[5] === '00099002' && i[8] === 1000
    && i[9] === 'NARAI,NK' && i[13] === 'ของแช่แข็ง',
    JSON.stringify(i));

  const [, g] = QCRD_ROW_MAPPERS.menucodegroup.map([{ code: '11', name: 'สลัด' }]);
  check('menucodegroup → รหัสหมวดกับชื่อหมวดอยู่ช่อง 0 กับ 1', g[0] === '11' && g[1] === 'สลัด');

  check('ทุกแท็บมีแถวหัวตารางที่ index 0 (เครื่องมือทุกตัว .slice(1) ทิ้ง)',
    Object.values(QCRD_ROW_MAPPERS).every(m => {
      const rows = m.map(m.kind === 'bom' ? {} : []);
      return rows.length === 1 && rows[0].every(c => typeof c === 'string');
    }));
}

/* ══════════ 5) อัปเดตตารางจากผลการบันทึก โดยไม่โหลดข้อมูลใหม่ ══════════
   หน้าเมนูเคยโหลดใหม่ทั้ง 5 ชุด (5 MB) ทุกครั้งที่กดบันทึก เพื่อแก้ตัวเลขไม่กี่ช่อง
   ตอนนี้แปะจากคำตอบตรง ๆ — ตรงนี้ตรวจว่าค่าที่แปะไปตรงกับที่ควรเป็น
   วัดความไวเทียบกับของเดิมด้วย scripts/bench-qcrd-refresh.mjs */
console.log('\nอัปเดตตารางหลังบันทึก (lib/qcrdPatch.mjs)');
{
  const state = () => ({
    menus: [
      { code: 'A1', name: 'เมนูเก่า', group: '1', groupName: 'หมวด 1', price: 100, cost: 5, status: 'ใช้งาน' },
      { code: 'B2', name: 'เมนูที่ดึงสูตรไปใช้', group: '2', groupName: 'หมวด 2', price: 200, cost: 9, status: 'ใช้งาน' },
    ],
    bom: {
      A1: { name: 'เมนูเก่า', items: [{ seq: '1', itemCode: 'X', qty: 10 }] },
      B2: { name: 'เมนูที่ดึงสูตรไปใช้', items: [{ seq: '1', itemCode: 'X', qty: 2 }] },
    },
  });
  const rows = bomRowsFromForm([
    { itemCode: 'X', itemName: 'วัตถุดิบ ก', qty: 50, converter: 1000, tag: 'วัตถุดิบ' },
    { itemCode: 'Y', itemName: 'วัตถุดิบ ข', qty: 25, converter: 1000, tag: 'วัตถุดิบ' },
  ], { X: 120, Y: 60 });

  check('bomRowsFromForm → ต้นทุนต่อหน่วยเล็ก = ราคา ÷ ตัวแปลง', rows[0].unitCost === 0.12, `ได้ ${rows[0].unitCost}`);
  check('bomRowsFromForm → ต้นทุนแถว = ยอดใช้ × ต้นทุนต่อหน่วยเล็ก', rows[0].lineCost === 6, `ได้ ${rows[0].lineCost}`);
  check('bomRowsFromForm → ไล่ลำดับ 1..n ให้เอง', rows.map(r => r.seq).join(',') === '1,2');
  check('bomRowsFromForm → วัตถุดิบที่ไม่มีราคาได้ null ไม่ใช่ 0',
    bomRowsFromForm([{ itemCode: 'Z', qty: 1 }], {})[0].lineCost === null);

  const before = state();
  const out = patchSavedMenu(before, {
    code: 'A1', name: 'เมนูแก้แล้ว', price: 149, cost: 7.5, rows, cascaded: [],
  });
  const a1 = out.menus.find(m => m.code === 'A1');
  check('แก้เมนูเดิม → ชื่อ/ราคา/ต้นทุน เปลี่ยนครบ',
    a1.name === 'เมนูแก้แล้ว' && a1.price === 149 && a1.cost === 7.5);
  check('แก้เมนูเดิม → สูตรถูกแทนที่ทั้งชุด', out.bom.A1.items.length === 2);
  check('แก้เมนูเดิม → ไม่แตะ state เดิม (ของเดิมยังเป็น 1 แถว)', before.bom.A1.items.length === 1);
  check('แก้เมนูเดิม → เมนูอื่นไม่ถูกแตะ', out.menus.find(m => m.code === 'B2').cost === 9);

  const added = patchSavedMenu(state(), { code: 'NEW9', name: 'เมนูใหม่', price: 59, cost: 3, rows, cascaded: [] });
  check('เมนูใหม่ → ถูกต่อท้ายตาราง', added.menus.at(-1).code === 'NEW9' && added.menus.length === 3);
  check('เมนูใหม่ → ตั้งสถานะเป็นใช้งาน', added.menus.at(-1).status === 'ใช้งาน');

  const emptied = patchSavedMenu(state(), { code: 'A1', name: 'เมนูเก่า', cost: null, rows: [], cascaded: [] });
  check('ถอดวัตถุดิบออกหมด → เมนูนั้นไม่มีสูตรแล้ว', !('A1' in emptied.bom));

  const casc = patchSavedMenu(state(), {
    code: 'A1', name: 'เมนูเก่า', cost: 7.5, rows,
    cascaded: [{ code: 'B2', name: 'เมนูที่ดึงสูตรไปใช้', rows: 5, cost: 12.34 }],
  });
  check('เมนูที่ผูกสูตรกัน → ต้นทุนใหม่ถูกแปะให้ด้วย',
    casc.menus.find(m => m.code === 'B2').cost === 12.34);
  check('เมนูที่ผูกสูตรกัน → จำนวนแถวถูกต้องทันที', casc.bom.B2.count === 5);
  check('เมนูที่ผูกสูตรกัน → ไม่กุบรรทัดปลอมขึ้นมาให้ครบจำนวน', casc.bom.B2.items.length === 1);
  check('เมนูที่ผูกสูตรกัน → ถูกบอกว่าบรรทัดยังเก่า จะได้โหลดตามทีหลัง',
    casc.staleBom.join(',') === 'B2');
  check('ไม่มีเมนูผูกกัน → ไม่ต้องโหลดอะไรตามเลย', out.staleBom.length === 0);
}

/* ─────────────────────────────── สรุป ─────────────────────────────── */
console.log(`\n${fails.length ? '❌' : '✅'} ผ่าน ${pass} ข้อ · ไม่ผ่าน ${fails.length} ข้อ`);
if (fails.length) { fails.forEach(f => console.log(`   - ${f}`)); process.exit(1); }
