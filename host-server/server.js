// ════════════════════════════════════════════════════════════
//  Narai API — ตัวกลางระหว่าง Dashboard กับ SQL Server (NaraiPos)
//  รันบนเครื่อง Windows Server เครื่องเดียวกับ SQL Server
//  ต่อ DB แบบ localhost (ไม่ต้องเปิด port 1433 ออกเน็ต)
//  เปิดออกเน็ตผ่าน ngrok:  ngrok http 14365
//
//  endpoint ที่ Dashboard ใช้:
//    GET /ctranbetweendate?start=YYYY-MM-DD&end=YYYY-MM-DD   → รายการสินค้า (dbo.Ctrans)
//    GET /cpaidbetweendate?start=YYYY-MM-DD&end=YYYY-MM-DD   → รายบิล/การชำระ (ตารางบิล)
//  endpoint ZKBio Time 9 (เครื่องสแกนนิ้ว — ฐานข้อมูลแยกบน SQLEXPRESS):
//    GET /zk/transactions?start=YYYY-MM-DD&end=YYYY-MM-DD[&emp=รหัส][&area=รหัสสาขา] → log สแกนนิ้ว
//    GET /zk/employees           → รายชื่อพนักงานในเครื่องสแกน + แผนก
//    GET /zk/ping /zk/tables /zk/columns /zk/sample → debug ฐาน ZKBio
//  endpoint QC/RD (เมนู/สูตร BOM/วัตถุดิบ — ฐาน InventoryNarai ตัวเดียวกับหน้านับสต๊อก):
//    GET  /qcrd/menu | /qcrd/bom | /qcrd/item | /qcrd/menugroup → ข้อมูลที่หน้า QC/RD ใช้
//    POST /qcrd/save  { action, ... }  → เพิ่ม/แก้/ลบ (ต้องมี header x-api-key = QCRD_WRITE_KEY)
//    GET  /qcrd/ping             → เช็กว่าต่อฐาน InventoryNarai ได้ไหม + เขียนได้ไหม
//    GET  /sheets/plan | /sheets/closing?branch=… | /sheets/expense-ref | /sheets/expense
//         | /sheets/employee        → แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน
//    POST /sheets/save { action, ... } → บันทึกค่าใช้จ่าย/แก้ข้อมูลพนักงาน (ต้องมี x-api-key)
//    GET  /sheets/ping           → เช็กว่าตาราง 5 ตารางพร้อมไหม + เขียนได้ไหม
//  endpoint ร้านเฟรนไชส์ (ฐาน Aoringo บนเครื่องเดียวกัน — ดู docs/franchise-aoringo.md):
//    GET  /aoringo/ping | /aoringo/schema  → ต่อฐานได้ไหม + ตาราง/คอลัมน์ที่จับคู่ได้
//    GET  /aoringo/sales | /aoringo/detail | /aoringo/expense?start=…&end=…  → บิล/รายการ/รายจ่าย
//    GET  /aoringo/activity?start=…&end=…  → ประวัติออเดอร์ (OrderActivity)
//  endpoint ช่วย debug:
//    GET /tables                 → รายชื่อตารางทั้งหมด
//    GET /columns?table=ชื่อ      → คอลัมน์ของตาราง (default = Ctrans)
//    GET /sample?table=ชื่อ       → ตัวอย่าง 1 แถว (แปลงชื่อคอลัมน์แล้ว)
//    GET /pos/latest[?days=14]   → ฐาน/เครื่องที่เส้นนี้ต่ออยู่จริง + บิลล่าสุด + บิลต่อวัน
//    GET /ping                   → เช็กว่า API ยังมีชีวิต
//
//  *** ไม่มี API key — ใครเข้าถึง URL ได้ก็ดึงข้อมูลได้ ***
// ════════════════════════════════════════════════════════════
const os = require('os');
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const compression = require('compression'); // บีบ JSON ด้วย gzip → ส่งผ่าน ngrok เร็วขึ้นมาก
const { mountQcrd } = require('./qcrd-db'); // QC/RD บน InventoryNarai (ดู docs/schema-qcrd.sql)
const { mountSheets } = require('./sheets-db'); // แพลน/ปิดรอบ/ค่าใช้จ่าย/พนักงาน (ดู docs/schema-sheets.sql)
const { mountAoringo } = require('./aoringo-db'); // ร้านเฟรนไชส์ บนฐาน Aoringo (ดู docs/franchise-aoringo.md)
const { mountAuth } = require('./auth-db');      // ผู้ใช้และสิทธิ์เมนู (ดู docs/login-permissions.md)

const app = express();
app.use(compression()); // ต้องมาก่อน route
app.use(cors());
// เครื่องที่ร้านมี API ตัวอื่นของโปรเจค Narai-branch (office-server) รันอยู่ด้วย
// ถ้าพอร์ตชนกันให้ตั้ง env PORT ก่อนรัน เช่น  $env:PORT = '14366'  (ค่าเริ่มต้นคือ 14365)
const PORT = Number(process.env.PORT) || 14365;

// ── ตารางที่เก็บข้อมูล "รายบิล/การชำระ" (cpaidbetweendate) ──
//    ตารางจริง = dbo.Cpaid / คอลัมน์วันที่ปิดบิล = Date
//    ช่องทางจ่ายเก็บเป็น _Credit/_QR/_Cash/... → alias เป็น credit/qr/cash/... ให้ตรงกับ frontend
const PAID_TABLE = 'dbo.Cpaid';
const PAID_DATE_COL = 'Date';

// ── ตั้งค่าเชื่อม SQL Server (อยู่เครื่องเดียวกัน → ใช้ localhost) ──
// ⚠️ อย่าฝังรหัสผ่านจริงในไฟล์ที่ push ขึ้น git (repo เป็น public)
//    ตั้งค่าผ่าน environment variable บนเครื่องโฮสต์ เช่น:
//    set DB_PASSWORD=xxxx  (Windows cmd)  แล้วค่อย node server.js
const dbConfig = {
  server: process.env.DB_SERVER || 'localhost', // named instance: 'localhost\\SQLEXPRESS' (แล้วลบ port)
  port: Number(process.env.DB_PORT) || 1433,
  database: process.env.DB_NAME || 'NaraiPos',
  user: process.env.DB_USER || 'SA',
  password: process.env.DB_PASSWORD || '',       // ใส่ค่าจริงผ่าน env เท่านั้น
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    useUTC: true,              // คืน datetime ตรงตามค่าที่เก็บ (ไม่บวกลบ timezone)
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  // ⚠️ ค่า default ของ mssql คือ 15 วินาที — สั้นเกินไปสำหรับเครื่องที่ร้าน
  //    /cpaidbetweendate วันเดียวใช้เวลาถึง 125 วิ (ดู docs/fix-slow-sales-index.sql)
  //    คำสั่งจึงถูกตัดทิ้งกลางทางแล้วตอบ HTTP 500 กลับไป ทั้งที่คำสั่งไม่ได้ผิดอะไร
  //    ตั้งให้ยาวกว่าฝั่ง Vercel ที่รอ 55 วิ เพื่อให้ "ใครหมดเวลาก่อน" อ่านง่าย:
  //    ถ้าหน้าเว็บขึ้นว่า host API ไม่ตอบ = ช้าจริง ไม่ใช่โดน SQL ตัดทิ้ง
  //    แต่ไม่ตั้งยาวเว่อร์ — เกิน 55 วิไปแล้วไม่มีใครรออ่านผลอยู่ ปล่อยให้ query
  //    วิ่งต่อมีแต่กินซีพียูของเครื่อง 2 คอร์ไปเปล่า ๆ
  requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT) || 90000,
  connectionTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 15000,
};

// connection pool ใช้ซ้ำ ไม่ต้องต่อใหม่ทุก request
//
// เดิมต่อครั้งเดียวตอนบูตแล้วเก็บ promise ไว้ตรง ๆ — ถ้าตอนนั้น SQL Server ยังไม่ขึ้น
// (Windows บูตเสร็จก่อน service ของ SQL · เครื่องเพิ่งตื่นจาก sleep) promise จะค้างสถานะ
// rejected ถาวร ทุกคำขอหลังจากนั้นพังหมดทั้งวัน จนกว่าคนจะไปรีสตาร์ต host-server เอง
// → ต่อแบบ lazy + ล้างทิ้งเมื่อพัง เหมือน getZkPool()/QC-RD/Aoringo ให้คำขอถัดไปลองใหม่ได้เอง

/** pool ที่ยังใช้งานได้ไหม (mssql รุ่นที่ไม่มี flag นี้จะได้ undefined = ถือว่าใช้ได้ เท่าพฤติกรรมเดิม) */
const isPoolUsable = pool => !!pool && (pool.connected !== false || pool.connecting === true);

let poolPromise = null;
function connectPool() {
  if (!poolPromise) {
    const attempt = new sql.ConnectionPool(dbConfig).connect()
      .then(pool => {
        console.log('✅ ต่อ SQL Server สำเร็จ');
        // pool ที่เคยต่อติดแล้วตายทีหลัง (SQL restart · เครื่อง sleep · สาย LAN หลุด)
        // จะยิง event 'error' ออกมา — ทิ้งตัวที่ตายแล้วเพื่อให้คำขอถัดไปต่อใหม่
        pool.on('error', err => {
          console.error('⚠️ pool ของ SQL Server มีปัญหา:', err.message);
          if (poolPromise === attempt) poolPromise = null;
        });
        return pool;
      })
      .catch(err => {
        if (poolPromise === attempt) poolPromise = null;   // ให้ request ถัดไปลองต่อใหม่ได้
        console.error('❌ ต่อ SQL Server ไม่ได้:', err.message);
        throw new Error(`ต่อฐานข้อมูล ${dbConfig.server}/${dbConfig.database} ไม่ได้: ${err.message}`);
      });
    poolPromise = attempt;
  }
  return poolPromise;
}

/** pool ที่ใช้ได้จริง — ตัวที่ถูกปิดไปแล้วไม่ยิง event 'error' เสมอไป ต้องเช็กเองด้วย */
async function getPool() {
  const attempt = connectPool();
  const pool = await attempt;
  if (isPoolUsable(pool)) return pool;
  if (poolPromise === attempt) poolPromise = null;
  return connectPool();
}

// ลองต่อตั้งแต่บูตเพื่อให้เห็นผลใน log ทันที (ต่อไม่ติดก็ไม่เป็นไร คำขอแรกจะลองใหม่เอง)
connectPool().catch(() => {});

// ── ZKBio Time 9 (เครื่องสแกนนิ้ว) — ฐานข้อมูลแยกอีกตัว มักอยู่บน named instance SQLEXPRESS ──
//    ตั้งค่าผ่าน env:  ZK_DB_SERVER (default localhost\SQLEXPRESS), ZK_DB_NAME (default ZKBio9),
//    ZK_DB_USER / ZK_DB_PASSWORD (ถ้าไม่ตั้ง ใช้ user/รหัสเดียวกับ NaraiPos)
//    named instance ต้องเปิด service "SQL Server Browser" บนเครื่องด้วย ไม่งั้นหา instance ไม่เจอ
const ZK_SERVER_RAW = process.env.ZK_DB_SERVER || 'localhost\\SQLEXPRESS';
const [zkHost, zkInstance] = ZK_SERVER_RAW.split('\\');
const zkConfig = {
  server: zkHost,
  database: process.env.ZK_DB_NAME || 'ZKBio9',
  user: process.env.ZK_DB_USER || process.env.DB_USER || 'SA',
  password: process.env.ZK_DB_PASSWORD || process.env.DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    useUTC: true,
    // มี instance name → ให้ SQL Browser หา port เอง (ห้ามตั้ง port ซ้ำ)
    ...(zkInstance ? { instanceName: zkInstance } : {}),
  },
  pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
  // เหตุผลเดียวกับ dbConfig — ดึง log สแกนนิ้วทุกสาขาทั้งเดือนใช้เวลาหลายสิบวินาที
  requestTimeout: Number(process.env.ZK_REQUEST_TIMEOUT) || 90000,
  connectionTimeout: Number(process.env.ZK_CONNECT_TIMEOUT) || 15000,
};
if (!zkInstance) zkConfig.port = Number(process.env.ZK_DB_PORT) || 1433;

// ชื่อตารางของ ZKBio Time 9 (แก้ผ่าน env ได้ถ้ารุ่นที่ติดตั้งใช้ชื่อไม่ตรง — เช็กด้วย /zk/tables)
const ZK_TRANS_TABLE = (process.env.ZK_TRANS_TABLE || 'iclock_transaction').replace(/[^A-Za-z0-9_]/g, '');
const ZK_EMP_TABLE   = (process.env.ZK_EMP_TABLE   || 'personnel_employee').replace(/[^A-Za-z0-9_]/g, '');
const ZK_DEPT_TABLE  = (process.env.ZK_DEPT_TABLE  || 'personnel_department').replace(/[^A-Za-z0-9_]/g, '');
// เพดานจำนวนแถวของ /zk/transactions — ฝั่ง /api/attendance หั่นช่วงวันที่เป็นก้อนละสัปดาห์
// ก่อนยิงมาแล้ว ปกติจึงไม่ชนเพดานนี้ (เพดานเป็นแค่กันเหนียวเวลามีใครยิงช่วงยาวๆ มาตรงๆ)
const ZK_MAX_ROWS = Math.max(1, Number(process.env.ZK_MAX_ROWS) || 100000);

// ต่อ ZKBio แบบ lazy: ต่อครั้งแรกเมื่อมีคนเรียก /zk/* — ต่อไม่ได้ก็ไม่กระทบ API ยอดขายหลัก
let zkPoolPromise = null;
function getZkPool() {
  if (!zkPoolPromise) {
    zkPoolPromise = new sql.ConnectionPool(zkConfig).connect()
      .then(pool => { console.log(`✅ ต่อ ZKBio DB สำเร็จ (${ZK_SERVER_RAW}/${zkConfig.database})`); return pool; })
      .catch(err => {
        zkPoolPromise = null; // ให้ request ถัดไปลองต่อใหม่ได้
        console.error('❌ ต่อ ZKBio DB ไม่ได้:', err.message);
        throw new Error(`ต่อฐานข้อมูล ZKBio (${ZK_SERVER_RAW}/${zkConfig.database}) ไม่ได้: ${err.message}`);
      });
  }
  return zkPoolPromise;
}

// ── helpers ──────────────────────────────────────────────────
// แปลงชื่อคอลัมน์ตัวพิมพ์ใหญ่ตัวแรก → ตัวเล็ก (PostTime → postTime) ให้ตรงกับ frontend
const lowerFirst = s => (s && s.length ? s[0].toLowerCase() + s.slice(1) : s);

// format datetime → 'YYYY-MM-DD HH:mm:ss' โดยใช้ค่า UTC (ตรงกับค่าที่เก็บใน DB)
const pad = n => String(n).padStart(2, '0');
const fmtDate = d =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

const fmtVal = v => (v instanceof Date ? fmtDate(v) : v);

// แปลง 1 แถว: key เป็น lowerFirst, ค่า Date → string รูปแบบเดิม
// (สำหรับ cpaid ที่ SELECT มี AS alias เป็นตัวพิมพ์เล็กอยู่แล้ว → lowerFirst ไม่เปลี่ยนชื่อ แค่ format date)
const mapRow = row => {
  const out = {};
  for (const k in row) out[lowerFirst(k)] = fmtVal(row[k]);
  return out;
};

// ── /ctranbetweendate : รายการสินค้า (กรองด้วย PostTime) ──
app.get('/ctranbetweendate', async (req, res) => {
  const { start, end, outlet } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'ต้องมี start และ end' });
  try {
    const pool = await getPool();
    const dbReq = pool.request()
      .input('start', sql.VarChar, start + ' 00:00:00')
      .input('end',   sql.VarChar, end   + ' 23:59:59');
    // ระบุสาขา (ไม่บังคับ) → กรองที่ SQL เพื่อลดข้อมูลที่ส่งกลับ
    let outletFilter = '';
    if (outlet != null && String(outlet).trim() !== '') {
      dbReq.input('outlet', sql.Int, parseInt(outlet, 10));
      outletFilter = ' AND [OutletID] = @outlet';
    }
    const result = await dbReq
      .query(`
        SELECT
          [PostTime]    AS postTime,
          [StartTime]   AS startTime,
          [OutletID]    AS outletID,
          [TableID]     AS tableID,
          [OrderID]     AS orderID,
          [Quantity]    AS quantity,
          [WaiterName]  AS waiterName,
          [ItemCode]    AS itemCode,
          [NameThai]    AS nameThai,
          [NameEng]     AS nameEng,
          [UnitPrice]   AS unitPrice,
          [GrossPrice]  AS grossPrice,
          [Tax]         AS tax,
          [ChkCheckID]  AS chkCheckID,
          [PrtOrdTime]  AS prtOrdTime,
          [Void]        AS [void],
          [VoidTime]    AS voidTime,
          [VoidType]    AS voidType
        FROM dbo.Ctrans
        WHERE [PostTime] >= @start AND [PostTime] <= @end${outletFilter}
      `);
    res.json({ data: result.recordset.map(mapRow) });
  } catch (e) {
    console.error('ctran query error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /cpaidbetweendate : รายบิล/การชำระ (กรองด้วย PAID_DATE_COL) ──
app.get('/cpaidbetweendate', async (req, res) => {
  const { start, end, outlet } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'ต้องมี start และ end' });
  try {
    const pool = await getPool();
    const dbReq = pool.request()
      .input('start', sql.VarChar, start + ' 00:00:00')
      .input('end',   sql.VarChar, end   + ' 23:59:59');
    // ระบุสาขา (ไม่บังคับ) → กรองที่ SQL เพื่อลดข้อมูลที่ส่งกลับ
    let outletFilter = '';
    if (outlet != null && String(outlet).trim() !== '') {
      dbReq.input('outlet', sql.Int, parseInt(outlet, 10));
      outletFilter = ' AND [OutletID] = @outlet';
    }
    const result = await dbReq
      .query(`
        SELECT
          [OutletID]     AS outletID,
          [CheckID]      AS checkID,
          [Amount]       AS amount,
          [BillTotal]    AS billTotal,
          [CashierID]    AS cashierID,
          [CashierName]  AS cashierName,
          [CheckDesc]    AS checkDesc,
          [Cover]        AS cover,
          [CoverAd]      AS coverAd,
          [CoverAll]     AS coverAll,
          [CshStation]   AS cshStation,
          [Date]         AS [date],
          [FullTaxAccID] AS fullTaxAccID,
          [FullTaxDate]  AS fullTaxDate,
          [FullTaxInvNo] AS fullTaxInvNo,
          [MealP]        AS mealP,
          [Nonvat]       AS nonvat,
          [OrderID]      AS orderID,
          [PaidNote]     AS paidNote,
          [PaidType]     AS paidType,
          [Pkg]          AS pkg,
          [PrtNo]        AS prtNo,
          [EDCM]         AS edcm,
          [RegNo]        AS regNo,
          [StartTime]    AS startTime,
          [TableID]      AS tableID,
          [TaxInvNo]     AS taxInvNo,
          [Vat]          AS vat,
          [Voucher]      AS voucher1,
          [Vtype]        AS vtype,
          [MemberTel]    AS memberTel,
          [Ref]          AS ref,
          [_Credit]      AS credit,
          [_QR]          AS qr,
          [_Cash]        AS cash,
          [_QRcredit]    AS qrCredit,
          [_Alipay]      AS alipay,
          [_WeChat]      AS weChat,
          [_Other1]      AS other1,
          [_OtherType1]  AS otherType1,
          [_Other2]      AS other2,
          [_OtherType2]  AS otherType2,
          [_Voucher]     AS voucher,
          [_OC]          AS oc
        FROM ${PAID_TABLE}
        WHERE [${PAID_DATE_COL}] >= @start AND [${PAID_DATE_COL}] <= @end${outletFilter}
      `);
    res.json({ data: result.recordset.map(mapRow) });
  } catch (e) {
    console.error('cpaid query error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /pos/latest : ฐานที่ "เส้นนี้" ต่ออยู่จริง + บิลล่าสุดที่มองเห็น ──
//
// ไว้ตอบคำถามเดียวที่ตอบยากที่สุดตอนยอดขายหาย: "หน้าเว็บมองเห็นฐานตัวเดียวกับที่เราเปิด
// SSMS ดูอยู่หรือเปล่า" — อาการที่เจอคือ SSMS บอกว่ามีบิลถึงเมื่อคืน แต่ /cpaidbetweendate
// คืน {"data":[]} ซึ่งเป็นไปได้สองทางที่หน้าตาเหมือนกันเป๊ะ:
//   - host-server ต่ออยู่คนละ instance/คนละฐาน (เช่น localhost vs localhost\SQLEXPRESS
//     หรือฐานสำเนาเก่าที่ชื่อเหมือนกัน) → serverName/dbName/totalBills จะไม่ตรงกับ SSMS
//   - โดเมนที่ Vercel ยิงเข้ามาไม่ได้วิ่งมาที่เครื่องนี้ → เปิดผ่านโดเมนแล้วได้ hostname
//     คนละตัวกับตอนเปิด localhost
// เปิดเทียบสองทางแล้วรู้ผลทันที (ดู pages/api/pos-latest.js ที่เรียกเส้นนี้ให้จากฝั่ง Vercel)
//
// ตั้งใจให้เบา: นับทั้งตาราง Cpaid (หลักแสนแถว) ไม่ใช่ Ctrans (หลักล้าน) จึงเร็วพอ
// แม้ยังไม่ได้สร้าง index (ดู docs/fix-slow-sales-index.sql)
app.get('/pos/latest', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
  try {
    const pool = await getPool();
    const head = await pool.request().query(`
      SELECT
        @@SERVERNAME AS serverName,
        DB_NAME()    AS dbName,
        (SELECT COUNT_BIG(*) FROM ${PAID_TABLE})                  AS totalBills,
        (SELECT MAX([${PAID_DATE_COL}]) FROM ${PAID_TABLE})       AS latestBill,
        (SELECT MIN([${PAID_DATE_COL}]) FROM ${PAID_TABLE})       AS oldestBill
    `);
    const recent = await pool.request().input('n', sql.Int, days).query(`
      SELECT TOP (@n)
        CONVERT(varchar(10), [${PAID_DATE_COL}], 23) AS day,
        COUNT(*) AS bills
      FROM ${PAID_TABLE}
      GROUP BY CONVERT(varchar(10), [${PAID_DATE_COL}], 23)
      ORDER BY day DESC
    `);
    res.json({
      ok: true,
      host: os.hostname(),                 // เครื่องที่ตอบคำขอนี้จริง ๆ
      table: PAID_TABLE,
      dateColumn: PAID_DATE_COL,
      connectedTo: {                       // ค่าที่ host-server ใช้ต่อ (ไม่มีรหัสผ่าน)
        server: dbConfig.server,
        port: dbConfig.port,
        database: dbConfig.database,
        user: dbConfig.user,
      },
      ...head.recordset[0],
      recentDays: recent.recordset,        // บิลต่อวัน ใหม่→เก่า ไว้ดูว่าข้อมูลหยุดวันไหน
    });
  } catch (e) {
    console.error('pos/latest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /tables : รายชื่อตารางทั้งหมด (ไว้หา PAID_TABLE) ──
app.get('/tables', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(
      "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES " +
      "WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    );
    res.json(result.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /columns?table=ชื่อ : คอลัมน์ของตาราง (default = Ctrans) ──
app.get('/columns', async (req, res) => {
  const table = (req.query.table || 'Ctrans').replace(/[^A-Za-z0-9_]/g, '');
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('t', sql.VarChar, table)
      .query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS " +
        "WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION"
      );
    res.json(result.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /sample?table=ชื่อ : ตัวอย่าง 1 แถว (แปลงชื่อคอลัมน์แล้ว) ──
app.get('/sample', async (req, res) => {
  const table = (req.query.table || 'Ctrans').replace(/[^A-Za-z0-9_]/g, '');
  try {
    const pool = await getPool();
    const result = await pool.request().query(`SELECT TOP 1 * FROM dbo.${table}`);
    res.json((result.recordset[0] && mapRow(result.recordset[0])) || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════ ZKBio Time 9 (เครื่องสแกนนิ้ว) ════════════════

// ── /zk/ping : เช็กว่าต่อฐาน ZKBio ได้ไหม ──
app.get('/zk/ping', async (req, res) => {
  try {
    const pool = await getZkPool();
    await pool.request().query('SELECT 1 AS ok');
    res.json({ ok: true, server: ZK_SERVER_RAW, database: zkConfig.database });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── /zk/transactions?start=YYYY-MM-DD&end=YYYY-MM-DD&emp=รหัส&area=รหัสสาขา : log สแกนนิ้วดิบ ──
//    area (ไม่บังคับ) = รหัสสาขาที่ตั้งไว้ในเครื่องสแกน (area_alias เช่น SUM/XCM/ZBW)
//    กรองที่ SQL เพื่อลดข้อมูลที่ส่งกลับ — หน้าเว็บ "ดูสแกนหน้า" ส่งมาเมื่อผู้ใช้เลือกสาขา
app.get('/zk/transactions', async (req, res) => {
  const { start, end, emp, area } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'ต้องมี start และ end' });
  try {
    const pool = await getZkPool();
    const dbReq = pool.request()
      .input('start', sql.VarChar, start + ' 00:00:00')
      .input('end',   sql.VarChar, end   + ' 23:59:59');
    let empFilter = '';
    if (emp != null && String(emp).trim() !== '') {
      dbReq.input('emp', sql.VarChar, String(emp).trim());
      empFilter = ' AND emp_code = @emp';
    }
    let areaFilter = '';
    if (area != null && String(area).trim() !== '') {
      dbReq.input('area', sql.NVarChar, String(area).trim().toUpperCase());
      areaFilter = ' AND UPPER(area_alias) = @area';
    }
    // เพดานแถว: หน้า "ดูสแกนหน้า" มีช่วง "เดือนนี้/เดือนที่แล้ว" แบบทุกสาขา
    // ซึ่งเกิน 20,000 แถวได้ง่าย (≈20 สาขา x 15 คน x 4 ครั้ง/วัน x 30 วัน)
    // แถวเล็กมากและ response ถูก gzip อยู่แล้ว จึงขยายเพดานได้โดยไม่หนัก
    //
    // เรียงใหม่→เก่า เพื่อให้ TOP ตัด "วันเก่าสุด" ทิ้งเวลาชนเพดาน — เรียงเก่า→ใหม่แล้วโดนตัด
    // จะทำให้วันล่าสุดหายไปทั้งวันโดยไม่มีอะไรบอก ซึ่งเป็นวันที่คนดูหน้านี้อยากเห็นที่สุด
    // (ฝั่ง /api/attendance เรียงใหม่→เก่าอยู่แล้ว การสลับตรงนี้จึงไม่กระทบรูปข้อมูลที่ส่งไป)
    const result = await dbReq.query(`
      SELECT TOP ${ZK_MAX_ROWS}
        emp_code, punch_time, punch_state, verify_type,
        terminal_sn, terminal_alias, area_alias
      FROM dbo.${ZK_TRANS_TABLE}
      WHERE punch_time >= @start AND punch_time <= @end${empFilter}${areaFilter}
      ORDER BY punch_time DESC
    `);
    res.json({ data: result.recordset.map(mapRow) });
  } catch (e) {
    console.error('zk transactions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /zk/employees : รายชื่อพนักงานในเครื่องสแกน + แผนก ──
app.get('/zk/employees', async (req, res) => {
  try {
    const pool = await getZkPool();
    const result = await pool.request().query(`
      SELECT
        e.emp_code, e.first_name, e.last_name, e.hire_date,
        d.dept_code, d.dept_name
      FROM dbo.${ZK_EMP_TABLE} e
      LEFT JOIN dbo.${ZK_DEPT_TABLE} d ON d.id = e.department_id
      ORDER BY e.emp_code
    `);
    res.json({ data: result.recordset.map(mapRow) });
  } catch (e) {
    console.error('zk employees error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /zk/tables /zk/columns /zk/sample : ช่วย debug หา schema จริงของ ZKBio ──
app.get('/zk/tables', async (req, res) => {
  try {
    const pool = await getZkPool();
    const result = await pool.request().query(
      "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES " +
      "WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    );
    res.json(result.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/zk/columns', async (req, res) => {
  const table = (req.query.table || ZK_TRANS_TABLE).replace(/[^A-Za-z0-9_]/g, '');
  try {
    const pool = await getZkPool();
    const result = await pool.request()
      .input('t', sql.VarChar, table)
      .query(
        "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS " +
        "WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION"
      );
    res.json(result.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/zk/sample', async (req, res) => {
  const table = (req.query.table || ZK_TRANS_TABLE).replace(/[^A-Za-z0-9_]/g, '');
  try {
    const pool = await getZkPool();
    const result = await pool.request().query(`SELECT TOP 1 * FROM dbo.${table}`);
    res.json((result.recordset[0] && mapRow(result.recordset[0])) || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── QC/RD: เมนู · สูตร BOM · วัตถุดิบ · หมวดหมู่เมนู (ฐาน InventoryNarai) ──
//    ต่อฐานแบบ lazy เหมือน ZKBio — ยังไม่ได้ย้ายข้อมูลก็ไม่กระทบ endpoint อื่น
mountQcrd(app);

// ── แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน (ฐานเดียวกัน ใช้ pool ร่วมกัน) ──
mountSheets(app);

// ── ร้านเฟรนไชส์ (ฐาน Aoringo บนเครื่องเดียวกัน) — ทางถอยของหน้าเมนู "เฟรนไชส์" บน Vercel ──
mountAoringo(app);

// ── ผู้ใช้และสิทธิ์เมนูของแดชบอร์ด (ฐาน InventoryNarai ใช้ pool ร่วมกับ QC/RD) ──
//    Vercel ต่อ SQL ที่ร้านตรง ๆ ไม่ได้เป็นปกติ ทางนี้จึงเป็นทางเดียวที่หน้าล็อกอินใช้ได้จริง
mountAuth(app);

// ── เช็กว่า API ยังมีชีวิต ──
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date() }));

app.listen(PORT, () => console.log(`🚀 Narai API รันที่ port ${PORT}`));
