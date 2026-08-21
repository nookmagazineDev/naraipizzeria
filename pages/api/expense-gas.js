// หลังบ้านของหน้า "ค่าใช้จ่ายอื่นๆ"
//
// ที่มาเดิม: proxy ไป Google Apps Script ของชีท 1YXOaA… (ตั้ง URL ผ่าน env EXPENSE_GAS_URL)
// ที่มาใหม่ (SHEETS_SOURCE=sql): ทำงานกับ dbo.expense_ref / dbo.expense_entry ในฐาน InventoryNarai ตรง ๆ
//   ชื่อ action และรูปแบบ body/ผลลัพธ์เหมือนเดิมทุกช่อง หน้าเว็บ (lib/expenseApi.js) จึงไม่ต้องแก้
//
// ฝั่งอ่าน (getExpenseRefs / getExpenses) ถ้า SQL ล่มจะถอยไปถาม Apps Script ให้
// ฝั่งเขียนไม่ถอย — เขียนลงชีทบ้างลงฐานบ้าง แปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น
import {
  usingSql, sqlRoute,
  readExpenseRefs, readExpenses, saveOtherExpense, bulkImportExpenses, deleteExpenseByMonth,
} from '../../lib/sheetsSource';

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

  // เก็บสาเหตุจริงจากฝั่ง SQL ไว้แนบท้าย error ของ Apps Script (ดูเหตุผลใน stock-gas.js)
  let sqlError = '';

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
      sqlError = err.message;
      console.error(`expense-gas: ทำงานกับ SQL ไม่ได้ (${sqlRoute()}):`, err.message);
      if (!READ_ACTIONS[action]) {
        // การเขียนห้ามถอยไปชีท — บอกไปตรง ๆ ว่าบันทึกไม่สำเร็จ ดีกว่าเขียนคนละที่กับที่หน้าเว็บอ่าน
        return res.status(502).json({
          status: 'error',
          message: `บันทึกลง SQL ไม่สำเร็จ (${err.message}) — ยังไม่ได้บันทึกอะไรลงไป ลองใหม่อีกครั้ง`,
        });
      }
      // ฝั่งอ่านถอยไปถาม Apps Script ต่อได้ หน้าเว็บจะได้ไม่ค้าง
    }
  }

  if (!SCRIPT_URL) {
    return res.status(503).json({ status: 'error', message: 'ยังไม่ได้ตั้งค่า EXPENSE_GAS_URL (Apps Script ของชีทค่าใช้จ่ายอื่นๆ)' });
  }
  try {
    const { json, error } = await callGas(JSON.stringify(payload));
    if (error) return res.status(502).json({ status: 'error', message: gasFailed(error, sqlError) });
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
