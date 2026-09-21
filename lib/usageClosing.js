// ยอดใช้จริง "จากยอดปิดรอบของสาขา" — ตัวเทียบอีกขาของหน้ารายงานการใช้วัตถุดิบต่อหัว
//
// อีกขาหนึ่ง (ของเดิม) คือยอดใช้ตามสูตร = ยอดขายจริง × BOM ซึ่งเป็น "ควรใช้เท่าไหร่"
// ไฟล์นี้คิดอีกฝั่ง คือ "หายไปจากชั้นเท่าไหร่จริง ๆ" ตามที่สาขานับของเอง:
//
//     ใช้จริง = ยอดยกมา (ปิดรอบก่อน) + ยอดรับเข้า (ในช่วงรอบ) − ยอดปิดรอบนี้
//
// ที่มาของแต่ละตัว:
//   ยอดยกมา / ยอดปิดรอบ  = /api/stock-month-end (dbo.stock_month_end) รอบก่อนหน้า และรอบที่เลือก
//   ยอดรับเข้า            = /api/orderd (MySQL myfbdata.trans — ใบรับ TRF/RCV ของสาขานั้น)
//   จำนวนหัว              = meta.covers ของ /api/usage-bom ในช่วงวันเดียวกับรอบ
//
// ⚠️ ช่วงวันของ "รอบ" ไม่เท่ากันทุกสาขา — สาขาหนึ่งปิด 31 ส.ค. อีกสาขาปิด 3 ก.ย. ก็ยังเป็น
//    รอบสิงหาคมเหมือนกัน (กติกา cycleMonth ใน lib/monthEndSql.mjs) ฉะนั้นยอดรับกับจำนวนหัว
//    ต้องดึงตามช่วงของ "สาขานั้น" คือ (วันปิดรอบก่อน + 1 วัน) ถึง (วันปิดรอบนี้) ไม่ใช่ 1–31 ของเดือน
//    ไม่งั้นของที่รับเข้าช่วงคาบเกี่ยวจะถูกนับผิดรอบ แล้วยอดใช้เพี้ยนทั้งสาขา
import { cycleMonth, CYCLE_PREV_MONTH_UNTIL_DAY, normalizeId } from './monthEndSql.mjs';
// ชื่อเดือน/วันที่ไทยใช้ของกลางที่ lib/thaiDate.js — หน้าปิดรอบเดือนอ่านชุดเดียวกัน
import { monthLabel, dateLabel } from './thaiDate.js';

export { cycleMonth, CYCLE_PREV_MONTH_UNTIL_DAY, normalizeId, monthLabel, dateLabel };

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' บวก/ลบเดือน (คืน '' ถ้ารูปแบบไม่ใช่) */
export function shiftMonth(ym, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** 'YYYY-MM-DD' + 1 วัน — วันแรกของรอบคือวันถัดจากวันที่นับของรอบก่อน */
export function nextDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * แถวปิดรอบดิบ (rows ของ /api/stock-month-end) -> { [รหัสสาขาตัวเล็ก]: { date, items } }
 *
 * ไอเทมเดียวกันมีได้หลายแถวในรอบเดียว (นับซ้ำ / แก้แล้วบันทึกใหม่) — เอาแถว "วันที่ใหม่สุด"
 * ของไอเทมนั้น ส่วน date ของสาขา = วันที่ใหม่สุดของทั้งสาขา ซึ่งคือวันที่ปิดรอบจริง
 * (บางสาขานับของแห้งวันหนึ่ง ของสดอีกวัน ยอดของแต่ละไอเทมจึงยึดวันของตัวเองไม่ใช่วันของสาขา)
 */
export function closingByBranch(rows) {
  const out = {};
  (rows || []).forEach((r) => {
    const key = String(r.branch || '').trim().toLowerCase();
    // จับคู่ด้วยรหัสสินค้าก่อนเสมอ — item_key เป็นคอลัมน์ที่ตารางอาจไม่มี/เก็บคนละรูปแบบ
    const id = normalizeId(r.itemCode) || normalizeId(r.itemKey);
    if (!key || !id) return;
    const date = String(r.date || '').slice(0, 10);
    const cur = out[key] || (out[key] = { date: '', items: {}, dates: {} });
    if (date > cur.date) cur.date = date;
    if (date >= (cur.dates[id] || '')) {
      cur.dates[id] = date;
      cur.items[id] = Number(r.balance) || 0;
    }
  });
  return out;
}

/**
 * ช่วงวันของรอบ สำหรับสาขาหนึ่ง — ไว้ยิงยอดรับ/จำนวนหัวให้ตรงกับของที่นับจริง
 * @returns {{from:string,to:string,days:number}|null}  null = ข้อมูลไม่พอ (ขาดรอบก่อน หรือรอบนี้)
 */
export function cycleWindow(prevEntry, curEntry) {
  const from = nextDay(prevEntry?.date || '');
  const to = String(curEntry?.date || '').slice(0, 10);
  if (!from || !to || from > to) return null;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  return { from, to, days };
}

/**
 * ใช้จริงของไอเทมหนึ่ง = ยกมา + รับ − ปิด
 * ไอเทมที่ไม่โผล่ในทั้งสามชุดเลย = สาขานี้ไม่มีของตัวนี้ในรอบนี้ คืน null (ไม่ใช่ 0)
 * เพื่อให้ตารางขึ้นขีดแทนเลขศูนย์ และไม่ถูกนับเข้าค่ากลาง
 */
export function actualUsage({ opening, received, closing }) {
  if (opening === undefined && received === undefined && closing === undefined) return null;
  return (Number(opening) || 0) + (Number(received) || 0) - (Number(closing) || 0);
}

/**
 * รวมทุกอย่างของสาขาเดียวให้เป็นแผนที่รายไอเทม
 * @returns {{ usage:{}, flow:{} }} flow[id] = { opening, received, closing, bom }
 */
export function branchFlow({ opening = {}, received = {}, closing = {}, bom = {} }) {
  const ids = new Set([
    ...Object.keys(opening), ...Object.keys(received), ...Object.keys(closing), ...Object.keys(bom),
  ]);
  const usage = {};
  const flow = {};
  ids.forEach((id) => {
    const qty = actualUsage({ opening: opening[id], received: received[id], closing: closing[id] });
    if (qty === null) return;
    usage[id] = qty;
    flow[id] = {
      opening: opening[id] === undefined ? null : Number(opening[id]) || 0,
      received: received[id] === undefined ? null : Number(received[id]) || 0,
      closing: closing[id] === undefined ? null : Number(closing[id]) || 0,
      bom: bom[id] === undefined ? null : Number(bom[id]) || 0,
    };
  });
  return { usage, flow };
}
