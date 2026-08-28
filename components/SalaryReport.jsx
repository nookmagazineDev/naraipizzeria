import React, { useState, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx-js-style';
import {
  Wallet, Loader2, Search, Building2, Download, AlertCircle, RefreshCw,
  Printer, CalendarClock, CalendarDays, X,
} from 'lucide-react';
import { summarizeDaily, attachSchedule } from '../lib/attendance';
import { useBranches } from '../lib/useBranches';
import {
  summarizeSalary, payableTotal, payableUnitLabel, periodDays,
  hhmmOfMinutes, hhmmOfHours, LEAVE_COLUMNS, loadHolidays, saveHolidays,
} from '../lib/payroll';

/*
 * NARAI OFFICE — HR → รายงานเงินเดือน (ฟอร์ม Summary รายสาขา สำหรับพิมพ์)
 *
 * เลือกสาขา + ช่วงวันที่ (วันที่เท่าไหร่ถึงเท่าไหร่) แล้วกดดึงข้อมูล จะได้ตารางหน้าตาเดียวกับ
 * ชีต "Summary <สาขา>" ที่ฝ่ายบุคคลใช้อยู่ (31 คอลัมน์ + แถวรหัสลาเหนือหัวตาราง)
 * แล้วกด "พิมพ์" ออกกระดาษ หรือส่งออก Excel ไปวางในชีตเดิมได้เลย
 *
 * ข้อมูลมาจากสองที่เดียวกับหน้า "ดูสแกนหน้า":
 *   ตารางงานที่สาขาลงไว้ (/api/hr-schedule) = ตัวหลัก — วันทำงาน/ลา/หยุด/OT/เวลาที่ลงไว้
 *   เวลาสแกนหน้า (/api/attendance)          = ตัวเสริม — นาทีที่สาย (ใช้หักออกจากเวลาทำงาน)
 * ดึงสแกนไม่ได้ก็ยังออกรายงานได้ (ช่องสายจะเป็น 0) แต่ดึงตารางงานไม่ได้ = ไม่มีวันทำงานให้สรุป
 *
 * "นข" (นักขัตฤกษ์) ตารางงานไม่ได้บอกว่าวันไหนเป็นวันนักขัตฤกษ์ จึงให้ระบุวันเองในหน้านี้
 * วันทำงานที่ตรงกับวันที่ระบุไว้จะถูกแยกไปลงช่อง นข ตามฟอร์ม
 */

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** วันที่แบบไทยไว้โชว์บนหัวกระดาษ */
const thaiDate = (ymd) => {
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d) ? ymd : d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
};

/** วันที่สั้นๆ ไว้แสดงบนป้ายวันนักขัตฤกษ์ */
const shortDate = (ymd) => {
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d) ? ymd : d.toLocaleDateString('th-TH', { month: 'short', day: 'numeric' });
};

/**
 * ช่วงวันที่สำเร็จรูปของงวดเงินเดือน — ตัดท้ายไม่ให้เกิน "วันนี้" เสมอ
 * (วันข้างหน้ามีแต่ตารางที่ลงไว้ล่วงหน้า ยังไม่ได้ทำงานจริง เอามาสรุปไม่ได้)
 */
function presetRange(key, now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cap = (d) => (d > t ? t : d);
  switch (key) {
    case 'thisMonth':
      return { start: fmtDate(new Date(t.getFullYear(), t.getMonth(), 1)), end: fmtDate(t) };
    case 'lastMonth': {
      const first = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const last = new Date(t.getFullYear(), t.getMonth(), 0);
      return { start: fmtDate(first), end: fmtDate(cap(last)) };
    }
    case 'firstHalf':
      return {
        start: fmtDate(new Date(t.getFullYear(), t.getMonth(), 1)),
        end: fmtDate(cap(new Date(t.getFullYear(), t.getMonth(), 15))),
      };
    case 'secondHalf': {
      // ยังไม่ถึงวันที่ 16 ของเดือนนี้ = งวดหลังที่ปิดแล้วคือของเดือนที่แล้ว
      const m = t.getDate() < 16 ? t.getMonth() - 1 : t.getMonth();
      return {
        start: fmtDate(new Date(t.getFullYear(), m, 16)),
        end: fmtDate(cap(new Date(t.getFullYear(), m + 1, 0))),
      };
    }
    default:
      return { start: fmtDate(new Date(t.getFullYear(), t.getMonth(), 1)), end: fmtDate(t) };
  }
}

const PRESETS = [
  { key: 'thisMonth', label: 'เดือนนี้' },
  { key: 'lastMonth', label: 'เดือนที่แล้ว' },
  { key: 'firstHalf', label: 'งวด 1–15' },
  { key: 'secondHalf', label: 'งวด 16–สิ้นเดือน' },
];

/* หัวตารางตามฟอร์ม — 15 คอลัมน์แรก, คอลัมน์วันลาอีก 14 ช่อง แล้วปิดท้ายอีก 2 ช่อง
   กว้างรวม 31 คอลัมน์เท่าชีต Summary ของฝ่ายบุคคล */
const HEAD_LEFT = [
  { key: 'branch', label: 'สาขา', align: 'left' },
  { key: 'badge', label: 'Badgenumber', align: 'left' },
  { key: 'ssn', label: 'SSN', align: 'left' },
  { key: 'name', label: 'ชื่อ', align: 'left' },
  { key: 'position', label: 'ตำแหน่ง', align: 'left' },
  { key: 'empType', label: 'สถานะ', align: 'left' },
  { key: 'workDays', label: 'วันทำงาน' },
  { key: 'holidayWorkDays', label: 'วันทำงาน นข' },
  { key: 'ot', label: 'OT' },
  { key: 'lateCut', label: 'หักสาย' },
  { key: 'holidayLateCut', label: 'หักสาย นข' },
  { key: 'workTime', label: 'เวลาทำงาน' },
  { key: 'holidayWorkTime', label: 'เวลาทำงาน นข' },
  { key: 'lateMinutes', label: 'สาย (นาที)' },
  { key: 'holidayLateMinutes', label: 'สาย นข (นาที)' },
];

export default function SalaryReport() {
  const { codes: branchCodes } = useBranches();
  const today = fmtDate(new Date());
  const thisMonth = presetRange('thisMonth');

  const [branch, setBranch] = useState('');              // '' = ทุกสาขา
  const [startDate, setStartDate] = useState(thisMonth.start);
  const [endDate, setEndDate] = useState(thisMonth.end);
  const [preset, setPreset] = useState('thisMonth');     // '' = กำหนดวันที่เอง
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');            // ตารางงานถูกตัด/สาขาบางตัวดึงไม่ได้
  const [scanNote, setScanNote] = useState('');          // ดึงเวลาสแกนไม่ได้ (รายงานยังออกได้)
  const [schedRows, setSchedRows] = useState(null);      // null = ยังไม่เคยดึง
  const [punches, setPunches] = useState([]);
  const [loaded, setLoaded] = useState(null);            // ช่วง/สาขาของข้อมูลชุดที่ถืออยู่
  const [search, setSearch] = useState('');

  const [holidays, setHolidays] = useState([]);          // วันนักขัตฤกษ์ ['YYYY-MM-DD']
  const [newHoliday, setNewHoliday] = useState('');
  const [holidayNote, setHolidayNote] = useState('');

  // localStorage อ่านได้เฉพาะฝั่งเบราว์เซอร์ — อ่านหลัง mount เพื่อให้ HTML รอบแรกตรงกับฝั่งเซิร์ฟเวอร์
  useEffect(() => { setHolidays(loadHolidays()); }, []);

  const load = async (opts = {}) => {
    const s = opts.start || startDate;
    const e = opts.end || endDate;
    const b = opts.branch !== undefined ? opts.branch : branch;
    if (!s || !e) { setError('กรุณาเลือกช่วงวันที่'); return; }
    if (s > e) { setError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด'); return; }
    setLoading(true);
    setError('');
    setWarning('');
    setScanNote('');
    try {
      // ตารางงาน = ตัวหลัก ดึงไม่ได้ = ออกรายงานไม่ได้
      const p = new URLSearchParams({ start: s, end: e });
      if (b) p.set('branches', b);
      const res = await fetch(`/api/hr-schedule?${p.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status !== 'success') {
        throw new Error((json && json.message) || `ดึงตารางงานไม่สำเร็จ (${res.status})`);
      }
      setSchedRows(json.data || []);

      const notes = [];
      if (json.unknown?.length) notes.push(`ไม่มีสาขา ${json.unknown.join(', ')} ในฐานข้อมูลตารางงาน`);
      if (json.failed?.length) notes.push(`ดึงตารางงานไม่ได้: ${json.failed.map((f) => f.branch).join(', ')}`);
      if (json.truncated) notes.push(json.message || 'ตารางงานถูกตัดเพราะช่วงวันที่กว้างเกินไป — ยอดที่ได้จะไม่ครบ');
      if ((json.count || 0) === 0) notes.push('ช่วงวันที่นี้ยังไม่มีใครลงตารางงานไว้');
      setWarning(notes.join(' · '));
      setLoaded({ start: s, end: e, branch: b });

      await loadPunches({ start: s, end: e, branch: b });
    } catch (err) {
      setSchedRows(null);
      setPunches([]);
      setLoaded(null);
      setError(err.message || 'ดึงข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };

  /** เวลาสแกนจริงเป็นข้อมูลเสริม — ใช้คิดนาทีที่สาย ดึงไม่ได้ก็ยังสรุปวันทำงานได้ */
  const loadPunches = async ({ start: s, end: e, branch: b }) => {
    try {
      const p = new URLSearchParams({ start: s, end: e });
      if (b) p.set('branch', b);
      const res = await fetch(`/api/attendance?${p.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status !== 'success') {
        throw new Error((json && json.message) || `ดึงเวลาสแกนไม่สำเร็จ (${res.status})`);
      }
      setPunches(json.data || []);
      setScanNote(json.truncated ? (json.message || 'เวลาสแกนถูกตัดเพราะช่วงวันที่กว้างเกินไป') : '');
    } catch (err) {
      setPunches([]);
      setScanNote(`${err.message || 'ดึงเวลาสแกนไม่สำเร็จ'} — สรุปจากตารางงานอย่างเดียว (ช่องสายและหักสายจะเป็น 0)`);
    }
  };

  const applyPreset = (key) => {
    const { start, end } = presetRange(key);
    setPreset(key);
    setStartDate(start);
    setEndDate(end);
    load({ start, end });
  };

  const setStart = (v) => { setStartDate(v); setPreset(''); };
  const setEnd = (v) => { setEndDate(v); setPreset(''); };

  // ----- วันหยุดนักขัตฤกษ์ (นข) -----

  const persistHolidays = (list) => {
    const next = [...new Set(list)].sort();
    setHolidays(next);
    setHolidayNote(saveHolidays(next) ? '' : 'เบราว์เซอร์นี้จำวันนักขัตฤกษ์ไว้ไม่ได้ (โหมดส่วนตัว?) — ปิดหน้าแล้วต้องกรอกใหม่');
  };
  const addHoliday = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newHoliday)) return;
    persistHolidays([...holidays, newHoliday]);
    setNewHoliday('');
  };
  const removeHoliday = (d) => persistHolidays(holidays.filter((x) => x !== d));

  // ตารางงาน + สแกน -> แถวรายวัน -> ยอดรายคนตามฟอร์ม
  // includeUnscanned ต้องเปิดเสมอ เพราะวันหยุด/วันลาไม่มีใครไปสแกน ถ้าไม่เอาเข้ามาด้วย
  // คอลัมน์วันลาจะว่างทั้งแถว
  const daily = useMemo(
    () => attachSchedule(summarizeDaily(punches), schedRows || [], { includeUnscanned: true }),
    [punches, schedRows]
  );

  // วันนักขัตฤกษ์ที่อยู่ในช่วงของข้อมูลชุดที่ถืออยู่ — นอกช่วงไม่มีผลกับรายงาน
  const holidaysInRange = useMemo(
    () => (loaded ? holidays.filter((d) => d >= loaded.start && d <= loaded.end) : []),
    [holidays, loaded]
  );

  const people = useMemo(
    () => summarizeSalary(daily, { holidays: holidaysInRange }),
    [daily, holidaysInRange]
  );

  const days = loaded ? periodDays(loaded.start, loaded.end) : 0;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people
      .filter((p) => !q
        || p.badge.toLowerCase().includes(q)
        || p.ssn.toLowerCase().includes(q)
        || p.name.toLowerCase().includes(q))
      .map((p) => ({ ...p, payable: payableTotal(p, days) }));
  }, [people, search, days]);

  // แถวที่ควรไปตรวจต่อ — ลงตารางว่าทำงานแต่ไม่มีสแกน / มีสแกนแต่ไม่มีในตารางงาน
  const checkStats = useMemo(() => ({
    noScan: rows.reduce((n, r) => n + r.noScanDays, 0),
    noPlan: rows.reduce((n, r) => n + r.noPlanDays, 0),
  }), [rows]);

  /** ค่าของแต่ละคนเรียงตามคอลัมน์ในฟอร์ม (ใช้ทั้งตารางบนจอและไฟล์ Excel) */
  const cellsOf = (r) => [
    r.branch, r.badge, r.ssn, r.name, r.position, r.empType,
    r.workDays, r.holidayWorkDays,
    hhmmOfHours(r.otHours), hhmmOfMinutes(r.lateMinutes), hhmmOfMinutes(r.holidayLateMinutes),
    hhmmOfMinutes(r.workMinutes), hhmmOfMinutes(r.holidayWorkMinutes),
    r.lateMinutes, r.holidayLateMinutes,
    ...LEAVE_COLUMNS.map((c) => r.leaveDays[c.code] || 0),
    r.payable, r.lateMinutes + r.holidayLateMinutes,
  ];

  /** ไฟล์ Excel วางทับชีต Summary ได้เลย — แถวแรกเป็นรหัสลา แถวสองเป็นหัวตาราง */
  const exportExcel = () => {
    const codeRow = [
      loaded?.branch || '', ...Array(14).fill(''),
      ...LEAVE_COLUMNS.map((c) => Number(c.code)),
      '', '',
    ];
    const headRow = [
      ...HEAD_LEFT.map((h) => h.label),
      ...LEAVE_COLUMNS.map((c) => c.label),
      'วันทำงาน', 'รวมสาย (นาที)',
    ];
    const aoa = [codeRow, headRow, ...rows.map(cellsOf)];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = headRow.map((h, i) => ({ wch: i === 3 ? 26 : Math.max(8, h.length + 2) }));
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const head = ws[XLSX.utils.encode_cell({ r: 1, c })];
      if (head) {
        head.s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: 'F59E0B' } },
          alignment: { horizontal: 'center', wrapText: true },
        };
      }
      const code = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (code) code.s = { font: { bold: true }, alignment: { horizontal: 'center' } };
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Summary ${loaded?.branch || 'ALL'}`.slice(0, 31));
    XLSX.writeFile(wb, `summary_${loaded?.branch || 'ALL'}_${loaded?.start}_${loaded?.end}.xlsx`);
  };

  const periodText = !loaded ? ''
    : loaded.start === loaded.end
      ? thaiDate(loaded.start)
      : `${thaiDate(loaded.start)} ถึง ${thaiDate(loaded.end)}`;

  // ช่องตัวเลข — ค่าที่เป็น 0 ทำให้จางลงเหมือนในชีต จะได้กวาดตาหาช่องที่มีค่าได้เร็ว
  // (เช็คจากตัวเลขจริง ไม่ใช่ข้อความที่แสดง เพราะ '00:00' เป็นข้อความที่ไม่ว่าง)
  const numCls = 'px-1.5 py-1 text-center font-mono tabular-nums';
  const cell = (value, accent = '') => `${numCls} ${value ? accent : 'text-slate-300'}`;

  return (
    <div className="space-y-6">
      {/* หัวข้อ */}
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-100 text-amber-600 rounded-xl"><Wallet size={22} /></div>
          <div>
            <h2 className="text-xl font-bold text-slate-800">รายงานเงินเดือน</h2>
            <p className="text-xs text-slate-500">
              ฟอร์มเดียวกับชีต Summary ของฝ่ายบุคคล • เลือกสาขาและช่วงวันที่ แล้วสั่งพิมพ์หรือส่งออก Excel
            </p>
          </div>
        </div>
      </div>

      {/* ตัวกรอง */}
      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm space-y-3 no-print">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">งวด</span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              disabled={loading}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${
                preset === p.key ? 'bg-amber-500 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
          <span className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${preset === '' ? 'bg-slate-800 text-white' : 'text-slate-400'}`}>
            กำหนดเอง
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
          <div className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-xl mt-3">
            <Building2 size={16} className="text-slate-400" />
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="text-sm text-slate-700 bg-transparent focus:outline-none cursor-pointer"
            >
              <option value="">ทุกสาขา</option>
              {branchCodes.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <input
            type="date" value={startDate} max={endDate}
            onChange={(e) => setStart(e.target.value)}
            className="px-3 py-2 mt-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-amber-500 outline-none"
          />
          <span className="text-slate-400 text-sm mt-3">ถึง</span>
          <input
            type="date" value={endDate} min={startDate} max={today}
            onChange={(e) => setEnd(e.target.value)}
            className="px-3 py-2 mt-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-amber-500 outline-none"
          />
          <button
            onClick={() => load()} disabled={loading}
            className="inline-flex items-center gap-2 px-5 py-2 mt-3 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {loading ? 'กำลังดึงข้อมูล…' : 'ดึงข้อมูล'}
          </button>
          {schedRows !== null && (
            <button
              onClick={() => load()} disabled={loading}
              title="โหลดใหม่"
              className="p-2 mt-3 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={16} />
            </button>
          )}
          {!loading && loaded && (
            <span className="text-xs text-slate-400 mt-3">
              ข้อมูล: {periodText} · {loaded.branch || 'ทุกสาขา'} · {days} วัน
            </span>
          )}
        </div>

        {/* วันหยุดนักขัตฤกษ์ — ตารางงานไม่ได้บอกไว้ ต้องระบุเองเพื่อให้ช่อง "นข" มีค่า */}
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500 inline-flex items-center gap-1.5">
            <CalendarDays size={14} className="text-slate-400" /> วันหยุดนักขัตฤกษ์ (นข)
          </span>
          <input
            type="date" value={newHoliday}
            onChange={(e) => setNewHoliday(e.target.value)}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 outline-none"
          />
          <button
            onClick={addHoliday}
            disabled={!newHoliday}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-40"
          >
            เพิ่ม
          </button>
          {holidays.length === 0 ? (
            <span className="text-xs text-slate-400">ยังไม่ได้ระบุ — วันทำงานทุกวันจะนับเป็นวันทำงานปกติ (ช่อง นข เป็น 0)</span>
          ) : (
            holidays.map((d) => {
              const inRange = loaded && d >= loaded.start && d <= loaded.end;
              return (
                <span
                  key={d}
                  title={inRange ? `${d} — อยู่ในงวดนี้` : `${d} — อยู่นอกงวดที่เลือก ไม่มีผลกับรายงาน`}
                  className={`inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg text-xs font-medium border ${
                    inRange ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-slate-50 border-slate-200 text-slate-400'
                  }`}
                >
                  {shortDate(d)}
                  <button onClick={() => removeHoliday(d)} title="ลบวันนี้" className="p-0.5 rounded hover:bg-white/70">
                    <X size={12} />
                  </button>
                </span>
              );
            })
          )}
        </div>
        {holidayNote && <p className="text-xs text-amber-600">{holidayNote}</p>}
      </div>

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-start gap-2 no-print">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <div>
            <div>{error}</div>
            <div className="text-xs text-rose-500 mt-1">
              รายงานนี้สรุปจากตารางงานที่สาขาลงไว้ (ฐาน narai_hr ผ่าน office-server)
              — ถ้าหน้า &quot;ดูสแกนหน้า&quot; ก็ขึ้นตารางงานไม่ได้เหมือนกัน แปลว่าติดที่เซิร์ฟเวอร์ฝั่งออฟฟิศ
            </div>
          </div>
        </div>
      )}

      {warning && !loading && (
        <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-sm flex items-start gap-2 no-print">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <span>ตารางงาน: {warning}</span>
        </div>
      )}

      {scanNote && !loading && schedRows !== null && (
        <div className="p-3 bg-indigo-50 border border-indigo-200 text-indigo-800 rounded-xl text-sm flex items-start gap-2 no-print">
          <CalendarClock size={18} className="mt-0.5 flex-shrink-0" />
          <span>เวลาสแกน: {scanNote}</span>
        </div>
      )}

      {schedRows !== null && (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden print-area">
          {/* หัวกระดาษ — เห็นเฉพาะตอนพิมพ์ */}
          <div className="print-only px-4 py-3 border-b border-slate-300">
            <h1 className="text-base font-bold">
              สรุปเงินเดือน (Summary) — สาขา {loaded?.branch || 'ทุกสาขา'}
            </h1>
            <p className="text-xs">
              งวด {periodText} ({days} วัน) · พนักงาน {rows.length} คน
              {holidaysInRange.length > 0 && ` · วันนักขัตฤกษ์: ${holidaysInRange.map(shortDate).join(', ')}`}
              {' · '}พิมพ์เมื่อ {new Date().toLocaleString('th-TH')}
            </p>
          </div>

          {/* แถบเครื่องมือ */}
          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2 no-print">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหารหัส หรือชื่อพนักงาน…"
                className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-amber-500 outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">{rows.length} คน</span>
              <button
                onClick={exportExcel}
                disabled={rows.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                <Download size={14} /> Excel
              </button>
              <button
                onClick={() => window.print()}
                disabled={rows.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-40"
              >
                <Printer size={14} /> พิมพ์สรุปเงินเดือน
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="py-16 px-6 text-center text-sm space-y-1">
              <p className="text-amber-600 font-medium">
                {search.trim() ? 'ไม่พบพนักงานที่ค้นหา' : 'ไม่มีข้อมูลในช่วงวันที่ที่เลือก'}
              </p>
              <p className="text-slate-400 text-xs">
                รายงานสรุปจากตารางงานที่สาขาลงไว้ — ถ้าสาขายังไม่ได้ลงตารางในงวดนี้ จะยังไม่มีใครขึ้นในรายงาน
              </p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[65vh] print-scroll">
              <table className="w-full text-[11px] border-collapse min-w-max">
                <thead className="text-slate-600">
                  {/* แถวรหัสลา — ลอยอยู่เหนือหัวตารางเหมือนในชีต (ช่องแรกเป็นรหัสสาขา) */}
                  <tr>
                    <th className="h-6 px-1.5 text-left sticky top-0 bg-slate-100 border-b border-slate-200 font-semibold">
                      {loaded?.branch || ''}
                    </th>
                    {HEAD_LEFT.slice(1).map((h) => (
                      <th key={`c-${h.key}`} className="h-6 sticky top-0 bg-slate-100 border-b border-slate-200" />
                    ))}
                    {LEAVE_COLUMNS.map((c, i) => (
                      <th
                        key={`c-${c.code}`}
                        className={`h-6 px-1.5 text-center sticky top-0 border-b border-slate-200 font-semibold ${
                          c.unpaid ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700'
                        }${i === 0 ? ' border-l border-slate-300' : ''}`}
                      >
                        {c.code}
                      </th>
                    ))}
                    <th className="h-6 sticky top-0 bg-slate-100 border-b border-l border-slate-300" />
                    <th className="h-6 sticky top-0 bg-slate-100 border-b border-slate-200" />
                  </tr>
                  {/* หัวตารางจริง */}
                  <tr>
                    {HEAD_LEFT.map((h) => (
                      <th
                        key={h.key}
                        className={`px-1.5 py-1.5 sticky top-6 bg-slate-50 border-b border-slate-200 whitespace-nowrap ${
                          h.align === 'left' ? 'text-left' : 'text-center'
                        }`}
                      >
                        {h.label}
                      </th>
                    ))}
                    {LEAVE_COLUMNS.map((c, i) => (
                      <th
                        key={`h-${c.code}`}
                        className={`px-1.5 py-1.5 text-center sticky top-6 border-b border-slate-200 whitespace-nowrap ${
                          c.unpaid ? 'bg-rose-50 text-rose-700' : 'bg-indigo-50 text-indigo-700'
                        }${i === 0 ? ' border-l border-slate-300' : ''}`}
                      >
                        {c.label}
                      </th>
                    ))}
                    <th className="px-1.5 py-1.5 text-center sticky top-6 bg-amber-50 text-amber-800 border-b border-l border-slate-300 whitespace-nowrap font-semibold">
                      วันทำงาน
                    </th>
                    <th className="px-1.5 py-1.5 text-center sticky top-6 bg-slate-50 border-b border-slate-200 whitespace-nowrap">
                      รวมสาย (นาที)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {rows.map((r) => (
                    <tr
                      key={r.ssn || r.badge || r.name}
                      className="hover:bg-amber-50/40"
                      title={[
                        r.noScanDays ? `ลงตารางว่าทำงานแต่ไม่มีสแกน ${r.noScanDays} วัน` : '',
                        r.noPlanDays ? `มีสแกนแต่ไม่มีในตารางงาน ${r.noPlanDays} วัน` : '',
                        r.hourlyLeave ? `ลาเป็นชั่วโมงรวม ${r.hourlyLeave} ชม.` : '',
                      ].filter(Boolean).join(' · ')}
                    >
                      <td className="px-1.5 py-1 text-slate-500">{r.branch}</td>
                      <td className="px-1.5 py-1 font-mono">{r.badge}</td>
                      <td className="px-1.5 py-1 font-mono text-slate-500">{r.ssn}</td>
                      <td className="px-1.5 py-1 whitespace-nowrap font-medium text-slate-800">{r.name}</td>
                      <td className="px-1.5 py-1 whitespace-nowrap text-slate-500">{r.position}</td>
                      <td className="px-1.5 py-1 whitespace-nowrap text-slate-500">{r.empType}</td>

                      <td className={cell(r.workDays, 'font-semibold text-slate-800')}>{r.workDays}</td>
                      <td className={cell(r.holidayWorkDays, 'text-slate-700')}>{r.holidayWorkDays}</td>
                      <td className={cell(r.otHours, 'text-emerald-700')}>{hhmmOfHours(r.otHours)}</td>
                      <td className={cell(r.lateMinutes, 'text-rose-600')}>{hhmmOfMinutes(r.lateMinutes)}</td>
                      <td className={cell(r.holidayLateMinutes, 'text-rose-600')}>{hhmmOfMinutes(r.holidayLateMinutes)}</td>
                      <td className={cell(r.workMinutes, 'font-semibold text-slate-800')}>{hhmmOfMinutes(r.workMinutes)}</td>
                      <td className={cell(r.holidayWorkMinutes, 'text-slate-700')}>{hhmmOfMinutes(r.holidayWorkMinutes)}</td>
                      <td className={cell(r.lateMinutes, 'text-rose-600')}>{r.lateMinutes}</td>
                      <td className={cell(r.holidayLateMinutes, 'text-rose-600')}>{r.holidayLateMinutes}</td>

                      {LEAVE_COLUMNS.map((c, i) => {
                        const v = r.leaveDays[c.code] || 0;
                        return (
                          <td
                            key={`${r.ssn || r.badge}-${c.code}`}
                            className={`${cell(v, c.unpaid ? 'text-rose-700 font-semibold' : 'text-indigo-700 font-semibold')}${
                              i === 0 ? ' border-l border-slate-200' : ''
                            }`}
                          >
                            {v}
                          </td>
                        );
                      })}

                      <td
                        className={`${numCls} bg-amber-50/60 font-bold text-slate-800 border-l border-slate-200`}
                        title={`หน่วยเป็น${payableUnitLabel(r)}`}
                      >
                        {r.payable}
                      </td>
                      <td className={cell(r.lateMinutes + r.holidayLateMinutes, 'text-rose-600')}>
                        {r.lateMinutes + r.holidayLateMinutes}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="px-4 py-3 text-xs text-slate-400 border-t border-slate-100 space-y-1">
                <p>
                  <span className="font-medium text-slate-500">วันทำงาน / เวลาทำงาน</span> มาจากตารางงานที่สาขาลงไว้
                  (เวลาทำงาน = เวลาที่ลงตารางไว้หักเวลาพักและหักสายแล้ว) ·
                  <span className="font-medium text-slate-500"> สาย</span> คิดจากเวลาสแกนจริงเทียบกับตารางงาน (เข้าสาย + กลับจากเบรคสาย)
                </p>
                <p>
                  <span className="font-medium text-slate-500">นข</span> = วันที่มาทำงานในวันหยุดนักขัตฤกษ์ที่ระบุไว้ด้านบน
                  (แยกออกจากวันทำงานปกติ) ·
                  <span className="font-medium text-amber-700"> วันทำงาน</span> ช่องท้ายสุด = ยอดที่ใช้คิดค่าแรง —
                  F/T คิดเต็มงวด ({days} วัน) · P/T คิดเป็นชั่วโมงทำงานรวม · นอกนั้นคิดเป็นวันทำงาน + นข + วันลาที่ยังได้ค่าแรง
                </p>
                {(checkStats.noScan > 0 || checkStats.noPlan > 0) && (
                  <p className="text-amber-600">
                    ควรตรวจเพิ่ม:
                    {checkStats.noScan > 0 && ` มี ${checkStats.noScan} วันที่ลงตารางว่าทำงานแต่ไม่มีสแกน`}
                    {checkStats.noScan > 0 && checkStats.noPlan > 0 && ' ·'}
                    {checkStats.noPlan > 0 && ` มี ${checkStats.noPlan} วันที่มีสแกนแต่ไม่มีในตารางงาน`}
                    {' '}— ดูรายวันได้ที่หน้า &quot;ดูสแกนหน้า&quot;
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {schedRows === null && !loading && !error && (
        <div className="bg-white border border-slate-100 rounded-2xl py-16 text-center text-sm text-slate-400 shadow-sm no-print">
          เลือกสาขาและช่วงวันที่ (หรือกดปุ่มงวด: เดือนนี้ / เดือนที่แล้ว / งวด 1–15 / งวด 16–สิ้นเดือน)
          แล้วกด &quot;ดึงข้อมูล&quot; เพื่อสรุปเงินเดือน
        </div>
      )}
    </div>
  );
}
