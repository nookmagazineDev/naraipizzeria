// QC/RD — อ่านข้อมูลจากชีทต้นทุนเมนู (1v8WRT…) 3 แท็บ: menu / BOM / item
// อ่านผ่าน gviz CSV (ชีทเป็น public) — ส่วน "เขียน" ใช้ /api/qcrd-gas (Apps Script)
const SHEET_ID = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';

function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ---------- วิเคราะห์หน่วยจากชื่อวัตถุดิบ ----------
// ชื่อในชีท item มักลงท้ายด้วยหน่วยซื้อ เช่น "...(1ถุง/1กก.) กก." หรือ "...(กิโล)"
const UNIT_ALIASES = [
  // [canonical, patterns...] เรียงจากยาวไปสั้นกันจับผิดคำ
  ['กระป๋อง', 'กระป๋อง', 'กป.', 'กป'],
  ['กระสอบ', 'กระสอบ', 'กส.', 'กส'],
  ['กระปุก', 'กระปุก'],
  ['แกลลอน', 'แกลลอน', 'แกลอน'],
  ['กล่อง', 'กล่อง', 'กล.'],
  ['กิโลกรัม', 'กิโลกรัม'],
  ['กก.', 'กก.', 'กก', 'กิโล', 'kg', 'KG', 'Kg'],
  ['กรัม', 'กรัม'],
  ['ลิตร', 'ลิตร'],
  ['มล.', 'มล.', 'ml', 'ML', 'ซีซี', 'cc', 'CC'],
  ['แพ็ค', 'แพ็ค', 'แพ๊ค', 'แพค', 'แพ็ก', 'แพ๊ก', 'pack', 'PACK', 'Pack'],
  ['ถ้วย', 'ถ้วย'],
  ['ถุง', 'ถุง'], ['ซอง', 'ซอง'], ['ขวด', 'ขวด'], ['ชิ้น', 'ชิ้น'],
  ['ที่', 'ที่'], ['ใบ', 'ใบ'], ['ม้วน', 'ม้วน'], ['แผ่น', 'แผ่น'],
  ['ฝา', 'ฝา'], ['ถัง', 'ถัง'], ['ถาด', 'ถาด'], ['ลัง', 'ลัง'],
  ['หัว', 'หัว'], ['ลูก', 'ลูก'], ['ต้น', 'ต้น'], ['เส้น', 'เส้น'],
  ['อัน', 'อัน'], ['คู่', 'คู่'], ['ชุด', 'ชุด'], ['โหล', 'โหล'],
  ['ตัว', 'ตัว'], ['แท่ง', 'แท่ง'], ['กำ', 'กำ'], ['มัด', 'มัด'],
  ['ก้อน', 'ก้อน'], ['เม็ด', 'เม็ด'], ['ขีด', 'ขีด'], ['ราง', 'ราง'],
  ['ดวง', 'ดวง'], ['แกน', 'แกน'],
];

function matchUnit(text) {
  if (!text) return '';
  let t = String(text).trim().replace(/[()\s]+$/g, '').replace(/^[()\s]+/g, '');
  // ภาษาอังกฤษท้ายชื่อมักมีจุดปิด เช่น "kg." / "PACK." — ตัดจุดท้ายถ้าไม่ใช่คำไทย
  if (/[a-zA-Z]\.+$/.test(t)) t = t.replace(/\.+$/, '');
  for (const [canon, ...pats] of UNIT_ALIASES) {
    for (const p of pats) {
      // ต้องลงท้ายด้วยคำนั้น (กันจับ "ที่" กลางคำ เช่น "5ที่/ถุง" ให้ผ่านขั้นตอนอื่นแทน)
      if (t === p || t.endsWith(p)) {
        // กันคำไทยติดกันผิดความหมาย: ตัวอักษรก่อนหน้าต้องไม่ใช่พยัญชนะไทยที่ทำให้เป็นคนละคำ
        const before = t[t.length - p.length - 1];
        if (before === undefined || /[\d\s().\/\-_"']/.test(before) || p.length >= 3) return canon;
      }
    }
  }
  return '';
}

export function inferUnit(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  // 1) ส่วนท้ายหลังวงเล็บสุดท้าย เช่น "...(1ถุง/1กก.) กก." → "กก."
  const lastClose = n.lastIndexOf(')');
  if (lastClose >= 0 && lastClose < n.length - 1) {
    const u = matchUnit(n.slice(lastClose + 1));
    if (u) return u;
  }
  // 2) token สุดท้าย เช่น "กระเทียมปอกขาว กก."
  const tokens = n.split(/\s+/);
  const u2 = matchUnit(tokens[tokens.length - 1]);
  if (u2) return u2;
  // 3) ในวงเล็บสุดท้าย หลังเครื่องหมาย / เช่น "(0.5กก./แพ็ค)" → "แพ็ค"
  const paren = n.match(/\(([^()]*)\)[^()]*$/);
  if (paren) {
    const inside = paren[1];
    const afterSlash = inside.split('/').pop();
    const u3 = matchUnit(afterSlash.replace(/[\d.]+/g, ''));
    if (u3) return u3;
    const u3b = matchUnit(inside.replace(/[\d.\/]+/g, ' ').trim().split(/\s+/).pop());
    if (u3b) return u3b;
  }
  // 4) วงเล็บท้ายแบบไม่มี / เช่น "(กิโล)" ถูกจับใน 3 แล้ว — สุดท้ายลองทั้งชื่อจากหลังมาหน้า
  for (let i = tokens.length - 1; i >= 0; i--) {
    const u4 = matchUnit(tokens[i].replace(/[\d.\/()]+/g, ''));
    if (u4) return u4;
  }
  return '';
}

// อ่านผ่าน export?format=csv (ค่าดิบตรงตามชีท) — ห้ามใช้ gviz เพราะ gviz เดาชนิดคอลัมน์
// แล้วทิ้งค่าที่ไม่ตรงชนิด เช่น รหัสเมนูที่เป็นข้อความในคอลัมน์ที่ส่วนใหญ่เป็นตัวเลข จะกลายเป็นช่องว่าง
const SHEET_GIDS = { menu: '0', BOM: '419926693', item: '302875824' };

async function fetchSheet(name) {
  const gid = SHEET_GIDS[name];
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status} (${name})`);
  return parseCSV(await r.text());
}

const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; };

export default async function handler(req, res) {
  const { sheet } = req.query;
  try {
    if (sheet === 'menu') {
      const rows = await fetchSheet('menu');
      const data = rows.slice(1)
        .filter(r => (r[0] || '').trim())
        .map(r => ({
          code: r[0].trim(),
          name: (r[1] || '').trim(),
          group: (r[2] || '').trim(),
          price: num(r[3]),
          cost: num(r[4]),
          // F = สถานะเมนู (ว่าง = ใช้งาน)
          status: (r[5] || '').trim() || 'ใช้งาน',
        }));
      return res.status(200).json({ status: 'success', data });
    }

    if (sheet === 'bom') {
      const rows = await fetchSheet('BOM');
      const map = {};
      rows.slice(1).forEach(r => {
        const code = (r[0] || '').trim();
        if (!code) return;
        if (!map[code]) map[code] = { name: (r[1] || '').trim(), items: [] };
        map[code].items.push({
          seq: (r[2] || '').trim(),
          itemCode: (r[3] || '').trim(),
          itemName: (r[4] || '').trim(),
          qty: num(r[5]),
          converter: num(r[7]),
          itemPrice: num(r[9]),
          unitCost: num(r[10]),
          lineCost: num(r[13]),
        });
      });
      return res.status(200).json({ status: 'success', data: map });
    }

    if (sheet === 'item') {
      const rows = await fetchSheet('item');
      const data = rows.slice(1)
        .filter(r => (r[0] || '').trim())
        .map(r => {
          const name = (r[1] || '').trim();
          const sheetUnit = (r[3] || '').trim();
          return {
            code: r[0].trim(),
            name,
            price: num(r[2]),
            unit: sheetUnit || inferUnit(name),
            unitSource: sheetUnit ? 'sheet' : 'auto',
            // E=สถานะ (ว่าง = ใช้งาน), F–H = รหัสไอเทมทดแทน (สูงสุด 3)
            status: (r[4] || '').trim() || 'ใช้งาน',
            subs: [r[5], r[6], r[7]].map(s => (s || '').trim()).filter(Boolean),
          };
        });
      return res.status(200).json({ status: 'success', data });
    }

    return res.status(400).json({ status: 'error', message: 'ระบุ ?sheet=menu|bom|item' });
  } catch (err) {
    console.error('QC/RD API error:', err.message);
    return res.status(502).json({ status: 'error', message: err.message });
  }
}
