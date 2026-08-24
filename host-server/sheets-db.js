// ════════════════════════════════════════════════════════════
//  แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ บน SQL Server
//  ฐานข้อมูล InventoryNarai (ตัวเดียวกับ QC/RD และหน้านับสต๊อก)
//  โครงตารางอยู่ใน docs/schema-sheets.sql
//
//  ไฟล์นี้คือฝั่ง "เปิดเป็น endpoint" ของข้อมูลที่ย้ายออกจาก Google Sheets รอบที่สอง
//  ทุก action ที่หน้าเว็บเคยยิงไป Apps Script มีครบที่นี่ ชื่อและรูปแบบ payload เหมือนเดิม
//    saveOtherExpense · bulkImport · deleteExpenseByMonth
//
//  หมายเหตุ: พนักงานย้ายไปอยู่ฐาน narai_hr แล้ว (ตารางเดียวกับที่ Narai-branch ใช้ลงตารางงาน)
//  ดู host-server/hr-db.js กับ docs/schema-hr-employee.sql — /sheets/employee จึงถูกปลดออก
//
//  endpoint
//    GET  /sheets/ping                     เช็กว่าต่อฐานได้ไหม + ตารางครบไหม + เขียนได้ไหม
//    GET  /sheets/plan                     แพลนสั่งของทั้งหมด
//    GET  /sheets/closing?branch=crm       ยอดยกมาล่าสุดของสาขานั้น
//    GET  /sheets/expense-ref              รหัสค่าใช้จ่าย (ประเภท/สาขา/รหัส)
//    GET  /sheets/expense                  ค่าใช้จ่ายที่บันทึกแล้วทั้งหมด
//    POST /sheets/save   { action, ... }   เขียน (ต้องมี header x-api-key)
//
//  ⚠️ เขียนได้ต้องตั้ง env SHEETS_WRITE_KEY (หรือใช้ QCRD_WRITE_KEY เดิมก็ได้) บนเครื่องโฮสต์
//     แล้วตั้งค่าเดียวกันบน Vercel — ไม่ตั้ง = ปิดการเขียนไว้ (อ่านได้อย่างเดียว)
//     API ตัวนี้เปิดออกเน็ตผ่าน tunnel ถ้าปล่อยให้เขียนได้โดยไม่มีกุญแจ ใครก็แก้ข้อมูลได้
//
//  ใช้ pool ตัวเดียวกับ /qcrd/* (require('./qcrd-db')) เพราะเป็นฐานเดียวกันเป๊ะ
//  ไม่ต้องต่อซ้ำสองครั้ง และไม่ต้องตั้ง env ชุดที่สองให้สับสน
// ════════════════════════════════════════════════════════════
const express = require('express');
const { q } = require('./qcrd-db');

// ตรรกะทั้งหมด (คิดจำนวน/ผลรวมค่าใช้จ่าย, คัดยอดปิดรอบล่าสุด, แก้เฉพาะฟิลด์ที่ส่งมา)
// อยู่ใน lib/sheetsSql.mjs เพื่อให้ฝั่ง Vercel ที่ต่อ SQL ตรงใช้ตรรกะชุดเดียวกันเป๊ะ
// โหลดแบบ dynamic import เพราะไฟล์นั้นเป็น ESM ส่วนไฟล์นี้เป็น CommonJS
let corePromise = null;
function getCore() {
  if (!corePromise) {
    corePromise = import('../lib/sheetsSql.mjs')
      .then(m => m.createSheets({ q }))
      .catch(err => { corePromise = null; throw err; });
  }
  return corePromise;
}

const str = v => (v === null || v === undefined ? '' : String(v).trim());

function mountSheets(app) {
  const WRITE_KEY = process.env.SHEETS_WRITE_KEY || process.env.QCRD_WRITE_KEY || '';

  const send = (res, promise, label) =>
    promise
      .then(data => res.json({ status: 'success', data }))
      .catch(err => {
        console.error(`sheets ${label} error:`, err.message);
        res.status(err.badRequest ? 400 : 500).json({ status: 'error', message: err.message });
      });

  app.get('/sheets/ping', async (req, res) => {
    try {
      // นับทีเดียวทุกตาราง — ตารางไหนยังไม่ได้สร้างจะเห็นเป็น error ทันทีว่าตัวไหนขาด
      const r = await q(`
        SELECT (SELECT COUNT(*) FROM dbo.stock_plan)     AS plan,
               (SELECT COUNT(*) FROM dbo.stock_closing)  AS closing,
               (SELECT COUNT(*) FROM dbo.expense_ref)    AS expenseRef,
               (SELECT COUNT(*) FROM dbo.expense_entry)  AS expense`);
      res.json({
        status: 'success',
        rows: r[0] || {},
        writeEnabled: Boolean(WRITE_KEY),
      });
    } catch (e) {
      res.status(500).json({
        status: 'error',
        message: e.message,
        hint: /Invalid object name/i.test(e.message)
          ? 'ยังไม่ได้สร้างตาราง — รัน docs\\schema-sheets.sql ที่เครื่องนี้ก่อน ' +
            '(หรือใช้ scripts\\migrate-sheets.ps1 ซึ่งสร้างให้ในตัว)'
          : undefined,
      });
    }
  });

  const read = (name, arg) => (req, res) => send(res, getCore().then(c => c[name](arg ? arg(req) : undefined)), name);
  app.get('/sheets/plan', read('readPlan'));
  app.get('/sheets/closing', read('readClosing', req => str(req.query.branch).toLowerCase()));
  app.get('/sheets/expense-ref', read('readExpenseRefs'));
  app.get('/sheets/expense', read('readExpenses'));
  // พนักงานย้ายไป /hr/employee (ฐาน narai_hr) แล้ว — ดู host-server/hr-db.js

  app.post('/sheets/save', express.json({ limit: '2mb' }), (req, res) => {
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

module.exports = { mountSheets };
