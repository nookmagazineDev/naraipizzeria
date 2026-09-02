// ข้อมูลปิดรอบเดือน — หน้า STOCK → "ดูข้อมูลปิดรอบเดือน" (ดูอย่างเดียว)
//
// ที่มา: dbo.stock_month_end ในฐาน InventoryNarai (ตารางที่มีอยู่ในฐานอยู่แล้ว)
//   ⚠️ คนละตัวกับ dbo.stock_closing ที่ /api/stock-closing ใช้เป็น "ยอดยกมา" ของหน้านับสต๊อก
//      ตัวนั้นย้ายมาจากชีท "ปิดรอบสิ้นเดือน" และคัดเฉพาะแถวล่าสุดของแต่ละไอเทม
//      ส่วนหน้านี้แสดงแถวปิดรอบของ "เดือนที่เลือก" ตามที่เก็บไว้จริงทั้งหมด
//
//   GET /api/stock-month-end?view=summary          -> สรุปรายสาขา: ปิดยอดล่าสุดถึงวันไหน (หน้าแรกของเมนู)
//   GET /api/stock-month-end                       -> เดือนล่าสุดที่มีข้อมูล ทุกสาขา
//   GET /api/stock-month-end?month=2026-08         -> เดือนที่ระบุ ทุกสาขา
//   GET /api/stock-month-end?month=2026-08&branch=CRM  -> เฉพาะสาขานั้น
//
// คืน: { status:'success', data: { month, months[], branches[], rows[], layout }, meta }
//   rows = [{ date, branch, itemCode, itemKey, itemName, unit, balance, unitValue, totalValue,
//             recordedBy, recordedAt }]  — ช่องที่ตารางไม่มีคอลัมน์ให้จะเป็นค่าว่าง/null
//   layout = คอลัมน์จริงในตาราง และคอลัมน์ไหนถูกใช้เป็นช่องอะไร (ไว้ไล่ดูเวลาชื่อไม่ตรง)
//
// ไม่มีทางถอยไปชีท — ข้อมูลชุดนี้ไม่เคยอยู่ในชีท ต่อฐานไม่ได้ = ตอบ error ให้หน้าเว็บขึ้นข้อความ
import { readMonthEnd, readMonthEndSummary, sqlRoute } from '../../lib/sheetsSource';

// ต่อ SQL ตรงไม่ติดจะรอ 15 วิ ก่อนถอยไปเรียก host API (ซึ่งรอได้อีก 20 วิ) — เกินเพดาน
// ค่าเริ่มต้น 10 วิของ Vercel ไปไกล ไม่ยืดตรงนี้จะโดนตัดกลางทางแล้วขึ้นเป็น error คนละเรื่อง
export const config = { maxDuration: 60 };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'GET เท่านั้น' });
  }

  const month = str(req.query.month);
  const branch = str(req.query.branch);
  const view = str(req.query.view).toLowerCase();

  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ status: 'error', message: `เดือน "${month}" ต้องเป็นรูปแบบ YYYY-MM เช่น 2026-08` });
  }

  try {
    // หน้าแรกของเมนูถามแค่ "สาขาไหนปิดยอดถึงวันไหนแล้ว" — สรุปที่ฐาน ไม่ต้องลากรายไอเทมมาทั้งเดือน
    if (view === 'summary') {
      const data = await readMonthEndSummary();
      res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
      return res.status(200).json({
        status: 'success',
        data,
        meta: { view: 'summary', branches: data.branches.length, latestDate: data.latestDate, source: data.source },
      });
    }

    const data = await readMonthEnd({ month, branch: branch.toLowerCase() === 'all' ? '' : branch });

    // ปิดรอบเดือนที่ปิดไปแล้วไม่เปลี่ยนอีก — ให้ CDN ตอบซ้ำได้สักพัก แต่ยังสั้นพอให้เดือนที่เพิ่งปิดขึ้นเร็ว
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({
      status: 'success',
      data,
      meta: {
        month: data.month,
        branch: branch || 'all',
        rows: data.rows.length,
        months: data.months.length,
        // ทางที่ใช้ได้จริง (ต่อ SQL ตรง หรือถอยมา host API) — ไม่ใช่ทางที่ตั้งใจจะใช้
        source: data.source || sqlRoute(),
      },
    });
  } catch (error) {
    console.error('stock-month-end error:', error.message);
    return res.status(error.badRequest ? 400 : 502).json({ status: 'error', message: error.message });
  }
}
