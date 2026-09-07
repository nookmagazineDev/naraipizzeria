// ร้านเฟรนไชส์ — ข้อมูลจากฐาน "Aoringo" บน SQL Server 203.154.185.48 (เครื่องเดียวกับ InventoryNarai)
//
//   GET /api/franchise?view=sales&start=YYYY-MM-DD&end=YYYY-MM-DD    -> บิลขาย (ตารางแบบ Cpaid)
//   GET /api/franchise?view=detail&start=…&end=…                     -> รายการสินค้าในบิล (แบบ Ctrans)
//   GET /api/franchise?view=expense&start=…&end=…                    -> รายจ่าย
//   GET /api/franchise?view=all&start=…&end=…                        -> ทั้งสามชุดในครั้งเดียว (หน้าเว็บใช้ตัวนี้)
//   GET /api/franchise?view=schema                                   -> ตาราง/คอลัมน์ที่จับคู่ได้ในฐาน
//   GET /api/franchise?view=diag                                     -> ต่อฐานได้ไหม ทางไหนพัง
//
// เพิ่ม &outlet=… กรองสาขาได้ถ้าตารางนั้นมีคอลัมน์สาขา · &limit=… ปรับเพดานแถวได้
//
// view=all ยอมให้ "รายจ่าย" พังเดี่ยว ๆ ได้ (บางฐานไม่มีตารางรายจ่ายเลย) โดยแนบ warning กลับไป
// แทนที่จะล้มทั้งหน้า — ยอดขายเป็นข้อมูลหลักของเมนูนี้ ขาดรายจ่ายก็ยังดูได้
import { readBills, readItems, readExpenses, readLayout, ping, hasDirectDb, describeTarget, AORINGO_API_BASE }
  from '../../lib/aoringoSource';

// ดึงบิลทั้งเดือนผ่าน tunnel กินเวลามากกว่าเพดาน 10 วิของ Vercel ไปไกล
export const config = { maxDuration: 60 };

const bad = (res, msg) => res.status(400).json({ status: 'error', message: msg });

/** ช่วงวันที่ที่รับมา — ต้องครบและถูกรูปแบบก่อนยิงคำสั่ง */
function range(req) {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  return { start, end, outlet: String(req.query.outlet || '').trim(), limit: req.query.limit };
}

export default async function handler(req, res) {
  const view = String(req.query.view || 'all').toLowerCase();

  try {
    if (view === 'schema') {
      const { data, route } = await readLayout();
      return res.status(200).json({ status: 'success', data, meta: { source: route } });
    }

    if (view === 'diag') {
      // ตรวจว่าขาไหนพัง — ไม่มีรหัสผ่านหลุดออกไป (ชื่อเครื่อง/ฐาน/ชื่อ env ที่ใช้ โผล่ใน error อยู่แล้ว)
      const t = Date.now();
      try {
        const { data, route } = await ping();
        return res.status(200).json({
          status: 'success',
          data: { ok: true, ms: Date.now() - t, route, ...data },
          meta: { directConfigured: hasDirectDb(), directTarget: describeTarget(), hostBase: AORINGO_API_BASE },
        });
      } catch (err) {
        return res.status(200).json({
          status: 'success',
          data: { ok: false, ms: Date.now() - t, error: err.message },
          meta: {
            directConfigured: hasDirectDb(),
            directTarget: describeTarget(),
            hostBase: AORINGO_API_BASE,
            hint: hasDirectDb()
              ? 'ต่อตรงไม่ติดและ host API ก็ไม่ตอบ — ที่เครื่องออฟฟิศลองเปิด http://localhost:14365/aoringo/ping ' +
                'ถ้าได้แปลว่า tunnel หลุด ถ้าไม่ได้แปลว่า host-server ยังไม่ได้รันโค้ดใหม่ (start-narai.ps1 -Restart)'
              : 'ยังไม่ได้ตั้ง AORINGO_DB_USER/PASSWORD (หรือ QCRD_DB_* / ZK_DB_* / HR_DB_*) บน Vercel ' +
                'จึงเหลือแค่ทาง host API',
          },
        });
      }
    }

    const r = range(req);
    if (!r) return bad(res, 'ต้องส่ง start และ end เป็นวันที่รูปแบบ YYYY-MM-DD');

    if (view === 'sales' || view === 'bills') {
      const { data, route } = await readBills(r);
      return res.status(200).json({ status: 'success', data, meta: { source: route } });
    }
    if (view === 'detail' || view === 'items') {
      const { data, route } = await readItems(r);
      return res.status(200).json({ status: 'success', data, meta: { source: route } });
    }
    if (view === 'expense' || view === 'expenses') {
      const { data, route } = await readExpenses(r);
      return res.status(200).json({ status: 'success', data, meta: { source: route } });
    }

    if (view === 'all') {
      // ยอดขาย (บิล+รายการ) ต้องได้ครบ ไม่งั้นแทบทุกหน้าย่อยว่างเปล่า → พังก็ให้พังทั้งคำขอ
      const [bills, items] = await Promise.all([readBills(r), readItems(r)]);
      // รายจ่ายขาดได้ — บางฐานไม่มีตารางรายจ่ายเลย แนบ warning ให้หน้าเว็บขึ้นข้อความแทน
      let expenses = null;
      let expenseError = '';
      try {
        expenses = await readExpenses(r);
      } catch (err) {
        expenseError = err.message;
      }
      return res.status(200).json({
        status: 'success',
        data: {
          range: { start: r.start, end: r.end },
          bills: bills.data.rows,
          items: items.data.rows,
          expenses: expenses ? expenses.data.rows : [],
          layout: {
            bill: { table: bills.data.table, dateColumn: bills.data.dateColumn, missing: bills.data.missing },
            item: { table: items.data.table, dateColumn: items.data.dateColumn, missing: items.data.missing },
            expense: expenses
              ? { table: expenses.data.table, dateColumn: expenses.data.dateColumn, missing: expenses.data.missing }
              : null,
          },
        },
        meta: { source: bills.route, expenseError },
      });
    }

    return bad(res, `ไม่รู้จัก view=${view} (ใช้ได้: all | sales | detail | expense | schema | diag)`);
  } catch (err) {
    console.error('franchise API error:', err.message);
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
