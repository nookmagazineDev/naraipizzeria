// รายชื่อพนักงานฝั่ง Vercel — ยึด dbo.hr_employee ในฐาน narai_hr ที่เดียว
//
// เดิมรีโปนี้อ่าน/เขียน InventoryNarai.dbo.hr_employee ซึ่งเป็นคนละตารางกับที่ Narai-branch ใช้
// (narai_hr.dbo.hr_employee ตัวที่ตารางงาน/ประวัติกะอ้าง hr_code อยู่) รายชื่อจึงแยกกันสองชุด
// ย้ายมารวมที่ narai_hr แล้ว — คอลัมน์ที่เพิ่มกับวิธีย้ายข้อมูลอยู่ใน docs/schema-hr-employee.sql
//
// สองทางไปถึงฐาน ลองตามลำดับเดียวกับข้อมูลชุดอื่นของโปรเจกต์ (ดู lib/sheetsSource.js):
//   1) ต่อ SQL ตรงจาก Vercel — ใช้เมื่อมีรหัสฐานใน env (QCRD_DB_/ZK_DB_/HR_DB_USER+PASSWORD)
//   2) host API /hr/* (host-server/hr-db.js) — สำหรับตอนที่ SQL ไม่ได้เปิดออกเน็ต
//      ตั้ง HR_API_BASE (ไม่ตั้ง = ใช้ SHEETS_API_BASE/QCRD_API_BASE/STORE_API_BASE)
//      ฝั่งเขียนต้องมี SHEETS_WRITE_KEY หรือ QCRD_WRITE_KEY ให้ตรงกับเครื่องโฮสต์
//
// ทั้งอ่านและเขียนยิงตารางเดียวกันเสมอ ไม่ว่าจะเดินทางไหน และไม่ถอยไปอ่านชีท/ฐานเก่า
// (อ่านที่หนึ่งแต่เขียนอีกที่หนึ่งคือต้นเหตุของอาการ "กดบันทึกขึ้นสำเร็จ แต่ข้อมูลไม่เปลี่ยน")
import { hrQuery, describeHrTarget, isConfigured as hasDirectDb } from './qcrdPool';
import { createHrEmployee, EDITABLE_FIELDS } from './hrEmployeeSql.mjs';
import { STORE_API_BASE, WRITE_UPSTREAM_OPTS, fetchUpstream } from './upstream.mjs';

export { describeHrTarget, hasDirectDb, EDITABLE_FIELDS };

export const HR_API_BASE = (
  process.env.HR_API_BASE || process.env.SHEETS_API_BASE || process.env.QCRD_API_BASE || STORE_API_BASE
).replace(/\/+$/, '');

/** ทางที่จะใช้จริง — ไว้แนบท้ายข้อความ error ให้รู้ว่าไปพังตรงไหน */
export const hrRoute = () =>
  (hasDirectDb() ? `ต่อ SQL ตรง (${describeHrTarget()})` : `host API (${HR_API_BASE})`);

/** ตรรกะชุดเดียวกับที่ host-server ใช้ ผูกกับ pool ที่ต่อ SQL ตรง */
const direct = createHrEmployee({ q: hrQuery });

async function getFromHost(path, { timeoutMs = 20000 } = {}) {
  // อ่านอย่างเดียว → ลองใหม่ได้ถ้า host API สะดุด
  const res = await fetchUpstream(`${HR_API_BASE}/hr/${path}`, { timeoutMs });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    throw new Error(
      `host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server ที่เครื่องออฟฟิศรันอยู่ไหม ` +
      'และเป็นเวอร์ชันที่มี /hr/* แล้วหรือยัง (git pull แล้วรีสตาร์ท)');
  }
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

async function postToHost(body, { timeoutMs = 60000 } = {}) {
  const key = process.env.SHEETS_WRITE_KEY || process.env.QCRD_WRITE_KEY || '';
  if (!key) {
    throw new Error(
      'ยังเขียนข้อมูลพนักงานไม่ได้ — ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (ต่อ SQL ตรง) ' +
      'หรือ SHEETS_WRITE_KEY/QCRD_WRITE_KEY ให้ตรงกับเครื่องโฮสต์ (ผ่าน host API) อย่างใดอย่างหนึ่งบน Vercel');
  }
  // คำสั่งเขียน — ห้ามลองใหม่อัตโนมัติ (คำสั่งอาจถึงปลายทางแล้วแต่คำตอบหายกลางทาง = เขียนซ้ำ)
  const res = await fetchUpstream(`${HR_API_BASE}/hr/save`, {
    ...WRITE_UPSTREAM_OPTS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
    timeoutMs,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

/** รายชื่อทั้งหมด พร้อมทุกคอลัมน์ที่หน้าเว็บแก้ได้ */
export const readEmployees = () =>
  (hasDirectDb() ? direct.readEmployees() : getFromHost('employee'));

/** พนักงานที่ยังทำงานอยู่ของสาขาหนึ่ง (dropdown ชื่อผู้นับสต๊อก/ผู้เบิก) */
export const readScheduleEmployees = (branch) =>
  (hasDirectDb()
    ? direct.readScheduleEmployees(branch)
    : getFromHost(`schedule-employees?branch=${encodeURIComponent(String(branch || ''))}`));

/** แก้ข้อมูลพนักงาน — ส่งเฉพาะฟิลด์ที่เปลี่ยน ฟิลด์อื่นไม่แตะ */
export const saveEmployee = (body) =>
  (hasDirectDb() ? direct.saveEmployee(body) : postToHost({ ...body, action: 'saveEmployee' }));
