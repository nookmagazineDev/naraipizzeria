// ยอดใช้วัตถุดิบ = ยอดขายจริง × สูตร BOM  (แทนการอ่านชีท UsageHistory ที่ต้องรออัปเดต)
// สูตร: ใช้ไป(หน่วยซื้อ) = จำนวนเมนูที่ขาย × ยอดใช้ต่อจาน(BOM คอลัมน์ F) ÷ ตัวแปลงหน่วย(คอลัมน์ H)
//   เช่น สันคอหมูสไลด์ 1 จาน ใช้ 33 กรัม, ตัวแปลง 1000 → 0.033 กก.
// สูตรอ่านจากแท็บ BOM ของชีท QC/RD ผ่าน lib/qcrdSheet.js — ตัวเดียวกับที่หน้า QC/RD ใช้
// จึงเห็นสูตรที่แก้จากหน้า QC/RD ทันที (ช้าสุด 10 นาทีตามแคช) และเคารพธง "ไม่ตัด BOM" ด้วย
// คืนรูปแบบเดียวกับ /api/usage: { normalizedItemCode: { total, details: { 'YYYY-MM-DD': qty } } }

import { fetchQcrdSheet, TRUTHY, DEFAULT_CONVERTER } from '../../lib/qcrdSheet';

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

const BRANCH_OUTLET = {
  sjp: 7, zjp: 7, crm: 12, xcm: 19, slr: 37, sum: 51, xum: 59, scs: 61,
  smp: 63, xsb: 67, xhh: 72, hrs: 78, clk: 79, p90: 80, hps: 109, zbw: 400,
  zpt: 401, npt: 500, wrm: 501, wmt: 503, ipr: 904, zk3: 906,
};

// โต๊ะ/ไอเทมที่ไม่นับ (กติกาเดียวกับหน้ารายงาน)
const EXCLUDE_TABLES = [600];
const EXCLUDE_ITEMS = [206001, 290016];
const isExcludedItem = c => {
  const i = parseInt(c);
  return EXCLUDE_ITEMS.includes(i) || (i >= 500002 && i <= 500026);
};

const normalizeId = id => String(id ?? '').replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

// สูตร BOM: menuCode -> { รหัสวัตถุดิบ(normalize): ยอดใช้ต่อ 1 จาน (หน่วยซื้อ) }
// รวมบรรทัดของวัตถุดิบตัวเดียวกันในเมนูเดียวกันไว้เป็นตัวเดียว (สูตรอาจแตกเป็นหลายบรรทัด)
// สำคัญ: ถ้าปล่อยให้เป็นหลายบรรทัด เวลานับ "จำนวนที่ขาย" ต่อเมนูจะถูกนับซ้ำตามจำนวนบรรทัด
// (cache 10 นาที กันโหลดชีทซ้ำทุกสาขา)
let bomCache = { map: null, stats: null, at: 0 };
async function fetchBom() {
  if (bomCache.map && Date.now() - bomCache.at < 10 * 60 * 1000) return bomCache;
  const rows = await fetchQcrdSheet('BOM');
  const map = {};
  const stats = { rows: 0, noDeduct: 0, noConverter: 0 };
  rows.slice(1).forEach(rw => {
    const menu = (rw[0] || '').trim();          // A = เลข POS ของเมนู
    const ing = (rw[3] || '').trim();           // D = รหัสวัตถุดิบ
    const perServe = parseFloat(rw[5]);         // F = ยอดใช้ต่อจาน (หน่วยเล็ก)
    const conv = parseFloat(rw[7]);             // H = ตัวแปลงหน่วย
    if (!menu || !ing || isNaN(perServe)) return;
    // T = "ไม่ตัด BOM" ที่ติ๊กไว้ในหน้า QC/RD → ยังคิดต้นทุนปกติ แต่ไม่ตัดสต็อกตามสูตร
    if (TRUTHY.test((rw[19] || '').trim())) { stats.noDeduct++; return; }
    const k = normalizeId(ing);
    if (!k) return;
    if (isNaN(conv) || !conv) stats.noConverter++;
    const perUnit = perServe / ((isNaN(conv) || !conv) ? DEFAULT_CONVERTER : conv);
    // รหัสเมนูเก็บแบบ normalize ด้วย เผื่อชีทพิมพ์ 0 นำหน้าไม่ตรงกับที่ POS ส่งมา
    const mk = normalizeId(menu);
    map[mk] = map[mk] || {};
    map[mk][k] = (map[mk][k] || 0) + perUnit;
    stats.rows++;
  });
  bomCache = { map, stats, at: Date.now() };
  return bomCache;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { branch, startDate, endDate, outletId } = req.query;
  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const key = String(branch).toLowerCase().trim();
  const oid = outletId || BRANCH_OUTLET[key];
  if (!oid) return res.status(400).json({ status: 'error', message: `ไม่รู้จักสาขา ${branch}` });

  try {
    const [{ map: bom, stats: bomStats }, detRes] = await Promise.all([
      fetchBom(),
      fetch(`${STORE_API}/ctranbetweendate?start=${startDate}&end=${endDate}&outlet=${oid}`),
    ]);
    if (!detRes.ok) throw new Error(`host API HTTP ${detRes.status}`);
    const dj = await detRes.json();
    const rows = Array.isArray(dj) ? dj : dj.data || [];

    const usageMap = {};
    // ยอดใช้แยกตามเมนู: { รหัสวัตถุดิบ: { เลขเมนู: { menu, menuCode, sold, qty } } }
    // นับจากบรรทัดขายชุดเดียวกับ usageMap เพื่อให้ "ขาย" กับ "ปริมาณใช้" มาจากฐานเดียวกันเสมอ
    const byMenu = {};
    let soldLines = 0, matchedLines = 0;
    const missingMenus = new Set();

    rows.forEach(r => {
      if (r.void) return;
      if (EXCLUDE_TABLES.includes(parseInt(r.tableID))) return;
      if (isExcludedItem(r.itemCode)) return;
      soldLines++;

      const code = String(r.itemCode).trim();
      const recipe = bom[normalizeId(code)] || bom[code];
      if (!recipe) { missingMenus.add(code); return; }
      matchedLines++;

      const qty = parseFloat(r.quantity) || 0;
      if (!qty) return;
      // ใช้วันที่สั่ง (prtOrdTime) เป็นหลัก ถ้าไม่มีใช้เวลาเปิดบิล
      const dateKey = String(r.prtOrdTime || r.startTime || '').slice(0, 10);
      if (!dateKey) return;

      const menuName = String(r.nameThai || r.nameEng || code).trim();

      Object.keys(recipe).forEach(k => {
        const used = qty * recipe[k];
        if (!usageMap[k]) usageMap[k] = { total: 0, details: {} };
        usageMap[k].total += used;
        usageMap[k].details[dateKey] = (usageMap[k].details[dateKey] || 0) + used;

        const perItem = byMenu[k] = byMenu[k] || {};
        const entry = perItem[code] = perItem[code] || { menu: menuName, menuCode: code, sold: 0, qty: 0 };
        entry.sold += qty;   // นับ 1 ครั้งต่อบรรทัดขาย (วัตถุดิบถูกยุบเป็นตัวเดียวแล้วใน fetchBom)
        entry.qty += used;
      });
    });

    // แปลงเป็น array + เรียงจากเมนูที่ใช้วัตถุดิบเยอะสุด
    const byMenuOut = {};
    Object.keys(byMenu).forEach(k => {
      byMenuOut[k] = Object.values(byMenu[k])
        .map(e => ({ ...e, sold: Number(e.sold.toFixed(2)), qty: Number(e.qty.toFixed(2)) }))
        .filter(e => e.qty > 0)
        .sort((a, b) => b.qty - a.qty);
    });

    // ปัดทศนิยมกันค่า floating point
    Object.keys(usageMap).forEach(k => {
      usageMap[k].total = Number(usageMap[k].total.toFixed(2));
      Object.keys(usageMap[k].details).forEach(d => {
        usageMap[k].details[d] = Number(usageMap[k].details[d].toFixed(2));
      });
    });

    return res.status(200).json({
      status: 'success',
      data: usageMap,
      byMenu: byMenuOut,
      meta: {
        source: 'bom',
        bomSheet: 'BOM (ชีท QC/RD)',
        bomRows: bomStats.rows,
        bomRowsNoDeduct: bomStats.noDeduct,        // แถวที่ติ๊ก "ไม่ตัด BOM" — ไม่นับเป็นยอดใช้
        bomRowsNoConverter: bomStats.noConverter,  // แถวที่ไม่มีตัวแปลงหน่วย (ใช้ค่าเริ่มต้น 1000)
        soldLines,
        matchedLines,
        coveragePct: soldLines ? Number((matchedLines / soldLines * 100).toFixed(1)) : 0,
        menusWithoutRecipe: missingMenus.size,
      },
    });
  } catch (error) {
    console.error('usage-bom error:', error.message);
    return res.status(502).json({ status: 'error', message: error.message });
  }
}
