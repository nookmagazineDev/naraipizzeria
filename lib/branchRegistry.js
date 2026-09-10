// ตารางแมป "รหัสสาขา ↔ รหัสร้าน POS (outletID)" ที่ฝั่ง API ใช้ร่วมกัน — อ่านจากทะเบียนสาขาจริง
//
// ⚠️ ไฟล์นี้ฝั่งเซิร์ฟเวอร์เท่านั้น (ลากตัวต่อฐานเข้ามาด้วย) ห้าม import จากคอมโพเนนต์
//    ฝั่งหน้าเว็บใช้ lib/useBranches.js ซึ่งยิง /api/branches แทน
//
// ทำไมต้องมี: เดิมแต่ละ API ฝัง { sjp: 7, crm: 12, ... } ไว้เอง รวมแล้ว 8 ไฟล์
// เปิดสาขาใหม่ทีต้องไล่แก้ทุกไฟล์แล้ว deploy ลืมไฟล์ไหนไฟล์นั้นเงียบ ๆ ไม่รู้จักสาขาใหม่
// ตอนนี้ทุกไฟล์อ่านจาก dbo.hr_branch ชุดเดียว = เพิ่มสาขาที่หน้า HR > จัดการสาขา แล้วจบ
//
// อ่านผ่าน lib/sheetsSource.js จึงได้ทางถอยชุดเดียวกับหน้าอื่น (ต่อ SQL ตรง → host API)
// ไปไม่ถึงฐานทั้งสองทาง = ใช้รายชื่อสำรองใน lib/branchCore.mjs ต่อ — API พวกนี้อยู่ในทางเดิน
// ของหน้ายอดขาย/ยอดใช้วัตถุดิบ ห้ามพังเพราะทะเบียนสาขาอ่านไม่ได้
import { readBranchRegistry } from './sheetsSource';
import { FALLBACK_BRANCHES } from './branches';

/**
 * รหัสเก่าที่ไม่ได้อยู่ในทะเบียน แต่ข้อมูลบางชุดยังเขียนมาแบบนี้ — ต้องแมปให้ได้ต่อไป
 * (zjp/zip เคยฝังไว้ใน usage.js กับ usagebytable.js มาก่อน ถ้าตัดทิ้งของเก่าจะหาสาขาไม่เจอ)
 */
const ALIASES = { zjp: 7, zip: 12 };

// อ่านทะเบียนใหม่ทุกคำขอคือเสียเวลาฟรี ๆ — ทะเบียนสาขาแทบไม่เปลี่ยน แต่ API พวกนี้ถูกเรียกถี่
// เก็บบน globalThis เพราะ Vercel ใช้ instance ซ้ำระหว่าง request (แนวเดียวกับ lib/directRoute.js)
const TTL_MS = 5 * 60 * 1000;

// ⭐ เพดานเวลาของตัวเอง — สำคัญกว่าที่คิด
//
// ทางไปถึงฐานมีเวลารอของมันเอง: ต่อ SQL ตรง 8 วิ แล้วถอยไป host API อีก 20 วิ
// รวมแล้วเกือบ 30 วินาทีกว่าจะรู้ว่าไปไม่ถึง — ซึ่งยาวเกินไปสำหรับ API พวกนี้
// เพราะมันคือทางเดินของหน้ายอดขาย/ยอดใช้วัตถุดิบ ที่เมื่อก่อนใช้ตารางฝังในโค้ด
// ได้คำตอบทันที เครื่องออฟฟิศดับทีเดียวหน้าเว็บค้างยาวทุกหน้า
//
// ทะเบียนสาขาเป็นตารางเล็กมาก (ยี่สิบแถว) ตอบไม่ทัน 5 วิ = ไปไม่ถึงอยู่ดี
// เลิกรอแล้วใช้รายชื่อสำรองต่อทันที ดีกว่าให้ทั้งหน้าค้าง
const READ_DEADLINE_MS = 5000;
// อ่านไม่ได้แล้วใช้ของสำรอง — แคชสั้นกว่า จะได้กลับไปลองใหม่เร็ว ๆ ไม่ต้องรอครบ 5 นาที
const FALLBACK_TTL_MS = 30 * 1000;

const g = globalThis;
g.__branchOutlet = g.__branchOutlet || { at: 0, ttl: 0, map: null, fromFallback: false };

const lower = (v) => String(v ?? '').trim().toLowerCase();

/** รอไม่เกิน ms — ตัวที่ค้างอยู่ปล่อยให้วิ่งต่อไปเอง (ผูก handler ไว้แล้ว ไม่เป็น unhandled rejection) */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`อ่านทะเบียนสาขาไม่เสร็จใน ${Math.round(ms / 1000)} วินาที`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** รายชื่อสำรองในโค้ด -> ตารางแมป (ใช้เมื่ออ่านทะเบียนจากฐานไม่ได้) */
const fallbackMap = () => {
  const m = { ...ALIASES };
  for (const b of FALLBACK_BRANCHES) if (b.outletId) m[lower(b.code)] = b.outletId;
  return m;
};

/**
 * ตารางแมป { 'xum': 59, ... } — คีย์เป็นรหัสสาขาตัวพิมพ์เล็ก
 *
 * รวมสาขาที่ปิดการใช้งานด้วย เพราะข้อมูลย้อนหลังยังอ้างถึงสาขาพวกนั้นอยู่
 * (ตัวกรอง "เฉพาะสาขาที่เปิดอยู่" เป็นเรื่องของ dropdown ไม่ใช่ของตัวแปลรหัส)
 */
export async function branchOutletMap() {
  const c = g.__branchOutlet;
  if (c.map && Date.now() - c.at < c.ttl) return c.map;

  try {
    const list = await withDeadline(readBranchRegistry(), READ_DEADLINE_MS);
    const m = { ...ALIASES };
    for (const b of list || []) if (b.outletId) m[lower(b.code)] = b.outletId;
    // ทะเบียนว่างเปล่า = ตารางเพิ่งสร้างยังไม่มีข้อมูล อย่าเอามาทับของสำรองจนหาสาขาไม่เจอทั้งระบบ
    if (Object.keys(m).length > Object.keys(ALIASES).length) {
      g.__branchOutlet = { at: Date.now(), ttl: TTL_MS, map: m, fromFallback: false };
      return m;
    }
    console.error('branchRegistry: ทะเบียนสาขาว่างเปล่า — ใช้รายชื่อสำรองในโค้ดแทน');
  } catch (err) {
    console.error('branchRegistry: อ่านทะเบียนสาขาไม่ได้ — ใช้รายชื่อสำรองในโค้ดแทน:', err.message);
  }

  const m = fallbackMap();
  g.__branchOutlet = { at: Date.now(), ttl: FALLBACK_TTL_MS, map: m, fromFallback: true };
  return m;
}

/** รหัสสาขา -> outletID (ไม่รู้จัก = null) */
export async function outletIdOf(branchCode) {
  const m = await branchOutletMap();
  return m[lower(branchCode)] ?? null;
}

/** ตารางกลับด้าน { 59: 'XUM', ... } — ไว้แปลง outletID ที่ POS ส่งมาเป็นรหัสสาขา */
export async function outletBranchMap() {
  const m = await branchOutletMap();
  const out = {};
  // ALIASES ชี้ outlet เดียวกับรหัสจริง ข้ามไป ไม่งั้นตารางกลับด้านจะได้ชื่อรหัสเก่า
  for (const [code, oid] of Object.entries(m)) {
    if (code in ALIASES) continue;
    out[oid] = code.toUpperCase();
  }
  return out;
}
