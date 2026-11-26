// ค่าแรงของช่วงวันที่ — การ์ด "ค่าแรงรวม" และหน้ารายละเอียดค่าแรงในหน้า "ดูสแกนหน้า"
//
// ค่าแรงไม่ได้คิดใหม่ที่นี่ ใช้ช่อง wage ของแต่ละแถวใน dbo.hr_timesheet ตรง ๆ
// (ค่าที่หน้าลงตารางรายสัปดาห์ของสาขาคิดด้วย calculateCellWage แล้วบันทึกไว้ — ออฟฟิศแก้ตารางงาน
//  จากหน้านี้ office-server ก็คิดใหม่ด้วยสูตรเดียวกัน ดู cellWage ใน Narai-branch/office-server/schedule.js)
// ยอดจึงตรงกับ "ค่าแรงรวม" ที่สาขาเห็นในหน้าลงตาราง ยกเว้นข้อเดียว:
//   หน้าสาขาเผื่อค่าแรงเต็มวันให้ F/T ในวันที่ "ยังไม่ได้ลงกะ" ด้วย (กันยอดสัปดาห์ที่ยังลงไม่ครบดูต่ำ)
//   ที่นี่นับเฉพาะช่องที่ลงไว้จริง — งวดที่ลงตารางครบแล้วยอดเท่ากัน
//
// ⚠️ ไฟล์นี้ใช้จากหน้าเว็บ ห้าม import โมดูลของ Node

const text = (v) => String(v ?? '').trim();

/** ประเภทพนักงาน 4 แบบที่แยกในหน้ารายละเอียด เรียงตามลำดับนี้เสมอ */
export const LABOR_TYPES = ['F/T', 'P/T', 'DAY', 'DAY9'];
export const OTHER_TYPE = 'อื่นๆ';

/** 'f/t' · 'FT' · 'รายเดือน' -> 'F/T' · 'day 9' -> 'DAY9' · ว่าง/ไม่รู้จัก -> 'อื่นๆ' */
export function laborTypeOf(empType) {
  const raw = text(empType);
  const s = raw.toUpperCase().replace(/[\s.\-/]/g, '');
  if (s === 'DAY9') return 'DAY9';
  if (s.startsWith('FT') || s.includes('FULL') || raw.includes('รายเดือน')) return 'F/T';
  if (s.startsWith('PT') || s.includes('PART') || raw.includes('พาร์ท')) return 'P/T';
  if (s.startsWith('DAY') || raw.includes('รายวัน')) return 'DAY';
  return OTHER_TYPE;
}

/** แถวที่สาขากด "ล้างข้อมูล" — หน้าสาขาไม่แสดงและไม่นับ */
export const isClearedRow = (r) => text(r?.otherNote) === 'ล้างข้อมูล';

/** ค่าแรงของแถว (บาท) — '1,250.50' / 1250.5 / '' ได้ตัวเลขเสมอ */
export const wageOf = (r) => {
  const n = Number(text(r?.wage).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * วันนี้ "มาทำงาน" ไหม — นับแบบเดียวกับจำนวนคนต่อวันในหน้าลงตารางของสาขา
 * (มีเวลาเข้างาน และไม่ใช่วันหยุด/วันลา)
 */
export const isWorkedRow = (r) =>
  !isClearedRow(r) && Boolean(text(r?.checkIn)) &&
  text(r?.status) !== 'หยุด' && !text(r?.leaveNote) && !text(r?.unpaidLeave);

const dayOf = (r) => String(r?.workDate || '').slice(0, 10);
const personKey = (r) => text(r?.hrCode) || `name:${text(r?.name)}`;

/** ถังสะสม คน · วันทำงาน · ค่าแรง */
const bucket = () => ({ people: new Set(), days: 0, wage: 0 });
const addTo = (b, key, worked, wage) => {
  if (worked || wage > 0) b.people.add(key);
  if (worked) b.days += 1;
  b.wage += wage;
};
const out = (b) => ({ people: b.people.size, days: b.days, wage: Math.round(b.wage * 100) / 100 });

/**
 * สรุปค่าแรงจากแถวตารางงาน (ข้อมูลเดียวกับที่หน้าดูสแกนหน้าดึงมาเทียบ — /api/hr-schedule)
 *
 * คนที่ถูกนับ = มีวันทำงาน หรือได้ค่าแรงในช่วงนั้น (คนที่มีแต่วันหยุดไม่รับค่าแรงไม่นับ)
 * คนเดียวกันอยู่สองตำแหน่ง/สองประเภทในงวดเดียว (ย้ายตำแหน่งกลางงวด) จะถูกนับในทั้งสองแถว
 * ยอดรวม "คน" ด้านบนจึงนับคนไม่ซ้ำแยกต่างหาก ไม่ได้เอาแถวมาบวกกัน
 *
 * @returns {{
 *   wage:number, people:number, days:number,
 *   byDate: Object<string,{wage:number, staff:number}>,
 *   byType: Array<{type, people, days, wage}>,
 *   byPosition: Array<{position, people, days, wage, types:Array<{type, people, days, wage}>}>
 * }}
 */
export function summarizeLabor(scheduleRows, { start = '', end = '' } = {}) {
  const total = bucket();
  const byDate = new Map();
  const byType = new Map();
  const byPos = new Map();

  for (const r of scheduleRows || []) {
    if (isClearedRow(r)) continue;
    const date = dayOf(r);
    if (!date || (start && date < start) || (end && date > end)) continue;

    const key = personKey(r);
    const worked = isWorkedRow(r);
    const wage = wageOf(r);
    const type = laborTypeOf(r.empType);
    const position = text(r.position) || 'ไม่ระบุตำแหน่ง';

    addTo(total, key, worked, wage);

    if (!byDate.has(date)) byDate.set(date, bucket());
    addTo(byDate.get(date), key, worked, wage);

    if (!byType.has(type)) byType.set(type, bucket());
    addTo(byType.get(type), key, worked, wage);

    if (!byPos.has(position)) byPos.set(position, { all: bucket(), types: new Map() });
    const p = byPos.get(position);
    addTo(p.all, key, worked, wage);
    if (!p.types.has(type)) p.types.set(type, bucket());
    addTo(p.types.get(type), key, worked, wage);
  }

  const typeOrder = (t) => {
    const i = LABOR_TYPES.indexOf(t);
    return i < 0 ? LABOR_TYPES.length : i;
  };
  const typeList = (m) => [...m.entries()]
    .map(([type, b]) => ({ type, ...out(b) }))
    .filter((t) => t.people > 0 || t.wage !== 0)
    .sort((a, b) => typeOrder(a.type) - typeOrder(b.type));

  const dates = {};
  for (const [d, b] of byDate) {
    dates[d] = { wage: Math.round(b.wage * 100) / 100, staff: b.days };
  }

  return {
    ...out(total),
    byDate: dates,
    byType: typeList(byType),
    byPosition: [...byPos.entries()]
      .map(([position, p]) => ({ position, ...out(p.all), types: typeList(p.types) }))
      .filter((p) => p.people > 0 || p.wage !== 0)
      .sort((a, b) => b.wage - a.wage || a.position.localeCompare(b.position, 'th')),
  };
}

/**
 * ช่องหนึ่งช่องในตารางการทำงาน (คน x วัน) — ข้อความสั้น + ชนิดไว้เลือกสี
 *   kind: 'work' | 'off' | 'paidLeave' | 'unpaidLeave' | ''
 */
export function scheduleCellOf(r) {
  if (!r || isClearedRow(r)) return { text: '', kind: '' };
  const code = (v) => text(v).split(/\s+/)[0];
  if (text(r.unpaidLeave)) return { text: code(r.unpaidLeave), kind: 'unpaidLeave', title: text(r.unpaidLeave) };
  if (text(r.leaveNote)) return { text: code(r.leaveNote), kind: 'paidLeave', title: text(r.leaveNote) };
  if (text(r.status) === 'หยุด' || !text(r.checkIn)) return { text: 'หยุด', kind: 'off', title: 'หยุด' };
  const span = `${text(r.checkIn)}${text(r.checkOut) ? `–${text(r.checkOut)}` : ''}`;
  return { text: text(r.checkIn), kind: 'work', title: span };
}

/** วันทุกวันในช่วง 'YYYY-MM-DD'..'YYYY-MM-DD' (รวมหัวท้าย) */
export function daysBetween(start, end) {
  const list = [];
  if (!start || !end || start > end) return list;
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last && list.length < 400) {
    list.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return list;
}

/** วันในสัปดาห์ของ 'YYYY-MM-DD' (0 = อาทิตย์) — ไม่ขึ้นกับเขตเวลาของเครื่อง */
export const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/**
 * จัดวันในช่วงเป็นสัปดาห์ จันทร์–อาทิตย์ สำหรับปฏิทินยอดขายรายวัน
 * วันนอกช่วง (หัว/ท้ายสัปดาห์แรกและสุดท้าย) เป็น null
 */
export function weeksOf(start, end) {
  const days = daysBetween(start, end);
  if (!days.length) return [];
  const weeks = [];
  let week = new Array((weekdayOf(days[0]) + 6) % 7).fill(null);
  for (const d of days) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length) weeks.push([...week, ...new Array(7 - week.length).fill(null)]);
  return weeks;
}
