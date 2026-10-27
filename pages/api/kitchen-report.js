// QC/RD › รายงานการผลิต — ข้อมูลชุดเดียวกับหน้า "รายงานการผลิต" ของครัวกลาง (ดู lib/kitchenReport.js)
//
//   POST /api/kitchen-report { action, ...payload }
//        action = getProductionReport | getMaterialIssues (อ่านอย่างเดียว — ชื่ออื่นได้ 400)
//        → { status:'success', ...data จาก office-server }
//   GET  /api/kitchen-report?menus=1[&refresh=1]   เมนู QC/RD (ผลผลิต/ต้นทุนต่อสูตร) → { status, menus, loadedAt }
//   GET  /api/kitchen-report?recipe=<รหัสเมนู>     สูตรของเมนูหนึ่งตัว → { status, menu, lines }
import { callKitchenReport, kitchenMenuList, kitchenMenuRecipe } from '../../lib/kitchenReport';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      const { action, ...payload } = req.body || {};
      if (!action) return res.status(400).json({ status: 'error', message: 'ไม่ระบุคำสั่ง (action)' });
      const data = await callKitchenReport(String(action), payload);
      return res.status(200).json({ status: 'success', ...(data || {}) });
    }

    if (req.method === 'GET') {
      if (String(req.query.menus || '') === '1') {
        const out = await kitchenMenuList({ refresh: String(req.query.refresh || '') === '1' });
        return res.status(200).json({ status: 'success', ...out });
      }
      const code = String(req.query.recipe || '').trim();
      if (code) {
        const out = await kitchenMenuRecipe(code);
        if (!out) return res.status(404).json({ status: 'error', message: `ไม่พบเมนูรหัส ${code} ใน QC/RD` });
        return res.status(200).json({ status: 'success', ...out });
      }
      return res.status(400).json({ status: 'error', message: 'ต้องส่ง ?menus=1 หรือ ?recipe=<รหัสเมนู>' });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  } catch (err) {
    console.error('/api/kitchen-report:', err.message);
    return res.status(err.status === 400 ? 400 : 500).json({ status: 'error', message: err.message });
  }
}
