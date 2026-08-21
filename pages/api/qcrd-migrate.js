// ย้ายข้อมูล QC/RD จากชีท -> SQL Server โดยให้ "ฝั่ง Vercel" เป็นคนทำ
//
// มีไว้เพราะการย้ายต้องเข้าถึงสองที่พร้อมกัน (Google Sheets + SQL Server) ซึ่ง Vercel ทำได้อยู่แล้ว
// จะได้ไม่ต้องไปนั่งรันสคริปต์ที่เครื่องออฟฟิศ (ถ้าอยากรันที่เครื่องเอง ใช้ scripts/migrate-qcrd.ps1)
//
//   GET /api/qcrd-migrate?key=<QCRD_MIGRATE_KEY>&step=check     ← ดูสถานะ ไม่แตะข้อมูล (ค่าเริ่มต้น)
//   GET /api/qcrd-migrate?key=...&step=probe                     ← ไล่ทดสอบว่าพอร์ตไหนของ SQL เปิดให้ต่อได้
//   GET /api/qcrd-migrate?key=...&step=schema&confirm=1          ← สร้างตาราง/เพิ่มคอลัมน์
//   GET /api/qcrd-migrate?key=...&step=group&confirm=1           ← ย้ายหมวดหมู่เมนู
//   GET /api/qcrd-migrate?key=...&step=menu&confirm=1            ← ย้ายเมนู
//   GET /api/qcrd-migrate?key=...&step=bom&confirm=1             ← ย้ายสูตร BOM
//   GET /api/qcrd-migrate?key=...&step=item&confirm=1            ← ย้ายวัตถุดิบ
//   GET /api/qcrd-migrate?key=...&step=verify                    ← เทียบจำนวนชีท ↔ SQL
//
// ไม่ใส่ confirm=1 = ทดลอง (อ่านชีท นับแถว แต่ไม่เขียนอะไรลงฐาน)
//
// ⚠️ ต้องตั้ง env QCRD_MIGRATE_KEY บน Vercel ก่อน ไม่ตั้ง = ปิดทางนี้ไว้ทั้งหมด
//    และต้องตั้งรหัสฐานข้อมูล (QCRD_DB_USER/PASSWORD หรือ HR_DB_USER/PASSWORD) ให้ต่อ SQL ตรงได้
//
// งานหนักเกิน 60 วิของ Vercel ไม่ได้ — แต่ละครั้งจึงทำเท่าที่ทัน แล้วบอก nextOffset กลับมา
// ให้เรียกซ้ำต่อจากเดิม (ตอบ done:false = ยังไม่จบ, done:true = ชุดนั้นครบแล้ว)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { probeEndpoints, extraTargets } from '../../lib/sqlProbe.mjs';
import { fetchQcrdSheet } from '../../lib/qcrdSheet';
import { isConfigured as hasDirectDb, describeTarget, runQuery, credentials } from '../../lib/qcrdPool';
import {
  mapGroups, mapMenus, mapBomByMenu, mapItems,
  groupStmt, menuStmt, bomStmt, itemStmt, itemBranchStmt, combine, PARAM_LIMIT,
  str, normCode,
} from '../../lib/qcrdMigrate.mjs';

export const config = { maxDuration: 60 };

// เผื่อเวลาไว้ตอบกลับก่อนโดน platform ตัดที่ 60 วิ
const BUDGET_MS = 45000;

const SHEET_OF = { group: 'menucodegroup', menu: 'menu', bom: 'BOM', item: 'item' };

/** อ่านชีทแล้วตัดหัวตารางออก (ตัวอ่านเดียวกับที่หน้าเว็บใช้ — lib/qcrdSheet.js) */
async function loadRows(step) {
  const rows = await fetchQcrdSheet(SHEET_OF[step]);
  return rows.slice(1);
}

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
      // (สูตรเมนูเดียวต้องลบ+ใส่ในคำสั่งเดียว) บอกให้รู้ว่าเมนูไหนดีกว่าปล่อยให้ error ดิบ
      if (!stmts.length && n > PARAM_LIMIT) {
        throw new Error(
          `รายการเดียวใหญ่เกินไป (${n} พารามิเตอร์)${describe ? ` ที่ ${describe(rec)}` : ''}` +
          ' — ลดจำนวนวัตถุดิบในสูตรเมนูนั้น หรือย้ายชุดนี้ด้วย scripts/migrate-qcrd.mjs แทน'
        );
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

async function runStep(step, { confirm, offset, deadline, extra = [] }) {
  if (step === 'probe') return probeEndpoints(extra);

  if (step === 'schema') {
    // อ่านไฟล์สคีมาจากรีโป (next.config.js สั่งให้แนบ docs/ ไปกับฟังก์ชันนี้)
    const file = path.join(process.cwd(), 'docs', 'schema-qcrd.sql');
    const sqlText = await readFile(file, 'utf8');
    const batches = sqlText.split(/^\s*GO\s*;?\s*$/gim).map((b) => b.trim()).filter(Boolean);
    // ชุดแรกเป็น CREATE DATABASE/USE ซึ่งรันจากคอนเนกชันที่ชี้ฐานนั้นอยู่แล้วไม่ได้/ไม่จำเป็น
    const skip = /CREATE\s+DATABASE|^\s*USE\s+/im;
    const runnable = batches.filter((b) => !skip.test(b));
    if (!confirm) return { step, wouldRun: runnable.length, note: 'ใส่ confirm=1 เพื่อสร้างตารางจริง' };
    let ok = 0;
    for (const b of runnable) {
      if (Date.now() > deadline) return { step, ran: ok, of: runnable.length, done: false };
      await runQuery(b);
      ok++;
    }
    return { step, ran: ok, of: runnable.length, done: true };
  }

  if (step === 'verify') return verify();

  const rows = await loadRows(step);
  const mapped = {
    group: mapGroups, menu: mapMenus, bom: mapBomByMenu, item: mapItems,
  }[step](rows);
  const total = mapped.rows.length;
  if (!confirm) {
    return { step, sheetRows: rows.length, records: total, ...mapped.stats, note: 'ใส่ confirm=1 เพื่อเขียนลงฐานจริง' };
  }

  const builder = { group: groupStmt, menu: menuStmt, bom: bomStmt, item: itemStmt }[step];
  const describe = step === 'bom' ? (m) => `เมนู ${m.menuCode}` : (x) => `รหัส ${x.code}`;
  const r = await writeBatched(mapped.rows, builder, { deadline, startAt: offset, describe });
  const out = {
    step, records: total, written: r.done, batches: r.batches,
    done: r.finished, ...mapped.stats,
  };
  if (!r.finished) {
    out.nextOffset = r.done;
    out.note = `ยังไม่จบ — เรียกซ้ำด้วย &offset=${r.done}`;
    return out;
  }

  // วัตถุดิบมีตารางสาขาที่ต้องเขียนตามอีกชุด (ทำหลังตัวทะเบียนเสร็จทั้งหมด)
  if (step === 'item') {
    const withBranch = mapped.rows.filter((it) => it.branches.length > 0);
    const b = await writeBatched(withBranch, itemBranchStmt, { deadline, startAt: 0 });
    out.branchRows = b.done;
    out.done = b.finished;
    if (!b.finished) out.note = 'ทะเบียนวัตถุดิบครบแล้ว แต่ตารางสาขายังไม่จบ — เรียกซ้ำอีกครั้ง (offset=0 ได้เลย)';
  }
  return out;
}

/** เทียบจำนวนในชีทกับที่อยู่ใน SQL ทีละชุด */
async function verify() {
  const count = async (sqlText) => Number((await runQuery(sqlText))[0]?.n) || 0;
  const [groupRows, menuRows, bomRows, itemRows] = await Promise.all(
    ['group', 'menu', 'bom', 'item'].map(loadRows));

  const sheetGroups = mapGroups(groupRows).rows.length;
  const sheetMenus = new Set(menuRows.map((r) => str(r[0])).filter(Boolean)).size;
  const sheetBom = mapBomByMenu(bomRows).stats.bomRows;
  const sheetItems = new Set(itemRows.map((r) => normCode(r[0])).filter(Boolean)).size;

  const [sqlGroups, sqlMenus, sqlBom, sqlItems, orphan, filled] = await Promise.all([
    count('SELECT COUNT(*) AS n FROM dbo.qcrd_menu_group'),
    count('SELECT COUNT(*) AS n FROM dbo.qcrd_menu'),
    count('SELECT COUNT(*) AS n FROM dbo.qcrd_bom'),
    count('SELECT COUNT(*) AS n FROM dbo.stock_item'),
    count(`SELECT COUNT(DISTINCT b.item_key) AS n FROM dbo.qcrd_bom b
           LEFT JOIN dbo.stock_item i ON i.item_key = b.item_key WHERE i.item_key IS NULL`),
    count('SELECT COUNT(*) AS n FROM dbo.stock_item WHERE converter IS NOT NULL'),
  ]);

  const line = (label, sheet, sql, note = '') => ({ label, sheet, sql, ok: sql >= sheet, note });
  const checks = [
    line('หมวดหมู่เมนู', sheetGroups, sqlGroups),
    line('เมนู', sheetMenus, sqlMenus),
    line('แถวสูตร BOM', sheetBom, sqlBom),
    line('วัตถุดิบ', sheetItems, sqlItems, 'SQL มากกว่าได้ ถ้าฝั่งสต๊อกเพิ่มไว้'),
  ];
  return {
    step: 'verify',
    ready: checks.every((c) => c.ok),
    checks,
    itemsWithConverter: filled,
    bomItemsMissingFromRegistry: orphan,
  };
}

export default async function handler(req, res) {
  const q = { ...req.query, ...(typeof req.body === 'object' ? req.body : {}) };
  const key = process.env.QCRD_MIGRATE_KEY || '';
  if (!key) {
    return res.status(503).json({
      status: 'error',
      message: 'ยังไม่ได้ตั้ง env QCRD_MIGRATE_KEY บน Vercel — ทางนี้ถูกปิดไว้',
    });
  }
  if (str(q.key) !== key) return res.status(401).json({ status: 'error', message: 'key ไม่ถูกต้อง' });

  if (!hasDirectDb()) {
    return res.status(400).json({
      status: 'error',
      message: 'ยังต่อ SQL ตรงไม่ได้ — ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (หรือ HR_DB_USER/HR_DB_PASSWORD) บน Vercel ก่อน',
    });
  }

  const step = str(q.step) || 'check';
  const confirm = String(q.confirm || '') === '1';
  const offset = Math.max(0, Number(q.offset) || 0);
  const deadline = Date.now() + BUDGET_MS;
  const t0 = Date.now();

  try {
    if (step === 'check') {
      // สิทธิ์ของ login ที่ใช้ — เช็กก่อนดีกว่าไปพังกลางทางตอนสร้างตาราง
      const perms = await runQuery(`
        SELECT DB_NAME() AS db, SUSER_SNAME() AS login_name,
               HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE TABLE') AS can_create,
               HAS_PERMS_BY_NAME(NULL, NULL, 'INSERT') AS can_insert,
               OBJECT_ID(N'dbo.stock_item') AS has_stock_item,
               OBJECT_ID(N'dbo.qcrd_menu') AS has_qcrd_menu`).catch((e) => ({ error: e.message }));
      if (perms.error) {
        const cannotConnect = /Failed to connect|ETIMEOUT|ECONNREFUSED|ENOTFOUND|ESOCKET/i.test(perms.error);
        return res.status(200).json({
          status: 'error', step, db: describeTarget(), credentialsFrom: credentials().from,
          message: perms.error,
          hint: cannotConnect
            ? 'ต่อปลายทางไม่ได้เลย — เรียก &step=probe เพื่อไล่ดูว่าพอร์ตไหนเปิดให้ต่อได้บ้าง'
            : undefined,
        });
      }
      const p = perms[0] || {};
      const tablesReady = Boolean(p.has_qcrd_menu);
      const menus = tablesReady
        ? Number((await runQuery('SELECT COUNT(*) AS n FROM dbo.qcrd_menu'))[0]?.n) || 0
        : undefined;
      return res.status(200).json({
        status: 'success', step, db: describeTarget(),
        credentialsFrom: credentials().from,
        loginName: str(p.login_name),
        canCreateTable: p.can_create === 1,
        canWrite: p.can_insert === 1,
        stockItemExists: Boolean(p.has_stock_item),
        tablesReady,
        menusInSql: menus,
        hint: tablesReady
          ? 'ตารางพร้อมแล้ว — เรียก &step=group&confirm=1 แล้วไล่ไป menu, bom, item, verify ตามลำดับ'
          : p.can_create === 1
            ? 'ยังไม่มีตาราง — เรียก &step=schema&confirm=1 ก่อน'
            : 'ยังไม่มีตาราง และ login นี้สร้างตารางไม่ได้ — ให้สิทธิ์ db_ddladmin เพิ่ม หรือรัน docs/schema-qcrd.sql ที่เครื่องออฟฟิศครั้งเดียว',
      });
    }
    if (!['schema', 'group', 'menu', 'bom', 'item', 'verify', 'probe'].includes(step)) {
      return res.status(400).json({ status: 'error', message: `ไม่รู้จัก step=${step}` });
    }
    const data = await runStep(step, { confirm, offset, deadline, extra: extraTargets(q) });
    return res.status(200).json({ status: 'success', db: describeTarget(), tookMs: Date.now() - t0, ...data });
  } catch (err) {
    console.error('qcrd-migrate error:', err.message);
    return res.status(500).json({ status: 'error', step, tookMs: Date.now() - t0, message: err.message });
  }
}
