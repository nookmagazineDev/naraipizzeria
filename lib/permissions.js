// ทะเบียนสิทธิ์เมนู — ชุดเดียวที่ทั้งหน้าเว็บและฝั่ง API ใช้ร่วมกัน
//
// "คีย์สิทธิ์" ที่นี่คือ activeTab ของ pages/index.js ตรง ๆ (dashboard, stockList, ...)
// เปิดเมนูใหม่ในหน้า index ทีไร ให้มาเติมที่นี่ด้วย ไม่งั้นเมนูนั้นจะโผล่กับทุกคน
// (ตัวกรองด้านล่างซ่อนเฉพาะคีย์ที่ "รู้จัก" — คีย์ที่ไม่ได้ลงทะเบียนถือว่าไม่ได้คุมสิทธิ์)
//
// ⚠️ ไฟล์นี้ถูก import จากทั้งเบราว์เซอร์ ฝั่งเซิร์ฟเวอร์ และ middleware (Edge)
//    ห้ามใส่ import ที่เป็นโมดูลของ Node (mssql, crypto, fs) เด็ดขาด
//    กติกาเดียวกับ lib/branches.js

/** สถานะผู้ใช้ — ใช้คำไทยชุดเดียวกับทะเบียนสาขาและวัตถุดิบ QC/RD */
export const STATUS_ACTIVE = 'ใช้งาน';
export const STATUS_INACTIVE = 'ปิดการใช้งาน';

/** บทบาท: admin เห็นทุกเมนูเสมอ + แก้สิทธิ์คนอื่นได้ / user เห็นเฉพาะที่ติ๊กให้ */
export const ROLE_ADMIN = 'admin';
export const ROLE_USER = 'user';
export const ROLES = [
  { value: ROLE_ADMIN, label: 'ผู้ดูแลระบบ (เห็นทุกเมนู + จัดการผู้ใช้)' },
  { value: ROLE_USER, label: 'ผู้ใช้ทั่วไป (เห็นเฉพาะเมนูที่ติ๊กให้)' },
];

/**
 * เมนูทั้งหมดจัดกลุ่มตามที่เห็นในแถบข้าง — หน้า "จัดการผู้ใช้" เอาชุดนี้ไปวาดช่องติ๊ก
 * label ต้องตรงกับข้อความในแถบข้าง ไม่งั้นคนตั้งสิทธิ์จะเดาไม่ถูกว่าติ๊กอันไหนได้อะไร
 */
export const MENU_GROUPS = [
  {
    key: 'acc', label: 'ACC', items: [
      { key: 'dashboard', label: 'แดชบอร์ด' },
      { key: 'sales', label: 'รายงานยอดการขาย' },
      { key: 'dailySale', label: 'ยอดรายวัน' },
      { key: 'details', label: 'รายละเอียดรายการ' },
      { key: 'itemSearch', label: 'ค้นหารายไอเทม' },
      { key: 'otherExpense', label: 'ค่าใช้จ่ายอื่นๆ' },
    ],
  },
  {
    key: 'stock', label: 'STOCK', items: [
      { key: 'stockList', label: 'นับสต๊อกและขอเบิก' },
      { key: 'stockTotal', label: 'ดูยอดรวมทุกสาขา' },
      { key: 'monthEnd', label: 'ดูข้อมูลปิดรอบเดือน' },
    ],
  },
  {
    key: 'hr', label: 'HR', items: [
      { key: 'employeeList', label: 'รายชื่อพนักงาน' },
      { key: 'attendance', label: 'ดูสแกนหน้า' },
      { key: 'salaryReport', label: 'รายงานเงินเดือน' },
      { key: 'branchList', label: 'จัดการสาขา' },
    ],
  },
  {
    key: 'qcrd', label: 'QC/RD', items: [
      { key: 'qcrdMenu', label: 'เมนู' },
      { key: 'qcrdItems', label: 'วัตถุดิบ' },
    ],
  },
  {
    key: 'purchase', label: 'จัดซื้อ', items: [
      { key: 'planList', label: 'แพลนสินค้า' },
      { key: 'branchRequisition', label: 'เบิกของสาขา' },
    ],
  },
  {
    key: 'franchise', label: 'เฟรนไชส์', items: [
      { key: 'fcDashboard', label: 'แดชบอร์ด' },
      { key: 'fcReport', label: 'รายงานยอดขาย' },
      { key: 'fcDaily', label: 'ยอดขายรายวัน' },
      { key: 'fcSales', label: 'รายการขาย' },
      { key: 'fcDetail', label: 'รายละเอียดการขาย' },
      { key: 'fcExpense', label: 'รายจ่าย' },
    ],
  },
  {
    key: 'ai', label: 'AI NARAI', items: [
      { key: 'aiNarai', label: 'แชทถามข้อมูล' },
    ],
  },
  {
    // เมนูจัดการผู้ใช้เองก็เป็นสิทธิ์หนึ่ง — แต่ให้เฉพาะ admin เท่านั้นที่ใช้ได้จริง
    // (ฝั่ง /api/users เช็ก role ซ้ำอีกชั้น ติ๊กช่องนี้ให้ user ธรรมดาก็ยังเข้าไม่ได้)
    key: 'system', label: 'ระบบ', items: [
      { key: 'userList', label: 'จัดการผู้ใช้และสิทธิ์' },
    ],
  },
];

/** คีย์เมนูทั้งหมดที่ลงทะเบียนไว้ (เรียงตามที่โผล่ในแถบข้าง) */
export const ALL_MENU_KEYS = MENU_GROUPS.flatMap((g) => g.items.map((i) => i.key));

const MENU_KEY_SET = new Set(ALL_MENU_KEYS);

/** ป้ายชื่อเมนูสำหรับคีย์หนึ่ง ๆ — ไว้โชว์ในตารางสรุปสิทธิ์ */
export const MENU_LABELS = Object.fromEntries(
  MENU_GROUPS.flatMap((g) => g.items.map((i) => [i.key, `${g.label} › ${i.label}`]))
);

/** เมนูเดียวที่ห้ามแจกให้ใครนอกจาก admin */
export const ADMIN_ONLY_KEYS = ['userList'];

/** ชื่อผู้ใช้มาตรฐาน = ตัวพิมพ์เล็ก ไม่มีช่องว่างหัวท้าย (เทียบชื่อซ้ำแบบไม่สนตัวพิมพ์) */
export const normalizeUsername = (v) => String(v ?? '').trim().toLowerCase();

/**
 * ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 3–50 ตัว
 * คืน '' ถ้าผ่าน หรือข้อความบอกสาเหตุถ้าไม่ผ่าน
 */
export function validateUsername(username) {
  const u = normalizeUsername(username);
  if (!u) return 'ต้องกรอกชื่อผู้ใช้';
  if (!/^[a-z0-9._-]{3,50}$/.test(u)) {
    return 'ชื่อผู้ใช้ต้องเป็นตัวอักษรอังกฤษเล็ก ตัวเลข . _ - ยาว 3–50 ตัว (เช่น magazine, acc.somchai)';
  }
  return '';
}

/** รหัสผ่านอย่างน้อย 6 ตัว — สั้นกว่านี้เดาได้ในไม่กี่นาที */
export const MIN_PASSWORD_LENGTH = 6;

export function validatePassword(password) {
  const p = String(password ?? '');
  if (!p) return 'ต้องกรอกรหัสผ่าน';
  if (p.length < MIN_PASSWORD_LENGTH) return `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`;
  return '';
}

/**
 * ล้างรายการสิทธิ์ให้เหลือเฉพาะคีย์ที่รู้จัก ไม่ซ้ำ และเรียงตามลำดับเมนู
 * รับได้ทั้ง array และ JSON string (คอลัมน์ในฐานเก็บเป็นข้อความ)
 */
export function normalizePerms(perms) {
  let list = perms;
  if (typeof list === 'string') {
    // ปกติคอลัมน์ perms เก็บ JSON array — เผื่อเจอของเก่าที่คั่นด้วยจุลภาคก็ยังอ่านออก
    try { list = JSON.parse(list); } catch { list = list.split(','); }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set(list.map((p) => String(p ?? '').trim()).filter((p) => MENU_KEY_SET.has(p)));
  return ALL_MENU_KEYS.filter((k) => seen.has(k));
}

/**
 * ผู้ใช้คนนี้เปิดเมนูคีย์นี้ได้ไหม
 * - ไม่มี session = ไม่ได้สักเมนู
 * - admin = ได้ทุกเมนู (ไม่ต้องไล่ติ๊ก และกันไม่ให้ตัวเองล็อกตัวเองออกจากหน้าจัดการผู้ใช้)
 * - คีย์ที่ยังไม่ได้ลงทะเบียนใน MENU_GROUPS ถือว่าไม่ได้คุมสิทธิ์ — ปล่อยผ่าน
 */
export function hasPerm(user, key) {
  if (!user) return false;
  if (user.role === ROLE_ADMIN) return true;
  if (!MENU_KEY_SET.has(key)) return true;
  if (ADMIN_ONLY_KEYS.includes(key)) return false;
  return (user.perms || []).includes(key);
}

/** เมนูแรกที่ผู้ใช้คนนี้เปิดได้ — ใช้เป็นหน้าเริ่มต้นหลังล็อกอิน */
export function firstAllowedMenu(user) {
  return ALL_MENU_KEYS.find((k) => hasPerm(user, k)) || null;
}

/** ผู้ใช้คนนี้เปิดเมนูในกลุ่มนี้ได้อย่างน้อยหนึ่งอันไหม — ไม่ได้เลยก็ไม่ต้องวาดหัวข้อกลุ่ม */
export function canSeeGroup(user, groupKey) {
  const g = MENU_GROUPS.find((x) => x.key === groupKey);
  return Boolean(g && g.items.some((i) => hasPerm(user, i.key)));
}
