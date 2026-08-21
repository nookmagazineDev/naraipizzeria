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

// ตรรกะทั้งหมด (คิดต้นทุน/แทนที่สูตร/cascade/ทุก action) อยู่ใน lib/qcrdSql.js
// ไฟล์นี้เหลือแค่ "ต่อฐานข้อมูล + เปิดเป็น endpoint" เพื่อให้ฝั่ง Vercel ที่ต่อ SQL ตรง
// (lib/qcrdPool.js) ใช้ตรรกะชุดเดียวกันเป๊ะ ไม่ต้องมีสองสำเนาให้แก้ตามกันทีหลัง
//
// โหลดแบบ dynamic import เพราะไฟล์นั้นเป็น ESM ส่วนไฟล์นี้เป็น CommonJS
// (ตั้งชื่อเป็น .mjs เพื่อให้ node รุ่นเก่ารู้แน่นอนว่าเป็น ESM — .js ในแพ็กเกจนี้ถูกมองเป็น CJS)
let corePromise = null;
function getCore() {
  if (!corePromise) {
    corePromise = import('../lib/qcrdSql.mjs')
      .then(m => m.createQcrd({ q, withTx }))
      .catch(err => { corePromise = null; throw err; });
  }
  return corePromise;
}

const str = v => (v === null || v === undefined ? '' : String(v).trim());

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

// ส่งออก q ด้วย เพื่อให้ sheets-db.js ใช้ pool เดียวกันได้ (ฐาน InventoryNarai ตัวเดียวกันเป๊ะ)
// ไม่ต้องต่อซ้ำสองครั้ง และไม่ต้องตั้ง env ชุดที่สองให้สับสน
module.exports = { mountQcrd, getPool, getCore, q, withTx };
