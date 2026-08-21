// QC/RD ฝั่ง "เขียน" — ทางเดียวที่หน้าเว็บใช้บันทึก (lib/qcrdApi.js ยิงมาที่นี่)
//
// ส่งต่อไปที่ไหน ขึ้นกับ env QCRD_SOURCE เหมือนฝั่งอ่านใน /api/qcrd:
//   sheet (ค่าเริ่มต้น) → /api/qcrd-gas (Apps Script เขียนลงชีทต้นทุนเมนู)
//   sql                → เขียนลงฐาน InventoryNarai — ต่อ SQL ตรงจาก Vercel ถ้าตั้งรหัสไว้
//                        ไม่งั้นยิงไป host API POST /qcrd/save (ดู lib/qcrdSource.js)
//
// action ทั้งสองทางชื่อเดียวกันและรับ payload ชุดเดียวกัน: saveMenu · saveMenuStatus ·
// saveMenuGroup · saveItem · addItem · deleteItem · updateItemUnits · sortBom
// สลับโหมดจึงไม่ต้องแก้หน้าเว็บเลย
//
// ฝั่งเขียนไม่มี fallback โดยตั้งใจ — ถ้า SQL ล่มแล้วแอบไปเขียนชีทแทน ข้อมูลสองที่จะแยกจากกัน
// ทันทีโดยไม่มีใครรู้ตัว ปล่อยให้ error ขึ้นหน้าเว็บตรง ๆ ดีกว่า
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
