// QC/RD บน SQL -> แถวตามตำแหน่งคอลัมน์ของชีทเดิม
//
// ผู้ใช้ตอนนี้คือเครื่องมือของ AI ใน pages/api/ai-chat.js ซึ่งอ่านข้อมูลด้วย r[n] ตามตำแหน่ง
// คอลัมน์ของชีท แล้ว .slice(1) ทิ้งแถวหัวตาราง — แปลงให้เหมือนชีทที่นี่ที่เดียว ตัวเรียกทุกตัว
// (get_menu_costs, get_menu_recipe, get_raw_materials, which_menus_use_item, read_sheet)
// จึงใช้ได้ทั้งโหมดชีทและโหมด SQL โดยไม่ต้องแก้อะไรเลย
//
// ⚠️ ตำแหน่งคอลัมน์ต้องตรงกับ lib/qcrdMigrate.mjs (ตัวที่ย้ายชีทเข้า SQL) เสมอ
//    แก้ที่นั่นแล้วต้องตามมาแก้ที่นี่ — scripts/test-qcrd-write.mjs ตรวจตำแหน่งพวกนี้ไว้ให้

/** menu: A=Code B=NameThai C=MenuCode D=UnitPrice E=cost F=สถานะ G=ปริมาณที่ได้ H=หน่วยที่ได้ */
export const menuRows = (menus = []) => [
  ['Code', 'NameThai', 'MenuCode', 'UnitPrice', 'cost Menu', 'สถานะ', 'ปริมาณที่ได้', 'หน่วยที่ได้'],
  ...menus.map(m => [m.code, m.name, m.group, m.price, m.cost, m.status, m.yieldQty, m.yieldUnit]),
];

/** BOM: A=เลขPOS B=ชื่อเมนู C=ลำดับ D=รหัสวัตถุดิบ E=ชื่อ F=ยอดใช้ H=ตัวแปลง J=ราคา
 *  K/M=ต้นทุน/หน่วยเล็ก N=ต้นทุนรวมแถว O–R=ที่มา S=แท็ก T=ไม่ตัด BOM
 *  (G กับ L ไม่มีใครอ่าน แต่ต้องกันที่ไว้ ไม่งั้นคอลัมน์ถัดไปเลื่อนทั้งแถว) */
export const bomRows = (bom = {}) => {
  const rows = [[
    'เลขPOS', 'ชื่อเมนู', 'ลำดับ', 'รหัสวัตถุดิบ', 'ชื่อวัตถุดิบ', 'ยอดใช้', '', 'ตัวแปลงหน่วย',
    'รหัสตัด0', 'ราคาวัตถุดิบ', 'ต้นทุน/หน่วยเล็ก', '', 'ต้นทุน/หน่วยเล็ก', 'ต้นทุนรวม',
    'รหัสเมนูต้นทาง', 'ชื่อเมนูต้นทาง', 'สัดส่วน', 'ยอดใช้ตามสูตรเดิม', 'แท็ก', 'ไม่ตัด BOM',
  ]];
  Object.entries(bom).forEach(([code, m]) => {
    (m?.items || []).forEach(it => {
      rows.push([
        code, m.name, it.seq, it.itemCode, it.itemName, it.qty, 1, it.converter,
        '', it.itemPrice, it.unitCost, '', it.unitCost, it.lineCost,
        it.srcCode, it.srcName, it.srcFactor, it.srcBase, it.tag, it.noDeduct ? 'TRUE' : '',
      ]);
    });
  });
  return rows;
};

/** item: A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ F,G,H=ไอเทมทดแทน I=ตัวแปลง J=สาขาที่ใช้
 *  K=itemid(POS) L=หน่วยเบิก N=หมวดสโตร์ O=ประเภท P=ใช้กับ (M เว้นว่างไว้ตามชีท) */
export const itemRows = (items = []) => [
  ['รหัส', 'ชื่อ', 'ราคา', 'หน่วย', 'สถานะ', 'ทดแทน1', 'ทดแทน2', 'ทดแทน3', 'ตัวแปลง',
   'สาขาที่ใช้', 'itemid', 'หน่วยเบิก', '', 'หมวดสโตร์', 'ประเภท', 'ใช้กับ'],
  ...items.map(i => [
    i.code, i.name, i.price, i.unit, i.status,
    i.subs?.[0] || '', i.subs?.[1] || '', i.subs?.[2] || '', i.converter,
    (i.usedBranches || []).join(','), i.posItemId, i.requestUnit, '',
    i.storeCategory, i.itemType, i.usedWhen,
  ]),
];

/** menucodegroup: A=รหัสหมวด B=ชื่อหมวด */
export const menuGroupRows = (groups = []) => [
  ['MenuCode', 'ชื่อหมวด'],
  ...groups.map(g => [g.code, g.name]),
];

/** ชื่อแท็บในชีท -> ชุดข้อมูลของ fetchQcrdSql() + ตัวแปลงเป็นแถว */
export const QCRD_ROW_MAPPERS = {
  menu: { kind: 'menu', map: menuRows },
  BOM: { kind: 'bom', map: bomRows },
  item: { kind: 'item', map: itemRows },
  menucodegroup: { kind: 'menugroup', map: menuGroupRows },
};
