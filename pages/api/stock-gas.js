// Proxy ไป Google Apps Script ของสต๊อก (getBranches / getStockItems / getStockTotal / saveStock ฯลฯ)
//
// ยกเว้นสองอย่างที่ย้ายเข้า SQL แล้ว: รายชื่อพนักงาน (getEmployees) กับการแก้ข้อมูลพนักงาน (saveEmployee)
// เมื่อ SHEETS_SOURCE=sql จะไปอ่าน/เขียน dbo.hr_employee ในฐาน InventoryNarai แทนชีท DATA
// ชื่อ action และรูปแบบผลลัพธ์เหมือนเดิม หน้า EmployeeList จึงไม่ต้องแก้อะไร
// ส่วน action อื่น ๆ ของสต๊อกยังส่งต่อไป Apps Script เหมือนเดิมทุกตัว
import { usingSql, sqlRoute, readEmployees, saveEmployee } from '../../lib/sheetsSource';

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }

  const payload = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const action = String(payload.action || '').trim();

  // เก็บไว้แนบท้าย error ของ Apps Script — ไม่งั้นหน้าเว็บจะเห็นแค่ "ตอบกลับจาก GAS ไม่ใช่ JSON"
  // ซึ่งไม่ได้บอกเลยว่าจริง ๆ แล้วมันลอง SQL ก่อนแล้วพลาดเพราะอะไร
  let sqlError = '';

  if (usingSql() && (action === 'getEmployees' || action === 'saveEmployee')) {
    try {
      const data = action === 'getEmployees' ? await readEmployees() : await saveEmployee(payload);
      return res.status(200).json({ status: 'success', source: 'sql', data });
    } catch (err) {
      sqlError = err.message;
      console.error(`stock-gas: ${action} กับ SQL ไม่ได้ (${sqlRoute()}):`, err.message);
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
    catch { return res.status(502).json({ status: 'error', message: gasFailed('ตอบกลับจาก GAS ไม่ใช่ JSON', sqlError) }); }

    // บอกหน้าเว็บว่าคำตอบนี้มาจากชีท ไม่ใช่ SQL — และถ้าเป็นการ "ถอยมาอ่านชีท" ทั้งที่โหมด sql เปิดอยู่
    // ต้องเตือนให้เห็นด้วย เพราะการแก้ไขพนักงานเขียนลง SQL อย่างเดียว (ไม่ถอยมาชีท)
    // ถ้าอ่านชีทแต่เขียน SQL อาการที่ผู้ใช้เจอคือ "กดบันทึกขึ้นสำเร็จ แต่ข้อมูลบนหน้าไม่เปลี่ยน"
    if (json && json.status === 'success' && (action === 'getEmployees' || action === 'saveEmployee')) {
      json.source = 'sheet';
      if (sqlError) {
        json.warning = 'ตอนนี้รายชื่อที่เห็นอ่านจาก Google Sheets ไม่ใช่ SQL ' +
          `(อ่าน SQL ไม่ได้: ${sqlError}) — การแก้ไขพนักงานจะเขียนลง SQL คนละที่กับที่อ่าน ` +
          'ค่าที่แสดงจึงอาจไม่ใช่ค่าล่าสุด ให้แก้ทางเชื่อม SQL ก่อนแล้วโหลดหน้าใหม่';
      }
    }
    return res.status(200).json(json);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: gasFailed(err.message, sqlError) });
  }
}

/** ข้อความ error ที่บอกครบว่าลองทางไหนไปแล้วบ้าง */
function gasFailed(gasMessage, sqlError) {
  if (!sqlError) {
    return `${gasMessage} — ตอนนี้ยังอ่านจาก Google Sheets อยู่ ` +
      '(ถ้าย้ายข้อมูลเข้า SQL แล้ว ให้ตั้ง env SHEETS_SOURCE=sql บน Vercel แล้ว Redeploy)';
  }
  return `อ่านจาก SQL ไม่ได้ (${sqlError}) แล้วถอยไปถาม Google Sheets ก็ไม่ได้อีก (${gasMessage})`;
}
