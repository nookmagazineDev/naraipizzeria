// ════════════════════════════════════════════════════════════
//  QC/RD บน SQL Server — เมนู · สูตร BOM · วัตถุดิบ · หมวดหมู่เมนู
//  ฐานข้อมูล InventoryNarai (ตัวเดียวกับหน้านับสต๊อก) โครงตารางอยู่ใน docs/schema-qcrd.sql
//
//  ไฟล์นี้คือฝั่ง "ทำงานจริง" ที่มาแทน qcrd-apps-script.gs ทั้งไฟล์
//  ทุก action ที่หน้าเว็บเคยยิงไป Apps Script มีครบที่นี่ ชื่อและรูปแบบ payload เหมือนเดิม
//    saveMenu · saveMenuStatus · saveMenuGroup · saveItem · addItem · deleteItem
//    · updateItemUnits · sortBom
//
//  endpoint
//    GET  /qcrd/ping                      เช็กว่าต่อฐาน InventoryNarai ได้ไหม
//    GET  /qcrd/menu | /qcrd/bom | /qcrd/item | /qcrd/menugroup     อ่านข้อมูล
//    POST /qcrd/save   { action, ... }    เขียน (ต้องมี header x-api-key)
//
//  ⚠️ เขียนได้ต้องตั้ง env QCRD_WRITE_KEY บนเครื่องโฮสต์ก่อน แล้วตั้งค่าเดียวกันเป็น
//     env QCRD_WRITE_KEY บน Vercel — ไม่ตั้ง = ปิดการเขียนไว้ (อ่านได้อย่างเดียว)
//     API ตัวนี้เปิดออกเน็ตผ่าน tunnel ถ้าปล่อยให้เขียนได้โดยไม่มีกุญแจ ใครก็ลบสูตรทิ้งได้
// ════════════════════════════════════════════════════════════
const express = require('express');
const sql = require('mssql');

// ── ต่อฐาน InventoryNarai (เครื่องเดียวกับ NaraiPos แต่คนละฐานข้อมูล/อาจคนละ instance) ──
const RAW_SERVER = process.env.QCRD_DB_SERVER || process.env.DB_SERVER || 'localhost\\SQLEXPRESS';
const [qHost, qInstance] = RAW_SERVER.split('\\');
const qcrdConfig = {
  server: qHost,
  database: process.env.QCRD_DB_NAME || 'InventoryNarai',
  user: process.env.QCRD_DB_USER || process.env.DB_USER || 'SA',
  password: process.env.QCRD_DB_PASSWORD || process.env.DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    ...(qInstance ? { instanceName: qInstance } : {}),
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
};
if (!qInstance) qcrdConfig.port = Number(process.env.QCRD_DB_PORT || process.env.DB_PORT) || 1433;

// ต่อแบบ lazy เหมือนฝั่ง ZKBio — ต่อไม่ได้ก็ไม่กระทบ API ยอดขายหลัก
let qcrdPoolPromise = null;
function getPool() {
  if (!qcrdPoolPromise) {
    qcrdPoolPromise = new sql.ConnectionPool(qcrdConfig).connect()
      .then(pool => { console.log(`✅ ต่อ QC/RD DB สำเร็จ (${RAW_SERVER}/${qcrdConfig.database})`); return pool; })
      .catch(err => {
        qcrdPoolPromise = null;   // ให้ request ถัดไปลองต่อใหม่ได้
        console.error('❌ ต่อ QC/RD DB ไม่ได้:', err.message);
        throw new Error(`ต่อฐานข้อมูล QC/RD (${RAW_SERVER}/${qcrdConfig.database}) ไม่ได้: ${err.message}`);
      });
  }
  return qcrdPoolPromise;
}

/** ยิง query พร้อมพารามิเตอร์ — ใช้ได้ทั้งบน pool และบน transaction */
async function q(text, params = {}, tx = null) {
  const req = tx ? new sql.Request(tx) : (await getPool()).request();
  for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
  const r = await req.query(text);
  return r.recordset || [];
}

/** ทุก action ที่แตะหลายตารางต้องอยู่ใน transaction เดียว ไม่งั้นสูตรอาจถูกลบแล้วใส่ไม่กลับ */
async function withTx(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (err) {
    try { await tx.rollback(); } catch { /* rollback ล้มก็ไม่มีอะไรให้ทำต่อ */ }
    throw err;
  }
}

// ── helpers (ต้องให้ผลตรงกับ qcrd-apps-script.gs และ lib/qcrdSheet.js) ──
const str = v => (v === null || v === undefined ? '' : String(v).trim());
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const normCode = v => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
const isTruthy = v => v === true || /^(y|yes|true|1|ใช่)$/i.test(str(v));
const DEFAULT_CONVERTER = 1000;              // ตัวแปลงหน่วยเริ่มต้นเมื่อไม่ได้กรอก
const round4 = n => Math.round(n * 10000) / 10000;

/* ─────────────────────────── อ่านข้อมูล ─────────────────────────── */

/** เมนูทั้งหมด เรียงตามลำดับเดิมในชีท (sort_order) พร้อมชื่อหมวดสำหรับแสดงผล */
async function readMenus() {
  const rows = await q(`
    SELECT m.menu_code, m.menu_name, m.group_code, g.group_name, m.price, m.cost,
           m.status, m.yield_qty, m.yield_unit
    FROM dbo.qcrd_menu m
    LEFT JOIN dbo.qcrd_menu_group g ON g.group_code = m.group_code
    ORDER BY m.sort_order, m.menu_code`);
  return rows.map(r => ({
    code: str(r.menu_code),
    name: str(r.menu_name),
    group: str(r.group_code),
    groupName: str(r.group_name),
    price: r.price === null ? null : Number(r.price),
    cost: r.cost === null ? null : Number(r.cost),
    status: str(r.status) || 'ใช้งาน',
    yieldQty: r.yield_qty === null ? null : Number(r.yield_qty),
    yieldUnit: str(r.yield_unit),
  }));
}

/** สูตรทุกเมนู → { รหัสเมนู: { name, items: [...] } } รูปแบบเดียวกับที่หน้าเว็บใช้อยู่ */
async function readBom() {
  const rows = await q(`
    SELECT b.menu_code, COALESCE(m.menu_name, b.menu_name) AS menu_name, b.seq,
           b.item_code, b.item_name, b.qty, b.converter, b.item_price, b.unit_cost, b.line_cost,
           b.src_code, b.src_name, b.src_factor, b.src_base, b.tag, b.no_deduct
    FROM dbo.qcrd_bom b
    LEFT JOIN dbo.qcrd_menu m ON m.menu_code = b.menu_code
    ORDER BY COALESCE(m.sort_order, 2147483647), b.menu_code, b.seq`);
  const map = {};
  rows.forEach(r => {
    const code = str(r.menu_code);
    if (!map[code]) map[code] = { name: str(r.menu_name), items: [] };
    map[code].items.push({
      seq: String(r.seq),
      itemCode: str(r.item_code),
      itemName: str(r.item_name),
      qty: r.qty === null ? null : Number(r.qty),
      converter: r.converter === null ? null : Number(r.converter),
      itemPrice: r.item_price === null ? null : Number(r.item_price),
      unitCost: r.unit_cost === null ? null : Number(r.unit_cost),
      lineCost: r.line_cost === null ? null : Number(r.line_cost),
      srcCode: str(r.src_code),
      srcName: str(r.src_name),
      srcFactor: r.src_factor === null ? null : Number(r.src_factor),
      srcBase: r.src_base === null ? null : Number(r.src_base),
      tag: str(r.tag),
      noDeduct: r.no_deduct === true || r.no_deduct === 1,
    });
  });
  return map;
}

/** วัตถุดิบ (ทะเบียนเดียวกับหน้านับสต๊อก) + สาขาที่ใช้ */
async function readItems() {
  const [rows, branchRows] = await Promise.all([
    q(`SELECT item_key, item_code, item_name, price, unit, status, store_cat, converter,
              sub_item1, sub_item2, sub_item3, item_type, used_when, pos_item_id, request_unit
       FROM dbo.stock_item
       ORDER BY sort_order, item_code`),
    q('SELECT item_key, branch FROM dbo.stock_item_branch'),
  ]);
  const branchOf = {};
  branchRows.forEach(b => {
    const k = str(b.item_key);
    (branchOf[k] = branchOf[k] || []).push(str(b.branch).toUpperCase());
  });
  return rows.map(r => ({
    code: str(r.item_code),
    key: str(r.item_key),
    name: str(r.item_name),
    price: r.price === null ? null : Number(r.price),
    unit: str(r.unit),
    status: str(r.status) || 'ใช้งาน',
    subs: [r.sub_item1, r.sub_item2, r.sub_item3].map(str).filter(Boolean),
    converter: r.converter === null ? null : Number(r.converter),
    usedBranches: branchOf[str(r.item_key)] || [],
    storeCategory: str(r.store_cat),
    itemType: str(r.item_type),
    usedWhen: str(r.used_when),
    posItemId: str(r.pos_item_id),
    requestUnit: str(r.request_unit),
  }));
}

async function readMenuGroups() {
  const rows = await q('SELECT group_code, group_name FROM dbo.qcrd_menu_group ORDER BY sort_order, group_code');
  return rows.map(r => ({ code: str(r.group_code), name: str(r.group_name) })).filter(g => g.name);
}

/* ─────────────────────────── เขียนข้อมูล ─────────────────────────── */

/** ราคาวัตถุดิบ: item_key -> ราคาต่อหน่วยซื้อ (ใช้คิดต้นทุนสูตร) */
async function itemPriceMap(tx) {
  const rows = await q('SELECT item_key, price FROM dbo.stock_item', {}, tx);
  const map = {};
  rows.forEach(r => { map[str(r.item_key)] = Number(r.price) || 0; });
  return map;
}

/** สร้างแถวสูตรของเมนูหนึ่ง + ต้นทุนรวม (ตรรกะเดียวกับ buildBomRows_ ของ Apps Script) */
function buildBomRows(items, priceMap) {
  const rows = [];
  let total = 0;
  (items || []).forEach(it => {
    const itemCode = str(it.itemCode);
    if (!itemCode) return;
    const qty = Number(it.qty) || 0;
    const conv = Number(it.converter) || DEFAULT_CONVERTER;
    const key = normCode(itemCode);
    const price = priceMap[key] || 0;
    const unitCost = conv ? price / conv : 0;
    const lineCost = qty * unitCost;
    total += lineCost;
    rows.push({
      seq: rows.length + 1,
      itemCode, itemKey: key, itemName: str(it.itemName),
      qty, converter: conv,
      itemPrice: price || null,
      unitCost: price ? unitCost : null,
      lineCost: price ? lineCost : null,
      srcCode: str(it.srcCode) || null,
      srcName: str(it.srcName) || null,
      srcFactor: num(it.srcFactor),
      srcBase: num(it.srcBase),
      tag: str(it.tag) || null,
      noDeduct: isTruthy(it.noDeduct) ? 1 : 0,
    });
  });
  return { rows, total };
}

/** แทนที่สูตรของเมนูนั้นทั้งชุด (ลบเก่า → ใส่ใหม่เรียงลำดับ 1..n) */
async function replaceBomRows(menuCode, menuName, rows, tx) {
  await q('DELETE FROM dbo.qcrd_bom WHERE menu_code = @menu_code', { menu_code: menuCode }, tx);
  for (const r of rows) {
    await q(`
      INSERT INTO dbo.qcrd_bom
        (menu_code, menu_name, seq, item_code, item_key, item_name, qty, converter, item_price,
         unit_cost, line_cost, src_code, src_name, src_factor, src_base, tag, no_deduct)
      VALUES (@menu_code, @menu_name, @seq, @item_code, @item_key, @item_name, @qty, @converter, @item_price,
              @unit_cost, @line_cost, @src_code, @src_name, @src_factor, @src_base, @tag, @no_deduct)`,
      {
        menu_code: menuCode, menu_name: menuName || null, seq: r.seq,
        item_code: r.itemCode, item_key: r.itemKey, item_name: r.itemName || null,
        qty: r.qty, converter: r.converter, item_price: r.itemPrice,
        unit_cost: r.unitCost, line_cost: r.lineCost,
        src_code: r.srcCode, src_name: r.srcName, src_factor: r.srcFactor, src_base: r.srcBase,
        tag: r.tag, no_deduct: r.noDeduct,
      }, tx);
  }
}

/** หมวดหมู่เมนู: มีรหัส = เปลี่ยนชื่อ, ไม่มีรหัส = หาจากชื่อก่อน ไม่เจอค่อยสร้างรหัสใหม่ */
async function upsertMenuGroup(code, name, tx) {
  code = str(code);
  name = str(name);
  if (!code && !name) throw new Error('ต้องระบุรหัสหรือชื่อหมวดหมู่');
  const rows = await q('SELECT group_code, group_name FROM dbo.qcrd_menu_group', {}, tx);

  if (code) {
    const hit = rows.find(r => str(r.group_code) === code);
    if (hit) {
      const renamed = Boolean(name && name !== str(hit.group_name));
      if (renamed) {
        await q('UPDATE dbo.qcrd_menu_group SET group_name = @name, updated_at = SYSDATETIME() WHERE group_code = @code',
          { name, code }, tx);
      }
      return { code, name: name || str(hit.group_name), renamed };
    }
  } else {
    const byName = rows.find(r => str(r.group_name) === name);
    if (byName) return { code: str(byName.group_code), name };
  }
  if (!name) throw new Error(`ไม่พบรหัสหมวด ${code} และไม่ได้ระบุชื่อหมวดใหม่`);

  // รหัสใหม่ = เลขถัดจากรหัสตัวเลขที่มากที่สุด (เหมือน upsertMenuGroup_ ในสคริปต์เดิม)
  const maxCode = rows.reduce((max, r) => {
    const n = Number(str(r.group_code));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  const newCode = code || String(maxCode + 1);
  const sortOrder = rows.length;
  await q(`INSERT INTO dbo.qcrd_menu_group (group_code, group_name, sort_order)
           VALUES (@code, @name, @sort)`, { code: newCode, name, sort: sortOrder }, tx);
  return { code: newCode, name, created: true };
}

/**
 * เมนูอื่นที่ดึงสูตรของเมนูนี้ไปใช้ → คิดยอดใช้ใหม่ตามสูตรล่าสุด × สัดส่วนเดิมของเมนูนั้น
 * ตรรกะเดียวกับ cascadeFromMenu_ (กันวนซ้ำด้วย seen + จำกัดความลึก 3 ชั้น)
 */
async function cascadeFromMenu(srcCode, priceMap, seen, depth, tx) {
  const out = [];
  if (!srcCode || depth > 3 || seen[srcCode]) return out;
  seen[srcCode] = true;

  const targets = await q(`
    SELECT b.menu_code, MIN(b.bom_id) AS first_id, MIN(b.src_factor) AS factor
    FROM dbo.qcrd_bom b
    WHERE b.src_code = @src AND b.menu_code <> @src
    GROUP BY b.menu_code
    ORDER BY MIN(b.bom_id)`, { src: srcCode }, tx);
  if (!targets.length) return out;

  const srcItems = await q(
    'SELECT item_code, item_name, qty, converter, tag, no_deduct FROM dbo.qcrd_bom WHERE menu_code = @src ORDER BY seq',
    { src: srcCode }, tx);
  const srcName = (await q('SELECT menu_name FROM dbo.qcrd_menu WHERE menu_code = @src', { src: srcCode }, tx))[0];

  for (const t of targets) {
    const tCode = str(t.menu_code);
    const factor = Number(t.factor) || 1;
    // แถวที่มาจากเมนูต้นทางนี้จะถูกสร้างใหม่ ที่เหลือเก็บไว้ตามเดิม
    const keepRows = await q(`
      SELECT item_code, item_name, qty, converter, src_code, src_name, src_factor, src_base, tag, no_deduct
      FROM dbo.qcrd_bom
      WHERE menu_code = @menu AND (src_code IS NULL OR src_code <> @src)
      ORDER BY seq`, { menu: tCode, src: srcCode }, tx);

    const keep = keepRows.map(r => ({
      itemCode: r.item_code, itemName: r.item_name, qty: r.qty, converter: r.converter,
      srcCode: r.src_code, srcName: r.src_name, srcFactor: r.src_factor, srcBase: r.src_base,
      tag: r.tag, noDeduct: r.no_deduct,
    }));
    srcItems.forEach(sr => {
      const base = Number(sr.qty) || 0;
      keep.push({
        itemCode: sr.item_code, itemName: sr.item_name,
        qty: round4(base * factor), converter: sr.converter,
        srcCode, srcName: str(srcName && srcName.menu_name), srcFactor: factor, srcBase: base,
        tag: sr.tag, noDeduct: sr.no_deduct,
      });
    });

    const tName = str((await q('SELECT menu_name FROM dbo.qcrd_menu WHERE menu_code = @c', { c: tCode }, tx))[0]?.menu_name) || tCode;
    const built = buildBomRows(keep, priceMap);
    await replaceBomRows(tCode, tName, built.rows, tx);
    await q('UPDATE dbo.qcrd_menu SET cost = @cost, updated_at = SYSDATETIME() WHERE menu_code = @c',
      { cost: built.rows.length ? round4(built.total) : null, c: tCode }, tx);
    out.push({ code: tCode, name: tName, rows: built.rows.length });
    out.push(...await cascadeFromMenu(tCode, priceMap, seen, depth + 1, tx));
  }
  return out;
}

/** เพิ่ม/แก้ไขเมนู + แทนที่สูตรทั้งชุด (payload เหมือน action saveMenu เดิมทุกช่อง) */
async function saveMenu(data) {
  const code = str(data.code);
  const name = str(data.name);
  if (!code || !name) throw new Error('ต้องระบุรหัสและชื่อเมนู');

  return withTx(async (tx) => {
    // หมวดหมู่: null = ไม่แตะหมวดเดิมของแถวนั้น
    let groupCode = null;
    if (str(data.newGroupName)) groupCode = (await upsertMenuGroup('', data.newGroupName, tx)).code;
    else if (data.group !== undefined) groupCode = str(data.group);

    const priceMap = await itemPriceMap(tx);
    const built = buildBomRows(data.items, priceMap);
    const costCell = built.rows.length ? round4(built.total) : null;

    const exists = (await q('SELECT menu_code FROM dbo.qcrd_menu WHERE menu_code = @c', { c: code }, tx)).length > 0;
    if (exists) {
      const sets = ['menu_name = @name', 'menu_key = @key', 'updated_at = SYSDATETIME()'];
      const params = { c: code, name, key: normCode(code) };
      if (groupCode !== null) { sets.push('group_code = @group'); params.group = groupCode || null; }
      if (data.price !== undefined && str(data.price) !== '') { sets.push('price = @price'); params.price = num(data.price); }
      if (built.rows.length) { sets.push('cost = @cost'); params.cost = costCell; }
      if (data.yieldQty !== undefined) { sets.push('yield_qty = @yq'); params.yq = num(data.yieldQty); }
      if (data.yieldUnit !== undefined) { sets.push('yield_unit = @yu'); params.yu = str(data.yieldUnit) || null; }
      await q(`UPDATE dbo.qcrd_menu SET ${sets.join(', ')} WHERE menu_code = @c`, params, tx);
    } else {
      const maxSort = (await q('SELECT MAX(sort_order) AS s FROM dbo.qcrd_menu', {}, tx))[0]?.s;
      await q(`
        INSERT INTO dbo.qcrd_menu
          (menu_code, menu_key, menu_name, group_code, price, cost, status, yield_qty, yield_unit, sort_order)
        VALUES (@c, @key, @name, @group, @price, @cost, @status, @yq, @yu, @sort)`, {
        c: code, key: normCode(code), name, group: groupCode || null,
        price: num(data.price), cost: costCell, status: null,
        yq: num(data.yieldQty), yu: str(data.yieldUnit) || null,
        sort: (Number(maxSort) || 0) + 1,
      }, tx);
    }

    await replaceBomRows(code, name, built.rows, tx);
    const cascaded = await cascadeFromMenu(code, priceMap, {}, 0, tx);
    return { code, bomRows: built.rows.length, totalCost: costCell, group: groupCode, cascaded };
  });
}

/** เปิด/ปิดใช้งานเมนู */
async function saveMenuStatus(data) {
  const code = str(data.code);
  if (!code) throw new Error('ต้องระบุรหัสเมนู');
  const status = str(data.status) || 'ใช้งาน';
  const r = await q(
    'UPDATE dbo.qcrd_menu SET status = @s, updated_at = SYSDATETIME() WHERE menu_code = @c; SELECT @@ROWCOUNT AS n',
    { s: status, c: code });
  if (!Number(r[0]?.n)) throw new Error(`ไม่พบรหัส ${code} ในตารางเมนู`);
  return { code, status };
}

async function saveMenuGroup(data) {
  return withTx(tx => upsertMenuGroup(data.code, data.name, tx));
}

/** ช่องของวัตถุดิบที่หน้า QC/RD แก้ได้ → คอลัมน์ใน stock_item */
const ITEM_FIELDS = [
  ['name', 'item_name', v => str(v)],
  ['price', 'price', v => num(v)],
  ['unit', 'unit', v => str(v) || null],
  ['status', 'status', v => str(v) || 'ใช้งาน'],
  ['converter', 'converter', v => (str(v) === '' ? null : num(v))],
  ['storeCategory', 'store_cat', v => str(v) || null],
  ['itemType', 'item_type', v => str(v) || null],
  ['usedWhen', 'used_when', v => str(v) || null],
  // สองช่องนี้ฝั่งสต๊อกใช้ (itemid ของ POS / หน่วยเบิก) — เดิมแก้ได้ที่ชีทเท่านั้น
  ['posItemId', 'pos_item_id', v => str(v) || null],
  ['requestUnit', 'request_unit', v => str(v) || null],
];

/** เขียนสาขาที่ใช้วัตถุดิบใหม่ทั้งชุด (เก็บเป็นตัวพิมพ์เล็กตามกติกาของตารางสต๊อก) */
async function writeItemBranches(itemKey, branches, tx) {
  await q('DELETE FROM dbo.stock_item_branch WHERE item_key = @k', { k: itemKey }, tx);
  for (const b of (branches || []).map(x => str(x).toLowerCase()).filter(Boolean)) {
    await q('INSERT INTO dbo.stock_item_branch (item_key, branch) VALUES (@k, @b)', { k: itemKey, b }, tx);
  }
}

/** แก้ไขวัตถุดิบ — เขียนเฉพาะช่องที่ส่งมา (ช่องที่ไม่ส่ง = คงค่าเดิม เหมือน saveItem_ เดิม) */
async function saveItem(data) {
  const code = str(data.code);
  if (!code) throw new Error('ต้องระบุรหัสวัตถุดิบ');
  const key = normCode(code);
  return withTx(async (tx) => {
    const hit = await q('SELECT item_key FROM dbo.stock_item WHERE item_key = @k', { k: key }, tx);
    if (!hit.length) throw new Error(`ไม่พบรหัส ${code} ในทะเบียนวัตถุดิบ`);

    const sets = ['updated_at = SYSDATETIME()'];
    const params = { k: key };
    ITEM_FIELDS.forEach(([field, col, conv], i) => {
      if (data[field] === undefined) return;
      if (field === 'name' && !str(data.name)) return;         // ชื่อว่าง = ไม่ทับของเดิม
      if (field === 'price' && (str(data.price) === '' || num(data.price) === null)) return;
      sets.push(`${col} = @p${i}`);
      params[`p${i}`] = conv(data[field]);
    });
    if (data.subs !== undefined) {
      const subs = (data.subs || []).slice(0, 3).map(str);
      sets.push('sub_item1 = @s1', 'sub_item2 = @s2', 'sub_item3 = @s3');
      Object.assign(params, { s1: subs[0] || null, s2: subs[1] || null, s3: subs[2] || null });
    }
    await q(`UPDATE dbo.stock_item SET ${sets.join(', ')} WHERE item_key = @k`, params, tx);
    if (data.branches !== undefined) await writeItemBranches(key, data.branches, tx);
    return { code, key };
  });
}

/** เพิ่มวัตถุดิบใหม่ (กันรหัสซ้ำด้วย item_key เหมือนที่ตารางสต๊อกใช้เป็นคีย์) */
async function addItem(data) {
  const code = str(data.code);
  const name = str(data.name);
  if (!code) throw new Error('ต้องระบุรหัสวัตถุดิบ');
  if (!name) throw new Error('ต้องระบุชื่อวัตถุดิบ');
  const key = normCode(code);
  return withTx(async (tx) => {
    const dup = await q('SELECT item_code FROM dbo.stock_item WHERE item_key = @k', { k: key }, tx);
    if (dup.length) throw new Error(`มีรหัส ${str(dup[0].item_code)} อยู่แล้วในทะเบียนวัตถุดิบ`);
    const maxSort = (await q('SELECT MAX(sort_order) AS s FROM dbo.stock_item', {}, tx))[0]?.s;
    const subs = (data.subs || []).slice(0, 3).map(str);
    await q(`
      INSERT INTO dbo.stock_item
        (item_key, item_code, item_name, unit, price, status, store_cat, converter,
         sub_item1, sub_item2, sub_item3, item_type, used_when, pos_item_id, request_unit, sort_order)
      VALUES (@k, @code, @name, @unit, @price, @status, @store, @conv,
              @s1, @s2, @s3, @type, @used, @pos, @runit, @sort)`, {
      k: key, code, name,
      unit: str(data.unit) || null,
      price: num(data.price),
      status: str(data.status) || 'ใช้งาน',
      store: str(data.storeCategory) || null,
      conv: str(data.converter) === '' ? null : num(data.converter),
      s1: subs[0] || null, s2: subs[1] || null, s3: subs[2] || null,
      type: str(data.itemType) || null, used: str(data.usedWhen) || null,
      pos: str(data.posItemId) || null, runit: str(data.requestUnit) || null,
      sort: (Number(maxSort) || 0) + 1,
    }, tx);
    if (data.branches !== undefined) await writeItemBranches(key, data.branches, tx);
    return { code, key };
  });
}

/** ลบวัตถุดิบ — บอกด้วยว่ามันถูกใช้ในสูตรกี่แถว เพื่อให้หน้าเว็บเตือนคนกดได้ */
async function deleteItem(data) {
  const code = str(data.code);
  if (!code) throw new Error('ต้องระบุรหัสวัตถุดิบ');
  const key = normCode(code);
  return withTx(async (tx) => {
    const hit = await q('SELECT item_code FROM dbo.stock_item WHERE item_key = @k', { k: key }, tx);
    if (!hit.length) throw new Error(`ไม่พบรหัส ${code} ในทะเบียนวัตถุดิบ`);
    const used = Number((await q('SELECT COUNT(*) AS n FROM dbo.qcrd_bom WHERE item_key = @k', { k: key }, tx))[0]?.n) || 0;
    await q('DELETE FROM dbo.stock_item_branch WHERE item_key = @k', { k: key }, tx);
    await q('DELETE FROM dbo.stock_item WHERE item_key = @k', { k: key }, tx);
    return { code, key, usedInBom: used };
  });
}

/** เติมหน่วยให้วัตถุดิบที่ยังไม่มีหน่วย (ไม่ทับของเดิม) — payload { units: [{ code, unit }] } */
async function updateItemUnits(data) {
  const units = (data.units || [])
    .map(u => ({ key: normCode(u.code), unit: str(u.unit) }))
    .filter(u => u.key && u.unit);
  if (!units.length) return { updated: 0 };
  return withTx(async (tx) => {
    let updated = 0;
    for (const u of units) {
      const r = await q(`
        UPDATE dbo.stock_item SET unit = @u, updated_at = SYSDATETIME()
        WHERE item_key = @k AND (unit IS NULL OR LTRIM(RTRIM(unit)) = '');
        SELECT @@ROWCOUNT AS n`, { u: u.unit, k: u.key }, tx);
      updated += Number(r[0]?.n) || 0;
    }
    return { updated };
  });
}

/**
 * sortBom — ในชีทต้องเรียงแถวจริงเพื่อให้สูตรของเมนูเดียวกันอยู่ติดกัน
 * บน SQL ไม่มีเรื่องนี้ ตัวอ่าน readBom() เรียงตาม (ลำดับเมนู, seq) ให้อยู่แล้ว
 * เก็บ action ไว้เพื่อให้หน้าเว็บเดิมยิงมาแล้วไม่ error
 */
async function sortBom() {
  const rows = await q('SELECT COUNT(*) AS n FROM dbo.qcrd_bom');
  return { sortedRows: Number(rows[0]?.n) || 0, note: 'SQL เรียงตอนอ่านอยู่แล้ว ไม่ต้องจัดเรียงตาราง' };
}

const ACTIONS = {
  saveMenu, saveMenuStatus, saveMenuGroup,
  saveItem, addItem, deleteItem, updateItemUnits, sortBom,
};

/* ─────────────────────────── ต่อเข้ากับ express ─────────────────────────── */

function mountQcrd(app) {
  const WRITE_KEY = process.env.QCRD_WRITE_KEY || '';

  const send = (res, promise, label) =>
    promise
      .then(data => res.json({ status: 'success', data }))
      .catch(err => {
        console.error(`qcrd ${label} error:`, err.message);
        res.status(500).json({ status: 'error', message: err.message });
      });

  app.get('/qcrd/ping', async (req, res) => {
    try {
      const r = await q('SELECT COUNT(*) AS menus FROM dbo.qcrd_menu');
      res.json({
        status: 'success',
        db: `${RAW_SERVER}/${qcrdConfig.database}`,
        menus: Number(r[0]?.menus) || 0,
        writeEnabled: Boolean(WRITE_KEY),
      });
    } catch (e) {
      res.status(500).json({ status: 'error', message: e.message });
    }
  });

  app.get('/qcrd/menu', (req, res) => send(res, readMenus(), 'menu'));
  app.get('/qcrd/bom', (req, res) => send(res, readBom(), 'bom'));
  app.get('/qcrd/item', (req, res) => send(res, readItems(), 'item'));
  app.get('/qcrd/menugroup', (req, res) => send(res, readMenuGroups(), 'menugroup'));

  app.post('/qcrd/save', express.json({ limit: '2mb' }), (req, res) => {
    if (!WRITE_KEY) {
      return res.status(503).json({
        status: 'error',
        message: 'ยังไม่ได้ตั้ง env QCRD_WRITE_KEY บนเครื่องโฮสต์ — โหมดนี้ดูข้อมูลได้อย่างเดียว',
      });
    }
    if (str(req.get('x-api-key')) !== WRITE_KEY) {
      return res.status(401).json({ status: 'error', message: 'x-api-key ไม่ถูกต้อง' });
    }
    const body = req.body || {};
    const fn = ACTIONS[str(body.action)];
    if (!fn) return res.status(400).json({ status: 'error', message: `unknown action: ${str(body.action)}` });
    return send(res, fn(body), str(body.action));
  });
}

module.exports = { mountQcrd, getPool, readMenus, readBom, readItems, readMenuGroups, ACTIONS };
