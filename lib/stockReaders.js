// ตัวอ่านข้อมูลหน้าสต๊อกจาก SQL — ใช้ร่วมกันระหว่าง /api/stock-read (GET) กับ /api/stock-gas (POST)
//
// action ชื่อเดียวกับ Apps Script เดิม และคืนรูปเดียวกับที่หน้าเว็บใช้อยู่ หน้าเว็บจึงไม่ต้องแก้อะไร
// ชีทของ Apps Script หยุดอัปเดตตั้งแต่สาขาย้ายไปนับ/เบิกบน SQL (lib/stockCountSql.mjs)
//   getStockItems        รายการนับ + ยอดยกมา + ใบเบิกล่าสุดของสาขา
//   getStockTotal        ยอดคงเหลือรวมทุกสาขา
//   getBranches          ทะเบียนสาขา dbo.hr_branch (ตัวเดียวกับ dropdown สาขาทุกหน้า)
//                        name = รหัสสาขาตัวพิมพ์เล็ก — คีย์เดียวกับที่ stock_count/stock_request เก็บ
//   getScheduleEmployees narai_hr.dbo.hr_employee ของสาขานั้น (ตารางเดียวกับหน้ารายชื่อพนักงาน)
import { readStockItems, readStockTotal, readBranchRegistry, readEmployees } from './sheetsSource';
import { STATUS_INACTIVE } from './branchCore.mjs';

/** พนักงานที่ออกไปแล้ว — ไม่ขึ้นในรายชื่อผู้นับ/ผู้เบิก */
const LEFT_STATUS = /ลาออก|พ้นสภาพ|resign|inactive/i;

const text = (v) => String(v ?? '').trim();

export const STOCK_SQL_READERS = {
  getStockItems: (q) => readStockItems(text(q.branch).toLowerCase()),
  getStockTotal: (q) => readStockTotal(text(q.endDate)),
  getBranches: async () => (await readBranchRegistry())
    .filter((b) => b.status !== STATUS_INACTIVE)
    .map((b) => ({ name: b.code.toLowerCase(), outletId: b.outletId || '' })),
  getScheduleEmployees: async (q) => {
    const branch = text(q.branch).toUpperCase();
    return (await readEmployees())
      .filter((e) => e.branch === branch && e.fullName && !LEFT_STATUS.test(e.status))
      .map((e) => ({ name: e.fullName, code: e.hrCode }));
  },
};

/** ข้อความ error เดียวกันทั้งสองเส้น — อ่านฐานไม่ได้ ไม่ถอยไปอ่านชีทเก่า */
export const stockSqlError = (err) =>
  `อ่านข้อมูลสต๊อกจากฐานข้อมูลไม่ได้ (${err.message}) — ตรวจว่าเครื่องออฟฟิศต่อฐานได้ แล้วโหลดใหม่`;
