// Proxy ไป Google Apps Script ของสต๊อก (getBranches / getStockItems / getStockTotal / saveStock ฯลฯ)
//
// ยกเว้นพนักงาน (getEmployees / saveEmployee) ที่ย้ายไปอ่าน-เขียน narai_hr.dbo.hr_employee
// บน SQL Server แล้ว — ตารางเดียวกับที่ตารางงาน/รายงานเงินเดือนใช้ (ดู HR_EMPLOYEE_TABLE ใน
// lib/sheetsSql.mjs) ทั้งอ่านและเขียนไปที่เดียวเสมอ ไม่ถอยไปชีท DATA
// (อ่านที่หนึ่งเขียนอีกที่หนึ่งคือต้นเหตุของอาการ "กดบันทึกขึ้นสำเร็จ แต่ข้อมูลไม่เปลี่ยน")
// เหตุที่ย้าย: Apps Script ตัวนี้เคยถูกวางโค้ดอื่นทับจนตอบ "HR System Backend is running."
// แทนรายชื่อ หน้าพนักงานพังทั้งหน้า — SQL เป็นที่เก็บรายชื่อตัวจริงของระบบตารางงานอยู่แล้ว
//
// เวลา GAS ตอบมาไม่ใช่ JSON เมื่อก่อนโยนแค่ "ตอบกลับจาก GAS ไม่ใช่ JSON" ซึ่งบอกไม่ได้เลยว่า
// พังตรงไหน (deployment ถูกลบ / ตั้งสิทธิ์ผิด / สคริปต์ error) ตอนนี้แปลสาเหตุให้ด้วย
// lib/gasDiagnose.js ตัวเดียวกับที่ /api/qcrd-gas ใช้
//
// เปิด GET /api/stock-gas จากเบราว์เซอร์ = health check ดูว่า deployment ยังตอบอยู่ไหม
import { diagnoseGas } from '../../lib/gasDiagnose';
import { usingStockSql, readEmployees, saveEmployee, sqlRoute } from '../../lib/sheetsSource';
import { HR_EMPLOYEE_TABLE } from '../../lib/sheetsSql.mjs';

const EMPLOYEE_ACTIONS = new Set(['getEmployees', 'saveEmployee']);

/** พนักงาน — อ่าน/เขียน SQL ที่เดียว ไม่ถอยไปชีท ต่อไม่ได้ให้ฟ้องตรง ๆ */
async function handleEmployee(action, payload, res) {
  try {
    const data = action === 'getEmployees' ? await readEmployees() : await saveEmployee(payload);
    return res.status(200).json({ status: 'success', source: HR_EMPLOYEE_TABLE, data });
  } catch (err) {
    console.error(`stock-gas: ${action} กับ ${HR_EMPLOYEE_TABLE} ไม่ได้ (${sqlRoute()}):`, err.message);
    return res.status(err.badRequest ? 400 : 502).json({
      status: 'error',
      message: action === 'saveEmployee'
        ? `บันทึกข้อมูลพนักงานไม่สำเร็จ: ${err.message}`
        : `อ่านรายชื่อพนักงานจาก ${HR_EMPLOYEE_TABLE} ไม่ได้: ${err.message} — ` +
          'ตรวจว่าเครื่องออฟฟิศ/host-server ยังทำงานอยู่ไหม',
    });
  }
}

// การบันทึกของหน้านับสต๊อกที่ "ต้องไม่วิ่งลงชีทอีกแล้ว" เมื่ออ่านจาก SQL
//
// สาขาย้ายไปนับบน SQL หมดแล้ว ถ้าฝั่งนี้ยังเขียนลงชีท = บันทึกไปคนละที่กับที่หน้าตัวเองอ่าน
// อาการที่จะเจอคือ "กดบันทึกขึ้นสำเร็จ แต่เลขไม่เปลี่ยน" แล้วยังทำให้ข้อมูลสองระบบแยกกันไปอีก
// จึงกันไว้ตรงนี้ พร้อมบอกให้ไปบันทึกที่หน้าสาขาแทน (ฝั่งเขียนของหน้านี้ยังไม่ได้ย้ายตาม)
const STOCK_WRITE_ACTIONS = new Set(['saveStock', 'updateStorageCategory']);

// อ่านรายชื่อพนักงาน/รายการสต๊อกทั้งชีทนานเกินค่าเริ่มต้น 10 วินาทีของ Vercel ได้
export const config = { maxDuration: 60 };

// action ที่อ่านอย่างเดียว — ปลอดภัยที่จะยิงซ้ำเมื่อ GAS คืนหน้า HTML แทน JSON
// (Google คืนหน้า error เป็นครั้งคราวตอนติดโควตา/execution timeout ยิงใหม่มักผ่านเลย)
// ฝั่งเขียนห้ามยิงซ้ำเด็ดขาด — รอบแรกอาจเขียนลงชีทไปแล้วแต่ตอบกลับมาไม่ใช่ JSON
const isReadAction = (body) => {
  const payload = typeof body === 'string'
    ? (() => { try { return JSON.parse(body); } catch { return {}; } })()
    : (body || {});
  return /^get/i.test(String(payload.action || '').trim());
};

const SCRIPT_URL =
  process.env.STOCK_GAS_URL ||
  'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

const DIAG = { scriptName: 'ของสต๊อก/พนักงาน', envName: 'STOCK_GAS_URL' };

async function callGas(body) {
  const upstream = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
    redirect: 'follow',
  });
  const text = await upstream.text();
  return { status: upstream.status, finalUrl: upstream.url, text };
}

export default async function handler(req, res) {
  // GET = health check เปิดจากเบราว์เซอร์ได้เลย — ดูทั้งสองที่ที่ route นี้พึ่งอยู่
  //   employee: รายชื่อพนักงานจาก SQL (narai_hr.dbo.hr_employee)
  //   gas:      Apps Script ของสต๊อก (ยิง getBranches — อ่านอย่างเดียว ไม่แตะข้อมูล)
  if (req.method === 'GET') {
    const usingEnv = Boolean(process.env.STOCK_GAS_URL);

    let employee;
    try {
      const list = await readEmployees();
      employee = { status: 'success', table: HR_EMPLOYEE_TABLE, rows: list.length };
    } catch (err) {
      employee = { status: 'error', table: HR_EMPLOYEE_TABLE, route: sqlRoute(), message: err.message };
    }

    let gas;
    try {
      const { status, finalUrl, text } = await callGas(JSON.stringify({ action: 'getBranches' }));
      let json = null;
      try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON — รายงานเป็น diagnosis ด้านล่าง */ }
      gas = {
        status: json && json.status === 'success' ? 'success' : 'error',
        scriptUrlFrom: usingEnv ? 'env STOCK_GAS_URL' : 'fallback ในโค้ด',
        scriptUrl: SCRIPT_URL,
        httpStatus: status,
        finalUrl,
        message: json
          ? (json.status === 'success'
            ? 'deployment ตอบเป็น JSON ปกติ'
            : `deployment ตอบเป็น JSON แต่แจ้ง error: ${json.message || '(ไม่มีข้อความ)'}`)
          : diagnoseGas(status, finalUrl, text, DIAG),
      };
    } catch (err) {
      gas = { status: 'error', scriptUrl: SCRIPT_URL, message: `เรียก GAS ไม่สำเร็จ: ${err.message}` };
    }

    return res.status(200).json({
      status: employee.status === 'success' && gas.status === 'success' ? 'success' : 'error',
      employee,
      gas,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'GET (health check) หรือ POST เท่านั้น' });
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});

    const action = String((typeof req.body === 'string'
      ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
      : (req.body || {})).action || '').trim();
    if (EMPLOYEE_ACTIONS.has(action)) {
      const payload = typeof req.body === 'string'
        ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
        : (req.body || {});
      return handleEmployee(action, payload, res);
    }
    if (usingStockSql() && STOCK_WRITE_ACTIONS.has(action)) {
      return res.status(409).json({
        status: 'error',
        message:
          'ยอดนับสต๊อกย้ายไปเก็บบนฐานข้อมูลของสาขาแล้ว หน้านี้จึงบันทึกให้ไม่ได้ ' +
          '(ถ้าบันทึกจากที่นี่จะลงชีทเก่าที่ไม่มีใครอ่านแล้ว) — ให้นับและกดบันทึกที่หน้าสาขา ' +
          'narai-branch.vercel.app/stock/list แทน แล้วรีเฟรชหน้านี้จะเห็นตัวเลขทันที',
      });
    }
    let { status, finalUrl, text } = await callGas(body);
    let json;
    try { json = JSON.parse(text); }
    catch {
      if (!isReadAction(body)) {
        return res.status(502).json({ status: 'error', message: diagnoseGas(status, finalUrl, text, DIAG) });
      }
      // อ่านอย่างเดียว — พักสักครู่แล้วลองอีกรอบเดียว ไม่ใช่วนซ้ำ
      await new Promise(r => setTimeout(r, 1200));
      ({ status, finalUrl, text } = await callGas(body));
      try { json = JSON.parse(text); }
      catch {
        return res.status(502).json({
          status: 'error',
          message: `${diagnoseGas(status, finalUrl, text, DIAG)} (ลองใหม่แล้วสองครั้ง)`,
        });
      }
    }
    return res.status(200).json(json);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
