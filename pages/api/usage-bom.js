// ยอดใช้วัตถุดิบ = ยอดขายจริง × สูตร BOM  (แทนการอ่านชีท UsageHistory ที่ต้องรออัปเดต)
// สูตร: ใช้ไป(หน่วยซื้อ) = จำนวนเมนูที่ขาย × ยอดใช้ต่อจาน(BOM คอลัมน์ F) ÷ ตัวแปลงหน่วย(คอลัมน์ H)
//   เช่น สันคอหมูสไลด์ 1 จาน ใช้ 33 กรัม, ตัวแปลง 1000 → 0.033 กก.
// สูตรอ่านจากแท็บ BOM ของชีท QC/RD ผ่าน lib/qcrdSheet.js — ตัวเดียวกับที่หน้า QC/RD ใช้
// จึงเห็นสูตรที่แก้จากหน้า QC/RD ทันที (ช้าสุด 10 นาทีตามแคช) และเคารพธง "ไม่ตัด BOM" ด้วย
// คืนรูปแบบเดียวกับ /api/usage: { normalizedItemCode: { total, details: { 'YYYY-MM-DD': qty } } }

import { fetchQcrdSheet, TRUTHY, DEFAULT_CONVERTER } from '../../lib/qcrdSheet';
import { usingSql, fetchQcrdSql } from '../../lib/qcrdSource';
// กติกาเดียวกับหน้านับสต๊อกของสาขา (โปรเจกต์ Narai-branch) — ดู lib/usageRules.js
import {
  normalizeId, countableSaleRow, usageDateKey, kgOnlyIngredients, skipReason,
  EXCLUDE_TABLES, EXCLUDE_ITEMCODES, EXCLUDE_PLATE_MENU_INGREDIENTS, EXCLUDE_PLATE_MENU_CODES,
} from '../../lib/usageRules';

// ยิง ctranbetweendate ตัวเดียวกับ /api/detail ซึ่งเป็นข้อมูลระดับไอเทม (หนักกว่ายอดบิลหลายเท่า)
// ค่า default ของ Vercel คือ 10 วินาที ซึ่งไม่พอ — ตั้งเท่ากับ /api/detail และ /api/sales
export const config = { maxDuration: 60 };
import { branchOutletMap } from '../../lib/branchRegistry';

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

// รหัสสาขา -> outletID อ่านจากทะเบียนสาขา (dbo.hr_branch) ผ่าน lib/branchRegistry.js
// เพิ่มสาขาใหม่ที่หน้า HR > จัดการสาขา แล้วไฟล์นี้รู้จักเองทันที ไม่ต้องมาแก้โค้ด

// สูตร BOM: menuCode -> { รหัสวัตถุดิบ(normalize): ยอดใช้ต่อ 1 จาน (หน่วยซื้อ) }
// รวมบรรทัดของวัตถุดิบตัวเดียวกันในเมนูเดียวกันไว้เป็นตัวเดียว (สูตรอาจแตกเป็นหลายบรรทัด)
// สำคัญ: ถ้าปล่อยให้เป็นหลายบรรทัด เวลานับ "จำนวนที่ขาย" ต่อเมนูจะถูกนับซ้ำตามจำนวนบรรทัด
// (cache 10 นาที กันโหลดชีทซ้ำทุกสาขา)
let bomCache = { map: null, names: null, stats: null, at: 0 };

/* สูตรจาก SQL (ตาราง qcrd_bom) — รูปแบบ { รหัสเมนู: { items: [...] } } ตัวเดียวกับที่หน้า QC/RD ใช้
   คิดยอดใช้ด้วยกติกาเดียวกับฝั่งชีททุกข้อ (ข้ามแถวที่ติด "ไม่ตัด BOM", converter ว่าง = 1000) */
function bomMapFromSql(data) {
  const map = {};
  const names = {};
  const stats = { rows: 0, noDeduct: 0, noConverter: 0 };
  Object.entries(data || {}).forEach(([menu, entry]) => {
    const mk = normalizeId(menu);
    if (!mk) return;
    if (entry.name && !names[mk]) names[mk] = String(entry.name).trim();
    (entry.items || []).forEach(it => {
      const perServe = parseFloat(it.qty);
      const k = normalizeId(it.itemCode);
      if (!k || isNaN(perServe)) return;
      if (it.noDeduct) { stats.noDeduct++; return; }
      const conv = parseFloat(it.converter);
      if (isNaN(conv) || !conv) stats.noConverter++;
      map[mk] = map[mk] || {};
      map[mk][k] = (map[mk][k] || 0) + perServe / ((isNaN(conv) || !conv) ? DEFAULT_CONVERTER : conv);
      stats.rows++;
    });
  });
  return { map, names, stats };
}

async function fetchBom() {
  if (bomCache.map && Date.now() - bomCache.at < 10 * 60 * 1000) return bomCache;
  // โหมด SQL: อ่านสูตรจากฐาน InventoryNarai — ล้มเมื่อไหร่ค่อยถอยไปอ่านชีทเหมือนเดิม
  if (usingSql()) {
    try {
      const { map, names, stats } = bomMapFromSql(await fetchQcrdSql('bom'));
      bomCache = { map, names, stats, at: Date.now() };
      return bomCache;
    } catch (err) {
      console.error('usage-bom SQL error:', err.message);
    }
  }
  const rows = await fetchQcrdSheet('BOM');
  const map = {};
  const names = {};
  const stats = { rows: 0, noDeduct: 0, noConverter: 0 };
  rows.slice(1).forEach(rw => {
    const menu = (rw[0] || '').trim();          // A = เลข POS ของเมนู
    const menuName = (rw[1] || '').trim();      // B = ชื่อเมนูในสูตร
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
    if (menuName && !names[mk]) names[mk] = menuName;
    map[mk] = map[mk] || {};
    map[mk][k] = (map[mk][k] || 0) + perUnit;
    stats.rows++;
  });
  bomCache = { map, names, stats, at: Date.now() };
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
  const oid = outletId || (await branchOutletMap())[key];
  if (!oid) return res.status(400).json({ status: 'error', message: `ไม่รู้จักสาขา ${branch}` });

  try {
    const [{ map: bom, names: bomNames, stats: bomStats }, detRes] = await Promise.all([
      fetchBom(),
      // ตัดจบเองที่ 55 วิ ให้ทันคืน error ที่อ่านรู้เรื่องก่อน maxDuration 60 จะฆ่า function
      // header ngrok: ถ้า host API อยู่หลัง tunnel จะได้ JSON ไม่ใช่หน้าเตือนของ ngrok ที่เป็น HTML
      fetch(`${STORE_API}/ctranbetweendate?start=${startDate}&end=${endDate}&outlet=${oid}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(55000),
        headers: { 'ngrok-skip-browser-warning': 'true' },
      }),
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

    // ── รอบที่ 1: รวมยอดขายต่อเมนู (ทั้งช่วง + รายวัน) ──
    // ต้องรู้ก่อนว่าช่วงนี้มีเมนูชั่ง (กก) ขายบ้างไหม ถึงจะรู้ว่าวัตถุดิบตัวไหนห้ามนับจากเมนูอื่น
    // จึงแยกเป็นสองรอบ (เดิมรอบเดียวจบ เลยใส่กฎกันนับซ้ำไม่ได้)
    const soldByMenu = {};
    rows.forEach(r => {
      if (!countableSaleRow(r)) return;
      soldLines++;

      const code = String(r.itemCode ?? '').trim();
      const key = normalizeId(code);
      if (!key) return;
      if (bom[key]) matchedLines++; else { missingMenus.add(code); return; }

      const qty = parseFloat(r.quantity) || 0;
      if (!qty) return;
      const dateKey = usageDateKey(r);
      if (!dateKey) return;

      const e = soldByMenu[key] || (soldByMenu[key] = {
        code,
        // ชื่อเมนูใช้ของ BOM ก่อน (กฎ (กก)/(ที่) อ่านจากชื่อในสูตร เหมือนฝั่ง Narai-branch)
        // ไม่มีในสูตรค่อยใช้ชื่อที่ POS ส่งมา
        name: (bomNames && bomNames[key]) || String(r.nameThai || r.nameEng || code).trim(),
        total: 0,
        daily: {},
      });
      e.total += qty;
      e.daily[dateKey] = (e.daily[dateKey] || 0) + qty;
    });

    // ── รอบที่ 2: กระจายยอดขายลงวัตถุดิบตามสูตร + กฎกันนับซ้ำสองข้อ ──
    const kgOnlyIngs = kgOnlyIngredients(
      Object.entries(soldByMenu).map(([key, e]) => ({ key, name: e.name, qty: e.total })),
      bom
    );
    let skippedKg = 0, skippedPlate = 0;

    Object.entries(soldByMenu).forEach(([key, e]) => {
      const recipe = bom[key];
      if (!recipe || !e.total) return;

      Object.entries(recipe).forEach(([ing, perUnit]) => {
        const skip = skipReason({ ing, menuKey: key, menuName: e.name, kgOnlyIngs });
        if (skip === 'kg') { skippedKg++; return; }
        if (skip === 'plate') { skippedPlate++; return; }

        const used = e.total * perUnit;
        if (!used) return;

        const u = usageMap[ing] || (usageMap[ing] = { total: 0, details: {} });
        u.total += used;
        Object.entries(e.daily).forEach(([d, dayQty]) => {
          const dayUsed = dayQty * perUnit;
          if (!dayUsed) return;
          u.details[d] = (u.details[d] || 0) + dayUsed;
        });

        // วัตถุดิบถูกยุบเป็นตัวเดียวต่อเมนูแล้วใน fetchBom → sold นับ 1 ครั้งต่อเมนู
        // (ฝั่ง Narai-branch ปล่อยให้สูตรแตกหลายบรรทัดแล้วบวก sold ซ้ำ เคยทำให้เมนู P20
        //  ขึ้น "ขาย" 451 ทั้งที่ผลรวมรายโต๊ะ 225.5 — ปริมาณใช้เท่ากัน ต่างแค่ช่อง "ขาย")
        const perItem = byMenu[ing] = byMenu[ing] || {};
        perItem[e.code] = { menu: e.name, menuCode: e.code, sold: e.total, qty: used };
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
        // กติกาที่ใช้จริงตอนคิด — เอาไว้เทียบกับหน้านับสต๊อกของสาขาเวลาเลขไม่ตรงกัน
        rules: {
          excludeTables: EXCLUDE_TABLES,
          excludeItemCodes: [...EXCLUDE_ITEMCODES],
          plateRuleIngredients: [...EXCLUDE_PLATE_MENU_INGREDIENTS],
          plateRuleMenuCodes: [...EXCLUDE_PLATE_MENU_CODES],
          kgOnlyIngredients: [...kgOnlyIngs],   // วัตถุดิบที่ช่วงนี้นับจากเมนู (กก) อย่างเดียว
          skippedByKgRule: skippedKg,           // จำนวนคู่ (เมนู × วัตถุดิบ) ที่ถูกกฎ (กก) ตัด
          skippedByPlateRule: skippedPlate,
          dateBasis: 'postTime',
          honorNoDeduct: true,                  // ยังเคารพธง "ไม่ตัด BOM" จากหน้า QC/RD
        },
      },
    });
  } catch (error) {
    console.error('usage-bom error:', error.message);
    return res.status(502).json({ status: 'error', message: error.message });
  }
}
