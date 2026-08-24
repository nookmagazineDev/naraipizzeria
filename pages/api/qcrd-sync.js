// ดัน "ชีท QC/RD -> SQL Server" — ชีทเป็นต้นทาง SQL เป็นสำเนาที่หน้าอื่นเอาไปใช้ต่อ
//
// ทำไมต้องมี: หน้า QC/RD กลับไปแก้ที่ชีทแล้ว (ดู lib/qcrdSource.js) แต่หน้า "นับสต๊อก"
// ของ Narai-branch อ่าน dbo.stock_item / dbo.stock_item_branch จาก SQL ผ่านเครื่องออฟฟิศ
// ถ้าไม่ดันขึ้นไป วัตถุดิบที่เพิ่ม/แก้/ปิดใช้งานจากหน้า QC/RD จะไม่ไปโผล่ที่หน้านับสต๊อกเลย
// (เมนู/สูตร BOM/หมวดหมู่ ดันขึ้นด้วยได้ เพื่อให้ตาราง qcrd_* ตรงกับชีทเสมอ)
//
//   POST /api/qcrd-sync            { steps: ['item'] }        ← เรียกจากหน้าเว็บ
//   GET  /api/qcrd-sync?steps=item,menu,bom,group&verify=1     ← เปิดจากเบราว์เซอร์ก็ได้
//
// ไปถึง SQL ได้ 2 ทาง เลือกให้เองตามที่ตั้งค่าไว้:
//   1) ต่อ SQL ตรงจาก Vercel — ใช้ตัวย้ายชุดเดียวกับ /api/qcrd-migrate (ต้องตั้งรหัสฐานบน Vercel)
//   2) host API GET /qcrd/migrate ที่เครื่องออฟฟิศ — เครื่องนั้นอ่านชีทเองแล้วเขียนลงฐานให้
//      (ไม่มีลิมิต 60 วิเหมือน Vercel จึงจบในรอบเดียว) ต้องตั้ง QCRD_WRITE_KEY ให้ตรงกัน
//
// ⚠️ การลบไม่ตามขึ้นไป — ตัวดันใช้ MERGE (เพิ่ม/อัปเดต) ไม่ลบแถวที่หายไปจากชีท
//    จะเอาวัตถุดิบออกจากหน้านับสต๊อก ให้ตั้งสถานะเป็น "ปิดการใช้งาน" ในชีทแทนการลบแถว
//    (หน้านับสต๊อกกรองสถานะนี้ออกอยู่แล้ว) ใส่ &verify=1 เพื่อดูว่าชีทกับ SQL มีกี่แถวห่างกันแค่ไหน
import { QCRD_API_BASE, hasDirectDb, sqlRoute } from '../../lib/qcrdSource';
import { runStep } from './qcrd-migrate';

export const config = { maxDuration: 60 };

export const ALL_STEPS = ['group', 'menu', 'bom', 'item'];

// action ฝั่งเขียนของ QC/RD ตัวไหน กระทบข้อมูลชุดไหน — ใช้ตอนดันอัตโนมัติหลังบันทึก
// (ดันเฉพาะชุดที่เกี่ยว จะได้ไม่ต้องรออัปทั้งชีททุกครั้งที่แก้ของนิดเดียว)
export const STEPS_FOR_ACTION = {
  saveMenu: ['menu', 'bom'],
  saveMenuStatus: ['menu'],
  saveMenuGroup: ['group', 'menu'],
  saveItem: ['item'],
  addItem: ['item'],
  deleteItem: ['item'],
  updateItemUnits: ['item'],
  sortBom: ['bom'],
};

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** เรียงตาม ALL_STEPS เสมอ (หมวดหมู่ต้องมาก่อนเมนู เมนูต้องมาก่อนสูตร) และตัดตัวที่ไม่รู้จักทิ้ง */
export function normalizeSteps(steps) {
  const want = new Set(
    (Array.isArray(steps) ? steps : String(steps || '').split(','))
      .map((s) => str(s).toLowerCase())
      .filter(Boolean)
  );
  if (want.has('all')) return [...ALL_STEPS];
  return ALL_STEPS.filter((s) => want.has(s));
}

/** ทางที่ 2 — ให้เครื่องออฟฟิศทำให้ (อ่านชีทเองแล้วเขียนลงฐาน จบในรอบเดียว) */
async function viaHost(step, { verify = false, timeoutMs = 50000 } = {}) {
  const key = process.env.QCRD_WRITE_KEY || '';
  if (!key) {
    throw new Error(
      'ยังดันขึ้น SQL ไม่ได้ — ตั้ง QCRD_WRITE_KEY บน Vercel ให้ตรงกับเครื่องออฟฟิศ ' +
      'หรือตั้งรหัสฐาน (QCRD_DB_USER/QCRD_DB_PASSWORD) เพื่อให้ Vercel ต่อ SQL ตรง'
    );
  }
  const qs = new URLSearchParams({ key, step });
  if (!verify) qs.set('confirm', '1');   // step=verify แค่นับเทียบ ไม่ต้อง confirm
  const res = await fetch(`${QCRD_API_BASE}/qcrd/migrate?${qs.toString()}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error(
      `host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server ที่เครื่องออฟฟิศรันอยู่ไหม ` +
      'และเป็นเวอร์ชันที่มี /qcrd/* แล้วหรือยัง (git pull แล้ว start-narai.ps1 -Restart)'
    );
  }
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json;
}

/** ทางที่ 1 — Vercel ต่อ SQL ตรง ใช้ตัวย้ายชุดเดียวกับ /api/qcrd-migrate (ต้องไล่ offset เอง) */
async function viaDirect(step, { verify = false, deadline }) {
  if (verify) return runStep('verify', { confirm: false, offset: 0, deadline });
  let offset = 0;
  let last = null;
  for (let round = 0; round < 20; round++) {
    last = await runStep(step, { confirm: true, offset, deadline });
    if (last.done !== false) return last;
    if (!(last.nextOffset > offset)) break;   // ไม่ขยับ = ไปต่อไม่ได้ อย่าวนฟรี
    offset = last.nextOffset;
    if (Date.now() > deadline) break;
  }
  return { ...(last || {}), done: false, note: 'ยังไม่ครบในรอบนี้ — เรียกซ้ำอีกครั้งเพื่อทำต่อ' };
}

/**
 * ดันข้อมูลตาม step ที่ขอ คืนผลรายชุด ไม่โยน error ออกไป (ผู้เรียกดู ok ของแต่ละชุดเอง)
 * budgetMs = เวลาที่ยอมให้ใช้ทั้งหมด เผื่อไว้ตอบกลับก่อน Vercel ตัดที่ 60 วิ
 */
export async function syncToSql(steps, { verify = false, budgetMs = 45000 } = {}) {
  const list = normalizeSteps(steps);
  const route = hasDirectDb() ? 'direct' : 'host';
  const deadline = Date.now() + budgetMs;
  const results = [];

  for (const step of list) {
    const t0 = Date.now();
    try {
      const data = hasDirectDb()
        ? await viaDirect(step, { deadline })
        : await viaHost(step, { timeoutMs: Math.max(5000, deadline - Date.now()) });
      results.push({ step, ok: true, tookMs: Date.now() - t0, ...data });
    } catch (err) {
      results.push({ step, ok: false, tookMs: Date.now() - t0, message: err.message });
      break;   // ชุดถัดไปก็ไปไม่ถึงอยู่ดี (ทางเดียวกัน) ไม่ต้องรอ timeout ซ้ำ
    }
  }

  if (verify && results.every((r) => r.ok)) {
    try {
      const data = hasDirectDb()
        ? await viaDirect('verify', { verify: true, deadline })
        : await viaHost('verify', { verify: true, timeoutMs: Math.max(5000, deadline - Date.now()) });
      results.push({ step: 'verify', ok: true, ...data });
    } catch (err) {
      results.push({ step: 'verify', ok: false, message: err.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0 && results.length > 0,
    route, via: sqlRoute(), steps: list, results,
    message: results.length === 0
      ? 'ไม่ได้ระบุชุดข้อมูลที่จะดันขึ้น SQL'
      : failed.length
        ? failed[0].message
        : `ดันขึ้น SQL แล้ว: ${list.join(', ')}`,
  };
}

export default async function handler(req, res) {
  const q = { ...req.query, ...(typeof req.body === 'object' ? req.body : {}) };
  const steps = q.steps || q.step || 'item';
  const verify = String(q.verify || '') === '1' || q.verify === true;

  const out = await syncToSql(steps, { verify });
  // คืน 200 พร้อม status:'error' เหมือน action อื่นของ QC/RD — หน้าเว็บอ่านข้อความไปแสดงตรง ๆ
  return res.status(200).json({ status: out.ok ? 'success' : 'error', ...out });
}
