import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import {
  ArrowLeft, Wallet, Download, Loader2, AlertCircle, ChevronDown, ChevronRight, RefreshCw,
} from 'lucide-react';
import {
  summarizeLabor, scheduleCellOf, weeksOf, daysBetween, weekdayOf, laborTypeOf, wageOf, isWorkedRow,
  isClearedRow, LABOR_TYPES,
} from '../lib/labor';
import { fetchDailySales } from '../lib/laborSales';
import { hhmm, totalLateOf } from '../lib/attendance';

/*
 * NARAI OFFICE — รายละเอียดค่าแรง (เปิดจากการ์ด "ค่าแรงรวม" ในหน้าดูสแกนหน้า)
 *
 * ใช้ข้อมูลชุดที่หน้าดูสแกนหน้าดึงมาแล้ว (ตารางงาน + เวลาสแกน) ไม่ได้ดึงซ้ำ
 * ดึงเพิ่มอย่างเดียวคือยอดขายของสาขาในช่วงเดียวกัน (lib/laborSales.js)
 *
 *   1. ค่าแรงรวม · ยอดขายรวม · % ค่าแรงต่อยอดขาย · จำนวนคน
 *   2. ยอดขายแต่ละวัน (ปฏิทินจันทร์–อาทิตย์) คู่กับค่าแรงและ % ของวันนั้น
 *   3. สรุปตามตำแหน่ง — กดบรรทัดดูแยก F/T · P/T · DAY · DAY9
 *   4. ตารางการทำงาน / ตารางสแกนหักสาย
 * ค่าแรงมาจากช่อง wage ที่หน้าลงตารางของสาขาคิดไว้ (ดู lib/labor.js)
 */

const baht = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const pctText = (labor, sales) => (sales > 0 ? `${((labor / sales) * 100).toFixed(1)}%` : '—');
const DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const DOW_HEAD = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
/** '2026-11-05' -> '5/11' */
const dm = (ymd) => {
  const [, m, d] = String(ymd || '').split('-');
  return m && d ? `${Number(d)}/${Number(m)}` : '';
};
const isWeekend = (ymd) => [0, 6].includes(weekdayOf(ymd));

const TYPE_CLS = {
  'F/T': 'bg-blue-100 text-blue-800',
  'P/T': 'bg-violet-100 text-violet-800',
  DAY: 'bg-teal-100 text-teal-800',
  DAY9: 'bg-orange-100 text-orange-800',
};
const typeCls = (t) => TYPE_CLS[t] || 'bg-slate-100 text-slate-700';
const TYPE_NOTE = { 'F/T': 'รายเดือน', 'P/T': 'รายชั่วโมง', DAY: 'รายวัน 8 ชม.', DAY9: 'รายวัน 9 ชม.' };

const CELL_CLS = {
  work: 'bg-emerald-50 text-emerald-800',
  off: 'bg-rose-50 text-rose-700',
  paidLeave: 'bg-indigo-100 text-indigo-800',
  unpaidLeave: 'bg-rose-100 text-rose-800',
};

const TypeChip = ({ type, children }) => (
  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${typeCls(type)}`}>{children || type}</span>
);

const lateNum = (v) => (v == null ? <span className="text-slate-300">—</span>
  : v > 0 ? <span className="font-mono font-semibold text-rose-600">{v}</span>
    : <span className="font-mono text-slate-400">0</span>);

export default function LaborDetail({ branch, startDate, endDate, schedRows, dailyRows, outletId, codeOfOutlet, onBack }) {
  const label = branch || 'ทุกสาขา';
  const labor = useMemo(
    () => summarizeLabor(schedRows, { start: startDate, end: endDate }),
    [schedRows, startDate, endDate],
  );
  const days = useMemo(() => daysBetween(startDate, endDate), [startDate, endDate]);

  /* ---------------- ยอดขายของสาขาในช่วงเดียวกัน ---------------- */
  const [sales, setSales] = useState(null);          // { byDate, total, bills }
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesError, setSalesError] = useState('');
  const [salesProgress, setSalesProgress] = useState('');
  const [salesKey, setSalesKey] = useState(0);        // กดลองใหม่
  // เลือกสาขาที่ไม่มีรหัสร้าน POS (เช่น OFFICE) = ไม่มียอดขายให้เทียบ
  const noOutlet = Boolean(branch) && !outletId;

  useEffect(() => {
    if (noOutlet) { setSales(null); setSalesError(''); return undefined; }
    let alive = true;
    setSalesLoading(true);
    setSalesError('');
    setSales(null);
    fetchDailySales({
      start: startDate, end: endDate, outletId: branch ? outletId : '', codeOfOutlet,
      onProgress: (t) => alive && setSalesProgress(t),
    })
      .then((r) => { if (alive) setSales(r); })
      .catch((e) => { if (alive) setSalesError(e.message || 'ดึงยอดขายไม่สำเร็จ'); })
      .finally(() => { if (alive) { setSalesLoading(false); setSalesProgress(''); } });
    return () => { alive = false; };
    // codeOfOutlet เปลี่ยนตัวอ้างอิงทุกครั้งที่ทะเบียนสาขาโหลดใหม่ — ไม่ต้องดึงยอดขายใหม่เพราะเรื่องนั้น
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, outletId, startDate, endDate, noOutlet, salesKey]);

  const salesOf = (d) => (sales ? sales.byDate[d] || 0 : null);
  const laborOf = (d) => labor.byDate[d]?.wage || 0;

  /* ---------------- ปฏิทินรายวัน ---------------- */
  const weeks = useMemo(() => weeksOf(startDate, endDate), [startDate, endDate]);

  /* ---------------- ตำแหน่ง ---------------- */
  const [openPos, setOpenPos] = useState(() => new Set());
  const togglePos = (p) => setOpenPos((prev) => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });

  /* ---------------- ตารางการทำงาน (คน x วัน) ---------------- */
  const people = useMemo(() => {
    const map = new Map();
    for (const r of schedRows || []) {
      const date = String(r.workDate || '').slice(0, 10);
      if (!date || date < startDate || date > endDate || isClearedRow(r)) continue;
      const code = String(r.hrCode || r.name || '').trim();
      const key = `${branch ? '' : String(r.branch || '').toUpperCase()}|${code}`;
      if (!map.has(key)) {
        map.set(key, {
          key, code: String(r.hrCode || ''), name: r.name || '', branch: String(r.branch || '').toUpperCase(),
          position: r.position || '', type: laborTypeOf(r.empType), cells: {}, days: 0, wage: 0,
        });
      }
      const p = map.get(key);
      p.cells[date] = scheduleCellOf(r);
      if (isWorkedRow(r)) p.days += 1;
      p.wage += wageOf(r);
      if (r.position) p.position = r.position;
    }
    const typeRank = (t) => (LABOR_TYPES.indexOf(t) < 0 ? 9 : LABOR_TYPES.indexOf(t));
    return [...map.values()].sort((a, b) =>
      a.branch.localeCompare(b.branch) ||
      String(a.position).localeCompare(String(b.position), 'th') ||
      typeRank(a.type) - typeRank(b.type) ||
      String(a.name).localeCompare(String(b.name), 'th'));
  }, [schedRows, startDate, endDate, branch]);

  /* ---------------- ตารางสแกนหักสาย (เฉพาะวันที่สาย) ---------------- */
  const lateRows = useMemo(() => (dailyRows || [])
    .filter((d) => d.date >= startDate && d.date <= endDate && (totalLateOf(d) || 0) > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.name).localeCompare(String(b.name), 'th')),
  [dailyRows, startDate, endDate]);
  const lateTotals = useMemo(() => {
    const t = { lateIn: 0, lateBreakIn: 0, earlyOut: 0, total: 0, people: new Set() };
    for (const d of lateRows) {
      t.lateIn += Math.max(0, d.lateIn || 0);
      t.lateBreakIn += Math.max(0, d.lateBreakIn || 0);
      t.earlyOut += Math.max(0, d.earlyOut || 0);
      t.total += totalLateOf(d) || 0;
      t.people.add(d.empCode);
    }
    return t;
  }, [lateRows]);

  const [tab, setTab] = useState('schedule');

  /* ---------------- Excel ---------------- */
  // หน้าตาเดียวกับไฟล์ Excel ของหน้าดูสแกนหน้า: หัวตารางพื้นส้มตัวขาว · แถวรวมตัวหนาพื้นเทาเส้นคั่นบน
  // ยอดรวมเขียนเป็นสูตร SUM (แก้ตัวเลขในไฟล์แล้วยอดตาม) พร้อมใส่ค่าที่คิดไว้แล้วไปด้วย
  // เพิ่มจากไฟล์นั้น: ตัวเลขเงินมีคอมมา · % เป็นรูปแบบเปอร์เซ็นต์ · สีช่องหยุด/ลา/สาย ให้อ่านเหมือนบนหน้าเว็บ
  const exportExcel = () => {
    const wb = XLSX.utils.book_new();
    const MONEY = '#,##0';
    const money = (v) => ({ t: 'n', v: Math.round((v || 0) * 100) / 100, z: MONEY });
    const pct = (labor, sales) => (sales > 0 ? { t: 'n', v: labor / sales, z: '0.0%' } : '');
    const fill = (rgb) => ({ fgColor: { rgb } });
    const HEAD = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: fill('F59E0B'),
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    };
    const TOTAL = {
      font: { bold: true },
      fill: fill('F1F5F9'),
      border: { top: { style: 'medium', color: { rgb: '94A3B8' } } },
    };
    const TYPE_FILL = { 'F/T': 'DBEAFE', 'P/T': 'EDE9FE', DAY: 'CCFBF1', DAY9: 'FFEDD5' };
    const TYPE_FONT = { 'F/T': '1E40AF', 'P/T': '5B21B6', DAY: '115E59', DAY9: '9A3412' };
    const typeStyle = (t) => (TYPE_FILL[t]
      ? { fill: fill(TYPE_FILL[t]), font: { bold: true, color: { rgb: TYPE_FONT[t] } }, alignment: { horizontal: 'center' } }
      : { alignment: { horizontal: 'center' } });
    const col = (c) => XLSX.utils.encode_col(c);
    /** SUM ของคอลัมน์ c จากแถวข้อมูลแรกถึงแถวสุดท้าย (แถว 1 = หัวตาราง) */
    const sum = (c, lastRow, v, z) => ({ t: 'n', v, f: `SUM(${col(c)}2:${col(c)}${lastRow})`, ...(z ? { z } : {}) });

    /**
     * สร้างชีตจาก aoa แล้วแต่งตามแบบไฟล์ดูสแกนหน้า
     * style(r, c) คืนสไตล์เพิ่มของช่องข้อมูล (ไม่รวมหัวตาราง/แถวรวม) · totalRow = แถวสุดท้ายเป็นแถวรวม
     */
    const add = (name, aoa, widths, { style, totalRow = true } = {}) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = widths.map((wch) => ({ wch }));
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const ref = XLSX.utils.encode_cell({ r, c });
          // ช่องว่างในแถวหัว/แถวรวมต้องมีตัวตนด้วย ไม่งั้นพื้นสีขาดเป็นช่อง ๆ
          if (!ws[ref] && (r === 0 || (totalRow && r === range.e.r))) ws[ref] = { t: 's', v: '' };
          const cell = ws[ref];
          if (!cell) continue;
          // สำเนาใหม่ทุกช่อง — ตัวเขียนไฟล์เติมรูปแบบตัวเลข (cell.z) ลงในอ็อบเจกต์สไตล์ของช่องนั้น
          // ใช้อ็อบเจกต์เดียวกันหลายช่อง รูปแบบ % ของช่องหนึ่งจะไปติดช่องอื่นด้วย (ยอดคน 172 กลายเป็น 17200%)
          let s = null;
          if (r === 0) s = HEAD;
          else if (totalRow && r === range.e.r) s = TOTAL;
          else if (style) s = style(r, c, cell);
          if (s) cell.s = JSON.parse(JSON.stringify(s));
        }
      }
      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    // ---- 1. รายวัน ----
    const n = days.length;
    add('รายวัน', [
      // ยอดขาย (รวม VAT) = "ยอดขายรวม VAT" ของหน้ายอดขาย · ก่อน VAT = "ยอดขายรวมทั้งหมด" ของแดชบอร์ด
      ['วันที่', 'วัน', 'ยอดขาย (รวม VAT)', 'ยอดขายก่อน VAT', 'ค่าแรง', '% ค่าแรง', 'คนมาทำงาน'],
      ...days.map((d) => {
        const s = salesOf(d);
        const nv = sales ? sales.beforeVatByDate[d] || 0 : null;
        return [d, DOW[weekdayOf(d)], s == null ? '' : money(s), nv == null ? '' : money(nv),
          money(laborOf(d)), s == null ? '' : pct(laborOf(d), s), labor.byDate[d]?.staff || 0];
      }),
      ['รวม', '',
        sales ? sum(2, n + 1, Math.round(sales.total * 100) / 100, MONEY) : '',
        sales ? sum(3, n + 1, Math.round(sales.beforeVat * 100) / 100, MONEY) : '',
        sum(4, n + 1, labor.wage, MONEY),
        sales?.total > 0 ? { t: 'n', v: labor.wage / sales.total, f: `IF(C${n + 2}>0,E${n + 2}/C${n + 2},"")`, z: '0.0%' } : '',
        sum(6, n + 1, labor.days)],
    ], [12, 7, 16, 15, 14, 11, 12], {
      // เสาร์-อาทิตย์ พื้นเหลืองอ่อนแบบเดียวกับปฏิทินบนหน้าเว็บ
      style: (r) => (isWeekend(days[r - 1]) ? { fill: fill('FFFBEB') } : null),
    });

    // ---- 2. ตามตำแหน่ง ----
    const posRows = [];
    const posKind = [];   // 'pos' = แถวรวมของตำแหน่ง · 'type' = แถวแยกประเภท
    for (const p of labor.byPosition) {
      posRows.push([p.position, 'รวม', p.people, p.days, money(p.wage), pct(p.wage, labor.wage)]);
      posKind.push({ kind: 'pos' });
      for (const t of p.types) {
        posRows.push(['', t.type, t.people, t.days, money(t.wage), '']);
        posKind.push({ kind: 'type', type: t.type });
      }
    }
    add('ตามตำแหน่ง', [
      ['ตำแหน่ง', 'ประเภท', 'จำนวนคน', 'วันทำงาน', 'ค่าแรง', 'สัดส่วน'],
      ...posRows,
      // คนเดียวอยู่ได้หลายแถว (ย้ายตำแหน่งกลางงวด) ยอดคนจึงเป็นค่านับไม่ซ้ำ ไม่ใช่ SUM ของคอลัมน์
      ['รวมทุกตำแหน่ง', '', labor.people, labor.days, money(labor.wage), labor.wage > 0 ? { t: 'n', v: 1, z: '0%' } : ''],
    ], [24, 10, 10, 10, 14, 10], {
      style: (r, c) => {
        const k = posKind[r - 1];
        if (k.kind === 'pos') return { font: { bold: true }, fill: fill('FEF3C7') };
        if (c === 1) return typeStyle(k.type);
        return null;
      },
    });

    // ---- 3. ตารางงาน ----
    const dayCol0 = branch ? 4 : 5;
    const CELL_STYLE = {
      off: { fill: fill('FFE4E6'), font: { color: { rgb: 'BE123C' } }, alignment: { horizontal: 'center' } },
      paidLeave: { fill: fill('E0E7FF'), font: { color: { rgb: '3730A3' } }, alignment: { horizontal: 'center' } },
      unpaidLeave: { fill: fill('FECACA'), font: { color: { rgb: '991B1B' } }, alignment: { horizontal: 'center' } },
      work: { alignment: { horizontal: 'center' } },
    };
    const np = people.length;
    add('ตารางงาน', [
      ['รหัส', 'ชื่อ', ...(branch ? [] : ['สาขา']), 'ตำแหน่ง', 'ประเภท',
        ...days.map((d) => `${DOW[weekdayOf(d)]} ${dm(d)}`), 'วันทำงาน', 'ค่าแรง'],
      ...people.map((p) => [p.code, p.name, ...(branch ? [] : [p.branch]), p.position, p.type,
        ...days.map((d) => p.cells[d]?.title || ''), p.days, money(p.wage)]),
      ['รวม', `${np} คน`, ...(branch ? [] : ['']), '', '', ...days.map(() => ''),
        sum(dayCol0 + days.length, np + 1, labor.days),
        sum(dayCol0 + days.length + 1, np + 1, labor.wage, MONEY)],
    ], [10, 24, ...(branch ? [] : [8]), 16, 8, ...days.map(() => 12), 10, 12], {
      style: (r, c) => {
        const p = people[r - 1];
        if (c === dayCol0 - 1) return typeStyle(p.type);
        const di = c - dayCol0;
        if (di >= 0 && di < days.length) return CELL_STYLE[p.cells[days[di]]?.kind] || null;
        if (di >= days.length) return { font: { bold: true }, fill: fill('FFFBEB') };
        return null;
      },
    });

    // ---- 4. หักสาย ----
    const nl = lateRows.length;
    const lateHead = ['วันที่', 'รหัส', 'ชื่อ', 'ประเภท', ...(branch ? [] : ['สาขา']),
      'ตาราง เข้า', 'สแกน เข้า', 'เข้าสาย (นาที)', 'เบรคสาย (นาที)', 'ออกก่อน (นาที)', 'รวมสาย (นาที)'];
    const late0 = lateHead.indexOf('เข้าสาย (นาที)');
    add('หักสาย', [
      lateHead,
      ...lateRows.map((d) => [d.date, d.empCode, d.name, d.plan?.empType || '', ...(branch ? [] : [d.branch]),
        d.plan?.in || '', hhmm(d.first) || '',
        d.lateIn ?? '', d.lateBreakIn ?? '', d.earlyOut ?? '', totalLateOf(d) ?? '']),
      ['รวม', `${nl} ครั้ง`, `${lateTotals.people.size} คน`, '', ...(branch ? [] : ['']), '', '',
        sum(late0, nl + 1, lateTotals.lateIn), sum(late0 + 1, nl + 1, lateTotals.lateBreakIn),
        sum(late0 + 2, nl + 1, lateTotals.earlyOut), sum(late0 + 3, nl + 1, lateTotals.total)],
    ], [12, 10, 24, 8, ...(branch ? [] : [8]), 10, 10, 12, 12, 12, 12], {
      style: (r, c, cell) => {
        if (c === 3) return typeStyle(laborTypeOf(cell.v));
        if (c === late0 - 2) return { fill: fill('EEF2FF'), font: { color: { rgb: '4338CA' } }, alignment: { horizontal: 'center' } };
        if (c === late0 - 1) return { font: { bold: true, color: { rgb: '047857' } }, alignment: { horizontal: 'center' } };
        if (c >= late0) {
          const red = Number(cell.v) > 0;
          return {
            fill: fill(c === late0 + 3 ? 'FFE4E6' : 'FFF1F2'),
            font: red ? { bold: true, color: { rgb: 'BE123C' } } : { color: { rgb: '94A3B8' } },
            alignment: { horizontal: 'center' },
          };
        }
        return null;
      },
    });

    XLSX.writeFile(wb, `labor_${branch || 'ALL'}_${startDate}_${endDate}.xlsx`);
  };

  const salesTotal = sales ? sales.total : null;

  return (
    <div className="space-y-5">
      {/* หัวข้อ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack} aria-label="กลับหน้าดูสแกนหน้า" title="กลับหน้าดูสแกนหน้า"
            className="p-2.5 rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="text-xs text-slate-500">
              <button onClick={onBack} className="font-semibold hover:text-amber-600">ดูสแกนหน้า</button>
              <span className="mx-1.5 text-slate-300">›</span>ค่าแรง
            </div>
            <h2 className="text-xl font-bold text-slate-800">ค่าแรง · {branch ? `สาขา ${branch}` : 'ทุกสาขา'}</h2>
            <p className="text-xs text-slate-500">
              {startDate === endDate ? startDate : `${startDate} ถึง ${endDate}`} ({days.length} วัน)
              {' · '}ค่าแรงจากตารางงานที่สาขาลงไว้ (ยอดเดียวกับหน้าลงตารางของสาขา)
            </p>
          </div>
        </div>
        <button
          onClick={exportExcel}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Download size={14} /> Excel
        </button>
      </div>

      {/* 1. ตัวเลขหลัก */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-amber-50 border-2 border-amber-400 rounded-2xl p-4">
          <div className="text-xs font-semibold text-amber-800 flex items-center gap-1.5"><Wallet size={14} /> ค่าแรงรวม</div>
          <div className="text-3xl font-bold text-slate-800 mt-1">{baht(labor.wage)} <span className="text-sm font-medium text-slate-500">บาท</span></div>
          <div className="text-xs text-slate-600">เฉลี่ย {baht(days.length ? labor.wage / days.length : 0)} / วัน</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="text-xs font-semibold text-slate-500">ยอดขายรวม VAT {branch || '(ทุกสาขา)'}</div>
          {noOutlet ? (
            <div className="text-sm text-slate-500 mt-2">สาขานี้ไม่มีรหัสร้าน POS ในทะเบียนสาขา — ไม่มียอดขายให้เทียบ</div>
          ) : salesLoading ? (
            <div className="text-sm text-slate-500 mt-2 flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> {salesProgress || 'กำลังดึงยอดขาย…'}</div>
          ) : salesError ? (
            <div className="text-xs text-rose-600 mt-2 space-y-1">
              <div className="flex items-start gap-1"><AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {salesError}</div>
              <button onClick={() => setSalesKey((k) => k + 1)} className="inline-flex items-center gap-1 font-semibold text-amber-700 hover:underline">
                <RefreshCw size={12} /> ลองใหม่
              </button>
            </div>
          ) : (
            <>
              <div className="text-3xl font-bold text-slate-800 mt-1">{baht(salesTotal)} <span className="text-sm font-medium text-slate-500">บาท</span></div>
              <div className="text-xs text-slate-600">
                ก่อน VAT {baht(sales?.beforeVat)} · {sales?.bills.toLocaleString('en-US')} บิล
              </div>
            </>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="text-xs font-semibold text-slate-500">ค่าแรง / ยอดขาย</div>
          <div className="text-3xl font-bold text-emerald-700 mt-1">{salesTotal != null ? pctText(labor.wage, salesTotal) : '—'}</div>
          <div className="text-xs text-slate-600">เทียบกับยอดขายรวม VAT (ตัวเลขเดียวกับหน้ายอดขาย)</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="text-xs font-semibold text-slate-500">พนักงาน</div>
          <div className="text-3xl font-bold text-slate-800 mt-1">{labor.people} <span className="text-sm font-medium text-slate-500">คน</span></div>
          <div className="text-xs text-slate-600">รวม {labor.days.toLocaleString('en-US')} วันทำงาน</div>
        </div>
      </div>

      {/* 2. ยอดขายแต่ละวัน */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-bold text-slate-800">ยอดขาย {branch || 'ทุกสาขา'} แต่ละวัน</h3>
          <span className="text-xs text-slate-500">ในช่อง: ยอดขาย · ค่าแรง · % ค่าแรง</span>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[980px] grid grid-cols-[repeat(7,minmax(0,1fr))_140px] text-xs">
            {DOW_HEAD.map((h, i) => (
              <div key={h} className={`px-3 py-2 text-center font-semibold ${i >= 5 ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'}`}>{h}</div>
            ))}
            <div className="px-3 py-2 text-center font-semibold bg-amber-100 text-amber-900">รวมสัปดาห์</div>
            {weeks.map((week, wi) => {
              const inWeek = week.filter(Boolean);
              const wl = inWeek.reduce((s, d) => s + laborOf(d), 0);
              const ws = sales ? inWeek.reduce((s, d) => s + (salesOf(d) || 0), 0) : null;
              return (
                <React.Fragment key={wi}>
                  {week.map((d, di) => (d ? (
                    <div key={d} className={`min-h-[76px] px-3 py-2 border-t border-l border-slate-100 flex flex-col gap-0.5 ${isWeekend(d) ? 'bg-amber-50/30' : ''}`}>
                      <span className="text-[11px] text-slate-500">{DOW[weekdayOf(d)]} {dm(d)}</span>
                      <span className="text-[15px] font-bold text-slate-800">{sales ? baht(salesOf(d)) : <span className="text-slate-300">…</span>}</span>
                      <span className="text-slate-600">ค่าแรง {baht(laborOf(d))}</span>
                      <span className="font-semibold text-emerald-700">{sales ? pctText(laborOf(d), salesOf(d)) : ''}</span>
                    </div>
                  ) : (
                    <div key={`x${wi}-${di}`} className="min-h-[76px] border-t border-l border-slate-100 bg-slate-50" />
                  )))}
                  <div className="min-h-[76px] px-3 py-2 border-t border-l border-amber-200 bg-amber-50 flex flex-col gap-0.5">
                    <span className="text-[11px] text-amber-800">{dm(inWeek[0])}–{dm(inWeek[inWeek.length - 1])}</span>
                    <span className="text-[15px] font-bold text-slate-800">{ws != null ? baht(ws) : <span className="text-slate-300">…</span>}</span>
                    <span className="text-slate-600">ค่าแรง {baht(wl)}</span>
                    <span className="font-semibold text-amber-800">{ws != null ? pctText(wl, ws) : ''}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* 3. สรุปตามตำแหน่ง */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-800">สรุปตามตำแหน่ง</h3>
            <p className="text-xs text-slate-500">กดบรรทัดเพื่อดูแยกประเภท F/T · P/T · DAY · DAY9 ว่ากี่คน กี่วัน</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {labor.byType.map((t) => (
              <span key={t.type} className={`text-xs font-semibold rounded-full px-2.5 py-1 ${typeCls(t.type)}`}>
                {t.type} · {t.people} คน · {t.days} วัน · {baht(t.wage)} ฿
              </span>
            ))}
          </div>
        </div>
        {labor.byPosition.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">ไม่มีตารางงานที่ลงไว้ในช่วงนี้</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="bg-slate-50 text-xs text-slate-500">
                  <th className="px-4 py-2.5 text-left font-semibold">ตำแหน่ง</th>
                  <th className="px-3 py-2.5 text-right font-semibold">จำนวนคน</th>
                  <th className="px-3 py-2.5 text-right font-semibold">วันทำงาน</th>
                  <th className="px-3 py-2.5 text-right font-semibold">ค่าแรง (บาท)</th>
                  <th className="px-4 py-2.5 text-right font-semibold">สัดส่วน</th>
                </tr>
              </thead>
              <tbody>
                {labor.byPosition.map((p) => {
                  const open = openPos.has(p.position);
                  return (
                    <React.Fragment key={p.position}>
                      <tr
                        onClick={() => togglePos(p.position)}
                        className={`border-t border-slate-100 cursor-pointer ${open ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
                      >
                        <td className="px-4 py-2.5 font-semibold text-slate-800">
                          <button
                            type="button" aria-expanded={open}
                            onClick={(e) => { e.stopPropagation(); togglePos(p.position); }}
                            className="inline-flex items-center gap-1.5"
                          >
                            {open ? <ChevronDown size={16} className="text-amber-600" /> : <ChevronRight size={16} className="text-amber-600" />}
                            {p.position}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-right">{p.people} คน</td>
                        <td className="px-3 py-2.5 text-right">{p.days} วัน</td>
                        <td className="px-3 py-2.5 text-right font-semibold">{baht(p.wage)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-500">{labor.wage > 0 ? `${((p.wage / labor.wage) * 100).toFixed(1)}%` : '—'}</td>
                      </tr>
                      {open && p.types.map((t) => (
                        <tr key={`${p.position}|${t.type}`} className="bg-amber-50/60 text-[13px] text-slate-700">
                          <td className="pl-11 pr-4 py-2">
                            <span className="inline-flex items-center gap-2">
                              <TypeChip type={t.type} />
                              <span className="text-xs text-slate-500">{TYPE_NOTE[t.type] || ''}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">{t.people} คน</td>
                          <td className="px-3 py-2 text-right">{t.days} วัน</td>
                          <td className="px-3 py-2 text-right">{baht(t.wage)}</td>
                          <td className="px-4 py-2" />
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-amber-100 font-bold text-amber-950">
                  <td className="px-4 py-2.5">รวมทุกตำแหน่ง</td>
                  <td className="px-3 py-2.5 text-right">{labor.people} คน</td>
                  <td className="px-3 py-2.5 text-right">{labor.days} วัน</td>
                  <td className="px-3 py-2.5 text-right">{baht(labor.wage)}</td>
                  <td className="px-4 py-2.5 text-right">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* 4. ตารางการทำงาน / ตารางสแกนหักสาย */}
      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1" role="tablist">
            {[['schedule', 'ตารางการทำงาน'], ['late', 'ตารางสแกน · หักสาย']].map(([k, t]) => (
              <button
                key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === k ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500">
            {tab === 'schedule'
              ? `ตารางงานที่สาขาลงไว้ · ${people.length} คน`
              : `เทียบตารางงานกับเวลาสแกนจริง · เฉพาะวันที่สาย · ${lateRows.length} ครั้ง ${lateTotals.people.size} คน`}
          </span>
        </div>

        {tab === 'schedule' && (people.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">ไม่มีตารางงานที่ลงไว้ในช่วงนี้</div>
        ) : (
          <>
            <div className="overflow-x-auto max-h-[70vh]">
              <table className="text-xs border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th className="sticky left-0 top-0 z-20 bg-slate-50 px-3 py-2 text-left font-semibold text-slate-600 min-w-[220px] border-b border-slate-200">พนักงาน</th>
                    {days.map((d) => (
                      <th key={d} className={`sticky top-0 z-10 px-1 py-1.5 text-center font-semibold min-w-[52px] border-b border-slate-200 leading-tight ${isWeekend(d) ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'}`}>
                        {DOW[weekdayOf(d)]}<br />{Number(d.slice(8))}
                      </th>
                    ))}
                    <th className="sticky top-0 z-10 bg-amber-100 px-2 py-2 text-right font-semibold text-amber-900 border-b border-slate-200">วัน</th>
                    <th className="sticky top-0 z-10 bg-amber-100 px-3 py-2 text-right font-semibold text-amber-900 border-b border-slate-200">ค่าแรง</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.key}>
                      <td className="sticky left-0 z-10 bg-white px-3 py-1.5 border-b border-slate-100">
                        <div className="font-semibold text-slate-800 text-[13px]">{p.name}</div>
                        <div className="text-slate-500 flex items-center gap-1.5">
                          <span className="font-mono">{p.code}</span>
                          {!branch && <span>· {p.branch}</span>}
                          {p.position && <span>· {p.position}</span>}
                          <TypeChip type={p.type} />
                        </div>
                      </td>
                      {days.map((d) => {
                        const c = p.cells[d];
                        return (
                          <td key={d} className="px-0.5 py-1.5 text-center border-b border-slate-100" title={c?.title || ''}>
                            {c?.text
                              ? <span className={`inline-block rounded px-1 py-0.5 text-[11px] whitespace-nowrap ${CELL_CLS[c.kind] || ''}`}>{c.text}</span>
                              : <span className="text-slate-200">·</span>}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-right font-semibold bg-amber-50/60 border-b border-slate-100">{p.days}</td>
                      <td className="px-3 py-1.5 text-right font-semibold bg-amber-50/60 border-b border-slate-100">{baht(p.wage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2.5 border-t border-slate-100 flex flex-wrap gap-3 text-xs text-slate-600">
              <span><span className={`rounded px-1.5 py-0.5 ${CELL_CLS.work}`}>13:30</span> เวลาเข้างานที่ลงไว้ (ชี้ดูเวลาออก)</span>
              <span><span className={`rounded px-1.5 py-0.5 ${CELL_CLS.off}`}>หยุด</span> วันหยุด</span>
              <span><span className={`rounded px-1.5 py-0.5 ${CELL_CLS.paidLeave}`}>13</span> ลา (รับค่าแรง)</span>
              <span><span className={`rounded px-1.5 py-0.5 ${CELL_CLS.unpaidLeave}`}>21</span> หยุด (ไม่รับค่าแรง)</span>
            </div>
          </>
        ))}

        {tab === 'late' && (lateRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-400">ไม่มีใครสายในช่วงนี้ (หรือยังไม่มีตารางงานให้เทียบ)</div>
        ) : (
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="text-[11px] font-semibold">
                  <th colSpan={branch ? 4 : 5} className="bg-slate-50" />
                  <th className="px-2 py-1.5 bg-indigo-100 text-indigo-800">ตารางงาน</th>
                  <th className="px-2 py-1.5 bg-emerald-100 text-emerald-800">สแกนจริง</th>
                  <th colSpan={4} className="px-2 py-1.5 bg-rose-100 text-rose-800">สาย (นาที)</th>
                </tr>
                <tr className="text-xs text-slate-500">
                  <th className="px-3 py-2 text-left bg-slate-50">วันที่</th>
                  <th className="px-3 py-2 text-left bg-slate-50">รหัส</th>
                  <th className="px-3 py-2 text-left bg-slate-50">ชื่อ</th>
                  <th className="px-3 py-2 text-left bg-slate-50">ประเภท</th>
                  {!branch && <th className="px-3 py-2 text-left bg-slate-50">สาขา</th>}
                  <th className="px-3 py-2 text-center bg-indigo-50">เข้า</th>
                  <th className="px-3 py-2 text-center bg-emerald-50">เข้า</th>
                  <th className="px-3 py-2 text-center bg-rose-50">เข้าสาย</th>
                  <th className="px-3 py-2 text-center bg-rose-50">เบรคสาย</th>
                  <th className="px-3 py-2 text-center bg-rose-50">ออกก่อน</th>
                  <th className="px-3 py-2 text-center bg-rose-100">รวมสาย</th>
                </tr>
              </thead>
              <tbody>
                {lateRows.map((d) => (
                  <tr key={`${d.date}|${d.empCode}|${d.branch}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 whitespace-nowrap">{d.date}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{d.empCode}</td>
                    <td className="px-3 py-2">{d.name}</td>
                    <td className="px-3 py-2">{d.plan?.empType ? <TypeChip type={laborTypeOf(d.plan.empType)}>{d.plan.empType}</TypeChip> : ''}</td>
                    {!branch && <td className="px-3 py-2 text-slate-500">{d.branch}</td>}
                    <td className="px-3 py-2 text-center font-mono text-indigo-700 bg-indigo-50/40">{d.plan?.in || '—'}</td>
                    <td className="px-3 py-2 text-center font-mono font-semibold text-emerald-700">{hhmm(d.first) || '—'}</td>
                    <td className="px-3 py-2 text-center bg-rose-50/30">{lateNum(d.lateIn)}</td>
                    <td className="px-3 py-2 text-center bg-rose-50/30">{lateNum(d.lateBreakIn)}</td>
                    <td className="px-3 py-2 text-center bg-rose-50/30">{lateNum(d.earlyOut)}</td>
                    <td className="px-3 py-2 text-center bg-rose-100/50">{lateNum(totalLateOf(d))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-rose-50 font-bold text-rose-900">
                  <td colSpan={branch ? 6 : 7} className="px-3 py-2.5">รวม {lateRows.length} ครั้ง · {lateTotals.people.size} คน</td>
                  <td className="px-3 py-2.5 text-center">{lateTotals.lateIn}</td>
                  <td className="px-3 py-2.5 text-center">{lateTotals.lateBreakIn}</td>
                  <td className="px-3 py-2.5 text-center">{lateTotals.earlyOut}</td>
                  <td className="px-3 py-2.5 text-center bg-rose-100">{lateTotals.total}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
