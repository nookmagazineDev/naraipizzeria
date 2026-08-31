// จัดซื้อ — แพลนสินค้า: ประวัติการสั่งของแต่ละสาขา
//
// ทางหลัก (ตั้งแต่ ส.ค. 2026): MySQL myfbdata.orderd — ใบสั่งของจริงจากฝั่ง POS
//   ตัวเดียวกับที่แอปสั่งของของสาขา (narai-storefct) เขียนลง ข้อมูลจึงสดเท่ากันเป๊ะ
//   ก่อนหน้านี้หน้านี้อ่าน "สำเนา" (ชีท plan / dbo.stock_plan) ซึ่งต้องมีคนรันคัดลอกเอง
//   ของที่สาขาเพิ่งสั่งจึงไม่ขึ้นจนกว่าจะมีคนรัน — เป็นที่มาของอาการ "ไม่มีข้อมูลวันล่าสุด"
//
// ทางถอย (ตามลำดับ): dbo.stock_plan -> ชีท plan  พร้อมแนบ warning บอกว่าข้อมูลอาจไม่สด
//
// ⚠️ orderd ไม่มี index ตามวันที่ ต้องจำกัดช่วงเสมอ — ดูเหตุผลใน lib/planLive.js
//    GET /api/plan?from=YYYY-MM-DD&to=YYYY-MM-DD   (ไม่ส่งมา = 30 วันล่าสุด)
import { fetchPlanRows } from '../../lib/sheetsSheet.mjs';
import { usingSql, readPlan, sqlRoute } from '../../lib/sheetsSource';
import { readPlanLive, bangkokToday, shiftDays, isISODate } from '../../lib/planLive';

// คิวรีกวาดตารางใหญ่ ใช้เวลาได้ถึง ~10 วิ — ยาวกว่า default 10 วิของ Vercel
export const config = { maxDuration: 60 };

const DEFAULT_DAYS = 30;

/** ช่วงวันที่ที่จะดึง — ไม่ส่งมา/ส่งมาผิดรูปแบบ ให้ถอยมาเป็น 30 วันล่าสุด */
function resolveRange(query) {
  const today = bangkokToday();
  const to = isISODate(query.to) ? query.to : today;
  const from = isISODate(query.from) ? query.from : shiftDays(to, -(DEFAULT_DAYS - 1));
  return from <= to ? { from, to } : { from: to, to: from };
}

/** ทางถอยเดิม: SQL Server -> ชีท (ไม่มีช่วงวันที่ ตัวสำเนาเล็กพอที่จะดึงทั้งก้อน) */
async function readFallback() {
  if (usingSql()) {
    try {
      return { data: await readPlan(), source: 'sql' };
    } catch (err) {
      console.error(`Plan API: อ่าน SQL ไม่ได้ (${sqlRoute()}) — ถอยไปอ่านชีท:`, err.message);
      return { data: await fetchPlanRows(), source: 'sheet', sqlError: err.message };
    }
  }
  return { data: await fetchPlanRows(), source: 'sheet' };
}

export default async function handler(req, res) {
  const range = resolveRange(req.query);

  try {
    const data = await readPlanLive(range);
    return res.status(200).json({ status: 'success', source: 'pos', range, data });
  } catch (posErr) {
    console.error('Plan API: อ่านใบสั่งจาก POS ไม่ได้ — ถอยไปอ่านสำเนา:', posErr.message);

    try {
      const { data, source, sqlError } = await readFallback();
      return res.status(200).json({
        status: 'success', source, range, data,
        warning:
          `ต่อฐานใบสั่งของ POS ไม่ได้ (${posErr.message}) — ข้อมูลชุดนี้มาจาก` +
          `${source === 'sql' ? 'สำเนาใน SQL Server' : 'สำเนาในชีท'} ซึ่งอาจไม่ใช่ข้อมูลล่าสุด` +
          (sqlError ? ` (อ่าน SQL Server ไม่ได้ด้วย: ${sqlError})` : ''),
      });
    } catch (err) {
      console.error('Plan API error:', err.message);
      return res.status(502).json({
        status: 'error',
        message: `อ่านข้อมูลไม่ได้ทุกทาง — POS: ${posErr.message} · สำเนา: ${err.message}`,
      });
    }
  }
}
