// Proxy ไป Google Apps Script ของชีท "ค่าใช้จ่ายอื่นๆ" (1YXOaA…)
// ตั้ง URL ที่ deploy แล้วผ่าน env EXPENSE_GAS_URL บน Vercel หรือใส่ตรง ๆ ตรง fallback ด้านล่าง
const SCRIPT_URL =
  process.env.EXPENSE_GAS_URL ||
  ''; // ← วาง URL /exec ที่ deploy จาก Apps Script ของชีท 1YXOaA ที่นี่ (หรือใช้ env)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }
  if (!SCRIPT_URL) {
    return res.status(503).json({ status: 'error', message: 'ยังไม่ได้ตั้งค่า EXPENSE_GAS_URL (Apps Script ของชีทค่าใช้จ่ายอื่นๆ)' });
  }
  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const upstream = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return res.status(502).json({ status: 'error', message: 'ตอบกลับจาก GAS ไม่ใช่ JSON' }); }
    return res.status(200).json(json);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
