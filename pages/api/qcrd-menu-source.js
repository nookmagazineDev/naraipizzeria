// ทะเบียนเมนูของ POS ฐานอื่น — ให้หน้า QC/RD > เมนู หยิบมาเพิ่มเข้าทะเบียนหลัก
//
//   GET /api/qcrd-menu-source?schema=1              ต้นทางไหนอ่านได้บ้าง + จับคู่คอลัมน์ได้อะไร
//   GET /api/qcrd-menu-source?src=aoringo&q=ไก่     ค้นเมนูในต้นทางนั้น (ค้นที่ฝั่ง SQL)
//
// อ่านอย่างเดียว — การบันทึกยังไปทาง /api/qcrd-save action saveMenu เหมือนการเพิ่มเมนูปกติ
// จึงไม่มีทางเขียนใหม่ให้ต้องดูแล และได้ทั้งโหมดชีทและโหมด SQL ฟรี ๆ
//
// ทางไปถึงฐาน: ต่อ SQL ตรงก่อน ต่อไม่ติดถอยไป host API (เหมือน /api/qcrd ทุกประการ)
export const config = { maxDuration: 30 };

import { fetchMenuSource, fetchMenuSourceSchema, QCRD_API_BASE } from '../../lib/qcrdSource';
import { bentoSchema, bentoSearch } from '../../lib/bentoMenuSheet';

// ต้นทางบน SQL — ใช้ตอนอ่าน schema ฝั่ง SQL ไม่ได้ทั้งก้อน แท็บจะได้ยังขึ้นครบพร้อมเหตุผล
const SQL_TABS = [
  { id: 'aoringo', label: 'Aoringo', prefix: 'AO' },
  { id: 'humlai', label: 'HumlaiPOS', prefix: 'HM', codeMode: 'running6' },
  { id: 'naraipos', label: 'NaraiPos', prefix: '' },
];

/** host-server รุ่นก่อนหน้านี้ยังไม่มีเส้น /qcrd/menu-source — express ตอบ 404 เป็นหน้า HTML
 *  ซึ่งอ่านแล้วนึกว่า tunnel พัง ทั้งที่แค่ยังไม่ได้รีสตาร์ต node หลัง git pull */
const explain = (err) => {
  const msg = err?.message || 'อ่านทะเบียนเมนูของฐานอื่นไม่ได้';
  if (/HTTP 404|ตอบไม่ใช่ JSON \(HTTP 404\)|Cannot GET/i.test(msg)) {
    return `${msg}\n→ เครื่องที่ ${QCRD_API_BASE} ยังไม่มีเส้น /qcrd/menu-source — ที่เครื่องออฟฟิศต้อง ` +
      'git pull แล้วรีสตาร์ต host-server (host-server\\start-narai.ps1 -Restart -NoTunnel)';
  }
  return msg;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (String(req.query.schema || '') === '1') {
      const fresh = String(req.query.fresh || '') === '1';
      // ข้าวกล่องอ่านจาก Google Sheet ไม่ผ่าน SQL — ฐานที่ร้านต่อไม่ติดก็ยังต้องใช้แท็บนี้ได้
      const [sql, bento] = await Promise.allSettled([fetchMenuSourceSchema({ fresh }), bentoSchema({ fresh })]);
      const sqlTabs = sql.status === 'fulfilled'
        ? sql.value
        : SQL_TABS.map(t => ({ ...t, codeMode: t.codeMode || 'source', ok: false, error: explain(sql.reason) }));
      return res.status(200).json({ status: 'success', data: [...sqlTabs, bento.value] });
    }

    const src = String(req.query.src || '').trim();
    if (!src) {
      return res.status(400).json({ status: 'error', message: 'ต้องส่ง ?src= (aoringo | humlai | naraipos | bento) หรือ ?schema=1' });
    }

    const opts = {
      q: String(req.query.q || '').trim(),
      limit: Number(req.query.limit) || 50,
      includeInactive: String(req.query.includeInactive || '') === '1',
    };
    if (src === 'bento') {
      return res.status(200).json({ status: 'success', data: await bentoSearch(opts) });
    }

    const data = await fetchMenuSource(src, {
      q: String(req.query.q || '').trim(),
      limit: Number(req.query.limit) || 50,
      includeInactive: String(req.query.includeInactive || '') === '1',
    });
    return res.status(200).json({ status: 'success', data });
  } catch (err) {
    console.error('qcrd-menu-source error:', err?.message);
    // คืน 200 พร้อม status:'error' แบบเดียวกับ API อื่นของ QC/RD — หน้าเว็บอ่าน message ไปแสดงตรง ๆ
    return res.status(200).json({ status: 'error', message: explain(err) });
  }
}
