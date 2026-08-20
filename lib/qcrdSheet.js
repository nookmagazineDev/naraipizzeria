// ชีทต้นทุนเมนู QC/RD (1v8WRT…) — ที่เดียวที่บอกว่าแท็บไหนคือแท็บไหน
// ใช้ร่วมกันระหว่าง /api/qcrd (หน้า QC/RD) กับ /api/usage-bom (ยอดใช้วัตถุดิบ)
// เพื่อให้ทั้งสองหน้าอ่าน "สูตรเดียวกัน" เสมอ
export const QCRD_SHEET_ID = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';

// อ่านผ่าน export?format=csv (ค่าดิบตรงตามชีท) — ห้ามใช้ gviz เพราะ gviz เดาชนิดคอลัมน์
// แล้วทิ้งค่าที่ไม่ตรงชนิด เช่น รหัสเมนูที่เป็นข้อความในคอลัมน์ที่ส่วนใหญ่เป็นตัวเลข จะกลายเป็นช่องว่าง
export const QCRD_SHEET_GIDS = { menu: '0', BOM: '419926693', item: '302875824', menucodegroup: '1491689317' };

// ค่าที่นับว่า "ติ๊กไว้" ในชีท (Google Sheets เขียน checkbox เป็น TRUE, สคริปต์เขียน Y)
export const TRUTHY = /^(y|yes|true|1|ใช่)$/i;

// ตัวแปลงหน่วยเริ่มต้นเมื่อคอลัมน์ H ว่าง — ต้องตรงกับ qcrd-apps-script.gs (buildBomRows_)
// ที่ใช้ `Number(it.converter) || 1000` ตอนคิดต้นทุน ไม่งั้นยอดใช้กับต้นทุนจะคนละสูตร
export const DEFAULT_CONVERTER = 1000;

export function parseCSV(text) {
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

export async function fetchQcrdSheet(name) {
  const gid = QCRD_SHEET_GIDS[name];
  if (!gid) throw new Error(`ไม่รู้จักแท็บ ${name} ในชีท QC/RD`);
  const url = `https://docs.google.com/spreadsheets/d/${QCRD_SHEET_ID}/export?format=csv&gid=${gid}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status} (${name})`);
  return parseCSV(await r.text());
}
