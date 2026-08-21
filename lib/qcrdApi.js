// งาน "เขียน" ของ QC/RD ทั้งหมดผ่าน /api/qcrd-save
// ปลายทางจริงเป็น SQL Server (InventoryNarai) หรือ Google Apps Script ตาม env QCRD_SOURCE
// — ฝั่งหน้าเว็บเรียกเหมือนกันทั้งสองแบบ ไม่ต้องรู้ว่าข้อมูลอยู่ที่ไหน
export const apiCall = async (action, payload = {}) => {
  const res = await fetch('/api/qcrd-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await res.json();
  if (result.status === 'success') return result;
  throw new Error(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
};
