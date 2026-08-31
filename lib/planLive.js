// แพลนสินค้า (ข้อมูลสด) — อ่านใบสั่งของตรงจากฐานเดียวกับที่แอปสั่งของของสาขาเขียนลง
//
// ต้นทาง: MySQL inventory.dyndns.tv -> myfbdata.orderd (ใบสั่ง/ใบเบิกกลาง)
//   ตัวเดียวกับที่ narai-storefct ใช้ (nookmagazineDev/Narai-branch: api/insert_order.js)
//   ข้อมูลจึงตรงกันทันทีที่สาขากดสั่ง ไม่ต้องรอใครรันคัดลอกเข้าชีท/SQL Server เหมือนทางเดิม
//
// คอลัมน์ที่ใช้ (ชื่อตามตาราง POS)
//   Ord_OrdDate  วันที่สั่ง
//   Ord_DelDate  วันที่ส่งของ
//   Ord_Rcv      POS เติมค่าให้เมื่อบันทึกรับของแล้ว — ว่าง = ยังรอรับ
//   Ord_PostTime เวลาที่บันทึกใบ
//
// ⚠️ orderd มี ~2.2 ล้านแถวและไม่มี index ตามสาขา/วันที่ (ดู api/pending_orders.js ของแอปสาขา)
//    คิวรีที่ไม่จำกัดช่วงวันที่จะกวาดทั้งตาราง ห้ามเปิดให้ดึงทั้งหมด — ผู้เรียกต้องส่งช่วงวันที่มาเสมอ
import mysql from 'mysql2/promise';
import { FALLBACK_BRANCHES } from './branches';

// รหัสสาขาฝั่ง POS (Ord_StrID) -> ตัวย่อสาขา
// ยึดทะเบียนกลางเป็นหลัก แล้วเติมรหัสที่มีเฉพาะฝั่ง POS ซึ่งทะเบียนยังไม่มี
// (ชุดเดียวกับ DB_SUFFIX ในแอปสั่งของ — 950 fct คือสาขาที่หน้า storefct ใช้อยู่)
const POS_ONLY = { 55: 'STS', 902: 'HPS', 950: 'FCT' };
const BRANCH_BY_ID = {
  ...POS_ONLY,
  ...Object.fromEntries(FALLBACK_BRANCHES.map(b => [b.outletId, b.code])),
};

const str = v => (v === null || v === undefined ? '' : String(v).trim());
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

let pool;
function getPool() {
  if (!pool) {
    // ค่าเชื่อมต่อชุดเดียวกับ pages/api/orderd.js — ตั้งบน Vercel ไว้แล้ว ไม่ต้องเพิ่ม env ใหม่
    // connectTimeout ยาวกว่า default ของ Vercel ไม่งั้น function ถูกฆ่าก่อน MySQL จะ timeout
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'inventory.dyndns.tv',
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'myfbdata',
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
    });
  }
  return pool;
}

/** วันนี้ตามเวลาไทย (Vercel รันเป็น UTC) — YYYY-MM-DD */
export function bangkokToday() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 10);
}

/** เลื่อนวันแบบ YYYY-MM-DD */
export function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isISODate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * ใบสั่งของทุกสาขาในช่วงวันที่สั่ง [from, to]
 * คืนโครงเดียวกับที่ /api/plan เคยตอบจากชีท/SQL Server ทุกช่อง หน้า PlanList จึงใช้ต่อได้เลย
 * ของใหม่ที่เพิ่มมา: deliverDate (วันที่ส่ง) และ received (รับของแล้วหรือยัง)
 */
export async function readPlanLive({ from, to }) {
  if (!isISODate(from) || !isISODate(to)) throw new Error('ช่วงวันที่ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)');

  const [rows] = await getPool().query(
    `SELECT Ord_No, Ord_StrID, Ord_Seq,
            DATE_FORMAT(Ord_OrdDate, '%d/%m/%Y') AS orderDate,
            DATE_FORMAT(Ord_DelDate, '%Y-%m-%d') AS deliverDate,
            Ord_PostTime, Ord_ItmID, Ord_itemCode, Ord_ItemName,
            Ord_Qty, Ord_Unit, Ord_UnPr, Ord_Total, Ord_ReqType, Ord_Rcv
       FROM orderd
      WHERE Ord_OrdDate BETWEEN ? AND ?
      ORDER BY Ord_OrdDate, Ord_No, Ord_Seq`,
    [from, to]
  );

  return rows
    .map(r => ({
      orderDate: str(r.orderDate),                                  // DD/MM/YYYY — วันที่สั่ง
      recordTime: str(r.Ord_PostTime),
      branch: BRANCH_BY_ID[Number(r.Ord_StrID)] || `#${str(r.Ord_StrID)}`,
      outletId: str(r.Ord_StrID),
      orderNo: str(r.Ord_No),
      seq: str(r.Ord_Seq),
      // ชื่อช่องเดิมของหน้าเว็บคือ receiveDate — ฝั่ง POS คือ "วันที่ส่งของ" ตัวเดียวกัน
      receiveDate: str(r.deliverDate),                              // YYYY-MM-DD — วันที่ส่ง
      deliverDate: str(r.deliverDate),
      received: r.Ord_Rcv !== null && r.Ord_Rcv !== undefined && str(r.Ord_Rcv) !== '',
      itemId: str(r.Ord_ItmID),
      itemCode: str(r.Ord_itemCode),
      itemName: str(r.Ord_ItemName),
      qty: num(r.Ord_Qty),
      unit: str(r.Ord_Unit),
      unitPrice: num(r.Ord_UnPr),
      total: num(r.Ord_Total),
      type: str(r.Ord_ReqType),
      recordedBy: '',   // ฝั่ง POS ไม่ได้เก็บชื่อคนคีย์ (ช่อง Ord_Rmk* ถูกเว้นว่างไว้)
    }))
    .filter(r => r.itemCode);
}
