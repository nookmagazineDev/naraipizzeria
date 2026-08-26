// Proxy ไป Google Apps Script ของชีท QC/RD (1v8WRT… — menu/BOM/item)
// deploy สคริปต์จาก qcrd-apps-script.gs แล้วตั้ง URL ผ่าน env QCRD_GAS_URL บน Vercel
// หรือใส่ตรง ๆ ตรง fallback ด้านล่าง
//
// หมายเหตุ: เดิมเวลา GAS ตอบกลับมาไม่ใช่ JSON เราโยนข้อความ "ตอบกลับจาก GAS ไม่ใช่ JSON"
// อย่างเดียว ซึ่งบอกไม่ได้เลยว่าพังตรงไหน (deployment หาย / ต้องล็อกอิน / สคริปต์ error)
// ตอนนี้เก็บ HTTP status + URL ปลายทางหลัง redirect + เนื้อหาที่ได้จริงมาแปลเป็นสาเหตุ
// ตัวแปลอยู่ใน lib/gasDiagnose.js ใช้ร่วมกับ /api/stock-gas (สต๊อก/พนักงาน)
import { diagnoseGas } from '../../lib/gasDiagnose';
const SCRIPT_URL =
  process.env.QCRD_GAS_URL ||
  'https://script.google.com/macros/s/AKfycbySKsNhK73tCvSY1SywTGhQ7ntw8UwbFNLWAZYw8sT0PFMXiuovukD349h9-PYnKpoF/exec';

async function callGas(body) {
  const upstream = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
    redirect: 'follow',
  });
  const text = await upstream.text();
  return { status: upstream.status, finalUrl: upstream.url, text };
}

export default async function handler(req, res) {
  // GET = health check เปิดจากเบราว์เซอร์ได้เลย (/api/qcrd-gas) ไว้ดูว่า deployment ยังตอบไหม
  if (req.method === 'GET') {
    const usingEnv = Boolean(process.env.QCRD_GAS_URL);
    try {
      const { status, finalUrl, text } = await callGas(JSON.stringify({ action: '__ping__' }));
      let json = null;
      try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON — รายงานเป็น diagnosis ด้านล่าง */ }
      // สคริปต์ QC/RD ตัวถูกต้องเท่านั้นที่จะตอบ "unknown action: __ping__" กลับมา
      // ถ้าตอบ JSON อย่างอื่น = deployment นี้ถูก deploy ทับด้วยสคริปต์ตัวอื่นแล้ว
      const healthy = Boolean(json && /unknown action/.test(String(json.message || '')));
      return res.status(200).json({
        status: healthy ? 'success' : 'error',
        scriptUrlFrom: usingEnv ? 'env QCRD_GAS_URL' : 'fallback ในโค้ด',
        scriptUrl: SCRIPT_URL,
        httpStatus: status,
        finalUrl,
        gasResponse: json || undefined,
        message: healthy
          ? 'deployment ตอบเป็น JSON ปกติ — โหมดเขียนใช้งานได้'
          : json
            ? 'deployment ตอบเป็น JSON แต่ไม่ใช่โค้ด QC/RD (น่าจะถูก deploy ทับด้วยสคริปต์อื่น) — ให้ deploy qcrd-apps-script.gs เป็น deployment ใหม่แยกตัว แล้วอัปเดต env QCRD_GAS_URL'
            : diagnoseGas(status, finalUrl, text, { scriptName: 'qcrd-apps-script.gs', envName: 'QCRD_GAS_URL' }),
      });
    } catch (err) {
      return res.status(200).json({
        status: 'error', scriptUrlFrom: usingEnv ? 'env QCRD_GAS_URL' : 'fallback ในโค้ด',
        scriptUrl: SCRIPT_URL, message: `เรียก GAS ไม่สำเร็จ: ${err.message}`,
      });
    }
  }

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
    const { status, finalUrl, text } = await callGas(body);
    let json;
    try { json = JSON.parse(text); }
    catch { return res.status(502).json({ status: 'error', message: diagnoseGas(status, finalUrl, text, { scriptName: 'qcrd-apps-script.gs', envName: 'QCRD_GAS_URL' }) }); }
    return res.status(200).json(json);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
