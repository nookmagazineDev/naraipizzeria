// ส่งออกตารางในหน้ารายละเอียด (modal) เป็น Excel — ใช้กับ CostDrillModal และ TableModal ของหน้าต้นทุนใบเบิกสาขา
//
// คอลัมน์ใช้นิยามเดียวกับที่วาดตาราง: { label, render(r), right?, x?(r) }
//   x      = ค่าที่จะลงไฟล์ (ใส่เมื่อ render คืน JSX หรืออยากได้ค่าดิบ)
//   right  = คอลัมน์ตัวเลข — ข้อความที่จัดรูปแล้ว ('1,234.50') แปลงกลับเป็นตัวเลขให้ Excel บวกได้
//
// ⚠️ ไฟล์นี้ใช้จากหน้าเว็บ ห้าม import โมดูลของ Node
import * as XLSX from 'xlsx-js-style';

const HEAD_STYLE = {
  font: { bold: true, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '334155' } }, // slate-700
};
const BOLD = { font: { bold: true } };

/** ข้อความตัวเลขที่จัดรูปแล้ว -> ตัวเลข (แปลงไม่ได้ = คืนของเดิม) */
function toCell(v, numeric) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return ''; // JSX ที่ไม่มี x — ไม่มีค่าให้ลง
  const s = String(v);
  if (numeric) {
    const t = s.replace(/[,฿\s]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  }
  return s;
}

/** ชื่อไฟล์ที่ปลอดภัย — ตัดอักขระที่ Windows ไม่ยอม */
const safeName = (s) => String(s || 'export').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * @param {object} p
 * @param {string} p.title
 * @param {string} [p.subtitle]
 * @param {Array<{label, render, right?, x?}>} p.cols
 * @param {object[]} p.rows
 * @param {Array} [p.foot]     แถวรวมท้ายตาราง (ค่าตามลำดับคอลัมน์)
 * @param {Array<{label, v, note?}>} [p.header]  บรรทัดสรุปเหนือตาราง (เช่น ส่วนประกอบ Total Food Cost)
 * @param {number|null} [p.total] ยอดรวมของ header (แสดงเป็น "Total Food Cost")
 */
export function exportTableXlsx({ title, subtitle, cols, rows, foot, header, total }) {
  const aoa = [[title]];
  if (subtitle) aoa.push([subtitle]);
  aoa.push([]);

  const boldRows = [];
  if (header?.length) {
    header.forEach((h) => aoa.push([`${h.label}${h.note ? ` (${h.note})` : ''}`, Number((Number(h.v) || 0).toFixed(2))]));
    if (total !== null && total !== undefined) {
      boldRows.push(aoa.length);
      aoa.push(['Total Food Cost', Number((Number(total) || 0).toFixed(2))]);
    }
    aoa.push([]);
  }

  const headRow = aoa.length;
  aoa.push(cols.map((c) => c.label));
  rows.forEach((r) => aoa.push(cols.map((c) => toCell(c.x ? c.x(r) : c.render(r), c.right))));
  if (foot) {
    boldRows.push(aoa.length);
    aoa.push(cols.map((c, i) => toCell(foot[i], c.right)));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = cols.map((c, i) => ({ wch: Math.max(12, ...aoa.slice(headRow, headRow + 200).map((r) => String(r[i] ?? '').length + 2)) }));
  cols.forEach((_, i) => {
    const cell = ws[XLSX.utils.encode_cell({ r: headRow, c: i })];
    if (cell) cell.s = HEAD_STYLE;
  });
  boldRows.forEach((r) => {
    for (let c = 0; c < Math.max(cols.length, 2); c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell) cell.s = BOLD;
    }
  });
  const t = ws[XLSX.utils.encode_cell({ r: 0, c: 0 })];
  if (t) t.s = { font: { bold: true, sz: 13 } };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'รายละเอียด');
  XLSX.writeFile(wb, `${safeName(title)}.xlsx`);
}
