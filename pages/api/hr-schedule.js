// ตารางงานที่สาขาลงไว้ (dbo.hr_timesheet ในฐานข้อมูล narai_hr) — ใช้คู่กับ /api/attendance
//
//   GET /api/hr-schedule?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา][&branches=a,b,c]
//   → { status:'success', start, end, from, branches, count, truncated, missing, data:[...], failed:[...] }
//
// ไม่ระบุสาขา = ดึงทุกสาขาที่มีในฐานข้อมูล HR (หน้า "ดูสแกนหน้า" ใช้ทางนี้ตอนเลือก "ทุกสาขา"
// เพราะสาขาที่หยุดทั้งสาขาจะไม่มีสแกนเลย ถ้าเดารายชื่อสาขาจากข้อมูลสแกนก็จะมองไม่เห็นวันหยุดนั้น)
// ระบุ branches มา = ดึงเฉพาะสาขาในรายการนั้น
//
// รหัสสาขาที่เครื่องสแกนส่งมา (area_alias) เป็นตัวพิมพ์ใหญ่ ส่วนในฐาน HR เก็บตามที่หน้าเว็บ
// ของสาขาใช้ (ตัวพิมพ์เล็ก) จึงเทียบแบบไม่สนตัวพิมพ์ แล้วส่งตัวสะกดที่เก็บจริงไปคิวรี่
import { fetchScheduleBranches, fetchTimesheet, fetchTimesheetMany } from '../../lib/hrSchedule';
// ตัวช่วยชุดเดียวกับ /api/attendance — ทั้งสองฝั่งของหน้า "ดูสแกนหน้า" เจอปัญหาเพดานแถวเหมือนกัน
import { capByDay, missingDates, dayOf, inRange } from '../../lib/dateRange';
import { branchAliasMap } from '../../lib/branchRegistry';

// ยิงทีละสาขาหลายรอบ — เผื่อเวลาให้พอเหมือน /api/attendance
export const config = { maxDuration: 60 };

// เพดานเดียวกับ ZK_ROW_CAP ของ /api/attendance — ทุกสาขา x ทั้งเดือนได้หลักหมื่นแถว
// ถ้าปล่อยไม่จำกัด หน้าเว็บต้องวาดตารางใหญ่มากจนหน่วง ชนเพดานเมื่อไหร่ = ช่วงวันที่กว้างเกิน
//
// เวลาตัดต้องตัด "ทั้งวัน" จากวันเก่าสุด (capByDay) — แถวที่ได้มาเรียงตามลำดับที่สาขาไหน
// ตอบก่อน การตัดดื้อๆ ด้วย slice จึงเท่ากับทำ "บางสาขา" หายไปทั้งสาขาแบบสุ่ม
const ROW_CAP = 20000;

const txt = (v) => (v == null ? '' : String(v).trim());
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** วันของแถวตารางงาน — workDate อาจมาเป็น '2026-09-15' หรือ '2026-09-15T00:00:00.000Z' */
const rowDate = (r) => dayOf(r.workDate);

/** แถวที่สาขากด "ล้างข้อมูล" ทิ้งไว้ — หน้าเว็บไม่แสดง จึงไม่นับว่าวันนั้นมีตารางงาน */
const isCleared = (r) => txt(r.otherNote) === 'ล้างข้อมูล';

/** 'SJP,crm' -> ['SJP','crm'] (ตัดค่าว่างและตัวซ้ำทิ้ง) */
const splitList = (v) => [...new Set(txt(v).split(',').map((s) => s.trim()).filter(Boolean))];

/**
 * ใส่รหัสพ้องของสาขาที่ขอเข้าไปด้วย — สาขาเดียวกันอาจลงตารางไว้ทั้งสองชื่อ
 * (เช่น SJP: เครื่องสแกน/ทะเบียนใช้ SJP แต่หน้าเว็บสาขาล็อกอินด้วย zjp) ขอ SJP ต้องได้ zjp มาด้วย และกลับกัน
 */
function withAliasBranches(wanted, aliasTo) {
  const canonOf = (c) => aliasTo[c.toLowerCase()] || c.toLowerCase();
  const groups = new Set(wanted.map(canonOf));
  const extra = Object.keys(aliasTo).filter((a) => groups.has(aliasTo[a]));
  return [...new Set([...wanted, ...groups, ...extra])];
}

/** ความครบของแถวตารางงาน — ไว้เลือกตัวที่จะเก็บเมื่อคนเดียวกันมีสองแถวในวันเดียว */
const rowScore = (r) => (isCleared(r) ? 0 : 2) +
  (txt(r.checkIn) || txt(r.leaveNote) || txt(r.unpaidLeave) || txt(r.status) ? 1 : 0);

/**
 * รหัสพ้อง -> รหัสจริง แล้วตัดแถวซ้ำ: วันเดียวกัน รหัสพนักงานเดียวกัน ในสาขาเดียวกัน = คนเดียวกัน
 * (เช่นลงไว้ทั้งใน sjp และ zjp) เก็บแถวที่ครบกว่า ไม่งั้นหน้าเว็บขึ้นเป็นสองแถว/นับวันซ้ำ
 *
 * ครบเท่ากัน (เช่น แถวหนึ่ง "หยุด" อีกแถวมีเวลา) ให้แถวที่ลงไว้ใต้รหัสพ้องชนะ — รหัสพ้องคือชื่อที่สาขา
 * ใช้ล็อกอินหน้าลงตาราง (zjp) แถวใต้รหัสจริงเป็นของค้างที่สาขามองไม่เห็นและแก้ไม่ได้
 * เมื่อก่อนให้ "ตัวหลังชนะ" แต่ลำดับแถวขึ้นกับว่าสาขาไหนดึงเสร็จก่อน (fetchTimesheetMany ยิงพร้อมกัน)
 * ผลจึงสุ่ม และไม่ตรงกับตารางรายสัปดาห์ที่สาขาเห็น
 */
function mergeAliasRows(rows, aliasTo) {
  const keep = new Map();
  const out = [];
  const fromAlias = new Set();   // แถวที่มาจากรหัสพ้อง (ดูจาก branch เดิมก่อนแปลง)
  for (const r0 of rows) {
    const canon = aliasTo[txt(r0.branch).toLowerCase()];
    const r = canon ? { ...r0, branch: canon } : r0;
    if (canon) fromAlias.add(r);
    const code = txt(r.hrCode);
    if (!code) { out.push(r); continue; }
    const key = `${rowDate(r)}|${txt(r.branch).toLowerCase()}|${code}`;
    const seen = keep.get(key);
    if (seen === undefined) { keep.set(key, out.length); out.push(r); continue; }
    const prev = out[seen];
    const diff = rowScore(r) - rowScore(prev);
    // ครบเท่ากัน: รหัสพ้องชนะรหัสจริง · มาจากชื่อเดียวกันทั้งคู่ = ตัวหลังชนะ เหมือน byCode ใน attachSchedule
    if (diff > 0 || (diff === 0 && (fromAlias.has(r) || !fromAlias.has(prev)))) out[seen] = r;
  }
  return out;
}

/**
 * แปลงรหัสสาขาที่ผู้ใช้ส่งมา ให้เป็นตัวสะกดที่เก็บจริงในตาราง hr_branch
 * สาขาที่ไม่มีในฐาน HR (เช่นเครื่องสแกนตั้งชื่อ area ไว้คนละแบบ) จะถูกคัดออกและรายงานกลับไป
 */
function resolveBranches(wanted, known) {
  const byLower = new Map(known.map((b) => [b.name.toLowerCase(), b.name]));
  const resolved = [];
  const unknown = [];
  for (const w of wanted) {
    const hit = byLower.get(w.toLowerCase());
    if (hit) resolved.push(hit);
    else unknown.push(w);
  }
  return { resolved: [...new Set(resolved)], unknown };
}

export default async function handler(req, res) {
  const start = txt(req.query.start);
  const end = txt(req.query.end);
  const branch = txt(req.query.branch);
  const branches = splitList(req.query.branches);

  if (!start || !end) {
    return res.status(400).json({ status: 'error', message: 'ต้องระบุ start และ end' });
  }
  if (!isYmd(start) || !isYmd(end)) {
    return res.status(400).json({ status: 'error', message: 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD' });
  }
  if (start > end) {
    return res.status(400).json({ status: 'error', message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
  }

  try {
    const [known, aliasTo] = await Promise.all([
      fetchScheduleBranches(),
      branchAliasMap().catch(() => ({})),
    ]);
    const asked = branch ? [branch] : branches;
    const wanted = asked.length ? withAliasBranches(asked, aliasTo) : [];
    // ไม่ได้ระบุมาเลย = เอาทุกสาขาที่มีในฐาน HR
    const { resolved, unknown: notFound } = wanted.length
      ? resolveBranches(wanted, known)
      : { resolved: known.map((b) => b.name), unknown: [] };
    // รหัสพ้องที่เติมเข้าไปเองแล้วไม่มีในฐาน HR ไม่ใช่เรื่องที่ต้องเตือน — เตือนเฉพาะสาขาที่ขอมา
    // แล้วหาไม่เจอสักชื่อในกลุ่มเดียวกัน
    const canonOf = (c) => aliasTo[c.toLowerCase()] || c.toLowerCase();
    const found = new Set(resolved.map(canonOf));
    const unknown = notFound.filter((u) => asked.some((a) => a.toLowerCase() === u.toLowerCase()) && !found.has(canonOf(u)));

    if (resolved.length === 0) {
      return res.status(200).json({
        status: 'success',
        start, end,
        from: start,
        branches: [],
        unknown,
        count: 0,
        truncated: false,
        missing: [],
        failed: [],
        data: [],
      });
    }

    const { rows: raw, failed } = resolved.length === 1
      ? { rows: await fetchTimesheet({ branch: resolved[0], start, end }), failed: [] }
      : await fetchTimesheetMany({ branches: resolved, start, end });

    // ตัดให้เหลือเฉพาะวันที่ขอ — ตารางงานเก็บเป็นราย "สัปดาห์" ฝั่ง office-server จึงส่งวันที่
    // อยู่นอกช่วงติดมาได้ (ดู inRange ที่ lib/dateRange.js) ถ้าไม่ตัด หน้า "ดูสแกนหน้า" จะมีแถว
    // ของวันอื่นโผล่ขึ้นมาปนด้วย เพราะแถวตารางงานที่ไม่มีสแกนถูกดึงขึ้นตารางเองอยู่แล้ว
    const inside = raw.filter((r) => inRange(rowDate(r), start, end));
    if (inside.length !== raw.length) {
      console.warn(`hr-schedule: ต้นทางส่งวันนอกช่วง ${start}..${end} มา ${raw.length - inside.length} แถว — ตัดทิ้งแล้ว`);
    }
    const rows = mergeAliasRows(inside, aliasTo);

    // เรียงใหม่→เก่าก่อนตัด ไม่งั้น "วันเก่าสุด" ที่ capByDay จะตัด ไม่ใช่วันเก่าสุดจริงๆ
    // (แถวมาเรียงตามสาขาที่ตอบก่อน) — เรียงสาขา/ชื่อต่อท้ายให้ผลออกมาเหมือนเดิมทุกครั้ง
    rows.sort((a, b) =>
      rowDate(b).localeCompare(rowDate(a)) ||
      txt(a.branch).localeCompare(txt(b.branch)) ||
      txt(a.name).localeCompare(txt(b.name)));

    const { data, truncated, from } = capByDay(rows, ROW_CAP, rowDate);

    // วันที่ไม่มีตารางงานเลยสักสาขา — นับเฉพาะช่วงที่ส่งกลับไปจริง และไม่นับแถวที่ถูกล้างข้อมูล
    const missing = missingDates(data.filter((r) => !isCleared(r)), truncated ? from : start, end, rowDate);

    return res.status(200).json({
      status: 'success',
      start, end,
      from: truncated ? from : start,
      branches: resolved,
      unknown,
      count: data.length,
      truncated,
      missing,
      failed,
      ...(truncated
        ? { message: `ตารางงานเกิน ${ROW_CAP.toLocaleString()} แถว — แสดงตั้งแต่วันที่ ${from} ถึง ${end} เท่านั้น กรุณาแคบช่วงวันที่ลงหรือเลือกสาขา` }
        : {}),
      data,
    });
  } catch (err) {
    console.error('hr-schedule API error:', err.message);
    return res.status(502).json({
      status: 'error',
      code: 'HR_SCHEDULE_UNREACHABLE',
      message: err.message || 'ดึงตารางงานไม่สำเร็จ',
    });
  }
}
