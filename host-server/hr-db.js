// ════════════════════════════════════════════════════════════
//  รายชื่อพนักงานบน SQL Server — ฐาน narai_hr (dbo.hr_employee)
//  ตารางเดียวกับที่โปรเจกต์ Narai-branch ใช้ลงตารางงาน (hr_timesheet อ้าง hr_code ตารางนี้)
//  คอลัมน์ที่รีโปนี้เพิ่มเข้าไป + วิธีย้ายข้อมูลจากตารางเก่า อยู่ใน docs/schema-hr-employee.sql
//
//  ทำไมต้องมีที่นี่ด้วย: ถ้าวันไหน SQL ไม่ได้เปิดพอร์ตออกเน็ต ฝั่ง Vercel จะต่อตรงไม่ได้
//  แล้วถอยมาใช้ทางนี้แทน (lib/hrEmployee.mjs เลือกทางให้เอง) หน้าเว็บจึงทำงานได้เหมือนเดิม
//
//  endpoint
//    GET  /hr/ping                             เช็กว่าต่อฐาน narai_hr ได้ไหม + คอลัมน์ครบไหม
//    GET  /hr/employee                         รายชื่อพนักงานทั้งหมด (ทุกคอลัมน์)
//    GET  /hr/schedule-employees?branch=crm    คนที่ยังทำงานอยู่ของสาขานั้น
//    POST /hr/save  { action:'saveEmployee', hrCode, ... }   เขียน (ต้องมี header x-api-key)
//
//  ⚠️ เขียนได้ต้องตั้ง env SHEETS_WRITE_KEY (หรือ QCRD_WRITE_KEY) บนเครื่องโฮสต์
//     แล้วตั้งค่าเดียวกันบน Vercel — ไม่ตั้ง = ปิดการเขียนไว้ (อ่านได้อย่างเดียว)
//
//  ต่อ pool แยกจาก /qcrd/* เพราะเป็นคนละฐานข้อมูล (mssql ผูก database ไว้ตั้งแต่ตอนต่อ)
//  แต่ใช้เครื่อง/รหัสชุดเดียวกัน ตั้ง HR_DB_* ทับเฉพาะตอนที่ฐาน HR อยู่คนละที่
// ════════════════════════════════════════════════════════════
const express = require('express');
const sql = require('mssql');

const RAW_SERVER = process.env.HR_DB_SERVER || process.env.QCRD_DB_SERVER || process.env.DB_SERVER || 'localhost\\SQLEXPRESS';
const [hHost, hInstance] = RAW_SERVER.split('\\');
const hrConfig = {
  server: hHost,
  database: process.env.HR_DB_NAME || 'narai_hr',
  user: process.env.HR_DB_USER || process.env.QCRD_DB_USER || process.env.DB_USER || 'SA',
  password: process.env.HR_DB_PASSWORD || process.env.QCRD_DB_PASSWORD || process.env.DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    ...(hInstance ? { instanceName: hInstance } : {}),
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
};
if (!hInstance) hrConfig.port = Number(process.env.HR_DB_PORT || process.env.QCRD_DB_PORT || process.env.DB_PORT) || 1433;

// ต่อแบบ lazy เหมือนฝั่ง QC/RD — ต่อไม่ได้ก็ไม่กระทบ API ยอดขายหลัก
let hrPoolPromise = null;
function getPool() {
  if (!hrPoolPromise) {
    hrPoolPromise = new sql.ConnectionPool(hrConfig).connect()
      .then(pool => { console.log(`✅ ต่อ HR DB สำเร็จ (${RAW_SERVER}/${hrConfig.database})`); return pool; })
      .catch(err => {
        hrPoolPromise = null;   // ให้ request ถัดไปลองต่อใหม่ได้
        console.error('❌ ต่อ HR DB ไม่ได้:', err.message);
        throw new Error(`ต่อฐานข้อมูล HR (${RAW_SERVER}/${hrConfig.database}) ไม่ได้: ${err.message}`);
      });
  }
  return hrPoolPromise;
}

async function q(text, params = {}, tx = null) {
  const req = tx ? new sql.Request(tx) : (await getPool()).request();
  for (const [k, v] of Object.entries(params)) req.input(k, v === undefined ? null : v);
  const r = await req.query(text);
  return r.recordset || [];
}

// ตรรกะทั้งหมด (คอลัมน์ที่แก้ได้, การเรียงตามตำแหน่ง, รหัสสาขาพี่น้อง) อยู่ใน lib/hrEmployeeSql.mjs
// เพื่อให้ฝั่ง Vercel ที่ต่อ SQL ตรงใช้ตรรกะชุดเดียวกันเป๊ะ
// โหลดแบบ dynamic import เพราะไฟล์นั้นเป็น ESM ส่วนไฟล์นี้เป็น CommonJS
let corePromise = null;
function getCore() {
  if (!corePromise) {
    corePromise = import('../lib/hrEmployeeSql.mjs')
      .then(m => m.createHrEmployee({ q }))
      .catch(err => { corePromise = null; throw err; });
  }
  return corePromise;
}

const str = v => (v === null || v === undefined ? '' : String(v).trim());

function mountHr(app) {
  const WRITE_KEY = process.env.SHEETS_WRITE_KEY || process.env.QCRD_WRITE_KEY || '';

  const send = (res, promise, label) =>
    promise
      .then(data => res.json({ status: 'success', data }))
      .catch(err => {
        console.error(`hr ${label} error:`, err.message);
        res.status(err.badRequest ? 400 : 500).json({ status: 'error', message: err.message });
      });

  app.get('/hr/ping', async (req, res) => {
    try {
      // อ่านคอลัมน์ที่รีโปนี้เพิ่มเข้าไปด้วย — ตัวไหนยังไม่มีจะฟ้องทันทีว่ายังไม่ได้รันสคริปต์
      const r = await q(`
        SELECT COUNT(*) AS employee,
               SUM(CASE WHEN status = N'ทำงาน' THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN photo_url IS NOT NULL THEN 1 ELSE 0 END) AS withPhoto
          FROM dbo.hr_employee`);
      res.json({ status: 'success', database: hrConfig.database, rows: r[0] || {}, writeEnabled: Boolean(WRITE_KEY) });
    } catch (e) {
      res.status(500).json({
        status: 'error',
        message: e.message,
        hint: /Invalid column name|Invalid object name/i.test(e.message)
          ? 'ตาราง dbo.hr_employee ในฐาน narai_hr ยังไม่มีคอลัมน์ครบ — รัน docs\\schema-hr-employee.sql ที่เครื่องนี้ก่อน'
          : undefined,
      });
    }
  });

  app.get('/hr/employee', (req, res) =>
    send(res, getCore().then(c => c.readEmployees()), 'employee'));

  app.get('/hr/schedule-employees', (req, res) =>
    send(res, getCore().then(c => c.readScheduleEmployees(str(req.query.branch))), 'schedule-employees'));

  app.post('/hr/save', express.json({ limit: '2mb' }), (req, res) => {
    if (!WRITE_KEY) {
      return res.status(503).json({
        status: 'error',
        message: 'ยังไม่ได้ตั้ง env SHEETS_WRITE_KEY (หรือ QCRD_WRITE_KEY) บนเครื่องโฮสต์ — โหมดนี้ดูข้อมูลได้อย่างเดียว',
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

module.exports = { mountHr, getPool, q };
