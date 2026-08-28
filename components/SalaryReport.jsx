import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx-js-style';
import {
  Wallet, Loader2, Search, Building2, Download, AlertCircle, RefreshCw,
  Printer, Settings2, CalendarClock, Upload,
} from 'lucide-react';
import { summarizeDaily, attachSchedule } from '../lib/attendance';
import { useBranches } from '../lib/useBranches';
import {
  summarizePayroll, payOf, money, loadRates, saveRates,
  loadSettings, saveSettings, rateOf, DEFAULT_SETTINGS, MONTH_DAYS,
} from '../lib/payroll';

/*
 * NARAI OFFICE — HR → รายงานเงินเดือน (สรุปเงินเดือนรายคน สำหรับพิมพ์)
 *
 * เลือกสาขา + ช่วงวันที่ (วันที่เท่าไหร่ถึงเท่าไหร่) แล้วกดดึงข้อมูล จะได้ตารางคนละแถว
 * พร้อมยอดเงิน แล้วกด "พิมพ์" ออกกระดาษ (หรือเซฟเป็น PDF จากหน้าต่างพิมพ์ของเบราว์เซอร์)
 *
 * ข้อมูลมาจากสองที่เดียวกับหน้า "ดูสแกนหน้า":
 *   ตารางงานที่สาขาลงไว้ (/api/hr-schedule)  = ตัวหลัก — บอกว่าวันไหนทำงาน/ลา/หยุด/OT
 *   เวลาสแกนหน้า (/api/attendance)           = ตัวเสริม — ชั่วโมงที่ทำจริงและนาทีที่สาย
 * ดึงสแกนไม่ได้ก็ยังออกรายงานได้ (แค่ไม่มีชั่วโมงจริงกับนาทีสาย) แต่ถ้าดึงตารางงานไม่ได้
 * จะไม่มีวันทำงานให้คิดเงินเลย จึงถือเป็น error
 *
 * ค่าแรงยังไม่มีที่เก็บกลางในระบบ — กรอกในตารางแล้วเก็บไว้ในเครื่องที่กรอก (localStorage)
 * ย้ายเครื่องให้ใช้ปุ่มส่งออก/นำเข้าไฟล์ค่าแรง (ดู lib/payroll.js)
 */

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const Dash = () => <span className="text-slate-300">—</span>;

/** ตัวเลขจำนวนวัน/นาที — 0 จางไว้ให้ตาไปเกาะเฉพาะช่องที่มีค่า */
const numCell = (v, cls = '') =>
  v ? <span className={`font-mono ${cls}`}>{v}</span> : <span className="font-mono text-slate-300">0</span>;

/** วันที่แบบไทยไว้โชว์บนหัวกระดาษ */
const thaiDate = (ymd) => {
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d) ? ymd : d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
};

/**
 * ช่วงวันที่สำเร็จรูปของงวดเงินเดือน — ตัดท้ายไม่ให้เกิน "วันนี้" เสมอ
 * (วันข้างหน้ามีแต่ตารางที่ลงไว้ล่วงหน้า ยังไม่ได้ทำงานจริง เอามาคิดเงินไม่ได้)
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

export default function SalaryReport() {
  const { codes: branchCodes } = useBranches();
  const today = fmtDate(new Date());
  const thisMonth = presetRange('thisMonth');
  const fileRef = useRef(null);

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
  const [loadedInfo, setLoadedInfo] = useState('');
  const [search, setSearch] = useState('');

  const [rates, setRates] = useState({});                // { [รหัสพนักงาน]: { amount, mode } }
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [fillRate, setFillRate] = useState('');          // ค่าแรงที่จะเติมให้คนที่ยังไม่ได้กรอก
  const [storeNote, setStoreNote] = useState('');

  // localStorage อ่านได้เฉพาะฝั่งเบราว์เซอร์ — อ่านหลัง mount เพื่อให้ HTML รอบแรกตรงกับฝั่งเซิร์ฟเวอร์
  useEffect(() => {
    setRates(loadRates());
    setSettings(loadSettings());
  }, []);

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

      const range = s === e ? thaiDate(s) : `${thaiDate(s)} — ${thaiDate(e)}`;
      setLoadedInfo(`${range} · ${b || 'ทุกสาขา'}`);

      await loadPunches({ start: s, end: e, branch: b });
    } catch (err) {
      setSchedRows(null);
      setPunches([]);
      setLoadedInfo('');
      setError(err.message || 'ดึงข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };

  /** เวลาสแกนจริงเป็นข้อมูลเสริม — ดึงไม่ได้ก็ยังคิดเงินจากตารางงานได้ตามปกติ */
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
      setScanNote(`${err.message || 'ดึงเวลาสแกนไม่สำเร็จ'} — คิดเงินจากตารางงานอย่างเดียว (ช่องชั่วโมงจริงและนาทีสายจะว่าง)`);
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

  // ตารางงาน + สแกน -> แถวรายวัน -> ยอดรายคน
  // includeUnscanned ต้องเปิดเสมอ เพราะวันหยุด/วันลาไม่มีใครไปสแกน ถ้าไม่เอาเข้ามาด้วย
  // วันลารับค่าแรงจะหายไปจากยอด
  const daily = useMemo(
    () => attachSchedule(summarizeDaily(punches), schedRows || [], { includeUnscanned: true }),
    [punches, schedRows]
  );
  const people = useMemo(() => summarizePayroll(daily), [daily]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people
      .filter((p) => !q || p.empCode.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .map((p) => {
        const rate = rateOf(rates, p.empCode);
        return { ...p, rate, pay: payOf(p, rate, settings) };
      });
  }, [people, rates, settings, search]);

  const totals = useMemo(() => rows.reduce((t, r) => ({
    workDays: t.workDays + r.workDays,
    paidDays: t.paidDays + r.pay.paidDays,
    paidLeaveDays: t.paidLeaveDays + r.paidLeaveDays,
    offDays: t.offDays + r.offDays,
    unpaidDays: t.unpaidDays + r.unpaidDays,
    absentDays: t.absentDays + r.absentDays,
    netHours: t.netHours + r.netHours,
    otHours: t.otHours + r.otHours,
    lateMinutes: t.lateMinutes + r.lateMinutes,
    base: t.base + r.pay.base,
    otPay: t.otPay + r.pay.otPay,
    cut: t.cut + r.pay.unpaidCut + r.pay.lateCut,
    net: t.net + r.pay.net,
  }), {
    workDays: 0, paidDays: 0, paidLeaveDays: 0, offDays: 0, unpaidDays: 0, absentDays: 0,
    netHours: 0, otHours: 0, lateMinutes: 0, base: 0, otPay: 0, cut: 0, net: 0,
  }), [rows]);

  const missingRate = useMemo(() => rows.filter((r) => !Number(r.rate.amount)).length, [rows]);

  // ----- ค่าแรงที่กรอกไว้ -----

  const persist = (next) => {
    setRates(next);
    setStoreNote(saveRates(next) ? '' : 'เบราว์เซอร์นี้บันทึกค่าแรงไว้ไม่ได้ (โหมดส่วนตัว?) — ปิดหน้าแล้วค่าที่กรอกจะหาย');
  };

  const setRate = (empCode, patch) => {
    if (!empCode) return;   // แถวที่ไม่มีรหัสพนักงานยังจำค่าแรงไม่ได้ (ไม่มีคีย์ให้เก็บ)
    persist({ ...rates, [empCode]: { ...rateOf(rates, empCode), ...patch } });
  };

  const changeSettings = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };

  /** เติมค่าแรงให้ทุกคนในตารางที่ยังไม่ได้กรอก (คนที่กรอกไว้แล้วไม่ถูกทับ) */
  const fillMissingRates = () => {
    const amount = Number(fillRate);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const next = { ...rates };
    for (const r of rows) {
      if (r.empCode && !Number(rateOf(next, r.empCode).amount)) next[r.empCode] = { amount, mode: 'daily' };
    }
    persist(next);
  };

  const exportRates = () => {
    const blob = new Blob([JSON.stringify(rates, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-rates_${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importRates = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';   // เลือกไฟล์เดิมซ้ำได้
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
      const next = { ...rates };
      let n = 0;
      for (const [code, v] of Object.entries(parsed)) {
        const amount = Number(v?.amount);
        if (!code || !Number.isFinite(amount)) continue;
        next[code] = { amount, mode: v?.mode === 'monthly' ? 'monthly' : 'daily' };
        n += 1;
      }
      if (n === 0) throw new Error('ไม่พบค่าแรงในไฟล์');
      persist(next);
      setStoreNote(`นำเข้าค่าแรง ${n} คนแล้ว`);
    } catch (err) {
      setStoreNote(`นำเข้าไฟล์ค่าแรงไม่สำเร็จ: ${err.message}`);
    }
  };

  // ----- ส่งออก -----

  const exportExcel = () => {
    const tag = `${branch || 'ALL'}_${startDate}_${endDate}`;
    const aoa = [
      [
        'รหัส', 'ชื่อ - สกุล', 'สาขา', 'ตำแหน่ง',
        'วันทำงาน', 'ลารับค่าแรง', 'วันหยุด', 'ไม่รับค่าแรง', 'ขาดงาน', 'วันที่จ่าย',
        'ชม.ทำงาน', 'OT (ชม.)', 'สาย (นาที)',
        'ค่าแรง', 'ต่อ', 'เป็นเงิน', 'ค่า OT', 'หัก', 'สุทธิ', 'หมายเหตุ',
      ],
      ...rows.map((r) => [
        r.empCode, r.name, r.branches.join(', '), r.position,
        r.workDays, r.paidLeaveDays, r.offDays, r.unpaidDays, r.absentDays, r.pay.paidDays,
        r.netHours, r.otHours, r.lateMinutes,
        Number(r.rate.amount) || 0, r.rate.mode === 'monthly' ? 'เดือน' : 'วัน',
        r.pay.base, r.pay.otPay, r.pay.unpaidCut + r.pay.lateCut, r.pay.net,
        r.leaveSummary,
      ]),
      [
        `รวม ${rows.length} คน`, '', '', '',
        totals.workDays, totals.paidLeaveDays, totals.offDays, totals.unpaidDays, totals.absentDays, totals.paidDays,
        totals.netHours, totals.otHours, totals.lateMinutes,
        '', '', totals.base, totals.otPay, totals.cut, totals.net, '',
      ],
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map(() => ({ wch: 13 }));
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const head = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (head) {
        head.s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: 'F59E0B' } },
          alignment: { horizontal: 'center' },
        };
      }
      const foot = ws[XLSX.utils.encode_cell({ r: range.e.r, c })];
      if (foot) foot.s = { font: { bold: true }, fill: { fgColor: { rgb: 'FEF3C7' } } };
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'สรุปเงินเดือน');
    XLSX.writeFile(wb, `salary_${tag}.xlsx`);
  };

  const periodText = startDate === endDate
    ? thaiDate(startDate)
    : `${thaiDate(startDate)} ถึง ${thaiDate(endDate)}`;

  return (
    <div className="space-y-6">
      {/* หัวข้อ */}
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-100 text-amber-600 rounded-xl"><Wallet size={22} /></div>
          <div>
            <h2 className="text-xl font-bold text-slate-800">รายงานเงินเดือน</h2>
            <p className="text-xs text-slate-500">
              สรุปวันทำงาน วันลา OT และยอดเงินรายคน • เลือกสาขาและช่วงวันที่ แล้วสั่งพิมพ์ได้เลย
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
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 mt-3 rounded-xl text-xs font-semibold border transition-colors ${
              showSettings ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Settings2 size={14} /> วิธีคิดเงิน
          </button>
          {!loading && loadedInfo && <span className="text-xs text-slate-400 mt-3">ข้อมูล: {loadedInfo}</span>}
        </div>

        {/* วิธีคิดเงิน + ค่าแรงที่กรอกไว้ */}
        {showSettings && (
          <div className="pt-3 border-t border-slate-100 space-y-3">
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-xs text-slate-500">
                ชั่วโมงทำงานต่อวัน
                <input
                  type="number" min="1" max="24" step="0.5" value={settings.hoursPerDay}
                  onChange={(e) => changeSettings({ hoursPerDay: Number(e.target.value) })}
                  className="block w-24 mt-1 px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500"
                />
              </label>
              <label className="text-xs text-slate-500">
                ตัวคูณค่า OT
                <input
                  type="number" min="0" step="0.5" value={settings.otMultiplier}
                  onChange={(e) => changeSettings({ otMultiplier: Number(e.target.value) })}
                  className="block w-24 mt-1 px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500"
                />
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-600 pb-2">
                <input
                  type="checkbox" checked={settings.deductLate}
                  onChange={(e) => changeSettings({ deductLate: e.target.checked })}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-500 w-4 h-4"
                />
                หักเงินตามนาทีที่สาย
              </label>
              <label className="text-xs text-slate-500">
                เติมค่าแรง/วัน ให้คนที่ยังไม่ได้กรอก
                <span className="flex items-center gap-2 mt-1">
                  <input
                    type="number" min="0" step="10" value={fillRate}
                    onChange={(e) => setFillRate(e.target.value)}
                    placeholder="เช่น 400"
                    className="w-28 px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  <button
                    onClick={fillMissingRates}
                    disabled={!Number(fillRate) || rows.length === 0}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-40"
                  >
                    เติมให้
                  </button>
                </span>
              </label>
              <div className="flex items-center gap-2 pb-1">
                <button
                  onClick={exportRates}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50"
                >
                  <Download size={14} /> ส่งออกค่าแรง
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50"
                >
                  <Upload size={14} /> นำเข้าค่าแรง
                </button>
                <input ref={fileRef} type="file" accept=".json,application/json" onChange={importRates} className="hidden" />
              </div>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              <span className="font-medium text-slate-500">รายวัน:</span> เป็นเงิน = (วันทำงาน + วันลารับค่าแรง) × ค่าแรง/วัน ·{' '}
              <span className="font-medium text-slate-500">รายเดือน:</span> เป็นเงิน = เงินเดือนเต็มงวด แล้วหักวันที่หยุดไม่รับค่าแรง วันละ เงินเดือน/{MONTH_DAYS} ·{' '}
              ค่า OT = ชั่วโมง OT × (ค่าแรงต่อวัน ÷ ชั่วโมงทำงานต่อวัน) × ตัวคูณ ·
              วันหยุดประจำ (รหัส 10 หยุด) ไม่นับเป็นวันรับค่าแรง ·
              ลาเป็นชั่วโมงและชั่วโมงสะสมไม่ถูกคิดให้อัตโนมัติ
            </p>
            <p className="text-[11px] text-slate-400">
              ค่าแรงที่กรอกถูกเก็บไว้ในเบราว์เซอร์เครื่องนี้เท่านั้น (ระบบยังไม่มีที่เก็บค่าแรงส่วนกลาง)
              — เปลี่ยนเครื่องหรือล้างข้อมูลเบราว์เซอร์แล้วต้องกรอกใหม่ ใช้ปุ่มส่งออก/นำเข้าเพื่อย้ายไปเครื่องอื่น
            </p>
          </div>
        )}
        {storeNote && <p className="text-xs text-amber-600">{storeNote}</p>}
      </div>

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-start gap-2 no-print">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <div>
            <div>{error}</div>
            <div className="text-xs text-rose-500 mt-1">
              รายงานนี้คิดวันทำงานจากตารางงานที่สาขาลงไว้ (ฐาน narai_hr ผ่าน office-server)
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
            <h1 className="text-lg font-bold">สรุปเงินเดือน — นารายณ์พิซเซอเรีย</h1>
            <p className="text-xs">
              สาขา: {branch || 'ทุกสาขา'} · ช่วงวันที่ {periodText} · พนักงาน {rows.length} คน
              · พิมพ์เมื่อ {new Date().toLocaleString('th-TH')}
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
              <span className="text-xs text-slate-400">
                {rows.length} คน{missingRate > 0 ? ` • ยังไม่ได้กรอกค่าแรง ${missingRate} คน` : ''}
              </span>
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
                รายงานคิดจากตารางงานที่สาขาลงไว้ — ถ้าสาขายังไม่ได้ลงตารางในงวดนี้ จะยังไม่มีใครขึ้นในรายงาน
              </p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[65vh] print-scroll">
              <table className="w-full text-sm border-collapse min-w-max">
                <thead className="text-[11px] text-slate-600">
                  <tr>
                    {['รหัส', 'ชื่อ - สกุล', 'สาขา', 'ตำแหน่ง'].map((h) => (
                      <th key={h} rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-slate-50 border-b border-slate-200">{h}</th>
                    ))}
                    <th colSpan={6} className="h-8 px-3 text-center sticky top-0 bg-indigo-100 text-indigo-800 border-b border-l border-slate-200 font-semibold">จำนวนวัน</th>
                    <th colSpan={3} className="h-8 px-3 text-center sticky top-0 bg-emerald-100 text-emerald-800 border-b border-l border-slate-200 font-semibold">เวลาทำงานจริง</th>
                    <th colSpan={2} className="h-8 px-3 text-center sticky top-0 bg-amber-100 text-amber-800 border-b border-l border-slate-200 font-semibold">ค่าแรง</th>
                    <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-slate-100 border-b border-l border-slate-200 font-semibold">เป็นเงิน (บาท)</th>
                    <th rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-slate-50 border-b border-l border-slate-200">หมายเหตุ</th>
                  </tr>
                  <tr>
                    {['ทำงาน', 'ลารับค่าแรง', 'หยุด', 'ไม่รับค่าแรง', 'ขาดงาน', 'วันที่จ่าย'].map((h, i) => (
                      <th key={`d${h}`} className={`px-3 py-1.5 text-center sticky top-8 bg-indigo-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                    ))}
                    {['ชม.ทำงาน', 'OT (ชม.)', 'สาย (นาที)'].map((h, i) => (
                      <th key={`t${h}`} className={`px-3 py-1.5 text-center sticky top-8 bg-emerald-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                    ))}
                    {['จำนวน', 'ต่อ'].map((h, i) => (
                      <th key={`r${h}`} className={`px-3 py-1.5 text-center sticky top-8 bg-amber-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                    ))}
                    {['ค่าแรง', 'OT', 'หัก', 'สุทธิ'].map((h, i) => (
                      <th key={`m${h}`} className={`px-3 py-1.5 text-right sticky top-8 bg-slate-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {rows.map((r) => (
                    <tr key={r.empCode || r.name} className="hover:bg-amber-50/40">
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.empCode || <Dash />}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-800">{r.name || <Dash />}</td>
                      <td className="px-3 py-2 text-xs text-slate-400">{r.branches.join(', ') || <Dash />}</td>
                      <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{r.position || <Dash />}</td>

                      {/* จำนวนวันในงวด — มาจากตารางงานที่สาขาลงไว้ */}
                      <td className="px-3 py-2 text-center bg-indigo-50/40 border-l border-slate-200">{numCell(r.workDays, 'font-semibold text-indigo-700')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{numCell(r.paidLeaveDays, 'text-amber-600')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{numCell(r.offDays, 'text-slate-500')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{numCell(r.unpaidDays, 'text-rose-600')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{numCell(r.absentDays, 'font-semibold text-rose-700')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/60">{numCell(r.pay.paidDays, 'font-semibold text-slate-700')}</td>

                      {/* เวลาที่สแกนจริง — ว่างได้ถ้าดึงเวลาสแกนไม่ได้ */}
                      <td className="px-3 py-2 text-right font-mono text-slate-500 border-l border-slate-200">{r.netHours ? r.netHours.toFixed(2) : <Dash />}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">{r.otHours ? r.otHours.toFixed(2) : <Dash />}</td>
                      <td className="px-3 py-2 text-right">{numCell(r.lateMinutes, 'text-rose-600')}</td>

                      {/* ค่าแรง — กรอกในตารางได้เลย เก็บไว้ในเครื่องนี้ */}
                      <td className="px-2 py-1.5 text-right border-l border-slate-200">
                        <input
                          type="number" min="0" step="10"
                          value={r.rate.amount || ''}
                          disabled={!r.empCode}
                          onChange={(e) => setRate(r.empCode, { amount: Number(e.target.value) })}
                          placeholder="0"
                          title={r.empCode ? '' : 'แถวนี้ไม่มีรหัสพนักงาน จึงจำค่าแรงไว้ไม่ได้'}
                          className="w-24 px-2 py-1 border border-slate-200 rounded-lg text-sm text-right font-mono outline-none focus:ring-2 focus:ring-amber-500 disabled:bg-slate-50"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <select
                          value={r.rate.mode}
                          disabled={!r.empCode}
                          onChange={(e) => setRate(r.empCode, { mode: e.target.value })}
                          className="px-1.5 py-1 border border-slate-200 rounded-lg text-xs bg-white outline-none focus:ring-2 focus:ring-amber-500 disabled:bg-slate-50"
                        >
                          <option value="daily">วัน</option>
                          <option value="monthly">เดือน</option>
                        </select>
                      </td>

                      {/* เป็นเงิน */}
                      <td className="px-3 py-2 text-right font-mono border-l border-slate-200">{money(r.pay.base)}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">{r.pay.otPay ? money(r.pay.otPay) : <Dash />}</td>
                      <td className="px-3 py-2 text-right font-mono text-rose-600">
                        {r.pay.unpaidCut + r.pay.lateCut ? money(r.pay.unpaidCut + r.pay.lateCut) : <Dash />}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">{money(r.pay.net)}</td>

                      <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap border-l border-slate-200">{r.leaveSummary || <Dash />}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-amber-50 text-slate-800 font-semibold border-t-2 border-amber-200">
                    <td className="px-3 py-2.5" colSpan={4}>รวม {rows.length} คน</td>
                    <td className="px-3 py-2.5 text-center border-l border-slate-200">{totals.workDays}</td>
                    <td className="px-3 py-2.5 text-center">{totals.paidLeaveDays}</td>
                    <td className="px-3 py-2.5 text-center">{totals.offDays}</td>
                    <td className="px-3 py-2.5 text-center">{totals.unpaidDays}</td>
                    <td className="px-3 py-2.5 text-center">{totals.absentDays}</td>
                    <td className="px-3 py-2.5 text-center">{totals.paidDays}</td>
                    <td className="px-3 py-2.5 text-right font-mono border-l border-slate-200">{totals.netHours.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{totals.otHours.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{totals.lateMinutes}</td>
                    <td className="px-3 py-2.5 border-l border-slate-200" colSpan={2} />
                    <td className="px-3 py-2.5 text-right font-mono border-l border-slate-200">{money(totals.base)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(totals.otPay)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-rose-700">{money(totals.cut)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-base">{money(totals.net)}</td>
                    <td className="px-3 py-2.5 border-l border-slate-200" />
                  </tr>
                </tfoot>
              </table>

              <div className="px-4 py-3 text-xs text-slate-400 border-t border-slate-100 space-y-1">
                <p>
                  <span className="font-medium text-indigo-600">จำนวนวัน</span> นับจากตารางงานที่สาขาลงไว้ ·
                  <span className="font-medium text-emerald-600"> เวลาทำงานจริง</span> มาจากเวลาสแกนหน้า (หักเวลาพักแล้ว) ·
                  วันที่ลงตารางว่าทำงานแต่ไม่มีสแกน ยังถูกนับเป็นวันทำงาน — ตรวจรายวันได้ที่หน้า &quot;ดูสแกนหน้า&quot;
                </p>
                <p>
                  <span className="font-medium">วันที่จ่าย</span> = วันทำงาน + วันลารับค่าแรง ·
                  <span className="font-medium"> หัก</span> = วันหยุดไม่รับค่าแรงของพนักงานรายเดือน
                  {settings.deductLate ? ' + เงินตามนาทีที่สาย' : ' (ยังไม่ได้เปิดหักนาทีที่สาย)'} ·
                  ยอดสุทธิ = ค่าแรง + OT − หัก
                </p>
              </div>
            </div>
          )}

          {/* ลายเซ็นผู้จัดทำ/ผู้อนุมัติ — เห็นเฉพาะตอนพิมพ์ */}
          <div className="print-only px-6 pt-10 pb-4 text-xs">
            <div className="flex justify-between gap-8">
              {['ผู้จัดทำ', 'ผู้ตรวจสอบ', 'ผู้อนุมัติ'].map((role) => (
                <div key={role} className="flex-1 text-center">
                  <div className="border-b border-slate-400 h-8" />
                  <p className="mt-1">({role})</p>
                  <p className="mt-1">วันที่ ......../......../........</p>
                </div>
              ))}
            </div>
          </div>
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
