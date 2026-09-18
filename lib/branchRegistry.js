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
import { readBranchRegistry, readBranchAliases } from './sheetsSource';
import { FALLBACK_BRANCHES, FALLBACK_ALIASES } from './branches';

/**
 * รหัสเก่าที่ไม่ได้อยู่ในทะเบียน แต่ข้อมูลบางชุดยังเขียนมาแบบนี้ — ต้องแมปให้ได้ต่อไป
 * (zjp/zip เคยฝังไว้ใน usage.js กับ usagebytable.js มาก่อน ถ้าตัดทิ้งของเก่าจะหาสาขาไม่เจอ)
 *
 * ตัวจริงย้ายไปอยู่ตาราง dbo.hr_branch_alias แล้ว (เพิ่มคู่ใหม่ได้จากหน้า HR > จัดการสาขา)
 * ชุดนี้เหลือไว้เป็นตัวสำรองตอนอ่านตารางนั้นไม่ได้ — ถ้าทิ้งไปเลย ช่วงที่ฐานล่ม
 * ข้อมูลที่เขียนมาด้วยรหัสเก่าจะแปลไม่ออกเงียบ ๆ ซึ่งแย่กว่าแปลด้วยของเก่าที่ยังถูกอยู่
 */
const FALLBACK_ALIAS_PAIRS = Object.entries(FALLBACK_ALIASES)
  .map(([alias, code]) => [alias.toLowerCase(), code.toLowerCase()]);

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
// aliasKeys = รหัสไหนในตารางแมปเป็น "รหัสพ้อง" ไม่ใช่รหัสสาขาจริง (outletBranchMap ใช้คัดออก)
// เก็บไว้ในก้อนแคชเดียวกับ map โดยตั้งใจ — สองอย่างนี้ต้องมาจากการอ่านรอบเดียวกันเสมอ
// แยกเก็บคนละที่เมื่อไหร่จะมีจังหวะที่ map มาจากฐานแต่ aliasKeys ยังเป็นของสำรอง
// แล้วตารางกลับด้านจะคัดผิดตัวแบบเงียบ ๆ
g.__branchOutlet = g.__branchOutlet
  || { at: 0, ttl: 0, map: null, aliasKeys: null, aliasTo: null, fromFallback: false };

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

/**
 * รวมรหัสพ้องเข้าไปในตารางแมป — รหัสพ้องชี้ไป outlet เดียวกับสาขาที่มันหมายถึง
 * สาขาปลายทางไม่มี outlet (ยังไม่ได้เลข POS มา) ก็ข้ามไป ไม่ใส่ค่า undefined ลงตาราง
 */
function withAliases(map, pairs) {
  for (const [alias, code] of pairs) {
    const oid = map[code];
    if (oid && !(alias in map)) map[alias] = oid;
  }
  return map;
}

/** รายชื่อสำรองในโค้ด -> ตารางแมป (ใช้เมื่ออ่านทะเบียนจากฐานไม่ได้) */
const fallbackMap = () => {
  const m = {};
  for (const b of FALLBACK_BRANCHES) if (b.outletId) m[lower(b.code)] = b.outletId;
  return withAliases(m, FALLBACK_ALIAS_PAIRS);
};

/**
 * ตารางแมป { 'xum': 59, ... } — คีย์เป็นรหัสสาขาตัวพิมพ์เล็ก
 *
 * รวมสาขาที่ปิดการใช้งานด้วย เพราะข้อมูลย้อนหลังยังอ้างถึงสาขาพวกนั้นอยู่
 * (ตัวกรอง "เฉพาะสาขาที่เปิดอยู่" เป็นเรื่องของ dropdown ไม่ใช่ของตัวแปลรหัส)
 */
export async function branchOutletMap() {
  return (await branchOutletCache()).map;
}

/** ก้อนแคชเต็ม ๆ { map, aliasKeys, fromFallback } — ตัวที่ต้องใช้ aliasKeys ด้วยเรียกตัวนี้ */
async function branchOutletCache() {
  const c = g.__branchOutlet;
  if (c.map && Date.now() - c.at < c.ttl) return c;

  try {
    // อ่านทะเบียนกับรหัสพ้องพร้อมกันใต้เพดานเวลาเดียว — เป็นทางเดินของหน้ายอดขาย
    // ยิงเรียงกันทีละตัวจะกลายเป็นรอสองรอบ และรหัสพ้องอ่านไม่ได้ก็ไม่ใช่เหตุให้ทั้งตารางแมปพัง
    // (ฐานที่ยังไม่ได้รัน DDL รอบใหม่จะยังไม่มีตารางนั้น — ถอยไปใช้คู่ที่ฝังในโค้ดแทน)
    const [list, aliasList] = await withDeadline(
      Promise.all([
        readBranchRegistry(),
        readBranchAliases().catch((err) => {
          console.error('branchRegistry: อ่านรหัสพ้องไม่ได้ — ใช้คู่สำรองในโค้ดแทน:', err.message);
          return null;
        }),
      ]),
      READ_DEADLINE_MS,
    );

    const m = {};
    for (const b of list || []) if (b.outletId) m[lower(b.code)] = b.outletId;
    // อ่านไม่ได้ (null) = ใช้คู่สำรอง · อ่านได้แต่ว่าง ([]) = ตั้งใจไม่มีรหัสพ้องแล้ว ต้องเคารพ
    // ไม่งั้นลบรหัสพ้องตัวสุดท้ายออกจากหน้าเว็บแล้วของสำรองจะโผล่กลับมาแทนที่เงียบ ๆ
    const pairs = aliasList
      ? aliasList.map((a) => [lower(a.alias), lower(a.branchCode)])
      : FALLBACK_ALIAS_PAIRS;
    withAliases(m, pairs);
    const aliasKeys = new Set(pairs.map(([alias]) => alias));
    const aliasTo = Object.fromEntries(pairs);

    // ทะเบียนว่างเปล่า = ตารางเพิ่งสร้างยังไม่มีข้อมูล อย่าเอามาทับของสำรองจนหาสาขาไม่เจอทั้งระบบ
    // (นับจากตารางแมปที่ได้จริง ไม่ใช่จำนวนแถว — ทุกแถวไม่มีเลข outlet ก็แปลรหัสไม่ได้อยู่ดี)
    if (Object.keys(m).length) {
      g.__branchOutlet = { at: Date.now(), ttl: TTL_MS, map: m, aliasKeys, aliasTo, fromFallback: false };
      return g.__branchOutlet;
    }
    console.error('branchRegistry: ทะเบียนสาขาว่างเปล่า — ใช้รายชื่อสำรองในโค้ดแทน');
  } catch (err) {
    console.error('branchRegistry: อ่านทะเบียนสาขาไม่ได้ — ใช้รายชื่อสำรองในโค้ดแทน:', err.message);
  }

  g.__branchOutlet = {
    at: Date.now(), ttl: FALLBACK_TTL_MS, map: fallbackMap(), fromFallback: true,
    aliasKeys: new Set(FALLBACK_ALIAS_PAIRS.map(([alias]) => alias)),
    aliasTo: Object.fromEntries(FALLBACK_ALIAS_PAIRS),
  };
  return g.__branchOutlet;
}

/**
 * ตารางรหัสพ้อง { 'zjp': 'sjp', ... } — คีย์และค่าเป็นตัวพิมพ์เล็กทั้งคู่
 * ใช้ตอนต้องรู้ "รหัสจริงของร้านนี้คืออะไร" ไม่ใช่แค่ outletID (เช่นเวลาไปหาชื่อสาขาในชีท)
 */
export async function branchAliasMap() {
  return (await branchOutletCache()).aliasTo || {};
}

/** รหัสที่ส่งมา -> รหัสสาขาจริง (ไม่ใช่รหัสพ้อง = คืนตัวมันเอง) — ตัวพิมพ์เล็กเสมอ */
export async function resolveBranch(code) {
  const c = lower(code);
  if (!c) return '';
  return (await branchAliasMap())[c] || c;
}

/** รหัสสาขา -> outletID (ไม่รู้จัก = null) */
export async function outletIdOf(branchCode) {
  const m = await branchOutletMap();
  return m[lower(branchCode)] ?? null;
}

/** ตารางกลับด้าน { 59: 'XUM', ... } — ไว้แปลง outletID ที่ POS ส่งมาเป็นรหัสสาขา */
export async function outletBranchMap() {
  const { map, aliasKeys } = await branchOutletCache();
  const out = {};
  // รหัสพ้องชี้ outlet เดียวกับรหัสจริง ข้ามไป ไม่งั้นตารางกลับด้านจะได้ชื่อรหัสเก่า
  for (const [code, oid] of Object.entries(map)) {
    if (aliasKeys?.has(code)) continue;
    out[oid] = code.toUpperCase();
  }
  return out;
}
