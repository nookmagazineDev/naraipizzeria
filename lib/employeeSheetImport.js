// อ่านไฟล์ .xlsx ที่ดาวน์โหลดจากสเปรดชีตพนักงาน (Google Sheet) — ใช้ครั้งเดียวตอนย้ายข้อมูลมา SQL
//
// อ่าน 3 แท็บ ตามตำแหน่งคอลัมน์ที่ Apps Script เดิมเขียนไว้ (apps-script.js ของรีโป Narai-branch)
//   DATA          รายชื่อ + ข้อมูลส่วนตัว   C รหัส · D ชื่อ · E สาขา · F ประเภท · G สถานะ · H วันเริ่มงาน
//                                           I ตำแหน่ง · J ค่าแรง · M เลขบัตร · Q ที่อยู่ · S วันเกิด
//                                           BP เบอร์โทร · BQ LINE · BR LOGA · BS สัญชาติ
//   พนักงานเข้า   A เวลาบันทึก · B ผู้บันทึก · C รหัส · D ชื่อ · E สังกัด · F ประเภท · G ตำแหน่ง
//                 N สัญชาติ · Q วันเริ่มงาน
//   พนักงานออก    A เวลาบันทึก · B รหัส · C ชื่อ · D สังกัด · E ประเภท · F วันเริ่มงาน · G วันลาออก
//                 H สาเหตุ · I อายุงาน · J ผู้บันทึก
// ผลลัพธ์ส่งต่อให้ /api/employee-hr { action:'import' } → office-server importEmployeeSheet
import { excelDate } from './employeeDocs.js';

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s === '-' ? '' : s;
};

const NAT = { thai: 'ไทย', foreigner: 'ต่างชาติ', foreign: 'ต่างชาติ' };
const natOf = (v) => NAT[cell(v).toLowerCase()] || cell(v);

/** 'สาขา SUM' / 'SUM' / 'sum, ipr' -> 'sum' (ช่องสังกัดในแท็บเข้า-ออกเป็นข้อความอิสระ) */
const branchCodeOf = (v) => (cell(v).split(/[\s,/|;+&]+/).find((t) => /^[a-z][a-z0-9]{1,5}$/i.test(t)) || '').toLowerCase();

const pad = (n) => String(n).padStart(2, '0');

/** เวลาบันทึก -> 'YYYY-MM-DD HH:mm:ss' (ค.ศ.) — ชีทเก็บเป็น 'dd/MM/yyyy HH:mm:ss' หรือเป็นค่าวันที่ของ Excel */
function stampOf(v, parseSerial) {
  if (v === null || v === undefined || v === '') return '';
  const fix = (y) => (y > 2400 ? y - 543 : y);
  if (typeof v === 'number' && parseSerial) {
    const p = parseSerial(v);
    if (p) return `${fix(p.y)}-${pad(p.m)}-${pad(p.d)} ${pad(p.H || 0)}:${pad(p.M || 0)}:${pad(Math.floor(p.S || 0))}`;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${fix(v.getFullYear())}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  }
  const m = cell(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${fix(Number(m[3]))}-${pad(m[2])}-${pad(m[1])} ${pad(m[4] || 0)}:${pad(m[5] || 0)}:${pad(m[6] || 0)}`;
  const { ymd } = excelDate(v, parseSerial);
  return ymd ? `${ymd} 00:00:00` : '';
}

const sheetRows = (XLSX, wb, name) => {
  const key = Object.keys(wb.Sheets).find((k) => k.trim() === name);
  return key ? XLSX.utils.sheet_to_json(wb.Sheets[key], { header: 1, raw: true, defval: null }) : null;
};

/** แถวที่เป็นข้อมูลจริง: มีรหัส HR (ตัวเลข/ตัวอักษร) และไม่ใช่หัวตาราง */
const isDataRow = (code, name) => code && name && !/รหัส|hr\s*code/i.test(code) && !/ชื่อ\s*-?\s*สกุล/.test(name);

/**
 * @returns {{ employees: object[], movements: object[], found: string[], missing: string[] }}
 */
export function parseEmployeeWorkbook(XLSX, wb) {
  const parseSerial = XLSX.SSF.parse_date_code;
  const date = (v) => excelDate(v, parseSerial).ymd;
  const found = [];
  const missing = [];

  const employees = [];
  const data = sheetRows(XLSX, wb, 'DATA');
  if (data) {
    found.push('DATA');
    for (const r of data.slice(1)) {
      const hrCode = cell(r[2]);
      const fullName = cell(r[3]).replace(/\s+/g, ' ');
      if (!isDataRow(hrCode, fullName) || !cell(r[4])) continue;
      employees.push({
        hrCode,
        fullName,
        branch: cell(r[4]),
        type: cell(r[5]),
        status: cell(r[6]),
        startDate: date(r[7]),
        position: cell(r[8]),
        dailyWage: cell(r[9]),
        idCard: cell(r[12]),
        address: cell(r[16]),
        birthday: date(r[18]),
        phone: cell(r[67]),
        lineId: cell(r[68]),
        loga: cell(r[69]),
        nationality: natOf(r[70]),
      });
    }
  } else missing.push('DATA');

  const movements = [];
  const ins = sheetRows(XLSX, wb, 'พนักงานเข้า');
  if (ins) {
    found.push('พนักงานเข้า');
    for (const r of ins.slice(1)) {
      const hrCode = cell(r[2]);
      const fullName = cell(r[3]);
      if (!hrCode && !fullName) continue;
      movements.push({
        kind: 'in',
        hrCode,
        fullName,
        branch: branchCodeOf(r[4]),
        empType: cell(r[5]),
        position: cell(r[6]),
        nationality: natOf(r[13]),
        startDate: date(r[16]),
        recordedBy: cell(r[1]),
        recordedAt: stampOf(r[0], parseSerial),
      });
    }
  } else missing.push('พนักงานเข้า');

  const outs = sheetRows(XLSX, wb, 'พนักงานออก');
  if (outs) {
    found.push('พนักงานออก');
    for (const r of outs.slice(1)) {
      const hrCode = cell(r[1]);
      const fullName = cell(r[2]);
      if (!hrCode && !fullName) continue;
      movements.push({
        kind: 'out',
        hrCode,
        fullName,
        branch: branchCodeOf(r[3]),
        empType: cell(r[4]),
        startDate: date(r[5]),
        resignDate: date(r[6]),
        reason: cell(r[7]),
        duration: cell(r[8]),
        recordedBy: cell(r[9]),
        recordedAt: stampOf(r[0], parseSerial),
      });
    }
  } else missing.push('พนักงานออก');

  return { employees, movements, found, missing };
}
