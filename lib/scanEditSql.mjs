// ตรรกะฝั่ง SQL ของ "แก้เวลาสแกนนิ้วด้วยมือ" (ฐาน InventoryNarai — ตาราง dbo.attendance_edit)
//
// แนวเดียวกับ lib/sheetsSql.mjs และ lib/qcrdSql.mjs — ไฟล์นี้ไม่รู้ว่า "ต่อฐานยังไง"
// รับตัวยิง query (q) เข้ามาแล้วคืนชุดฟังก์ชันให้ จึงใช้ร่วมกันได้ทั้งสองฝั่ง:
//   lib/sheetsSource.js      ฝั่ง Vercel ที่ต่อ SQL ตรง (pool ใน lib/qcrdPool.js)
//   host-server/sheets-db.js ฝั่งเครื่องออฟฟิศ ที่เปิดเป็น /sheets/scan-edit ให้เรียกผ่าน tunnel
//
// จุดสำคัญของชุดนี้: การแก้เวลาเป็น "การบันทึกใหม่" ทุกครั้ง (INSERT อย่างเดียว ไม่มี UPDATE)
// เวลาที่ใช้จริงคือแถวล่าสุดของช่องนั้น แถวเก่าเก็บไว้เป็นประวัติ — เวลาสแกนเป็นฐานคิดค่าแรง
// จึงต้องย้อนดูได้เสมอว่าใครแก้อะไร จากเท่าไหร่เป็นเท่าไหร่ เมื่อไหร่
//
// ข้อมูลสแกนจริงใน ZKBio9 ไม่ถูกแตะ — ตารางนี้เป็นชั้นทับตอนแสดงผลเท่านั้น (ดู lib/attendance.js)

/** ช่องที่แก้ได้ — ตรงกับ SCAN_SLOTS ใน lib/attendance.js และ CHECK constraint ของตาราง */
export const EDIT_SLOTS = ['in', 'breakOut', 'breakIn', 'out'];

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const pad2 = (n) => String(n).padStart(2, '0');

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 'HH:mm' (รับ 'HH:mm:ss' มาด้วย ตัดวินาทีทิ้ง) — คืน '' ถ้าไม่ใช่เวลา */
export function hhmmOrEmpty(v) {
  const m = str(v).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${pad2(h)}:${pad2(mi)}`;
}

/** DATE จาก SQL -> 'YYYY-MM-DD' (mssql คืนมาเป็น Date ที่ตั้งเป็น UTC เที่ยงคืน) */
function ymd(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  return String(value).slice(0, 10);
}

/** DATETIME2 -> 'YYYY-MM-DD HH:mm' (เวลาที่กดบันทึก ไว้แสดงใน tooltip) */
function stamp(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${ymd(value)} ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}`;
  }
  return String(value).replace('T', ' ').slice(0, 16);
}

const badRequest = (message) => Object.assign(new Error(message), { badRequest: true });

/**
 * @param db.q  ยิง query: (text, params) => rows
 * คืน: readScanEdits / readScanEditHistory + actions.saveScanEdit
 */
export function createScanEdits({ q }) {
  /**
   * เวลาที่ถูกแก้ไว้ในช่วงวันที่หนึ่ง — คืนเฉพาะแถวล่าสุดของแต่ละ (วัน, พนักงาน, ช่อง)
   * ให้ฐานคัดมาให้เลยด้วย ROW_NUMBER จะได้ไม่ต้องลากประวัติทั้งหมดมาคัดข้างนอก
   */
  async function readScanEdits({ start, end, branch } = {}) {
    if (!isYmd(str(start)) || !isYmd(str(end))) throw badRequest('ต้องระบุช่วงวันที่ (start, end) เป็น YYYY-MM-DD');

    const params = { start: str(start), end: str(end) };
    let where = 'work_date >= @start AND work_date <= @end';
    if (str(branch)) {
      params.branch = str(branch).toUpperCase();
      where += ' AND UPPER(branch) = @branch';
    }

    const rows = await q(`
      SELECT edit_id, work_date, emp_code, slot, scan_time, old_time, emp_name, branch, note, edited_by, created_at
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY work_date, emp_code, slot ORDER BY edit_id DESC) AS rn
        FROM dbo.attendance_edit
        WHERE ${where}
      ) x
      WHERE rn = 1
      ORDER BY work_date DESC, emp_code, slot`, params);

    return rows.map(mapEdit);
  }

  /** ประวัติการแก้ของคนหนึ่งในวันหนึ่ง (ทุกครั้งที่กดบันทึก ใหม่ก่อน) */
  async function readScanEditHistory({ date, empCode } = {}) {
    if (!isYmd(str(date))) throw badRequest('ต้องระบุวันที่ (date) เป็น YYYY-MM-DD');
    if (!str(empCode)) throw badRequest('ต้องระบุรหัสพนักงาน (empCode)');
    const rows = await q(`
      SELECT edit_id, work_date, emp_code, slot, scan_time, old_time, emp_name, branch, note, edited_by, created_at
      FROM dbo.attendance_edit
      WHERE work_date = @date AND emp_code = @emp
      ORDER BY edit_id DESC`, { date: str(date), emp: str(empCode) });
    return rows.map(mapEdit);
  }

  /**
   * บันทึกการแก้หนึ่งช่อง — INSERT เสมอ (ไม่ทับแถวเดิม)
   * time = '' แปลว่า "ล้างค่าช่องนั้น" เก็บเป็น NULL
   */
  async function saveScanEdit(body) {
    const date = str(body?.date);
    const empCode = str(body?.empCode);
    const slot = str(body?.slot);
    const rawTime = str(body?.time);

    if (!isYmd(date)) throw badRequest('วันที่ (date) ต้องเป็นรูปแบบ YYYY-MM-DD');
    if (!empCode) throw badRequest('ไม่ได้ระบุรหัสพนักงาน (empCode)');
    if (!EDIT_SLOTS.includes(slot)) throw badRequest(`ช่องที่แก้ (slot) ต้องเป็น ${EDIT_SLOTS.join(' | ')}`);

    const time = rawTime ? hhmmOrEmpty(rawTime) : '';
    if (rawTime && !time) throw badRequest(`เวลา "${rawTime}" ไม่ถูกต้อง — ต้องเป็น HH:mm เช่น 11:30`);

    const rows = await q(`
      INSERT INTO dbo.attendance_edit (work_date, emp_code, slot, scan_time, old_time, emp_name, branch, note, edited_by)
      OUTPUT inserted.edit_id, inserted.work_date, inserted.emp_code, inserted.slot, inserted.scan_time,
             inserted.old_time, inserted.emp_name, inserted.branch, inserted.note, inserted.edited_by, inserted.created_at
      VALUES (@work_date, @emp_code, @slot, @scan_time, @old_time, @emp_name, @branch, @note, @edited_by)`, {
      work_date: date,
      emp_code: empCode,
      slot,
      scan_time: time || null,
      old_time: hhmmOrEmpty(body?.oldTime) || null,
      emp_name: str(body?.name) || null,
      branch: str(body?.branch).toUpperCase() || null,
      note: str(body?.note) || null,
      edited_by: str(body?.editedBy) || null,
    });

    return mapEdit(rows[0] || {});
  }

  return { readScanEdits, readScanEditHistory, actions: { saveScanEdit } };
}

/** แถวในตาราง -> รูปที่หน้าเว็บใช้ */
function mapEdit(r) {
  return {
    editId: Number(r.edit_id) || 0,
    date: ymd(r.work_date),
    empCode: str(r.emp_code),
    slot: str(r.slot),
    // ล้างค่าไว้ = '' (ไม่ใช่ null) หน้าเว็บจะได้เทียบกับช่องว่างได้ตรง ๆ
    time: str(r.scan_time),
    oldTime: str(r.old_time),
    name: str(r.emp_name),
    branch: str(r.branch),
    note: str(r.note),
    editedBy: str(r.edited_by),
    savedAt: stamp(r.created_at),
  };
}
