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
    
    // Skip header line (i = 0)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const cols = parseCSVLine(line);
      if (cols.length >= 8) {
        const itemCode = cols[0];
        const costVal = parseFloat(cols[cols.length - 1]); // the last column contains the cost
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
