// map: รหัสวัตถุดิบ (ตัด 0 นำหน้า) -> รายชื่อเมนูที่ใช้วัตถุดิบนั้น
//
// ที่มาเดิม: ชีท 1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg แท็บ RcpDtls (สูตรฝั่ง POS)
//   คอลัมน์ A: รหัสเมนู | C: ชื่อเมนู | E: รหัสวัตถุดิบ
// ที่มาใหม่ (QCRD_SOURCE=sql): dbo.qcrd_bom — สูตรชุดที่หน้า QC/RD กับหน้ายอดใช้วัตถุดิบใช้จริง
//   ชีท RcpDtls หยุดอัปเดตไปแล้ว ส่วน BOM ยังถูกแก้ทุกครั้งที่บันทึกสูตรจากหน้าเว็บ
//   ทั้งสองทางคืนโครงเดียวกัน หน้าเว็บจึงไม่ต้องแก้อะไร
import { usingSql, fetchQcrdSql, sqlRoute } from '../../lib/qcrdSource';

const SHEET_ID = '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg';
const SHEET_NAME = 'RcpDtls';

const COL_MENU_CODE = 0;  // A
const COL_MENU_NAME = 2;  // C
const COL_ITEM_CODE = 4;  // E

function normalizeId(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
}

/** { รหัสวัตถุดิบ: Set(ชื่อเมนู) } -> { รหัสวัตถุดิบ: [ชื่อเมนูเรียงตามตัวอักษรไทย] } */
function toSortedLists(menuSets) {
  const data = {};
  Object.keys(menuSets).forEach(key => {
    data[key] = Array.from(menuSets[key]).sort((a, b) => a.localeCompare(b, 'th'));
  });
  return data;
}

async function recipeFromSheet() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}`;
  const fetchRes = await fetch(url);
  if (!fetchRes.ok) throw new Error(`Google Sheet Error: ${fetchRes.status}`);

  const text = await fetchRes.text();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('รูปแบบข้อมูลจาก Google Sheet ไม่ถูกต้อง');

  const parsed = JSON.parse(text.substring(start, end + 1));
  const rows = (parsed.table && parsed.table.rows) ? parsed.table.rows : [];

  const menuSets = {};
  rows.forEach(row => {
    const c = row.c;
    if (!c) return;

    // ข้ามแถวหัวตาราง/หมายเหตุ: ต้องมีรหัสเมนู (คอลัมน์ A) เป็นตัวเลข
    const menuCodeCell = c[COL_MENU_CODE];
    const menuCode = menuCodeCell && menuCodeCell.v != null ? menuCodeCell.v : null;
    if (menuCode === null || isNaN(Number(menuCode))) return;

    const menuName = c[COL_MENU_NAME] && c[COL_MENU_NAME].v != null
      ? String(c[COL_MENU_NAME].v).trim() : '';
    const rawItem = c[COL_ITEM_CODE] && c[COL_ITEM_CODE].v != null ? c[COL_ITEM_CODE].v : null;
    if (!menuName || rawItem === null) return;

    const normId = normalizeId(rawItem);
    if (!normId) return;

    if (!menuSets[normId]) menuSets[normId] = new Set();
    menuSets[normId].add(menuName);
  });

  return toSortedLists(menuSets);
}

async function recipeFromSql() {
  const bom = await fetchQcrdSql('bom');   // { รหัสเมนู: { name, items: [{ itemCode, ... }] } }
  const menuSets = {};
  Object.values(bom).forEach(menu => {
    const menuName = String(menu?.name || '').trim();
    if (!menuName) return;
    (menu.items || []).forEach(it => {
      const normId = normalizeId(it.itemCode);
      if (!normId) return;
      if (!menuSets[normId]) menuSets[normId] = new Set();
      menuSets[normId].add(menuName);
    });
  });
  return toSortedLists(menuSets);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (usingSql()) {
      try {
        return res.status(200).json({ status: 'success', data: await recipeFromSql() });
      } catch (err) {
        console.error(`Recipe API: อ่าน SQL ไม่ได้ (${sqlRoute()}) — ถอยไปอ่านชีท:`, err.message);
      }
    }
    return res.status(200).json({ status: 'success', data: await recipeFromSheet() });
  } catch (error) {
    console.error('Recipe API error:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
