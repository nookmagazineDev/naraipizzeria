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
