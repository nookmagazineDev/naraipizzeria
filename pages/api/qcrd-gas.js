import { fetchScript } from '../../lib/upstream.mjs';
// Proxy ไป Google Apps Script ของชีท QC/RD (1v8WRT… — menu/BOM/item)
// deploy สคริปต์จาก qcrd-apps-script.gs แล้วตั้ง URL ผ่าน env QCRD_GAS_URL บน Vercel
// หรือใส่ตรง ๆ ตรง fallback ด้านล่าง
//
// หมายเหตุ: เดิมเวลา GAS ตอบกลับมาไม่ใช่ JSON เราโยนข้อความ "ตอบกลับจาก GAS ไม่ใช่ JSON"
// อย่างเดียว ซึ่งบอกไม่ได้เลยว่าพังตรงไหน (deployment หาย / ต้องล็อกอิน / สคริปต์ error)
// ตอนนี้เก็บ HTTP status + URL ปลายทางหลัง redirect + เนื้อหาที่ได้จริงมาแปลเป็นสาเหตุ
const SCRIPT_URL =
  process.env.QCRD_GAS_URL ||
  'https://script.google.com/macros/s/AKfycbySKsNhK73tCvSY1SywTGhQ7ntw8UwbFNLWAZYw8sT0PFMXiuovukD349h9-PYnKpoF/exec';

// ตัด tag HTML ออกให้เหลือข้อความอ่านรู้เรื่อง (หน้า error ของ Google เป็น HTML ล้วน)
const stripHtml = (t) =>
  String(t || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

// แปลว่าที่ GAS ตอบมา (ไม่ใช่ JSON) แปลว่าอะไร แล้วบอกวิธีแก้เป็นภาษาไทย
function diagnose(status, finalUrl, text) {
  const snippet = stripHtml(text).slice(0, 300);
  const url = String(finalUrl || '');

  if (url.includes('accounts.google.com') || /ลงชื่อเข้าใช้|sign in|Sign in/.test(snippet)) {
    return 'GAS เด้งไปหน้าล็อกอิน Google — deployment ตั้งสิทธิ์ไม่ถูก ให้แก้ที่ Apps Script > Deploy > Manage deployments > แก้ไข > Who has access = Anyone (และ Execute as = Me) แล้ว Deploy ใหม่';
  }
  if (status === 404 || /Page Not Found|ไม่พบหน้าเว็บ|Requested entity was not found|unable to open the file/i.test(snippet)) {
    return 'ไม่พบ deployment ตาม URL นี้ (ถูกลบ/เก็บถาวร หรือ URL ผิด) — ให้ Deploy สคริปต์ qcrd-apps-script.gs ใหม่ แล้วอัปเดต env QCRD_GAS_URL บน Vercel';
  }
  if (/Authorization is required|ต้องได้รับสิทธิ์|Script function not found|Exception|TypeError|ReferenceError/i.test(snippet)) {
    return `สคริปต์ฝั่ง GAS error: ${snippet}`;
  }
  if (status >= 500) {
    return `GAS ตอบ HTTP ${status} (ฝั่ง Google ขัดข้องหรือสคริปต์ล้ม): ${snippet || 'ไม่มีเนื้อหา'}`;
  }
  if (!snippet) {
    return `GAS ตอบกลับว่าง (HTTP ${status}) — ตรวจว่า deployment ยังใช้งานได้อยู่`;
  }
  return `ตอบกลับจาก GAS ไม่ใช่ JSON (HTTP ${status}): ${snippet}`;
}

async function callGas(body) {
  // fetchScript = timeout 60 วิ ไม่ลองใหม่ (คำสั่งเขียน ยิงซ้ำ = ได้แถวซ้ำในชีท)
  const upstream = await fetchScript(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
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
            : diagnose(status, finalUrl, text),
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
    catch { return res.status(502).json({ status: 'error', message: diagnose(status, finalUrl, text) }); }
    return res.status(200).json(json);
  } catch (err) {
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
