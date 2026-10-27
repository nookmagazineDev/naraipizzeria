// ไฟล์ Excel ของรายงานการผลิต — สำเนา exportReportExcel จาก narai-storefct/src/services/kitchenExport.js
// (หน้า QC/RD › รายงานการผลิต ออกไฟล์หน้าตาเดียวกับหน้าของครัวกลาง)

/**
 * รายงานการผลิตเป็น Excel — หน้า QC/RD › รายงานการผลิต (components/QcRdProduction.jsx)
 * หนึ่งชีทต่อหนึ่งตาราง: หัวรายงาน (ชื่อ + ช่วงวันที่ + พิมพ์เมื่อ) → หัวตาราง → แถวข้อมูล → แถวรวม (ถ้ามี)
 * ตัวเลขเป็นตัวเลขจริงในเซลล์ (คำนวณ/กรองต่อใน Excel ได้) จัดรูปแบบด้วย z ของแต่ละคอลัมน์
 *
 * @param {object} p
 * @param {string} p.filename  ไม่ต้องใส่ .xlsx
 * @param {string[]} p.meta    บรรทัดใต้ชื่อรายงาน (ช่วงวันที่ · ดูตาม · เมนู)
 * @param {Array<{ name: string, title: string, cols: Array<{ label: string, wch?: number, z?: string }>,
 *   rows: Array<Array<string|number|null>>, total?: Array<string|number|null> }>} p.sheets
 */
export async function exportReportExcel({ filename, meta = [], sheets }) {
  const mod = await import('xlsx-js-style');
  const XLSX = mod.default || mod;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const printedAt = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const thin = { style: 'thin', color: { rgb: '999999' } };
  const border = { top: thin, bottom: thin, left: thin, right: thin };

  const wb = XLSX.utils.book_new();
  for (const sh of sheets) {
    const n = sh.cols.length;
    const data = [[sh.title], ...meta.map((m) => [m]), [`พิมพ์เมื่อ: ${printedAt}`], []];
    const headRow = data.length;
    data.push(sh.cols.map((c) => c.label));
    for (const r of sh.rows) data.push(r.map((v) => (v === null || v === undefined || Number.isNaN(v) ? '' : v)));
    const lastRow = data.length - 1;
    if (sh.total) data.push(sh.total.map((v) => (v === null || v === undefined || Number.isNaN(v) ? '' : v)));
    const totalRow = sh.total ? data.length - 1 : -1;

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = sh.cols.map((c) => ({ wch: c.wch || 12 }));
    ws['!merges'] = data.slice(0, headRow - 1).map((_, r) => ({ s: { r, c: 0 }, e: { r, c: n - 1 } }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headRow, c: 0 }, e: { r: Math.max(lastRow, headRow), c: n - 1 } }) };
    for (let r = 0; r < data.length; r++) {
      for (let c = 0; c < n; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const inTable = r >= headRow && (r <= lastRow || r === totalRow);
        if (!ws[ref] && inTable) ws[ref] = { t: 's', v: '' };
        const cell = ws[ref];
        if (!cell) continue;
        if (r === 0) cell.s = { font: { bold: true, sz: 14 } };
        else if (r < headRow) cell.s = { font: { sz: 10, color: { rgb: '555555' } } };
        else if (r === headRow) {
          cell.s = {
            font: { bold: true, sz: 10 }, border, fill: { fgColor: { rgb: 'E8E8E8' } },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          };
        } else {
          const z = sh.cols[c].z;
          if (z && cell.t === 'n') cell.z = z;
          cell.s = {
            ...(z && cell.t === 'n' ? { numFmt: z } : {}), // xlsx-js-style อ่านรูปแบบตัวเลขจาก s.numFmt (z = ของ SheetJS)
            font: { sz: 10, bold: r === totalRow },
            border,
            alignment: { horizontal: cell.t === 'n' ? 'right' : 'left', vertical: 'center' },
            ...(r === totalRow ? { fill: { fgColor: { rgb: 'F3F3F3' } } } : {}),
          };
        }
      }
    }
    ws['!rows'] = [];
    ws['!rows'][headRow] = { hpt: 30 };
    XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
  }
  XLSX.writeFile(wb, `${filename}.xlsx`);
}
