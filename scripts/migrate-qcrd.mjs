#!/usr/bin/env node
/**
 * ย้ายข้อมูล QC/RD จาก Google Sheets (ชีทต้นทุนเมนู 1v8WRT…) เข้า MS SQL Server
 * ปลายทาง: ฐานข้อมูล InventoryNarai — ตัวเดียวกับที่หน้านับสต๊อกใช้ (dbo.stock_*)
 *
 * ย้าย 4 ชุด — โครงตารางและที่มาของแต่ละคอลัมน์อยู่ใน docs/schema-qcrd.sql
 *   group  ชีท 'menucodegroup' -> dbo.qcrd_menu_group
 *   menu   ชีท 'menu'          -> dbo.qcrd_menu
 *   bom    ชีท 'BOM'           -> dbo.qcrd_bom
 *   item   ชีท 'item'          -> dbo.stock_item (+ stock_item_branch) ในคอลัมน์ฝั่ง QC/RD
 *
 * วิธีใช้ (รันบนเครื่องที่ต่อ SQL Server ได้ — เครื่องเดียวกับที่รัน host-server)
 *   1) สร้างตารางก่อน:  sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัส>' -i docs\schema-qcrd.sql
 *   2) ตั้ง env การเชื่อมต่อ (ดูหัวข้อด้านล่าง)
 *   3) ดูก่อนว่าคอลัมน์ตรงกับที่โค้ดคาดไว้ไหม (ไม่แตะฐานข้อมูล):
 *        node scripts/migrate-qcrd.mjs --inspect
 *   4) ลองแบบไม่เขียนจริง:  node scripts/migrate-qcrd.mjs --dry-run
 *   5) ย้ายจริง:            node scripts/migrate-qcrd.mjs
 *
 * env ที่ใช้ (ถ้าไม่ตั้ง จะไล่ใช้ค่าของ host-server ที่ตั้งไว้อยู่แล้ว)
 *   QCRD_DB_SERVER   (หรือ DB_SERVER)    ค่าเริ่มต้น 'localhost\SQLEXPRESS'
 *   QCRD_DB_NAME     (หรือ STOCK_DB_NAME) ค่าเริ่มต้น 'InventoryNarai'
 *   QCRD_DB_USER     (หรือ DB_USER)
 *   QCRD_DB_PASSWORD (หรือ DB_PASSWORD)
 *
 * ตัวเลือก
 *   --dry-run          อ่านชีทและสรุปผลอย่างเดียว ไม่เขียนลงฐานข้อมูล
 *   --inspect          พิมพ์แถวแรก ๆ ของทุกชีทออกมาดิบ ๆ + รายงานรหัสวัตถุดิบซ้ำ
 *   --only=menu,bom    ย้ายเฉพาะบางชุด (group,menu,bom,item)
 *   --db=InventoryNarai ฐานข้อมูลปลายทาง
 *   --gid-menu=0       ระบุ gid ของแท็บเอง (มีครบ: --gid-menu --gid-bom --gid-item --gid-group)
 *
 * ข้อควรรู้
 * - อ่านชีทผ่าน export?format=csv เหมือน lib/qcrdSheet.js (ไม่ใช้ gviz เพราะ gviz เดาชนิดคอลัมน์
 *   แล้วทิ้งค่าที่ไม่ตรงชนิด เช่น รหัสเมนูที่เป็นข้อความในคอลัมน์ที่ส่วนใหญ่เป็นตัวเลข)
 * - รันซ้ำได้ ไม่เกิดข้อมูลซ้ำ: ทุกชุดเป็นทะเบียน ใช้ MERGE ทับของเดิม
 *   ส่วน qcrd_bom ลบสูตรเดิมของเมนูนั้นทั้งชุดก่อนใส่ใหม่ (เหมือน replaceMenuBomRows_)
 * - รหัสวัตถุดิบ/รหัสเมนูเทียบกันด้วยค่าที่ normalize แล้ว (ตัด 0 นำหน้า + ตัวพิมพ์เล็ก)
 *   เหมือน Apps Script ไม่งั้น '00123' กับ '123' จะกลายเป็นคนละตัว
 * - ชีท item มีรหัสซ้ำได้ (หน้า QC/RD ขึ้นเตือน "รหัสซ้ำ") แต่ SQL คีย์ด้วย item_key
 *   รหัสที่ซ้ำกันจะยุบเหลือแถวเดียว (แถวท้ายสุดของชีทชนะ) — --inspect บอกจำนวนให้ก่อนย้าย
 */

import process from 'node:process';

/* ---- ต้นทาง: ชีทต้นทุนเมนู (ค่าตรงกับ lib/qcrdSheet.js) ---- */
const QCRD_SS = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const INSPECT = args.includes('--inspect');
const DB_NAME = argVal('db', process.env.QCRD_DB_NAME || process.env.STOCK_DB_NAME || 'InventoryNarai');
const ONLY = String(argVal('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const wants = (part) => ONLY.length === 0 || ONLY.includes(part);

const SOURCES = {
  group: { sheet: 'menucodegroup', gid: argVal('gid-group', '1491689317') },
  menu: { sheet: 'menu', gid: argVal('gid-menu', '0') },
  bom: { sheet: 'BOM', gid: argVal('gid-bom', '419926693') },
  item: { sheet: 'item', gid: argVal('gid-item', '302875824') },
};

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
/* ต้องให้ผลตรงกับ normalizeId() ของ Apps Script และ normCode() ของ migrate-stock.mjs */
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
const TRUTHY = /^(y|yes|true|ture|1|ใช่)$/i;
const DEFAULT_CONVERTER = 1000;   // ตรงกับ lib/qcrdSheet.js และ buildBomRows_

/* --------------------------- อ่านชีทผ่าน export CSV --------------------------- */

function parseCsv(text) {
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

async function loadSheet(part) {
  const src = SOURCES[part];
  const url = `https://docs.google.com/spreadsheets/d/${QCRD_SS}/export?format=csv&gid=${encodeURIComponent(src.gid)}`;
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  const text = await res.text();
  if (!res.ok || /^\s*</.test(text)) {
    throw new Error(
      `อ่านชีท ${src.sheet} ไม่ได้ (HTTP ${res.status}) — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`
    );
  }
  const rows = parseCsv(text);
  return rows.slice(1);   // ทุกแท็บมีหัวตารางแถวเดียว (ฝั่งอ่านของเว็บก็ตัดแถวแรกเหมือนกัน)
}

/* ------------------------------ ต่อฐานข้อมูล ------------------------------ */

let pool = null;
async function getPool() {
  if (pool) return pool;
  let mssql;
  try {
    mssql = (await import('mssql')).default;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        "ยังไม่ได้ลง package 'mssql' — รัน npm install ที่โฟลเดอร์รีโปก่อน\n" +
        '  โหมด --inspect กับ --dry-run ใช้ได้เลยโดยไม่ต้องลง เพราะไม่แตะฐานข้อมูล'
      );
    }
    throw err;
  }
  const raw = process.env.QCRD_DB_SERVER || process.env.DB_SERVER || 'localhost\\SQLEXPRESS';
  const [host, instance] = raw.split('\\');
  const config = {
    server: host,
    database: DB_NAME,
    user: process.env.QCRD_DB_USER || process.env.DB_USER || 'sa',
    password: process.env.QCRD_DB_PASSWORD || process.env.DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
      ...(instance ? { instanceName: instance } : {}),
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 120000,
  };
  if (!instance) config.port = Number(process.env.QCRD_DB_PORT || process.env.DB_PORT) || 1433;
  try {
    pool = await new mssql.ConnectionPool(config).connect();
  } catch (err) {
    throw new Error(`ต่อ SQL Server (${raw}/${DB_NAME}) ไม่ได้: ${err.message}`);
  }
  pool.__sql = mssql;
  return pool;
}

/** ยิงคำสั่งเดียวพร้อมพารามิเตอร์ — ปล่อยให้ driver เดาชนิดจากค่า (เหมือน request().input(k, v)) */
async function run(text, params = {}) {
  const p = await getPool();
  const req = p.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
  return req.query(text);
}

async function runBatch(label, rows, buildStatement) {
  if (rows.length === 0) { console.log(`  ${label}: ไม่มีข้อมูล`); return; }
  if (DRY_RUN) {
    console.log(`  ${label}: ${rows.length} แถว (dry-run ไม่ได้เขียนลงฐานข้อมูล)`);
    console.log(`    ตัวอย่าง: ${JSON.stringify(rows[0])}`);
    return;
  }
  let done = 0;
  for (const row of rows) {
    const { text, params } = buildStatement(row);
    await run(text, params);
    done++;
    if (done % 50 === 0 || done === rows.length) process.stdout.write(`\r  ${label}: ${done}/${rows.length} แถว`);
  }
  console.log('');
}

/* --------------------------- ส่วนที่ย้ายแต่ละชุด --------------------------- */

/** ชีท 'menucodegroup': A=รหัสหมวด B=ชื่อหมวด */
async function migrateGroups() {
  const rows = await loadSheet('group');
  const groups = [];
  rows.forEach((r, index) => {
    const code = str(r[0]);
    const name = str(r[1]);
    if (!code || !name) return;
    groups.push({ code, name, sortOrder: index });
  });
  await runBatch('qcrd_menu_group', groups, (g) => ({
    text: `
      MERGE dbo.qcrd_menu_group AS t
      USING (SELECT @group_code AS group_code) AS s ON t.group_code = s.group_code
      WHEN MATCHED THEN UPDATE SET group_name = @group_name, sort_order = @sort_order, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (group_code, group_name, sort_order)
        VALUES (@group_code, @group_name, @sort_order);`,
    params: { group_code: g.code, group_name: g.name, sort_order: g.sortOrder },
  }));
}

/** ชีท 'menu': A=Code B=NameThai C=MenuCode D=UnitPrice E=cost F=สถานะ G=ปริมาณที่ได้ H=หน่วยที่ได้ */
async function migrateMenus() {
  const rows = await loadSheet('menu');
  const menus = [];
  const seen = new Set();
  let dup = 0;
  rows.forEach((r, index) => {
    const code = str(r[0]);
    if (!code) return;
    if (seen.has(code)) dup++;
    seen.add(code);
    menus.push({
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
  if (dup) console.log(`  ⚠️ รหัสเมนูซ้ำในชีท ${dup} แถว — แถวท้ายสุดจะทับแถวก่อนหน้า`);
  await runBatch('qcrd_menu', menus, (m) => ({
    text: `
      MERGE dbo.qcrd_menu AS t
      USING (SELECT @menu_code AS menu_code) AS s ON t.menu_code = s.menu_code
      WHEN MATCHED THEN UPDATE SET
        menu_key = @menu_key, menu_name = @menu_name, group_code = @group_code,
        price = @price, cost = @cost, status = @status,
        yield_qty = @yield_qty, yield_unit = @yield_unit, sort_order = @sort_order,
        updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (menu_code, menu_key, menu_name, group_code, price, cost, status, yield_qty, yield_unit, sort_order)
        VALUES (@menu_code, @menu_key, @menu_name, @group_code, @price, @cost, @status,
                @yield_qty, @yield_unit, @sort_order);`,
    params: {
      menu_code: m.code, menu_key: m.key, menu_name: m.name, group_code: m.group || null,
      price: m.price, cost: m.cost, status: m.status || null,
      yield_qty: m.yieldQty, yield_unit: m.yieldUnit || null, sort_order: m.sortOrder,
    },
  }));
}

/** ชีท 'BOM': A=เลขPOS B=ชื่อเมนู C=ลำดับ D=รหัส E=ชื่อ F=ยอดใช้ H=ตัวแปลง J=ราคา
 *  K/M=ต้นทุนต่อหน่วยเล็ก N=ต้นทุนแถว O–R=ที่มา S=แท็ก T=ไม่ตัด BOM */
async function migrateBom() {
  const rows = await loadSheet('bom');
  /* จัดกลุ่มตามเมนูก่อน เพราะฝั่งเขียนลบสูตรเดิมของเมนูนั้นทั้งชุดแล้วใส่ใหม่
     (ถ้าใส่ทีละแถวโดยไม่ลบก่อน สูตรเก่าที่ถูกถอดออกไปแล้วจะค้างอยู่ตลอดไป) */
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
  if (skipped) console.log(`  ข้ามแถว BOM ที่ไม่มีรหัสเมนูหรือรหัสวัตถุดิบ ${skipped} แถว`);

  const menus = [...byMenu.entries()].map(([menuCode, items]) => ({ menuCode, items }));
  console.log(`  qcrd_bom: ${menus.length} เมนู / ${menus.reduce((s, m) => s + m.items.length, 0)} แถว`);
  await runBatch('qcrd_bom', menus, (m) => {
    const params = { menu_code: m.menuCode };
    const values = m.items.map((it, i) => {
      Object.assign(params, {
        [`n${i}`]: it.menuName || null, [`q${i}`]: it.seq,
        [`c${i}`]: it.itemCode, [`k${i}`]: it.itemKey, [`m${i}`]: it.itemName || null,
        [`y${i}`]: it.qty, [`v${i}`]: it.converter, [`p${i}`]: it.itemPrice,
        [`u${i}`]: it.unitCost, [`l${i}`]: it.lineCost,
        [`sc${i}`]: it.srcCode || null, [`sn${i}`]: it.srcName || null,
        [`sf${i}`]: it.srcFactor, [`sb${i}`]: it.srcBase,
        [`tg${i}`]: it.tag || null, [`nd${i}`]: it.noDeduct,
      });
      return `(@menu_code, @n${i}, @q${i}, @c${i}, @k${i}, @m${i}, @y${i}, @v${i}, @p${i}, @u${i}, @l${i},`
        + ` @sc${i}, @sn${i}, @sf${i}, @sb${i}, @tg${i}, @nd${i})`;
    });
    return {
      text: `DELETE FROM dbo.qcrd_bom WHERE menu_code = @menu_code;
             INSERT INTO dbo.qcrd_bom
               (menu_code, menu_name, seq, item_code, item_key, item_name, qty, converter, item_price,
                unit_cost, line_cost, src_code, src_name, src_factor, src_base, tag, no_deduct)
             VALUES ${values.join(', ')};`,
      params,
    };
  });
}

/** ชีท 'item': A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ F,G,H=ไอเทมทดแทน I=ตัวแปลง
 *  J=สาขาที่ใช้ K=itemid(POS) L=หน่วยเบิก N=หมวดสโตร์ O=Plan/ประเภท P=ใช้กับ
 *
 *  คอลัมน์ K/L/plan_only เป็นของฝั่งสต๊อก — ที่นี่เขียนเฉพาะตอนสร้างแถวใหม่
 *  แถวที่มีอยู่แล้วจะไม่แตะ (COALESCE) เพื่อไม่ให้ค่าที่ฝั่งสต๊อกดูแลอยู่หายไป */
async function migrateItems() {
  const rows = await loadSheet('item');
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
      // คอลัมน์ O ถูกใช้ชนกันสองความหมาย — ดูจากค่าที่อยู่ในช่องว่าเป็นแบบไหนแล้วลงให้ถูกช่อง
      planOnly: TRUTHY.test(colO) ? 1 : null,
      itemType: TRUTHY.test(colO) ? null : (colO || null),
      usedWhen: str(r[15]) || null,
      sortOrder: index,
    });
  });
  if (skipped) console.log(`  ข้ามแถวที่ไม่มีรหัสวัตถุดิบ ${skipped} แถว`);
  if (dup) console.log(`  ⚠️ รหัสวัตถุดิบซ้ำ (หลัง normalize) ${dup} แถว — ยุบเหลือแถวท้ายสุดของแต่ละรหัส`);

  const items = [...byKey.values()];
  await runBatch('stock_item (คอลัมน์ฝั่ง QC/RD)', items, (it) => ({
    text: `
      MERGE dbo.stock_item AS t
      USING (SELECT @item_key AS item_key) AS s ON t.item_key = s.item_key
      WHEN MATCHED THEN UPDATE SET
        item_code = @item_code, item_name = @item_name, unit = @unit, price = @price,
        status = @status, store_cat = @store_cat, converter = @converter,
        sub_item1 = @sub1, sub_item2 = @sub2, sub_item3 = @sub3,
        item_type = COALESCE(@item_type, t.item_type),
        used_when = COALESCE(@used_when, t.used_when),
        plan_only = COALESCE(@plan_only, t.plan_only),
        sort_order = @sort_order, updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (item_key, item_code, item_name, unit, price, status, store_cat, converter,
         sub_item1, sub_item2, sub_item3, item_type, used_when,
         pos_item_id, request_unit, plan_only, sort_order)
        VALUES (@item_key, @item_code, @item_name, @unit, @price, @status, @store_cat, @converter,
                @sub1, @sub2, @sub3, @item_type, @used_when,
                @pos_item_id, @request_unit, COALESCE(@plan_only, 0), @sort_order);`,
    params: {
      item_key: it.key, item_code: it.code, item_name: it.name,
      unit: it.unit || null, price: it.price, status: it.status || null,
      store_cat: it.storeCat || null, converter: it.converter,
      sub1: it.subs[0] || null, sub2: it.subs[1] || null, sub3: it.subs[2] || null,
      item_type: it.itemType, used_when: it.usedWhen, plan_only: it.planOnly,
      pos_item_id: it.posItemId || null, request_unit: it.requestUnit || null,
      sort_order: it.sortOrder,
    },
  }));

  // สาขาที่ใช้วัตถุดิบ — ลบของเดิมของรหัสนั้นก่อนแล้วใส่ชุดใหม่ทั้งชุด
  const branchRows = items.filter((it) => it.branches.length > 0);
  await runBatch('stock_item_branch', branchRows, (it) => {
    const params = { item_key: it.key };
    const values = it.branches.map((b, i) => { params[`b${i}`] = b; return `(@item_key, @b${i})`; });
    return {
      text: `DELETE FROM dbo.stock_item_branch WHERE item_key = @item_key;
             INSERT INTO dbo.stock_item_branch (item_key, branch) VALUES ${values.join(', ')};`,
      params,
    };
  });
}

/* ------------------------------- โหมดตรวจ ------------------------------- */

async function inspectSheets() {
  for (const part of Object.keys(SOURCES)) {
    if (!wants(part)) continue;
    const rows = await loadSheet(part);
    console.log(`\n=== ${part} (${SOURCES[part].sheet}) — ${rows.length} แถว ===`);
    rows.slice(0, 3).forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r.slice(0, 20))}`));
  }

  // รหัสซ้ำเป็นเรื่องที่ต้องรู้ก่อนย้าย เพราะ SQL คีย์ด้วย item_key จะยุบให้เหลือแถวเดียว
  if (wants('item')) {
    const rows = await loadSheet('item');
    const count = new Map();
    rows.forEach((r) => {
      const k = normCode(r[0]);
      if (k) count.set(k, (count.get(k) || 0) + 1);
    });
    const dups = [...count.entries()].filter(([, n]) => n > 1);
    console.log(`\n=== รหัสวัตถุดิบซ้ำ (หลัง normalize) ${dups.length} รหัส ===`);
    dups.slice(0, 20).forEach(([k, n]) => console.log(`  ${k} × ${n}`));
    if (dups.length > 20) console.log(`  … อีก ${dups.length - 20} รหัส`);
  }

  // สูตรที่อ้างวัตถุดิบซึ่งไม่มีในชีท item — ย้ายไปแล้วจะกลายเป็นแถวที่ join ไม่เจอ
  if (wants('bom') && wants('item')) {
    const [bomRows, itemRows] = await Promise.all([loadSheet('bom'), loadSheet('item')]);
    const known = new Set(itemRows.map((r) => normCode(r[0])).filter(Boolean));
    const missing = new Set();
    bomRows.forEach((r) => {
      const k = normCode(r[3]);
      if (k && !known.has(k)) missing.add(k);
    });
    console.log(`\n=== วัตถุดิบในสูตรที่ไม่มีในชีท item: ${missing.size} รหัส ===`);
    [...missing].slice(0, 20).forEach((k) => console.log(`  ${k}`));
  }
}

/* --------------------------------- main --------------------------------- */

async function main() {
  console.log(`ต้นทาง: ชีท ${QCRD_SS}`);
  if (INSPECT) { await inspectSheets(); return; }
  console.log(`ปลายทาง: ${DB_NAME}${DRY_RUN ? ' (dry-run)' : ''}`);

  if (wants('group')) { console.log('\n[หมวดหมู่เมนู]'); await migrateGroups(); }
  if (wants('menu')) { console.log('\n[เมนู]'); await migrateMenus(); }
  if (wants('bom')) { console.log('\n[สูตร BOM]'); await migrateBom(); }
  if (wants('item')) { console.log('\n[วัตถุดิบ]'); await migrateItems(); }

  console.log('\nเสร็จแล้ว');
}

main()
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(async () => { if (pool) await pool.close(); });
