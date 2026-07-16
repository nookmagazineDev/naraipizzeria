// แผนที่หมวดหมู่เมนู: itemCode → ชื่อหมวด
// host API ไม่ส่ง menuCode มา จึงต่อจากชีทต้นทุนเมนู 2 แท็บ:
//   menu (gid=0)            : A=Code  C=MenuCode          → itemCode ได้ MenuCode
//   menucodegroup (gid=1491689317) : A=code B=name        → MenuCode ได้ชื่อหมวด
// คืน { "202013": "ครัวอบ ของทอด", ... } (แมตช์รายการขายจริงได้ ~100%)

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
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status} (gid ${gid})`);
  return parseCSV(await r.text());
}

export default async function handler(req, res) {
  try {
    const [menuRows, groupRows] = await Promise.all([csv(GID_MENU), csv(GID_GROUP)]);

    const groupName = {};
    groupRows.slice(1).forEach(r => {
      const code = (r[0] || '').trim();
      if (code) groupName[code] = (r[1] || '').trim();
    });

    const map = {};
    menuRows.slice(1).forEach(r => {
      const code = (r[0] || '').trim();
      const menuCode = (r[2] || '').trim();
      if (!code || !menuCode) return;
      const name = groupName[menuCode];
      if (!name) return;
      // รหัสซ้ำใช้ค่าแรก + เก็บทั้งแบบมี/ไม่มีศูนย์นำหน้า (ระบบคลังใช้ 0 นำหน้า)
      if (!(code in map)) map[code] = name;
      const stripped = code.replace(/^0+/, '');
      if (stripped && !(stripped in map)) map[stripped] = name;
    });

    res.status(200).json(map);
  } catch (err) {
    console.error('Menu group API error:', err.message);
    res.status(502).json({ error: err.message });
  }
}
