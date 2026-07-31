// จัดซื้อ — เบิกของสาขา: อ่านชีท "ใบเบิก" (บันทึกทุกครั้งที่สาขากดเบิก) + ชีท "data" (ข้อมูลไอเทม)
// สเปรดชีต: https://docs.google.com/spreadsheets/d/12Wb7tMXfT548XvK1H0Cp6uOysjS8ksmMFzQZ-Rpay2k
// ทำ pivot: แถว = ไอเทม, คอลัมน์ = สาขา, ช่อง = จำนวนที่เบิกรวม (sum จากชีทใบเบิกเอง ไม่ใช้ยอดสำเร็จรูปในชีท data
// เพราะคอลัมน์สาขาในชีท data เป็นค่าที่คีย์ด้วยมือ ไม่ได้ผูกสูตรกับชีทใบเบิกจริง)
const SHEET_ID = '12Wb7tMXfT548XvK1H0Cp6uOysjS8ksmMFzQZ-Rpay2k';

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

const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };

async function fetchSheetByName(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status} (${name})`);
  return parseCSV(await r.text());
}

// แปลงลิงก์ Google Drive (…/file/d/<ID>/view) เป็นลิงก์รูป thumbnail ที่ฝังใน <img> ได้
function toThumbUrl(driveLink) {
  const s = String(driveLink || '').trim();
  if (!s) return '';
  const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return s;
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w200`;
}

export default async function handler(req, res) {
  try {
    const [reqRows, dataRows] = await Promise.all([
      fetchSheetByName('ใบเบิก'),
      fetchSheetByName('data'),
    ]);

    // ชีท data มีหัวคอลัมน์แถวแรก — หาตำแหน่งคอลัมน์จากชื่อ กันชีทสลับตำแหน่งในอนาคต
    const header = (dataRows[0] || []).map(h => h.trim());
    const col = name => header.indexOf(name);
    const c = {
      codeNew: col('รหัสอุปกรณ์ใหม่'),
      codeOld: col('เก่า'),
      name: col('รายการสินค้า'),
      unit: col('หน่วย'),
      image: col('รูป'),
      price: col('ราคา'),
      remainNew: col('คงเหลือ ใหม่'),
      remainOld: col('คงเหลือ เก่า'),
      supplier: col('ซัพฯ'),
    };

    const itemInfo = {};
    dataRows.slice(1).forEach(r => {
      const name = (r[c.name] || '').trim();
      if (!name) return;
      itemInfo[name] = {
        code: (r[c.codeNew] || '').trim(),
        oldCode: (r[c.codeOld] || '').trim(),
        unit: (r[c.unit] || '').trim(),
        image: toThumbUrl(r[c.image]),
        price: num(r[c.price]) || null,
        remainNew: (r[c.remainNew] || '').trim(),
        remainOld: (r[c.remainOld] || '').trim(),
        supplier: (r[c.supplier] || '').trim(),
      };
    });

    // ชีท "ใบเบิก" ไม่มีหัวคอลัมน์ — เรียงตายตัว: เวลาบันทึก, สาขา, ชื่อสินค้า, จำนวน
    // ส่งเป็นแถวดิบ (ไม่ pivot ที่ฝั่ง API) เพื่อให้หน้าเว็บกรองตามเดือนแล้วรวมยอดใหม่ได้เอง
    const branchSet = new Set();
    const logs = reqRows
      .filter(r => r.some(x => String(x).trim()))
      .map(r => ({
        timestamp: (r[0] || '').trim(),   // DD/MM/YYYY HH:MM:SS
        branch: (r[1] || '').trim().toUpperCase(),
        itemName: (r[2] || '').trim(),
        qty: num(r[3]),
      }))
      .filter(r => r.itemName && r.branch);
    logs.forEach(r => branchSet.add(r.branch));

    const branches = [...branchSet].sort();

    res.status(200).json({ status: 'success', data: { branches, logs, itemInfo } });
  } catch (err) {
    console.error('Branch requisition API error:', err.message);
    res.status(502).json({ status: 'error', message: err.message });
  }
}
