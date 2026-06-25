// ════════════════════════════════════════════════════════════
//  Narai API — ตัวกลางระหว่าง Dashboard กับ SQL Server (NaraiPos)
//  รันบนเครื่อง Windows Server เครื่องเดียวกับ SQL Server
//  ต่อ DB แบบ localhost (ไม่ต้องเปิด port 1433 ออกเน็ต)
//  เปิดออกเน็ตผ่าน ngrok:  ngrok http 14365
//
//  endpoint ที่ Dashboard ใช้:
//    GET /ctranbetweendate?start=YYYY-MM-DD&end=YYYY-MM-DD   → รายการสินค้า (dbo.Ctrans)
//    GET /cpaidbetweendate?start=YYYY-MM-DD&end=YYYY-MM-DD   → รายบิล/การชำระ (ตารางบิล)
//  endpoint ช่วย debug:
//    GET /tables                 → รายชื่อตารางทั้งหมด
//    GET /columns?table=ชื่อ      → คอลัมน์ของตาราง (default = Ctrans)
//    GET /sample?table=ชื่อ       → ตัวอย่าง 1 แถว (แปลงชื่อคอลัมน์แล้ว)
//    GET /ping                   → เช็กว่า API ยังมีชีวิต
//
//  *** ไม่มี API key — ใครเข้าถึง URL ได้ก็ดึงข้อมูลได้ ***
// ════════════════════════════════════════════════════════════
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const compression = require('compression'); // บีบ JSON ด้วย gzip → ส่งผ่าน ngrok เร็วขึ้นมาก

const app = express();
app.use(compression()); // ต้องมาก่อน route
app.use(cors());
const PORT = 14365;

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
};

// connection pool ใช้ซ้ำ ไม่ต้องต่อใหม่ทุก request
let poolPromise = sql.connect(dbConfig)
  .then(pool => { console.log('✅ ต่อ SQL Server สำเร็จ'); return pool; })
  .catch(err => { console.error('❌ ต่อ SQL Server ไม่ได้:', err.message); throw err; });

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
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'ต้องมี start และ end' });
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('start', sql.VarChar, start + ' 00:00:00')
      .input('end',   sql.VarChar, end   + ' 23:59:59')
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
          [VoidTime]    AS voidTime
        FROM dbo.Ctrans
        WHERE [PostTime] >= @start AND [PostTime] <= @end
      `);
    res.json({ data: result.recordset.map(mapRow) });
  } catch (e) {
    console.error('ctran query error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /cpaidbetweendate : รายบิล/การชำระ (กรองด้วย PAID_DATE_COL) ──
app.get('/cpaidbetweendate', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'ต้องมี start และ end' });
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('start', sql.VarChar, start + ' 00:00:00')
      .input('end',   sql.VarChar, end   + ' 23:59:59')
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
        WHERE [${PAID_DATE_COL}] >= @start AND [${PAID_DATE_COL}] <= @end
      `);
    res.json({ data: result.recordset.map(mapRow) });
  } catch (e) {
    console.error('cpaid query error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /tables : รายชื่อตารางทั้งหมด (ไว้หา PAID_TABLE) ──
app.get('/tables', async (req, res) => {
  try {
    const pool = await poolPromise;
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
    const pool = await poolPromise;
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
    const pool = await poolPromise;
    const result = await pool.request().query(`SELECT TOP 1 * FROM dbo.${table}`);
    res.json((result.recordset[0] && mapRow(result.recordset[0])) || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── เช็กว่า API ยังมีชีวิต ──
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date() }));

app.listen(PORT, () => console.log(`🚀 Narai API รันที่ port ${PORT}`));
