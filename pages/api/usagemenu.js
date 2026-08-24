// [เลิกใช้แล้ว] ยอดใช้วัตถุดิบ "แยกตามเมนูที่ขายจริง"
// หน้านับสต๊อกย้ายไปใช้ byMenu จาก /api/usage-bom แทน เพราะ endpoint นี้คืนค่า sold
// ที่ไม่ตรงกับ /usagebytable (เจอเมนู P20 ได้ 451 ทั้งที่ผลรวมรายโต๊ะ 225.5 = ต่างกันเท่าตัว)
// เก็บไฟล์ไว้เผื่อเทียบข้อมูลย้อนหลังเท่านั้น — อย่าเอากลับมาใช้โดยไม่แก้ฝั่งเซิร์ฟเวอร์เดิมก่อน
// Vercel ไม่ต่อ DB เอง — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET {USAGE_API_BASE}/usagebymenu?branch=<code>&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
//   -> { status:'success', data:{ "<itemCode>":[{menu, qty}, ...], ... } }
// ตั้งค่า env บน Vercel: USAGE_API_BASE (จำเป็น), USAGE_API_TOKEN (ถ้าตั้ง token ฝั่งออฟฟิศ)
// base URL / timeout / retry / CORS / ข้อความ error อยู่ที่ lib/upstream.mjs ชุดเดียวกับ Narai-branch
import { USAGE_API_BASE, fetchUpstream, applyCors, replyUpstreamError } from '../../lib/upstream.mjs';

// ปลายทางคำนวณข้ามหลายวันได้นาน — ให้เวลาฟังก์ชันเท่ากับ API พี่น้อง (ดู HEAVY_UPSTREAM_OPTS)
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const { branch, startDate, endDate } = req.query;
  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: {} });
  }

  try {
    const params = new URLSearchParams({ branch: branchKey, start: startDate, end: endDate });
    const r = await fetchUpstream(`${USAGE_API_BASE}/usagebymenu?${params.toString()}`);
    if (!r.ok) {
      return res.status(502).json({ status: 'error', message: `Office API Error: ${r.status}` });
    }
    const payload = await r.json();
    return res.status(200).json({
      status: 'success',
      data: (payload && payload.data) ? payload.data : {},
      daily: (payload && payload.daily) ? payload.daily : {}, // ยอดใช้แยกรายวันต่อวัตถุดิบ (ชุดเดียวกับ Narai-branch)
    });
  } catch (error) {
    return replyUpstreamError(res, error, 'usagemenu');
  }
}
