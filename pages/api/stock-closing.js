// ยอดยกมา (Endding) = ยอดปิดรอบสิ้นเดือน "ล่าสุด" ของแต่ละสาขา แต่ละไอเทม
// อ่านจากชีท "ปิดรอบสิ้นเดือน" ในสมุดงานสต๊อก (แชร์แบบ anyone-with-link อ่านได้)
// คอลัมน์: A วันที่ปิดยอด | B สาขา | C รหัสสินค้า | D ชื่อสินค้า | E หน่วย
//          F ยอดคงเหลือสิ้นเดือน | G มูลค่า/หน่วย | H มูลค่ารวม | I ผู้บันทึก | J เวลาบันทึก
// คืนรูปแบบ: { status:'success', data: { <รหัสสินค้าตัด 0 นำหน้า>: { balance, date, unit, recordedAt } } }
const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const SHEET_NAME = 'ปิดรอบสิ้นเดือน';

const COL_DATE = 0;      // A วันที่ปิดยอด
const COL_BRANCH = 1;    // B สาขา
const COL_ITEM = 2;      // C รหัสสินค้า
const COL_UNIT = 4;      // E หน่วย
const COL_BALANCE = 5;   // F ยอดคงเหลือสิ้นเดือน
const COL_RECORDED = 9;  // J เวลาบันทึก

const normalizeId = id => String(id ?? '').replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

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

const pad2 = n => String(n).padStart(2, '0');

// รับได้ทั้ง 'YYYY-MM-DD' และ 'DD/MM/YYYY' (พร้อมเวลาต่อท้ายหรือไม่ก็ได้) -> 'YYYY-MM-DD'
function toISODate(value) {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return '';
}

// 'DD/MM/YYYY HH:mm:ss' -> 'YYYY-MM-DD HH:mm:ss' สำหรับใช้เรียงลำดับแบบ string
function toSortableStamp(value) {
  const s = String(value || '').trim();
  const date = toISODate(s);
  if (!date) return '';
  const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return `${date} ${t ? `${pad2(t[1])}:${t[2]}:${t[3] || '00'}` : '00:00:00'}`;
}

// แถวปิดรอบทั้งชีท (cache 5 นาที — สาขาไหนเรียกก็ใช้ชุดเดียวกัน)
let closingCache = { rows: null, at: 0 };

async function fetchClosingRows() {
  if (closingCache.rows && Date.now() - closingCache.at < 5 * 60 * 1000) return closingCache.rows;

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`ชีทปิดรอบสิ้นเดือน HTTP ${r.status}`);

  const rows = [];
  parseCSV(await r.text()).forEach((rw, idx) => {
    const date = toISODate(rw[COL_DATE]);
    const branch = String(rw[COL_BRANCH] || '').trim().toLowerCase();
    const itemId = normalizeId(rw[COL_ITEM]);
    const balance = parseFloat(String(rw[COL_BALANCE] ?? '').replace(/,/g, ''));
    // ตัดหัวตาราง/แถวว่าง/แถวที่ยอดไม่ใช่ตัวเลข ออกไปในตัว
    if (!date || !branch || !itemId || isNaN(balance)) return;
    rows.push({
      date,
      branch,
      itemId,
      balance,
      unit: String(rw[COL_UNIT] || '').trim(),
      recordedAt: String(rw[COL_RECORDED] || '').trim(),
      sortKey: `${date}|${toSortableStamp(rw[COL_RECORDED])}|${String(idx).padStart(6, '0')}`,
    });
  });

  closingCache = { rows, at: Date.now() };
  return rows;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch } = req.query;
  if (!branch) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขาไม่ครบถ้วน' });
  }

  const branchKey = String(branch).trim().toLowerCase();
  if (branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: {} });
  }

  try {
    const rows = await fetchClosingRows();

    // เก็บเฉพาะรายการล่าสุดของแต่ละไอเทม: เรียงตาม วันที่ปิดยอด > เวลาบันทึก > ลำดับแถว
    const latest = {};
    rows.forEach(row => {
      if (row.branch !== branchKey) return;
      const cur = latest[row.itemId];
      if (!cur || row.sortKey > cur.sortKey) latest[row.itemId] = row;
    });

    const data = {};
    let latestDate = '';
    Object.entries(latest).forEach(([itemId, row]) => {
      data[itemId] = {
        balance: Number(row.balance.toFixed(2)),
        date: row.date,
        unit: row.unit,
        recordedAt: row.recordedAt,
      };
      if (row.date > latestDate) latestDate = row.date;
    });

    return res.status(200).json({
      status: 'success',
      data,
      meta: { branch: branchKey, items: Object.keys(data).length, latestDate },
    });
  } catch (error) {
    console.error('stock-closing error:', error.message);
    return res.status(502).json({ status: 'error', message: error.message });
  }
}
