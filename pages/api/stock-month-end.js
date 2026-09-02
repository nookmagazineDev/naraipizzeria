// ข้อมูลปิดรอบเดือน — หน้า STOCK → "ดูข้อมูลปิดรอบเดือน" (ดูอย่างเดียว)
//
// ที่มา: dbo.stock_month_end ในฐาน InventoryNarai (ตารางที่มีอยู่ในฐานอยู่แล้ว)
//   ⚠️ คนละตัวกับ dbo.stock_closing ที่ /api/stock-closing ใช้เป็น "ยอดยกมา" ของหน้านับสต๊อก
//      ตัวนั้นย้ายมาจากชีท "ปิดรอบสิ้นเดือน" และคัดเฉพาะแถวล่าสุดของแต่ละไอเทม
//      ส่วนหน้านี้แสดงแถวปิดรอบของ "เดือนที่เลือก" ตามที่เก็บไว้จริงทั้งหมด
//
//   GET /api/stock-month-end?view=summary          -> สรุปรายสาขา: ปิดยอดล่าสุดถึงวันไหน (หน้าแรกของเมนู)
//   GET /api/stock-month-end?view=diag             -> ตรวจว่าขาไหนพัง (ต่อ SQL ตรง / host API / เวอร์ชัน host-server)
//   GET /api/stock-month-end                       -> เดือนล่าสุดที่มีข้อมูล ทุกสาขา
//   GET /api/stock-month-end?month=2026-08         -> เดือนที่ระบุ ทุกสาขา
//   GET /api/stock-month-end?month=2026-08&branch=CRM  -> เฉพาะสาขานั้น
//
// คืน: { status:'success', data: { month, months[], branches[], rows[], layout }, meta }
//   rows = [{ date, branch, itemCode, itemKey, itemName, unit, balance, unitValue, totalValue,
//             recordedBy, recordedAt }]  — ช่องที่ตารางไม่มีคอลัมน์ให้จะเป็นค่าว่าง/null
//   layout = คอลัมน์จริงในตาราง และคอลัมน์ไหนถูกใช้เป็นช่องอะไร (ไว้ไล่ดูเวลาชื่อไม่ตรง)
//
// ไม่มีทางถอยไปชีท — ข้อมูลชุดนี้ไม่เคยอยู่ในชีท ต่อฐานไม่ได้ = ตอบ error ให้หน้าเว็บขึ้นข้อความ
import { readMonthEnd, readMonthEndSummary, sqlRoute, SHEETS_API_BASE, hasDirectDb, describeTarget } from '../../lib/sheetsSource';
import { runQuery } from '../../lib/qcrdPool';

// ต่อ SQL ตรงไม่ติดจะรอ 15 วิ ก่อนถอยไปเรียก host API (ซึ่งรอได้อีก 20 วิ) — เกินเพดาน
// ค่าเริ่มต้น 10 วิของ Vercel ไปไกล ไม่ยืดตรงนี้จะโดนตัดกลางทางแล้วขึ้นเป็น error คนละเรื่อง
export const config = { maxDuration: 60 };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** จับเวลา + จับ error ของการตรวจหนึ่งอย่าง — ตัวไหนพังก็ไม่ล้มทั้งชุด */
async function timed(fn) {
  const t = Date.now();
  try { return { ok: true, ms: Date.now() - t, ...(await fn()) }; }
  catch (err) { return { ok: false, ms: Date.now() - t, error: err.message }; }
}

/** เรียก host API ดิบ ๆ — อยากได้ HTTP status กับเนื้อที่ตอบมาจริง ๆ ไม่ใช่แค่ error ที่แปลแล้ว */
async function hitHost(path, timeoutMs = 12000) {
  const res = await fetch(`${SHEETS_API_BASE}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* host-server เก่าตอบ HTML ('Cannot GET ...') */ }
  return { status: res.status, json: json ? undefined : text.slice(0, 120), body: json };
}

/**
 * ตรวจทีละขาแล้วบอกว่าต้องไปแก้ตรงไหน — ไม่มีรหัสผ่านหลุดออกไป
 * (ชื่อเครื่อง/ฐาน/ชื่อ env ที่ใช้ ก็โผล่ในข้อความ error บนหน้าเว็บอยู่แล้ว)
 */
async function diagnose() {
  const direct = hasDirectDb()
    ? await timed(async () => { await runQuery('SELECT 1 AS ok'); return {}; })
    : { ok: false, skipped: true, error: 'ยังไม่ได้ตั้ง QCRD_DB_USER/PASSWORD (หรือ ZK_DB_* / HR_DB_*) บน Vercel' };

  const [ping, summary] = await Promise.all([
    timed(() => hitHost('/sheets/ping')),
    timed(() => hitHost('/sheets/month-end-summary')),
  ]);

  const hostOld = ping.ok && summary.ok === false && /404/.test(String(summary.error || ''));
  const summary404 = ping.ok && summary.ok && summary.status === 404;

  let hint;
  if (direct.ok) {
    hint = 'ต่อ SQL ตรงได้ปกติ — หน้าเว็บควรใช้งานได้แล้ว ลองกดโหลดใหม่';
  } else if (summary.ok && summary.status === 200) {
    hint = 'ต่อ SQL ตรงไม่ได้ แต่ host API ใช้ได้ — หน้าเว็บจะถอยมาทางนี้เอง ลองกดโหลดใหม่';
  } else if (hostOld || summary404) {
    hint = 'host-server ที่เครื่องออฟฟิศเป็นเวอร์ชันเก่า (ยังไม่มี /sheets/month-end-summary) — ' +
      'ที่เครื่องนั้น: git pull แล้วรัน start-narai.ps1 -Restart (git pull เฉย ๆ ไม่พอ node ถือโค้ดเก่าอยู่)';
  } else if (!ping.ok) {
    hint = `เรียก ${SHEETS_API_BASE} ไม่ได้เลย — เครื่องออฟฟิศไม่ได้เปิด host-server อยู่ หรือ tunnel หลุด ` +
      'ที่เครื่องนั้นลองเปิด http://localhost:14365/sheets/ping ดูก่อน ถ้าได้แสดงว่า tunnel เป็นตัวที่หลุด';
  } else {
    hint = 'host API ตอบ แต่ /sheets/month-end-summary ยังใช้ไม่ได้ — ดูข้อความในช่อง summary ข้างบน';
  }

  return {
    direct: { configured: hasDirectDb(), target: hasDirectDb() ? describeTarget() : null, ...direct },
    host: { base: SHEETS_API_BASE, ping, summary },
    hint,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'GET เท่านั้น' });
  }

  const month = str(req.query.month);
  const branch = str(req.query.branch);
  const view = str(req.query.view).toLowerCase();

  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ status: 'error', message: `เดือน "${month}" ต้องเป็นรูปแบบ YYYY-MM เช่น 2026-08` });
  }

  try {
    // ปุ่ม "ตรวจการเชื่อมต่อ" บนหน้าเว็บ — ไล่ทีละขาแล้วบอกว่าต้องไปแก้ตรงไหน
    if (view === 'diag') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ status: 'success', data: await diagnose() });
    }

    // หน้าแรกของเมนูถามแค่ "สาขาไหนปิดยอดถึงวันไหนแล้ว" — สรุปที่ฐาน ไม่ต้องลากรายไอเทมมาทั้งเดือน
    if (view === 'summary') {
      const data = await readMonthEndSummary();
      res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
      return res.status(200).json({
        status: 'success',
        data,
        meta: { view: 'summary', branches: data.branches.length, latestDate: data.latestDate, source: data.source },
      });
    }

    const data = await readMonthEnd({ month, branch: branch.toLowerCase() === 'all' ? '' : branch });

    // ปิดรอบเดือนที่ปิดไปแล้วไม่เปลี่ยนอีก — ให้ CDN ตอบซ้ำได้สักพัก แต่ยังสั้นพอให้เดือนที่เพิ่งปิดขึ้นเร็ว
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({
      status: 'success',
      data,
      meta: {
        month: data.month,
        branch: branch || 'all',
        rows: data.rows.length,
        months: data.months.length,
        // ทางที่ใช้ได้จริง (ต่อ SQL ตรง หรือถอยมา host API) — ไม่ใช่ทางที่ตั้งใจจะใช้
        source: data.source || sqlRoute(),
      },
    });
  } catch (error) {
    console.error('stock-month-end error:', error.message);
    return res.status(error.badRequest ? 400 : 502).json({ status: 'error', message: error.message });
  }
}
