// ยอดยกมาเดือนที่แล้ว ของหน้านับสต๊อก (โหมดดูอย่างเดียวของออฟฟิศ)
//
// = ยอดปิดรอบสิ้นเดือน "ของเดือนก่อน" จาก dbo.stock_month_end — ตารางเดียวกับที่หน้าสาขา
//   (Narai-branch: /api/stockcount?closingprev=1) และหน้า "ดูข้อมูลปิดรอบเดือน" อ่าน
//
// เดิมอ่าน dbo.stock_closing ซึ่งเป็นสำเนาชีท "ปิดรอบสิ้นเดือน" ที่ย้ายเข้ามาครั้งเดียว
// ไม่มีใครเขียนเพิ่มแล้ว (สาขาปิดยอดลง stock_month_end) ยอดยกมาฝั่งออฟฟิศเลยค้างที่
// "ปิดรอบ 2026-08-01" ขณะที่หน้าสาขาขึ้นรอบล่าสุด — ตัวเลขสองหน้าจึงไม่ตรงกัน
//
// กติกาเลือกแถว (ต้องตรงกับ closingMonthValue ใน api/stockcount.js ของ Narai-branch):
//   - เดือนเป้าหมาย = เดือนก่อนเดือนปัจจุบัน (เวลาไทย)
//   - ปิดยอดวันที่ 1–5 ของเดือนไหน = ยอดปิดของ "เดือนก่อนหน้า" (สาขามักปิดช้าไม่กี่วัน)
//   - สินค้าเดียวกันหลายแถว แถวที่บันทึกทีหลังชนะ
// ⚠️ ไม่ใช่กติกา 1–10 วันของหน้า "ดูข้อมูลปิดรอบเดือน" (cycleMonth) — อันนั้นใช้จัดกลุ่มรายงาน
//    อันนี้ต้องให้เลขตรงกับหน้าสาขาเป๊ะ จึงยึดกติกาของฝั่งสาขา
//
// คืนรูปแบบ: { status:'success', data: { <รหัสสินค้าตัด 0 นำหน้า>: { balance, date } }, meta }
// อ่านไม่ได้ = data ว่าง + warning (หน้าเว็บจะถอยไปใช้ยอดนับล่าสุดของเดือนก่อนเหมือนหน้าสาขา)
import { readMonthEnd } from '../../lib/sheetsSource';

export const config = { maxDuration: 60 };

// ร้านเดียวกันที่บันทึกไว้หลายรหัส (กติกาเดียวกับ BRANCH_ALIAS_GROUPS ของ Narai-branch)
const BRANCH_ALIAS_GROUPS = [['zjp', 'sjp']];
const branchGroup = (b) => BRANCH_ALIAS_GROUPS.find((g) => g.includes(b)) || [b];

const pad2 = (n) => String(n).padStart(2, '0');
const normCode = (v) => String(v ?? '').replace(/\.0+$/, '').replace(/^0+/, '').trim().toLowerCase();

/** 'YYYY-MM' บวก/ลบเดือน */
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** เดือนปัจจุบันตามเวลาไทย 'YYYY-MM' (เครื่องที่รันอาจตั้งเป็น UTC) */
function thaiThisMonth() {
  const t = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}`;
}

/** วันที่ปิดยอด 'YYYY-MM-DD' -> เดือนที่ยอดนั้นเป็นตัวแทน (วันที่ 1–5 = เดือนก่อน) */
function closingMonthOf(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!m) return '';
  const ym = `${m[1]}-${m[2]}`;
  return Number(m[3]) <= 5 ? shiftMonth(ym, -1) : ym;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const branchKey = String(req.query.branch || '').trim().toLowerCase();
  if (!branchKey) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขาไม่ครบถ้วน' });
  }
  if (branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: {} });
  }

  const target = shiftMonth(thaiThisMonth(), -1);

  // readMonthEnd จัดแถวเป็น "รอบ" ด้วยกติกา 1–10 วัน — หน้าต่างของกติกา 1–5 วันสำหรับเดือน target
  // (วันที่ 6 ของ target ถึงวันที่ 5 ของเดือนถัดไป) อยู่ในรอบ target-1 กับ target รวมกันเสมอ
  // จึงดึงสองรอบนั้นมาแล้วคัดใหม่ด้วยกติกาของฝั่งสาขา
  const cycles = [shiftMonth(target, -1), target];
  const jobs = [];
  for (const b of branchGroup(branchKey)) {
    for (const month of cycles) jobs.push(readMonthEnd({ month, branch: b }));
  }
  const settled = await Promise.allSettled(jobs);
  const failed = settled.filter((s) => s.status === 'rejected');

  const data = {};
  let latestDate = '';
  // เรียงตามลำดับที่ดึงมา: รอบเก่าก่อน และในรอบเดียวกันฐานเรียงตามเลขที่แถวมาให้แล้ว
  // แถวหลังทับแถวหน้า = แถวที่บันทึกทีหลังชนะ
  settled.forEach((s) => {
    if (s.status !== 'fulfilled') return;
    (s.value?.rows || []).forEach((r) => {
      if (closingMonthOf(r.date) !== target) return;
      const code = normCode(r.itemKey || r.itemCode);
      if (!code) return;
      data[code] = { balance: Number(Number(r.balance || 0).toFixed(2)), date: r.date };
      if (r.date > latestDate) latestDate = r.date;
    });
  });

  const meta = { branch: branchKey, month: target, items: Object.keys(data).length, latestDate, source: 'stock_month_end' };

  if (failed.length === settled.length) {
    const reason = failed[0]?.reason?.message || 'ไม่ทราบสาเหตุ';
    console.error('stock-closing: อ่าน stock_month_end ไม่ได้:', reason);
    return res.status(200).json({
      status: 'success',
      data: {},
      meta,
      warning: `อ่านยอดปิดรอบสิ้นเดือนไม่ได้ (${reason}) — ช่องยอดยกมาใช้ยอดนับล่าสุดของเดือนก่อนแทน`,
    });
  }

  // ไม่ให้ตัวกลาง (Cloudflare tunnel/CDN) เก็บคำตอบ — เคยตั้ง public s-maxage + stale-while-revalidate 1 ชม.
  // พอเปลี่ยนที่มาของข้อมูล หน้าเว็บยังได้คำตอบชุดเก่า (ยอดปิดรอบ 2026-08-01 จาก stock_closing) ค้างอยู่
  // และวันที่ 1–5 ที่สาขาเพิ่งปิดยอด ออฟฟิศก็จะเห็นช้าไปเป็นชั่วโมง
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    status: 'success',
    data,
    meta,
    ...(failed.length ? { warning: `อ่านยอดปิดรอบได้ไม่ครบ (${failed[0].reason?.message || ''}) — บางรายการอาจใช้ยอดนับของเดือนก่อนแทน` } : {}),
  });
}
