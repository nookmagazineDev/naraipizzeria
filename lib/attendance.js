// ตัวช่วยสรุปข้อมูลสแกนหน้า (เข้า-ออกงาน) — พอร์ตมาจาก src/utils/attendance.js ของโปรเจค Narai-branch
//
// "เข้า/ออก" คิดจากลำดับเวลาสแกนของวัน ไม่ได้อิง punch_state
// เพราะการตั้งค่าปุ่มเข้า/ออกของเครื่องสแกนแต่ละตัวไม่เหมือนกัน (ข้อมูลจริงมีทั้งค่า 0/1/2 ปนกัน)

import { leaveText } from './leaveCodes';

/** "2026-08-06 09:05:12" -> "09:05" */
export const hhmm = (t) => String(t || '').slice(11, 16);

/** ผลต่างเป็นชั่วโมง จาก "YYYY-MM-DD HH:MM:SS" (เวลาท้องถิ่นทั้งคู่ ลบกันตรงๆ ได้) */
export function hoursBetween(a, b) {
  if (!a || !b || a === b) return null;
  const d1 = new Date(String(a).replace(' ', 'T'));
  const d2 = new Date(String(b).replace(' ', 'T'));
  if (isNaN(d1) || isNaN(d2)) return null;
  return (d2 - d1) / 3600000;
}

/**
 * รวมรายการสแกนดิบเป็นรายวัน — พนักงาน 1 คน x 1 วัน = 1 แถว
 * คืน [{ date, empCode, name, first, breakOut, breakIn, last, count, hours, breakHours, netHours }]
 * เรียงวันที่ล่าสุดก่อน
 *
 * ลำดับการสแกนปกติของสาขาคือ 4 รอบ: เข้างาน -> ออกเบรค -> เข้าเบรค -> ออกงาน
 * จึงอ่านจาก "ลำดับ" ของเวลาในวันนั้น ไม่ได้อ่านจาก punch_state
 *
 * จำนวนครั้งที่สแกนไม่ครบ 4 ก็ยังอ่านได้เท่าที่มี:
 *   1 ครั้ง = มีแต่เวลาเข้า (ยังไม่ออก หรือลืมสแกน)
 *   2 ครั้ง = เข้า-ออก ไม่ได้แยกเบรค
 *   3 ครั้ง = มีออกเบรค แต่ขาดเข้าเบรค (ลืมสแกนตอนกลับ)
 */
export function summarizeDaily(rows) {
  const m = {};
  for (const r of rows || []) {
    const k = `${r.date}|${r.empCode}`;
    if (!m[k]) m[k] = { date: r.date, empCode: r.empCode, name: r.name, branch: r.area || r.terminal || '', times: [] };
    if (!m[k].name && r.name) m[k].name = r.name;
    if (!m[k].branch && (r.area || r.terminal)) m[k].branch = r.area || r.terminal;
    m[k].times.push(r.time);
  }
  return Object.values(m)
    .map((e) => {
      const ts = e.times.slice().sort();
      const n = ts.length;
      const first = ts[0];
      const last = n > 1 ? ts[n - 1] : null;
      const breakOut = n >= 3 ? ts[1] : null;
      const breakIn = n >= 4 ? ts[2] : null;
      const hours = hoursBetween(first, last);
      const breakHours = hoursBetween(breakOut, breakIn);
      return {
        ...e,
        first,
        breakOut,
        breakIn,
        last,
        count: n,
        hours,
        breakHours,
        // ชั่วโมงทำงานจริงหลังหักเวลาพัก (ถ้าไม่มีข้อมูลพักก็เท่ากับชั่วโมงรวม)
        netHours: hours != null && breakHours != null ? hours - breakHours : hours,
      };
    })
    .sort((a, b) => (b.date + b.empCode).localeCompare(a.date + a.empCode));
}


// ---------------------------------------------------------------------------
// เทียบกับตารางงานที่สาขาลงไว้ (hr_timesheet ผ่าน /api/hr-schedule)
//
// หน้า "ดูสแกนหน้า" จะได้เห็นสองฝั่งคู่กัน: เวลาที่ "ลงตารางไว้" กับเวลาที่ "สแกนจริง"
// แล้วสรุปส่วนต่างให้เลยว่าเข้าสาย/กลับจากเบรคสาย/ออกก่อนเวลากี่นาที
//
// วันที่ลงไว้ว่าหยุด/ลา จะไม่มีเวลาให้เทียบ — ช่องฝั่งตารางงานจึงใส่เหตุผลแทนเวลา
// (หยุด / ลาป่วย / ขาดงาน ฯลฯ) และไม่คิดว่าสายหรือออกก่อน เพราะวันนั้นไม่ได้นัดให้มา
//
// พอร์ตมาจาก src/utils/attendance.js ของ Narai-branch — ต่างกันตรงที่หน้านี้ดูได้ทีละหลายสาขา
// การจับคู่ด้วยชื่อจึงต้องระวังชื่อซ้ำข้ามสาขาเพิ่มอีกชั้น (ดู attachSchedule)
// ---------------------------------------------------------------------------

/** 'HH:mm' -> จำนวนนาทีนับจากเที่ยงคืน (รองรับ '24:00' ที่ระบบลงตารางใช้ได้จริง) */
export function minutesOfDay(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** ระยะเบรคที่อนุญาตเป็นนาที จากข้อความในตารางงาน ('ไม่เบรค' / '1 ชม.') */
export function breakMinutes(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (s.includes('ไม่เบรค')) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 60) : null;
}

/* ชื่อจากเครื่องสแกน (ZKBio9) กับจากตารางงานมักใส่คำนำหน้าไม่เหมือนกัน
   ใช้เป็นทางสำรองตอนรหัสไม่ตรงกันเท่านั้น รหัสยังเป็นตัวหลักเสมอ */
const normName = (s) =>
  String(s || '')
    .replace(/^(นาย|นางสาว|น\.ส\.|นาง|ว่าที่ร\.ต\.|ดร\.|mr\.?|mrs\.?|miss|ms\.?)\s*/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();

const lower = (s) => String(s || '').trim().toLowerCase();
const text = (v) => String(v ?? '').trim();
/** ตัวเลขที่เก็บมาเป็นข้อความ — '0'/''/null ถือว่าไม่มีค่า */
const numOrZero = (v) => {
  const n = parseFloat(text(v));
  return Number.isFinite(n) ? n : 0;
};

/**
 * แถวตารางงานหนึ่งแถว -> เวลาที่ลงไว้ + สถานะของวันนั้น
 *
 * สองคอลัมน์ที่บอกว่า "ไม่ต้องมาทำงาน" แยกกันตามการคิดค่าแรง (ดู lib/leaveCodes.js)
 *   leaveNote    ลา (รับค่าแรง)      เช่น 13 ป่วย, 14 กิจ
 *   unpaidLeave  หยุด (ไม่รับค่าแรง) เช่น 21 ป่วย, 23 ขาดงาน
 * ส่วน status = 'หยุด' คือวันหยุดเฉยๆ ที่ไม่ได้ระบุเหตุผล
 *
 * ลาเป็นชั่วโมง (hourlyLeave) ไม่นับเป็นหยุดทั้งวัน — วันนั้นยังต้องมาสแกนอยู่
 * จึงเก็บไว้เป็นหมายเหตุแทน เหมือน OT และชั่วโมงสะสม
 */
export function planOf(record) {
  if (!record) return null;
  const range = text(record.breakTimeRange).split('-');

  const leaveNote = text(record.leaveNote);       // ลา (รับค่าแรง)
  const unpaidLeave = text(record.unpaidLeave);   // หยุด (ไม่รับค่าแรง)
  const otherNote = text(record.otherNote);
  const status = text(record.status);
  const isOff = status === 'หยุด' || Boolean(leaveNote) || Boolean(unpaidLeave);

  // เหตุผลของวันหยุด — เรียงตามที่หน้าลงตารางแสดง (ลาก่อน แล้วค่อยหยุดไม่รับค่าแรง)
  const reasons = [];
  if (leaveNote) reasons.push(leaveText(leaveNote));
  if (unpaidLeave) reasons.push(leaveText(unpaidLeave));
  if (otherNote) reasons.push(otherNote);

  // หมายเหตุของวันที่ยังต้องมาทำงาน
  const hourlyLeave = numOrZero(record.hourlyLeave);
  const otHours = numOrZero(record.ot);
  const useAccumulated = numOrZero(record.useAccumulatedHours);
  const otAccumulated = numOrZero(record.otAccumulated);
  const notes = [];
  if (hourlyLeave > 0) notes.push(`ลาชม. ${hourlyLeave}`);
  if (useAccumulated > 0) notes.push(`ใช้ชม.สะสม ${useAccumulated}`);
  if (otHours > 0) notes.push(`OT ${otHours}`);
  if (otAccumulated > 0) notes.push(`+สะสม ${otAccumulated}`);
  if (otherNote && !isOff) notes.push(otherNote);

  return {
    // รหัสพนักงานฝั่งตารางงาน — คนละตัวกับรหัสเครื่องสแกนได้ (รายงานเงินเดือนใช้เป็นช่อง SSN)
    hrCode: text(record.hrCode),
    in: record.checkIn || '',
    out: record.checkOut || '',
    breakOut: range[0] || '',
    breakIn: range[1] || '',
    breakAllowed: breakMinutes(record.breakTime),
    status,
    position: text(record.position),
    empType: text(record.empType),
    otHours,
    otApprover: text(record.otApprover),
    hourlyLeave,
    leaveNote,
    unpaidLeave,
    otherNote,
    isOff,
    // ลา (รับค่าแรง) กับ หยุด (ไม่รับค่าแรง) ใช้สีต่างกัน ฝ่ายบุคคลจะได้แยกออกตั้งแต่มอง
    offPaid: Boolean(leaveNote) && !unpaidLeave,
    offLabel: isOff ? (leaveNote && !unpaidLeave ? 'ลา' : 'หยุด') : '',
    reasons,
    notes,
  };
}

/** ต่างกันกี่นาที คืน null ถ้าข้อมูลไม่พอ และคืน 0 เมื่อไม่สาย (ไม่คืนค่าติดลบ) */
function lateBy(actual, planned) {
  const a = minutesOfDay(actual);
  const p = minutesOfDay(planned);
  if (a == null || p == null) return null;
  return Math.max(0, Math.round(a - p));
}

/** แถวตารางงานที่ไม่มีการสแกนคู่กัน -> แถวเปล่าฝั่งสแกน เพื่อให้วันหยุด/ลาขึ้นในตารางด้วย */
function rowFromSchedule(record) {
  return {
    date: String(record.workDate || '').slice(0, 10),
    empCode: text(record.hrCode),
    name: text(record.name),
    // ฝั่งสแกนใช้รหัสสาขาตัวพิมพ์ใหญ่ (area_alias) ส่วนฐาน HR เก็บตัวพิมพ์เล็ก — แสดงให้เหมือนกัน
    branch: text(record.branch).toUpperCase(),
    times: [],
    first: null,
    breakOut: null,
    breakIn: null,
    last: null,
    count: 0,
    hours: null,
    breakHours: null,
    netHours: null,
    plan: planOf(record),
    lateIn: null,
    lateBreakIn: null,
    earlyOut: null,
    noScan: true,
    offScanned: false,
  };
}

/**
 * รวมสรุปรายวัน (จากการสแกน) เข้ากับตารางงานที่สาขาลงไว้
 *
 * ลำดับการจับคู่ — รหัสมาก่อนเสมอ เพราะ hr_code เป็นคีย์หลักที่ไม่ซ้ำทั้งระบบ:
 *   1) วันที่ + รหัสพนักงาน
 *   2) วันที่ + สาขา + ชื่อ   (เครื่องสแกนกับตารางงานเป็นคนละระบบ บางสาขารหัสจึงไม่ตรงกัน)
 *   3) วันที่ + ชื่อ          เฉพาะชื่อที่ไม่ซ้ำข้ามสาขาในวันนั้น — หน้านี้ดูได้ทีละหลายสาขา
 *                            ชื่อซ้ำแล้วจับมั่วจะได้เวลาของอีกคนมาแสดง จึงยอมไม่จับดีกว่า
 *
 * เพิ่มให้แต่ละแถว:
 *   plan          สิ่งที่ลงตารางไว้ (null = วันนั้นไม่มีในตารางงาน)
 *   lateIn        เข้างานสายกี่นาที
 *   lateBreakIn   กลับจากเบรคสายกี่นาที
 *   earlyOut      ออกก่อนเวลากี่นาที
 *   offScanned    ลงไว้ว่าหยุด/ลา แต่มีการสแกนจริง (ควรไปตรวจว่าลืมแก้ตาราง หรือมาทำงานจริง)
 *   noScan        มีในตารางงาน แต่ไม่มีการสแกนเลยทั้งวัน
 *
 * includeUnscanned = true จะเพิ่มแถวของคนที่ลงตารางไว้แต่ไม่มีการสแกนเข้ามาด้วย
 * ถ้าไม่เพิ่ม วันหยุด/วันลาจะไม่โผล่ในตารางเลย เพราะวันพวกนั้นไม่มีใครไปสแกน
 */
export function attachSchedule(daily, scheduleRows, { includeUnscanned = false } = {}) {
  const rows = (scheduleRows || []).filter(
    (r) => r.otherNote !== 'ล้างข้อมูล' && String(r.workDate || '').slice(0, 10)
  );

  const byCode = new Map();
  const byBranchName = new Map();
  const byName = new Map();
  const dupName = new Set(); // ชื่อที่โผล่มากกว่าหนึ่งแถวในวันเดียวกัน -> ห้ามจับด้วยชื่ออย่างเดียว

  for (const r of rows) {
    const date = String(r.workDate).slice(0, 10);
    if (r.hrCode) byCode.set(`${date}|${text(r.hrCode)}`, r);

    const n = normName(r.name);
    if (!n) continue;
    byBranchName.set(`${date}|${lower(r.branch)}|${n}`, r);

    const key = `${date}|${n}`;
    const seen = byName.get(key);
    // แถวเดิมของคนเดิม (บันทึกซ้ำ/สาขาเดียวกัน) ไม่นับว่าซ้ำ
    if (seen && text(seen.hrCode) !== text(r.hrCode)) dupName.add(key);
    byName.set(key, r);
  }

  const used = new Set(); // แถวตารางงานที่จับคู่กับการสแกนไปแล้ว

  const merged = (daily || []).map((d) => {
    const n = normName(d.name);
    const nameKey = `${d.date}|${n}`;
    const rec =
      byCode.get(`${d.date}|${text(d.empCode)}`) ||
      (n ? byBranchName.get(`${d.date}|${lower(d.branch)}|${n}`) : null) ||
      (n && !dupName.has(nameKey) ? byName.get(nameKey) : null) ||
      null;
    if (rec) used.add(rec);

    const plan = planOf(rec);
    const base = { ...d, plan, noScan: false, offScanned: false };
    if (!plan) return { ...base, lateIn: null, lateBreakIn: null, earlyOut: null };

    // วันหยุด/วันลา ไม่มีเวลานัดให้เทียบ จึงไม่คิดว่าสายหรือออกก่อน
    // แต่ถ้ามีการสแกนจริงก็ติดธงไว้ให้ไปตรวจ (ลืมแก้ตาราง หรือมาทำงานแทนคนอื่น)
    if (plan.isOff) {
      return { ...base, lateIn: null, lateBreakIn: null, earlyOut: null, offScanned: d.count > 0 };
    }

    // กลับจากเบรคสาย: เทียบกับเวลาสิ้นสุดเบรคที่ลงไว้ ถ้าไม่ได้ลงช่วงเวลาไว้
    // ก็เทียบกับ "ออกเบรคจริง + ระยะเบรคที่อนุญาต" แทน จะได้ยังวัดได้
    let lateBreakIn = lateBy(hhmm(d.breakIn), plan.breakIn);
    if (lateBreakIn == null && plan.breakAllowed != null && d.breakOut && d.breakIn) {
      const out = minutesOfDay(hhmm(d.breakOut));
      const back = minutesOfDay(hhmm(d.breakIn));
      if (out != null && back != null) lateBreakIn = Math.max(0, Math.round(back - out - plan.breakAllowed));
    }

    return {
      ...base,
      lateIn: lateBy(hhmm(d.first), plan.in),
      lateBreakIn,
      // ออกก่อนเวลา = กลับด้านของการสาย (เวลาที่ลงไว้ - เวลาที่สแกนออกจริง)
      earlyOut: lateBy(plan.out, d.last ? hhmm(d.last) : ''),
    };
  });

  if (includeUnscanned) {
    for (const r of rows) if (!used.has(r)) merged.push(rowFromSchedule(r));
  }

  return merged.sort((a, b) => (b.date + b.empCode).localeCompare(a.date + a.empCode));
}
