// Proxy ไป Google Apps Script ของสต๊อก (getBranches / getStockItems / getStockTotal / saveStock ฯลฯ)
//
// รายชื่อพนักงาน (getEmployees) กับการแก้ข้อมูลพนักงาน (saveEmployee) กลับมาใช้ชีท DATA
// ผ่าน Apps Script เหมือนเดิมแล้ว ไม่ผ่าน dbo.hr_employee และไม่ขึ้นกับ SHEETS_SOURCE
// ชีทเป็นต้นทางจริงของข้อมูลพนักงาน ส่วนตารางใน SQL เหลือไว้ให้ host-server/สคริปต์ย้ายข้อมูลใช้
// อ่านกับเขียนต้องอยู่ที่เดียวกันเสมอ (อ่านที่หนึ่งเขียนอีกที่หนึ่งคือต้นเหตุของอาการ
// "กดบันทึกขึ้นสำเร็จ แต่ข้อมูลไม่เปลี่ยน") — ทั้งคู่จึงยิงไป Apps Script ตัวเดียวกัน
// action อื่น ๆ ของสต๊อกส่งต่อไป Apps Script เหมือนเดิมทุกตัว

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
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
