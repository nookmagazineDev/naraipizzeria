// แผนที่หมวดหมู่เมนู: itemCode → ชื่อหมวด
// คืน { "202013": "ครัวอบ ของทอด", ... } (แมตช์รายการขายจริงได้ ~100%)
//
// ที่มาเดิมคือชีทต้นทุนเมนู 1v8WRT… 2 แท็บ:
//   menu (gid=0)                   : A=Code  C=MenuCode   → itemCode ได้ MenuCode
//   menucodegroup (gid=1491689317) : A=code  B=name       → MenuCode ได้ชื่อหมวด
// ทั้งสองแท็บย้ายเข้า SQL แล้ว (dbo.qcrd_menu + dbo.qcrd_menu_group) และตัวอ่านฝั่ง SQL
// join ให้เสร็จตั้งแต่ในฐาน (readMenus คืน groupName มาด้วย) จึงเหลือการอ่านรอบเดียว
import { usingSql, fetchQcrdSql, sqlRoute } from '../../lib/qcrdSource';
import { fetchSheet } from '../../lib/upstream.mjs';

const SHEET_ID = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';
const GID_MENU = '0';
const GID_GROUP = '1491689317';

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function csv(gid) {
  const r = await fetchSheet(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`);
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status} (gid ${gid})`);
  return parseCSV(await r.text());
}

// รหัสซ้ำใช้ค่าแรก + เก็บทั้งแบบมี/ไม่มีศูนย์นำหน้า (ระบบคลังใช้ 0 นำหน้า)
function put(map, code, name) {
  if (!code || !name) return;
  if (!(code in map)) map[code] = name;
  const stripped = code.replace(/^0+/, '');
  if (stripped && !(stripped in map)) map[stripped] = name;
}

async function groupsFromSheet() {
  const [menuRows, groupRows] = await Promise.all([csv(GID_MENU), csv(GID_GROUP)]);

  const groupName = {};
  groupRows.slice(1).forEach(r => {
    const code = (r[0] || '').trim();
    if (code) groupName[code] = (r[1] || '').trim();
  });

  const map = {};
  menuRows.slice(1).forEach(r => {
    put(map, (r[0] || '').trim(), groupName[(r[2] || '').trim()]);
  });
  return map;
}

async function groupsFromSql() {
  const menus = await fetchQcrdSql('menu');
  const map = {};
  menus.forEach(m => put(map, String(m.code || '').trim(), String(m.groupName || '').trim()));
  return map;
}

export default async function handler(req, res) {
  try {
    if (usingSql()) {
      try {
        return res.status(200).json(await groupsFromSql());
      } catch (err) {
        console.error(`Menu group API: อ่าน SQL ไม่ได้ (${sqlRoute()}) — ถอยไปอ่านชีท:`, err.message);
      }
    }
    res.status(200).json(await groupsFromSheet());
  } catch (err) {
    console.error('Menu group API error:', err.message);
    res.status(502).json({ error: err.message });
  }
}
