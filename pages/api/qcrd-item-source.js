// วัตถุดิบที่มีอยู่ในข้อมูลจริงแต่ยังไม่มีในทะเบียน — ให้หน้า QC/RD > วัตถุดิบ หยิบมาเพิ่ม
//
//   GET /api/qcrd-item-source?schema=1           ต้นทางไหนอ่านได้บ้าง + เหลือให้เพิ่มกี่ตัว
//   GET /api/qcrd-item-source?src=bom&q=หมู      ค้นในต้นทางนั้น (ค้นที่ฝั่ง SQL)
//
// ต้นทางทั้งหมดอยู่ในฐาน InventoryNarai ฐานเดียวกับทะเบียนวัตถุดิบ:
//   bom = dbo.qcrd_bom (สูตรที่หน้าเมนูใช้อยู่) · plan = dbo.stock_plan · closing = dbo.stock_closing
//
// อ่านอย่างเดียว — การบันทึกยังไปทาง /api/qcrd-save action addItem เหมือนการเพิ่มวัตถุดิบปกติ
// ทางไปถึงฐาน: ต่อ SQL ตรงก่อน ต่อไม่ติดถอยไป host API (เหมือน /api/qcrd ทุกประการ)
export const config = { maxDuration: 30 };

import { fetchItemSource, fetchItemSourceSchema, QCRD_API_BASE } from '../../lib/qcrdSource';

/** host-server รุ่นก่อนหน้านี้ยังไม่มีเส้น /qcrd/item-source — express ตอบ 404 เป็นหน้า HTML
 *  ซึ่งอ่านแล้วนึกว่า tunnel พัง ทั้งที่แค่ยังไม่ได้รีสตาร์ต node หลัง git pull */
const explain = (err) => {
  const msg = err?.message || 'อ่านวัตถุดิบจากฐานข้อมูลไม่ได้';
  if (/HTTP 404|ตอบไม่ใช่ JSON \(HTTP 404\)|Cannot GET/i.test(msg)) {
    return `${msg}\n→ เครื่องที่ ${QCRD_API_BASE} ยังไม่มีเส้น /qcrd/item-source — ที่เครื่องออฟฟิศต้อง ` +
      'git pull แล้วรีสตาร์ต host-server (host-server\\start-narai.ps1 -Restart -NoTunnel)';
  }
  return msg;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (String(req.query.schema || '') === '1') {
      const data = await fetchItemSourceSchema();
      return res.status(200).json({ status: 'success', data });
    }

    const src = String(req.query.src || '').trim();
    if (!src) {
      return res.status(400).json({ status: 'error', message: 'ต้องส่ง ?src= (bom | plan | closing) หรือ ?schema=1' });
    }

    const data = await fetchItemSource(src, {
      q: String(req.query.q || '').trim(),
      limit: Number(req.query.limit) || 50,
    });
    return res.status(200).json({ status: 'success', data });
  } catch (err) {
    console.error('qcrd-item-source error:', err?.message);
    // คืน 200 พร้อม status:'error' แบบเดียวกับ API อื่นของ QC/RD — หน้าเว็บอ่าน message ไปแสดงตรง ๆ
    return res.status(200).json({ status: 'error', message: explain(err) });
  }
}
