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
  const result = await res.json();
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
  const result = await res.json();
  if (result.status === 'success') return result;
  throw new Error(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
};
