import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ClipboardList, Search, Loader2, AlertCircle, Download, X, Building2, Calendar, Info, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import { isPlanItem, PLAN_ITEM_COUNT } from '../lib/planItems';

/*
 * จัดซื้อ — แพลนสินค้า: ใบสั่งของจริงของแต่ละสาขา ผ่าน /api/plan
 *
 * ต้นทางคือ myfbdata.orderd ฝั่ง POS — ตัวเดียวกับที่แอปสั่งของของสาขาเขียนลง
 * ข้อมูลจึงตรงกันทันที (ทางถอย: สำเนาในชีท/SQL Server พร้อมแถบเตือนว่าอาจไม่สด)
 *
 * ทุกแถวมีสองวันที่ที่ต้องแยกให้ชัด: วันที่สั่ง (Ord_OrdDate) กับ วันที่ส่ง (Ord_DelDate)
 * ช่วงวันที่บนหน้าจอกรองด้วย "วันที่สั่ง" และถูกส่งไปให้ API จำกัดคิวรีด้วย
 * (orderd ใหญ่มากและไม่มี index ตามวันที่ — ดึงทั้งหมดไม่ได้)
 *
 * หน้าหลักสรุปยอดรวมต่อรายการ กดแถว → แยกตามสาขา + รายละเอียดทุกใบพร้อมสถานะรับของ
 */

const fmtNum = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const fmtMoney = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pad2 = v => String(v).padStart(2, '0');

// ปี พ.ศ. -> ค.ศ. (ชีทบางสาขาคีย์เป็น 2569) ปีที่เป็น ค.ศ. อยู่แล้วปล่อยผ่าน
const toAD = y => { const n = Number(y); return n > 2400 ? n - 543 : n; };

/**
 * แปลง "วันที่สั่ง" ให้เป็น YYYY-MM-DD เพื่อเทียบกับ <input type="date">
 *
 * ต้นทางส่งมาไม่เหมือนกันทุกทาง จึงต้องรับให้ครบ ไม่งั้นแถวที่อ่านไม่ออกจะถูกตัดทิ้งเงียบ ๆ
 * แล้วหน้าจอขึ้น 0 รายการทั้งที่ข้อมูลมีอยู่:
 *   25/08/2026 · 25/8/2026 · 25/08/2569 (พ.ศ.) · "25/08/2026 14:30:00" (มีเวลาต่อท้าย) · 2026-08-25
 */
const toISO = value => {
  const s = String(value ?? '').trim();
  if (!s) return '';

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);          // 2026-08-25 (ตัดเวลาต่อท้ายทิ้ง)
  if (iso) return `${toAD(iso[1])}-${pad2(iso[2])}-${pad2(iso[3])}`;

  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);      // 25/08/2026 (ตัดเวลาต่อท้ายทิ้ง)
  if (slash) {
    let [, d, m] = slash;
    // ชีทที่ตั้งเป็นภาษาอังกฤษเขียน MM/DD/YYYY — ช่องเดือนเกิน 12 แปลว่าสลับกันมา
    if (Number(m) > 12 && Number(d) <= 12) [d, m] = [m, d];
    return `${toAD(slash[3])}-${pad2(m)}-${pad2(d)}`;
  }
  return '';
};

// คีย์เรียงเวลา = วันที่ (ปรับให้เป็นรูปแบบเดียว) + recordTime (HH:MM:SS)
const sortKey = r => {
  const iso = toISO(r.orderDate);
  return iso ? `${iso}${(r.recordTime || '').replace(/:/g, '')}` : '';
};

// สถานะรับของ — มีเฉพาะข้อมูลสดจาก POS (ช่อง Ord_Rcv) ต้นทางสำเนาไม่มีให้
const statusText = r => (r.received === true ? 'รับแล้ว' : r.received === false ? 'รอรับ' : '');

// ชื่อวันแบบสั้น ไว้ทำหัวคอลัมน์ปฏิทิน (0 = อาทิตย์ ตาม getUTCDay)
const TH_DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/** 'YYYY-MM-DD' -> { dow:'จ', day:'08', month:'09', weekend:false } */
const dayParts = iso => {
  const d = new Date(`${iso}T00:00:00Z`);
  const n = d.getUTCDay();
  return { dow: TH_DOW[n], day: pad2(d.getUTCDate()), month: pad2(d.getUTCMonth() + 1), weekend: n === 0 || n === 6 };
};

const RANGE_DAYS = 30;   // ต้องตรงกับ DEFAULT_DAYS ใน pages/api/plan.js

const todayISO = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 10);
const shiftISO = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const defaultRange = () => { const to = todayISO(); return { from: shiftISO(to, -(RANGE_DAYS - 1)), to }; };

const HEAD_STYLE = {
  font: { name: 'Tahoma', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '0E7490' } }, // cyan-700
};

// สีในชีทปฏิทิน ให้ตรงกับที่เห็นบนหน้าจอ
const CELL_PENDING = { font: { name: 'Tahoma', sz: 10, color: { rgb: '92400E' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FEF3C7' } } };
const CELL_DONE = { font: { name: 'Tahoma', sz: 10, color: { rgb: '065F46' } }, fill: { patternType: 'solid', fgColor: { rgb: 'D1FAE5' } } };
const CELL_TITLE = { font: { name: 'Tahoma', sz: 12, bold: true } };
const CELL_TOTAL = { font: { name: 'Tahoma', sz: 10, bold: true }, fill: { patternType: 'solid', fgColor: { rgb: 'F1F5F9' } } };
const CELL_WEEKEND = { font: { name: 'Tahoma', sz: 11, bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '475569' } } };

/**
 * ชื่อชีทของ Excel: ยาวได้ 31 ตัว ห้ามมี : \ / ? * [ ] และห้ามซ้ำกัน
 * ชื่อสินค้าไทยยาวเกินและมีวงเล็บ/ทับ จึงต้องตัดให้สั้นและกันชื่อซ้ำก่อนเสมอ
 */
const safeSheetName = (base, used) => {
  let name = String(base).replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'sheet';
  for (let i = 2; used.has(name); i++) {
    const tail = `~${i}`;
    name = name.slice(0, 31 - tail.length) + tail;
  }
  used.add(name);
  return name;
};

export default function PlanList() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');   // API อ่านฐานไม่ได้แล้วถอยไปอ่านชีท — ต้องบอกให้รู้
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  // หมวดสินค้า: true = เฉพาะรายการในหมวดแพลน (lib/planItems.js) · false = ทุกหมวดที่สาขาสั่ง
  const [onlyPlan, setOnlyPlan] = useState(true);
  // ช่วง "วันที่สั่ง" — ตัวนี้เป็นตัวกำหนดว่า API จะไปดึงใบสั่งช่วงไหนมา ไม่ใช่แค่กรองบนจอ
  const [dateFrom, setDateFrom] = useState(() => defaultRange().from);
  const [dateTo, setDateTo] = useState(() => defaultRange().to);
  const [source, setSource] = useState('');     // pos = สดจาก POS · sql/sheet = สำเนา
  const [selectedItem, setSelectedItem] = useState(null); // itemCode ที่กำลังดูรายละเอียด
  // เปลี่ยนวันที่รัว ๆ แล้วคำตอบของช่วงเก่ามาถึงทีหลัง จะทับข้อมูลของช่วงใหม่ — นับรอบกันไว้
  const reqId = useRef(0);

  const load = () => {
    if (!dateFrom || !dateTo) return;
    const myId = ++reqId.current;
    setLoading(true);
    fetch(`/api/plan?from=${dateFrom}&to=${dateTo}`)
      .then(async r => {
        // เซิร์ฟเวอร์ล่มมักตอบเป็นหน้า HTML ไม่ใช่ JSON — กัน error ดิบ ๆ ที่ผู้ใช้อ่านไม่รู้เรื่อง
        const text = await r.text();
        try { return JSON.parse(text); }
        catch { throw new Error(`เซิร์ฟเวอร์ตอบไม่ใช่ข้อมูล (HTTP ${r.status}) — ลองกดโหลดใหม่อีกครั้ง`); }
      })
      .then(res => {
        if (myId !== reqId.current) return;   // มีคำขอใหม่แซงไปแล้ว ทิ้งคำตอบนี้
        if (res.status === 'success') {
          setRows(res.data || []); setError(''); setWarning(res.warning || ''); setSource(res.source || '');
        } else { setError(res.message || 'โหลดข้อมูลไม่สำเร็จ'); setWarning(''); }
      })
      .catch(err => { if (myId === reqId.current) { setError(err.message); setWarning(''); } })
      .finally(() => { if (myId === reqId.current) setLoading(false); });
  };
  // เปลี่ยนช่วงวันที่ = ต้องไปดึงมาใหม่ ไม่ใช่แค่กรองของเดิม
  useEffect(load, [dateFrom, dateTo]);

  const branches = useMemo(() => [...new Set(rows.map(r => r.branch).filter(Boolean))].sort(), [rows]);

  // ช่วงวันที่ที่ "มีข้อมูลจริง" + จำนวนแถวที่อ่านวันที่ไม่ออก — ไว้บอกสาเหตุตอนกรองแล้วไม่เหลืออะไรเลย
  const dataRange = useMemo(() => {
    let min = '', max = '', minRaw = '', maxRaw = '', unreadable = 0;
    rows.forEach(r => {
      const iso = toISO(r.orderDate);
      if (!iso) { unreadable++; return; }
      if (!min || iso < min) { min = iso; minRaw = r.orderDate; }
      if (!max || iso > max) { max = iso; maxRaw = r.orderDate; }
    });
    return { min, max, minRaw, maxRaw, unreadable, readable: rows.length - unreadable };
  }, [rows]);

  // คัดตามหมวด + ช่วงวันที่สั่ง — ใช้ต่อทั้งสรุป/รายละเอียด/Excel จะได้เป็นชุดเดียวกันหมด
  const baseRows = useMemo(() => rows.filter(r => {
    if (onlyPlan && !isPlanItem(r.itemCode)) return false;
    if (!dateFrom && !dateTo) return true;
    const iso = toISO(r.orderDate);
    if (!iso) return false;
    if (dateFrom && iso < dateFrom) return false;
    if (dateTo && iso > dateTo) return false;
    return true;
  }), [rows, dateFrom, dateTo, onlyPlan]);

  // สรุปยอดรวมต่อรายการ (itemCode) พร้อมวันที่บันทึกข้อมูลล่าสุดของแต่ละรายการ
  const summary = useMemo(() => {
    const g = {};
    baseRows.forEach(r => {
      if (branchFilter && r.branch !== branchFilter) return;
      const k = r.itemCode;
      if (!g[k]) g[k] = { itemCode: k, itemName: r.itemName, unit: r.unit, qty: 0, total: 0, branches: new Set(), lines: 0, lastRecorded: '', lastDeliver: '', pending: 0, _key: '' };
      g[k].qty += r.qty;
      g[k].total += r.total;
      g[k].branches.add(r.branch);
      g[k].lines++;
      if (r.received === false) g[k].pending++;
      if (r.deliverDate && r.deliverDate > g[k].lastDeliver) g[k].lastDeliver = r.deliverDate;
      const key = sortKey(r);
      if (key > g[k]._key) { g[k]._key = key; g[k].lastRecorded = r.orderDate; }
    });
    return Object.values(g).map(x => ({ ...x, branchCount: x.branches.size }))
      .sort((a, b) => b.qty - a.qty);
  }, [baseRows, branchFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return summary;
    return summary.filter(x => x.itemCode.toLowerCase().includes(q) || x.itemName.toLowerCase().includes(q));
  }, [summary, search]);

  const grand = useMemo(() => ({
    qty: filtered.reduce((s, x) => s + x.qty, 0),
    total: filtered.reduce((s, x) => s + x.total, 0),
  }), [filtered]);

  // แถวดิบของรายการที่เลือก (ตามตัวกรองสาขา+ช่วงวันที่บันทึกด้วย) เรียงคีย์เวลาล่าสุดก่อน
  const detailRows = useMemo(() => {
    if (!selectedItem) return [];
    return baseRows
      .filter(r => r.itemCode === selectedItem && (!branchFilter || r.branch === branchFilter))
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  }, [baseRows, selectedItem, branchFilter]);

  const branchBreakdown = useMemo(() => {
    const g = {};
    detailRows.forEach(r => {
      if (!g[r.branch]) g[r.branch] = { branch: r.branch, qty: 0, total: 0, lines: 0, pending: 0 };
      g[r.branch].qty += r.qty;
      g[r.branch].total += r.total;
      g[r.branch].lines++;
      if (r.received === false) g[r.branch].pending++;
    });
    return Object.values(g).sort((a, b) => b.qty - a.qty);
  }, [detailRows]);

  // จำนวน/มูลค่าต่อ (สาขา, วันที่รับ) — ใช้แสดงตอนกดวันที่ในตาราง "แยกตามสาขา"
  const branchDateQty = useMemo(() => {
    const m = {};
    detailRows.forEach(r => {
      if (!r.receiveDate) return;
      const k = `${r.branch}|${r.receiveDate}`;
      if (!m[k]) m[k] = { qty: 0, total: 0, lines: 0, pending: 0 };
      m[k].qty += r.qty;
      m[k].total += r.total;
      m[k].lines++;
      if (r.received === false) m[k].pending++;
    });
    return m;
  }, [detailRows]);

  // วันที่ส่งทั้งหมดของรายการนี้ เรียงจากวันแรกไปวันหลัง — ใช้เป็นคอลัมน์ของตารางปฏิทิน
  const deliverDates = useMemo(
    () => [...new Set(detailRows.map(r => r.deliverDate || r.receiveDate).filter(Boolean))].sort(),
    [detailRows]
  );

  // ยอดรวมของแต่ละวัน (ท้ายตารางปฏิทิน)
  const dateTotals = useMemo(() => {
    const t = {};
    detailRows.forEach(r => {
      const d = r.deliverDate || r.receiveDate;
      if (!d) return;
      if (!t[d]) t[d] = { qty: 0, pending: 0 };
      t[d].qty += r.qty;
      if (r.received === false) t[d].pending++;
    });
    return t;
  }, [detailRows]);

  const selectedInfo = filtered.find(x => x.itemCode === selectedItem) || summary.find(x => x.itemCode === selectedItem);

  // Export Excel: ชีตสรุปรายการ + ชีตรายละเอียดทุกแถว (ตามตัวกรองปัจจุบัน)
  const exportExcel = () => {
    if (!filtered.length) return;
    const wb = XLSX.utils.book_new();

    const sumAoa = [['รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'จำนวนรวม', 'มูลค่ารวม', 'จำนวนสาขาที่สั่ง', 'จำนวนครั้งสั่ง', 'สั่งล่าสุด', 'ส่งล่าสุด', 'ยังรอรับ (ใบ)']];
    filtered.forEach(x => sumAoa.push([x.itemCode, x.itemName, x.unit, x.qty, x.total, x.branchCount, x.lines, x.lastRecorded, x.lastDeliver, x.pending || 0]));
    const ws1 = XLSX.utils.aoa_to_sheet(sumAoa);
    ws1['!cols'] = [{ wch: 12 }, { wch: 36 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    for (let c = 0; c < 10; c++) { const cell = ws1[XLSX.utils.encode_cell({ r: 0, c })]; if (cell) cell.s = HEAD_STYLE; }
    XLSX.utils.book_append_sheet(wb, ws1, 'สรุปรายการ');

    const detAoa = [['วันที่สั่ง', 'เวลา', 'สาขา', 'เลขที่ใบสั่ง', 'รหัสสินค้า', 'ชื่อสินค้า', 'จำนวน', 'หน่วย', 'ราคา/หน่วย', 'มูลค่ารวม', 'วันที่ส่ง', 'สถานะ', 'ผู้บันทึก']];
    // ให้ตรงกับที่เห็นบนจอ: ตามช่วงวันที่ + สาขา + คำค้นหา (เดิมชีตนี้ไม่ตามคำค้น เลยได้คนละชุดกับชีตสรุป)
    const codes = new Set(filtered.map(x => x.itemCode));
    const detailSrc = baseRows.filter(r =>
      codes.has(r.itemCode) && (!branchFilter || r.branch === branchFilter));
    [...detailSrc].sort((a, b) => sortKey(b).localeCompare(sortKey(a))).forEach(r =>
      detAoa.push([r.orderDate, r.recordTime, r.branch, r.orderNo, r.itemCode, r.itemName, r.qty, r.unit, r.unitPrice, r.total, r.deliverDate || r.receiveDate, statusText(r), r.recordedBy]));
    const ws2 = XLSX.utils.aoa_to_sheet(detAoa);
    ws2['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 34 }, { wch: 9 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }];
    for (let c = 0; c < 13; c++) { const cell = ws2[XLSX.utils.encode_cell({ r: 0, c })]; if (cell) cell.s = HEAD_STYLE; }
    XLSX.utils.book_append_sheet(wb, ws2, 'รายละเอียดทั้งหมด');

    // ปฏิทินแยกชีทต่อไอเทม — ทำเฉพาะตอนกรองหมวดแพลนไว้
    // (ถ้าเปิด "ทุกหมวด" จะได้ชีทเป็นร้อย ไฟล์เปิดไม่ไหว)
    if (onlyPlan) {
      const used = new Set(['สรุปรายการ', 'รายละเอียดทั้งหมด']);
      filtered.forEach(item => {
        const src = detailSrc.filter(r => r.itemCode === item.itemCode);
        if (!src.length) return;

        const dates = [...new Set(src.map(r => r.deliverDate || r.receiveDate).filter(Boolean))].sort();
        const byBranch = {};
        src.forEach(r => {
          const b = byBranch[r.branch] || (byBranch[r.branch] = { branch: r.branch, qty: 0, cells: {} });
          b.qty += r.qty;
          const d = r.deliverDate || r.receiveDate;
          if (!d) return;
          const cell = b.cells[d] || (b.cells[d] = { qty: 0, pending: 0 });
          cell.qty += r.qty;
          if (r.received === false) cell.pending++;
        });
        const branchRows = Object.values(byBranch).sort((a, b) => b.qty - a.qty);

        // หัวเรื่อง 3 บรรทัด แล้วค่อยเป็นตารางปฏิทิน (แถว = สาขา, คอลัมน์ = วันที่ส่ง)
        const aoa = [
          [item.itemName ? `${item.itemName} (รหัส ${item.itemCode})` : `รหัส ${item.itemCode}`],
          [`วันที่สั่ง ${dateFrom} ถึง ${dateTo}${branchFilter ? ` · เฉพาะสาขา ${branchFilter}` : ''}`],
          [`หน่วย: ${item.unit || '—'} · ตัวเลขในตารางคือจำนวนที่ต้องส่ง · พื้นเหลือง = ยังไม่ได้รับ · พื้นเขียว = รับแล้ว`],
          [],
          ['สาขา', ...dates.map(d => { const t = dayParts(d); return `${t.dow} ${t.day}/${t.month}`; }), 'รวม'],
        ];
        const headRow = aoa.length - 1;
        const styled = [];   // ช่องที่ต้องลงสีทีหลัง

        branchRows.forEach(b => {
          const row = [b.branch];
          dates.forEach(d => {
            const c = b.cells[d];
            row.push(c ? c.qty : '');
            if (c) styled.push({ r: aoa.length, c: row.length - 1, s: c.pending > 0 ? CELL_PENDING : CELL_DONE });
          });
          row.push(b.qty);
          styled.push({ r: aoa.length, c: row.length - 1, s: CELL_TOTAL });
          aoa.push(row);
        });

        // แถวรวมท้ายตาราง — รวมต่อวัน
        const totalRow = ['รวมทุกสาขา'];
        dates.forEach(d => totalRow.push(branchRows.reduce((sum, b) => sum + (b.cells[d]?.qty || 0), 0)));
        totalRow.push(branchRows.reduce((sum, b) => sum + b.qty, 0));
        totalRow.forEach((_, i) => styled.push({ r: aoa.length, c: i, s: CELL_TOTAL }));
        aoa.push(totalRow);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 12 }, ...dates.map(() => ({ wch: 10 })), { wch: 10 }];
        ws[XLSX.utils.encode_cell({ r: 0, c: 0 })].s = CELL_TITLE;
        for (let c = 0; c <= dates.length + 1; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r: headRow, c })];
          if (!cell) continue;
          // เสาร์อาทิตย์ให้หัวคอลัมน์เข้มกว่าวันธรรมดา จะได้กวาดตาเจอ
          const d = dates[c - 1];
          cell.s = (c > 0 && c <= dates.length && dayParts(d).weekend) ? CELL_WEEKEND : HEAD_STYLE;
        }
        styled.forEach(({ r, c, s: style }) => {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (cell) cell.s = style;
        });

        XLSX.utils.book_append_sheet(wb, ws, safeSheetName(`${item.itemCode} ${item.itemName || ''}`, used));
      });
    }

    XLSX.writeFile(wb, `plan_procurement_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  // ตารางว่างเพราะอะไร — บอกให้ตรงเหตุ ไม่ใช่ "ไม่พบรายการ" เฉย ๆ จนไล่ปัญหาไม่ถูก
  const emptyMessage = () => {
    if (!rows.length) return (
      <span>
        ไม่มีใบสั่งของสาขาไหนเลยในช่วงวันที่สั่ง {dateFrom} ถึง {dateTo}
        <button onClick={() => { const d = defaultRange(); setDateFrom(shiftISO(d.to, -89)); setDateTo(d.to); }}
          className="ml-2 text-cyan-600 hover:text-cyan-700 font-semibold underline">ลองขยายเป็น 90 วัน</button>
      </span>
    );

    if (!dataRange.readable) return (
      <span className="text-rose-500">
        อ่านรูปแบบ “วันที่สั่ง” จากต้นทางไม่ออกทั้ง {dataRange.unreadable.toLocaleString()} แถว
        (ตัวอย่างค่าที่ได้มา: “{rows[0]?.orderDate || 'ว่าง'}”) — กรองตามวันที่จึงไม่เหลืออะไรเลย
      </span>
    );

    if (!baseRows.length && onlyPlan) return (
      <span>
        ไม่มีการสั่งของในหมวดแพลนช่วง {dateFrom} ถึง {dateTo} (ใบสั่งช่วงนี้มี {rows.length.toLocaleString()} แถว แต่เป็นหมวดอื่นทั้งหมด)
        <button onClick={() => setOnlyPlan(false)}
          className="ml-2 text-cyan-600 hover:text-cyan-700 font-semibold underline">ดูทุกหมวด</button>
      </span>
    );

    if (!baseRows.length) return (
      <span>
        ไม่มีการสั่งของในช่วง {dateFrom || '…'} ถึง {dateTo || '…'}
        {dataRange.min && <> · ใบสั่งที่ดึงมาอยู่ระหว่าง {dataRange.minRaw} ถึง {dataRange.maxRaw}</>}
        <button onClick={() => { const d = defaultRange(); setDateFrom(d.from); setDateTo(d.to); }}
          className="ml-2 text-cyan-600 hover:text-cyan-700 font-semibold underline">กลับไป {RANGE_DAYS} วันล่าสุด</button>
      </span>
    );

    if (!summary.length) return <span>สาขา {branchFilter} ไม่มีการสั่งของในช่วงที่เลือก</span>;

    return <span>ไม่พบสินค้าที่ตรงกับ “{search.trim()}”</span>;
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-cyan-100 text-cyan-700 rounded-xl"><ClipboardList className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">แพลนสินค้า</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {filtered.length.toLocaleString()} รายการ · จำนวนรวม {fmtNum(grand.qty)} · มูลค่ารวม ฿{fmtMoney(grand.total)}
                {onlyPlan && <span className="ml-1.5 text-cyan-600 font-semibold">· เฉพาะหมวดแพลน</span>}
                {(dateFrom || dateTo) && (
                  <span className="ml-1.5 text-cyan-600 font-semibold">· วันที่สั่ง {dateFrom || '…'} ถึง {dateTo || '…'}</span>
                )}
                {source && !loading && (
                  <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[11px] font-semibold ${source === 'pos'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-amber-50 text-amber-700'}`}>
                    {source === 'pos' ? 'ข้อมูลสดจาก POS' : 'ข้อมูลจากสำเนา'}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} title="โหลดข้อมูลใหม่"
              className="inline-flex items-center gap-2 border border-slate-200 hover:bg-slate-50 disabled:opacity-40 text-slate-600 font-semibold text-xs px-3 py-2 rounded-xl transition-all">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> โหลดใหม่
            </button>
            <button onClick={exportExcel} disabled={loading || !filtered.length}
              className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Download size={14} /> Export Excel
            </button>
          </div>
        </div>

        <div className="p-4 flex flex-wrap gap-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อสินค้า…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <select value={onlyPlan ? 'plan' : 'all'} onChange={e => setOnlyPlan(e.target.value === 'plan')}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500">
            <option value="plan">หมวดแพลน ({PLAN_ITEM_COUNT} รายการ)</option>
            <option value="all">ทุกหมวด</option>
          </select>
          <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500">
            <option value="">ทุกสาขา ({branches.length})</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <div className="flex items-center gap-2 bg-cyan-50/60 border border-cyan-100 rounded-xl px-3 py-1.5">
            <Calendar size={14} className="text-cyan-600 flex-shrink-0" />
            <span className="text-xs font-semibold text-cyan-700 whitespace-nowrap">วันที่สั่ง:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500" />
            <span className="text-slate-400 text-xs">-</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500" />
            <button onClick={() => { const d = defaultRange(); setDateFrom(d.from); setDateTo(d.to); }}
              className="text-slate-400 hover:text-cyan-600 text-xs font-semibold whitespace-nowrap">{RANGE_DAYS} วันล่าสุด</button>
          </div>
        </div>

        {error && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-center gap-2">
            <AlertCircle size={16} /><span className="flex-1">{error}</span>
            <button onClick={load} className="font-semibold underline whitespace-nowrap">ลองใหม่</button>
          </div>
        )}

        {warning && !error && (
          <div className="m-4 p-3 bg-amber-50 border border-amber-100 rounded-xl text-sm text-amber-800 flex items-start gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" /><span>{warning}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">รหัสสินค้า</th>
                <th className="px-4 py-3 text-left">ชื่อสินค้า</th>
                <th className="px-3 py-3 text-center">หน่วย</th>
                <th className="px-4 py-3 text-right">จำนวนรวม</th>
                <th className="px-4 py-3 text-right">มูลค่ารวม</th>
                <th className="px-3 py-3 text-center">สาขาที่สั่ง</th>
                <th className="px-3 py-3 text-center">จำนวนครั้ง</th>
                <th className="px-4 py-3 text-left">สั่งล่าสุด</th>
                <th className="px-4 py-3 text-left">ส่งล่าสุด</th>
                <th className="px-3 py-3 text-center">รอรับ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังดึงใบสั่งของ…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-400 text-sm">{emptyMessage()}</td></tr>
              ) : filtered.map(x => (
                <tr key={x.itemCode} onClick={() => setSelectedItem(x.itemCode)}
                  className="cursor-pointer hover:bg-cyan-50/50 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">{x.itemCode}</td>
                  <td className="px-4 py-2.5 text-slate-800 font-medium">{x.itemName}</td>
                  <td className="px-3 py-2.5 text-center text-slate-500 whitespace-nowrap">{x.unit || '—'}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-slate-800">{fmtNum(x.qty)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-cyan-700">{fmtMoney(x.total)}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className="inline-block px-2 py-0.5 bg-cyan-50 text-cyan-700 rounded-full text-xs font-semibold">{x.branchCount}</span>
                  </td>
                  <td className="px-3 py-2.5 text-center text-slate-500">{x.lines}</td>
                  <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap font-mono text-xs">{x.lastRecorded || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap font-mono text-xs">{x.lastDeliver || '—'}</td>
                  <td className="px-3 py-2.5 text-center">
                    {x.pending > 0
                      ? <span className="inline-block px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold">{x.pending}</span>
                      : <span className="text-slate-300 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && (
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-400 flex items-center gap-2">
            <Info size={13} />
            กดแถวเพื่อดูว่าสาขาไหนสั่งวันไหน ส่งวันไหน และรับของแล้วหรือยัง
          </div>
        )}
      </div>

      {/* ───── Modal รายละเอียดรายการ ───── */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setSelectedItem(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-800">{selectedInfo?.itemName || selectedItem}</h3>
                <p className="text-xs text-slate-400 mt-0.5 font-mono">รหัส {selectedItem} · จำนวนรวม {fmtNum(selectedInfo?.qty)} {selectedInfo?.unit} · มูลค่ารวม ฿{fmtMoney(selectedInfo?.total)}</p>
              </div>
              <button onClick={() => setSelectedItem(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
            </div>

            <div className="overflow-auto p-5 space-y-5">
              {/* แยกตามสาขา: สั่งเท่าไหร่ + รับของวันไหนบ้าง */}
              <div>
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                  <Building2 size={13} /> แยกตามสาขา
                </h4>
                <div className="overflow-x-auto border border-slate-100 rounded-xl">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr className="text-xs font-bold">
                        <th className="px-3 py-2 text-left">สาขา</th>
                        <th className="px-3 py-2 text-right">จำนวนรวม</th>
                        <th className="px-3 py-2 text-right">มูลค่ารวม</th>
                        <th className="px-3 py-2 text-center">จำนวนครั้งสั่ง</th>
                        <th className="px-3 py-2 text-center">รอรับ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {branchBreakdown.map(b => (
                        <tr key={b.branch} className="hover:bg-slate-50/60">
                          <td className="px-3 py-2 font-semibold text-slate-800">{b.branch}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmtNum(b.qty)}</td>
                          <td className="px-3 py-2 text-right font-mono text-cyan-700">{fmtMoney(b.total)}</td>
                          <td className="px-3 py-2 text-center text-slate-500">{b.lines}</td>
                          <td className="px-3 py-2 text-center">
                            {b.pending > 0
                              ? <span className="inline-block px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold">{b.pending}</span>
                              : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ปฏิทินการส่ง: สาขา (แถว) x วันที่ส่ง (คอลัมน์) — อ่านทีเดียวว่าวันไหนต้องส่งสาขาไหนเท่าไหร่ */}
              {deliverDates.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                    <Calendar size={13} /> ปฏิทินการส่ง
                    <span className="ml-1 font-normal normal-case text-slate-400">
                      ตัวเลข = จำนวนที่ต้องส่ง · เหลือง = ยังไม่ได้รับ · เขียว = รับแล้ว
                    </span>
                  </h4>
                  <div className="overflow-x-auto border border-slate-100 rounded-xl">
                    <table className="text-sm border-collapse">
                      <thead className="bg-slate-50 text-slate-500">
                        <tr className="text-xs font-bold">
                          <th className="px-3 py-2 text-left sticky left-0 bg-slate-50 z-10 border-r border-slate-100">สาขา</th>
                          {deliverDates.map(d => {
                            const t = dayParts(d);
                            return (
                              <th key={d} className={`px-2 py-1.5 text-center whitespace-nowrap font-normal ${t.weekend ? 'bg-slate-100' : ''}`}>
                                <div className="text-[10px] text-slate-400">{t.dow}</div>
                                <div className="font-bold text-slate-600">{t.day}/{t.month}</div>
                              </th>
                            );
                          })}
                          <th className="px-3 py-2 text-right border-l border-slate-100">รวม</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {branchBreakdown.map(b => (
                          <tr key={b.branch} className="hover:bg-slate-50/60">
                            <td className="px-3 py-1.5 font-semibold text-slate-800 sticky left-0 bg-white z-10 border-r border-slate-100">{b.branch}</td>
                            {deliverDates.map(d => {
                              const info = branchDateQty[`${b.branch}|${d}`];
                              const weekend = dayParts(d).weekend;
                              if (!info) return <td key={d} className={`px-2 py-1.5 text-center text-slate-200 ${weekend ? 'bg-slate-50/70' : ''}`}>·</td>;
                              const waiting = info.pending > 0;
                              return (
                                <td key={d} className={`px-2 py-1.5 text-center ${weekend ? 'bg-slate-50/70' : ''}`}
                                  title={`${b.branch} · ส่ง ${d} · ${fmtNum(info.qty)} ${selectedInfo?.unit || ''}` + (waiting ? ` · ยังไม่ได้รับ ${info.pending} ใบ` : ' · รับแล้ว')}>
                                  <span className={`inline-block min-w-[2.2rem] px-1.5 py-0.5 rounded font-mono font-bold text-xs ${waiting
                                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                    : 'bg-emerald-50 text-emerald-700 border border-emerald-100'}`}>
                                    {fmtNum(info.qty)}
                                  </span>
                                </td>
                              );
                            })}
                            <td className="px-3 py-1.5 text-right font-mono font-bold text-slate-700 border-l border-slate-100">{fmtNum(b.qty)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-50 text-slate-600">
                        <tr className="text-xs font-bold">
                          <td className="px-3 py-2 sticky left-0 bg-slate-50 z-10 border-r border-slate-100">รวมทุกสาขา</td>
                          {deliverDates.map(d => (
                            <td key={d} className={`px-2 py-2 text-center font-mono ${dayParts(d).weekend ? 'bg-slate-100' : ''}`}>
                              {fmtNum(dateTotals[d]?.qty)}
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right font-mono border-l border-slate-100">{fmtNum(selectedInfo?.qty)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* รายละเอียดทุกแถว พร้อมวันที่คีย์ข้อมูล */}
              <div>
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">ทุกใบที่สั่ง — สั่งวันไหน ส่งวันไหน ({detailRows.length} แถว)</h4>
                <div className="overflow-x-auto border border-slate-100 rounded-xl max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500 sticky top-0">
                      <tr className="font-bold">
                        <th className="px-3 py-2 text-left">วันที่สั่ง</th>
                        <th className="px-3 py-2 text-left">สาขา</th>
                        <th className="px-3 py-2 text-left">เลขที่ใบสั่ง</th>
                        <th className="px-3 py-2 text-right">จำนวน</th>
                        <th className="px-3 py-2 text-right">ราคา/หน่วย</th>
                        <th className="px-3 py-2 text-right">มูลค่า</th>
                        <th className="px-3 py-2 text-left">วันที่ส่ง</th>
                        <th className="px-3 py-2 text-center">สถานะ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {detailRows.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50/60">
                          <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.orderDate} <span className="text-slate-400">{r.recordTime}</span></td>
                          <td className="px-3 py-1.5 font-semibold">{r.branch}</td>
                          <td className="px-3 py-1.5 font-mono text-slate-500">{r.orderNo}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmtNum(r.qty)} {r.unit}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmtMoney(r.unitPrice)}</td>
                          <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmtMoney(r.total)}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap font-mono">{r.deliverDate || r.receiveDate || '—'}</td>
                          <td className="px-3 py-1.5 text-center whitespace-nowrap">
                            {r.received === true
                              ? <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded text-[11px] font-semibold">รับแล้ว</span>
                              : r.received === false
                                ? <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded text-[11px] font-semibold">รอรับ</span>
                                : <span className="text-slate-300">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
