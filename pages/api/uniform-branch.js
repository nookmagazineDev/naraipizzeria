// ยูนิฟอร์มของสาขา — หน้า HR → "ยูนิฟอร์ม" (ดูอย่างเดียว)
//
// ที่มา: dbo.UniformBranch ในฐาน InventoryNarai (ตารางที่มีอยู่ในฐานอยู่แล้ว ไม่ได้สร้างจากรีโปนี้)
//
//   GET /api/uniform-branch              -> แถวล่าสุดไม่เกิน 20000 แถว ครบทุกคอลัมน์
//   GET /api/uniform-branch?limit=50000  -> ขอแถวเพิ่ม (สูงสุด 50000)
//
// คืน: { status:'success', data: { rows[], total, truncated, limit, layout, source } }
//   layout.columns = คอลัมน์จริงในตาราง [{ name, type, kind: 'text'|'number'|'date' }]
//   layout.fields  = คอลัมน์ที่เดาว่าเป็น branch/item/size/qty/price/total/date/employee/status
//                    (หน้าเว็บใช้เป็นค่าเริ่มต้นของตัวเลือกจัดกลุ่ม/รวมยอด)
//
// ทางไปถึงฐานเลือกให้ที่ lib/sheetsSource.js (ต่อ SQL ตรง แล้วถอยไป host API ที่เครื่องออฟฟิศ)
// ไม่มีชีทให้ถอย — ต่อฐานไม่ได้ = ตอบ error ให้หน้าเว็บขึ้นข้อความ
import { readUniformBranch } from '../../lib/sheetsSource';

// ต่อ SQL ตรงไม่ติดแล้วถอยไป host API กินเวลาเกินเพดาน 10 วิของ Vercel ได้
export const config = { maxDuration: 60 };

/** แปลง error ที่ผู้ใช้แก้เองได้ ให้เป็นข้อความที่บอกวิธีแก้ */
function explain(msg) {
  if (/Cannot GET \/sheets\/uniform-branch|HTTP 404/i.test(msg)) {
    return 'host-server ที่เครื่องออฟฟิศเป็นเวอร์ชันเก่า (ยังไม่มี /sheets/uniform-branch) — ' +
      'ที่เครื่องนั้น: git pull แล้วรัน start-narai.ps1 -Restart';
  }
  if (/permission was denied|SELECT permission/i.test(msg)) {
    return 'login ที่แดชบอร์ดใช้ยังไม่มีสิทธิ์อ่านตาราง dbo.UniformBranch — ให้สิทธิ์ SELECT ที่เครื่องออฟฟิศก่อน';
  }
  return msg;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'GET เท่านั้น' });
  }

  const limit = Number(String(req.query.limit || '').trim()) || 0;

  try {
    const data = await readUniformBranch({ limit: limit > 0 ? limit : undefined });
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      status: 'success',
      data,
      meta: { rows: data.rows.length, total: data.total, source: data.source },
    });
  } catch (err) {
    console.error('uniform-branch: อ่านไม่ได้:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ status: 'error', message: explain(err.message || String(err)) });
  }
}
