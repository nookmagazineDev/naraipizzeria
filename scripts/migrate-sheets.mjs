// ════════════════════════════════════════════════════════════
//  ย้าย แพลนสั่งของ · ปิดรอบสิ้นเดือน · ค่าใช้จ่ายอื่นๆ · พนักงาน จาก Google Sheets -> SQL Server
//  รันจากเครื่องที่ต่อ SQL Server ได้ (ปกติคือเครื่องออฟฟิศ ต่อ localhost\SQLEXPRESS)
//
//  วิธีใช้
//    node scripts/migrate-sheets.mjs --inspect          สำรวจต้นทาง ไม่แตะฐานข้อมูล
//    node scripts/migrate-sheets.mjs --dry-run          อ่านครบ แปลงครบ แต่ไม่เขียน
//    node scripts/migrate-sheets.mjs                    ย้ายจริงทุกชุด
//    node scripts/migrate-sheets.mjs --only=plan,expense ย้ายเฉพาะบางชุด
//    node scripts/migrate-sheets.mjs --verify           เทียบจำนวนต้นทาง ↔ SQL
//
//  ชุดข้อมูล: plan · closing · expenseref · expense · employee
//
//  ทำไมต้องมีตัวนี้ทั้งที่มี /api/sheets-migrate อยู่แล้ว
//    endpoint นั้นให้ Vercel เป็นคนย้าย ซึ่งต้องต่อ SQL ตรงได้ — ที่ร้านตอนนี้ SQL ไม่ได้เปิด
//    พอร์ตออกเน็ต (probe แล้วปิดหมดทุกพอร์ต) จึงต้องย้ายจากเครื่องที่อยู่ในวงเดียวกับฐานแทน
//
//  ค่าเชื่อมต่อฐานข้อมูลใช้ชุดเดียวกับฝั่ง QC/RD (scripts/qcrdDb.mjs) ไม่ต้องตั้ง env ใหม่
//  ปลอดภัยที่จะรันซ้ำ — ทุกชุดเขียนแบบ MERGE (มีอยู่แล้วทับของเดิม ไม่มีค่อยเพิ่ม)
// ════════════════════════════════════════════════════════════
import process from 'node:process';
import { openPool, describeTarget } from './qcrdDb.mjs';
import {
  fetchPlanRows, fetchClosingRows, fetchExpenseRefs, fetchExpenses, fetchEmployees,
} from '../lib/sheetsSheet.mjs';
import {
  mapPlan, mapClosing, mapExpenseRefs, mapExpenses, mapEmployees,
  planStmt, closingStmt, expenseRefStmt, expenseStmt, employeeStmt,
} from '../lib/sheetsMigrate.mjs';

const SETS = {
  plan: {
    label: 'แพลนสั่งของ', table: 'dbo.stock_plan',
    read: fetchPlanRows, map: mapPlan, stmt: planStmt,
  },
  closing: {
    label: 'ปิดรอบสิ้นเดือน', table: 'dbo.stock_closing',
    read: () => fetchClosingRows('full'), map: mapClosing, stmt: closingStmt,
  },
  expenseref: {
    label: 'รหัสค่าใช้จ่าย', table: 'dbo.expense_ref',
    read: fetchExpenseRefs, map: mapExpenseRefs, stmt: expenseRefStmt,
  },
  expense: {
    label: 'ค่าใช้จ่ายอื่นๆ', table: 'dbo.expense_entry',
    read: fetchExpenses, map: mapExpenses, stmt: expenseStmt,
  },
  employee: {
    label: 'พนักงาน', table: 'dbo.hr_employee',
    read: fetchEmployees, map: mapEmployees, stmt: employeeStmt,
  },
};

const ORDER = ['plan', 'closing', 'expenseref', 'expense', 'employee'];

// SQL Server รับได้ 2100 พารามิเตอร์ต่อคำสั่ง — เผื่อไว้ที่ 2000
const PARAM_LIMIT = 2000;

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const valueOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const INSPECT = has('inspect');
const DRY = has('dry-run');
const VERIFY = has('verify');
const only = valueOf('only').split(',').map((s) => s.trim()).filter(Boolean);
const chosen = only.length ? only : ORDER;

const bad = chosen.filter((k) => !SETS[k]);
if (bad.length) {
  console.error(`❌ ไม่รู้จักชุดข้อมูล: ${bad.join(', ')} — ใช้ได้: ${ORDER.join(', ')}`);
  process.exit(1);
}

const n = (x) => x.toLocaleString('en-US');

/** อ่านต้นทาง + แปลงเป็นเรคคอร์ด พร้อมพิมพ์สถิติที่ตัวแปลงตรวจเจอ */
async function load(key) {
  const set = SETS[key];
  process.stdout.write(`   อ่าน ${set.label} ... `);
  const rows = await set.read();
  const mapped = set.map(rows);
  console.log(`ต้นทาง ${n(rows.length)} แถว → เขียนได้ ${n(mapped.rows.length)} แถว`);
  Object.entries(mapped.stats || {}).forEach(([k, v]) => {
    if (v) console.log(`      · ${k}: ${n(v)}`);
  });
  return mapped;
}

/** ยิงทีละก้อน โดยรวมหลายแถวเป็นคำสั่งเดียวเท่าที่พารามิเตอร์ยังไม่เกินลิมิต */
async function writeAll(pool, records, buildStmt, label) {
  let done = 0;
  let batches = 0;
  while (done < records.length) {
    const stmts = [];
    let params = 0;
    while (done + stmts.length < records.length) {
      const stmt = buildStmt(records[done + stmts.length], `_${stmts.length}`);
      const count = Object.keys(stmt.params).length;
      if (stmts.length && params + count > PARAM_LIMIT) break;
      stmts.push(stmt);
      params += count;
    }
    const req = pool.request();
    const text = stmts.map((s) => s.text).join('\n');
    Object.entries(Object.assign({}, ...stmts.map((s) => s.params)))
      .forEach(([k, v]) => req.input(k, v === undefined ? null : v));
    await req.query(text);
    done += stmts.length;
    batches++;
    process.stdout.write(`\r   เขียน ${label} ... ${n(done)}/${n(records.length)}`);
  }
  console.log(`\r   เขียน ${label} ... ${n(done)}/${n(records.length)} เสร็จ (${batches} ก้อน)`);
  return done;
}

async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  ย้ายข้อมูลจาก Google Sheets -> SQL Server');
  console.log(`  ชุดที่ทำ: ${chosen.join(', ')}`);
  if (!INSPECT) console.log(`  ปลายทาง: ${describeTarget()}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('');

  // --inspect ไม่แตะฐานเลย จะได้ดูตัวเลขก่อนโดยไม่ต้องมีรหัสฐานข้อมูล
  if (INSPECT) {
    for (const key of chosen) await load(key);
    console.log('\n✅ สำรวจเสร็จ — ยังไม่ได้เขียนอะไรลงฐานข้อมูล');
    return;
  }

  const pool = await openPool();
  try {
    if (VERIFY) {
      console.log('   เทียบจำนวน ต้นทาง ↔ SQL\n');
      let ready = true;
      for (const key of chosen) {
        const set = SETS[key];
        const mapped = set.map(await set.read());
        const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${set.table}`);
        const inSql = Number(r.recordset[0]?.n) || 0;
        const ok = inSql >= mapped.rows.length;
        if (!ok) ready = false;
        console.log(`   ${ok ? '✅' : '❌'} ${set.label.padEnd(18)} ต้นทาง ${n(mapped.rows.length).padStart(8)}  SQL ${n(inSql).padStart(8)}`);
      }
      console.log(ready ? '\n✅ ครบทุกชุด' : '\n❌ ยังไม่ครบ — ย้ายชุดที่ขาดซ้ำอีกรอบ');
      if (!ready) process.exitCode = 1;
      return;
    }

    for (const key of chosen) {
      const set = SETS[key];
      const mapped = await load(key);
      if (DRY) {
        console.log(`   (--dry-run) ข้ามการเขียน ${set.table}\n`);
        continue;
      }
      await writeAll(pool, mapped.rows, set.stmt, set.label);
      console.log('');
    }

    console.log(DRY
      ? '✅ ทดลองเสร็จ — ยังไม่ได้เขียนอะไรลงฐานข้อมูล'
      : '✅ ย้ายข้อมูลเสร็จแล้ว — ตรวจซ้ำด้วย --verify ได้');
  } finally {
    await pool.close().catch(() => { /* ปิดไม่ได้ก็ไม่มีอะไรให้ทำต่อ */ });
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
