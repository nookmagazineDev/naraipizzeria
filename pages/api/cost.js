export default async function handler(req, res) {
  try {
    // ชีทต้นทุนเมนู (1v8WRT… แท็บแรก): Code, NameThai, MenuCode, UnitPrice, cost Menu
    // (สลับจากชีทเดิม 1Tjvt… — ชีทใหม่ครอบคลุมกว่า ~1,500 รหัส)
    const url = 'https://docs.google.com/spreadsheets/d/1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw/export?format=csv&gid=0';
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Google Sheets HTTP ${response.status}`);
    const text = await response.text();

    const lines = text.split('\n');
    const costMap = {};

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

    res.status(200).json(costMap);
  } catch (err) {
    console.error('Cost API error:', err.message);
    res.status(502).json({ error: err.message });
  }
}
