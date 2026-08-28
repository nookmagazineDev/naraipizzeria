// สรุปเงินเดือน — รวมข้อมูลรายวันให้เป็นยอดรายคน สำหรับหน้า HR → รายงานเงินเดือน
//
// ข้อมูลตั้งต้นเป็นชุดเดียวกับหน้า "ดูสแกนหน้า" คือแถวรายวันที่ผ่าน attachSchedule() มาแล้ว
// (ตารางงานที่สาขาลงไว้ + เวลาสแกนจริง) ไฟล์นี้แค่ยุบให้เหลือคนละแถว แล้วคิดเป็นเงิน
//
//   ตารางงาน (hr_timesheet) --\
//                              >-- attachSchedule() -> แถวรายวัน -> summarizePayroll() -> รายคน
//   สแกนหน้า (ZKBio9) --------/
//
// ⚠️ ระบบยังไม่มีที่เก็บ "ค่าแรง" ของพนักงาน (ชีตพนักงานไม่มีคอลัมน์นี้ และฐาน HR ก็ไม่ได้ส่งมา)
//    หน้ารายงานจึงให้กรอกค่าแรงเอง แล้วเก็บไว้ในเครื่องที่กรอก (localStorage) — ดู loadRates()
//    ถ้าวันหลังมีคอลัมน์ค่าแรงในชีตพนักงานแล้ว ให้เปลี่ยนมาอ่านจากที่นั่นแทน ตัวคิดเงินด้านล่างใช้ต่อได้เลย

import { leaveCode, leaveText } from './leaveCodes';

/** ขาดงาน — รหัสในกลุ่ม "หยุด (ไม่รับค่าแรง)" ที่ต้องแยกให้เห็นชัดในรายงาน */
export const ABSENT_CODE = '23';

/**
 * '10 หยุด' อยู่ในกลุ่มลารับค่าแรงก็จริง แต่ในทางปฏิบัติคือ "วันหยุดประจำสัปดาห์"
 * ไม่ใช่วันลาที่ต้องจ่ายค่าแรงให้พนักงานรายวัน จึงนับแยกเป็นวันหยุด ไม่รวมในวันรับค่าแรง
 */
export const WEEKLY_OFF_CODE = '10';

/** ค่าตั้งต้นของการคิดเงิน — ผู้ใช้ปรับได้ที่หัวหน้ารายงาน */
export const DEFAULT_SETTINGS = {
  hoursPerDay: 8,      // ชั่วโมงทำงานมาตรฐานต่อวัน (ใช้แปลงค่าแรงรายวัน -> รายชั่วโมง)
  otMultiplier: 1.5,   // ตัวคูณค่า OT
  deductLate: false,   // หักเงินตามนาทีที่เข้าสาย/กลับเบรคสาย
};

/** ค่าแรงรายคนที่ยังไม่ได้กรอก */
export const DEFAULT_RATE = { amount: 0, mode: 'daily' };  // mode: 'daily' = ต่อวัน | 'monthly' = ต่อเดือน

/** จำนวนวันที่ใช้หารเงินเดือนของพนักงานรายเดือน (มาตรฐานที่ฝ่ายบุคคลใช้กัน) */
export const MONTH_DAYS = 30;

const num = (v) => (Number.isFinite(v) ? v : 0);
const text = (v) => String(v ?? '').trim();

/** ปัดเป็นทศนิยม 2 ตำแหน่ง (เงินและชั่วโมงใช้ร่วมกัน) */
export const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/** 1234.5 -> '1,234.50' */
export const money = (n) =>
  num(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * วันหนึ่งของคนหนึ่ง นับเป็นอะไร — แยกไว้เป็นฟังก์ชันเดียวเพื่อให้ตารางรายวัน
 * กับยอดรวมรายคนใช้เกณฑ์เดียวกันเสมอ
 *
 *   work    มาทำงาน (ลงตารางไว้ว่าทำงาน หรือไม่มีในตารางแต่มีสแกน)
 *   paid    ลาแบบรับค่าแรง (13 ป่วย, 14 กิจ ฯลฯ — ไม่รวม 10 หยุด)
 *   off     วันหยุด (ลงว่าหยุดเฉยๆ หรือรหัส 10 หยุด) — ไม่จ่าย ไม่หัก
 *   unpaid  หยุดแบบไม่รับค่าแรง (21 ป่วย, 22 กิจ, 23 ขาดงาน)
 *   none    ไม่มีทั้งตารางงานและสแกน (ไม่ควรเกิด — กันไว้ไม่ให้ตกหล่นเงียบๆ)
 */
export function dayKind(row) {
  const plan = row?.plan;
  if (!plan) return row?.count > 0 ? 'work' : 'none';
  if (!plan.isOff) return 'work';
  if (plan.unpaidLeave) return 'unpaid';
  if (plan.leaveNote) return leaveCode(plan.leaveNote) === WEEKLY_OFF_CODE ? 'off' : 'paid';
  return 'off';
}

/**
 * ยุบแถวรายวันให้เหลือคนละแถว
 *
 * จับกลุ่มด้วยรหัสพนักงาน (คนเดียวกันทำหลายสาขาในงวดเดียวก็ยังเป็นแถวเดียว — เก็บสาขาไว้ทุกสาขา)
 * แถวที่ไม่มีรหัสจะใช้ชื่อแทน ไม่งั้นทุกคนที่ไม่มีรหัสจะถูกรวมเป็นคนเดียวกันหมด
 *
 * คืน [{ empCode, name, branch, branches, position, empType, workDays, paidLeaveDays,
 *        offDays, unpaidDays, absentDays, noPlanDays, noScanDays, offScannedDays,
 *        otHours, hourlyLeave, netHours,
 *        lateMinutes, earlyMinutes, leaveSummary, days }]
 * เรียงตามสาขาแล้วตามรหัสพนักงาน
 */
export function summarizePayroll(dailyRows) {
  const byPerson = new Map();

  for (const row of dailyRows || []) {
    const empCode = text(row.empCode);
    const key = empCode || `ชื่อ:${text(row.name)}`;
    if (!key || key === 'ชื่อ:') continue;

    let p = byPerson.get(key);
    if (!p) {
      p = {
        empCode,
        name: text(row.name),
        branches: [],
        position: '',
        empType: '',
        days: 0,
        workDays: 0,
        paidLeaveDays: 0,
        offDays: 0,
        unpaidDays: 0,
        absentDays: 0,
        noPlanDays: 0,       // มาสแกนแต่ไม่มีในตารางงาน (นับเป็นวันทำงานให้ แต่ควรไปตรวจ)
        noScanDays: 0,       // ลงตารางว่าทำงาน แต่ไม่มีสแกนเลยทั้งวัน
        offScannedDays: 0,   // ลงว่าหยุด/ลา แต่มีสแกน
        otHours: 0,
        hourlyLeave: 0,     // ลาเป็นชั่วโมง (วันนั้นยังมาทำงาน) — ไม่ถูกคิดเงินให้อัตโนมัติ
        netHours: 0,
        lateMinutes: 0,
        earlyMinutes: 0,
        leaveCounts: {},     // { '13 ป่วย': 2, ... } นับตามรหัสลาเพื่อให้ฝ่ายบุคคลตรวจย้อนได้
      };
      byPerson.set(key, p);
    }

    if (!p.name && row.name) p.name = text(row.name);
    const branch = text(row.branch);
    if (branch && !p.branches.includes(branch)) p.branches.push(branch);

    const plan = row.plan;
    if (plan) {
      if (!p.position && plan.position) p.position = plan.position;
      if (!p.empType && plan.empType) p.empType = plan.empType;
      p.otHours += num(plan.otHours);
      p.hourlyLeave += num(plan.hourlyLeave);
      for (const v of [plan.leaveNote, plan.unpaidLeave]) {
        const label = leaveText(v);
        if (label) p.leaveCounts[label] = (p.leaveCounts[label] || 0) + 1;
      }
    }

    p.days += 1;
    p.netHours += num(row.netHours);
    p.lateMinutes += num(row.lateIn) + num(row.lateBreakIn);
    p.earlyMinutes += num(row.earlyOut);
    if (row.offScanned) p.offScannedDays += 1;

    switch (dayKind(row)) {
      case 'work':
        p.workDays += 1;
        if (!plan) p.noPlanDays += 1;
        if (row.noScan) p.noScanDays += 1;
        break;
      case 'paid':
        p.paidLeaveDays += 1;
        break;
      case 'unpaid':
        p.unpaidDays += 1;
        if (leaveCode(plan.unpaidLeave) === ABSENT_CODE) p.absentDays += 1;
        break;
      case 'off':
        p.offDays += 1;
        break;
      default:
        break;
    }
  }

  return [...byPerson.values()]
    .map((p) => ({
      ...p,
      branch: p.branches[0] || '',
      netHours: round2(p.netHours),
      otHours: round2(p.otHours),
      hourlyLeave: round2(p.hourlyLeave),
      // '13 ป่วย 2, 23 ขาดงาน 1, ลาชม. 4' — ใส่จำนวนวันต่อท้ายเฉพาะที่มากกว่าหนึ่งวัน
      leaveSummary: [
        ...Object.entries(p.leaveCounts).map(([label, n]) => (n > 1 ? `${label} ${n}` : label)),
        ...(p.hourlyLeave > 0 ? [`ลาชม. ${round2(p.hourlyLeave)}`] : []),
      ].join(', '),
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.empCode.localeCompare(b.empCode));
}

/**
 * คิดเงินของคนหนึ่งตามค่าแรงที่กรอกไว้
 *
 * รายวัน (mode 'daily')
 *   ค่าแรง   = (วันทำงาน + วันลารับค่าแรง) x ค่าแรงต่อวัน
 *   วันหยุด/วันหยุดไม่รับค่าแรง ไม่ได้เงินอยู่แล้ว จึงไม่ต้องหักซ้ำ
 *
 * รายเดือน (mode 'monthly')
 *   ค่าแรง   = เงินเดือนเต็มงวด แล้วหักวันที่หยุดแบบไม่รับค่าแรง วันละ เงินเดือน/30
 *
 * ทั้งสองแบบ
 *   OT      = ชั่วโมง OT x (ค่าแรงต่อวัน / ชั่วโมงมาตรฐาน) x ตัวคูณ OT
 *   หักสาย  = นาทีที่สาย x ค่าแรงต่อนาที (เปิด/ปิดได้ ค่าเริ่มต้นคือปิด)
 *
 * ลาเป็นชั่วโมง / ชั่วโมงสะสม ไม่ถูกนำมาคิดเงินอัตโนมัติ — แสดงไว้ให้ฝ่ายบุคคลตัดสินใจเอง
 * เพราะแต่ละสาขาใช้ต่างกัน (บางที่หักเวลา บางที่ให้ใช้ชั่วโมงสะสมแทน)
 */
export function payOf(person, rate = DEFAULT_RATE, settings = DEFAULT_SETTINGS) {
  const amount = num(Number(rate?.amount));
  const monthly = rate?.mode === 'monthly';
  const hoursPerDay = num(Number(settings?.hoursPerDay)) || DEFAULT_SETTINGS.hoursPerDay;
  const otMultiplier = num(Number(settings?.otMultiplier));

  const paidDays = person.workDays + person.paidLeaveDays;
  const dailyRate = monthly ? amount / MONTH_DAYS : amount;
  const hourRate = dailyRate / hoursPerDay;

  const base = monthly ? amount : paidDays * dailyRate;
  const unpaidCut = monthly ? person.unpaidDays * dailyRate : 0;
  const otPay = person.otHours * hourRate * otMultiplier;
  const lateCut = settings?.deductLate ? (person.lateMinutes * hourRate) / 60 : 0;

  return {
    paidDays,
    dailyRate: round2(dailyRate),
    base: round2(base),
    unpaidCut: round2(unpaidCut),
    otPay: round2(otPay),
    lateCut: round2(lateCut),
    net: round2(base - unpaidCut + otPay - lateCut),
  };
}

// ---------------------------------------------------------------------------
// ค่าแรงที่กรอกไว้ — เก็บในเบราว์เซอร์ของเครื่องที่กรอก (ยังไม่มีที่เก็บกลาง)
//
// เก็บแยกตามรหัสพนักงาน { [รหัส]: { amount, mode } } ใครเปิดรายงานจากเครื่องอื่น
// จะยังไม่เห็นค่าแรงชุดนี้ — หน้ารายงานบอกไว้ให้รู้ พร้อมปุ่มนำเข้า/ส่งออกไฟล์
// ---------------------------------------------------------------------------

export const RATES_KEY = 'narai.payroll.rates.v1';
export const SETTINGS_KEY = 'narai.payroll.settings.v1';

/** อ่านค่าจาก localStorage แบบไม่ให้พังตอน render ฝั่งเซิร์ฟเวอร์ หรือตอนค่าที่เก็บไว้เสีย */
function readStore(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;   // โหมดส่วนตัว/พื้นที่เต็ม — กรอกต่อได้ แค่ไม่ถูกจำไว้รอบหน้า
  }
}

export const loadRates = () => readStore(RATES_KEY, {});
export const saveRates = (rates) => writeStore(RATES_KEY, rates);
export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...readStore(SETTINGS_KEY, {}) });
export const saveSettings = (settings) => writeStore(SETTINGS_KEY, settings);

/** ค่าแรงของคนหนึ่ง — ยังไม่ได้กรอกก็คืนค่าเริ่มต้น (0 บาท รายวัน) */
export const rateOf = (rates, empCode) => ({ ...DEFAULT_RATE, ...(rates?.[empCode] || {}) });
