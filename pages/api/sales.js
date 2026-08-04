// เดิมเป็น Edge Function — Vercel Edge runtime มี hard timeout ราว ~25 วินาที
// ซึ่งไม่พอกับช่วงที่ host/SQL ตอบช้า (ยิ่งดึงทุกสาขาพร้อมกัน) ทำให้ได้หน้า error
// ของแพลตฟอร์ม ("An error occurred...") แทน JSON แล้วฝั่งเว็บ parse ไม่ออก
// → เปลี่ยนเป็น Node.js serverless function ธรรมดา (เหมือน API อื่นในโปรเจกต์)
// เพื่อใช้ maxDuration ที่นานกว่า Edge ได้มาก
export const config = { maxDuration: 60 };

const STORE_API_BASE = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

export default async function handler(req, res) {
  const { start, end, outlet } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end are required' });
  }

  try {
    let url = `${STORE_API_BASE}/cpaidbetweendate?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    if (outlet) url += `&outlet=${encodeURIComponent(outlet)}`;
    const upstream = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(55000),
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    if (!upstream.ok) throw new Error(`Upstream HTTP ${upstream.status}`);
    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Sales API proxy error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
