// กติกา "จำนวนหัวลูกค้า" — ที่เดียวที่เก็บกฎ ใช้ร่วมกันทั้งหน้าเว็บและฝั่ง API
//
// เดิมกฎชุดนี้ถูกเขียนซ้ำอยู่สามที่ (pages/index.js, pages/api/ai-chat.js และที่อื่นที่จะเพิ่มทีหลัง)
// พอรายงาน "ใช้วัตถุดิบต่อหัว" ต้องใช้ตัวหารชุดเดียวกับแดชบอร์ด จึงยกมารวมไว้ที่นี่
// ตัวเลขต่างกันแม้แต่นิดเดียวแปลว่าสองหน้าตอบคำถาม "ลูกค้ากี่หัว" ไม่ตรงกัน ซึ่งอธิบายยากกว่าที่คิด
//
// ⚠️ ไฟล์นี้ถูก import จากทั้งเบราว์เซอร์และฝั่งเซิร์ฟเวอร์
//    ห้ามใส่ import ที่เป็นโมดูลของ Node และห้ามอ่าน process.env (ฝั่งเบราว์เซอร์อ่านไม่เห็น)
//    กติกาเดียวกับ lib/branches.js และ lib/permissions.js

/**
 * ไอเทมบุฟเฟต์ที่นับเป็น "หัวลูกค้า" 1 หัว — นับเฉพาะจานที่จ่ายเงินจริง
 * ไม่รวมเด็กฟรี (101005) และผู้สูงอายุฟรี (401087 / 401105 / 401112)
 */
export const COVER_ITEM_CODES = [101001, 101002, 101003, 101004, 101107, 101108];

/**
 * สาขาที่นับหัวจากช่อง Cover All ของบิลแทนการนับจานบุฟเฟต์
 * (WRM 501 · WMT 503 — สองสาขานี้ลงจำนวนคนไว้ที่บิลโดยตรง ไม่ได้ยิงจานบุฟเฟต์รายหัว)
 */
export const COVERALL_OUTLETS = [501, 503];

/** ไอเทมนี้นับเป็นหัวลูกค้าไหม */
export const isCoverItem = (itemCode) => COVER_ITEM_CODES.indexOf(parseInt(itemCode)) >= 0;

/** สาขานี้นับหัวจาก Cover All ของบิลไหม (ไม่ใช่ = นับจานบุฟเฟต์) */
export const usesCoverAll = (outletId) => COVERALL_OUTLETS.includes(parseInt(outletId));

/**
 * จำนวนหัวจากรายการขายระดับไอเทม (ctranbetweendate) — สำหรับสาขาทั่วไป
 * ข้ามแถว void เหมือนที่แดชบอร์ดทำ ไม่งั้นบิลที่ยกเลิกแล้วยังนับเป็นลูกค้าอยู่
 */
export function coversFromDetailRows(rows) {
  return (rows || []).reduce((sum, r) => {
    if (r.void || r.Void === 'V') return sum;
    return isCoverItem(r.itemCode) ? sum + (parseFloat(r.quantity) || 0) : sum;
  }, 0);
}

/**
 * จำนวนหัวจากบิล (cpaidbetweendate) — สำหรับสาขาที่ใช้ Cover All
 * ข้ามบิลยอดติดลบ (ปรับลด/คืนเงิน) ไม่ให้นับหัวซ้ำ — กติกาเดียวกับรายงานยอดรายวัน
 */
export function coversFromBillRows(rows) {
  return (rows || []).reduce((sum, r) => {
    if ((parseFloat(r.billTotal ?? r.BillTotal ?? r.amount ?? 0) || 0) < 0) return sum;
    return sum + (parseFloat(r.coverAll ?? r.CoverAll ?? 0) || 0);
  }, 0);
}
