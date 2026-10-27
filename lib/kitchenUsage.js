// ยอดวัตถุดิบของการผลิต — สำเนาของ narai-storefct/src/services/kitchenUsage.js (หน้า QC/RD › รายงานการผลิต)
// ต้องตรงกับฝั่งนั้นทุกบรรทัด ตัวเลขของสองหน้าจึงออกมาเท่ากัน — ฝั่งนั้นแก้ ที่นี่ต้องแก้ตาม
//
// ยอดวัตถุดิบของการผลิต — ตามสูตร QC/RD เทียบกับใช้จริงจากใบเบิก (หน้าดูรายงานการผลิต)
//
// ใช้จริง = ใบเบิกวัตถุดิบของคำสั่งผลิต (kitchen_material_issue: qty รวมของสูญเสียแล้ว, loss_qty, unit_price)
// ตามสูตร = สูตร BOM ของ QC/RD × จำนวนสูตรของคำสั่ง (ยอดสั่ง ÷ ผลผลิตต่อสูตร) แปลงเป็นหน่วยสต๊อก
//           กติกาเดียวกับแท็บเบิกตามแพลน (ข้าม "ไม่ตัด BOM")
//
// คำสั่งเดียวผลิตหลายครั้งได้ — แบ่งให้แต่ละครั้งตามสัดส่วนจำนวนที่ได้ เหมือนที่ office-server แบ่งต้นทุน
// (getProductionReport) รวมทุกครั้งของคำสั่งแล้วเท่ากับยอดของคำสั่งพอดี

const normKey = (v) => String(v ?? '').trim().replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
export const round3 = (n) => Math.round(n * 1000) / 1000;

/** จำนวนสูตรของยอดหนึ่ง — ยอด ÷ ผลผลิตต่อสูตร (หน่วยต้องตรง) · สูตรไม่มีผลผลิต ยอดเป็นหน่วย "สูตร" */
export function batchesOf(qty, unit, menu) {
  const yieldQty = Number(menu?.yieldQty);
  const u = String(unit || '');
  if (yieldQty > 0 && (!u || !menu.yieldUnit || u === menu.yieldUnit)) return Number(qty) / yieldQty;
  if (u === 'สูตร') return Number(qty);
  return null;
}

/** รวมยอดผลิตของแต่ละคำสั่งจากรายการผลิตที่มี — ตัวหารของสัดส่วน */
export function orderTotals(runs) {
  const t = new Map();
  for (const r of runs) {
    if (!r.order_id) continue;
    t.set(String(r.order_id), (t.get(String(r.order_id)) || 0) + (Number(r.qty_produced) || 0));
  }
  return t;
}

/**
 * วัตถุดิบของการผลิตครั้งเดียว
 * @param {object} run  แถวจาก getProductionReport
 * @param {{ recipe?: { menu, lines }, issues: Array, totals: Map }} ctx
 *   issues = บรรทัดใบเบิกของคำสั่งนี้ (getMaterialIssues กรองด้วย order_id แล้ว)
 * @returns {{ batches: number|null, share: number, hasIssues: boolean, lines: Map<string, object> }}
 */
export function runUsage(run, { recipe, issues, totals }) {
  const produced = Number(run.qty_produced) || 0;
  const orderTotal = run.order_id ? totals.get(String(run.order_id)) || produced : produced;
  const share = run.order_id && orderTotal > 0 ? produced / orderTotal : 1;
  // จำนวนสูตรของคำสั่ง (ถ้ามี) ไม่งั้นคิดจากที่ผลิตได้ — แล้วคูณสัดส่วนของครั้งนี้
  const orderBatches = run.order_id
    ? batchesOf(run.order_qty, run.unit, recipe?.menu)
    : batchesOf(produced, run.unit, recipe?.menu);
  const batches = orderBatches === null ? null : orderBatches * (run.order_id ? share : 1);

  const lines = new Map();
  const get = (key, seed) => {
    if (!lines.has(key)) lines.set(key, { key, code: seed.code, name: seed.name, unit: seed.unit, recipe: 0, actual: 0, loss: 0, cost: 0 });
    return lines.get(key);
  };

  if (batches !== null) {
    for (const l of recipe?.lines || []) {
      if (l.noDeduct) continue;
      const qty = (Number(l.qty) || 0) * batches / (Number(l.converter) || 1000);
      if (!(qty > 0)) continue;
      const key = l.itemKey || normKey(l.itemCode);
      get(key, { code: l.itemCode, name: l.itemName, unit: l.purchaseUnit }).recipe += qty;
    }
  }
  for (const it of issues || []) {
    const key = normKey(it.item_key || it.item_code);
    const row = get(key, { code: it.item_code, name: it.item_name, unit: it.unit });
    const qty = (Number(it.qty) || 0) * share;
    row.actual += qty;
    row.loss += (Number(it.loss_qty) || 0) * share;
    row.cost += qty * (Number(it.unit_price) || 0);
    if (it.unit) row.unit = it.unit; // หน่วยสต๊อกจากใบเบิกแม่นกว่าหน่วยซื้อของสูตร
    if (it.item_name) row.name = it.item_name;
  }
  return { batches, share, hasIssues: (issues || []).length > 0, lines };
}

/**
 * สูตรที่เก็บไว้กับคำสั่งผลิต (kitchen_production_order.recipe_snapshot) — เก็บเฉพาะฟิลด์ที่ใช้คิด
 * "ตามสูตร" ทั้งในรายงานและฟอร์มบันทึกผล รูปเดียวกับคำตอบของ /api/qcrd_recipe ใช้แทนกันได้ตรง ๆ
 */
export function toRecipeSnapshot(recipe) {
  const m = recipe?.menu;
  if (!m) return null;
  return {
    menu: {
      code: m.code, key: m.key, name: m.name, groupName: m.groupName || '',
      cost: Number(m.cost) || 0, yieldQty: Number(m.yieldQty) || 0, yieldUnit: m.yieldUnit || '',
    },
    lines: (recipe.lines || []).map((l) => ({
      itemKey: l.itemKey, itemCode: l.itemCode, itemName: l.itemName,
      qty: Number(l.qty) || 0, converter: Number(l.converter) || 0,
      purchaseUnit: l.purchaseUnit || '', useUnit: l.useUnit || '', noDeduct: l.noDeduct === true,
    })),
  };
}

/** อ่าน recipe_snapshot ของแถวคำสั่ง/รายการผลิต · null = ไม่ได้เก็บ (คำสั่งรุ่นก่อน) หรืออ่านไม่ออก */
export function parseRecipeSnapshot(text) {
  if (!text) return null;
  try {
    const snap = typeof text === 'string' ? JSON.parse(text) : text;
    return snap?.menu && Array.isArray(snap.lines) ? snap : null;
  } catch {
    return null;
  }
}
