// ตรรกะรายชื่อพนักงานบน dbo.hr_employee (ฐาน narai_hr) — ชุดเดียวกันทั้งฝั่ง Vercel และ host-server
//
// รูปแบบเดียวกับ lib/sheetsSql.mjs: ไฟล์นี้ไม่ต่อฐานเอง รับตัวยิง query เข้ามา
//   ฝั่ง Vercel  -> lib/hrEmployee.mjs ผูกกับ pool ที่ต่อ SQL ตรง (lib/qcrdPool.js)
//   ฝั่งออฟฟิศ   -> host-server/hr-db.js ผูกกับ pool ที่ต่อ localhost
// ตรรกะจึงเป็นชุดเดียวกันเป๊ะ ไม่ว่าจะเดินทางไหน
//
// ตารางนี้เป็นตัวเดียวกับที่ Narai-branch ใช้ลงตารางงาน (hr_timesheet อ้าง hr_code ตารางนี้)
// คอลัมน์ที่รีโปนี้เพิ่มเข้าไป + วิธีย้ายข้อมูลจากตารางเก่า อยู่ใน docs/schema-hr-employee.sql

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** ค่าที่ฝั่งเว็บส่งมาเมื่อสั่งล้างช่องนั้นทิ้ง (คำเดียวกับที่ Narai-branch ใช้) */
const CLEAR_NOTE = 'ล้างข้อมูล';
const textOrNull = (v) => {
  const s = str(v);
  return s === '' || s === CLEAR_NOTE ? null : s;
};
const numOrZero = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const intOrZero = (v) => {
  const n = parseInt(String(v ?? '').replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};
/** resign_date เป็นชนิด DATE — รับเฉพาะ YYYY-MM-DD ไม่งั้นเก็บเป็นค่าว่าง */
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);

// รหัสสาขาที่ถือเป็นร้านเดียวกัน — ยกจาก office-server/hr-session.js ของ Narai-branch
// ใช้กับ "การอ่าน" เท่านั้น ข้อมูลเก่าถูกลงไว้ด้วยรหัสไหนก็ยังเห็นครบ
const BRANCH_ALIAS_GROUPS = [['zjp', 'sjp']];
export function branchGroup(code) {
  const b = str(code).toLowerCase();
  if (!b) return [];
  const hit = BRANCH_ALIAS_GROUPS.find((g) => g.includes(b));
  return hit ? [...hit] : [b];
}

// ลำดับตำแหน่งสำหรับเรียงพนักงานในตารางกะ — ยกจาก Narai-branch ทั้งชุด
const POSITION_PRIORITY = {
  'ผู้จัดการ': 1, 'ผู้จัดการ ฝึก': 2, 'ผู้จัดการฝึก': 2,
  'ผช.ผู้จัดการ': 3, 'ผช.ผู้จัดการ ฝึก': 4, 'ผช.ผู้จัดการฝึก': 4,
  'ซุปเปอร์ไวเซอร์': 5, 'Supervisor': 5, 'ซุปเปอร์ไวเซอร์ ฝึก': 6, 'ซุปเปอร์ไวเซอร์ฝึก': 6,
  'Pre.Sup': 7, 'แคชเชียร์': 8, 'บริการ': 9, 'หัวหน้ากุ๊ก': 10, 'กุ๊ก': 11, 'ล้างจาน': 12,
};
const positionPriority = (p) => POSITION_PRIORITY[str(p)] || 99;

/* ทุกคอลัมน์ที่หน้าเว็บแก้ได้ — ชื่อฟิลด์ฝั่งเว็บ -> ชื่อคอลัมน์ + ตัวแปลงค่า
   hr_code ไม่อยู่ในนี้เพราะเป็นคีย์ (ตารางงาน/ประวัติกะอ้างถึง เปลี่ยนแล้วประวัติจะขาด)
   updated_at ก็ไม่อยู่ เพราะตั้งให้เองทุกครั้งที่บันทึก */
const EDITABLE = {
  fullName:   ['full_name',  (v) => str(v)],
  branch:     ['branch',     (v) => str(v)],
  type:       ['emp_type',   textOrNull],
  status:     ['status',     (v) => str(v) || 'ทำงาน'],
  position:   ['position',   textOrNull],
  dailyWage:  ['daily_wage', numOrZero],
  resignDate: ['resign_date', dateOrNull],
  startDate:  ['start_date', textOrNull],
  loga:       ['loga',       textOrNull],
  newCode:    ['new_code',   textOrNull],
  photoUrl:   ['photo_url',  textOrNull],
  sortOrder:  ['sort_order', intOrZero],
};

/** ชื่อฟิลด์ทั้งหมดที่แก้ได้ — หน้าเว็บ/ข้อความ error เอาไปใช้ต่อได้ */
export const EDITABLE_FIELDS = Object.keys(EDITABLE);


/**
 * @param db.q  ยิง query: (text, params) => rows
 * คืน: readEmployees / readScheduleEmployees / saveEmployee + actions (ชื่อเดียวกับฝั่ง host API)
 */
export function createHrEmployee({ q }) {
  const SELECT_COLUMNS = `hr_code, full_name, branch, emp_type, status, position,
         daily_wage, resign_date, start_date, loga, new_code, photo_url, sort_order`;

  const toEmployee = (r) => ({
    hrCode: str(r.hr_code),
    fullName: str(r.full_name),
    branch: str(r.branch),
    type: str(r.emp_type),
    status: str(r.status),
    position: str(r.position),
    dailyWage: Number(r.daily_wage ?? 0),
    // ส่งเป็น YYYY-MM-DD ให้ตรงกับที่ช่องกรอกวันที่ในหน้าเว็บใช้
    resignDate: r.resign_date ? new Date(r.resign_date).toISOString().slice(0, 10) : '',
    startDate: str(r.start_date),
    loga: str(r.loga),
    newCode: str(r.new_code),
    photoUrl: str(r.photo_url),
    sortOrder: Number(r.sort_order ?? 0),
  });

  /* ─────────────────────────── อ่าน ─────────────────────────── */

  /** รายชื่อทั้งหมด (หน้ารายชื่อพนักงาน) — ส่งทุกคอลัมน์ที่แก้ได้กลับไปด้วย */
  async function readEmployees() {
    const rows = await q(
      `SELECT ${SELECT_COLUMNS} FROM dbo.hr_employee ORDER BY sort_order, hr_code`);
    return rows.map(toEmployee);
  }

  /**
   * พนักงานที่ยังทำงานอยู่ของสาขาหนึ่ง (dropdown ชื่อผู้นับสต๊อก/ผู้เบิก ในหน้านับสต๊อก)
   * คืนรูปเดียวกับ action getScheduleEmployees ของ Narai-branch เป๊ะ หน้าเว็บจึงใช้ต่อได้เลย
   */
  async function readScheduleEmployees(branch) {
    const group = branchGroup(branch);
    if (group.length === 0) return [];
    const params = {};
    const names = group.map((b, i) => { params[`brg${i}`] = b; return `@brg${i}`; });
    const rows = await q(
      `SELECT hr_code, full_name, branch, emp_type, position, daily_wage
         FROM dbo.hr_employee
        WHERE branch IN (${names.join(', ')}) AND status = N'ทำงาน'`, params);
    return rows
      .map((r) => ({
        hrCode: str(r.hr_code),
        name: str(r.full_name),
        branch: str(r.branch),
        type: str(r.emp_type),
        empType: str(r.emp_type),  // ชื่อเดิมของฟิลด์ เผื่อหน้าที่ยังอ่านชื่อนี้อยู่
        position: str(r.position),
        dailyWage: Number(r.daily_wage ?? 0),
      }))
      .sort((a, b) => positionPriority(a.position) - positionPriority(b.position));
  }

  /* ─────────────────────────── เขียน ─────────────────────────── */

  /**
   * แก้ข้อมูลพนักงาน — เขียนเฉพาะฟิลด์ที่ส่งมา ฟิลด์อื่นไม่แตะ
   * คืน updated = จำนวนแถวที่คำสั่ง UPDATE โดนจริง (หน้าเว็บใช้ค่านี้ยืนยันว่าบันทึกติดจริง)
   */
  async function saveEmployee(body) {
    const hrCode = str(body?.hrCode);
    if (!hrCode) throw Object.assign(new Error('ไม่ได้ระบุรหัสพนักงาน (hrCode)'), { badRequest: true });

    const sets = [];
    const params = { hr_code: hrCode };
    for (const [field, [column, cast]] of Object.entries(EDITABLE)) {
      if (body[field] === undefined) continue;
      sets.push(`${column} = @${column}`);
      params[column] = cast(body[field]);
    }
    if (!sets.length) return { hrCode, updated: 0, note: 'ไม่มีฟิลด์ที่ต้องแก้' };

    const rows = await q(
      `UPDATE dbo.hr_employee SET ${sets.join(', ')}, updated_at = SYSDATETIME() WHERE hr_code = @hr_code;
       SELECT @@ROWCOUNT AS n;`, params);
    const updated = Number(rows[0]?.n) || 0;
    if (!updated) {
      throw Object.assign(new Error(`ไม่พบพนักงานรหัส ${hrCode} ในฐานข้อมูล`), { badRequest: true });
    }
    return { hrCode, updated, fields: sets.length };
  }

  const ACTIONS = { saveEmployee };

  return { readEmployees, readScheduleEmployees, saveEmployee, actions: ACTIONS };
}
