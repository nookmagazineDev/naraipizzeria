import { fetchScript } from '../../lib/upstream.mjs';
import { readScheduleEmployees, hrRoute } from '../../lib/hrEmployee.mjs';
// อ่านข้อมูลสต๊อกจาก Google Apps Script ผ่าน GET เพื่อให้ CDN/เบราว์เซอร์แคชได้
// (/api/stock-gas เป็น POST — CDN แคชไม่ได้ ทุกครั้งจึงต้องรอ Apps Script ใหม่ทุกรอบ)
// ใช้เฉพาะ action ที่เป็นการอ่านอย่างเดียว — การเขียน (saveStock ฯลฯ) ยังใช้ /api/stock-gas เหมือนเดิม
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

// action -> { params: พารามิเตอร์ที่ส่งต่อได้, sMaxAge: วินาทีที่ CDN ถือไว้ก่อน revalidate }
// รายชื่อสาขาแทบไม่เปลี่ยน เก็บได้ยาว / ยอดนับเปลี่ยนระหว่างวัน เก็บสั้นแล้วพึ่ง stale-while-revalidate
const READ_ACTIONS = {
  getBranches: { params: [], sMaxAge: 600 },
  getStockItems: { params: ['branch'], sMaxAge: 60 },
  getStockTotal: { params: ['endDate'], sMaxAge: 60 },
  getScheduleEmployees: { params: ['branch'], sMaxAge: 300 },
};

/**
 * รายชื่อพนักงานของสาขา (ผู้นับสต๊อก/ผู้เบิก) — อ่านจาก dbo.hr_employee ฐาน narai_hr
 * ตารางเดียวกับหน้ารายชื่อพนักงานและกับตารางงานของ Narai-branch ชื่อในดรอปดาวน์จึงตรงกันทุกที่
 *
 * ถอยไปอ่านชีทได้ถ้าฐานล่ม เพราะเป็นการอ่านล้วน (แค่เอาชื่อมาให้เลือก) — แนบ warning ไปด้วย
 * ฝั่งเขียนไม่มีการถอย (ดู /api/stock-gas) เพราะเขียนสองที่สลับกันแปลว่าข้อมูลจะไม่ตรงกันทันที
 */
async function scheduleEmployeesFromSql(branch) {
  const list = await readScheduleEmployees(branch);
  // ฐานยังว่าง = ยังไม่ได้ย้ายข้อมูลเข้ามา ให้ถอยไปชีทแทนการโชว์ดรอปดาวน์เปล่า
  if (!Array.isArray(list) || list.length === 0) throw new Error('ยังไม่มีรายชื่อพนักงานของสาขานี้ในฐานข้อมูล');
  return list;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'GET only' });
  }

  const { action } = req.query;
  const spec = READ_ACTIONS[action];
  if (!spec) {
    return res.status(400).json({ status: 'error', message: `action ไม่ถูกต้อง: ${action || '(ไม่ระบุ)'}` });
  }

  const payload = { action };
  spec.params.forEach(name => {
    if (req.query[name] !== undefined) payload[name] = req.query[name];
  });

  // พนักงานยึดฐาน narai_hr เป็นหลัก — ชีทเป็นแค่ทางถอยเวลาต่อฐานไม่ได้
  let sqlWarning = '';
  if (action === 'getScheduleEmployees') {
    try {
      const data = await scheduleEmployeesFromSql(payload.branch);
      res.setHeader('Cache-Control', `public, s-maxage=${spec.sMaxAge}, stale-while-revalidate=3600`);
      return res.status(200).json({ status: 'success', source: 'sql', data });
    } catch (err) {
      console.error(`stock-read: อ่านพนักงานจาก SQL ไม่ได้ (${hrRoute()}) — ถอยไปอ่านชีท:`, err.message);
      sqlWarning = `อ่านรายชื่อพนักงานจากฐานข้อมูลไม่ได้ (${err.message}) — กำลังแสดงรายชื่อจากชีทแทน [${hrRoute()}]`;
    }
  }

  try {
    // action ในไฟล์นี้เป็นการอ่านล้วน (READ_ACTIONS) จึงลองใหม่ได้ปลอดภัยเมื่อ GAS สะดุด
    const upstream = await fetchScript(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      retries: 1,
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return res.status(502).json({ status: 'error', message: 'ตอบกลับจาก GAS ไม่ใช่ JSON' }); }

    // แคชเฉพาะตอนได้ข้อมูลจริง จะได้ไม่ค้าง error ไว้ให้คนถัดไป
    if (json.status === 'success') {
      res.setHeader('Cache-Control', `public, s-maxage=${spec.sMaxAge}, stale-while-revalidate=3600`);
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    // ถอยมาจาก SQL — บอกให้รู้ว่ารายชื่อชุดนี้อาจไม่ตรงกับฐาน (หน้าเว็บเอาไปขึ้นเตือนได้)
    if (sqlWarning) return res.status(200).json({ ...json, source: 'sheet', warning: sqlWarning });
    return res.status(200).json(json);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
