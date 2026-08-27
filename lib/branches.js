// ทะเบียนสาขา — รายชื่อสาขากลางที่ทุกหน้าใช้ร่วมกัน
//
// ก่อนหน้านี้รายชื่อสาขาถูก hardcode ไว้ 3 ที่ (Attendance, QcRdItems, OtherExpense)
// และตารางแมป outlet id อีก 8 ที่ในฝั่ง API — เปิดสาขาใหม่ทีต้องไล่แก้ 11 ไฟล์
// ไฟล์นี้เป็น "ตัวสำรอง" ชุดเดียวที่ทุกหน้าถอยมาใช้เมื่อยังอ่านทะเบียนจากฐานไม่ได้
//
// ⚠️ ไฟล์นี้ถูก import จากทั้งฝั่งเบราว์เซอร์และฝั่งเซิร์ฟเวอร์ — ห้ามใส่ import ที่เป็น
//    โมดูลของ Node (mssql, fs ฯลฯ) เด็ดขาด ไม่งั้น bundle ฝั่งหน้าเว็บจะพัง
//    ตัวต่อฐานอยู่ใน pages/api/branches.js ซึ่งฝั่งเซิร์ฟเวอร์เท่านั้นที่แตะ

/**
 * สาขาตั้งต้น 21 ตัว — ชุดเดียวกับที่เคย hardcode ไว้ใน 3 คอมโพเนนต์
 * outletId มาจากตาราง OUTLETS ใน pages/index.js (รหัสร้านฝั่ง POS)
 *
 * ใช้เป็น seed ตอนสร้างตารางครั้งแรก และเป็นตัวสำรองตอนต่อฐานไม่ได้
 * จะเพิ่ม/แก้สาขาให้ใช้หน้า "จัดการสาขา" (HR) ไม่ต้องมาแก้ไฟล์นี้อีก
 */
export const FALLBACK_BRANCHES = [
  { code: 'SJP', outletId: 7 },
  { code: 'CRM', outletId: 12 },
  { code: 'XCM', outletId: 19 },
  { code: 'SLR', outletId: 37 },
  { code: 'SUM', outletId: 51 },
  { code: 'XUM', outletId: 59 },
  { code: 'SCS', outletId: 61 },
  { code: 'SMP', outletId: 63 },
  { code: 'XSB', outletId: 67 },
  { code: 'XHH', outletId: 72 },
  { code: 'HRS', outletId: 78 },
  { code: 'CLK', outletId: 79 },
  { code: 'P90', outletId: 80 },
  { code: 'HPS', outletId: 109 },
  { code: 'ZBW', outletId: 400 },
  { code: 'ZPT', outletId: 401 },
  { code: 'NPT', outletId: 500 },
  { code: 'WRM', outletId: 501 },
  { code: 'WMT', outletId: 503 },
  { code: 'IPR', outletId: 904 },
  { code: 'ZK3', outletId: 906 },
];

/** แค่รหัสสาขาเรียงตามลำดับเดิม — รูปแบบเดียวกับค่าคงที่ BRANCHES ที่เคยใช้ */
export const FALLBACK_BRANCH_CODES = FALLBACK_BRANCHES.map((b) => b.code);

export const STATUS_ACTIVE = 'ใช้งาน';
export const STATUS_INACTIVE = 'ปิดการใช้งาน';

/** รหัสสาขามาตรฐาน = ตัวพิมพ์ใหญ่ ไม่มีช่องว่างหัวท้าย (ฐาน HR เก็บตัวพิมพ์เล็ก จึงเทียบแบบไม่สนตัวพิมพ์เสมอ) */
export const normalizeCode = (v) => String(v ?? '').trim().toUpperCase();

/** เลข outlet ที่ใช้ได้จริงต้องเป็นจำนวนเต็มบวก — ค่าอื่น (ว่าง, 0, ติดลบ, ไม่ใช่ตัวเลข) คืน null */
export function normalizeOutletId(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * รหัสสาขาต้องเป็น A-Z และ 0-9 ยาว 2–10 ตัว
 * (เครื่องสแกนหน้าเก็บรหัสนี้ไว้ที่ area_alias และฝั่ง POS ใช้เป็นคีย์ ห้ามมีอักขระแปลก)
 * คืน '' ถ้าผ่าน หรือข้อความบอกสาเหตุถ้าไม่ผ่าน
 */
export function validateCode(code) {
  const c = normalizeCode(code);
  if (!c) return 'ต้องกรอกรหัสสาขา';
  if (!/^[A-Z0-9]{2,10}$/.test(c)) return 'รหัสสาขาต้องเป็นตัวอักษรอังกฤษหรือตัวเลข 2–10 ตัว (เช่น SJP, P90)';
  return '';
}

/** ชื่อที่เอาไว้โชว์ — ยังไม่ได้กรอกชื่อไทยก็ใช้รหัสไปก่อน จะได้ไม่มีช่องว่างเปล่าในตาราง */
export const branchLabel = (b) => (b?.name?.trim() ? `${b.code} — ${b.name.trim()}` : String(b?.code || ''));

/**
 * เรียงสาขาตามลำดับที่ตั้งไว้ แล้วค่อยตามรหัส
 * (sortOrder เท่ากันได้ เช่นสาขาที่เพิ่มใหม่ยังไม่ได้จัดลำดับ — ให้ตกไปเรียงตามรหัสแทน)
 */
export const sortBranches = (list) =>
  [...(list || [])].sort((a, b) => (a.sortOrder - b.sortOrder) || a.code.localeCompare(b.code));

/** แปลงรายการทะเบียนเป็นตารางแมป { SJP: 7, ... } — เฉพาะสาขาที่มี outletId */
export function outletMapOf(list) {
  const m = {};
  for (const b of list || []) if (b.outletId) m[normalizeCode(b.code)] = b.outletId;
  return m;
}
