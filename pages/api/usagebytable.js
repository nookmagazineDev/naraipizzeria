// "โต๊ะที่ขายเมนูนี้" — คำนวณจากบรรทัดขายจริงชุดเดียวกับ /api/usage-bom
//   GET /usagebytable?branch&outletId&startDate&endDate&menuCode(&menu) -> { status, data:[{table, qty}] }
// เดิม proxy ไปที่ Narai Usage API เครื่องเก่า (port 8787) ซึ่งใช้คนละฐานกับยอดใช้
// ทำให้ "ขาย" ระดับเมนูกับผลรวมของโต๊ะไม่ตรงกัน (เคยเจอเมนู P20 ต่างกันเท่าตัว)
// base URL / timeout / retry / CORS / ข้อความ error อยู่ที่ lib/upstream.mjs ชุดเดียวกับ Narai-branch
import { STORE_API_BASE, HEAVY_UPSTREAM_OPTS, fetchUpstream, applyCors, replyUpstreamError } from '../../lib/upstream.mjs';

// ปลายทางคำนวณข้ามหลายวันได้นาน — ให้เวลาฟังก์ชันเท่ากับ API พี่น้อง (ดู HEAVY_UPSTREAM_OPTS)
export const config = { maxDuration: 60 };

const BRANCH_OUTLET = {
  sjp: 7, zjp: 7, crm: 12, xcm: 19, slr: 37, sum: 51, xum: 59, scs: 61,
  smp: 63, xsb: 67, xhh: 72, hrs: 78, clk: 79, p90: 80, hps: 109, zbw: 400,
  zpt: 401, npt: 500, wrm: 501, wmt: 503, ipr: 904, zk3: 906,
};

// โต๊ะ/ไอเทมที่ไม่นับ (กติกาเดียวกับ /api/usage-bom)
const EXCLUDE_TABLES = [600];
const EXCLUDE_ITEMS = [206001, 290016];
const isExcludedItem = c => {
  const i = parseInt(c);
  return EXCLUDE_ITEMS.includes(i) || (i >= 500002 && i <= 500026);
};

const normalizeId = id => String(id ?? '').replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const { branch, startDate, endDate, menu, menuCode, outletId } = req.query;
  if (!branch || !startDate || !endDate || (!menu && !menuCode)) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่, และเมนูไม่ครบถ้วน' });
  }
  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: [] });
  }
  const oid = outletId || BRANCH_OUTLET[branchKey];
  if (!oid) return res.status(400).json({ status: 'error', message: `ไม่รู้จักสาขา ${branch}` });

  // จับคู่เมนูด้วยรหัส POS เป็นหลัก ถ้าไม่มีค่อยเทียบชื่อ (เผื่อของเก่าที่ส่งมาแต่ชื่อ)
  const wantCode = menuCode ? normalizeId(menuCode) : '';
  const wantName = String(menu || '').trim().toLowerCase();

  try {
    const params = new URLSearchParams({ start: startDate, end: endDate, outlet: String(oid) });
    // ชุดแถวเดียวกับ /api/usage-bom — คำนวณข้ามหลายวัน ต้องใช้ชุด timeout/retry ของงานหนัก
    const r = await fetchUpstream(`${STORE_API_BASE}/ctranbetweendate?${params.toString()}`, HEAVY_UPSTREAM_OPTS);
    if (!r.ok) throw new Error(`เซิร์ฟเวอร์ที่ออฟฟิศตอบผิดพลาด (HTTP ${r.status})`);
    const dj = await r.json();
    const rows = Array.isArray(dj) ? dj : dj.data || [];

    const byTable = {};
    rows.forEach(row => {
      if (row.void) return;
      if (EXCLUDE_TABLES.includes(parseInt(row.tableID))) return;
      if (isExcludedItem(row.itemCode)) return;

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
    return replyUpstreamError(res, error, 'usagebytable');
  }
}
