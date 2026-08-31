// แก้เวลาสแกนนิ้วด้วยมือ — ชั้นทับของหน้า "ดูสแกนหน้า" (ตาราง dbo.attendance_edit ในฐาน InventoryNarai)
//
//   GET  /api/attendance-edit?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา]
//        → { status:'success', count, data:[{ date, empCode, slot, time, oldTime, name, branch, note, editedBy, savedAt }] }
//        คืนเฉพาะ "แถวล่าสุด" ของแต่ละ (วัน, พนักงาน, ช่อง) — คือเวลาที่ใช้แสดงจริง
//
//   GET  /api/attendance-edit?date=YYYY-MM-DD&emp=รหัสพนักงาน&history=1
//        → ประวัติการแก้ของคนนั้นในวันนั้น ทุกครั้งที่กดบันทึก (ใหม่ก่อน)
//
//   POST /api/attendance-edit   { date, empCode, slot, time, oldTime?, name?, branch?, note?, editedBy? }
//        → { status:'success', data:{ ...แถวที่เพิ่งบันทึก } }
//        slot = in | breakOut | breakIn | out   ·   time = 'HH:mm' หรือ '' (ล้างค่าช่องนั้น)
//
// ทุกครั้งที่กดบันทึกคือการ "บันทึกแถวใหม่" ไม่ใช่แก้ทับของเดิม — ประวัติจึงอยู่ครบว่าใครแก้
// จากเท่าไหร่เป็นเท่าไหร่เมื่อไหร่ และข้อมูลสแกนจริงใน ZKBio9 ไม่ถูกแตะเลยสักแถว
// (หน้าเว็บเอาไปครอบตอนแสดงผลด้วย applyScanEdits ใน lib/attendance.js)
//
// ทางไปถึงฐานใช้ชุดเดียวกับหน้าอื่นที่เขียนลง InventoryNarai (lib/sheetsSource.js):
// ต่อ SQL ตรงเมื่อตั้ง QCRD_DB_USER/PASSWORD (หรือ ZK_DB_/HR_DB_) ไว้ ไม่งั้นผ่าน host API
// /sheets/* ซึ่งฝั่งเขียนต้องมี SHEETS_WRITE_KEY (หรือ QCRD_WRITE_KEY) ให้ตรงกับเครื่องออฟฟิศ
import { readScanEdits, readScanEditHistory, saveScanEdit, sqlRoute } from '../../lib/sheetsSource';
import { EDIT_SLOTS } from '../../lib/scanEditSql.mjs';

export const config = { maxDuration: 30 };

const txt = (v) => (v == null ? '' : String(v).trim());
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** ยังไม่ได้สร้างตาราง/ยังไม่ได้ตั้งกุญแจเขียน = คนละวิธีแก้ บอกให้ตรงจุดไปเลย */
function hintOf(message) {
  if (/Invalid object name/i.test(message)) {
    return 'ยังไม่ได้สร้างตาราง dbo.attendance_edit — เรียก /api/sheets-migrate?key=...&step=schema&confirm=1 ' +
      'หรือรัน docs/schema-sheets.sql ที่เครื่องออฟฟิศครั้งเดียว';
  }
  if (/x-api-key|SHEETS_WRITE_KEY|QCRD_WRITE_KEY/i.test(message)) {
    return 'ยังเขียนไม่ได้ — ตั้ง SHEETS_WRITE_KEY (หรือ QCRD_WRITE_KEY) บน Vercel ให้ตรงกับเครื่องออฟฟิศ ' +
      'หรือตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD เพื่อต่อ SQL ตรง';
  }
  return undefined;
}

function failed(res, err, status = 502) {
  const message = err?.message || 'ทำรายการไม่สำเร็จ';
  console.error('attendance-edit API error:', message);
  return res.status(err?.badRequest ? 400 : status).json({
    status: 'error',
    message,
    route: sqlRoute(),
    hint: hintOf(message),
  });
}

async function handleGet(req, res) {
  const date = txt(req.query.date);
  const emp = txt(req.query.emp);

  // โหมดประวัติ: ดูว่าช่องของคนนี้ในวันนี้ถูกแก้มากี่รอบแล้ว
  if (txt(req.query.history) === '1' || (date && emp)) {
    if (!isYmd(date) || !emp) {
      return res.status(400).json({ status: 'error', message: 'ดูประวัติต้องระบุ date (YYYY-MM-DD) และ emp' });
    }
    try {
      const data = await readScanEditHistory({ date, empCode: emp });
      return res.status(200).json({ status: 'success', date, empCode: emp, count: data.length, data });
    } catch (err) {
      return failed(res, err);
    }
  }

  const start = txt(req.query.start);
  const end = txt(req.query.end);
  const branch = txt(req.query.branch).toUpperCase();

  if (!isYmd(start) || !isYmd(end)) {
    return res.status(400).json({ status: 'error', message: 'ต้องระบุ start และ end เป็น YYYY-MM-DD' });
  }
  if (start > end) {
    return res.status(400).json({ status: 'error', message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
  }

  try {
    const data = await readScanEdits({ start, end, branch });
    return res.status(200).json({ status: 'success', start, end, branch, count: data.length, data });
  } catch (err) {
    return failed(res, err);
  }
}

async function handlePost(req, res) {
  const body = req.body || {};
  const date = txt(body.date);
  const empCode = txt(body.empCode);
  const slot = txt(body.slot);

  // ตรวจฝั่งนี้ก่อนอีกชั้น เพื่อให้ได้ 400 พร้อมเหตุผลไทย ๆ โดยไม่ต้องวิ่งไปถึงฐานก่อน
  if (!isYmd(date)) {
    return res.status(400).json({ status: 'error', message: 'ต้องระบุวันที่ (date) เป็น YYYY-MM-DD' });
  }
  if (!empCode) {
    return res.status(400).json({ status: 'error', message: 'ต้องระบุรหัสพนักงาน (empCode)' });
  }
  if (!EDIT_SLOTS.includes(slot)) {
    return res.status(400).json({ status: 'error', message: `ช่องที่แก้ (slot) ต้องเป็น ${EDIT_SLOTS.join(' | ')}` });
  }

  try {
    const data = await saveScanEdit({
      date,
      empCode,
      slot,
      time: txt(body.time),
      oldTime: txt(body.oldTime),
      name: txt(body.name),
      branch: txt(body.branch),
      note: txt(body.note),
      editedBy: txt(body.editedBy) || process.env.HR_SCHEDULE_USER || 'naraipizzeria',
    });
    return res.status(200).json({ status: 'success', data });
  } catch (err) {
    return failed(res, err);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ status: 'error', message: `ไม่รองรับ method ${req.method}` });
}
