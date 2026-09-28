// คัดลอกสูตรฝั่ง POS (RcpDtls) มาเป็นสูตรจริงของเมนู (qcrd_bom) — ปุ่ม "คัดลอกลงฐานข้อมูล"
// ที่หน้า QC/RD > เมนู
//
// ทางเขียนใช้ action saveMenu ตัวเดิม (ตัวเดียวกับฟอร์มแก้สูตร) ไฟล์นี้มีหน้าที่แค่แปลงบรรทัด
// ที่ /api/rcp?rtsId= คืนมา ให้เป็นแถววัตถุดิบในรูปแบบเดียวกับที่ฟอร์มส่งไปบันทึก
// แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อให้ทดสอบได้โดยไม่ต้องมีเบราว์เซอร์ (แบบเดียวกับ lib/qcrdPatch.mjs)
//
// การแปลงแต่ละช่อง
//   รหัสวัตถุดิบ  RcpDtls เขียน '01000077' ทะเบียนเขียน '1000077' — หาในทะเบียนด้วย rcpItemKey
//                เจอ = ใช้รหัส/ชื่อตามทะเบียน · ไม่เจอ = ใช้รหัส POS ที่ตัด 0 นำหน้าแล้ว
//                (ต้นทุนบรรทัดนั้นจะว่างจนกว่าจะเพิ่มวัตถุดิบตัวนั้นเข้าทะเบียน)
//   ยอดใช้       net_qty ("ปริมาณใช้" ในหน้าต่างดูสูตร)
//   ตัวแปลงหน่วย portion ("สัดส่วน/หน่วย") — เป็นคู่กับ net_qty ในฝั่ง POS เอง
//                (net_qty ÷ portion = ยอดใช้เป็นหน่วยสต๊อก) จึงคงสัดส่วนเดิมของ POS ไว้ได้ตรงที่สุด
//                ไม่มีค่า → ใช้ตัวแปลงของทะเบียนวัตถุดิบ → ไม่มีอีก ใช้ 1000 ตามกติกาเดิมของ BOM
//   แท็ก         ตามประเภทในทะเบียน (แพ็กเกจจิ้ง/วัตถุดิบ) เหมือนตอนเลือกวัตถุดิบในฟอร์ม
//
// บรรทัดที่ข้าม: ไม่มีรหัสวัตถุดิบ หรือยอดใช้ว่าง/0 — ฟอร์มแก้สูตรก็ทิ้งแถวแบบนี้ตอนบันทึกอยู่แล้ว
import { rcpItemKey } from './rcpMatch.js';

export const DEFAULT_CONVERTER = 1000;
// ต้องสะกดตรงกับ TAG_MATERIAL / TAG_PACKAGING ใน components/QcRdMenu.jsx
const TAG_MATERIAL = 'วัตถุดิบ';
const TAG_PACKAGING = 'แพ็กเกจจิ้ง';

const round4 = (n) => Math.round(n * 10000) / 10000;
const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** รหัสวัตถุดิบแบบที่ทะเบียนเขียน — ตัด 0 นำหน้าและ .0 ท้าย แต่คงตัวพิมพ์เดิมไว้ */
const plainCode = (v) => {
  const s = String(v ?? '').trim().replace(/\.0+$/, '');
  return s.replace(/^0+/, '') || s;
};

/**
 * บรรทัดสูตร POS -> แถววัตถุดิบสำหรับ saveMenu
 *
 * @param {Array<{itemCode, itemName, qty, portion}>} lines  items จาก /api/rcp?rtsId=
 * @param {Record<string, {code, name, converter, itemType}>} itemByKey  ทะเบียนวัตถุดิบ คีย์ = rcpItemKey(code)
 * @returns {{
 *   rows: Array<{itemCode, itemName, qty, converter, tag, noDeduct}>,
 *   skipped: number,          บรรทัดที่ข้าม (ไม่มีรหัส/ยอดใช้เป็น 0)
 *   notInRegistry: string[],  รหัสที่ไม่มีในทะเบียนวัตถุดิบ (ยังคัดลอกให้ แต่ไม่มีราคาคิดต้นทุน)
 *   convMismatch: number,     บรรทัดที่ตัวแปลงของ POS ไม่ตรงกับที่ทะเบียนตั้งไว้ (ควรเปิดดู)
 * }}
 */
export function rcpLinesToBom(lines, itemByKey = {}) {
  const rows = [];
  const notInRegistry = [];
  let skipped = 0;
  let convMismatch = 0;

  for (const l of lines || []) {
    const key = rcpItemKey(l?.itemCode);
    const qty = pos(l?.qty);
    if (!key || qty === null) { skipped++; continue; }

    const info = itemByKey[key];
    const regConv = pos(info?.converter);
    const posConv = pos(l.portion);
    const converter = posConv ?? regConv ?? DEFAULT_CONVERTER;
    if (posConv !== null && regConv !== null && posConv !== regConv) convMismatch++;
    if (!info) notInRegistry.push(plainCode(l.itemCode));

    rows.push({
      itemCode: info ? info.code : plainCode(l.itemCode),
      itemName: (info && info.name) || String(l.itemName ?? '').trim(),
      qty: round4(qty),
      converter,
      tag: info?.itemType === TAG_PACKAGING ? TAG_PACKAGING : TAG_MATERIAL,
      noDeduct: false,
    });
  }
  return { rows, skipped, notInRegistry, convMismatch };
}

/** แถวจาก rcpLinesToBom -> รูปแบบ items ที่ action saveMenu รับ (ช่องเดียวกับที่ฟอร์มส่ง) */
export function toSaveItems(rows) {
  return rows.map((r) => ({
    itemCode: r.itemCode, itemName: r.itemName,
    qty: r.qty, converter: r.converter,
    // ไม่ใส่ที่มา (src*) — ช่องนั้นหมายถึง "ดึงมาจากเมนูอื่นในทะเบียน" และใช้คิด cascade
    // ถ้าใส่ rts_id ของ POS ลงไป ระบบจะไปไล่หาเมนูรหัสนั้นทุกครั้งที่มีการบันทึก
    srcCode: '', srcName: '', srcFactor: '', srcBase: '',
    tag: r.tag, noDeduct: r.noDeduct ? 'Y' : '',
  }));
}
