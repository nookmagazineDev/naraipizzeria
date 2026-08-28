// สรุปเงินเดือนรายคน — ทำให้ออกมาหน้าตาเหมือนฟอร์ม "Summary <สาขา>" ที่ฝ่ายบุคคลใช้อยู่
//
// ฟอร์มต้นแบบ (ชีต Summary ของแต่ละสาขา) มี 31 คอลัมน์ เรียงแบบนี้:
//   สาขา · Badgenumber · SSN · ชื่อ · ตำแหน่ง · สถานะ
//   วันทำงาน · วันทำงาน นข · OT · หักสาย · หักสาย นข · เวลาทำงาน · เวลาทำงาน นข
//   สาย (นาที) · สาย นข (นาที)
//   คอลัมน์วันลา 14 ช่อง เรียงตามรหัส 10,11,12,13,14,15,16,17,19,80,18,21,22,23
//   วันทำงาน (ยอดที่ใช้จ่ายเงิน) · รวมสาย (นาที)
// แถวบนสุดของชีตเป็นรหัสลาที่ลอยอยู่เหนือคอลัมน์วันลา และมีรหัสสาขาอยู่ช่องแรก
//
// "นข" = วันหยุดนักขัตฤกษ์ — ในฟอร์มนับ "วันที่มาทำงานในวันนักขัตฤกษ์" แยกออกจากวันทำงานปกติ
// (ยอดรวมของแต่ละคน วันทำงาน + นข + วันหยุด/ลาทุกช่อง = จำนวนวันของงวด)
// ตารางงาน (hr_timesheet) ไม่ได้บอกว่าวันไหนเป็นนักขัตฤกษ์ หน้ารายงานจึงให้ระบุวันเอง
// ไม่ระบุ = ทุกวันนับเป็นวันทำงานปกติเหมือนเดิม (ช่อง นข เป็น 0)
//
// ข้อมูลตั้งต้นเป็นแถวรายวันที่ผ่าน attachSchedule() มาแล้ว (ตารางงาน + เวลาสแกนจริง)
//   ตารางงาน (hr_timesheet) --\
//                              >-- attachSchedule() -> แถวรายวัน -> summarizeSalary()
//   สแกนหน้า (ZKBio9) --------/

const num = (v) => (Number.isFinite(v) ? v : 0);
const text = (v) => String(v ?? '').trim();

/** ปัดทศนิยม 2 ตำแหน่ง */
export const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/**
 * คอลัมน์วันลาในฟอร์ม เรียงตามชีตต้นแบบ (รหัส 18 "ออก" อยู่ต่อจาก 80 ไม่ได้เรียงเลข)
 * paidWork = นับรวมเป็น "วันทำงาน" ช่องท้ายสุดของพนักงานรายวัน (วันลาที่ยังได้ค่าแรง)
 *   10 หยุด   = วันหยุดประจำ ไม่ใช่วันลา จึงไม่นับ
 *   18 ออก    = วันที่พ้นสภาพแล้ว ไม่นับ
 *   21/22/23  = หยุดแบบไม่รับค่าแรง ไม่นับ
 */
export const LEAVE_COLUMNS = [
  { code: '10', label: 'หยุด' },
  { code: '11', label: 'ชดเชย', paidWork: true },
  { code: '12', label: 'V', paidWork: true },
  { code: '13', label: 'ป่วย', paidWork: true },
  { code: '14', label: 'กิจ', paidWork: true },
  { code: '15', label: 'cd off', paidWork: true },
  { code: '16', label: 'M , ประชุม', paidWork: true },
  { code: '17', label: 'คลอด', paidWork: true },
  { code: '19', label: 'อบรม', paidWork: true },
  { code: '80', label: '8hr', paidWork: true },
  { code: '18', label: 'ออก' },
  { code: '21', label: 'ป่วย', unpaid: true },
  { code: '22', label: 'กิจ', unpaid: true },
  { code: '23', label: 'ขาดงาน', unpaid: true },
];

/** วันหยุดประจำที่ไม่ได้ระบุรหัส (ตารางงานลงแค่ status='หยุด') ให้ตกในช่องนี้ */
export const WEEKLY_OFF_CODE = '10';

const LEAVE_CODE_SET = new Set(LEAVE_COLUMNS.map((c) => c.code));

/** '13 ป่วย' / '13' -> '13' · ค่าที่ไม่ได้ขึ้นต้นด้วยรหัสที่รู้จักคืน '' */
export function columnCode(value) {
  const first = text(value).split(/\s+/)[0];
  return LEAVE_CODE_SET.has(first) ? first : '';
}

/**
 * ประเภทการจ่ายของพนักงาน — อ่านจากช่อง "สถานะ" ในตารางงาน (DAY / F/T / P/T)
 * ช่อง "วันทำงาน" ท้ายฟอร์มคิดคนละแบบตามประเภทนี้ (ดู payableTotal)
 * รองรับคำไทยด้วย เผื่อบางสาขากรอกเป็น รายเดือน/พาร์ทไทม์/รายวัน
 */
export function payUnitOf(empType) {
  const s = text(empType).toUpperCase().replace(/[\s.\-/]/g, '');
  if (!s) return 'daily';
  if (s.startsWith('FT') || s.includes('FULL') || text(empType).includes('รายเดือน')) return 'monthly';
  if (s.startsWith('PT') || s.includes('PART') || text(empType).includes('พาร์ท')) return 'hourly';
  return 'daily';
}

// ---------------------------------------------------------------------------
// รูปแบบตัวเลขในฟอร์ม
// ---------------------------------------------------------------------------

/** 187 นาที -> '03:07' · ชั่วโมงเกิน 24 ไม่ตัด (ฟอร์มใช้ '215:50' แบบชั่วโมงสะสม) */
export function hhmmOfMinutes(minutes) {
  const total = Math.max(0, Math.round(num(minutes)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 2.5 ชั่วโมง -> '02:30' */
export const hhmmOfHours = (hours) => hhmmOfMinutes(num(hours) * 60);

/** 'HH:mm' -> นาทีนับจากเที่ยงคืน (รองรับ '24:00' ที่ระบบลงตารางใช้ได้จริง) */
function minutesOfDay(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * เวลาทำงานที่ "ลงตารางไว้" ของวันนั้นเป็นนาที (หักเวลาพักที่อนุญาตแล้ว)
 * ข้ามคืนได้ (เข้า 17:00 ออก 01:00 = 8 ชม.) · ไม่มีเวลาให้คิดคืน null
 */
export function plannedMinutes(plan) {
  const start = minutesOfDay(plan?.in);
  const end = minutesOfDay(plan?.out);
  if (start == null || end == null) return null;
  const span = (end > start ? end : end + 24 * 60) - start;
  return Math.max(0, span - num(plan?.breakAllowed));
}

// ---------------------------------------------------------------------------
// สรุปรายคน
// ---------------------------------------------------------------------------

const blankPerson = () => ({
  branch: '',
  badge: '',          // Badgenumber — รหัสที่เครื่องสแกนส่งมา (ไม่มีสแกนเลยจะใช้รหัสตารางงานแทน)
  scanBadge: '',      // รหัสจากแถวที่มีการสแกนจริง — ตัวนี้คือ Badgenumber ตัวจริง
  ssn: '',            // SSN — รหัสพนักงานในตารางงาน (hr_code)
  name: '',
  position: '',
  empType: '',
  workDays: 0,            // วันทำงาน (ไม่รวมวันนักขัตฤกษ์)
  holidayWorkDays: 0,     // วันทำงาน นข
  otHours: 0,             // OT (ชั่วโมง)
  lateMinutes: 0,         // สาย (นาที) ของวันทำงานปกติ
  holidayLateMinutes: 0,  // สาย นข (นาที)
  workMinutes: 0,         // เวลาทำงาน (นาที) หักสายแล้ว
  holidayWorkMinutes: 0,  // เวลาทำงาน นข (นาที) หักสายแล้ว
  leaveDays: {},          // { '13': 2, ... } จำนวนวันของแต่ละรหัสลา
  hourlyLeave: 0,         // ลาเป็นชั่วโมง (ไม่ได้อยู่ในฟอร์ม — ใช้เป็นหมายเหตุ)
  noScanDays: 0,          // ลงตารางว่าทำงาน แต่ไม่มีสแกนเลยทั้งวัน
  noPlanDays: 0,          // มีสแกน แต่ไม่มีในตารางงาน
  days: 0,
});

/**
 * ยุบแถวรายวันให้เหลือคนละแถวตามฟอร์ม Summary
 *
 * @param dailyRows แถวรายวันจาก attachSchedule()
 * @param opts.holidays วันหยุดนักขัตฤกษ์ ['YYYY-MM-DD', ...] — วันทำงานที่ตรงกับวันพวกนี้จะไปลงช่อง นข
 * @returns รายคน เรียงตามสาขาแล้วตามรหัส
 *
 * จับกลุ่มด้วยรหัสในตารางงาน (hr_code) เป็นหลัก เพราะคนเดียวกันอาจมีรหัสเครื่องสแกน
 * คนละตัวกับรหัสในตารางงาน ถ้าจับด้วยรหัสของแถวตรงๆ วันที่มีสแกนกับวันที่ไม่มีสแกน
 * จะกลายเป็นคนละแถวกัน (attachSchedule จับคู่ด้วยชื่อให้แล้วเมื่อรหัสไม่ตรง)
 */
export function summarizeSalary(dailyRows, { holidays = [] } = {}) {
  const rows = dailyRows || [];
  const holidaySet = new Set(holidays || []);

  // รหัสเครื่องสแกน -> รหัสในตารางงาน (เรียนรู้จากแถวที่มีทั้งคู่)
  const hrByBadge = new Map();
  for (const r of rows) {
    const hr = text(r.plan?.hrCode);
    const badge = text(r.empCode);
    if (hr && badge) hrByBadge.set(badge, hr);
  }

  const byPerson = new Map();
  for (const row of rows) {
    const badge = text(row.empCode);
    const hr = text(row.plan?.hrCode) || hrByBadge.get(badge) || '';
    const key = hr || badge || `ชื่อ:${text(row.name)}`;
    if (key === 'ชื่อ:') continue;

    let p = byPerson.get(key);
    if (!p) { p = blankPerson(); byPerson.set(key, p); }

    if (!p.branch && row.branch) p.branch = text(row.branch);
    // รหัสของแถวที่มาจากการสแกน = Badgenumber ของเครื่องสแกน ส่วนแถวที่มาจากตารางงาน
    // จะเป็นรหัส hr — คนที่รหัสสองระบบไม่ตรงกันต้องเอาตัวจากเครื่องสแกนมาลงช่อง Badgenumber
    if (!p.scanBadge && badge && row.count > 0) p.scanBadge = badge;
    if (!p.badge && badge) p.badge = badge;
    if (!p.ssn && hr) p.ssn = hr;
    if (!p.name && row.name) p.name = text(row.name);

    const plan = row.plan;
    if (plan) {
      if (!p.position && plan.position) p.position = plan.position;
      if (!p.empType && plan.empType) p.empType = plan.empType;
      p.otHours += num(plan.otHours);
      p.hourlyLeave += num(plan.hourlyLeave);
    }
    p.days += 1;

    // วันหยุด/วันลา -> ลงช่องตามรหัส แล้วจบ (ไม่มีเวลาทำงานให้คิด)
    if (plan?.isOff) {
      const code = columnCode(plan.unpaidLeave) || columnCode(plan.leaveNote) || WEEKLY_OFF_CODE;
      p.leaveDays[code] = (p.leaveDays[code] || 0) + 1;
      continue;
    }
    // ไม่มีทั้งตารางงานและสแกน — ไม่นับเป็นอะไรเลย
    if (!plan && !(row.count > 0)) continue;

    // วันทำงาน — สายคิดจากเวลาสแกนเทียบตารางงาน (เข้าสาย + กลับจากเบรคสาย)
    const late = num(row.lateIn) + num(row.lateBreakIn);
    // เวลาทำงานยึดตามตารางที่ลงไว้ หักสายออก · ไม่ได้ลงเวลาไว้ค่อยใช้เวลาสแกนจริงแทน
    const planned = plannedMinutes(plan);
    const worked = Math.max(0, (planned != null ? planned : Math.round(num(row.netHours) * 60)) - late);

    if (holidaySet.has(row.date)) {
      p.holidayWorkDays += 1;
      p.holidayLateMinutes += late;
      p.holidayWorkMinutes += worked;
    } else {
      p.workDays += 1;
      p.lateMinutes += late;
      p.workMinutes += worked;
    }
    if (!plan) p.noPlanDays += 1;
    else if (row.noScan) p.noScanDays += 1;
  }

  return [...byPerson.values()]
    .map((p) => ({
      ...p,
      badge: p.scanBadge || p.badge,
      otHours: round2(p.otHours),
      hourlyLeave: round2(p.hourlyLeave),
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch) || (a.badge || a.ssn).localeCompare(b.badge || b.ssn));
}

/** จำนวนวันในงวด (นับหัวท้าย) — ใช้เป็นยอดของพนักงานรายเดือน */
export function periodDays(start, end) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  if (isNaN(a) || isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * ช่อง "วันทำงาน" ช่องท้ายฟอร์ม — ยอดที่เอาไปคูณค่าแรง คิดคนละแบบตามสถานะ
 *   F/T (รายเดือน)  = จำนวนวันของงวด (จ่ายเต็มงวด)
 *   P/T (พาร์ทไทม์) = ชั่วโมงทำงานรวม (เวลาทำงาน + เวลาทำงาน นข)
 *   DAY / เหมา      = วันทำงาน + วันทำงาน นข + วันลาที่ยังได้ค่าแรง (ไม่รวม 10 หยุด, 18 ออก)
 */
export function payableTotal(person, days) {
  const unit = payUnitOf(person.empType);
  if (unit === 'monthly') return num(days);
  if (unit === 'hourly') return round2((person.workMinutes + person.holidayWorkMinutes) / 60);
  const paidLeave = LEAVE_COLUMNS
    .filter((c) => c.paidWork)
    .reduce((sum, c) => sum + num(person.leaveDays[c.code]), 0);
  return person.workDays + person.holidayWorkDays + paidLeave;
}

/** หน่วยของยอดช่อง "วันทำงาน" ท้ายฟอร์ม — ไว้ขึ้น title ให้คนอ่านรู้ว่าเป็นวันหรือชั่วโมง */
export const payableUnitLabel = (person) => {
  const unit = payUnitOf(person.empType);
  return unit === 'hourly' ? 'ชั่วโมง' : 'วัน';
};

// ---------------------------------------------------------------------------
// วันหยุดนักขัตฤกษ์ที่ระบุไว้ — เก็บในเบราว์เซอร์เครื่องที่กรอก
// (ยังไม่มีทะเบียนวันหยุดกลางในระบบ ถ้าวันหลังมีให้เปลี่ยนมาอ่านจากที่นั่นแทน)
// ---------------------------------------------------------------------------

export const HOLIDAYS_KEY = 'narai.payroll.holidays.v1';

/** อ่านรายการวันหยุด — ปลอดภัยทั้งตอน render ฝั่งเซิร์ฟเวอร์และตอนค่าที่เก็บไว้เสีย */
export function loadHolidays() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HOLIDAYS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  } catch {
    return [];
  }
}

export function saveHolidays(list) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(HOLIDAYS_KEY, JSON.stringify([...new Set(list)].sort()));
    return true;
  } catch {
    return false;   // โหมดส่วนตัว/พื้นที่เต็ม — ใช้ต่อได้ แค่ไม่ถูกจำไว้รอบหน้า
  }
}
