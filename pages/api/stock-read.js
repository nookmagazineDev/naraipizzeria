// อ่านข้อมูลสต๊อกผ่าน GET เพื่อให้ CDN/เบราว์เซอร์แคชได้
//
// ⚠️ ยอดนับสต๊อก/ใบเบิกย้ายไปอยู่บน SQL Server (InventoryNarai) แล้ว — หน้าสาขา
//    (narai-branch.vercel.app/stock/list) ทั้งอ่านและเขียนที่นั่นตั้งแต่กลางปี ชีทที่ Apps Script
//    อ่านอยู่จึงไม่มียอดนับใหม่เข้าอีกเลย ถ้าอ่านชีทจะเห็นข้อมูลค้างอยู่เดือนสิงหา
//    getStockItems / getStockTotal จึงอ่าน SQL ก่อน (ตรรกะเดียวกับฝั่งสาขา ดู lib/stockCountSql.mjs)
//    อ่านไม่ได้ค่อยถอยไปชีทพร้อมแนบ warning ให้หน้าเว็บขึ้นเตือนว่าเลขที่เห็นเป็นของเก่า
//
// อ่านข้อมูลส่วนที่เหลือจาก Google Apps Script
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

import { usingStockSql, readStockItems, readStockTotal } from '../../lib/sheetsSource';

// อ่านทั้งชีทของสาขาผ่าน tunnel ใช้เวลาเกินค่าเริ่มต้น 10 วินาทีของ Vercel ได้
export const config = { maxDuration: 60 };

// action ที่มีตัวอ่านจาก SQL แล้ว — ที่เหลือยังวิ่งไป Apps Script เหมือนเดิม
const SQL_READERS = {
  getStockItems: query => readStockItems(String(query.branch || '').toLowerCase().trim()),
  getStockTotal: query => readStockTotal(String(query.endDate || '').trim()),
};

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

  // ── ทางหลัก: อ่านจากฐานเดียวกับที่สาขาบันทึกยอดนับลงไป ──
  let sqlWarning = '';
  const readFromSql = usingStockSql() ? SQL_READERS[action] : null;
  if (readFromSql) {
    try {
      const data = await readFromSql(req.query);
      res.setHeader('Cache-Control', `public, s-maxage=${spec.sMaxAge}, stale-while-revalidate=3600`);
      return res.status(200).json({ status: 'success', data, source: 'sql' });
    } catch (err) {
      // ถอยไปอ่านชีทได้ แต่ห้ามเงียบ — ตัวเลขในชีทเป็นของเก่าที่สาขาเลิกใช้แล้ว
      console.error(`stock-read ${action}: อ่าน SQL ไม่ได้ ถอยไปอ่านชีท:`, err.message);
      sqlWarning =
        `อ่านยอดนับจากฐานข้อมูลไม่ได้ (${err.message}) — ตัวเลขที่เห็นตอนนี้มาจากชีทเก่า ` +
        'ที่สาขาเลิกใช้แล้ว อย่าเพิ่งยึดเป็นหลัก';
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
