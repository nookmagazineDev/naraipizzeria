#!/usr/bin/env node
/**
 * ย้าย login ของสาขาจากชีท User เข้าตาราง narai_hr.dbo.hr_user (ครั้งเดียว)
 *
 *   node scripts/import-hr-users.mjs users.csv              ดูก่อนว่าจะเกิดอะไร (ไม่เขียนฐาน)
 *   node scripts/import-hr-users.mjs users.csv --commit     เขียนจริง
 *   node scripts/import-hr-users.mjs users.csv --commit --overwrite   ทับบัญชีที่มีอยู่แล้วด้วย
 *
 * ทำไมต้องมีสคริปต์นี้
 * ---------------------------------------------------------------------------
 * ตอนนี้การล็อกอินของสาขายังมี "ทางถอยไปถามชีท" อยู่ (office-server/schedule.js ของ
 * โปรเจค Narai-branch) ซึ่งทำให้การตั้งรหัสใหม่จากหน้า HR > login สาขา ถูกย้อนกลับเงียบ ๆ:
 * พนักงานพิมพ์รหัสเก่าที่ยังอยู่ในชีท -> ตรวจกับฐานไม่ผ่าน -> ถอยไปถามชีท -> ชีทผ่าน ->
 * ระบบเขียนทับรหัส "และสาขา/outlet id" กลับเป็นค่าจากชีท แล้วให้เข้า
 *
 * ปิดทางถอยนั้นได้ด้วย SHEET_LOGIN_URL=off แต่ปิดก่อนที่ทุกคนจะมีแถวในฐาน = สาขานั้น
 * ล็อกอินไม่ได้ทันที สคริปต์นี้จึงย้ายทุกคนเข้ามาให้ครบก่อน แล้วค่อยปิด
 *
 * ทำไมต้อง export ไฟล์เอง ไม่ให้สคริปต์ไปดึงจากชีทตรง ๆ
 * ---------------------------------------------------------------------------
 * Apps Script ของชีทไม่มี action ไหนที่คืนรายชื่อผู้ใช้ออกมา (มีแค่ 'login' ที่ตรวจทีละคู่)
 * ส่วนการอ่านผ่าน gviz ต้องตั้งชีทเป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" ก่อน — ชีท User มีรหัสผ่าน
 * ของทุกสาขาอยู่ การเปิดลิงก์สาธารณะแม้ชั่วคราวคือเอารหัสทั้งหมดไปวางไว้กลางแจ้ง
 * (เหตุผลเดียวกับที่ office-server เลือกย้ายทีละคนตอนล็อกอินแทนการเขียนสคริปต์ย้าย)
 *
 * วิธีที่ปลอดภัยกว่า: คนที่เปิดชีทได้อยู่แล้ว export เป็น CSV ลงเครื่องออฟฟิศ แล้วรัน
 * สคริปต์นี้ที่เครื่องนั้น รหัสจึงไม่เคยวิ่งออกเน็ต และไม่ต้องเปิดสิทธิ์ชีทให้ใครเพิ่ม
 *
 * ⚠️ ลบไฟล์ CSV ทิ้งทันทีหลังรันเสร็จ — เป็นไฟล์ที่มีรหัสผ่านของทุกสาขาเป็นข้อความล้วน
 *
 * ขั้นตอนเต็ม
 * ---------------------------------------------------------------------------
 *   1. เปิดชีท User -> ไฟล์ -> ดาวน์โหลด -> CSV  (คอลัมน์ A/B/C/D = ชื่อผู้ใช้/รหัส/สาขา/outlet id)
 *   2. รันสคริปต์นี้แบบไม่ใส่ --commit ดูสรุปก่อน
 *   3. รันซ้ำพร้อม --commit
 *   4. เปิดหน้า HR > login สาขา เทียบว่าบัญชีครบทุกสาขาที่ยังเปิดอยู่
 *   5. ตั้ง SHEET_LOGIN_URL=off ใน .env ของ office-server แล้วรีสตาร์ท
 *   6. ลบไฟล์ CSV
 *
 * ตั้งค่าเชื่อมต่อผ่าน env ชุดเดียวกับสคริปต์อื่น (ดู scripts/qcrdDb.mjs)
 * ต้องเป็น login ที่มีสิทธิ์อ่าน/เขียน narai_hr.dbo.hr_user (ดู docs/grant-hr-user.sql)
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { openPool, describeTarget } from './qcrdDb.mjs';
import { hashHrPassword, validateHrPassword } from '../lib/hrUserHash.mjs';
import { validateBranchField, validateHrUsername } from '../lib/branchUserSql.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const commit = args.includes('--commit');
const overwrite = args.includes('--overwrite');
const dbArg = args.find((a) => a.startsWith('--db='));
const DB_NAME = dbArg ? dbArg.slice(5) : (process.env.HR_DB_NAME || 'narai_hr');

if (!file) {
  console.error('ใช้: node scripts/import-hr-users.mjs <ไฟล์.csv> [--commit] [--overwrite] [--db=narai_hr]');
  console.error('  ไม่ใส่ --commit = ดูอย่างเดียว ไม่เขียนฐาน');
  process.exit(1);
}

/**
 * แยก CSV ตามมาตรฐาน RFC4180 — รหัสผ่านมีจุลภาคหรือเครื่องหมายคำพูดได้
 * split(',') เฉย ๆ จะทำให้รหัสแบบ a,b กลายเป็นสองคอลัมน์แล้วนำเข้าผิดแบบเงียบ ๆ
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  // ชีทของ Google มักได้ BOM ติดมา ตัดทิ้งก่อน ไม่งั้นคอลัมน์แรกของแถวแรกจะมีอักขระแปลกนำหน้า
  const s = text.replace(/^﻿/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }   // "" ข้างในคือ " หนึ่งตัว
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

const str = (v) => String(v ?? '').trim();

/**
 * แถวแรกเป็นหัวตารางหรือข้อมูล — ชีทนี้ไม่มีมาตรฐานตายตัว บางชุดมีหัว บางชุดไม่มี
 * เดาจาก "ช่องรหัสผ่านว่าง" หรือ "ข้อความในช่องแรกดูเป็นชื่อคอลัมน์" แทนที่จะบังคับให้มี
 */
const looksLikeHeader = (r) => {
  const a = str(r[0]).toLowerCase();
  const b = str(r[1]).toLowerCase();
  return !b || /^(user|username|ชื่อผู้ใช้|ผู้ใช้)$/.test(a) || /^(pass|password|รหัส|รหัสผ่าน)$/.test(b);
};

async function main() {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (!rows.length) {
    console.error(`ไฟล์ ${file} ไม่มีข้อมูล`);
    process.exit(1);
  }
  if (looksLikeHeader(rows[0])) rows.shift();

  // คัดแถวที่ใช้ได้ก่อน ยังไม่แตะฐาน — จะได้เห็นปัญหาของไฟล์ทั้งหมดในรอบเดียว
  const good = [];
  const skipped = [];
  const seen = new Set();

  for (const [i, r] of rows.entries()) {
    const line = i + 1;
    const username = str(r[0]);
    const password = String(r[1] ?? '');   // ไม่ trim รหัส — ช่องว่างหัวท้ายเป็นส่วนหนึ่งของรหัสได้
    const branch = str(r[2]);
    const outletId = str(r[3]);

    const why = validateHrUsername(username)
      || (password ? '' : 'ไม่มีรหัสผ่านในไฟล์')
      || validateBranchField(branch);
    if (why) { skipped.push({ line, username: username || '(ว่าง)', why }); continue; }

    // ชื่อซ้ำในไฟล์ = แถวหลังจะทับแถวหน้าเงียบ ๆ ต้องให้คนเห็นแล้วไปแก้ในชีท
    const key = username.toLowerCase();
    if (seen.has(key)) { skipped.push({ line, username, why: 'ชื่อผู้ใช้ซ้ำกับแถวก่อนหน้าในไฟล์เดียวกัน' }); continue; }
    seen.add(key);

    // รหัสที่สั้นกว่าเกณฑ์ยังนำเข้าได้ — ของเดิมที่ใช้อยู่จริง ห้ามตกหล่นเพราะกติกาใหม่
    // แต่ต้องรายงานให้เห็นว่ามีกี่ตัว จะได้ตามไปเปลี่ยนทีหลัง
    good.push({ username, password, branch, outletId, weak: validateHrPassword(password) });
  }

  console.log(`ไฟล์: ${file}`);
  console.log(`ปลายทาง: ${describeTarget(DB_NAME)} -> dbo.hr_user`);
  console.log(`โหมด: ${commit ? (overwrite ? 'เขียนจริง + ทับของเดิม' : 'เขียนจริง (ข้ามบัญชีที่มีอยู่แล้ว)') : 'ดูอย่างเดียว ไม่เขียนฐาน'}\n`);
  console.log(`อ่านจากไฟล์ได้ ${good.length} แถว · ข้าม ${skipped.length} แถว`);
  for (const s of skipped) console.log(`  ข้ามบรรทัด ${s.line} (${s.username}): ${s.why}`);

  if (!good.length) { console.log('\nไม่มีอะไรให้นำเข้า'); return; }

  const pool = await openPool(DB_NAME);
  const mssql = pool.__mssql;
  try {
    const existing = new Set(
      (await pool.request().query('SELECT username FROM dbo.hr_user')).recordset
        .map((r) => String(r.username).trim().toLowerCase())
    );
    console.log(`ในฐานตอนนี้มี ${existing.size} บัญชี\n`);

    const toAdd = good.filter((u) => !existing.has(u.username.toLowerCase()));
    const already = good.filter((u) => existing.has(u.username.toLowerCase()));
    const weak = good.filter((u) => u.weak);

    console.log(`จะเพิ่มใหม่ ${toAdd.length} บัญชี: ${toAdd.map((u) => u.username).join(', ') || '(ไม่มี)'}`);
    if (already.length) {
      console.log(`มีอยู่แล้ว ${already.length} บัญชี: ${already.map((u) => u.username).join(', ')}`);
      console.log(overwrite
        ? '  --overwrite เปิดอยู่ -> จะเขียนทับรหัสและสาขาของบัญชีพวกนี้ด้วยค่าจากไฟล์'
        : '  จะข้ามไป (ไม่ทับ) — ถ้าเคยตั้งรหัสใหม่จากหน้าเว็บไปแล้ว การทับจะย้อนกลับเป็นรหัสเก่าในชีท');
    }
    if (weak.length) {
      console.log(`\n⚠️  ${weak.length} บัญชีมีรหัสที่ไม่ผ่านเกณฑ์ปัจจุบัน (สั้นกว่า 8 ตัว หรือมีช่องว่าง):`);
      console.log(`   ${weak.map((u) => u.username).join(', ')}`);
      console.log('   นำเข้าให้ตามเดิมเพื่อไม่ให้ใครล็อกอินไม่ได้ — ตามไปเปลี่ยนที่หน้า HR > login สาขา ทีหลัง');
    }

    const targets = overwrite ? good : toAdd;
    if (!commit) {
      console.log(`\nยังไม่ได้เขียนอะไรลงฐาน — ใส่ --commit เพื่อเขียนจริง (${targets.length} บัญชี)`);
      return;
    }
    if (!targets.length) { console.log('\nไม่มีบัญชีที่ต้องเขียน'); return; }

    let done = 0;
    const failed = [];
    for (const u of targets) {
      try {
        await pool.request()
          .input('username', mssql.NVarChar(100), u.username)
          .input('hash', mssql.NVarChar(255), hashHrPassword(u.password))
          .input('branch', mssql.NVarChar(50), u.branch)
          .input('outletId', mssql.NVarChar(50), u.outletId)
          .query(
            `MERGE dbo.hr_user WITH (HOLDLOCK) AS t
               USING (SELECT @username AS username) AS s
                  ON t.username = s.username
             WHEN MATCHED THEN UPDATE SET
                  password_hash = @hash, branch = @branch,
                  outlet_id = NULLIF(@outletId, N''), updated_at = SYSDATETIME()
             WHEN NOT MATCHED THEN
                  INSERT (username, password_hash, branch, outlet_id)
                  VALUES (@username, @hash, @branch, NULLIF(@outletId, N''));`
          );
        done++;
      } catch (err) {
        // ⚠️ ห้ามให้ u หลุดลง log ทั้งก้อน — มี password อยู่ในนั้น
        failed.push({ username: u.username, message: err.message });
      }
    }

    console.log(`\nเขียนสำเร็จ ${done} บัญชี`);
    for (const f of failed) console.log(`  ไม่สำเร็จ ${f.username}: ${f.message}`);
    if (failed.length) process.exitCode = 1;

    console.log('\nต่อไป:');
    console.log('  1. เปิดหน้า HR > login สาขา เทียบว่าบัญชีครบทุกสาขาที่ยังเปิดอยู่');
    console.log('  2. ตั้ง SHEET_LOGIN_URL=off ใน .env ของ office-server แล้วรีสตาร์ท');
    console.log(`  3. ลบไฟล์ ${file} ทิ้ง (มีรหัสผ่านของทุกสาขาเป็นข้อความล้วน)`);
  } finally {
    await pool.close();
  }
}

try {
  await main();
} catch (err) {
  console.error('ล้มเหลว:', err.message);
  process.exitCode = 1;
}
