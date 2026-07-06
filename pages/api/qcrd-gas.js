// Proxy ไป Google Apps Script ของชีท QC/RD (1v8WRT… — menu/BOM/item)
// deploy สคริปต์จาก qcrd-apps-script.gs แล้วตั้ง URL ผ่าน env QCRD_GAS_URL บน Vercel
// หรือใส่ตรง ๆ ตรง fallback ด้านล่าง
const SCRIPT_URL = process.env.QCRD_GAS_URL || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }
  if (!SCRIPT_URL) {
    return res.status(200).json({
      status: 'error',
      message: 'ยังไม่ได้ deploy Apps Script (qcrd-apps-script.gs) — โหมดนี้ดูข้อมูลได้อย่างเดียว',
    });
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
