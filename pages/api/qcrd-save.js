// QC/RD ฝั่ง "เขียน" — ทางเดียวที่หน้าเว็บใช้บันทึก (lib/qcrdApi.js ยิงมาที่นี่)
//
// ส่งต่อไป /api/qcrd-gas (Apps Script เขียนลงชีทต้นทุนเมนู) ที่เดียวกับที่ /api/qcrd อ่าน
// action: saveMenu · saveMenuStatus · saveMenuGroup · saveItem · addItem · deleteItem ·
// updateItemUnits · sortBom
//
// บันทึกลงชีทสำเร็จแล้ว "ดันขึ้น SQL" ต่อให้อัตโนมัติ (/api/qcrd-sync) เฉพาะชุดข้อมูลที่เกี่ยว
// เพราะหน้านับสต๊อกของ Narai-branch อ่าน dbo.stock_item / stock_item_branch จากฐาน ไม่ได้อ่านชีท
// ชีทยังเป็นต้นทางเสมอ SQL เป็นสำเนา — ดันไม่สำเร็จก็ไม่ทำให้การบันทึกลงชีทเสีย แค่แนบผลกลับไป
// ในฟิลด์ sync ให้หน้าเว็บบอกผู้ใช้ว่ายังไม่ขึ้นฐาน (กดปุ่ม "อัพขึ้น SQL" ซ้ำได้)
// ปิดการดันอัตโนมัติ: ตั้ง env QCRD_SYNC_ON_SAVE=off บน Vercel
//
// ทาง SQL ฝั่ง "เขียนตรง" ปิดไว้แล้ว (usingSql() คืน false เสมอ ดู lib/qcrdSource.js)
// โค้ดฝั่งนั้นเก็บไว้เผื่อเปิดใช้อีกรอบ ตอนนี้ไม่ถูกเรียก
import { usingSql, saveQcrdSql } from '../../lib/qcrdSource';
import gasHandler from './qcrd-gas';
import { syncToSql, STEPS_FOR_ACTION } from './qcrd-sync';

// saveMenu ที่มีเมนูผูกกันหลายชั้นใช้เวลานานกว่าค่าเริ่มต้น 10 วินาทีของ Vercel
export const config = { maxDuration: 60 };

// เผื่อเวลาไว้ตอบกลับก่อนโดน platform ตัดที่ 60 วิ — บันทึกลงชีทเสร็จแล้วเหลือเท่าไหร่ ค่อยเอาไปดัน
const TOTAL_BUDGET_MS = 50000;
const MIN_SYNC_MS = 6000;

const syncEnabled = () => String(process.env.QCRD_SYNC_ON_SAVE || '').toLowerCase() !== 'off';

/** ให้ gasHandler เขียนคำตอบใส่ตัวห่อนี้แทน res จริง จะได้เอา JSON มาต่อยอดก่อนส่งออก */
function captureJson(res) {
  const captured = { statusCode: 200, body: null };
  const proxy = {
    status(code) { captured.statusCode = code; return proxy; },
    json(body) { captured.body = body; return proxy; },
    setHeader: (...a) => res.setHeader(...a),
    end: () => proxy,
  };
  return { proxy, captured };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'POST only' });
  }

  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })()
    : (req.body || {});
  const action = String(body.action || '').trim();

  if (usingSql()) {
    try {
      return res.status(200).json(await saveQcrdSql(body));
    } catch (err) {
      // หน้าเว็บอ่านข้อความนี้ไปแสดงตรง ๆ จึงคืน 200 พร้อม status:'error' เหมือนที่ Apps Script ทำ
      return res.status(200).json({ status: 'error', message: err.message });
    }
  }

  const t0 = Date.now();
  const { proxy, captured } = captureJson(res);
  await gasHandler(req, proxy);
  const saved = captured.body || { status: 'error', message: 'ไม่มีคำตอบจากตัวบันทึกลงชีท' };

  // บันทึกลงชีทไม่ผ่าน = ไม่มีอะไรให้ดันขึ้น SQL
  const steps = STEPS_FOR_ACTION[action] || [];
  if (saved.status !== 'success' || !steps.length || !syncEnabled()) {
    return res.status(captured.statusCode).json(saved);
  }

  const budgetMs = TOTAL_BUDGET_MS - (Date.now() - t0);
  if (budgetMs < MIN_SYNC_MS) {
    return res.status(captured.statusCode).json({
      ...saved,
      sync: {
        ok: false, steps, skipped: true,
        message: 'บันทึกลงชีทแล้ว แต่เวลาไม่พอดันขึ้น SQL ในรอบนี้ — กด "อัพขึ้น SQL" อีกครั้ง',
      },
    });
  }

  // ดันไม่ขึ้นไม่ทำให้การบันทึกลงชีทเสีย — แนบผลไปให้หน้าเว็บบอกผู้ใช้เอง
  let sync;
  try {
    sync = await syncToSql(steps, { budgetMs });
  } catch (err) {
    sync = { ok: false, steps, message: err.message };
  }
  if (!sync.ok) console.error(`qcrd-save: ${action} ดันขึ้น SQL ไม่สำเร็จ:`, sync.message);
  return res.status(captured.statusCode).json({ ...saved, sync });
}
