// ตัวช่วยเรื่อง "ช่วงวันที่" ที่หน้า "ดูสแกนหน้า" ใช้ร่วมกันทั้งสองฝั่ง
// (/api/attendance = เวลาสแกน · /api/hr-schedule = ตารางงานที่สาขาลงไว้)
//
// ทั้งสองฝั่งเจอปัญหาเดียวกัน: ต้นทางมีเพดานจำนวนแถวของตัวเอง ขอทีเดียวช่วงยาวๆ
// แล้วชนเพดานเมื่อไหร่ ข้อมูลจะหายไป "ทั้งวัน" โดยไม่มีอะไรบอก และไม่รู้ด้วยว่า
// หายฝั่งวันเก่าหรือวันใหม่ (แล้วแต่ว่าต้นทางเรียงข้อมูลมายังไง)
//
// วิธีแก้ที่ใช้ร่วมกัน:
//   dateChunks   หั่นช่วงเป็นก้อนเล็กๆ ก่อนยิง — ไม่มีก้อนไหนชนเพดานของต้นทาง
//   capByDay     ถ้าจะตัดเพราะเกินเพดานของเราเอง ก็ตัด "ทั้งวัน" จากวันเก่าสุด
//   missingDates วันไหนในช่วงที่ไม่มีข้อมูลเลย — เอาไปบอกผู้ใช้ตรงๆ ว่าขาดวันไหน

/** เลื่อนวันแบบ YYYY-MM-DD (คิดบน UTC ไม่ให้เวลาท้องถิ่นของเซิร์ฟเวอร์มาทำวันเพี้ยน) */
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** '2026-09-01'..'2026-09-17' -> [{start,end}] ก้อนละไม่เกิน size วัน */
export function dateChunks(start, end, size) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push({ start: s, end: e > end ? end : e });
  }
  return out;
}

/** วันของแถว — เผื่อฝั่งที่ส่งมาเป็น '2026-09-15T00:00:00.000Z' หรือ '2026-09-15 09:00:00' */
export const dayOf = (v) => String(v ?? '').slice(0, 10);

/**
 * ตัดให้เหลือไม่เกินเพดาน โดยตัด "ทั้งวัน" จากวันเก่าสุดขึ้นมา
 * ต้องส่ง rows ที่เรียงใหม่→เก่ามาแล้ว (ดู sortByDayDesc)
 *
 * ตัดกลางวันจะได้วันที่มีข้อมูลครึ่งวันมาแทน ซึ่งอ่านแล้วเข้าใจผิดว่าวันนั้นไม่มีคนมา
 * คืน { data, truncated, from } — from = วันเก่าสุดที่ยังอยู่ในชุดข้อมูล
 */
export function capByDay(rows, cap, dateOf = (r) => r.date) {
  if ((rows || []).length <= cap) return { data: rows || [], truncated: false, from: null };
  let n = 0;
  let day = null;
  for (const r of rows) {
    const d = dateOf(r);
    if (n >= cap && d !== day) break;  // ครบเพดานแล้ว และกำลังจะขึ้นวันใหม่ = พอ
    day = d;
    n++;
  }
  return { data: rows.slice(0, n), truncated: true, from: day };
}

/** วันในช่วงที่ไม่มีข้อมูลเลยสักแถว — ไว้บอกผู้ใช้ว่า "ขาดวันไหน" จะได้ไม่ต้องไล่ดูเอง */
export function missingDates(rows, start, end, dateOf = (r) => r.date) {
  const have = new Set((rows || []).map(dateOf));
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}
