// ════════════════════════════════════════════════════════════
//  ร้านเฟรนไชส์ — ฐาน "Aoringo" บน SQL Server เครื่องเดียวกัน (203.154.185.48)
//
//  ทางถอยของหน้าเมนู "เฟรนไชส์" สำหรับตอนที่ Vercel ต่อ SQL ตรงไม่ติด
//  (ที่ร้านเปิดไฟร์วอลล์ให้เฉพาะ IP ในไทย — ปัญหาเดียวกับ /sheets/* และ /qcrd/*)
//  ตรรกะการจับคู่ตาราง/คอลัมน์เป็นไฟล์เดียวกับฝั่ง Vercel: lib/aoringoSql.mjs
//
//  endpoint (อ่านอย่างเดียว — เมนูนี้ไม่มีฝั่งเขียน จึงไม่ต้องมีกุญแจ)
//    GET /aoringo/ping                                  ต่อฐานได้ไหม + จับคู่ตารางได้อะไรบ้าง
//    GET /aoringo/schema                                ตาราง/คอลัมน์ทั้งหมดที่จับคู่ได้
//    GET /aoringo/sales?start=YYYY-MM-DD&end=YYYY-MM-DD   บิลขาย
//    GET /aoringo/detail?start=…&end=…                    รายการสินค้าในบิล
//    GET /aoringo/expense?start=…&end=…                   รายจ่าย
//
//  ตั้งค่าเชื่อมต่อ (ไม่ตั้ง = ใช้ค่าเดียวกับ QC/RD แต่เปลี่ยนฐานเป็น Aoringo):
//    AORINGO_DB_SERVER · AORINGO_DB_NAME (ค่าเริ่มต้น Aoringo) · AORINGO_DB_USER/PASSWORD
// ════════════════════════════════════════════════════════════
const sql = require('mssql');

// ── ต่อฐาน Aoringo (เครื่องเดียวกับ NaraiPos/InventoryNarai แต่คนละฐานข้อมูล) ──
const RAW_SERVER = process.env.AORINGO_DB_SERVER || process.env.QCRD_DB_SERVER ||
  process.env.DB_SERVER || 'localhost\\SQLEXPRESS';
const [aHost, aInstance] = RAW_SERVER.split('\\');
const aoringoConfig = {
  server: aHost,
  database: process.env.AORINGO_DB_NAME || 'Aoringo',
  user: process.env.AORINGO_DB_USER || process.env.QCRD_DB_USER || process.env.DB_USER || 'SA',
  password: process.env.AORINGO_DB_PASSWORD || process.env.QCRD_DB_PASSWORD || process.env.DB_PASSWORD || '',
  requestTimeout: 60000,   // ดึงบิลทั้งเดือนหนักกว่าคำสั่งของ QC/RD ที่ทีละไม่กี่ร้อยแถว
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    useUTC: true,          // คืน datetime ตรงตามค่าที่เก็บ (ตรงกับที่ฝั่ง Vercel อ่านได้)
    ...(aInstance ? { instanceName: aInstance } : {}),
  },
  pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
};
if (!aInstance) aoringoConfig.port = Number(process.env.AORINGO_DB_PORT || process.env.QCRD_DB_PORT || process.env.DB_PORT) || 1433;

// ต่อแบบ lazy เหมือน ZKBio/QC-RD — ยังไม่มีฐาน Aoringo ที่เครื่องนี้ก็ไม่กระทบ endpoint อื่น
let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(aoringoConfig).connect()
      .then(pool => { console.log(`✅ ต่อ Aoringo DB สำเร็จ (${RAW_SERVER}/${aoringoConfig.database})`); return pool; })
      .catch(err => {
        poolPromise = null;   // ให้ request ถัดไปลองต่อใหม่ได้
        console.error('❌ ต่อ Aoringo DB ไม่ได้:', err.message);
        throw new Error(`ต่อฐานข้อมูลเฟรนไชส์ (${RAW_SERVER}/${aoringoConfig.database}) ไม่ได้: ${err.message}`);
      });
  }
  return poolPromise;
}

/** ยิง query พร้อมพารามิเตอร์ */
async function q(text, params = {}) {
  const req = (await getPool()).request();
  for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
  const r = await req.query(text);
  return r.recordset || [];
}

// ตรรกะชุดเดียวกับฝั่ง Vercel — โหลดแบบ dynamic import เพราะเป็นไฟล์ ESM (.mjs) ใน CommonJS
let corePromise = null;
function getCore() {
  if (!corePromise) {
    corePromise = import('../lib/aoringoSql.mjs')
      .then(m => m.createAoringo({ q }))
      .catch(err => { corePromise = null; throw err; });
  }
  return corePromise;
}

const str = v => (v === null || v === undefined ? '' : String(v).trim());

function mountAoringo(app) {
  const send = (res, promise, label) =>
    promise
      .then(data => res.json({ status: 'success', data }))
      .catch(err => {
        console.error(`aoringo ${label} error:`, err.message);
        res.status(500).json({ status: 'error', message: err.message });
      });

  const range = req => ({
    start: str(req.query.start),
    end: str(req.query.end),
    outlet: str(req.query.outlet),
    limit: req.query.limit,
  });

  app.get('/aoringo/ping', (req, res) => send(res, getCore().then(c => c.ping()), 'ping'));

  app.get('/aoringo/schema', (req, res) =>
    send(res, getCore().then(c => c.readLayout({ force: true })), 'schema'));

  app.get('/aoringo/sales', (req, res) =>
    send(res, getCore().then(c => c.readBills(range(req))), 'sales'));

  app.get('/aoringo/detail', (req, res) =>
    send(res, getCore().then(c => c.readItems(range(req))), 'detail'));

  app.get('/aoringo/expense', (req, res) =>
    send(res, getCore().then(c => c.readExpenses(range(req))), 'expense'));
}

module.exports = { mountAoringo };
