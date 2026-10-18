// กดพื้นที่มืดรอบป๊อปอัพแล้วไม่ปิด (กันข้อมูลที่กรอกหายเพราะเผลอกด) — สั่นกล่องเตือนแทน
// ใช้เป็น onClick ของฉากหลัง: ปิดได้ด้วยปุ่ม ✕ หรือ "ยกเลิก" เท่านั้น
export function nudgeModal(e) {
  if (e.target !== e.currentTarget) return;
  const box = e.currentTarget.firstElementChild;
  if (!box) return;
  box.classList.remove('modal-nudge');
  void box.offsetWidth;   // รีสตาร์ตแอนิเมชันเมื่อกดซ้ำ
  box.classList.add('modal-nudge');
}
