// ยอดยกมา (Endding) = ยอดปิดรอบสิ้นเดือน "ล่าสุด" ของแต่ละสาขา แต่ละไอเทม
// อ่านจากชีท "ปิดรอบสิ้นเดือน" ในสมุดงานสต๊อก (แชร์แบบ anyone-with-link อ่านได้)
// คอลัมน์: A วันที่ปิดยอด | B สาขา | C รหัสสินค้า | D ชื่อสินค้า | E หน่วย
//          F ยอดคงเหลือสิ้นเดือน | G มูลค่า/หน่วย | H มูลค่ารวม | I ผู้บันทึก | J เวลาบันทึก
// คืนรูปแบบ: { status:'success', data: { <รหัสสินค้าตัด 0 นำหน้า>: { balance, date, unit, recordedAt } } }
const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const SHEET_NAME = 'ปิดรอบสิ้นเดือน';

// ดึงเฉพาะคอลัมน์ที่ใช้ (ตัดชื่อสินค้า/มูลค่า/ผู้บันทึกทิ้ง) เพื่อลดขนาดที่ต้องโหลดลงมาก
// ถ้า gviz ไม่รับ query ด้วยเหตุใดก็ตาม ถอยไปดึงทั้งชีทแล้วอ่านตามตำแหน่งคอลัมน์เดิม
const LAYOUTS = [
  { tq: 'select A,B,C,E,F,J', col: { date: 0, branch: 1, item: 2, unit: 3, balance: 4, recorded: 5 } },
  { tq: '', col: { date: 0, branch: 1, item: 2, unit: 4, balance: 5, recorded: 9 } },
];

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

function parseRows(text, col) {
  const rows = [];
  parseCSV(text).forEach((rw, idx) => {
    const date = toISODate(rw[col.date]);
    const branch = String(rw[col.branch] || '').trim().toLowerCase();
    const itemId = normalizeId(rw[col.item]);
    const balance = parseFloat(String(rw[col.balance] ?? '').replace(/,/g, ''));
    // ตัดหัวตาราง/แถวว่าง/แถวที่ยอดไม่ใช่ตัวเลข ออกไปในตัว
    if (!date || !branch || !itemId || isNaN(balance)) return;
    rows.push({
      date,
      branch,
      itemId,
      balance,
      unit: String(rw[col.unit] || '').trim(),
      recordedAt: String(rw[col.recorded] || '').trim(),
      sortKey: `${date}|${toSortableStamp(rw[col.recorded])}|${String(idx).padStart(6, '0')}`,
    });
  });
  return rows;
}

async function fetchClosingRows() {
  if (closingCache.rows && Date.now() - closingCache.at < 5 * 60 * 1000) return closingCache.rows;

  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;
  let lastError = null;

  for (const layout of LAYOUTS) {
    try {
      const r = await fetch(layout.tq ? `${base}&tq=${encodeURIComponent(layout.tq)}` : base,
        { cache: 'no-store', redirect: 'follow' });
      if (!r.ok) throw new Error(`ชีทปิดรอบสิ้นเดือน HTTP ${r.status}`);
      const rows = parseRows(await r.text(), layout.col);
      if (rows.length === 0) throw new Error('ไม่พบข้อมูลในชีทปิดรอบสิ้นเดือน');
      closingCache = { rows, at: Date.now() };
      return rows;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
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

    // ยอดปิดรอบเปลี่ยนแค่ตอนสิ้นเดือน — ให้ CDN ตอบซ้ำได้เลย ไม่ต้องวิ่งไป Google ทุกครั้ง
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
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
