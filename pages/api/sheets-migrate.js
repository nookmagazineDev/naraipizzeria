// ย้ายข้อมูลเก่า (แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน) จากชีท -> SQL Server
//
// ฝาแฝดของ /api/qcrd-migrate — ให้ "ฝั่ง Vercel" เป็นคนย้าย เพราะการย้ายต้องเข้าถึงสองที่พร้อมกัน
// (Google Sheets + SQL Server) ซึ่ง Vercel ทำได้อยู่แล้ว จะได้ไม่ต้องไปนั่งรันสคริปต์ที่เครื่องออฟฟิศ
//
//   GET /api/sheets-migrate?key=<SHEETS_MIGRATE_KEY>&step=check       ← ดูสถานะ ไม่แตะข้อมูล (ค่าเริ่มต้น)
//   GET /api/sheets-migrate?key=...&step=probe                        ← ไล่ทดสอบว่าพอร์ตไหนของ SQL เปิดให้ต่อได้
//        เติม &host=1.2.3.4 และ/หรือ &port=1450,1451 เพื่อลองปลายทางที่ไม่ได้อยู่ในรายการเดา
//   GET /api/sheets-migrate?key=...&step=schema&confirm=1              ← สร้างตาราง 5 ตาราง
//   GET /api/sheets-migrate?key=...&step=plan&confirm=1                ← ย้ายแพลนสั่งของ
//   GET /api/sheets-migrate?key=...&step=closing&confirm=1             ← ย้ายยอดปิดรอบสิ้นเดือน
//   GET /api/sheets-migrate?key=...&step=expenseref&confirm=1          ← ย้ายรหัสค่าใช้จ่าย
//   GET /api/sheets-migrate?key=...&step=expense&confirm=1             ← ย้ายค่าใช้จ่ายที่บันทึกแล้ว
//   GET /api/sheets-migrate?key=...&step=employee&confirm=1            ← ย้ายพนักงาน
//   GET /api/sheets-migrate?key=...&step=all&confirm=1                 ← ไล่ทุกชุดตามลำดับข้างบน
//   GET /api/sheets-migrate?key=...&step=verify                        ← เทียบจำนวนชีท ↔ SQL
//
// ไม่ใส่ confirm=1 = ทดลอง (อ่านชีท นับแถว แต่ไม่เขียนอะไรลงฐาน)
//
// ⚠️ ต้องมีรหัสเปิดทางก่อน ไม่มี = ปิดทางนี้ไว้ทั้งหมด — ใช้ SHEETS_MIGRATE_KEY
//    หรือ QCRD_MIGRATE_KEY ที่ตั้งไว้แล้วตอนย้าย QC/RD ก็ได้ (ตัวไหนตั้งไว้ก่อนใช้ตัวนั้น)
//    และต้องตั้งรหัสฐานข้อมูล (QCRD_DB_USER/PASSWORD หรือ ZK_DB_/HR_DB_) ให้ต่อ SQL ตรงได้
//    ต่อไม่ติดให้เรียก &step=probe ไล่ดูว่าพอร์ตไหนเปิดจริง (probe ไม่ต้องใช้รหัสฐาน)
//
// งานหนักเกิน 60 วิของ Vercel ไม่ได้ — แต่ละครั้งจึงทำเท่าที่ทัน แล้วบอก nextOffset กลับมา
// ให้เรียกซ้ำต่อจากเดิม (ตอบ done:false = ยังไม่จบ, done:true = ชุดนั้นครบแล้ว)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { probeEndpoints, extraTargets } from '../../lib/sqlProbe.mjs';
import {
  fetchPlanRows, fetchClosingRows, fetchExpenseRefs, fetchExpenses, fetchEmployees,
} from '../../lib/sheetsSheet.mjs';
import { isConfigured as hasDirectDb, describeTarget, runQuery, credentials } from '../../lib/qcrdPool';
import { combine, PARAM_LIMIT } from '../../lib/qcrdMigrate.mjs';
import {
  mapPlan, mapClosing, mapExpenseRefs, mapExpenses, mapEmployees,
  planStmt, closingStmt, expenseRefStmt, expenseStmt, employeeStmt,
  str,
} from '../../lib/sheetsMigrate.mjs';

export const config = { maxDuration: 60 };

// เผื่อเวลาไว้ตอบกลับก่อนโดน platform ตัดที่ 60 วิ
const BUDGET_MS = 45000;

// ชุดข้อมูล -> วิธีอ่านชีท, วิธีแปลง, วิธีเขียน, ตารางปลายทาง
const SETS = {
  plan: {
    label: 'แพลนสั่งของ',
    table: 'dbo.stock_plan',
    read: fetchPlanRows,
    map: mapPlan,
    stmt: planStmt,
    describe: (r) => `ใบสั่ง ${r.orderNo} ลำดับ ${r.seq}`,
  },
  closing: {
    label: 'ปิดรอบสิ้นเดือน',
    table: 'dbo.stock_closing',
    read: () => fetchClosingRows('full'),
    map: mapClosing,
    stmt: closingStmt,
    describe: (r) => `${r.branch} ${r.closeDate} ไอเทม ${r.itemKey}`,
  },
  expenseref: {
    label: 'รหัสค่าใช้จ่าย',
    table: 'dbo.expense_ref',
    read: fetchExpenseRefs,
    map: mapExpenseRefs,
    stmt: expenseRefStmt,
    describe: (r) => `${r.type} ${r.branch}`,
  },
  expense: {
    label: 'ค่าใช้จ่ายอื่นๆ',
    table: 'dbo.expense_entry',
    read: fetchExpenses,
    map: mapExpenses,
    stmt: expenseStmt,
    describe: (r) => `${r.period} ${r.type} ${r.branch}`,
  },
  employee: {
    label: 'พนักงาน',
    table: 'dbo.hr_employee',
    read: fetchEmployees,
    map: mapEmployees,
    stmt: employeeStmt,
    describe: (r) => `รหัส ${r.hrCode}`,
  },
};

const ORDER = ['plan', 'closing', 'expenseref', 'expense', 'employee'];

/** ยิงทีละก้อน โดยรวมหลายแถวเป็นคำสั่งเดียวเท่าที่พารามิเตอร์ยังไม่เกินลิมิต */
async function writeBatched(records, buildStmt, { deadline, startAt = 0, describe }) {
  let done = startAt;
  let batches = 0;
  while (done < records.length) {
    if (Date.now() > deadline) return { done, batches, finished: false };
    const stmts = [];
    let params = 0;
    while (done + stmts.length < records.length) {
      const rec = records[done + stmts.length];
      const stmt = buildStmt(rec, `_${stmts.length}`);
      const n = Object.keys(stmt.params).length;
      // SQL Server รับได้ 2100 พารามิเตอร์ต่อคำสั่ง — แถวเดียวที่ใหญ่เกินนั้นแบ่งไม่ได้
      if (!stmts.length && n > PARAM_LIMIT) {
        throw new Error(
          `รายการเดียวใหญ่เกินไป (${n} พารามิเตอร์)${describe ? ` ที่ ${describe(rec)}` : ''}`);
      }
      if (stmts.length && params + n > PARAM_LIMIT) break;
      stmts.push(stmt);
      params += n;
    }
    const { text, params: p } = combine(stmts);
    await runQuery(text, p);
    done += stmts.length;
    batches++;
  }
  return { done, batches, finished: true };
}

async function runSet(key, { confirm, offset, deadline }) {
  const set = SETS[key];
  const sheetRows = await set.read();
  const mapped = set.map(sheetRows);
  const total = mapped.rows.length;

  if (!confirm) {
    return {
      step: key, label: set.label, sheetRows: sheetRows.length, records: total,
      ...mapped.stats, note: 'ใส่ confirm=1 เพื่อเขียนลงฐานจริง',
    };
  }

  const r = await writeBatched(mapped.rows, set.stmt, { deadline, startAt: offset, describe: set.describe });
  const out = {
    step: key, label: set.label, sheetRows: sheetRows.length, records: total,
    written: r.done, batches: r.batches, done: r.finished, ...mapped.stats,
  };
  if (!r.finished) {
    out.nextOffset = r.done;
    out.note = `ยังไม่จบ — เรียกซ้ำด้วย &step=${key}&confirm=1&offset=${r.done}`;
  }
  return out;
}

async function runSchema(confirm, deadline) {
  // อ่านไฟล์สคีมาจากรีโป (next.config.js สั่งให้แนบ docs/ ไปกับฟังก์ชันนี้)
  const file = path.join(process.cwd(), 'docs', 'schema-sheets.sql');
  const sqlText = await readFile(file, 'utf8');
  const batches = sqlText.split(/^\s*GO\s*;?\s*$/gim).map((b) => b.trim()).filter(Boolean);
  // ชุดแรกเป็น CREATE DATABASE/USE ซึ่งรันจากคอนเนกชันที่ชี้ฐานนั้นอยู่แล้วไม่ได้/ไม่จำเป็น
  const skip = /CREATE\s+DATABASE|^\s*USE\s+/im;
  const runnable = batches.filter((b) => !skip.test(b));
  if (!confirm) return { step: 'schema', wouldRun: runnable.length, note: 'ใส่ confirm=1 เพื่อสร้างตารางจริง' };
  let ok = 0;
  for (const b of runnable) {
    if (Date.now() > deadline) return { step: 'schema', ran: ok, of: runnable.length, done: false };
    await runQuery(b);
    ok++;
  }
  return { step: 'schema', ran: ok, of: runnable.length, done: true };
}

/** เทียบจำนวนในชีทกับที่อยู่ใน SQL ทีละชุด */
async function verify() {
  const count = async (table) => Number((await runQuery(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n) || 0;

  const checks = [];
  for (const key of ORDER) {
    const set = SETS[key];
    try {
      const mapped = set.map(await set.read());
      const inSql = await count(set.table);
      checks.push({
        label: set.label, table: set.table,
        sheet: mapped.rows.length, sql: inSql,
        ok: inSql >= mapped.rows.length,
      });
    } catch (err) {
      checks.push({ label: set.label, table: set.table, error: err.message, ok: false });
    }
  }
  return { step: 'verify', ready: checks.every((c) => c.ok), checks };
}

export default async function handler(req, res) {
  const q = { ...req.query, ...(typeof req.body === 'object' ? req.body : {}) };
  // ตั้ง SHEETS_MIGRATE_KEY แยกก็ได้ ไม่ตั้งก็ใช้รหัสเดิมของ QC/RD ได้เลย (คนเดียวกันเป็นคนกด
  // และคุมฐานเดียวกัน) จะได้ไม่ต้องไปตั้ง env ใหม่บน Vercel แค่เพราะจะกดย้ายข้อมูลรอบนี้
  const key = process.env.SHEETS_MIGRATE_KEY || process.env.QCRD_MIGRATE_KEY || '';
  if (!key) {
    return res.status(503).json({
      status: 'error',
      message: 'ยังไม่ได้ตั้ง env SHEETS_MIGRATE_KEY (หรือ QCRD_MIGRATE_KEY) บน Vercel — ทางนี้ถูกปิดไว้',
    });
  }
  if (str(q.key) !== key) return res.status(401).json({ status: 'error', message: 'key ไม่ถูกต้อง' });

  const step0 = str(q.step) || 'check';

  // probe เป็นการทดสอบ TCP ล้วน ๆ ไม่ต้อง login ฐาน — ต้องกดได้แม้ยังไม่ได้ตั้งรหัสฐาน
  // (เป็นตัวที่ใช้ตอบว่า "ต่อไม่ติด" เพราะพอร์ตปิด หรือเพราะรหัสผิด ซึ่งเป็นคนละเรื่องกัน)
  if (step0 === 'probe') {
    try {
      return res.status(200).json({ status: 'success', ...(await probeEndpoints(extraTargets(q))) });
    } catch (err) {
      return res.status(500).json({ status: 'error', step: 'probe', message: err.message });
    }
  }

  if (!hasDirectDb()) {
    return res.status(400).json({
      status: 'error',
      message: 'ยังต่อ SQL ตรงไม่ได้ — ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (หรือ ZK_DB_/HR_DB_) บน Vercel ก่อน',
    });
  }

  const step = step0;
  const confirm = String(q.confirm || '') === '1';
  const offset = Math.max(0, Number(q.offset) || 0);
  const deadline = Date.now() + BUDGET_MS;
  const t0 = Date.now();

  try {
    if (step === 'check') {
      // สิทธิ์ของ login ที่ใช้ + ตารางไหนสร้างแล้วบ้าง — เช็กก่อนดีกว่าไปพังกลางทาง
      const perms = await runQuery(`
        SELECT DB_NAME() AS db, SUSER_SNAME() AS login_name,
               HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE TABLE') AS can_create,
               HAS_PERMS_BY_NAME(NULL, NULL, 'INSERT') AS can_insert,
               OBJECT_ID(N'dbo.stock_plan') AS t_plan,
               OBJECT_ID(N'dbo.stock_closing') AS t_closing,
               OBJECT_ID(N'dbo.expense_ref') AS t_expense_ref,
               OBJECT_ID(N'dbo.expense_entry') AS t_expense,
               OBJECT_ID(N'dbo.hr_employee') AS t_employee`).catch((e) => ({ error: e.message }));
      if (perms.error) {
        const cannotConnect = /Failed to connect|ETIMEOUT|ECONNREFUSED|ENOTFOUND|ESOCKET/i.test(perms.error);
        return res.status(200).json({
          status: 'error', step, db: describeTarget(), credentialsFrom: credentials().from,
          message: perms.error,
          hint: cannotConnect
            ? 'ต่อปลายทางไม่ได้เลย — เรียก &step=probe (รหัสเดิม) เพื่อไล่ดูว่าพอร์ตไหนเปิดให้ต่อได้'
            : undefined,
        });
      }
      const p = perms[0] || {};
      const tables = {
        stock_plan: Boolean(p.t_plan),
        stock_closing: Boolean(p.t_closing),
        expense_ref: Boolean(p.t_expense_ref),
        expense_entry: Boolean(p.t_expense),
        hr_employee: Boolean(p.t_employee),
      };
      const missing = Object.entries(tables).filter(([, v]) => !v).map(([k2]) => k2);
      return res.status(200).json({
        status: 'success', step, db: describeTarget(),
        credentialsFrom: credentials().from,
        loginName: str(p.login_name),
        canCreateTable: p.can_create === 1,
        canWrite: p.can_insert === 1,
        tables,
        sheetsSource: process.env.SHEETS_SOURCE || 'sheet',
        hint: missing.length
          ? (p.can_create === 1
            ? `ยังไม่มีตาราง: ${missing.join(', ')} — เรียก &step=schema&confirm=1 ก่อน`
            : `ยังไม่มีตาราง: ${missing.join(', ')} และ login นี้สร้างตารางไม่ได้ — ` +
              'ให้สิทธิ์ db_ddladmin เพิ่ม หรือรัน docs/schema-sheets.sql ที่เครื่องออฟฟิศครั้งเดียว')
          : 'ตารางพร้อมแล้ว — เรียก &step=all&confirm=1 เพื่อย้ายข้อมูลทุกชุด แล้วปิดท้ายด้วย &step=verify',
      });
    }

    if (step === 'schema') {
      const data = await runSchema(confirm, deadline);
      return res.status(200).json({ status: 'success', db: describeTarget(), tookMs: Date.now() - t0, ...data });
    }

    if (step === 'verify') {
      const data = await verify();
      return res.status(200).json({ status: 'success', db: describeTarget(), tookMs: Date.now() - t0, ...data });
    }

    if (step === 'all') {
      // ไล่ทีละชุดจนหมดเวลา — ชุดที่ยังไม่จบบอก nextOffset ไว้ให้เรียกซ้ำเฉพาะชุดนั้น
      const results = [];
      for (const k2 of ORDER) {
        if (Date.now() > deadline) {
          results.push({ step: k2, skipped: true, note: `หมดเวลาก่อน — เรียก &step=${k2}&confirm=1 ต่อเอง` });
          continue;
        }
        try {
          results.push(await runSet(k2, { confirm, offset: 0, deadline }));
        } catch (err) {
          results.push({ step: k2, error: err.message });
        }
      }
      return res.status(200).json({
        status: 'success', step, db: describeTarget(), tookMs: Date.now() - t0,
        done: results.every((r) => r.done !== false && !r.error && !r.skipped),
        results,
      });
    }

    if (!SETS[step]) {
      return res.status(400).json({
        status: 'error',
        message: `ไม่รู้จัก step=${step} — ใช้ได้: check, probe, schema, ${ORDER.join(', ')}, all, verify`,
      });
    }

    const data = await runSet(step, { confirm, offset, deadline });
    return res.status(200).json({ status: 'success', db: describeTarget(), tookMs: Date.now() - t0, ...data });
  } catch (err) {
    console.error('sheets-migrate error:', err.message);
    return res.status(500).json({ status: 'error', step, tookMs: Date.now() - t0, message: err.message });
  }
}
