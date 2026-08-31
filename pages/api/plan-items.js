// ทะเบียนไอเทมหมวดแพลน — อ่าน/เขียนตาราง InventoryNarai.dbo.plan_item
//
//   GET  /api/plan-items   -> รายชื่อรหัสสินค้าที่นับเป็นหมวดแพลน
//   POST /api/plan-items   -> { action: 'saveItem' | 'deleteItem' | 'createTable', ... }
//
// ตารางนี้เก็บแค่ "รายชื่อรหัส" ไม่ได้เก็บยอดสั่ง — ยอดสั่งอ่านสดจาก POS ทุกครั้ง (lib/planLive.js)
// ต่อฐานด้วย pool เดียวกับ QC/RD และทะเบียนสาขา (lib/qcrdPool.js) ซึ่งชี้ InventoryNarai อยู่แล้ว
//
// ⭐ ฝั่งอ่านห้ามพัง — หน้าแพลนสินค้ากรองหมวดด้วยรายชื่อชุดนี้ ต่อฐานไม่ได้/ยังไม่ได้สร้างตาราง
//    = ถอยไปใช้รายชื่อสำรองใน lib/planItems.js แล้วแนบ warning ไม่ใช่ตอบ error ทิ้งหน้าให้ว่าง
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isConfigured as hasDirectDb, describeTarget, runQuery } from '../../lib/qcrdPool';
import {
  PLAN_ITEMS, STATUS_ACTIVE, STATUS_INACTIVE, normItemCode, validateItemCode,
} from '../../lib/planItems';

export const config = { maxDuration: 60 };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** รายชื่อสำรองในรูปแบบเดียวกับที่อ่านจากฐาน — หน้าเว็บจึงไม่ต้องรู้ว่ามาจากไหน */
const fallbackRows = () =>
  PLAN_ITEMS.map((it, i) => ({
    code: normItemCode(it.code), name: it.name || '',
    status: STATUS_ACTIVE, note: '', sortOrder: i + 1,
  }));

const rowToItem = (r) => ({
  code: normItemCode(r.item_code),
  name: str(r.item_name),
  status: str(r.status) || STATUS_ACTIVE,
  note: str(r.note),
  sortOrder: Number(r.sort_order) || 0,
});

const isMissingTable = (msg) => /Invalid object name .*plan_item/i.test(msg || '');

const sortItems = (list) =>
  [...list].sort((a, b) => (a.sortOrder - b.sortOrder) || a.code.localeCompare(b.code));

async function readItems() {
  const rows = await runQuery(
    'SELECT item_code, item_name, status, note, sort_order FROM dbo.plan_item'
  );
  return sortItems(rows.map(rowToItem));
}

/**
 * สร้างตารางจาก docs/schema-plan-item.sql แล้วหยอดรายการตั้งต้นจาก PLAN_ITEMS
 * แยกหยอดใน JS ไม่ใส่ไว้ในไฟล์ SQL เพราะจะได้มีรายชื่อตั้งต้นอยู่ที่เดียว (lib/planItems.js)
 * รันซ้ำได้ — DDL เป็น IF NOT EXISTS และการหยอดเป็น MERGE ที่ไม่ทับของเดิม
 */
async function createTable() {
  // next.config.js สั่งแนบไฟล์นี้ไปกับฟังก์ชัน ไม่งั้นบน Vercel จะขึ้น ENOENT
  const file = path.join(process.cwd(), 'docs', 'schema-plan-item.sql');
  const sqlText = await readFile(file, 'utf8');
  const batches = sqlText.split(/^\s*GO\s*;?\s*$/gim).map((b) => b.trim()).filter(Boolean);
  const runnable = batches.filter((b) => !/CREATE\s+DATABASE|^\s*USE\s+/im.test(b));
  let ran = 0;
  for (const b of runnable) { await runQuery(b); ran++; }

  let seeded = 0;
  for (const [i, it] of PLAN_ITEMS.entries()) {
    const code = normItemCode(it.code);
    if (!code) continue;
    await runQuery(
      `MERGE dbo.plan_item AS t
       USING (SELECT @code AS item_code) AS s
          ON t.item_code = s.item_code
       WHEN NOT MATCHED THEN
          INSERT (item_code, item_name, status, sort_order)
          VALUES (@code, @name, @status, @sortOrder);`,
      { code, name: it.name || null, status: STATUS_ACTIVE, sortOrder: i + 1 }
    );
    seeded++;
  }
  return { ran, of: runnable.length, seeded };
}

/** เพิ่มหรือแก้ไอเทมหนึ่งตัว — รหัสเป็นคีย์ (ส่งรหัสเดิมมา = แก้ชื่อ/สถานะของตัวนั้น) */
async function saveItem(body) {
  const code = normItemCode(body.code);
  const bad = validateItemCode(code);
  if (bad) throw new Error(bad);

  const status = str(body.status) === STATUS_INACTIVE ? STATUS_INACTIVE : STATUS_ACTIVE;
  await runQuery(
    `MERGE dbo.plan_item AS t
     USING (SELECT @code AS item_code) AS s
        ON t.item_code = s.item_code
     WHEN MATCHED THEN UPDATE SET
        item_name = @name, status = @status, note = @note,
        sort_order = @sortOrder, updated_at = SYSDATETIME()
     WHEN NOT MATCHED THEN
        INSERT (item_code, item_name, status, note, sort_order)
        VALUES (@code, @name, @status, @note, @sortOrder);`,
    {
      code,
      name: str(body.name) || null,
      status,
      note: str(body.note) || null,
      sortOrder: Number(body.sortOrder) || 0,
    }
  );
  return { code };
}

async function deleteItem(body) {
  const code = normItemCode(body.code);
  if (!code) throw new Error('ต้องระบุรหัสสินค้าที่จะลบ');
  const rows = await runQuery(
    'DELETE FROM dbo.plan_item OUTPUT deleted.item_code AS code WHERE item_code = @code',
    { code }
  );
  if (!rows.length) throw new Error(`ไม่พบรหัส ${code} ในทะเบียนหมวดแพลน`);
  return { code };
}

/** แปลง error ของ SQL ที่ผู้ใช้แก้เองได้ ให้เป็นข้อความที่บอกวิธีแก้ */
function explain(err) {
  const msg = err?.message || String(err);
  if (isMissingTable(msg)) {
    return 'ยังไม่ได้สร้างตารางทะเบียนหมวดแพลน — กดปุ่ม "สร้างตาราง" ในหน้าจัดการรายการ ' +
      'หรือรัน docs/schema-plan-item.sql ที่เครื่องออฟฟิศ';
  }
  return msg;
}

const NO_DB =
  'ยังไม่ได้ตั้งรหัสฐานข้อมูลบน Vercel (QCRD_DB_USER/QCRD_DB_PASSWORD หรือ ZK_DB_* / HR_DB_* ' +
  'ที่มีสิทธิ์ในฐาน InventoryNarai)';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!hasDirectDb()) {
      return res.status(200).json({
        status: 'success', source: 'fallback', tableReady: false, canWrite: false,
        data: fallbackRows(),
        warning: `${NO_DB} — ใช้รายชื่อหมวดแพลนสำรองที่ฝังไว้ในโค้ด เพิ่ม/ลบจากหน้านี้ยังไม่ได้`,
      });
    }
    try {
      const data = await readItems();
      // ตารางว่าง (เพิ่งสร้างแต่ยังไม่ได้หยอด) ให้ถอยไปใช้รายชื่อสำรอง ไม่งั้นหน้าแพลนจะโล่ง
      if (!data.length) {
        return res.status(200).json({
          status: 'success', source: 'fallback', tableReady: true, canWrite: true,
          data: fallbackRows(),
          warning: 'ตารางทะเบียนหมวดแพลนยังว่าง — แสดงรายชื่อสำรองไปก่อน กดปุ่ม "สร้างตาราง" เพื่อหยอดรายการตั้งต้น',
        });
      }
      return res.status(200).json({
        status: 'success', source: 'sql', target: describeTarget(),
        tableReady: true, canWrite: true, data,
      });
    } catch (err) {
      console.error('plan-items: อ่านทะเบียนหมวดแพลนไม่ได้:', err.message);
      const missing = isMissingTable(err.message);
      return res.status(200).json({
        status: 'success', source: 'fallback', tableReady: false, canWrite: true,
        data: fallbackRows(),
        warning: missing
          ? 'ยังไม่ได้สร้างตารางทะเบียนหมวดแพลน — แสดงรายชื่อสำรองไปก่อน กดปุ่ม "สร้างตาราง" เพื่อเริ่มใช้งาน'
          : `อ่านทะเบียนหมวดแพลนจากฐานไม่ได้ (${err.message}) — แสดงรายชื่อสำรองที่ฝังไว้ในโค้ดแทน`,
      });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'GET หรือ POST เท่านั้น' });
  }

  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })()
    : (req.body || {});
  const action = str(body.action);

  if (!hasDirectDb()) {
    return res.status(200).json({ status: 'error', message: `แก้ทะเบียนหมวดแพลนไม่ได้ — ${NO_DB}` });
  }

  try {
    // ไม่ได้ป้องกันด้วยคีย์ กติกาเดียวกับ /api/branches — ตารางนี้เก็บแค่รายชื่อรหัสสินค้า
    // ไม่มีข้อมูลยอดสั่ง และ createTable เป็น IF NOT EXISTS + MERGE ที่ไม่ทับของเดิมสักแถว
    if (action === 'createTable') return res.status(200).json({ status: 'success', data: await createTable() });
    if (action === 'saveItem') return res.status(200).json({ status: 'success', data: await saveItem(body) });
    if (action === 'deleteItem') return res.status(200).json({ status: 'success', data: await deleteItem(body) });
    return res.status(200).json({ status: 'error', message: `ไม่รู้จักคำสั่ง ${action || '(ว่าง)'}` });
  } catch (err) {
    console.error(`plan-items: ${action} ไม่สำเร็จ:`, err.message);
    // คืน 200 พร้อม status:'error' เหมือน /api/branches — หน้าเว็บอ่านข้อความไปแสดงตรง ๆ
    return res.status(200).json({ status: 'error', message: explain(err) });
  }
}
