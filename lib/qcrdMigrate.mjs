// แปลงแถวจากชีทต้นทุนเมนู -> เรคคอร์ด + คำสั่ง SQL สำหรับย้ายข้อมูล QC/RD
//
// ใช้ร่วมกันสองที่ ให้การจับคอลัมน์เป็นชุดเดียว:
//   scripts/migrate-qcrd.mjs   ย้ายจากเครื่องที่ต่อฐานได้ (CLI)
//   pages/api/qcrd-migrate.js  ย้ายจากฝั่ง Vercel เอง (กดจากลิงก์)
//
// ที่มาของแต่ละคอลัมน์อยู่ใน docs/schema-qcrd.sql — แก้ตรงนี้ที่เดียวแล้วทั้งสองทางตรงกันเสมอ
//   menucodegroup : A=รหัสหมวด B=ชื่อหมวด
//   menu          : A=Code B=NameThai C=MenuCode D=UnitPrice E=cost F=สถานะ G=ปริมาณที่ได้ H=หน่วยที่ได้
//   BOM           : A=เลขPOS B=ชื่อเมนู C=ลำดับ D=รหัส E=ชื่อ F=ยอดใช้ H=ตัวแปลง J=ราคา
//                   K/M=ต้นทุนต่อหน่วยเล็ก N=ต้นทุนแถว O–R=ที่มา S=แท็ก T=ไม่ตัด BOM
//   item          : A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ F,G,H=ไอเทมทดแทน I=ตัวแปลง
//                   J=สาขาที่ใช้ K=itemid(POS) L=หน่วยเบิก N=หมวดสโตร์ O=Plan/ประเภท P=ใช้กับ

export const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
export const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
/* ต้องให้ผลตรงกับ normalizeId() ของ Apps Script และ normCode() ของ migrate-stock.mjs */
export const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
export const TRUTHY = /^(y|yes|true|ture|1|ใช่)$/i;

/* ---------------------------- แปลงแถว -> เรคคอร์ด ---------------------------- */

export function mapGroups(rows) {
  const out = [];
  rows.forEach((r, index) => {
    const code = str(r[0]);
    const name = str(r[1]);
    if (!code || !name) return;
    out.push({ code, name, sortOrder: index });
  });
  return { rows: out, stats: {} };
}

export function mapMenus(rows) {
  const out = [];
  const seen = new Set();
  let dup = 0;
  rows.forEach((r, index) => {
    const code = str(r[0]);
    if (!code) return;
    if (seen.has(code)) dup++;
    seen.add(code);
    out.push({
      code,
      key: normCode(code),
      name: str(r[1]) || code,
      group: str(r[2]),
      price: num(r[3]),
      cost: num(r[4]),
      status: str(r[5]),
      yieldQty: num(r[6]),
      yieldUnit: str(r[7]),
      sortOrder: index,
    });
  });
  return { rows: out, stats: { duplicateCodes: dup } };
}

/** จัดกลุ่มตามเมนู เพราะฝั่งเขียนลบสูตรเดิมของเมนูนั้นทั้งชุดก่อนใส่ใหม่
 *  (ใส่ทีละแถวโดยไม่ลบก่อน = สูตรเก่าที่ถอดออกไปแล้วจะค้างอยู่ตลอดไป) */
export function mapBomByMenu(rows) {
  const byMenu = new Map();
  let skipped = 0;
  rows.forEach((r) => {
    const menuCode = str(r[0]);
    const itemCode = str(r[3]);
    if (!menuCode || !itemCode) { if (menuCode || itemCode) skipped++; return; }
    const list = byMenu.get(menuCode) || [];
    list.push({
      menuName: str(r[1]),
      seq: list.length + 1,                     // เรียงใหม่ 1..n ตามลำดับแถวในชีท
      itemCode,
      itemKey: normCode(itemCode),
      itemName: str(r[4]),
      qty: num(r[5]) ?? 0,
      converter: num(r[7]),
      itemPrice: num(r[9]),
      unitCost: num(r[10]) ?? num(r[12]),
      lineCost: num(r[13]),
      srcCode: str(r[14]),
      srcName: str(r[15]),
      srcFactor: num(r[16]),
      srcBase: num(r[17]),
      tag: str(r[18]),
      noDeduct: TRUTHY.test(str(r[19])) ? 1 : 0,
    });
    byMenu.set(menuCode, list);
  });
  const out = [...byMenu.entries()].map(([menuCode, items]) => ({ menuCode, items }));
  return { rows: out, stats: { skipped, bomRows: out.reduce((s, m) => s + m.items.length, 0) } };
}

export function mapItems(rows) {
  const byKey = new Map();
  let dup = 0, skipped = 0;
  rows.forEach((r, index) => {
    const code = str(r[0]);
    const name = str(r[1]);
    if (!code && !name) return;
    const key = normCode(code);
    if (!key) { skipped++; return; }
    if (byKey.has(key)) dup++;
    const colO = str(r[14]);
    byKey.set(key, {           // รหัสซ้ำ = แถวท้ายสุดของชีทชนะ (ตรงกับที่ชีทใช้ค่าล่าสุด)
      key, code, name,
      price: num(r[2]),
      unit: str(r[3]),
      status: str(r[4]),
      subs: [str(r[5]), str(r[6]), str(r[7])],
      converter: num(r[8]),
      branches: String(r[9] ?? '').toLowerCase().split(/[,\s]+/).map((b) => b.trim()).filter(Boolean),
      posItemId: str(r[10]),
      requestUnit: str(r[11]),
      storeCat: str(r[13]),
      // คอลัมน์ O ถูกใช้ชนกันสองความหมาย — ดูจากค่าที่อยู่ในช่องแล้วลงให้ถูกช่อง
      planOnly: TRUTHY.test(colO) ? 1 : null,
      itemType: TRUTHY.test(colO) ? null : (colO || null),
      usedWhen: str(r[15]) || null,
      sortOrder: index,
    });
  });
  return { rows: [...byKey.values()], stats: { duplicateCodes: dup, skipped } };
}

/* ------------------------- เรคคอร์ด -> คำสั่ง SQL ------------------------- */
// ทุกตัวรันซ้ำได้ ไม่เกิดข้อมูลซ้ำ: ทะเบียนใช้ MERGE ทับของเดิม ส่วนสูตรลบทั้งชุดก่อนใส่ใหม่
// suffix มีไว้ให้ต่อหลายแถวเป็นคำสั่งเดียวได้ (ลดจำนวนรอบวิ่งไป-กลับ ซึ่งสำคัญมากตอนรันจาก Vercel)

export function groupStmt(g, suffix = '') {
  const p = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.qcrd_menu_group AS t
      USING (SELECT ${p('group_code')} AS group_code) AS s ON t.group_code = s.group_code
      WHEN MATCHED THEN UPDATE SET group_name = ${p('group_name')}, sort_order = ${p('sort_order')}, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (group_code, group_name, sort_order)
        VALUES (${p('group_code')}, ${p('group_name')}, ${p('sort_order')});`,
    params: {
      [`group_code${suffix}`]: g.code,
      [`group_name${suffix}`]: g.name,
      [`sort_order${suffix}`]: g.sortOrder,
    },
  };
}

export function menuStmt(m, suffix = '') {
  const p = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.qcrd_menu AS t
      USING (SELECT ${p('menu_code')} AS menu_code) AS s ON t.menu_code = s.menu_code
      WHEN MATCHED THEN UPDATE SET
        menu_key = ${p('menu_key')}, menu_name = ${p('menu_name')}, group_code = ${p('group_code')},
        price = ${p('price')}, cost = ${p('cost')}, status = ${p('status')},
        yield_qty = ${p('yield_qty')}, yield_unit = ${p('yield_unit')}, sort_order = ${p('sort_order')},
        updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (menu_code, menu_key, menu_name, group_code, price, cost, status, yield_qty, yield_unit, sort_order)
        VALUES (${p('menu_code')}, ${p('menu_key')}, ${p('menu_name')}, ${p('group_code')}, ${p('price')},
                ${p('cost')}, ${p('status')}, ${p('yield_qty')}, ${p('yield_unit')}, ${p('sort_order')});`,
    params: {
      [`menu_code${suffix}`]: m.code,
      [`menu_key${suffix}`]: m.key,
      [`menu_name${suffix}`]: m.name,
      [`group_code${suffix}`]: m.group || null,
      [`price${suffix}`]: m.price,
      [`cost${suffix}`]: m.cost,
      [`status${suffix}`]: m.status || null,
      [`yield_qty${suffix}`]: m.yieldQty,
      [`yield_unit${suffix}`]: m.yieldUnit || null,
      [`sort_order${suffix}`]: m.sortOrder,
    },
  };
}

export function bomStmt(menu, suffix = '') {
  const params = { [`menu_code${suffix}`]: menu.menuCode };
  const values = menu.items.map((it, i) => {
    const k = `${i}${suffix}`;
    Object.assign(params, {
      [`n${k}`]: it.menuName || null, [`q${k}`]: it.seq,
      [`c${k}`]: it.itemCode, [`k${k}`]: it.itemKey, [`m${k}`]: it.itemName || null,
      [`y${k}`]: it.qty, [`v${k}`]: it.converter, [`p${k}`]: it.itemPrice,
      [`u${k}`]: it.unitCost, [`l${k}`]: it.lineCost,
      [`sc${k}`]: it.srcCode || null, [`sn${k}`]: it.srcName || null,
      [`sf${k}`]: it.srcFactor, [`sb${k}`]: it.srcBase,
      [`tg${k}`]: it.tag || null, [`nd${k}`]: it.noDeduct,
    });
    return `(@menu_code${suffix}, @n${k}, @q${k}, @c${k}, @k${k}, @m${k}, @y${k}, @v${k}, @p${k}, @u${k}, @l${k},`
      + ` @sc${k}, @sn${k}, @sf${k}, @sb${k}, @tg${k}, @nd${k})`;
  });
  return {
    text: `DELETE FROM dbo.qcrd_bom WHERE menu_code = @menu_code${suffix};
           INSERT INTO dbo.qcrd_bom
             (menu_code, menu_name, seq, item_code, item_key, item_name, qty, converter, item_price,
              unit_cost, line_cost, src_code, src_name, src_factor, src_base, tag, no_deduct)
           VALUES ${values.join(', ')};`,
    params,
  };
}

/** คอลัมน์ K/L/plan_only เป็นของฝั่งสต๊อก — เขียนเฉพาะตอนสร้างแถวใหม่ แถวเดิมไม่แตะ (COALESCE) */
export function itemStmt(it, suffix = '') {
  const p = (n) => `@${n}${suffix}`;
  return {
    text: `
      MERGE dbo.stock_item AS t
      USING (SELECT ${p('item_key')} AS item_key) AS s ON t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = ${p('item_code')}, item_name = ${p('item_name')}, unit = ${p('unit')}, price = ${p('price')},
        status = ${p('status')}, store_cat = ${p('store_cat')}, converter = ${p('converter')},
        sub_item1 = ${p('sub1')}, sub_item2 = ${p('sub2')}, sub_item3 = ${p('sub3')},
        item_type = COALESCE(${p('item_type')}, t.item_type),
        used_when = COALESCE(${p('used_when')}, t.used_when),
        plan_only = COALESCE(${p('plan_only')}, t.plan_only),
        sort_order = ${p('sort_order')}, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (item_key, item_code, item_name, unit, price, status, store_cat, converter,
         sub_item1, sub_item2, sub_item3, item_type, used_when,
         pos_item_id, request_unit, plan_only, sort_order)
        VALUES (${p('item_key')}, ${p('item_code')}, ${p('item_name')}, ${p('unit')}, ${p('price')},
                ${p('status')}, ${p('store_cat')}, ${p('converter')},
                ${p('sub1')}, ${p('sub2')}, ${p('sub3')}, ${p('item_type')}, ${p('used_when')},
                ${p('pos_item_id')}, ${p('request_unit')}, COALESCE(${p('plan_only')}, 0), ${p('sort_order')});`,
    params: {
      [`item_key${suffix}`]: it.key,
      [`item_code${suffix}`]: it.code,
      [`item_name${suffix}`]: it.name,
      [`unit${suffix}`]: it.unit || null,
      [`price${suffix}`]: it.price,
      [`status${suffix}`]: it.status || null,
      [`store_cat${suffix}`]: it.storeCat || null,
      [`converter${suffix}`]: it.converter,
      [`sub1${suffix}`]: it.subs[0] || null,
      [`sub2${suffix}`]: it.subs[1] || null,
      [`sub3${suffix}`]: it.subs[2] || null,
      [`item_type${suffix}`]: it.itemType,
      [`used_when${suffix}`]: it.usedWhen,
      [`plan_only${suffix}`]: it.planOnly,
      [`pos_item_id${suffix}`]: it.posItemId || null,
      [`request_unit${suffix}`]: it.requestUnit || null,
      [`sort_order${suffix}`]: it.sortOrder,
    },
  };
}

/** สาขาที่ใช้วัตถุดิบ — ลบของเดิมของรหัสนั้นก่อนแล้วใส่ชุดใหม่ทั้งชุด
 *  (สินค้าที่ถูกถอดออกจากสาขาหนึ่งต้องหายไปจริง ไม่งั้นสาขานั้นจะยังเห็นค้างอยู่ตลอดไป) */
export function itemBranchStmt(it, suffix = '') {
  const params = { [`item_key${suffix}`]: it.key };
  const values = it.branches.map((b, i) => {
    params[`b${i}${suffix}`] = b;
    return `(@item_key${suffix}, @b${i}${suffix})`;
  });
  return {
    text: `DELETE FROM dbo.stock_item_branch WHERE item_key = @item_key${suffix};
           ${values.length ? `INSERT INTO dbo.stock_item_branch (item_key, branch) VALUES ${values.join(', ')};` : ''}`,
    params,
  };
}

/** รวมหลายคำสั่งเป็นก้อนเดียว — ลดรอบวิ่งไป-กลับ (SQL Server รับได้สูงสุด 2100 พารามิเตอร์ต่อคำสั่ง) */
export function combine(stmts) {
  const text = stmts.map((s) => s.text).join('\n');
  const params = Object.assign({}, ...stmts.map((s) => s.params));
  return { text, params };
}

export const PARAM_LIMIT = 2000;

/* ---------------------------- อ่านชีทต้นทาง ---------------------------- */
// อ่านผ่าน export?format=csv (ค่าดิบตรงตามชีท) — ห้ามใช้ gviz เพราะ gviz เดาชนิดคอลัมน์
// แล้วทิ้งค่าที่ไม่ตรงชนิด เช่น รหัสเมนูที่เป็นข้อความในคอลัมน์ที่ส่วนใหญ่เป็นตัวเลข จะกลายเป็นช่องว่าง
// (เลขแท็บชุดเดียวกับ lib/qcrdSheet.js ที่หน้าเว็บใช้)
export const QCRD_SHEET_ID = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';
export const SHEET_GIDS = { group: '1491689317', menu: '0', bom: '419926693', item: '302875824' };

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** แถวข้อมูลของชุดหนึ่ง (ตัดหัวตารางออกแล้ว) — name = group | menu | bom | item */
export async function fetchSheetRows(name, { gid } = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('node รุ่นนี้ไม่มี fetch (ต้อง Node 18 ขึ้นไป) — อัปเดต node หรือย้ายข้อมูลด้วย scripts/migrate-qcrd.ps1 แทน');
  }
  const id = gid || SHEET_GIDS[name];
  if (!id) throw new Error(`ไม่รู้จักชุดข้อมูล ${name}`);
  const url = `https://docs.google.com/spreadsheets/d/${QCRD_SHEET_ID}/export?format=csv&gid=${encodeURIComponent(id)}`;
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  const text = await res.text();
  if (!res.ok || /^\s*</.test(text)) {
    throw new Error(`อ่านชีท ${name} ไม่ได้ (HTTP ${res.status}) — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`);
  }
  return parseCsv(text).slice(1);   // ทุกแท็บมีหัวตารางแถวเดียว
}

export const MAPPERS = { group: mapGroups, menu: mapMenus, bom: mapBomByMenu, item: mapItems };
export const BUILDERS = { group: groupStmt, menu: menuStmt, bom: bomStmt, item: itemStmt };
