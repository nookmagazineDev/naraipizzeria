// ยอดใช้วัตถุดิบ = ยอดขายจริง × สูตร BOM  (แทนการอ่านชีท UsageHistory ที่ต้องรออัปเดต)
// สูตร: ใช้ไป(หน่วยซื้อ) = จำนวนเมนูที่ขาย × ยอดใช้ต่อจาน(BOM คอลัมน์ F) ÷ ตัวแปลงหน่วย(คอลัมน์ H)
//   เช่น สันคอหมูสไลด์ 1 จาน ใช้ 33 กรัม, ตัวแปลง 1000 → 0.033 กก.
// คืนรูปแบบเดียวกับ /api/usage: { normalizedItemCode: { total, details: { 'YYYY-MM-DD': qty } } }

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';
const BOM_SHEET = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';
const BOM_GID = '419926693';

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

// สูตร BOM: menuCode -> [{ ing, perServe, converter }]  (cache 10 นาที กันโหลดชีทซ้ำทุกสาขา)
let bomCache = { map: null, at: 0 };
async function fetchBom() {
  if (bomCache.map && Date.now() - bomCache.at < 10 * 60 * 1000) return bomCache.map;
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${BOM_SHEET}/export?format=csv&gid=${BOM_GID}`,
    { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`BOM sheet HTTP ${r.status}`);
  const rows = parseCSV(await r.text());
  const map = {};
  rows.slice(1).forEach(rw => {
    const menu = (rw[0] || '').trim();          // A = เลข POS ของเมนู
    const ing = (rw[3] || '').trim();           // D = รหัสวัตถุดิบ
    const perServe = parseFloat(rw[5]);         // F = ยอดใช้ต่อจาน (หน่วยเล็ก)
    const conv = parseFloat(rw[7]);             // H = ตัวแปลงหน่วย
    if (!menu || !ing || isNaN(perServe)) return;
    (map[menu] = map[menu] || []).push({ ing, perServe, converter: (isNaN(conv) || !conv) ? 1 : conv });
  });
  bomCache = { map, at: Date.now() };
  return map;
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
    const [bom, detRes] = await Promise.all([
      fetchBom(),
      fetch(`${STORE_API}/ctranbetweendate?start=${startDate}&end=${endDate}&outlet=${oid}`),
    ]);
    if (!detRes.ok) throw new Error(`host API HTTP ${detRes.status}`);
    const dj = await detRes.json();
    const rows = Array.isArray(dj) ? dj : dj.data || [];

    const usageMap = {};
    let soldLines = 0, matchedLines = 0;
    const missingMenus = new Set();

    rows.forEach(r => {
      if (r.void) return;
      if (EXCLUDE_TABLES.includes(parseInt(r.tableID))) return;
      if (isExcludedItem(r.itemCode)) return;
      soldLines++;

      const code = String(r.itemCode).trim();
      const recipe = bom[code] || bom[normalizeId(code)];
      if (!recipe) { missingMenus.add(code); return; }
      matchedLines++;

      const qty = parseFloat(r.quantity) || 0;
      if (!qty) return;
      // ใช้วันที่สั่ง (prtOrdTime) เป็นหลัก ถ้าไม่มีใช้เวลาเปิดบิล
      const dateKey = String(r.prtOrdTime || r.startTime || '').slice(0, 10);
      if (!dateKey) return;

      recipe.forEach(ing => {
        const used = qty * ing.perServe / ing.converter;
        const k = normalizeId(ing.ing);
        if (!k) return;
        if (!usageMap[k]) usageMap[k] = { total: 0, details: {} };
        usageMap[k].total += used;
        usageMap[k].details[dateKey] = (usageMap[k].details[dateKey] || 0) + used;
      });
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
      meta: {
        source: 'bom',
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
