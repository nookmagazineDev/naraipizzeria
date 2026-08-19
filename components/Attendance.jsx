import React, { useState, useMemo } from 'react';
import * as XLSX from 'xlsx-js-style';
import {
  Fingerprint, Loader2, Search, CalendarDays, ListOrdered,
  Building2, Download, AlertCircle, RefreshCw, CalendarClock
} from 'lucide-react';
import { hhmm, summarizeDaily, attachSchedule } from '../lib/attendance';

/*
 * NARAI OFFICE — ดูสแกนหน้า (เข้า-ออกงาน)
 * ข้อมูลจากเครื่องสแกนหน้า ZKBio Time 9 ผ่าน /api/attendance → host API (/zk/transactions)
 * ทำงานแบบเดียวกับหน้า "สแกนเข้า-ออก" ของโปรเจค Narai-branch
 *
 * "เข้า/ออก" คิดจากลำดับเวลาสแกนของวัน (เข้างาน → ออกเบรค → เข้าเบรค → ออกงาน)
 * ไม่ได้อิง punch_state เพราะการตั้งค่าปุ่มของเครื่องสแกนแต่ละตัวไม่เหมือนกัน
 * (แสดง punch_state ไว้ในตาราง "ทุกครั้งที่สแกน" แทน)
 *
 * ตารางสรุปรายวันวางคู่กันสองฝั่ง: เวลาที่สาขา "ลงตารางไว้" (dbo.hr_timesheet ผ่าน
 * /api/hr-schedule) กับเวลาที่ "สแกนจริง" แล้วสรุปส่วนต่างให้ว่าเข้าสาย/เบรคสาย/ออกก่อนกี่นาที
 * ตารางงานเป็นข้อมูลเสริม — ดึงไม่ได้ก็ยังเห็นเวลาสแกนตามปกติ
 */

// รหัสสาขาเดียวกับที่ใช้ทั้งระบบ — ZKBio เก็บรหัสนี้ไว้ที่ area_alias ของเครื่องสแกน
const BRANCHES = [
  'SJP', 'CRM', 'XCM', 'SLR', 'SUM', 'XUM', 'SCS', 'SMP', 'XSB', 'XHH',
  'HRS', 'CLK', 'P90', 'HPS', 'ZBW', 'ZPT', 'NPT', 'WRM', 'WMT', 'IPR', 'ZK3',
];

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num2 = (v) => (v != null ? v.toFixed(2) : '-');

const Dash = () => <span className="text-slate-300">—</span>;
/** ช่องเวลา 'HH:mm' — ว่าง = ไม่มีข้อมูลฝั่งนั้น */
const timeCell = (t, cls = '') => (t ? <span className={`font-mono ${cls}`}>{t}</span> : <Dash />);
/** จำนวนนาทีที่สาย — 0 = ตรงเวลา (เขียว), เกินนั้นเน้นแดง, null = เทียบไม่ได้ */
const lateCell = (v) => {
  if (v == null) return <Dash />;
  if (v <= 0) return <span className="font-mono text-emerald-600">0</span>;
  return <span className="font-mono font-semibold text-rose-600">{v}</span>;
};

// ช่วงวันที่สำเร็จรูป — คิดจาก "วันนี้" ตามเวลาเครื่องผู้ใช้
// สัปดาห์นี้ = จันทร์ถึงวันนี้ · เดือนนี้ = วันที่ 1 ถึงวันนี้ · เดือนที่แล้ว = ทั้งเดือน
function presetRange(key, now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (key) {
    case 'today':
      return { start: fmtDate(t), end: fmtDate(t) };
    case 'thisWeek': {
      const dow = (t.getDay() + 6) % 7; // 0 = จันทร์
      const mon = new Date(t); mon.setDate(t.getDate() - dow);
      return { start: fmtDate(mon), end: fmtDate(t) };
    }
    case 'thisMonth':
      return { start: fmtDate(new Date(t.getFullYear(), t.getMonth(), 1)), end: fmtDate(t) };
    case 'lastMonth': {
      const first = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const last = new Date(t.getFullYear(), t.getMonth(), 0); // วันสุดท้ายของเดือนที่แล้ว
      return { start: fmtDate(first), end: fmtDate(last) };
    }
    default:
      return { start: fmtDate(t), end: fmtDate(t) };
  }
}

const PRESETS = [
  { key: 'today', label: 'วันนี้' },
  { key: 'thisWeek', label: 'สัปดาห์นี้' },
  { key: 'thisMonth', label: 'เดือนนี้' },
  { key: 'lastMonth', label: 'เดือนที่แล้ว' },
];

export default function Attendance() {
  const today = fmtDate(new Date());

  const [branch, setBranch] = useState('');          // '' = ทุกสาขา
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [preset, setPreset] = useState('today');     // '' = กำหนดวันที่เอง
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');   // แยกสาเหตุ เพื่อขึ้นวิธีแก้ให้ตรงจุด
  const [warning, setWarning] = useState('');        // เตือนตอนข้อมูลถูกตัดเพราะช่วงกว้างเกิน
  const [rows, setRows] = useState(null);            // null = ยังไม่เคยดึง
  const [schedRows, setSchedRows] = useState([]);    // ตารางงานที่สาขาลงไว้ ในช่วงวันเดียวกัน
  const [schedNote, setSchedNote] = useState('');    // ดึงตารางงานไม่ได้/ได้ไม่ครบทุกสาขา
  const [loadedInfo, setLoadedInfo] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('daily');         // 'daily' = สรุปรายวัน | 'raw' = ทุกครั้งที่สแกน
  const [showPlan, setShowPlan] = useState(true);    // เทียบกับตารางงานที่ลงไว้ (ปิดได้เพื่อดูตารางแบบสั้น)

  // รับวันที่/สาขามาเป็นพารามิเตอร์ได้ เพื่อให้ปุ่มช่วงสำเร็จรูปกดแล้วดึงได้เลย
  // (ไม่ต้องรอ state รอบถัดไป)
  const load = async (opts = {}) => {
    const s = opts.start || startDate;
    const e = opts.end || endDate;
    const b = opts.branch !== undefined ? opts.branch : branch;
    if (!s || !e) { setError('กรุณาเลือกช่วงวันที่'); return; }
    if (s > e) { setError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด'); return; }
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const params = new URLSearchParams({ start: s, end: e });
      if (b) params.set('branch', b);
      const res = await fetch(`/api/attendance?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status !== 'success') {
        const e = new Error((json && json.message) || `ดึงข้อมูลไม่สำเร็จ (${res.status})`);
        e.code = json && json.code;
        throw e;
      }
      const punches = json.data || [];
      setRows(punches);
      setWarning(json.truncated ? (json.message || 'ข้อมูลถูกตัดเพราะช่วงวันที่กว้างเกินไป') : '');
      const range = s === e ? s : `${s} ถึง ${e}`;
      setLoadedInfo(`${range} · ${b || 'ทุกสาขา'} · ${json.count || 0} ครั้ง`);

      // ตารางงานเป็นข้อมูลเสริม ดึงทีหลังเพื่อจะได้รู้ว่าต้องขอสาขาไหนบ้าง
      // (ขอเฉพาะสาขาที่มีคนสแกนจริง จะได้ไม่ยิงครบ 21 สาขาทิ้งเปล่าๆ)
      await loadSchedule({ start: s, end: e, branch: b, punches });
    } catch (err) {
      setRows(null);
      setSchedRows([]);
      setSchedNote('');
      setWarning('');
      setError(err.message || 'ดึงข้อมูลไม่สำเร็จ');
      setErrorCode(err.code || '');
    } finally {
      setLoading(false);
    }
  };

  /**
   * ตารางงานที่สาขาลงไว้ในช่วงเดียวกัน — ดึงไม่ได้ก็ไม่ทำให้ทั้งหน้าล้ม
   * แค่ขึ้นหมายเหตุแล้วแสดงเฉพาะเวลาสแกนเหมือนเดิม
   */
  const loadSchedule = async ({ start: s, end: e, branch: b, punches }) => {
    // สาขาที่มีคนสแกนจริงในรอบนี้ (area_alias จากเครื่องสแกน)
    const inData = [...new Set(punches.map((r) => (r.area || '').trim()).filter(Boolean))];
    const want = b ? [b] : inData;
    if (want.length === 0) { setSchedRows([]); setSchedNote(''); return; }

    try {
      const p = new URLSearchParams({ start: s, end: e, branches: want.join(',') });
      const res = await fetch(`/api/hr-schedule?${p.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status !== 'success') {
        throw new Error((json && json.message) || `ดึงตารางงานไม่สำเร็จ (${res.status})`);
      }
      setSchedRows(json.data || []);

      // สาขาที่ฐาน HR ไม่รู้จัก / ดึงไม่สำเร็จบางสาขา — บอกให้รู้ว่าคอลัมน์ตารางงานจะว่าง
      const notes = [];
      if (json.unknown?.length) notes.push(`ไม่มีสาขา ${json.unknown.join(', ')} ในฐานข้อมูลตารางงาน`);
      if (json.failed?.length) notes.push(`ดึงตารางงานไม่ได้: ${json.failed.map((f) => f.branch).join(', ')}`);
      if (json.count === 0 && notes.length === 0) notes.push('ช่วงวันที่นี้ยังไม่มีใครลงตารางงานไว้');
      setSchedNote(notes.join(' · '));
    } catch (err) {
      setSchedRows([]);
      setSchedNote(`${err.message || 'ดึงตารางงานไม่สำเร็จ'} — แสดงเฉพาะเวลาสแกน`);
    }
  };

  // กดปุ่มช่วงสำเร็จรูป = ตั้งวันที่ให้ แล้วดึงข้อมูลทันที
  const applyPreset = (key) => {
    const { start, end } = presetRange(key);
    setPreset(key);
    setStartDate(start);
    setEndDate(end);
    load({ start, end });
  };

  // แก้วันที่เองเมื่อไหร่ = หลุดจากช่วงสำเร็จรูป (ปุ่มเลิกไฮไลต์)
  const setStart = (v) => { setStartDate(v); setPreset(''); };
  const setEnd = (v) => { setEndDate(v); setPreset(''); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows || [];
    if (!q) return list;
    return list.filter((r) =>
      String(r.empCode).toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  // สรุปรายวัน: พนักงาน 1 คน x 1 วัน = 1 แถว (เข้า = สแกนแรก, ออก = สแกนสุดท้าย)
  // แล้วเทียบกับตารางงานที่สาขาลงไว้ เพื่อคิดว่าสาย/ออกก่อนเวลากี่นาที
  const daily = useMemo(() => attachSchedule(summarizeDaily(filtered), schedRows), [filtered, schedRows]);
  const people = useMemo(() => new Set(daily.map((d) => d.empCode)).size, [daily]);

  // มีตารางงานให้เทียบกี่แถว — ใช้บอกผู้ใช้ว่าคอลัมน์ฝั่งซ้ายมาจากไหน
  const matched = useMemo(() => daily.filter((d) => d.plan).length, [daily]);

  const exportExcel = () => {
    const tag = `${branch || 'ALL'}_${startDate}${startDate === endDate ? '' : `_${endDate}`}`;
    // เปิดเทียบตารางงานไว้ = ใส่ฝั่ง "ที่ลงไว้" กับนาทีที่สายลงไฟล์ด้วย
    const planHead = showPlan
      ? ['ลงไว้ เข้า', 'ลงไว้ ออกเบรค', 'ลงไว้ เข้าเบรค', 'ลงไว้ ออก']
      : [];
    const lateHead = showPlan ? ['เข้าสาย (นาที)', 'เบรคสาย (นาที)', 'ออกก่อน (นาที)'] : [];
    const planCells = (d) => (showPlan ? [d.plan?.in || '', d.plan?.breakOut || '', d.plan?.breakIn || '', d.plan?.out || ''] : []);
    const lateCells = (d) => (showPlan ? [d.lateIn ?? '', d.lateBreakIn ?? '', d.earlyOut ?? ''] : []);

    const aoa = view === 'daily'
      ? [
          ['วันที่', 'รหัส', 'ชื่อ', 'สาขา', ...planHead, 'เข้า', 'ออกเบรค', 'เข้าเบรค', 'ออก', ...lateHead, 'รวม (ชม.)', 'พัก (ชม.)', 'สุทธิ (ชม.)', 'จำนวนสแกน'],
          ...daily.map((d) => [
            d.date, d.empCode, d.name, d.branch,
            ...planCells(d),
            hhmm(d.first), d.breakOut ? hhmm(d.breakOut) : '', d.breakIn ? hhmm(d.breakIn) : '', d.last ? hhmm(d.last) : '',
            ...lateCells(d),
            d.hours != null ? +d.hours.toFixed(2) : '',
            d.breakHours != null ? +d.breakHours.toFixed(2) : '',
            d.netHours != null ? +d.netHours.toFixed(2) : '',
            d.count,
          ]),
        ]
      : [
          ['เวลา', 'รหัส', 'ชื่อ', 'ประเภท', 'สาขา', 'เครื่อง'],
          ...filtered.map((r) => [r.time, r.empCode, r.name, r.stateLabel || r.state, r.area, r.terminal]),
        ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map(() => ({ wch: 14 }));
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) {
        cell.s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: 'F59E0B' } },
          alignment: { horizontal: 'center' },
        };
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, view === 'daily' ? 'สรุปรายวัน' : 'ทุกครั้งที่สแกน');
    XLSX.writeFile(wb, `attendance_${tag}.xlsx`);
  };

  return (
    <div className="space-y-6">
      {/* หัวข้อ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-100 text-amber-600 rounded-xl"><Fingerprint size={22} /></div>
          <div>
            <h2 className="text-xl font-bold text-slate-800">ดูสแกนหน้า</h2>
            <p className="text-xs text-slate-500">
              เวลาสแกนหน้าจากเครื่องสแกนของสาขา (ZKBio Time) • เข้า = สแกนแรกของวัน, ออก = สแกนสุดท้าย
              • เทียบกับตารางงานที่สาขาลงไว้ให้ด้วย
            </p>
          </div>
        </div>
      </div>

      {/* ตัวกรอง */}
      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm space-y-3">
        {/* ช่วงวันที่สำเร็จรูป — กดแล้วดึงข้อมูลให้เลย */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">ช่วงเวลา</span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              disabled={loading}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${
                preset === p.key
                  ? 'bg-amber-500 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
          <span className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${preset === '' ? 'bg-slate-800 text-white' : 'text-slate-400'}`}>
            กำหนดเอง
          </span>
        </div>

        {/* สาขา + วันที่ + ปุ่มดึงข้อมูล */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
          <div className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-xl mt-3">
            <Building2 size={16} className="text-slate-400" />
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="text-sm text-slate-700 bg-transparent focus:outline-none cursor-pointer"
            >
              <option value="">ทุกสาขา</option>
              {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
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
          {rows !== null && (
            <button
              onClick={() => load()} disabled={loading}
              title="โหลดใหม่"
              className="p-2 mt-3 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={16} />
            </button>
          )}
          {!loading && loadedInfo && <span className="text-xs text-slate-400 mt-3">ข้อมูล: {loadedInfo}</span>}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-start gap-2">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <div>
            <div>{error}</div>
            {/* คำใบ้ให้ตรงกับสาเหตุ: host-server เก่า / ติดต่อไม่ได้ / ต่อ SQL ตรงไม่ได้ แก้คนละจุดกัน */}
            <div className="text-xs text-rose-500 mt-1">
              {errorCode === 'ZK_OFFICE_UNREACHABLE'
                ? 'ติดต่อ office-server ที่ออฟฟิศไม่ได้ (storenarai.dyndns.tv:8787) — ตรวจว่าเครื่องเปิดอยู่และเซิร์ฟเวอร์ยังรัน ถ้าหน้า "ยอดใช้วัตถุดิบ" ก็ดึงไม่ขึ้นเหมือนกัน แปลว่าเป็นที่เซิร์ฟเวอร์ตัวนี้'
                : errorCode === 'ZK_HOST_OUTDATED'
                ? 'เครื่องออฟฟิศตอบอยู่ แต่ไม่รู้จัก /zk/* — server.js ที่รันอยู่เป็นเวอร์ชันเก่า ให้ก๊อป host-server/server.js ตัวล่าสุดไปทับแล้วรีสตาร์ท node server.js (ถ้าเปิด http://localhost:14365/zk/ping บนเครื่องนั้นแล้วได้ ok:true แปลว่า tunnel/โดเมนชี้ผิดที่แทน)'
                : errorCode === 'ZK_HOST_UNREACHABLE'
                ? 'ตรวจที่เครื่องออฟฟิศ: เปิดเครื่องอยู่ไหม, host-server (node server.js) รันอยู่ไหม และ tunnel/โดเมนที่ตั้งใน STORE_API_BASE ยังใช้ได้ไหม — เช็กเร็วๆ ด้วยการเปิด http://localhost:14365/zk/ping บนเครื่องนั้น'
                : errorCode === 'ZK_CONNECT_FAILED'
                  ? 'ตรวจว่า SQL Server ของ ZKBio เปิดอยู่ และเปิดพอร์ตให้เข้าถึงจากภายนอกได้ (ปกติควรให้ดึงผ่าน host API แทน ไม่ต้องเปิดพอร์ต SQL ออกเน็ต)'
                  : 'ลองใหม่อีกครั้ง หรือแคบช่วงวันที่ลง'}
            </div>
          </div>
        </div>
      )}

      {warning && (
        <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-sm flex items-start gap-2">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <span>{warning}</span>
        </div>
      )}

      {/* ตารางงานเป็นข้อมูลเสริม — ดึงไม่ได้/ไม่ครบก็ยังดูเวลาสแกนได้ตามปกติ บอกไว้เฉยๆ ว่าทำไมช่องฝั่งซ้ายว่าง */}
      {schedNote && !loading && rows !== null && (
        <div className="p-3 bg-indigo-50 border border-indigo-200 text-indigo-800 rounded-xl text-sm flex items-start gap-2">
          <CalendarClock size={18} className="mt-0.5 flex-shrink-0" />
          <span>ตารางงาน: {schedNote}</span>
        </div>
      )}

      {rows !== null && (
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
          {/* แถบเครื่องมือ */}
          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
              <button
                onClick={() => setView('daily')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${view === 'daily' ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <CalendarDays size={16} /> สรุปรายวัน
              </button>
              <button
                onClick={() => setView('raw')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${view === 'raw' ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <ListOrdered size={16} /> ทุกครั้งที่สแกน
              </button>
            </div>
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหารหัส หรือชื่อพนักงาน…"
                className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-amber-500 outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              {view === 'daily' && (
                <button
                  onClick={() => setShowPlan((v) => !v)}
                  title="แสดง/ซ่อนเวลาที่สาขาลงตารางไว้ และนาทีที่สาย"
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    showPlan
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                      : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  <CalendarClock size={14} /> เทียบตารางงาน
                </button>
              )}
              <span className="text-xs text-slate-400">
                {view === 'daily'
                  ? `${daily.length} แถว • ${people} คน${showPlan ? ` • มีตารางงาน ${matched}` : ''}`
                  : `${filtered.length} ครั้ง`}
              </span>
              <button
                onClick={exportExcel}
                disabled={filtered.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                <Download size={14} /> Excel
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="py-16 px-6 text-center text-sm space-y-1">
              <p className="text-amber-600 font-medium">ไม่พบการสแกนในช่วงวันที่ที่เลือก</p>
              <p className="text-slate-400 text-xs">
                ลองเปลี่ยนช่วงวันที่ หรือเลือก &quot;ทุกสาขา&quot; ดูก่อน (สาขาอ่านจากค่า Area ที่ตั้งไว้ในเครื่องสแกน)
                · ถ้ายังไม่มีข้อมูล ให้ตรวจว่าเครื่องสแกนของสาขาส่งข้อมูลเข้าระบบแล้วหรือยัง
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-sm">ไม่พบพนักงานที่ค้นหา</div>
          ) : view === 'daily' ? (
            <div className="overflow-auto max-h-[65vh]">
              {/* 17 คอลัมน์ตอนเปิดเทียบตารางงาน — บังคับความกว้างขั้นต่ำไว้ให้เลื่อนแนวนอนแทนที่จะบีบจนอ่านไม่ออก */}
              <table className={`w-full text-sm border-collapse${showPlan ? ' min-w-max' : ''}`}>
                {/* เปิดเทียบตารางงาน = หัวตารางสองชั้น แยกให้เห็นชัดว่าฝั่งไหนคือเวลาที่สาขาลงไว้
                    ฝั่งไหนคือเวลาที่สแกนจริง · ปิดไว้ = ตารางสั้นแบบเดิม */}
                {showPlan ? (
                  <thead className="text-[11px] text-slate-600">
                    <tr>
                      {['วันที่', 'รหัส', 'ชื่อ', 'สาขา'].map((h) => (
                        <th key={h} rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-slate-50 border-b border-slate-200">{h}</th>
                      ))}
                      <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-indigo-100 text-indigo-800 border-b border-l border-slate-200 font-semibold">ตารางงานที่ลงไว้</th>
                      <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-emerald-100 text-emerald-800 border-b border-l border-slate-200 font-semibold">สแกนจริง</th>
                      <th colSpan={3} className="h-8 px-3 text-center sticky top-0 bg-rose-100 text-rose-800 border-b border-l border-slate-200 font-semibold">สาย (นาที)</th>
                      <th colSpan={3} className="h-8 px-3 text-center sticky top-0 bg-slate-50 border-b border-l border-slate-200 font-semibold">เวลาทำงาน (ชม.)</th>
                      <th rowSpan={2} className="h-8 px-3 text-right sticky top-0 bg-slate-50 border-b border-l border-slate-200">สแกน</th>
                    </tr>
                    <tr>
                      {['เข้า', 'ออกเบรค', 'เข้าเบรค', 'ออก'].map((h, i) => (
                        <th key={`p${h}`} className={`px-3 py-1.5 text-center sticky top-8 bg-indigo-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                      ))}
                      {['เข้า', 'ออกเบรค', 'เข้าเบรค', 'ออก'].map((h, i) => (
                        <th key={`a${h}`} className={`px-3 py-1.5 text-center sticky top-8 bg-emerald-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                      ))}
                      {['เข้าสาย', 'เบรคสาย', 'ออกก่อน'].map((h, i) => (
                        <th key={h} className={`px-3 py-1.5 text-center sticky top-8 bg-rose-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                      ))}
                      {['รวม', 'พัก', 'สุทธิ'].map((h, i) => (
                        <th key={h} className={`px-3 py-1.5 text-right sticky top-8 bg-slate-50 border-b border-slate-200 font-normal${i === 0 ? ' border-l' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                ) : (
                  <thead>
                    <tr className="text-slate-600 text-xs">
                      {['วันที่', 'รหัส', 'ชื่อ', 'สาขา'].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-left sticky top-0 bg-slate-50 border-b border-slate-200">{h}</th>
                      ))}
                      {['เข้า', 'ออกเบรค', 'เข้าเบรค', 'ออก'].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-center sticky top-0 bg-slate-50 border-b border-slate-200">{h}</th>
                      ))}
                      {['รวม', 'พัก', 'สุทธิ', 'สแกน'].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-right sticky top-0 bg-slate-50 border-b border-slate-200">{h}</th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {daily.map((d) => (
                    <tr key={`${d.date}|${d.empCode}`} className="hover:bg-amber-50/40">
                      <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{d.date}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{d.empCode}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{d.name || <Dash />}</td>
                      <td className="px-3 py-2 text-xs text-slate-400">{d.branch || <Dash />}</td>

                      {/* ฝั่งตารางงานที่สาขาลงไว้ */}
                      {showPlan && (
                        <>
                          <td className="px-3 py-2 text-center bg-indigo-50/40 border-l border-slate-200">{timeCell(d.plan?.in, 'text-indigo-700')}</td>
                          <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.breakOut, 'text-indigo-500')}</td>
                          <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.breakIn, 'text-indigo-500')}</td>
                          <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.out, 'text-indigo-700')}</td>
                        </>
                      )}

                      {/* ฝั่งที่สแกนจริง */}
                      <td className={`px-3 py-2 text-center${showPlan ? ' border-l border-slate-200' : ''}`}>{timeCell(hhmm(d.first), 'font-semibold text-emerald-700')}</td>
                      <td className="px-3 py-2 text-center">{timeCell(d.breakOut ? hhmm(d.breakOut) : '', 'text-amber-600')}</td>
                      <td className="px-3 py-2 text-center">{timeCell(d.breakIn ? hhmm(d.breakIn) : '', 'text-amber-600')}</td>
                      <td className="px-3 py-2 text-center">{timeCell(d.last ? hhmm(d.last) : '', 'font-semibold text-rose-700')}</td>

                      {/* สรุปส่วนต่าง */}
                      {showPlan && (
                        <>
                          <td className="px-3 py-2 text-center bg-rose-50/30 border-l border-slate-200">{lateCell(d.lateIn)}</td>
                          <td className="px-3 py-2 text-center bg-rose-50/30">{lateCell(d.lateBreakIn)}</td>
                          <td className="px-3 py-2 text-center bg-rose-50/30">{lateCell(d.earlyOut)}</td>
                        </>
                      )}

                      {/* เวลาทำงาน */}
                      <td className={`px-3 py-2 text-right font-mono text-slate-500${showPlan ? ' border-l border-slate-200' : ''}`}>{num2(d.hours)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">{num2(d.breakHours)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-slate-800">{num2(d.netHours)}</td>
                      <td className={`px-3 py-2 text-right font-mono text-slate-400${showPlan ? ' border-l border-slate-200' : ''}`}>{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-3 text-xs text-slate-400 border-t border-slate-100 space-y-1">
                <p>
                  {showPlan && (
                    <>
                      <span className="font-medium text-indigo-600">ตารางงานที่ลงไว้</span> = เวลาที่สาขากรอกในหน้าลงตารางรายสัปดาห์ (ระบบ Narai-branch) ·{' '}
                    </>
                  )}
                  <span className="font-medium text-emerald-600">สแกนจริง</span> อ่านจากลำดับการสแกน 4 รอบ: เข้างาน → ออกเบรค → เข้าเบรค → ออกงาน ·
                  ช่องที่เป็น — คือไม่มีข้อมูลฝั่งนั้น (ยังไม่ได้ลงตาราง หรือวันนั้นสแกนไม่ครบ)
                </p>
                {showPlan && (
                  <p>
                    <span className="font-medium text-rose-600">เข้าสาย</span> = สแกนเข้า − เวลาเข้าที่ลงไว้ ·
                    <span className="font-medium text-rose-600"> เบรคสาย</span> = สแกนเข้าเบรค − เวลาสิ้นสุดเบรคที่ลงไว้
                    (ถ้าไม่ได้ลงช่วงเบรคไว้ จะเทียบกับ ออกเบรคจริง + ระยะเบรคที่อนุญาตแทน) ·
                    <span className="font-medium text-rose-600"> ออกก่อน</span> = เวลาออกที่ลงไว้ − สแกนออก ·
                    นับเฉพาะที่เกิน 0 นาที มาก่อนเวลาไม่ถือว่าติดลบ
                  </p>
                )}
                <p>
                  <span className="font-medium">สุทธิ</span> = ชั่วโมงรวมหักเวลาพักแล้ว
                  {showPlan && ' · จับคู่กับตารางงานด้วยรหัสพนักงานก่อน ถ้ารหัสไม่ตรงจะลองจับด้วยชื่อในวันเดียวกัน'}
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-slate-600 text-xs">
                    {['เวลา', 'รหัส', 'ชื่อ', 'ประเภท', 'สาขา', 'เครื่อง'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left sticky top-0 bg-slate-50 border-b border-slate-200">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {filtered.map((r, i) => (
                    <tr key={`${r.empCode}-${r.time}-${i}`} className="hover:bg-amber-50/40">
                      <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{r.time}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{r.empCode}</td>
                      <td className="px-4 py-2 whitespace-nowrap">{r.name || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-2 text-xs">
                        {r.stateLabel
                          ? <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{r.stateLabel}</span>
                          : <span className="text-slate-300">{r.state || '—'}</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-400">{r.area || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-2 text-xs text-slate-400">{r.terminal || <span className="text-slate-300">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {rows === null && !loading && !error && (
        <div className="bg-white border border-slate-100 rounded-2xl py-16 text-center text-sm text-slate-400 shadow-sm">
          กดปุ่มช่วงเวลา (วันนี้ / สัปดาห์นี้ / เดือนนี้ / เดือนที่แล้ว) หรือกำหนดวันที่เอง
          แล้วกด &quot;ดึงข้อมูล&quot; เพื่อดูเวลาสแกนหน้าเข้า-ออกงาน
        </div>
      )}
    </div>
  );
}
