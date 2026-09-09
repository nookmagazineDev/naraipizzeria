// ทะเบียนสาขา (dbo.hr_branch) — ตรรกะฝั่ง SQL ที่ใช้ร่วมกันสองฝั่ง
//
// แนวเดียวกับ lib/sheetsSql.mjs และ lib/scanEditSql.mjs — ไฟล์นี้ไม่รู้จักวิธีต่อฐาน
// รับ "ตัวยิงคำสั่ง" (q) เข้ามาแล้วคืนชุดฟังก์ชันให้ จึงใช้ได้ทั้ง:
//   lib/sheetsSource.js      ฝั่ง Vercel ที่ต่อ SQL ตรง (pool ใน lib/qcrdPool.js)
//   host-server/sheets-db.js ฝั่งเครื่องออฟฟิศ ที่เปิดเป็น endpoint /sheets/branch* ให้เรียกผ่าน tunnel
//
// ทำไมต้องมีสองทาง: ที่ร้าน SQL ไม่ได้เปิดพอร์ตออกเน็ต Vercel จึงต่อตรงไม่ติด
// ถ้ามีแต่ทางต่อตรง หน้า "จัดการสาขา" จะอ่านไม่ได้/บันทึกไม่ได้เลย (อาการที่เจออยู่)
//
// โครงตารางอยู่ใน docs/schema-hr-branch.sql
import { normalizeCode, normalizeOutletId, validateCode, STATUS_ACTIVE, STATUS_INACTIVE, sortBranches } from './branchCore.mjs';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** แถวในฐาน -> รูปแบบที่หน้าเว็บใช้ (ต้องตรงกับที่ /api/branches เคยคืน ทุกช่อง) */
const rowToBranch = (r) => ({
  code: normalizeCode(r.branch_code),
  name: str(r.branch_name),
  outletId: normalizeOutletId(r.outlet_id),
  status: str(r.status) || STATUS_ACTIVE,
  note: str(r.note),
  sortOrder: Number(r.sort_order) || 0,
});

/**
 * @param db.q ยิง query: (text, params) => rows
 * คืน: readBranches + actions (saveBranch / deleteBranch)
 */
export function createBranches({ q }) {
  async function readBranches() {
    const rows = await q(
      `SELECT branch_code, branch_name, outlet_id, status, note, sort_order
         FROM dbo.hr_branch`
    );
    return sortBranches(rows.map(rowToBranch));
  }

  /**
   * เพิ่มหรือแก้สาขาหนึ่งตัว — รหัสสาขาเป็นคีย์ แก้รหัสไม่ได้
   * (รหัสนี้ถูกอ้างในตารางงาน ข้อมูลสแกนหน้า ค่าใช้จ่าย และคอลัมน์ "สาขาที่ใช้" ของวัตถุดิบ
   *  เปลี่ยนที่ทะเบียนที่เดียวจะทำให้ข้อมูลเก่ากำพร้าทันที — จะเปลี่ยนจริงให้เพิ่มตัวใหม่แล้วปิดตัวเก่า)
   */
  async function saveBranch(body) {
    const code = normalizeCode(body?.code);
    const bad = validateCode(code);
    if (bad) throw Object.assign(new Error(bad), { badRequest: true });

    const outletId = normalizeOutletId(body?.outletId);
    if (str(body?.outletId) && outletId === null) {
      throw Object.assign(
        new Error('รหัสร้าน POS ต้องเป็นจำนวนเต็มบวก (เว้นว่างได้ถ้ายังไม่ได้เลขมา)'),
        { badRequest: true });
    }
    const status = str(body?.status) === STATUS_INACTIVE ? STATUS_INACTIVE : STATUS_ACTIVE;

    await q(
      `MERGE dbo.hr_branch AS t
       USING (SELECT @code AS branch_code) AS s
          ON t.branch_code = s.branch_code
       WHEN MATCHED THEN UPDATE SET
          branch_name = @name, outlet_id = @outletId, status = @status,
          note = @note, sort_order = @sortOrder, updated_at = SYSDATETIME()
       WHEN NOT MATCHED THEN
          INSERT (branch_code, branch_name, outlet_id, status, note, sort_order)
          VALUES (@code, @name, @outletId, @status, @note, @sortOrder);`,
      {
        code,
        name: str(body?.name),
        outletId,
        status,
        note: str(body?.note),
        sortOrder: Number(body?.sortOrder) || 0,
      }
    );
    return { code };
  }

  async function deleteBranch(body) {
    const code = normalizeCode(body?.code);
    if (!code) throw Object.assign(new Error('ต้องระบุรหัสสาขาที่จะลบ'), { badRequest: true });
    const rows = await q(
      'DELETE FROM dbo.hr_branch OUTPUT deleted.branch_code AS code WHERE branch_code = @code',
      { code }
    );
    if (!rows.length) {
      throw Object.assign(new Error(`ไม่พบสาขา ${code} ในทะเบียน`), { badRequest: true });
    }
    return { code };
  }

  return { readBranches, actions: { saveBranch, deleteBranch } };
}
