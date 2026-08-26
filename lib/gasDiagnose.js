// แปลว่าที่ Apps Script ตอบมา (ที่ไม่ใช่ JSON) แปลว่าอะไร แล้วบอกวิธีแก้เป็นภาษาไทย
//
// หน้า error ของ Google เป็น HTML ล้วน ถ้าโยนแค่ "ตอบกลับจาก GAS ไม่ใช่ JSON" ออกไป
// คนอ่านไม่มีทางรู้เลยว่าพังตรงไหน — deployment ถูกลบ / ตั้งสิทธิ์ผิด / สคริปต์ error
// ใช้ร่วมกันระหว่าง /api/qcrd-gas (ชีทต้นทุนเมนู) กับ /api/stock-gas (สต๊อก+พนักงาน)

/** ตัด tag HTML ออกให้เหลือข้อความอ่านรู้เรื่อง */
export const stripHtml = (t) =>
  String(t || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * @param status    HTTP status ที่ได้จาก GAS
 * @param finalUrl  URL ปลายทางหลัง redirect (บอกได้ว่าโดนเด้งไปหน้าล็อกอินไหม)
 * @param text      เนื้อหาที่ตอบกลับมาจริง
 * @param scriptName ชื่อไฟล์สคริปต์ในรีโป ไว้บอกว่าต้องเอาตัวไหนไป deploy ใหม่
 * @param envName   ชื่อ env ที่เก็บ URL ไว้ (ถ้ามี) ไว้บอกว่าต้องไปอัปเดตที่ไหน
 */
export function diagnoseGas(status, finalUrl, text, { scriptName = '', envName = '' } = {}) {
  const snippet = stripHtml(text).slice(0, 300);
  const url = String(finalUrl || '');
  const redeploy = scriptName ? `ให้ Deploy สคริปต์ ${scriptName} ใหม่` : 'ให้ Deploy สคริปต์ใหม่';
  const updateEnv = envName ? ` แล้วอัปเดต env ${envName} บน Vercel` : ' แล้วอัปเดต URL ในโค้ด';

  if (url.includes('accounts.google.com') || /ลงชื่อเข้าใช้|sign in|Sign in/.test(snippet)) {
    return 'GAS เด้งไปหน้าล็อกอิน Google — deployment ตั้งสิทธิ์ไม่ถูก ให้แก้ที่ Apps Script > Deploy > ' +
      'Manage deployments > แก้ไข > Who has access = Anyone (และ Execute as = Me) แล้ว Deploy ใหม่';
  }
  if (status === 404 || /Page Not Found|ไม่พบหน้าเว็บ|Requested entity was not found|unable to open the file/i.test(snippet)) {
    return `ไม่พบ deployment ตาม URL นี้ (ถูกลบ/เก็บถาวร หรือ URL ผิด) — ${redeploy}${updateEnv}`;
  }
  if (/Authorization is required|ต้องได้รับสิทธิ์|Script function not found|Exception|TypeError|ReferenceError|SyntaxError/i.test(snippet)) {
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
