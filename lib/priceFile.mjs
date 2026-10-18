// อ่านไฟล์ "ราคาซื้อสินค้าล่าสุด" (export จากระบบคลัง) — ปุ่ม "อัปเดตราคาจากไฟล์" หน้าวัตถุดิบ QC/RD
//
// รูปแบบไฟล์ (ตัวอย่าง INVENTORY 9-69 ราคา IT.xlsx):
//   แถว 1  ราคาซื้อสินค้าล่าสุด
//   แถว 2  บริษัท นารายณ์ พิซเซอเรีย จำกัด | วันที่ ...
//   แถว 3  รหัส | ชื่อ | ราคา                    ← หัวตาราง (หาจากข้อความ ไม่ได้ล็อกเลขแถว)
//   แถว 4+ 1000002 | FCน้ำซอสขี้เมา ... | 0
//   ท้ายสุด วันที่ | เวลา ที่ export
// มีได้หลายชีท (เช่น 9-69 กับ อุปกรณ์) อ่านทุกชีทที่หาหัวตารางเจอ
//
// แยกเป็นไฟล์ล้วน ๆ (ไม่แตะ xlsx/DOM) จะได้ทดสอบกับแถวที่อ่านมาได้ตรง ๆ
// หน้าเว็บอ่านไฟล์ด้วยแพ็กเกจ xlsx แล้วส่ง sheet_to_json(ws, { header: 1 }) ของแต่ละชีทมาให้

export const normKey = (code) => String(code ?? '').trim().replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

const cellText = (v) => String(v ?? '').replace(/\s+/g, '').trim();
const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
// รหัสสินค้า = ตัวเลข หรือข้อความที่เป็นตัวอักษร/ตัวเลขล้วน — แถววันที่ท้ายไฟล์ (Date) ไม่ผ่าน
const toCode = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(s) ? s : null;
};

/** หาแถวหัวตาราง (ใน 20 แถวแรก) ที่มีทั้ง "รหัส" และ "ราคา" */
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] || []).map(cellText);
    const code = cells.findIndex(c => c === 'รหัส' || c === 'รหัสสินค้า');
    const price = cells.findIndex(c => c === 'ราคา' || c.startsWith('ราคา'));
    if (code >= 0 && price >= 0 && code !== price) {
      return { row: i, code, price, name: cells.findIndex(c => c === 'ชื่อ' || c.startsWith('ชื่อ')) };
    }
  }
  return null;
}

/**
 * @param {Array<{ name: string, rows: any[][] }>} sheets
 * @returns {{ lines: Array<{ code, key, name, price, sheet }>, sheets: Array<{ name, rows, found }>, exportedAt: Date|null }}
 *   lines = ทุกแถวที่มีรหัส (ราคา 0/ว่าง ก็รวมมา ให้หน้าสรุปนับว่าข้ามไปกี่ตัว)
 */
export function readPriceSheets(sheets) {
  const lines = [];
  const info = [];
  let exportedAt = null;
  for (const { name, rows } of sheets || []) {
    const h = findHeader(rows || []);
    if (!h) { info.push({ name, rows: 0, found: false }); continue; }
    let count = 0;
    for (let i = h.row + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (r[h.code] instanceof Date) { exportedAt = exportedAt || r[h.code]; continue; }
      const code = toCode(r[h.code]);
      if (!code) continue;
      const price = toNumber(r[h.price]);
      lines.push({
        code, key: normKey(code),
        name: h.name >= 0 ? String(r[h.name] ?? '').trim() : '',
        price: price !== null && price > 0 ? price : null,
        sheet: name,
      });
      count++;
    }
    info.push({ name, rows: count, found: true });
  }
  return { lines, sheets: info, exportedAt };
}

/**
 * เทียบกับทะเบียนวัตถุดิบ
 *   change  ราคาไม่เท่าเดิม (หรือทะเบียนยังไม่มีราคา) → อัปเดต
 *   same    ราคาเท่าเดิม
 *   noPrice ไฟล์ไม่มีราคา (0/ว่าง) → ข้าม ไม่ทับราคาเดิม
 *   missing รหัสยังไม่มีในทะเบียน → ข้าม
 * รหัสเดียวกันมาหลายแถว (คนละชีท) ใช้แถวท้ายสุดที่มีราคา
 */
export function comparePrices(lines, items) {
  const byKey = new Map((items || []).map(i => [normKey(i.code), i]));
  const last = new Map();
  let duplicates = 0;
  for (const l of lines || []) {
    if (!l.key) continue;
    const prev = last.get(l.key);
    if (prev) duplicates++;
    if (!prev || l.price !== null) last.set(l.key, l);
  }
  const out = { change: [], same: [], noPrice: [], missing: [], duplicates };
  for (const l of last.values()) {
    const item = byKey.get(l.key);
    if (l.price === null) { out.noPrice.push({ ...l, item }); continue; }
    if (!item) { out.missing.push(l); continue; }
    const old = item.price === null || item.price === undefined || item.price === '' ? null : Number(item.price);
    const row = { ...l, item, old, pct: old ? ((l.price - old) / old) * 100 : null };
    if (old !== null && Math.abs(old - l.price) < 0.0001) out.same.push(row);
    else out.change.push(row);
  }
  return out;
}
