// หลังบ้านของหน้า "ค่าใช้จ่ายอื่นๆ"
//
// ที่มาเดิม: proxy ไป Google Apps Script ของชีท 1YXOaA… (ตั้ง URL ผ่าน env EXPENSE_GAS_URL)
// ที่มาใหม่ (SHEETS_SOURCE=sql): ทำงานกับ dbo.expense_ref / dbo.expense_entry ในฐาน InventoryNarai ตรง ๆ
//   ชื่อ action และรูปแบบ body/ผลลัพธ์เหมือนเดิมทุกช่อง หน้าเว็บ (lib/expenseApi.js) จึงไม่ต้องแก้
//
// ฝั่งอ่าน (getExpenseRefs / getExpenses) ถ้า SQL ล่มจะถอยไปถาม Apps Script ให้
// ฝั่งเขียนไม่ถอยไปชีท — เขียนลงชีทบ้างลงฐานบ้าง แปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น
// (แต่ในโหมด sql ยังถอยจาก "ต่อ SQL ตรง" ไป host API ได้ ปลายทางเป็นฐานตัวเดียวกัน — ดู lib/sheetsSource.js)
import {
  usingSql, sqlRoute,
  readExpenseRefs, readExpenses, saveOtherExpense, bulkImportExpenses, deleteExpenseByMonth,
} from '../../lib/sheetsSource';

// ทาง SQL อาจต้องลองต่อตรงก่อน (8 วิ) แล้วค่อยถอยไป host API ที่วิ่งผ่าน tunnel ของเครื่องออฟฟิศ
// ค่าเริ่มต้นของ Vercel (10 วิ) ตัดกลางทางพอดี — ให้เท่ากับ API ตัวอื่นในโปรเจกต์
export const config = { maxDuration: 60 };

const SCRIPT_URL =
  process.env.EXPENSE_GAS_URL ||
  'https://script.google.com/macros/s/AKfycbwcRP65mAO0jWusYr1OfcgxpW8GU7yv0t85VcnQ3ShTjEROaXCF2d3MNo_VffNho6Y/exec';

const READ_ACTIONS = { getExpenseRefs: readExpenseRefs, getExpenses: readExpenses };
const WRITE_ACTIONS = {
  saveOtherExpense, bulkImport: bulkImportExpenses, deleteExpenseByMonth,
};

async function callGas(body) {
  const upstream = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
    redirect: 'follow',
  });
  const text = await upstream.text();
  try { return { json: JSON.parse(text) }; }
  catch { return { error: 'ตอบกลับจาก GAS ไม่ใช่ JSON' }; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }

  const payload = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const action = String(payload.action || '').trim();

  // ถึงบรรทัด Apps Script ข้างล่างได้เฉพาะโหมด SHEETS_SOURCE=sheet — ไม่มีสาเหตุจากฝั่ง SQL ให้แนบ
  const sqlError = '';

  if (usingSql()) {
    try {
      if (READ_ACTIONS[action]) {
        return res.status(200).json({ status: 'success', source: 'sql', data: await READ_ACTIONS[action]() });
      }
      if (WRITE_ACTIONS[action]) {
        return res.status(200).json({ status: 'success', source: 'sql', data: await WRITE_ACTIONS[action](payload) });
      }
      return res.status(400).json({ status: 'error', message: `unknown action: ${action || '(ไม่ระบุ)'}` });
    } catch (err) {
      console.error(`expense-gas: ทำงานกับ SQL ไม่ได้ (${sqlRoute()}):`, err.message);
      // ทั้งอ่านและเขียนไม่ถอยไปชีท — ชีทหยุดรับข้อมูลตั้งแต่ย้ายเข้า SQL
      // เขียน: ถอยไปคือเขียนคนละที่กับที่หน้าเว็บอ่าน · อ่าน: ได้ข้อมูลเก่าที่ดูเหมือนรายการหลัง ๆ หายไป
      const what = READ_ACTIONS[action] ? 'อ่านข้อมูลจาก SQL ไม่ได้' : 'บันทึกลง SQL ไม่สำเร็จ — ยังไม่ได้บันทึกอะไรลงไป';
      return res.status(502).json({
        status: 'error',
        message:
          `${what} (${err.message}) · ` +
          'ตรวจว่าเครื่องออฟฟิศต่อฐานได้ / เปิด host-server อยู่ไหม (ทางสำรองตอนต่อ SQL ตรงไม่ติด) แล้วลองใหม่อีกครั้ง',
      });
    }
  }

  if (!SCRIPT_URL) {
    return res.status(503).json({ status: 'error', message: 'ยังไม่ได้ตั้งค่า EXPENSE_GAS_URL (Apps Script ของชีทค่าใช้จ่ายอื่นๆ)' });
  }
  try {
    const { json, error } = await callGas(JSON.stringify(payload));
    if (error) return res.status(502).json({ status: 'error', message: gasFailed(error, sqlError) });
    // ข้อมูลจากชีทเป็นของเก่า (ชีทหยุดรับข้อมูลตั้งแต่ย้ายเข้า SQL) — ต้องบอกหน้าเว็บให้ขึ้นป้ายเตือน
    // ไม่งั้นคนเห็นแค่ว่า "ข้อมูลไม่อัพเดท / ของเดือนหลัง ๆ หายไป" โดยไม่รู้ว่ากำลังดูชีทอยู่
    if (json && typeof json === 'object' && json.status === 'success') {
      return res.status(200).json({ ...json, source: 'sheet', warning: sheetWarning(action, sqlError) });
    }
    return res.status(200).json(json);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: gasFailed(err.message, sqlError) });
  }
}

/** ป้ายเตือนเมื่อคำตอบมาจาก Google Sheet แทน SQL */
function sheetWarning(action, sqlError) {
  const stale = 'ข้อมูลในชีทหยุดอัปเดตตั้งแต่ย้ายเข้า SQL — รายการที่บันทึกหลังจากนั้นจะไม่ขึ้นที่นี่';
  if (sqlError) {
    return `อ่านฐานข้อมูล SQL ไม่ได้ (${sqlError}) จึงแสดงข้อมูลจาก Google Sheet แทน · ${stale} ` +
      '· ตรวจว่าเครื่องออฟฟิศเปิด service NaraiAPI อยู่ แล้วกดโหลดใหม่';
  }
  const verb = READ_ACTIONS[action] ? 'อ่านจาก' : 'บันทึกลง';
  return `เว็บนี้ยังตั้งค่าให้${verb} Google Sheet อยู่ (SHEETS_SOURCE ไม่ใช่ sql) · ${stale} ` +
    '· ให้ตั้ง SHEETS_SOURCE=sql ในไฟล์ env ของเว็บ แล้ว build + รีสตาร์ตใหม่ (update-office.bat)';
}

/** ข้อความ error ที่บอกครบว่าลองทางไหนไปแล้วบ้าง */
function gasFailed(gasMessage, sqlError) {
  if (!sqlError) {
    return `${gasMessage} — ตอนนี้ยังอ่านจาก Google Sheets อยู่ ` +
      '(ถ้าย้ายข้อมูลเข้า SQL แล้ว ให้ตั้ง SHEETS_SOURCE=sql ในไฟล์ env ของเว็บ แล้ว build + รีสตาร์ตใหม่)';
  }
  return `อ่านจาก SQL ไม่ได้ (${sqlError}) แล้วถอยไปถาม Google Sheets ก็ไม่ได้อีก (${gasMessage})`;
}
