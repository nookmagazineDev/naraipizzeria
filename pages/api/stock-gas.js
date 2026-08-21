// Proxy ไป Google Apps Script ของสต๊อก (getBranches / getStockItems / getStockTotal / saveStock ฯลฯ)
//
// ยกเว้นสองอย่างที่ย้ายเข้า SQL แล้ว: รายชื่อพนักงาน (getEmployees) กับการแก้ข้อมูลพนักงาน (saveEmployee)
// เมื่อ SHEETS_SOURCE=sql จะไปอ่าน/เขียน dbo.hr_employee ในฐาน InventoryNarai แทนชีท DATA
// ชื่อ action และรูปแบบผลลัพธ์เหมือนเดิม หน้า EmployeeList จึงไม่ต้องแก้อะไร
// ส่วน action อื่น ๆ ของสต๊อกยังส่งต่อไป Apps Script เหมือนเดิมทุกตัว
import { usingSql, describeTarget, readEmployees, saveEmployee } from '../../lib/sheetsSource';

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }

  const payload = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const action = String(payload.action || '').trim();

  if (usingSql() && (action === 'getEmployees' || action === 'saveEmployee')) {
    try {
      const data = action === 'getEmployees' ? await readEmployees() : await saveEmployee(payload);
      return res.status(200).json({ status: 'success', source: 'sql', data });
    } catch (err) {
      console.error(`stock-gas: ${action} กับ SQL ไม่ได้ (${describeTarget()}):`, err.message);
      if (action === 'saveEmployee') {
        // การเขียนห้ามถอยไปชีท — เขียนคนละที่กับที่หน้าเว็บอ่าน แปลว่าข้อมูลสองที่จะไม่ตรงกัน
        return res.status(502).json({
          status: 'error',
          message: `บันทึกลง SQL ไม่สำเร็จ (${err.message}) — ยังไม่ได้บันทึกอะไรลงไป ลองใหม่อีกครั้ง`,
        });
      }
      // ฝั่งอ่านถอยไปถาม Apps Script ต่อได้ หน้าเว็บจะได้ไม่ค้าง
    }
  }

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const upstream = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return res.status(502).json({ status: 'error', message: 'ตอบกลับจาก GAS ไม่ใช่ JSON' }); }
    return res.status(200).json(json);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
