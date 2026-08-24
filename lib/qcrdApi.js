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

// ── ดันชีทขึ้น SQL (ให้หน้า "นับสต๊อก" ของ Narai-branch เห็นของที่แก้จากหน้านี้) ──
//
// /api/qcrd-save ดันให้อัตโนมัติหลังบันทึกลงชีทสำเร็จอยู่แล้ว แล้วแนบผลกลับมาในฟิลด์ sync
// syncNote() เอาไว้ต่อท้ายข้อความ toast ให้ผู้ใช้รู้ทันทีว่าขึ้นฐานแล้วหรือยัง
// ถ้ายังไม่ขึ้น กด syncSql() ซ้ำได้ (ดันแบบ MERGE ทำซ้ำกี่รอบก็ได้ ไม่ทำข้อมูลซ้ำ)

/** '' ถ้าขึ้น SQL แล้ว (หรือไม่มีการดันในรอบนั้น) · ข้อความเตือนถ้ายังไม่ขึ้น */
export const syncNote = (res) => {
  const sync = res && res.sync;
  if (!sync || sync.ok) return '';
  return ` · ⚠ ยังไม่ขึ้น SQL (หน้านับสต๊อกจะยังไม่เห็น): ${sync.message || 'ดันขึ้นฐานไม่สำเร็จ'}`;
};

/** ผลรวมว่าบันทึกรอบนั้น "ครบทั้งชีทและ SQL" ไหม — ใช้เลือกสีของ toast */
export const syncOk = (res) => !(res && res.sync) || res.sync.ok === true;

/** ดันขึ้น SQL เอง — steps: 'item' | 'menu' | 'bom' | 'group' | 'all' (คั่นด้วย , ได้) */
export const syncSql = async (steps = 'item', { verify = false } = {}) => {
  const r = await fetch('/api/qcrd-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps, verify: verify ? 1 : 0 }),
  });
  return r.json();
};
