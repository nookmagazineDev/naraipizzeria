// เรียก Google Apps Script ของชีท QC/RD (1v8WRT…) ผ่าน proxy /api/qcrd-gas — ใช้เฉพาะงาน "เขียน"
export const apiCall = async (action, payload = {}) => {
  const res = await fetch('/api/qcrd-gas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await res.json();
  if (result.status === 'success') return result;
  throw new Error(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
};
