// ต้นทุนต่อเมนู: { "<รหัสเมนู>": <ต้นทุน> } — หน้ารายงานขายเอาไปคิดกำไรต่อบิล
//
// ที่มาเดิมคือชีทต้นทุนเมนู 1v8WRT… แท็บแรก (Code, NameThai, MenuCode, UnitPrice, cost Menu)
// ตอนนี้ชีทนั้นย้ายเข้า SQL แล้ว (dbo.qcrd_menu) — เปิด QCRD_SOURCE=sql เมื่อไหร่ก็อ่านจากฐานแทน
// อ่านฐานไม่ได้ถอยไปอ่านชีทให้ หน้ารายงานจะได้ไม่ล้มทั้งหน้าเพราะต้นทุนช่องเดียว
import { usingSql, fetchQcrdSql, sqlRoute } from '../../lib/qcrdSource';
import { fetchSheet } from '../../lib/upstream.mjs';

const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw/export?format=csv&gid=0';

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

async function costFromSheet() {
  const response = await fetchSheet(SHEET_URL);
  if (!response.ok) throw new Error(`Google Sheets HTTP ${response.status}`);
  const lines = (await response.text()).split('\n');
  const costMap = {};

  // หา index ของคอลัมน์ต้นทุนจากหัวคอลัมน์ "cost Menu" (กันคอลัมน์สลับ/เพิ่มในอนาคต)
  const header = parseCSVLine(lines[0] || '');
  let costIdx = header.findIndex(h => /cost/i.test(h));
  if (costIdx < 0) costIdx = 4; // fallback ตำแหน่งคอลัมน์ E (cost Menu)

  // Skip header line (i = 0) — รหัสซ้ำใช้ค่าแรกที่เจอ (ตรวจแล้วไม่มีค่าขัดแย้งกัน)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);
    const itemCode = cols[0];
    const costVal = parseFloat(cols[costIdx]);
    if (itemCode && !isNaN(costVal) && !(itemCode in costMap)) {
      costMap[itemCode] = costVal;
    }
  }
  return costMap;
}

async function costFromSql() {
  const menus = await fetchQcrdSql('menu');
  const costMap = {};
  menus.forEach(m => {
    if (!m.code || m.cost === null || m.cost === undefined) return;
    if (!(m.code in costMap)) costMap[m.code] = Number(m.cost);
  });
  return costMap;
}

export default async function handler(req, res) {
  try {
    if (usingSql()) {
      try {
        return res.status(200).json(await costFromSql());
      } catch (err) {
        console.error(`Cost API: อ่าน SQL ไม่ได้ (${sqlRoute()}) — ถอยไปอ่านชีท:`, err.message);
      }
    }
    res.status(200).json(await costFromSheet());
  } catch (err) {
    console.error('Cost API error:', err.message);
    res.status(502).json({ error: err.message });
  }
}
