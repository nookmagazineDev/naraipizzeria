// Proxy ไป Google Apps Script ของสต๊อก (getBranches / getStockItems / getStockTotal / saveStock ฯลฯ)
// สคริปต์ตัวนี้ยังเป็นตัวเดียวกับที่ให้ข้อมูลพนักงาน (getEmployees / saveEmployee) ด้วย
//
// รายชื่อพนักงานกับการแก้ข้อมูลพนักงานใช้ชีท DATA ผ่าน Apps Script เหมือนเดิม ไม่ผ่าน dbo.hr_employee
// และไม่ขึ้นกับ SHEETS_SOURCE — ชีทเป็นต้นทางจริง ส่วนตารางใน SQL เหลือไว้ให้สคริปต์ย้ายข้อมูลใช้
// อ่านกับเขียนต้องอยู่ที่เดียวกันเสมอ (อ่านที่หนึ่งเขียนอีกที่หนึ่งคือต้นเหตุของอาการ
// "กดบันทึกขึ้นสำเร็จ แต่ข้อมูลไม่เปลี่ยน") — ทุก action จึงยิงไป Apps Script ตัวเดียวกัน
//
// เวลา GAS ตอบมาไม่ใช่ JSON เมื่อก่อนโยนแค่ "ตอบกลับจาก GAS ไม่ใช่ JSON" ซึ่งบอกไม่ได้เลยว่า
// พังตรงไหน (deployment ถูกลบ / ตั้งสิทธิ์ผิด / สคริปต์ error) ตอนนี้แปลสาเหตุให้ด้วย
// lib/gasDiagnose.js ตัวเดียวกับที่ /api/qcrd-gas ใช้
//
// เปิด GET /api/stock-gas จากเบราว์เซอร์ = health check ดูว่า deployment ยังตอบอยู่ไหม
import { diagnoseGas } from '../../lib/gasDiagnose';

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
  // GET = health check เปิดจากเบราว์เซอร์ได้เลย ไว้ดูว่า deployment ยังตอบเป็น JSON อยู่ไหม
  // ยิง getEmployees เพราะเป็น action อ่านอย่างเดียว ไม่แตะข้อมูล และเป็นตัวที่มีปัญหาอยู่พอดี
  if (req.method === 'GET') {
    const usingEnv = Boolean(process.env.STOCK_GAS_URL);
    try {
      const { status, finalUrl, text } = await callGas(JSON.stringify({ action: 'getEmployees', branch: 'all' }));
      let json = null;
      try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON — รายงานเป็น diagnosis ด้านล่าง */ }
      const rows = Array.isArray(json?.data) ? json.data.length : undefined;
      return res.status(200).json({
        status: json && json.status === 'success' ? 'success' : 'error',
        scriptUrlFrom: usingEnv ? 'env STOCK_GAS_URL' : 'fallback ในโค้ด',
        scriptUrl: SCRIPT_URL,
        httpStatus: status,
        finalUrl,
        employeeRows: rows,
        gasResponse: json && json.status !== 'success' ? json : undefined,
        message: json
          ? (json.status === 'success'
            ? `deployment ตอบเป็น JSON ปกติ — อ่านรายชื่อพนักงานได้ ${rows ?? '?'} แถว`
            : `deployment ตอบเป็น JSON แต่แจ้ง error: ${json.message || '(ไม่มีข้อความ)'}`)
          : diagnoseGas(status, finalUrl, text, DIAG),
      });
    } catch (err) {
      return res.status(200).json({
        status: 'error',
        scriptUrlFrom: usingEnv ? 'env STOCK_GAS_URL' : 'fallback ในโค้ด',
        scriptUrl: SCRIPT_URL,
        message: `เรียก GAS ไม่สำเร็จ: ${err.message}`,
      });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'GET (health check) หรือ POST เท่านั้น' });
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
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
