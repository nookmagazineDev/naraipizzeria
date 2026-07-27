// จัดซื้อ — แพลนสินค้า: อ่านชีท "plan" (ประวัติการสั่งของแต่ละสาขา)
// สเปรดชีตสต๊อกเดิม (ตัวเดียวกับ ข้อมูลนับสตอค/ข้อมูลเบิก) แท็บ plan
const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const GID = '571271047';

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };

export default async function handler(req, res) {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
    const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
    if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status}`);
    const rows = parseCSV(await r.text());
    if (rows.length < 2) return res.status(200).json({ status: 'success', data: [] });

    // หา column index จากชื่อหัวคอลัมน์ (กันชีทสลับตำแหน่งคอลัมน์ในอนาคต)
    const header = rows[0].map(h => h.trim());
    const col = name => header.indexOf(name);
    const c = {
      orderDate: col('วันที่สั่ง'),
      recordTime: col('เวลาบันทึก'),
      branch: col('สาขา'),
      outletId: col('รหัสสาขา'),
      orderNo: col('เลขที่ใบสั่ง'),
      seq: col('ลำดับ'),
      receiveDate: col('วันที่รับ'),
      itemId: col('itemId'),
      itemCode: col('รหัสสินค้า'),
      itemName: col('ชื่อสินค้า'),
      qty: col('จำนวน'),
      unit: col('หน่วย'),
      unitPrice: col('ราคา/หน่วย'),
      total: col('มูลค่ารวม'),
      type: col('ประเภท'),
      recordedBy: col('ผู้บันทึก'),
    };

    const data = rows.slice(1)
      .filter(r => r.some(x => String(x).trim()))
      .map(r => ({
        orderDate: (r[c.orderDate] || '').trim(),       // DD/MM/YYYY — วันที่คีย์ข้อมูล
        recordTime: (r[c.recordTime] || '').trim(),     // HH:MM:SS — เวลาคีย์ข้อมูล
        branch: (r[c.branch] || '').trim().toUpperCase(),
        outletId: (r[c.outletId] || '').trim(),
        orderNo: (r[c.orderNo] || '').trim(),
        seq: (r[c.seq] || '').trim(),
        receiveDate: (r[c.receiveDate] || '').trim(),   // YYYY-MM-DD — วันที่รับของ
        itemId: (r[c.itemId] || '').trim(),
        itemCode: (r[c.itemCode] || '').trim(),
        itemName: (r[c.itemName] || '').trim(),
        qty: num(r[c.qty]),
        unit: (r[c.unit] || '').trim(),
        unitPrice: num(r[c.unitPrice]),
        total: num(r[c.total]),
        type: (r[c.type] || '').trim(),
        recordedBy: (r[c.recordedBy] || '').trim(),
      }))
      .filter(r => r.itemCode);

    res.status(200).json({ status: 'success', data });
  } catch (err) {
    console.error('Plan API error:', err.message);
    res.status(502).json({ status: 'error', message: err.message });
  }
}
