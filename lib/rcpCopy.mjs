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
//   ตัวแปลงหน่วย portion ("สัดส่วน/หน่วย") — ยืนยันจากสูตรในชีท Kios Dtls เองแล้ว:
//                "@ calculate" = ราคา 8.2 ÷ portion และ "Cost 8.2" = net_qty × ค่านั้น
//                (เช่น แซลมอน 13,080 × 405 ÷ 1000 = 5,297.40) คือหน่วยใช้ต่อ 1 หน่วยสต๊อกเหมือน converter
//                ไม่มีค่า → ทะเบียนวัตถุดิบ → หน่วยเล็กสุดที่ชื่อไอเทมบอก → 1000 ตามกติกาเดิมของ BOM
//   แท็ก         ตามประเภทในทะเบียน (แพ็กเกจจิ้ง/วัตถุดิบ) เหมือนตอนเลือกวัตถุดิบในฟอร์ม
//   ปริมาณที่ได้  rcp_qty = สูตรหนึ่งรอบทำได้กี่หน่วย (แท็บ Cost ของชีทเดียวกันคิด Cost/Unit = COST ÷ Rcp_Qty
//                เช่น 5,510.51 ÷ 107 = 51.50) — net_qty ทุกบรรทัดเป็นยอดของ "ทั้งรอบ" ไม่ใช่ต่อหน่วย
//
// บรรทัดที่ข้าม: ไม่มีรหัสวัตถุดิบ หรือยอดใช้ว่าง/0 — ฟอร์มแก้สูตรก็ทิ้งแถวแบบนี้ตอนบันทึกอยู่แล้ว
//
// ตรวจกับชื่อไอเทม (lib/unitFromName.mjs): portion ควรตรงกับขนาดที่ชื่อบอก ("(400กรัม/ถุง) ถุง" → 400)
// ไม่ตรง = น่าจะคีย์ผิดในฝั่ง POS จึงฟ้องไว้ให้เปิดดู (ไม่แก้ให้เอง — ตัวเลขของ POS คือของที่ใช้คิดต้นทุนจริง)
// และวัตถุดิบในทะเบียนที่ยังไม่มี "หน่วยใช้" จะได้หน่วยที่ตัวแปลงนั้นหมายถึงกลับไปให้เติม
import { rcpItemKey } from './rcpMatch.js';
import { checkConverter, unitOptionsFromName } from './unitFromName.mjs';

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
 * @param {Array<{itemCode, itemName, qty, rcpQty, portion}>} lines  items จาก /api/rcp?rtsId=
 * @param {Record<string, {code, name, unit, converter, itemType, useUnit}>} itemByKey  ทะเบียนวัตถุดิบ คีย์ = rcpItemKey(code)
 * @returns {{
 *   rows: Array<{itemCode, itemName, qty, converter, tag, noDeduct}>,
 *   skipped: number,          บรรทัดที่ข้าม (ไม่มีรหัส/ยอดใช้เป็น 0)
 *   notInRegistry: string[],  รหัสที่ไม่มีในทะเบียนวัตถุดิบ (ยังคัดลอกให้ แต่ไม่มีราคาคิดต้นทุน)
 *   convMismatch: number,     บรรทัดที่ตัวแปลงของ POS ไม่ตรงกับที่ทะเบียนตั้งไว้ (ควรเปิดดู)
 *   nameMismatch: Array<{code, name, portion, expect}>  portion ไม่ตรงกับขนาดที่ชื่อไอเทมบอก
 *   useUnitFills: Array<{code, name, useUnit}>  วัตถุดิบในทะเบียนที่ยังไม่มีหน่วยใช้ + หน่วยที่อ่านได้
 *   yieldQty: number|null,    สูตรหนึ่งรอบทำได้กี่หน่วย (rcp_qty) — null = POS ไม่ได้บอก
 * }}
 */
export function rcpLinesToBom(lines, itemByKey = {}) {
  const rows = [];
  const notInRegistry = [];
  const nameMismatch = [];
  const useUnitFills = [];
  const yieldVotes = new Map();
  let skipped = 0;
  let convMismatch = 0;

  for (const l of lines || []) {
    const y = pos(l?.rcpQty);
    if (y !== null) yieldVotes.set(y, (yieldVotes.get(y) || 0) + 1);

    const key = rcpItemKey(l?.itemCode);
    const qty = pos(l?.qty);
    if (!key || qty === null) { skipped++; continue; }

    const info = itemByKey[key];
    const posName = String(l.itemName ?? '').trim() || String(info?.name ?? '');
    const regConv = pos(info?.converter);
    const posConv = pos(l.portion);
    const fromName = unitOptionsFromName(posName);
    const nameConv = fromName.options.length ? fromName.smallest.per : null;
    const converter = posConv ?? regConv ?? nameConv ?? DEFAULT_CONVERTER;
    if (posConv !== null && regConv !== null && posConv !== regConv) convMismatch++;
    if (!info) notInRegistry.push(plainCode(l.itemCode));

    // portion ของ POS นับจากหน่วยสต๊อกตามชื่อไอเทมฝั่ง POS
    if (posConv !== null) {
      const chk = checkConverter(posName, posConv);
      if (chk.ok === false) {
        nameMismatch.push({ code: plainCode(l.itemCode), name: posName, portion: posConv, expect: chk.expect });
      }
    }
    // หน่วยใช้ของทะเบียน: คู่กับตัวแปลง "ของทะเบียน" (ถ้ามี) และนับจากหน่วยซื้อของทะเบียน
    // ไม่งั้นหน่วยที่เติมจะไม่ตรงกับตัวเลขที่ทะเบียนใช้คู่กันอยู่
    if (info && !String(info.useUnit ?? '').trim() && !useUnitFills.some(f => f.code === info.code)) {
      const chk = checkConverter(info.name || posName, regConv ?? converter, info.unit);
      if (chk.ok && chk.unit) useUnitFills.push({ code: info.code, name: info.name || posName, useUnit: chk.unit });
    }

    rows.push({
      itemCode: info ? info.code : plainCode(l.itemCode),
      itemName: (info && info.name) || String(l.itemName ?? '').trim(),
      qty: round4(qty),
      converter,
      tag: info?.itemType === TAG_PACKAGING ? TAG_PACKAGING : TAG_MATERIAL,
      noDeduct: false,
    });
  }
  // rcp_qty ซ้ำอยู่ทุกบรรทัดของสูตรเดียวกัน — เอาค่าที่เจอบ่อยสุด เผื่อบางบรรทัดคีย์เพี้ยน
  const yieldQty = [...yieldVotes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  return { rows, skipped, notInRegistry, convMismatch, nameMismatch, useUnitFills, yieldQty };
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
