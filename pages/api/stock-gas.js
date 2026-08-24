// Proxy ไป Google Apps Script ของสต๊อก (getBranches / getStockItems / getStockTotal / saveStock ฯลฯ)
//
// ยกเว้นสองอย่างที่ย้ายเข้า SQL แล้ว: รายชื่อพนักงาน (getEmployees) กับการแก้ข้อมูลพนักงาน (saveEmployee)
// สองตัวนี้ **ยึด narai_hr.dbo.hr_employee อย่างเดียว** ไม่ขึ้นกับ SHEETS_SOURCE
// (ฐานเดียวกับตารางงาน/กะ — รวมมาจาก InventoryNarai.dbo.hr_employee แล้ว ดู docs/schema-hr-employee.sql)
// และไม่ถอยไปอ่าน/เขียนชีท DATA อีกแล้ว — ชีทเป็นแค่ต้นทางตอนย้ายข้อมูลเข้าฐานเท่านั้น
// (อ่านที่หนึ่งแต่เขียนอีกที่หนึ่งคือต้นเหตุของอาการ "กดบันทึกขึ้นสำเร็จ แต่ข้อมูลไม่เปลี่ยน"
//  ต่อฐานไม่ได้เมื่อไหร่ให้ฟ้องไปตรง ๆ ดีกว่าโชว์ข้อมูลเก่าจากชีทโดยที่คนใช้ไม่รู้ตัว)
// ส่วน action อื่น ๆ ของสต๊อกยังส่งต่อไป Apps Script เหมือนเดิมทุกตัว
import { sqlRoute, readEmployees, saveEmployee } from '../../lib/sheetsSource';

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }

  const payload = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const action = String(payload.action || '').trim();

  // พนักงานไปฐานเดียวเสมอ ไม่มีทางถอย — ทั้งอ่านและเขียน
  if (action === 'getEmployees' || action === 'saveEmployee') {
    try {
      const data = action === 'getEmployees' ? await readEmployees() : await saveEmployee(payload);
      return res.status(200).json({ status: 'success', source: 'sql', data });
    } catch (err) {
      console.error(`stock-gas: ${action} กับ SQL ไม่ได้ (${sqlRoute()}):`, err.message);
      return res.status(502).json({
        status: 'error',
        message: action === 'saveEmployee'
          ? `บันทึกลง SQL ไม่สำเร็จ (${err.message}) — ยังไม่ได้บันทึกอะไรลงไป ลองใหม่อีกครั้ง [${sqlRoute()}]`
          : `อ่านข้อมูลพนักงานจาก SQL ไม่ได้ (${err.message}) — ข้อมูลพนักงานอยู่ที่ฐาน InventoryNarai ` +
            `ที่เดียว ตรวจว่าเครื่องออฟฟิศ/ทางเชื่อมยังทำงานอยู่ไหม [${sqlRoute()}]`,
      });
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
