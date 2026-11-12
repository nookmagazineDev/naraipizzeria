// อ่านข้อมูลสต๊อกผ่าน GET เพื่อให้ CDN/เบราว์เซอร์แคชได้
//
// ⚠️ ยอดนับสต๊อก/ใบเบิกย้ายไปอยู่บน SQL Server (InventoryNarai) แล้ว — หน้าสาขา
//    (narai-branch.vercel.app/stock/list) ทั้งอ่านและเขียนที่นั่นตั้งแต่กลางปี ชีทที่ Apps Script
//    อ่านอยู่จึงไม่มียอดนับใหม่เข้าอีกเลย ถ้าอ่านชีทจะเห็นข้อมูลค้างอยู่เดือนสิงหา
//    ทุก action ในรายการข้างล่างจึงอ่าน SQL (ตัวอ่านอยู่ที่ lib/stockReaders.js) อ่านไม่ได้ตอบ error
//    ไม่ถอยไปชีท — Apps Script ข้างล่างใช้เฉพาะตอนตั้ง STOCK_SOURCE=sheet ไว้ตั้งใจ
//
// (/api/stock-gas เป็น POST — CDN แคชไม่ได้ เส้นนี้เป็น GET จึงแคชได้)
// ใช้เฉพาะ action ที่เป็นการอ่านอย่างเดียว
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwIOFT32mCznuUzCpLZnyBrYrjkdYRskUdVEVXEkP2CeMNd2qzT7dAqd7Vfsz2ZKbF2Fw/exec';

// action -> { params: พารามิเตอร์ที่ส่งต่อได้, sMaxAge: วินาทีที่ CDN ถือไว้ก่อน revalidate }
// รายชื่อสาขาแทบไม่เปลี่ยน เก็บได้ยาว / ยอดนับเปลี่ยนระหว่างวัน เก็บสั้นแล้วพึ่ง stale-while-revalidate
const READ_ACTIONS = {
  getBranches: { params: [], sMaxAge: 600 },
  getStockItems: { params: ['branch'], sMaxAge: 60 },
  getStockTotal: { params: ['endDate'], sMaxAge: 60 },
  getScheduleEmployees: { params: ['branch'], sMaxAge: 300 },
};

import { usingStockSql } from '../../lib/sheetsSource';
import { STOCK_SQL_READERS as SQL_READERS, stockSqlError } from '../../lib/stockReaders';

// อ่านทั้งชีทของสาขาผ่าน tunnel ใช้เวลาเกินค่าเริ่มต้น 10 วินาทีของ Vercel ได้
export const config = { maxDuration: 60 };

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

  // ── อ่านจากฐานเดียวกับที่สาขาบันทึกลงไป — อ่านไม่ได้ตอบ error ไม่ถอยไปอ่านชีทเก่า ──
  // (เคยถอยไปชีทพร้อมป้ายเตือน แต่ตัวเลขในชีทค้างตั้งแต่สาขาเลิกใช้ ดูปกติจนคนเชื่อ)
  const sqlWarning = '';
  const readFromSql = usingStockSql() ? SQL_READERS[action] : null;
  if (readFromSql) {
    try {
      const data = await readFromSql(req.query);
      res.setHeader('Cache-Control', `public, s-maxage=${spec.sMaxAge}, stale-while-revalidate=3600`);
      return res.status(200).json({ status: 'success', data, source: 'sql' });
    } catch (err) {
      console.error(`stock-read ${action}: อ่าน SQL ไม่ได้:`, err.message);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        status: 'error', source: 'sql',
        message: stockSqlError(err),
      });
    }
  }

  try {
    const upstream = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return res.status(502).json({ status: 'error', message: 'ตอบกลับจาก GAS ไม่ใช่ JSON' }); }

    // แคชเฉพาะตอนได้ข้อมูลจริง จะได้ไม่ค้าง error ไว้ให้คนถัดไป
    // ตอนถอยมาจาก SQL ไม่แคชเลย รอบหน้าจะได้ลองอ่านฐานใหม่ (ปกติแค่ tunnel สะดุดชั่วคราว)
    if (json.status === 'success' && !sqlWarning) {
      res.setHeader('Cache-Control', `public, s-maxage=${spec.sMaxAge}, stale-while-revalidate=3600`);
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    return res.status(200).json(sqlWarning ? { ...json, source: 'sheet', warning: sqlWarning } : json);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
