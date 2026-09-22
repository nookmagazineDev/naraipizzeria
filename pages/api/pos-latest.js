// ตรวจว่า "หน้าเว็บมองเห็นฐาน POS ตัวเดียวกับที่เราเปิด SSMS ดูอยู่หรือเปล่า"
//
// เกิดจากอาการที่แกะยาก: SSMS บอก MAX([Date]) = เมื่อคืน 22:30 มีบิลรวม 3.5 แสนใบ
// แต่หน้ายอดรายวันของวันเดียวกันขึ้นว่า "ไม่พบข้อมูล" และดึงทั้งเดือนก็มาไม่ครบทุกวัน
// ทั้งที่ฝั่ง host ไม่ได้ error สักครั้ง (/cpaidbetweendate คืน {"data":[]} พร้อมสถานะ 200)
// สามชั้นนี้ชี้นิ้วหากันเองไม่ได้เลยถ้าไม่มีเส้นที่ตอบว่า "ฉันกำลังอ่านฐานไหนอยู่":
//
//   เบราว์เซอร์ → /api/sales (Vercel) → STORE_API_BASE → host-server ที่ร้าน → SQL Server
//
// เปิดเส้นนี้จากเบราว์เซอร์ที่ล็อกอินแดชบอร์ดอยู่ (https://<โดเมน>/api/pos-latest)
// จะได้คำตอบจากปลายสายจริงที่ Vercel ใช้ แล้วเอาไปเทียบกับที่เครื่องออฟฟิศเปิด
// http://localhost:14365/pos/latest — ตรงไหนไม่ตรงกันคือจุดที่ข้อมูลหาย:
//
//   base ไม่ใช่โดเมนที่คิดไว้        → env STORE_API_BASE บน Vercel ชี้ผิดที่
//   host (ชื่อเครื่อง) คนละตัว       → tunnel/โดเมนไม่ได้วิ่งมาที่เครื่องออฟฟิศเครื่องนี้
//   serverName/dbName/totalBills ต่าง → host-server ต่อคนละ instance/คนละฐานกับ SSMS
//   recentDays หยุดที่วันหนึ่ง        → ฐานที่เว็บอ่านอยู่ไม่ได้รับบิลใหม่ตั้งแต่วันนั้น
export const config = { maxDuration: 60 };

import { explainHostError, explainUpstreamError } from '../../lib/directRoute';

const STORE_API_BASE = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

export default async function handler(req, res) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
  // ค่า base ต้องบอกเสมอ แม้ปลายทางจะล่ม — คำถามแรกของงานนี้คือ "ยิงไปที่ไหน" ไม่ใช่ "ตอบว่าอะไร"
  const base = STORE_API_BASE;

  try {
    const upstream = await fetch(`${base}/pos/latest?days=${days}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(55000),
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    // host-server รุ่นก่อนหน้านี้ยังไม่มีเส้น /pos/latest — express ตอบ 404 หน้า HTML
    // ซึ่งอ่านแล้วนึกว่า tunnel พัง ทั้งที่แค่ยังไม่ได้รีสตาร์ต node หลัง git pull
    if (upstream.status === 404) {
      return res.status(503).json({
        base,
        error: `host API (${base}) ยังไม่มีเส้น /pos/latest — ที่เครื่องออฟฟิศต้อง git pull ` +
          `แล้วรีสตาร์ต host-server (ปิดหน้าต่าง node เดิมแล้ว node server.js ใหม่) เส้นใหม่ถึงจะโผล่`,
      });
    }
    if (!upstream.ok) throw await explainUpstreamError(upstream, { base });
    const data = await upstream.json();
    return res.status(200).json({ base, ...data });
  } catch (err) {
    const explained = err?.explained ? err : explainHostError(err, { base, timeoutMs: 55000 });
    console.error('pos-latest proxy error:', explained.message);
    return res.status(502).json({ base, error: explained.message });
  }
}
