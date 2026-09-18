// ทะเบียนสาขา — รายชื่อสาขากลางที่ทุกหน้าใช้ร่วมกัน
//
// ก่อนหน้านี้รายชื่อสาขาถูก hardcode ไว้ 3 ที่ (Attendance, QcRdItems, OtherExpense)
// และตารางแมป outlet id อีก 8 ที่ในฝั่ง API — เปิดสาขาใหม่ทีต้องไล่แก้ 11 ไฟล์
// ไฟล์นี้เป็น "ตัวสำรอง" ชุดเดียวที่ทุกหน้าถอยมาใช้เมื่อยังอ่านทะเบียนจากฐานไม่ได้
//
// ⚠️ ไฟล์นี้ถูก import จากทั้งฝั่งเบราว์เซอร์และฝั่งเซิร์ฟเวอร์ — ห้ามใส่ import ที่เป็น
//    โมดูลของ Node (mssql, fs ฯลฯ) เด็ดขาด ไม่งั้น bundle ฝั่งหน้าเว็บจะพัง
//    ตัวต่อฐานอยู่ใน pages/api/branches.js ซึ่งฝั่งเซิร์ฟเวอร์เท่านั้นที่แตะ

export const STATUS_ACTIVE = 'ใช้งาน';
export const STATUS_INACTIVE = 'ปิดการใช้งาน';

/**
 * สาขาตั้งต้น — ชุดเดียวกับที่เคย hardcode ไว้ใน 3 คอมโพเนนต์
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
  { code: 'HPS', outletId: 902, status: STATUS_INACTIVE },   // ปิดกิจการแล้ว (ก.ย. 2026)
  { code: 'ZBW', outletId: 400 },
  { code: 'ZPT', outletId: 401 },
  { code: 'NPT', outletId: 500 },
  { code: 'WRM', outletId: 501 },
  { code: 'WMT', outletId: 503 },
  { code: 'IPR', outletId: 904 },
  // สองตัวนี้เคยมีแต่ในโค้ดฝั่งสโตร์ (narai-storefct/lib/branches.js) ไม่เคยอยู่ในทะเบียนนี้
  // ปิดไปแล้วทั้งคู่ แต่ต้องมีชื่ออยู่ ไม่งั้นรายงานย้อนหลังแปลรหัสไม่ออก
  { code: 'STS', outletId: 55,  status: STATUS_INACTIVE },
  { code: 'ZK3', outletId: 906, status: STATUS_INACTIVE },
];

/**
 * แค่รหัสสาขาที่ยังเปิดอยู่ เรียงตามลำดับเดิม — รูปแบบเดียวกับค่าคงที่ BRANCHES ที่เคยใช้
 *
 * ตัดสาขาที่ปิดแล้วออก เพราะตัวนี้มีที่ใช้ที่เดียวคือเติม dropdown ตอนยิง API ไม่ถึงเลย
 * (lib/useBranches.js) — ไม่ใช่ตัวแปลรหัส ตัวแปลรหัสต้องรู้จักสาขาที่ปิดแล้วด้วย
 * จึงอ่านจาก FALLBACK_BRANCHES ตรง ๆ (lib/branchRegistry.js, lib/planLive.js, api/ai-chat.js)
 */
export const FALLBACK_BRANCH_CODES = FALLBACK_BRANCHES
  .filter((b) => b.status !== STATUS_INACTIVE)
  .map((b) => b.code);

/**
 * รหัสพ้องสำรอง — ชุดเดียวกับที่เคยฝังไว้ใน lib/branchRegistry.js และ pages/api/usage.js
 * ตัวจริงอยู่ในตาราง dbo.hr_branch_alias ชุดนี้ใช้เฉพาะตอนอ่านทะเบียนจากฐานไม่ได้
 */
export const FALLBACK_ALIASES = { ZJP: 'SJP', ZIP: 'CRM' };

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

/* ======================= ช่องที่เพิ่มมาตอนยกเป็นทะเบียนแม่ =======================
   (วันเปิด-ปิดสาขา · โซน · รหัสพ้อง · เป้ายอด/เพดานค่าแรง)
   เหตุผลและแผนอยู่ใน docs/branch-hub.md — สคีมาอยู่ใน docs/schema-hr-branch.sql */

/** วันที่แบบ YYYY-MM-DD — ค่าอื่น (ว่าง, ไม่ใช่วันที่, วันที่ไม่มีจริง) คืน null */
export function normalizeDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  // รับเฉพาะรูปแบบเดียว ไม่ปล่อยให้ Date() เดาเอง — 'x/y/z' แต่ละเครื่องตีความคนละแบบ
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  // 2026-02-31 ผ่าน regex แต่ Date จะเลื่อนไปเป็น 3 มี.ค. — เทียบกลับเพื่อจับกรณีนี้
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  return s;
}

/** จำนวนเงิน — ไม่ติดลบ ทศนิยม 2 ตำแหน่ง (ค่าว่าง/ไม่ใช่ตัวเลข = 0) */
export function normalizeMoney(v) {
  const n = Number(String(v ?? '').trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

/** โซน/กลุ่มสาขา — ตัดช่องว่างหัวท้าย ยาวไม่เกิน 50 ตามที่ฐานรับ */
export const normalizeRegion = (v) => String(v ?? '').trim().slice(0, 50);

/**
 * รหัสพ้องต้องเป็น A-Z และ 0-9 ยาว 2–20 ตัว เหมือนรหัสสาขาแต่ยาวกว่าได้
 * (บางระบบเก็บรหัสยาวกว่าที่ทะเบียนนี้ใช้ เช่นชื่อโซนของเครื่องสแกนหน้า)
 * คืน '' ถ้าผ่าน หรือข้อความบอกสาเหตุถ้าไม่ผ่าน
 */
export function validateAlias(alias) {
  const a = normalizeCode(alias);
  if (!a) return 'ต้องกรอกรหัสพ้อง';
  if (!/^[A-Z0-9]{2,20}$/.test(a)) return 'รหัสพ้องต้องเป็นตัวอักษรอังกฤษหรือตัวเลข 2–20 ตัว';
  return '';
}

/**
 * รหัสพ้องซ้ำกับรหัสสาขาจริงไม่ได้ — ฐานบังคับให้ไม่ได้เพราะอยู่คนละตาราง
 * ปล่อยผ่านแล้วรหัสจริงจะถูกแปลไปเป็นสาขาอื่น ซึ่งเงียบมาก: ข้อมูลของสาขานั้น
 * จะไปโผล่ใต้ชื่อสาขาอื่นทั้งหมดโดยไม่มี error สักตัว
 *
 * @param {string} alias      รหัสพ้องที่จะเพิ่ม
 * @param {string[]} codes    รหัสสาขาทั้งหมดในทะเบียน
 * @param {string} target     สาขาปลายทางที่รหัสพ้องนี้ชี้ไป
 */
export function validateAliasTarget(alias, codes, target) {
  const a = normalizeCode(alias);
  const t = normalizeCode(target);
  const known = new Set((codes || []).map(normalizeCode));
  if (known.has(a)) return `${a} เป็นรหัสสาขาจริงอยู่แล้ว — ใช้เป็นรหัสพ้องไม่ได้`;
  if (!t) return 'ต้องเลือกสาขาปลายทางที่รหัสพ้องนี้ชี้ไป';
  if (!known.has(t)) return `ไม่พบสาขา ${t} ในทะเบียน`;
  if (a === t) return 'รหัสพ้องกับสาขาปลายทางเป็นตัวเดียวกันไม่ได้';
  return '';
}

/**
 * แปลงรายการรหัสพ้องเป็นตาราง { ZJP: 'SJP', ... }
 * รับได้ทั้งรูป [{ alias, branchCode }] และรูปที่เป็น object อยู่แล้ว
 */
export function aliasMapOf(list) {
  if (!list) return {};
  if (!Array.isArray(list)) {
    return Object.fromEntries(
      Object.entries(list).map(([a, c]) => [normalizeCode(a), normalizeCode(c)]));
  }
  const m = {};
  for (const a of list) {
    const alias = normalizeCode(a?.alias);
    const code = normalizeCode(a?.branchCode ?? a?.code);
    if (alias && code) m[alias] = code;
  }
  return m;
}

/**
 * รหัสที่ส่งมา -> รหัสสาขาจริงในทะเบียน
 * ไม่ใช่รหัสพ้อง = คืนตัวมันเอง (ตัวพิมพ์ใหญ่) ไม่ใช่ null — ตัวเรียกจะได้ไม่ต้องเช็กสองชั้น
 */
export function resolveBranchCode(code, aliases) {
  const c = normalizeCode(code);
  if (!c) return '';
  return aliasMapOf(aliases)[c] || c;
}
