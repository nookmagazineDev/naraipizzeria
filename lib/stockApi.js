// อ่านผลตอบกลับเป็น JSON — ถ้าไม่ใช่ JSON แปลเป็นข้อความที่คนอ่านเข้าใจแทน
// "Unexpected token 'A', "An error o"... is not valid JSON" ซึ่งไม่บอกอะไรเลย
//
// ตัวที่ตอบมาไม่ใช่ JSON ส่วนใหญ่เป็นหน้า error ของ Vercel เอง (ฟังก์ชันใช้เวลาเกิน maxDuration
// เพราะ Apps Script ตอบช้า หรือฟังก์ชันพังก่อนตอบ) ไม่ใช่ของ /api/stock-gas ซึ่งตอบ JSON เสมอ
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const s = res.status;
    let why;
    if (s === 504 || /timeout|timed out/i.test(text)) {
      why = 'เซิร์ฟเวอร์ตอบช้าเกินกำหนด (Google Apps Script ใช้เวลานานเกินไป) — รอสักครู่แล้วลองใหม่';
    } else if (s === 401 || s === 403) {
      why = 'ไม่มีสิทธิ์เข้าถึง — ลองออกจากระบบแล้วเข้าใหม่';
    } else if (s === 404) {
      why = 'ไม่พบ API ที่เรียก — อาจกำลัง deploy เวอร์ชันใหม่อยู่ รอสักครู่แล้วลองใหม่';
    } else if (s >= 500) {
      why = 'เซิร์ฟเวอร์ขัดข้องชั่วคราว — รอสักครู่แล้วลองใหม่';
    } else {
      why = 'เซิร์ฟเวอร์ตอบกลับในรูปแบบที่อ่านไม่ได้ — ลองใหม่อีกครั้ง';
    }
    throw new Error(`${why} (HTTP ${s})`);
  }
}

// อ่านข้อมูลผ่าน proxy /api/stock-read (GET) — CDN/เบราว์เซอร์แคชได้ เลือกสาขาซ้ำจึงไม่ต้องรอ Apps Script ใหม่
// ใช้ได้เฉพาะ action ที่อยู่ใน allowlist ของ /api/stock-read เท่านั้น การเขียนยังต้องใช้ apiCall
//
// fresh = true → ต่อ ?t= กันไม่ให้ CDN คืนของที่แคชไว้ก่อนการบันทึกรอบนี้
// จำเป็นตอนโหลดใหม่หลังกดบันทึก: getStockItems แคชไว้ s-maxage=60 + stale-while-revalidate=3600
// ถ้าไม่ต่อ จะได้ภาพก่อนบันทึกกลับมาทันที (และได้ของเก่าต่อได้นานถึงชั่วโมงผ่าน stale-while-revalidate)
// = อาการ "บันทึกยอดนับแล้วเลขไม่เปลี่ยน" ทั้งที่ลงชีท/ฐานไปแล้ว
// /api/stock-read ส่งต่อเฉพาะพารามิเตอร์ใน allowlist ตัว t จึงไม่หลุดไปถึง Apps Script
export const apiRead = async (action, params = {}, { fresh = false } = {}) => {
  const qs = new URLSearchParams({ action });
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) qs.set(k, v);
  });
  if (fresh) qs.set('t', String(Date.now()));
  const res = await fetch(`/api/stock-read?${qs.toString()}`);
  const result = await readJson(res);
  if (result.status === 'success') return result;
  throw new Error(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
};

// เรียก Google Apps Script ผ่าน proxy /api/stock-gas (ใช้ใน STOCK menu)
export const apiCall = async (action, payload = {}) => {
  const res = await fetch('/api/stock-gas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await readJson(res);
  if (result.status === 'success') return result;
  throw new Error(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
};
