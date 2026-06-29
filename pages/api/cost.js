export default async function handler(req, res) {
  try {
    const url = 'https://docs.google.com/spreadsheets/d/1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg/export?format=csv&gid=1742903365';
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
    
    // หา index ของคอลัมน์ต้นทุนจาก header (เดิมใช้คอลัมน์สุดท้าย แต่ชีตมีคอลัมน์ว่างต่อท้าย
    // ทำให้ parseFloat('') = NaN แล้วข้ามทุกแถว → costMap ว่าง). ยึดชื่อหัวคอลัมน์ "ต้นทุน" แทน
    const header = parseCSVLine(lines[0] || '');
    let costIdx = header.indexOf('ต้นทุน');
    if (costIdx < 0) costIdx = 7; // fallback ตามตำแหน่งเดิมของคอลัมน์ต้นทุน

    // Skip header line (i = 0)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      if (cols.length >= 8) {
        const itemCode = cols[0];
        const costVal = parseFloat(cols[costIdx]);
        if (itemCode && !isNaN(costVal)) {
          costMap[itemCode] = costVal;
        }
      }
    }
    
    res.status(200).json(costMap);
  } catch (err) {
    console.error('Cost API error:', err.message);
    res.status(502).json({ error: err.message });
  }
}
