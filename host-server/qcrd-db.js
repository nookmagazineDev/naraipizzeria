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
//    GET  /qcrd/migrate?key=..&step=..     ย้ายข้อมูลจากชีทเข้า SQL (ทำที่เครื่องนี้ เปิดจากเบราว์เซอร์ได้)
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

// ตรรกะทั้งหมด (คิดต้นทุน/แทนที่สูตร/cascade/ทุก action) อยู่ใน lib/qcrdSql.js
// ไฟล์นี้เหลือแค่ "ต่อฐานข้อมูล + เปิดเป็น endpoint" เพื่อให้ฝั่ง Vercel ที่ต่อ SQL ตรง
// (lib/qcrdPool.js) ใช้ตรรกะชุดเดียวกันเป๊ะ ไม่ต้องมีสองสำเนาให้แก้ตามกันทีหลัง
//
// โหลดแบบ dynamic import เพราะไฟล์นั้นเป็น ESM ส่วนไฟล์นี้เป็น CommonJS
// (ตั้งชื่อเป็น .mjs เพื่อให้ node รุ่นเก่ารู้แน่นอนว่าเป็น ESM — .js ในแพ็กเกจนี้ถูกมองเป็น CJS)
//
// หาไฟล์สองที่: ในรีโป (../lib/) กับข้าง ๆ ไฟล์นี้ (./) เพราะเครื่องที่ออฟฟิศบางเครื่อง
// รัน API จากโฟลเดอร์ที่ก๊อปมาเฉพาะไฟล์ ไม่ได้เช็กเอาต์ทั้งรีโป
async function importFirst(paths) {
  let lastErr;
  for (const p of paths) {
    try { return await import(p); } catch (err) { lastErr = err; }
  }
  throw new Error(`หาไฟล์ ${paths[0]} ไม่เจอ (ลองแล้ว: ${paths.join(', ')}) — ${lastErr?.message || ''}`);
}

let corePromise = null;
function getCore() {
  if (!corePromise) {
    corePromise = importFirst(['../lib/qcrdSql.mjs', './qcrdSql.mjs'])
      .then(m => m.createQcrd({ q, withTx }))
      .catch(err => { corePromise = null; throw err; });
  }
  return corePromise;
}

/** ตัวย้ายข้อมูล (โหลดเมื่อเรียก /qcrd/migrate เท่านั้น) */
let migratePromise = null;
function getMigrate() {
  if (!migratePromise) {
    migratePromise = importFirst(['../lib/qcrdMigrate.mjs', './qcrdMigrate.mjs'])
      .catch(err => { migratePromise = null; throw err; });
  }
  return migratePromise;
}

const str = v => (v === null || v === undefined ? '' : String(v).trim());

/* ─────────────────────── ย้ายข้อมูลจากชีท (ทำที่เครื่องนี้) ─────────────────────── */

/** หาไฟล์สคีมา ทั้งแบบอยู่ในรีโปและแบบก๊อปมาไว้ข้าง ๆ server.js */
function schemaFile() {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(__dirname, '..', 'docs', 'schema-qcrd.sql'),
    path.join(__dirname, 'schema-qcrd.sql'),
    path.join(process.cwd(), 'schema-qcrd.sql'),
  ];
  const hit = candidates.find(f => fs.existsSync(f));
  if (!hit) throw new Error(`หาไฟล์ schema-qcrd.sql ไม่เจอ (ลองแล้ว: ${candidates.join(' , ')})`);
  return { fs, file: hit };
}

/**
 * ย้ายข้อมูลทีละชุด — เครื่องนี้ไม่มีลิมิตเวลาเหมือน Vercel จึงทำจบในรอบเดียวได้
 * ไม่ใส่ confirm = อ่านชีทแล้วบอกจำนวนแถวเฉย ๆ ไม่เขียนอะไร
 */
async function migrateStep(step, confirm) {
  const M = await getMigrate();

  if (step === 'check') {
    const rows = await q(`
      SELECT DB_NAME() AS db, SUSER_SNAME() AS login_name,
             OBJECT_ID(N'dbo.stock_item') AS has_stock_item,
             OBJECT_ID(N'dbo.qcrd_menu') AS has_qcrd_menu`);
    const r = rows[0] || {};
    const tablesReady = Boolean(r.has_qcrd_menu);
    return {
      step, loginName: str(r.login_name), stockItemExists: Boolean(r.has_stock_item), tablesReady,
      menusInSql: tablesReady ? Number((await q('SELECT COUNT(*) AS n FROM dbo.qcrd_menu'))[0]?.n) || 0 : undefined,
      hint: tablesReady
        ? 'ตารางพร้อมแล้ว — เรียก &step=group&confirm=1 แล้วไล่ไป menu, bom, item, verify ตามลำดับ'
        : 'ยังไม่มีตาราง — เรียก &step=schema&confirm=1 ก่อน',
    };
  }

  if (step === 'schema') {
    const { fs, file } = schemaFile();
    const batches = fs.readFileSync(file, 'utf8')
      .split(/^\s*GO\s*;?\s*$/gim).map(b => b.trim()).filter(Boolean)
      .filter(b => !/CREATE\s+DATABASE|^\s*USE\s+/im.test(b));   // ต่อเข้าฐานนั้นอยู่แล้ว
    if (!confirm) return { step, file, wouldRun: batches.length, note: 'ใส่ &confirm=1 เพื่อสร้างตารางจริง' };
    const pool = await getPool();
    let ok = 0;
    for (const b of batches) { await pool.request().batch(b); ok++; }
    return { step, file, ran: ok, done: true };
  }

  if (step === 'verify') {
    const count = async (text) => Number((await q(text))[0]?.n) || 0;
    const [g, m, b, i] = await Promise.all(['group', 'menu', 'bom', 'item'].map(n => M.fetchSheetRows(n)));
    const checks = [
      { label: 'หมวดหมู่เมนู', sheet: M.mapGroups(g).rows.length, sql: await count('SELECT COUNT(*) AS n FROM dbo.qcrd_menu_group') },
      { label: 'เมนู', sheet: M.mapMenus(m).rows.length, sql: await count('SELECT COUNT(*) AS n FROM dbo.qcrd_menu') },
      { label: 'แถวสูตร BOM', sheet: M.mapBomByMenu(b).stats.bomRows, sql: await count('SELECT COUNT(*) AS n FROM dbo.qcrd_bom') },
      { label: 'วัตถุดิบ', sheet: M.mapItems(i).rows.length, sql: await count('SELECT COUNT(*) AS n FROM dbo.stock_item') },
    ].map(c => ({ ...c, ok: c.sql >= c.sheet }));
    return {
      step, ready: checks.every(c => c.ok), checks,
      bomItemsMissingFromRegistry: await count(`
        SELECT COUNT(DISTINCT b.item_key) AS n FROM dbo.qcrd_bom b
        LEFT JOIN dbo.stock_item i ON i.item_key = b.item_key WHERE i.item_key IS NULL`),
    };
  }

  if (!M.MAPPERS[step]) throw new Error(`ไม่รู้จัก step=${step}`);

  const rows = await M.fetchSheetRows(step);
  const mapped = M.MAPPERS[step](rows);
  if (!confirm) {
    return { step, sheetRows: rows.length, records: mapped.rows.length, ...mapped.stats,
             note: 'ใส่ &confirm=1 เพื่อเขียนลงฐานจริง' };
  }

  // รวมหลายแถวเป็นคำสั่งเดียวเท่าที่พารามิเตอร์ยังไม่เกินลิมิตของ SQL Server
  const build = M.BUILDERS[step];
  let done = 0, batches = 0;
  while (done < mapped.rows.length) {
    const stmts = [];
    let params = 0;
    while (done + stmts.length < mapped.rows.length) {
      const st = build(mapped.rows[done + stmts.length], `_${stmts.length}`);
      const n = Object.keys(st.params).length;
      if (stmts.length && params + n > M.PARAM_LIMIT) break;
      stmts.push(st); params += n;
    }
    const c = M.combine(stmts);
    await q(c.text, c.params);
    done += stmts.length; batches++;
  }
  const out = { step, records: mapped.rows.length, written: done, batches, done: true, ...mapped.stats };

  if (step === 'item') {   // สาขาที่ใช้วัตถุดิบเป็นอีกตารางหนึ่ง เขียนตามหลังทะเบียน
    let bDone = 0;
    for (const it of mapped.rows.filter(x => x.branches.length > 0)) {
      const st = M.itemBranchStmt(it);
      await q(st.text, st.params);
      bDone++;
    }
    out.branchRows = bDone;
  }
  return out;
}

/* ─────────────────────────── ต่อเข้ากับ express ─────────────────────────── */

function mountQcrd(app) {
  const WRITE_KEY = process.env.QCRD_WRITE_KEY || '';

  const send = (res, promise, label) =>
    promise
      .then(data => res.json({ status: 'success', data }))
      .catch(err => {
        console.error(`qcrd ${label} error:`, err.message);
        res.status(err.badRequest ? 400 : 500).json({ status: 'error', message: err.message });
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

  const read = (name) => (req, res) => send(res, getCore().then(c => c[name]()), name);
  app.get('/qcrd/menu', read('readMenus'));
  app.get('/qcrd/bom', read('readBom'));
  app.get('/qcrd/item', read('readItems'));
  app.get('/qcrd/menugroup', read('readMenuGroups'));

  // ── ย้ายข้อมูลจากชีท -> SQL (ทำที่เครื่องนี้ เพราะต่อ SQL ได้ตรงและเปิดเน็ตอ่านชีทได้) ──
  //    เปิดจากเบราว์เซอร์ได้เลย: /qcrd/migrate?key=<QCRD_WRITE_KEY>&step=check
  //    step: check | schema | group | menu | bom | item | verify   (ต้องมี &confirm=1 ถึงจะเขียนจริง)
  app.get('/qcrd/migrate', async (req, res) => {
    if (!WRITE_KEY) {
      return res.status(503).json({ status: 'error', message: 'ยังไม่ได้ตั้ง env QCRD_WRITE_KEY บนเครื่องนี้' });
    }
    if (str(req.query.key) !== WRITE_KEY) {
      return res.status(401).json({ status: 'error', message: 'key ไม่ถูกต้อง' });
    }
    const step = str(req.query.step) || 'check';
    const confirm = String(req.query.confirm || '') === '1';
    const t0 = Date.now();
    try {
      const data = await migrateStep(step, confirm);
      res.json({ status: 'success', db: `${RAW_SERVER}/${qcrdConfig.database}`, tookMs: Date.now() - t0, ...data });
    } catch (err) {
      console.error(`qcrd migrate ${step} error:`, err.message);
      res.status(500).json({ status: 'error', step, tookMs: Date.now() - t0, message: err.message });
    }
  });

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
    const action = str(body.action);
    return send(res, getCore().then(core => {
      const fn = core.actions[action];
      if (!fn) throw Object.assign(new Error(`unknown action: ${action}`), { badRequest: true });
      return fn(body);
    }), action);
  });
}

module.exports = { mountQcrd, getPool, getCore };
