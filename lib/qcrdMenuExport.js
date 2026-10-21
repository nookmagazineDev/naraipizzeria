// QC/RD เมนู → ไฟล์ Excel (ปุ่ม "ส่งออก Excel" หัวหน้าเมนู)
//
// ส่งออกเฉพาะเมนูที่ผ่านตัวกรองบนหน้า (ชุดเดียวกับที่เห็นในตาราง ลำดับเดียวกัน)
//   แผ่นงาน "เมนู"        1 แถวต่อเมนู
//   แผ่นงาน "สูตร (BOM)"  วัตถุดิบทุกบรรทัดของเมนูชุดนั้น
// สองแถวบนสุดของทุกแผ่นงานบอกเวลาที่ส่งออกและตัวกรองที่ใช้ เปิดไฟล์ทีหลังจะได้รู้ว่ากรองมายังไง
//
// แยกส่วนประกอบตาราง (ล้วน ๆ ไม่แตะ DOM/xlsx) ออกจากตัวเขียนไฟล์ เพื่อทดสอบได้ตรง ๆ

import { dateLabel } from './thaiDate';

const keyOf = (code) => String(code ?? '').trim().replace(/^0+/, '').toLowerCase();
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? '' : Number(v));
const round = (v, d) => (v === '' ? '' : Math.round(v * 10 ** d) / 10 ** d);

export const MENU_HEAD = [
  'รหัสเมนู', 'ชื่อเมนู', 'หมวดหมู่', 'ราคาขาย', 'ต้นทุนก่อนหน้า', 'วันที่ต้นทุนก่อนหน้า',
  'ต้นทุน', 'วันที่ต้นทุน', 'เปลี่ยน %', 'ต้นทุน/ราคาขาย %', 'จำนวนวัตถุดิบ',
  'ปริมาณที่ได้', 'หน่วยที่ได้', 'ต้นทุนต่อหน่วยที่ได้', 'สถานะ',
];
export const BOM_HEAD = [
  'รหัสเมนู', 'ชื่อเมนู', 'ลำดับ', 'รหัสวัตถุดิบ', 'ชื่อวัตถุดิบ', 'ยอดใช้', 'หน่วยใช้', 'ตัวแปลง',
  'หน่วยซื้อ', 'ราคา/หน่วยซื้อ', 'ต้นทุนต่อหน่วยเล็ก', 'ต้นทุนบรรทัด', 'แท็ก', 'ไม่ตัด BOM', 'ดึงมาจากเมนู',
];

/** ข้อความสรุปตัวกรอง เช่น "หมวดหมู่ = พิซซ่า · สถานะ = ใช้งาน · ค้นหา = (ไม่มี)" */
export function filterText({ search, group, status }) {
  return [
    `หมวดหมู่ = ${group || 'ทุกหมวดหมู่'}`,
    `สถานะ = ${status || 'ทุกสถานะ'}`,
    `ค้นหา = ${String(search || '').trim() || '(ไม่มี)'}`,
  ].join(' · ');
}

/** ชื่อไฟล์ — ใส่ตัวกรองที่ใช้ + วันที่ (พ.ศ.) ตัดอักขระที่ใช้ในชื่อไฟล์ไม่ได้ */
export function exportFileName({ search, group, status }, now = new Date()) {
  const parts = ['QCRD-เมนู', group, status, String(search || '').trim() && `ค้นหา-${String(search).trim()}`]
    .filter(Boolean)
    .map(s => String(s).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40));
  const d = `${now.getFullYear() + 543}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${parts.join('_')}_${d}.xlsx`;
}

/**
 * แถวของทั้งสองแผ่นงาน (ไม่รวมสองแถวบนสุด/หัวคอลัมน์)
 * @param menus   เมนูที่ผ่านตัวกรองแล้ว ตามลำดับบนหน้า
 * @param bom     { รหัสเมนู: { items: [...] } }
 * @param items   ทะเบียนวัตถุดิบ (ราคา/หน่วยซื้อ/หน่วยใช้)
 */
export function buildRows(menus, bom, items) {
  const itemBy = new Map((items || []).map(i => [keyOf(i.code), i]));
  const menuRows = [];
  const bomRows = [];
  for (const m of menus || []) {
    const lines = bom?.[m.code]?.items || [];
    const price = num(m.price);
    const cost = num(m.cost);
    const prev = num(m.prevCost);
    const yieldQty = num(m.yieldQty);
    menuRows.push([
      m.code, m.name, m.groupName || '', price,
      prev, m.prevCostAt ? dateLabel(m.prevCostAt) : '',
      cost, m.costAt ? dateLabel(m.costAt) : '',
      prev !== '' && prev > 0 && cost !== '' ? round(((cost - prev) / prev) * 100, 1) : '',
      price !== '' && price > 0 && cost !== '' ? round((cost / price) * 100, 1) : '',
      lines.length,
      yieldQty, m.yieldUnit || '',
      yieldQty !== '' && yieldQty > 0 && cost !== '' ? round(cost / yieldQty, 4) : '',
      m.status || 'ใช้งาน',
    ]);
    lines.forEach((r, i) => {
      const info = itemBy.get(keyOf(r.itemCode));
      const conv = num(r.converter) || 1000;
      const itemPrice = num(info?.price ?? r.itemPrice);
      const unitCost = itemPrice !== '' && conv ? itemPrice / conv : '';
      const qty = num(r.qty);
      bomRows.push([
        m.code, m.name, i + 1, r.itemCode, r.itemName || info?.name || '',
        qty, String(info?.useUnit || '').trim(), conv, info?.unit || '',
        itemPrice, unitCost === '' ? '' : round(unitCost, 6),
        unitCost === '' || qty === '' ? '' : round(qty * unitCost, 4),
        r.tag || '', r.noDeduct ? 'Y' : '', r.srcName || '',
      ]);
    });
  }
  return { menuRows, bomRows };
}

/* ───────────── เขียนไฟล์ ───────────── */

const HEAD_STYLE = {
  font: { bold: true, color: { rgb: 'FFFFFF' } },
  fill: { fgColor: { rgb: '1E3A5F' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: { bottom: { style: 'thin', color: { rgb: '94A3B8' } } },
};
const TITLE_STYLE = { font: { bold: true, sz: 13 } };
const INFO_STYLE = { font: { color: { rgb: '64748B' } }, fill: { fgColor: { rgb: 'FFF8E1' } } };

function sheetOf(XLSX, title, info, head, rows, numCols, widths) {
  const aoa = [[title], [info], head, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const last = head.length - 1;
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: last } }, { s: { r: 1, c: 0 }, e: { r: 1, c: last } }];
  ws['!cols'] = widths.map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: 2 + rows.length, c: last } }) };
  ws['!freeze'] = { xSplit: 2, ySplit: 3 };
  const at = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
  if (at(0, 0)) at(0, 0).s = TITLE_STYLE;
  if (at(1, 0)) at(1, 0).s = INFO_STYLE;
  head.forEach((_, c) => { if (at(2, c)) at(2, c).s = HEAD_STYLE; });
  // ตัวเลขแสดงทศนิยมสวย ๆ แต่เก็บค่าจริงไว้ (รวม/คำนวณต่อใน Excel ได้)
  rows.forEach((_, i) => numCols.forEach(([c, z]) => {
    const cell = at(3 + i, c);
    if (cell && cell.t === 'n') cell.z = z;
  }));
  return ws;
}

/** สร้างไฟล์แล้วสั่งดาวน์โหลด — โหลดแพ็กเกจ xlsx-js-style ตอนกดเท่านั้น */
export async function exportMenusToExcel({ menus, bom, items, filters }) {
  const XLSX = await import('xlsx-js-style');
  const now = new Date();
  const stamp = `${dateLabel(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)} `
    + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const { menuRows, bomRows } = buildRows(menus, bom, items);
  const info = `ตัวกรอง: ${filterText(filters)} — ${menuRows.length.toLocaleString()} เมนู`;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetOf(
    XLSX, `QC/RD — รายการเมนู · ส่งออกเมื่อ ${stamp}`, info, MENU_HEAD, menuRows,
    [[3, '#,##0.00'], [4, '#,##0.00'], [6, '#,##0.00'], [8, '0.0'], [9, '0.0'], [11, '#,##0.##'], [13, '#,##0.00##']],
    [12, 34, 16, 10, 12, 14, 10, 12, 9, 12, 10, 10, 10, 12, 12],
  ), 'เมนู');
  XLSX.utils.book_append_sheet(wb, sheetOf(
    XLSX, `QC/RD — สูตรเมนู (BOM) · ส่งออกเมื่อ ${stamp}`, `${info} · ${bomRows.length.toLocaleString()} บรรทัด`, BOM_HEAD, bomRows,
    [[5, '#,##0.####'], [7, '#,##0.##'], [9, '#,##0.00'], [10, '0.000000'], [11, '#,##0.0000']],
    [12, 30, 7, 12, 34, 10, 9, 9, 9, 12, 12, 12, 11, 9, 24],
  ), 'สูตร (BOM)');
  XLSX.writeFile(wb, exportFileName(filters, now));
  return { menus: menuRows.length, lines: bomRows.length };
}
