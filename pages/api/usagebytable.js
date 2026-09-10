import { branchOutletMap } from '../../lib/branchRegistry';
// โต๊ะ/ไอเทมที่ไม่นับ ต้องเป็นชุดเดียวกับ /api/usage-bom เป๊ะ ๆ ไม่งั้นผลรวมรายโต๊ะ
// จะไม่เท่ากับยอด "ขาย" ของเมนูนั้นอีก — กติกาอยู่ที่เดียวใน lib/usageRules.js
import { normalizeId, countableSaleRow } from '../../lib/usageRules';
// "โต๊ะที่ขายเมนูนี้" — คำนวณจากบรรทัดขายจริงชุดเดียวกับ /api/usage-bom
//   GET /usagebytable?branch&outletId&startDate&endDate&menuCode(&menu) -> { status, data:[{table, qty}] }
// เดิม proxy ไปที่ Narai Usage API เครื่องเก่า (port 8787) ซึ่งใช้คนละฐานกับยอดใช้
// ทำให้ "ขาย" ระดับเมนูกับผลรวมของโต๊ะไม่ตรงกัน (เคยเจอเมนู P20 ต่างกันเท่าตัว)
const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

// รหัสสาขา -> outletID อ่านจากทะเบียนสาขา (dbo.hr_branch) ผ่าน lib/branchRegistry.js
// เพิ่มสาขาใหม่ที่หน้า HR > จัดการสาขา แล้วไฟล์นี้รู้จักเองทันที ไม่ต้องมาแก้โค้ด


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch, startDate, endDate, menu, menuCode, outletId } = req.query;
  if (!branch || !startDate || !endDate || (!menu && !menuCode)) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่, และเมนูไม่ครบถ้วน' });
  }
  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: [] });
  }
  const oid = outletId || (await branchOutletMap())[branchKey];
  if (!oid) return res.status(400).json({ status: 'error', message: `ไม่รู้จักสาขา ${branch}` });

  // จับคู่เมนูด้วยรหัส POS เป็นหลัก ถ้าไม่มีค่อยเทียบชื่อ (เผื่อของเก่าที่ส่งมาแต่ชื่อ)
  const wantCode = menuCode ? normalizeId(menuCode) : '';
  const wantName = String(menu || '').trim().toLowerCase();

  try {
    const r = await fetch(`${STORE_API}/ctranbetweendate?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}&outlet=${encodeURIComponent(oid)}`);
    if (!r.ok) throw new Error(`host API HTTP ${r.status}`);
    const dj = await r.json();
    const rows = Array.isArray(dj) ? dj : dj.data || [];

    const byTable = {};
    rows.forEach(row => {
      if (!countableSaleRow(row)) return;

      const code = String(row.itemCode ?? '').trim();
      const name = String(row.nameThai || row.nameEng || '').trim().toLowerCase();
      const hit = wantCode ? normalizeId(code) === wantCode : name === wantName;
      if (!hit) return;

      // ไม่กรองวันซ้ำอีกชั้น — ใช้ชุดแถวเดียวกับ /api/usage-bom (host กรองด้วย PostTime แล้ว)
      // ถ้ากรองต่างกันแม้แต่นิดเดียว ผลรวมของโต๊ะจะไม่เท่ากับ "ขาย" ของเมนูอีก
      const qty = parseFloat(row.quantity) || 0;
      if (!qty) return;
      const table = String(row.tableID ?? '-').trim() || '-';
      byTable[table] = (byTable[table] || 0) + qty;
    });

    const data = Object.entries(byTable)
      .map(([table, qty]) => ({ table, qty: Number(qty.toFixed(2)) }))
      .sort((a, b) => b.qty - a.qty);

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('usagebytable error:', error);
    return res.status(502).json({ status: 'error', message: error.message });
  }
}
