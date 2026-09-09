// ทะเบียนสาขา — อ่าน/เขียนตาราง InventoryNarai.dbo.hr_branch
//
//   GET  /api/branches              -> รายชื่อสาขาทั้งหมด (ใช้เติม dropdown ทุกหน้า)
//   GET  /api/branches?compare=1    -> แนบผลเทียบกับรายชื่อสาขาของระบบตารางงานมาด้วย
//   POST /api/branches              -> { action: 'saveBranch' | 'deleteBranch' | 'createTable', ... }
//
// ⚠️ ตารางนี้คนละตัวกับ narai_hr.dbo.hr_branch ของโปรเจกต์ Narai-branch (ระบบตารางงาน)
//    เหตุผลที่แยกกันอยู่หัวไฟล์ docs/schema-hr-branch.sql — compare=1 มีไว้ให้เห็นว่าสองที่ยังตรงกันไหม
//
// ไปถึงฐาน InventoryNarai ได้สองทาง (lib/sheetsSource.js เลือกให้เอง ชุดเดียวกับค่าใช้จ่ายอื่นๆ):
//   1) ต่อ SQL ตรงจาก Vercel — ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (หรือ ZK_DB_* / HR_DB_*)
//   2) host API /sheets/branch + /sheets/save ที่เครื่องออฟฟิศ — ต้องตั้ง SHEETS_WRITE_KEY
//      ให้ตรงกับเครื่องนั้นสำหรับฝั่งเขียน
// ที่ร้าน SQL ไม่ได้เปิดพอร์ตออกเน็ต ทางที่ใช้จริงจึงเป็นทางที่ 2 — เมื่อก่อนหน้านี้ยิงแต่ทางที่ 1
// อ่านก็ไม่ได้ บันทึกก็ไม่ได้ เลยตกไปแสดงรายชื่อสำรองในโค้ดตลอด ทั้งที่ทะเบียนจริงอยู่ในฐาน
//
// ⭐ ฝั่งอ่านห้ามพังเด็ดขาด — dropdown เลือกสาขาของหน้า "ดูสแกนหน้า", QC/RD วัตถุดิบ และ
//    ค่าใช้จ่ายอื่นๆ กินข้อมูลชุดนี้ ต่อฐานไม่ได้/ยังไม่ได้สร้างตาราง = ถอยไปใช้รายชื่อสำรอง
//    ใน lib/branches.js แล้วแนบ warning กลับไป ไม่ใช่ตอบ error ทิ้งหน้าเว็บให้ว่างเปล่า
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isConfigured as hasDirectDb, runQuery } from '../../lib/qcrdPool';
import {
  readBranchRegistry, saveBranchRow, deleteBranchRow, sqlRoute, SHEETS_API_BASE,
} from '../../lib/sheetsSource';
import { fetchScheduleBranches } from '../../lib/hrSchedule';
import {
  FALLBACK_BRANCHES, STATUS_ACTIVE, STATUS_INACTIVE, normalizeCode,
  normalizeOutletId, validateCode,
} from '../../lib/branches';

export const config = { maxDuration: 60 };

// แคชสั้น ๆ ที่ CDN — ทะเบียนสาขาแทบไม่เปลี่ยน แต่ทุกหน้าที่มี dropdown เรียกตอนเปิด
// หลังกดบันทึก หน้าเว็บต่อ ?t=<เวลา> มาด้วย จึงได้ของใหม่เสมอ (กติกาเดียวกับ /api/qcrd)
const CACHE_OK = 'public, s-maxage=30, stale-while-revalidate=120';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * ตรวจค่าที่ส่งมาก่อนยิงต่อ — คืนข้อความบอกสาเหตุ หรือ '' ถ้าผ่าน
 *
 * lib/branchSql.mjs ตรวจซ้ำอีกชั้นตอนจะเขียนจริง แต่ตรวจที่นี่ด้วยเพราะเมื่อไปทาง host API
 * คนที่รันตัวตรวจคือเครื่องออฟฟิศ ไม่ใช่ฟังก์ชันนี้ — ปล่อยผ่านไปแล้วค่อยให้ปลายทางปฏิเสธ
 * แปลว่าส่งของเสียข้ามเน็ตไปฟรี ๆ และถ้าวันหลังปลายทางเป็นเวอร์ชันเก่าก็หลุดเข้าฐานได้จริง
 */
function checkBranchBody(action, body) {
  const code = normalizeCode(body.code);
  if (action === 'deleteBranch') return code ? '' : 'ต้องระบุรหัสสาขาที่จะลบ';
  const bad = validateCode(code);
  if (bad) return bad;
  if (str(body.outletId) && normalizeOutletId(body.outletId) === null) {
    return 'รหัสร้าน POS ต้องเป็นจำนวนเต็มบวก (เว้นว่างได้ถ้ายังไม่ได้เลขมา)';
  }
  return '';
}

/** ไปถึงฐานได้ไหม — ต่อ SQL ตรงได้ หรือมีกุญแจเขียนสำหรับ host API อย่างใดอย่างหนึ่งก็พอ */
const canWrite = () =>
  hasDirectDb() || Boolean(process.env.SHEETS_WRITE_KEY || process.env.QCRD_WRITE_KEY);

/** รายชื่อสำรองในรูปแบบเดียวกับที่อ่านจากฐาน — หน้าเว็บจึงไม่ต้องรู้ว่ามาจากไหน */
const fallbackRows = () =>
  FALLBACK_BRANCHES.map((b, i) => ({
    code: b.code, name: '', outletId: b.outletId,
    status: STATUS_ACTIVE, note: '', sortOrder: i + 1,
  }));

const isMissingTable = (msg) => /Invalid object name .*hr_branch/i.test(msg || '');

/**
 * เทียบทะเบียนกับรายชื่อสาขาของระบบตารางงาน (narai_hr ผ่าน office-server)
 * ไม่ใช่การซิงก์ — แค่บอกว่ารหัสไหนมีที่เดียว จะได้ตามไปแก้ให้ตรงกันเอง
 * ดึงไม่ได้ (เครื่องออฟฟิศดับ) ไม่ถือว่าพัง คืน error ไปให้แสดงเป็นหมายเหตุ
 */
async function compareWithSchedule(list) {
  try {
    const known = await fetchScheduleBranches();
    const scheduleCodes = known.map((b) => normalizeCode(b.name)).filter(Boolean);
    const inRegistry = new Set(list.map((b) => normalizeCode(b.code)));
    const inSchedule = new Set(scheduleCodes);
    return {
      ok: true,
      scheduleCount: scheduleCodes.length,
      // ชื่อไทยที่ระบบตารางงานมี — เอาไปเติมช่องชื่อในทะเบียนได้ (ปุ่ม "ดึงชื่อจากตารางงาน")
      names: Object.fromEntries(
        known.map((b) => [normalizeCode(b.name), str(b.fullName)]).filter(([c, n]) => c && n && n !== c)
      ),
      missingInRegistry: scheduleCodes.filter((c) => !inRegistry.has(c)),
      missingInSchedule: list
        .filter((b) => b.status !== STATUS_INACTIVE && !inSchedule.has(normalizeCode(b.code)))
        .map((b) => b.code),
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/** สร้างตารางจาก docs/schema-hr-branch.sql (รันซ้ำได้ ไม่ทับข้อมูลเดิม) */
async function createTable() {
  // next.config.js สั่งแนบไฟล์นี้ไปกับฟังก์ชัน ไม่งั้นบน Vercel จะขึ้น ENOENT
  const file = path.join(process.cwd(), 'docs', 'schema-hr-branch.sql');
  const sqlText = await readFile(file, 'utf8');
  const batches = sqlText.split(/^\s*GO\s*;?\s*$/gim).map((b) => b.trim()).filter(Boolean);
  // ชุด CREATE DATABASE/USE รันจากคอนเนกชันที่ชี้ฐานนั้นอยู่แล้วไม่ได้ (และไม่จำเป็น)
  const runnable = batches.filter((b) => !/CREATE\s+DATABASE|^\s*USE\s+/im.test(b));
  let ran = 0;
  for (const b of runnable) { await runQuery(b); ran++; }
  return { ran, of: runnable.length };
}

/* ตัวเขียนจริงอยู่ใน lib/branchSql.mjs (ใช้ร่วมกับ host-server) — ที่นี่แค่เลือกทางไปถึงฐาน
   ตรวจความถูกต้องของรหัส/เลข outlet ก็อยู่ในนั้น ทั้งสองทางจึงได้กติกาเดียวกันเป๊ะ */
/** แปลง error ของ SQL ที่ผู้ใช้แก้เองได้ ให้เป็นข้อความที่บอกวิธีแก้ */
function explain(err) {
  const msg = err?.message || String(err);
  if (/UQ_hr_branch_outlet|duplicate key.*outlet/i.test(msg)) {
    return 'รหัสร้าน POS นี้ถูกใช้กับสาขาอื่นอยู่แล้ว — เลขนี้ต้องไม่ซ้ำกัน ไม่งั้นยอดขายสองสาขาจะรวมกันมั่ว';
  }
  if (isMissingTable(msg)) {
    return 'ยังไม่ได้สร้างตารางทะเบียนสาขา — กดปุ่ม "สร้างตาราง" ที่หัวหน้านี้ ' +
      'หรือรัน docs/schema-hr-branch.sql ที่เครื่องออฟฟิศ';
  }
  return msg;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const wantCompare = str(req.query.compare) === '1';

    // การเทียบกับระบบตารางงานไม่ต้องพึ่งฐานเลย (ยิงไป office-server ตรง ๆ)
    // จึงต้องทำได้แม้ตอนที่ยังต่อฐานไม่ได้และแสดงรายชื่อสำรองอยู่ — ไม่งั้นกดปุ่มแล้วเงียบ
    const withCompare = async (payload, list) =>
      wantCompare ? { ...payload, compare: await compareWithSchedule(list) } : payload;

    if (!canWrite()) {
      const data = fallbackRows();
      return res.status(200).json(await withCompare({
        status: 'success', source: 'fallback', tableReady: false, canWrite: false, data,
        warning: 'ยังไปถึงฐานทะเบียนสาขาไม่ได้ — ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (ต่อ SQL ตรง) ' +
          'หรือ SHEETS_WRITE_KEY ให้ตรงกับเครื่องออฟฟิศ (ผ่าน host API) อย่างใดอย่างหนึ่งบน Vercel ' +
          'ตอนนี้แสดงรายชื่อสาขาสำรองที่ฝังไว้ในโค้ด แก้ไขจากหน้านี้ยังไม่ได้',
      }, data));
    }

    try {
      const data = await readBranchRegistry();
      res.setHeader('Cache-Control', CACHE_OK);
      return res.status(200).json(await withCompare({
        status: 'success', source: 'sql', target: sqlRoute(),
        tableReady: true, canWrite: true, data,
      }, data));
    } catch (err) {
      const missing = isMissingTable(err.message);
      console.error('branches: อ่านทะเบียนสาขาไม่ได้:', err.message);
      const data = fallbackRows();
      return res.status(200).json(await withCompare({
        status: 'success', source: 'fallback', tableReady: false, canWrite: true, data,
        warning: missing
          ? 'ยังไม่ได้สร้างตารางทะเบียนสาขา — แสดงรายชื่อสำรองไปก่อน กดปุ่ม "สร้างตาราง" เพื่อเริ่มใช้งาน'
          : `อ่านทะเบียนสาขาจากฐานไม่ได้ (${err.message}) — แสดงรายชื่อสำรองที่ฝังไว้ในโค้ดแทน`,
      }, data));
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'GET หรือ POST เท่านั้น' });
  }

  const body = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })()
    : (req.body || {});
  const action = str(body.action);

  if (!canWrite()) {
    return res.status(200).json({
      status: 'error',
      message: 'แก้ทะเบียนสาขาไม่ได้ — ต้องตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (ต่อ SQL ตรง) ' +
        `หรือ SHEETS_WRITE_KEY ให้ตรงกับเครื่องออฟฟิศ (ผ่าน host API ${SHEETS_API_BASE}) ` +
        'อย่างใดอย่างหนึ่งบน Vercel',
    });
  }

  try {
    // ทั้งสามคำสั่งไม่ได้ป้องกันด้วยคีย์ เหมือน /api/qcrd-save — แดชบอร์ดตัวนี้เป็นระบบหลังบ้าน
    // ของออฟฟิศที่แก้ทะเบียนวัตถุดิบทั้งชุดได้อยู่แล้ว ต่างจาก /api/qcrd-migrate ที่ต้องมีคีย์
    // เพราะตัวนั้นเขียนทับข้อมูลทั้งฐานได้ ส่วน createTable ที่นี่เป็น IF NOT EXISTS + MERGE
    // ที่ไม่ทับของเดิมสักแถว
    if (action === 'createTable') {
      // ตัวนี้ทางเดียว: ต่อ SQL ตรง เพราะอ่าน DDL จากไฟล์ในฟังก์ชันแล้วยิงทีละ batch
      // ต่อตรงไม่ได้ = ให้ไปรันไฟล์ที่เครื่องออฟฟิศแทน (เป็นงานตั้งค่าครั้งเดียว ไม่ใช่ของที่ใช้ประจำ)
      if (!hasDirectDb()) {
        return res.status(200).json({
          status: 'error',
          message: 'สร้างตารางจากหน้านี้ได้เฉพาะตอนต่อ SQL ตรงจาก Vercel ได้ — ' +
            'ตอนนี้ไปทาง host API ให้รัน docs\\schema-hr-branch.sql ที่เครื่องออฟฟิศแทน (รันซ้ำได้ ไม่ทับของเดิม)',
        });
      }
      const out = await createTable();
      return res.status(200).json({ status: 'success', data: out });
    }
    // แก้รหัสสาขาไม่ได้ตั้งใจ — รหัสนี้ถูกอ้างอยู่ในตารางงาน ข้อมูลสแกนหน้า ค่าใช้จ่าย
    // และคอลัมน์ "สาขาที่ใช้" ของวัตถุดิบ เปลี่ยนที่ทะเบียนที่เดียวจะทำให้ข้อมูลเก่ากำพร้าทันที
    // จะเปลี่ยนรหัสจริง ๆ ให้เพิ่มสาขาใหม่แล้วปิดการใช้งานตัวเก่าแทน
    if (action === 'saveBranch' || action === 'deleteBranch') {
      const bad = checkBranchBody(action, body);
      if (bad) return res.status(200).json({ status: 'error', message: bad });
    }
    if (action === 'saveBranch') {
      const out = await saveBranchRow(body);
      return res.status(200).json({ status: 'success', data: out });
    }
    if (action === 'deleteBranch') {
      const out = await deleteBranchRow(body);
      return res.status(200).json({ status: 'success', data: out });
    }
    return res.status(200).json({ status: 'error', message: `ไม่รู้จักคำสั่ง ${action || '(ว่าง)'}` });
  } catch (err) {
    console.error(`branches: ${action} ไม่สำเร็จ:`, err.message);
    // คืน 200 พร้อม status:'error' เหมือน /api/qcrd-save — หน้าเว็บอ่านข้อความไปแสดงตรง ๆ
    return res.status(200).json({ status: 'error', message: explain(err) });
  }
}
