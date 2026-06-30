// เรียก Google Apps Script ของชีท "ค่าใช้จ่ายอื่นๆ" ผ่าน proxy /api/expense-gas
export const apiCall = async (action, payload = {}) => {
  const res = await fetch('/api/expense-gas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await res.json();
  if (result.status === 'success') return result;
  throw new Error(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
};
