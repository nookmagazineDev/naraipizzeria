// หลังบ้านของหน้า "รายงานจากซัพหน้าสาขา" (ACC)
//
// อ่านชีท "ต้นทุนจากsup" (สเปรดชีต 1YXOaA…) — ชีทที่หน้า "กรอกรายจ่าย" ของ Narai-branch
// เขียนลงผ่าน Apps Script action saveSupCost (สาขากรอกของที่ซื้อจากซัพพลายเออร์/ผักหน้าร้าน)
// คอลัมน์: [0]วันที่ [1]สาขา [2]รหัส [3]ชื่อรายการ [4]หน่วย [5]จำนวน [6]ราคา/หน่วย [7]มูลค่ารวม [8]ผู้บันทึก
//
// GET ?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=xxx]
//   -> { status, data: [{ date, branch, code, name, unit, qty, price, amount, recorder, cat }] }
// cat = 'veg' (ผัก, ผลไม้) หรือ 'sup' (ซัพพลายเออร์) แยกตามช่วงรหัสเดียวกับหน้ากรอกของสาขา
//
// ชีทนี้ยังไม่ได้ย้ายเข้า SQL (Narai-branch ก็ยังอ่านจากชีทเหมือนกัน — ดู api/stockcount.js ฝั่งนั้น)
// ชีทต้องตั้งแชร์ "ใครมีลิงก์ก็ดูได้" ไว้แล้ว (หน้าสรุปกำไรของสาขาใช้อยู่)
const SHEET_ID = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';
const SHEET_NAME = 'ต้นทุนจากsup';

// ช่วงรหัสหมวด "ผัก, ผลไม้" — ต้องตรงกับ VEG_CODE_MIN/MAX ใน Narai-branch src/pages/ExpenseEntry.jsx
const VEG_CODE_MIN = 11090003;
const VEG_CODE_MAX = 11090999;

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const normCode = (v) => String(v == null ? '' : v).replace(/\.0+$/, '').replace(/^0+/, '').trim();

// วันที่จาก gviz: "Date(2026,9,5)" (เดือนเริ่ม 0) หรือข้อความ YYYY-MM-DD / DD/MM/YYYY
function cellYmd(c) {
  if (!c) return '';
  const s = String(c.v == null ? '' : c.v).trim();
  let m = s.match(/Date\((\d+),(\d+),(\d+)/);
  if (m) return `${m[1]}-${String(+m[2] + 1).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const f = String(c.f == null ? '' : c.f).trim();
  m = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

const num = (c) => {
  const v = c?.v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const str = (c) => (c?.v == null ? '' : String(c.v).trim());

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'GET only' });
  }
  const { start, end } = req.query;
  const branch = String(req.query.branch || '').toLowerCase().trim();
  if (!isYmd(start) || !isYmd(end)) {
    return res.status(400).json({ status: 'error', message: 'ระบุวันที่เริ่มต้น/สิ้นสุดไม่ถูกต้อง (YYYY-MM-DD)' });
  }
  if (start > end) {
    return res.status(400).json({ status: 'error', message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
  }

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let text;
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`Google Sheet ตอบ ${r.status}`);
      text = await r.text();
    } finally {
      clearTimeout(timer);
    }
    if (text.trimStart().startsWith('<')) {
      throw new Error('อ่านชีท "ต้นทุนจากsup" ไม่ได้ (ต้องตั้งแชร์ "ใครมีลิงก์ก็ดูได้")');
    }
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a === -1 || b === -1) throw new Error('รูปแบบข้อมูลจาก Google Sheet ไม่ถูกต้อง');
    const parsed = JSON.parse(text.substring(a, b + 1));
    if (parsed.status === 'error') {
      throw new Error(parsed.errors?.[0]?.detailed_message || parsed.errors?.[0]?.message || 'Google Sheet แจ้งข้อผิดพลาด');
    }

    const data = [];
    for (const row of parsed.table?.rows || []) {
      const c = row.c || [];
      const date = cellYmd(c[0]);
      if (!date || date < start || date > end) continue; // แถวหัวตาราง/แถวว่างหลุดไปตรงนี้เอง
      const br = str(c[1]).toLowerCase();
      if (!br || (branch && br !== branch)) continue;
      const code = normCode(c[2]?.v);
      const qty = num(c[5]);
      const price = num(c[6]);
      // มูลค่ารวมในชีทเป็นตัวหลัก (Apps Script ปัดเศษไว้แล้ว) ช่องว่างค่อยคำนวณเอง
      const amount = c[7]?.v != null && c[7].v !== '' ? num(c[7]) : Math.round(qty * price * 100) / 100;
      const n = parseInt(code, 10) || 0;
      data.push({
        date,
        branch: br,
        code,
        name: str(c[3]) || '(ไม่ระบุชื่อ)',
        unit: str(c[4]),
        qty,
        price,
        amount,
        recorder: str(c[8]),
        cat: n >= VEG_CODE_MIN && n <= VEG_CODE_MAX ? 'veg' : 'sup',
      });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ status: 'success', data });
  } catch (err) {
    console.error('sup-cost error:', err);
    const msg = err.name === 'AbortError' ? 'Google Sheet ตอบช้าเกินไป ลองใหม่อีกครั้ง' : err.message;
    return res.status(502).json({ status: 'error', message: msg });
  }
}
