// จัดซื้อ — แพลนสินค้า: ประวัติการสั่งของแต่ละสาขา
//
// ที่มาเดิม: ชีทสต๊อก 1xegMu… แท็บ plan (ตัวเดียวกับ ข้อมูลนับสตอค/ข้อมูลเบิก)
// ที่มาใหม่ (SHEETS_SOURCE=sql): dbo.stock_plan ในฐาน InventoryNarai
// ทั้งสองทางคืนโครงเดียวกันทุกช่อง — หน้า PlanList ไม่ต้องแก้อะไร
// อ่านฐานไม่ได้ถอยไปอ่านชีทให้ พร้อมแนบ warning ไปกับผลลัพธ์
import { fetchPlanRows } from '../../lib/sheetsSheet.mjs';
import { usingSql, readPlan, sqlRoute } from '../../lib/sheetsSource';

export default async function handler(req, res) {
  try {
    if (usingSql()) {
      try {
        return res.status(200).json({ status: 'success', source: 'sql', data: await readPlan() });
      } catch (err) {
        console.error(`Plan API: อ่าน SQL ไม่ได้ (${sqlRoute()}) — ถอยไปอ่านชีท:`, err.message);
        const data = await fetchPlanRows();
        return res.status(200).json({
          status: 'success', source: 'sheet', data,
          warning: `อ่านจาก SQL ไม่ได้ (${err.message}) — ข้อมูลชุดนี้มาจากชีท`,
        });
      }
    }
    res.status(200).json({ status: 'success', source: 'sheet', data: await fetchPlanRows() });
  } catch (err) {
    console.error('Plan API error:', err.message);
    res.status(502).json({ status: 'error', message: err.message });
  }
}
