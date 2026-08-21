// ยอดยกมา (Endding) = ยอดปิดรอบสิ้นเดือน "ล่าสุด" ของแต่ละสาขา แต่ละไอเทม
//
// ที่มาเดิม: ชีท "ปิดรอบสิ้นเดือน" ในสมุดงานสต๊อก 1xegMu… (แชร์แบบ anyone-with-link อ่านได้)
// ที่มาใหม่ (SHEETS_SOURCE=sql): dbo.stock_closing ในฐาน InventoryNarai
//   ฝั่ง SQL ให้ฐานคัดแถวล่าสุดมาให้เลย ไม่ต้องลากทั้งชีทมาคัดที่ Vercel ทุกครั้ง
//
// คืนรูปแบบ: { status:'success', data: { <รหัสสินค้าตัด 0 นำหน้า>: { balance, date, unit, recordedAt } } }
import { fetchClosingRows } from '../../lib/sheetsSheet';
import { usingSql, readClosing, describeTarget } from '../../lib/sheetsSource';

/** คัดเฉพาะรายการล่าสุดของแต่ละไอเทมจากแถวดิบในชีท (เรียงตาม วันที่ปิดยอด > เวลาบันทึก > ลำดับแถว) */
function latestFromSheetRows(rows, branchKey) {
  const latest = {};
  rows.forEach(row => {
    if (row.branch !== branchKey) return;
    const cur = latest[row.itemId];
    if (!cur || row.sortKey > cur.sortKey) latest[row.itemId] = row;
  });

  const data = {};
  let latestDate = '';
  Object.entries(latest).forEach(([itemId, row]) => {
    data[itemId] = {
      balance: Number(row.balance.toFixed(2)),
      date: row.date,
      unit: row.unit,
      recordedAt: row.recordedAt,
    };
    if (row.date > latestDate) latestDate = row.date;
  });
  return { data, latestDate };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch } = req.query;
  if (!branch) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขาไม่ครบถ้วน' });
  }

  const branchKey = String(branch).trim().toLowerCase();
  if (branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: {} });
  }

  try {
    let source = 'sheet';
    let warning = '';
    let result = null;

    if (usingSql()) {
      try {
        result = await readClosing(branchKey);
        source = 'sql';
      } catch (err) {
        console.error(`stock-closing: อ่าน SQL ไม่ได้ (${describeTarget()}) — ถอยไปอ่านชีท:`, err.message);
        warning = `อ่านจาก SQL ไม่ได้ (${err.message}) — ข้อมูลชุดนี้มาจากชีท`;
      }
    }
    if (!result) result = latestFromSheetRows(await fetchClosingRows('lite'), branchKey);

    // ยอดปิดรอบเปลี่ยนแค่ตอนสิ้นเดือน — ให้ CDN ตอบซ้ำได้เลย ไม่ต้องวิ่งไปอ่านต้นทางทุกครั้ง
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({
      status: 'success',
      data: result.data,
      meta: { branch: branchKey, items: Object.keys(result.data).length, latestDate: result.latestDate, source },
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    console.error('stock-closing error:', error.message);
    return res.status(502).json({ status: 'error', message: error.message });
  }
}
