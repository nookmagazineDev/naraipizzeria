import { STORE_API_BASE, HEAVY_UPSTREAM_OPTS, fetchUpstream, replyUpstreamError } from '../../lib/upstream.mjs';
// base URL / timeout / retry / ข้อความ error อยู่ที่ lib/upstream.mjs ชุดเดียวกับ Narai-branch
// เดิมเป็น Edge Function — Vercel Edge runtime มี hard timeout ราว ~25 วินาที
// ซึ่งไม่พอกับข้อมูลรายการระดับไอเทม (มากกว่ายอดบิลหลายเท่า) เวลาดึงทุกสาขา
// พร้อมกันในช่วงกว้าง ทำให้ได้หน้า error ของแพลตฟอร์ม ("An error occurred...")
// แทน JSON แล้วฝั่งเว็บ parse ไม่ออก → เปลี่ยนเป็น Node.js serverless function
// ธรรมดา (เหมือน API อื่นในโปรเจกต์) เพื่อใช้ maxDuration ที่นานกว่า Edge ได้มาก
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const { start, end, outlet } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end required' });
  }

  try {
    let url = `${STORE_API_BASE}/ctranbetweendate?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    if (outlet) url += `&outlet=${encodeURIComponent(outlet)}`;
    // ข้อมูลระดับไอเทมหนักกว่ายอดบิลหลายเท่า — ใช้ชุด timeout/retry ของงานหนัก
    const upstream = await fetchUpstream(url, HEAVY_UPSTREAM_OPTS);
    if (!upstream.ok) {
      const msg = `เซิร์ฟเวอร์ที่ออฟฟิศตอบผิดพลาด (HTTP ${upstream.status})`;
      // หน้าแดชบอร์ดอ่านสาเหตุจากคีย์ error — ส่ง message คู่กันให้เข้าชุดกับ API ตัวอื่น
      return res.status(502).json({ status: 'error', message: msg, error: msg });
    }
    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (err) {
    return replyUpstreamError(res, err, 'detail');
  }
}
