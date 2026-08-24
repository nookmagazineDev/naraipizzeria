// QC/RD ฝั่ง "เขียน" — ทางเดียวที่หน้าเว็บใช้บันทึก (lib/qcrdApi.js ยิงมาที่นี่)
//
// ส่งต่อไป /api/qcrd-gas (Apps Script เขียนลงชีทต้นทุนเมนู) ที่เดียวกับที่ /api/qcrd อ่าน
// action: saveMenu · saveMenuStatus · saveMenuGroup · saveItem · addItem · deleteItem ·
// updateItemUnits · sortBom
//
// ทาง SQL ปิดไว้แล้ว (usingSql() คืน false เสมอ ดู lib/qcrdSource.js) — เมื่อก่อนเขียนลง
// InventoryNarai ผ่านเครื่องออฟฟิศ พอ host-server ไม่ได้รันก็บันทึกไม่ได้เลยทั้งหน้า
// โค้ดฝั่ง SQL ข้างล่างเก็บไว้เผื่อเปิดใช้อีกรอบ ตอนนี้ไม่ถูกเรียก
import { usingSql, saveQcrdSql } from '../../lib/qcrdSource';
import gasHandler from './qcrd-gas';

// saveMenu ที่มีเมนูผูกกันหลายชั้นใช้เวลานานกว่าค่าเริ่มต้น 10 วินาทีของ Vercel
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }
  if (!usingSql()) return gasHandler(req, res);

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    const json = await saveQcrdSql(body);
    return res.status(200).json(json);
  } catch (err) {
    // หน้าเว็บอ่านข้อความนี้ไปแสดงตรง ๆ จึงคืน 200 พร้อม status:'error' เหมือนที่ Apps Script ทำ
    return res.status(200).json({ status: 'error', message: err.message });
  }
}
