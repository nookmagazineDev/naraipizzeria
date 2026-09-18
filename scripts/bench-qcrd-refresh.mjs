// วัดความไวของการอัปเดตตารางหลังกดบันทึกในหน้า QC/RD — แบบเดิม (โหลดใหม่ทั้งชุด) เทียบแบบใหม่
//
// วัดสองอย่างที่วัดได้จริงโดยไม่ต้องมีเบราว์เซอร์หรือฐานข้อมูล:
//   1) ขนาดข้อมูลที่ต้องวิ่งผ่านเน็ต (ไบต์ของ JSON ที่เซิร์ฟเวอร์ส่งกลับ)
//   2) เวลาที่ฝั่งเบราว์เซอร์ต้องใช้แกะ JSON แล้วประกอบเป็น state
// เวลาวิ่งบนเน็ตจริงกับเวลาที่ SQL ใช้ค้นข้อมูลเป็นส่วนที่ต้องบวกเพิ่มจากตัวเลขนี้อีก
//
//   node scripts/bench-qcrd-refresh.mjs
//   node scripts/bench-qcrd-refresh.mjs --menus 3003 --with-bom 1167 --lines 8
import process from 'node:process';
import { patchSavedMenu, bomRowsFromForm } from '../lib/qcrdPatch.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
// ค่าเริ่มต้นตามของจริงที่หน้าเว็บขึ้นอยู่ตอนนี้: "3,003 เมนู · มีสูตร (BOM) 1,167 เมนู"
const N_MENUS = arg('menus', 3003);
const N_WITH_BOM = arg('with-bom', 1167);
const N_LINES = arg('lines', 8);
const N_ITEMS = arg('items', 3000);

const ms = (n) => `${n.toFixed(1)} ms`;
const kb = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const time = (fn) => { const t = process.hrtime.bigint(); const out = fn(); return [Number(process.hrtime.bigint() - t) / 1e6, out]; };
/** รันหลายรอบแล้วเอาค่ากลาง — รอบแรกของ V8 ช้ากว่าปกติเสมอ ใช้รอบเดียวจะได้ตัวเลขหลอก */
const median = (runs, fn) => {
  const xs = Array.from({ length: runs }, () => time(fn)[0]).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
};

/* ───────────────── สร้างข้อมูลจำลองขนาดเท่าของจริง ───────────────── */
const menus = Array.from({ length: N_MENUS }, (_, i) => ({
  code: `110${String(i).padStart(5, '0')}`,
  name: `เมนูทดสอบลำดับที่ ${i} ชื่อยาวพอ ๆ กับของจริง`,
  group: String((i % 104) + 1), groupName: `หมวดหมู่ที่ ${(i % 104) + 1}`,
  price: 100 + (i % 300), cost: 12.3456, status: 'ใช้งาน', yieldQty: 1, yieldUnit: 'จาน',
}));

const bom = {};
for (let i = 0; i < N_WITH_BOM; i++) {
  const code = menus[i].code;
  bom[code] = {
    name: menus[i].name,
    items: Array.from({ length: N_LINES }, (_, k) => ({
      seq: String(k + 1), itemCode: `99${String(k).padStart(5, '0')}`,
      itemName: `วัตถุดิบทดสอบชื่อยาวพอสมควร ลำดับ ${k}`,
      qty: 12.5, converter: 1000, itemPrice: 120, unitCost: 0.12, lineCost: 1.5,
      srcCode: '', srcName: '', srcFactor: null, srcBase: null,
      tag: 'วัตถุดิบ', noDeduct: false,
    })),
  };
}

const items = Array.from({ length: N_ITEMS }, (_, i) => ({
  code: `99${String(i).padStart(5, '0')}`, key: String(99000 + i),
  name: `วัตถุดิบในทะเบียน ลำดับ ${i}`, price: 120 + (i % 400), unit: 'กก.',
  status: 'ใช้งาน', subs: [], converter: 1000, usedBranches: ['NARAI', 'NK'],
  storeCategory: 'ของแห้ง', itemType: 'วัตถุดิบ', usedWhen: 'ทั้งสอง',
  posItemId: String(i), requestUnit: 'กก.',
}));

const groups = Array.from({ length: 104 }, (_, i) => ({ code: String(i + 1), name: `หมวดหมู่ที่ ${i + 1}` }));

const bomLines = Object.values(bom).reduce((s, m) => s + m.items.length, 0);
console.log(`ข้อมูลจำลอง: เมนู ${N_MENUS.toLocaleString()} · มีสูตร ${N_WITH_BOM.toLocaleString()} เมนู`
  + ` (${bomLines.toLocaleString()} บรรทัด) · วัตถุดิบ ${N_ITEMS.toLocaleString()} · หมวดหมู่ ${groups.length}\n`);

/* ───────────────── แบบเดิม: โหลดใหม่ทั้ง 4 ชุดทุกครั้งที่กดบันทึก ───────────────── */
const payloads = {
  menu: JSON.stringify({ status: 'success', data: menus }),
  bom: JSON.stringify({ status: 'success', data: bom }),
  item: JSON.stringify({ status: 'success', data: items }),
  menugroup: JSON.stringify({ status: 'success', data: groups }),
};
const bytes = Object.fromEntries(Object.entries(payloads).map(([k, v]) => [k, Buffer.byteLength(v, 'utf8')]));
const totalBytes = Object.values(bytes).reduce((a, b) => a + b, 0);

console.log('แบบเดิม — โหลดใหม่ทั้งชุดหลังกดบันทึก');
Object.entries(bytes).forEach(([k, n]) => {
  const parse = median(5, () => JSON.parse(payloads[k]));
  console.log(`  sheet=${k.padEnd(10)} ${kb(n).padStart(8)}  แกะ JSON ${ms(parse)}`);
});
const parseAll = median(5, () => Object.values(payloads).forEach(p => JSON.parse(p)));
console.log(`  ${'รวม'.padEnd(17)} ${kb(totalBytes).padStart(8)}  แกะ JSON ${ms(parseAll)}`);
console.log('  (+ เวลาที่ SQL ค้นข้อมูล และเวลาวิ่งบนเน็ตจริง ซึ่งเป็นส่วนที่ใหญ่ที่สุด)\n');

/* ───────────────── แบบใหม่: แปะผลจากคำตอบของการบันทึก ───────────────── */
const priceMap = Object.fromEntries(items.map(i => [i.code, i.price]));
const formRows = [
  { itemCode: items[0].code, itemName: items[0].name, qty: 50, converter: 1000, tag: 'วัตถุดิบ' },
  { itemCode: items[1].code, itemName: items[1].name, qty: 25, converter: 1000, tag: 'วัตถุดิบ' },
];
const saved = {
  code: menus[0].code, name: 'เมนูที่เพิ่งบันทึก', price: 199, cost: 7.5,
  rows: bomRowsFromForm(formRows, priceMap), cascaded: [],
};

const patchMs = median(21, () => patchSavedMenu({ menus, bom }, saved));
console.log('แบบใหม่ — แปะผลจากคำตอบของการบันทึก');
console.log(`  ${'ส่งผ่านเน็ตเพิ่ม'.padEnd(17)} ${'0 KB'.padStart(8)}  คิดในเครื่อง ${ms(patchMs)}`);

/* ───────────────── กรณีที่ยังต้องโหลดตามอยู่ ───────────────── */
const cascadedSaved = { ...saved, cascaded: [{ code: menus[1].code, name: menus[1].name, rows: 5, cost: 9.9 }] };
const cascadeMs = median(21, () => patchSavedMenu({ menus, bom }, cascadedSaved));
console.log(`  มีเมนูผูกสูตรกัน       ${kb(bytes.bom).padStart(8)}  คิดในเครื่อง ${ms(cascadeMs)} แล้วโหลดเฉพาะชุด bom ตามทีหลัง`);
console.log(`  เพิ่งสร้างหมวดใหม่     ${kb(bytes.menugroup).padStart(8)}  โหลดเฉพาะชุด menugroup`);
console.log(`  เพิ่งแก้หน่วยวัตถุดิบ    ${kb(bytes.item).padStart(8)}  โหลดเฉพาะชุด item\n`);

/* ───────────────── สรุป ───────────────── */
const saveRatio = totalBytes / 1024;
console.log('สรุป');
console.log(`  กรณีปกติ (แก้สูตรเมนูเดียว ไม่มีเมนูผูกกัน ไม่ได้เพิ่มหมวด/แก้หน่วย)`);
console.log(`    เดิม: ดึง ${kb(totalBytes)} + แกะ ${ms(parseAll)} ทุกครั้งที่กดบันทึก`);
console.log(`    ใหม่: ดึง 0 ไบต์ + คิดในเครื่อง ${ms(patchMs)} — ตารางอัปเดตทันทีในเฟรมเดียวกับที่ขึ้นข้อความสำเร็จ`);
console.log(`    ประหยัดการรับส่งข้อมูลไปราว ${saveRatio.toFixed(0)} KB ต่อการกดบันทึกหนึ่งครั้ง`);
