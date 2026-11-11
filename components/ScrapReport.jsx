// STOCK › ข้อมูลเศษ
//
// เทียบ 3 ยอดของแต่ละสาขา: เบิก (วัตถุดิบต้นทาง) → เตรียม (สาขาคีย์ใน POS โต๊ะเตรียม) → เศษ (รหัสเศษ)
// แสดงเป็นยอดสะสมทั้งช่วง กดดูรายวัน/รายสาขาได้ และกดช่องรายวันเพื่อดูรายการของวันนั้น
//
// ข้อมูลมาจาก /api/scrap-report สาขาละคำขอ (ยิงเป็นชุด ไม่ยิงทุกสาขาพร้อมกัน — host API ช้าลงมากเมื่อโดนพร้อมกัน)
// รหัสเศษ/รายการเตรียม/ไอเทมต้นทาง อยู่ที่ lib/scrapReport.js ที่เดียว
import { useState, useMemo, Fragment } from 'react';
import { Loader2, Download, AlertTriangle, ChevronRight, ChevronDown, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import * as XLSX from 'xlsx-js-style';
import { useBranches } from '../lib/useBranches';
import { isIncludedBranch } from '../lib/excludedBranches';
import { dateLabel } from '../lib/thaiDate';
import { SCRAP_GROUPS, nameKey } from '../lib/scrapReport';

const BRANCH_BATCH = 5;

const GROUP_TONE = {
  '971015': { text: 'text-red-700', bg: 'bg-red-50', border: 'border-t-red-600', ring: 'ring-red-500' },
  '971013': { text: 'text-pink-700', bg: 'bg-pink-50', border: 'border-t-pink-600', ring: 'ring-pink-500' },
  '971014': { text: 'text-orange-700', bg: 'bg-orange-50', border: 'border-t-orange-600', ring: 'ring-orange-500' },
};
const DEFAULT_TONE = { text: 'text-slate-600', bg: 'bg-slate-50', border: 'border-t-slate-500', ring: 'ring-slate-400' };
const toneOf = code => GROUP_TONE[code] || DEFAULT_TONE;

const MEASURES = [
  { key: 'scrap', label: 'เศษ' },
  { key: 'prep', label: 'เตรียม' },
  { key: 'wd', label: 'เบิก' },
  { key: 'cmp', label: 'เทียบ 3 ยอด' },
];

const fmt = n => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtOrDash = n => (Math.abs(Number(n) || 0) < 0.0005 ? '–' : fmt(n));
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '–');
const localYmd = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export default function ScrapReport() {
  const { branches: registry, loading: branchLoading } = useBranches();
  const allBranches = useMemo(
    () => registry.filter(b => b.outletId && isIncludedBranch(b.code)),
    [registry]
  );

  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(1); return localYmd(d); });
  const [endDate, setEndDate] = useState(() => localYmd(new Date()));
  const [branchSel, setBranchSel] = useState('all');

  // records = แถวแบนของทุกสาขา { branch, date, kind: 'scrap'|'prep'|'wd', group, item, name, qty }
  const [records, setRecords] = useState([]);
  const [loadedBranches, setLoadedBranches] = useState([]);   // รหัสสาขาที่ดึงมาแล้ว (เรียงตามทะเบียน)
  const [loadedRange, setLoadedRange] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');

  const [group, setGroup] = useState(SCRAP_GROUPS[0].code);
  const [measure, setMeasure] = useState('scrap');
  const [cell, setCell] = useState(null);                      // { branch, date } ของช่องที่กดดูรายการ

  const fetchData = async () => {
    if (!startDate || !endDate) return toast.error('กรุณาระบุช่วงวันที่ให้ครบถ้วน');
    if (startDate > endDate) return toast.error('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด');
    if (!allBranches.length) return toast.error('ไม่พบสาขาที่มีรหัส outlet — ดึงข้อมูลไม่ได้');

    setLoading(true);
    setWarnings([]);
    const recs = [];
    const warn = [];
    const done = [];
    try {
      for (let i = 0; i < allBranches.length; i += BRANCH_BATCH) {
        const batch = allBranches.slice(i, i + BRANCH_BATCH);
        setProgress(`${Math.min(i + BRANCH_BATCH, allBranches.length)}/${allBranches.length} สาขา`);
        const results = await Promise.all(batch.map(b =>
          fetch(`/api/scrap-report?branch=${encodeURIComponent(b.code)}&outletId=${encodeURIComponent(b.outletId)}` +
                `&startDate=${startDate}&endDate=${endDate}`)
            .then(async r => {
              const text = await r.text();
              try { return JSON.parse(text); }
              catch { return { status: 'error', message: `เซิร์ฟเวอร์ตอบช้าหรือขัดข้อง (HTTP ${r.status})` }; }
            })
            .catch(err => ({ status: 'error', message: err.message }))
        ));
        results.forEach((res, idx) => {
          const code = String(batch[idx].code).toUpperCase();
          if (res.status !== 'success') {
            warn.push(`${code}: ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}`);
            return;
          }
          done.push(code);
          (res.warnings || []).forEach(w => warn.push(`${code}: ${w}`));
          (res.data?.pos || []).forEach(r => recs.push({
            branch: code, date: r.date, kind: r.kind, group: r.group, item: r.code, name: r.name, qty: Number(r.qty) || 0,
          }));
          (res.data?.wd || []).forEach(r => recs.push({
            branch: code, date: r.date, kind: 'wd', group: r.group, item: r.key, name: r.name, qty: Number(r.qty) || 0,
          }));
        });
      }
      setRecords(recs);
      setLoadedBranches(done);
      setLoadedRange({ start: startDate, end: endDate });
      setWarnings(warn);
      if (!done.length) toast.error('ดึงข้อมูลไม่สำเร็จทุกสาขา');
      else if (warn.length) toast.error(`ดึงข้อมูลได้ไม่ครบ ${warn.length} รายการ — ดูรายละเอียดด้านบนตาราง`, { duration: 6000 });
      else toast.success(`ดึงข้อมูลแล้ว ${done.length} สาขา`);
    } finally {
      setLoading(false);
      setProgress('');
    }
  };

  // สาขาที่แสดง = สาขาที่ดึงมาแล้ว กรองตาม dropdown (กรองที่หน้าเว็บ ไม่ต้องดึงใหม่)
  const shown = useMemo(
    () => (branchSel === 'all' ? loadedBranches : loadedBranches.filter(b => b === branchSel)),
    [loadedBranches, branchSel]
  );

  // รวมยอดรอบเดียว เก็บหลายระดับ — ทุกตารางอ่านจากก้อนนี้
  //   g[kind|group|branch]  d[kind|group|branch|date]  it[kind|item|branch]  dates[group] = ชุดวันที่ที่มีข้อมูล
  const agg = useMemo(() => {
    const g = {}, d = {}, it = {}, dates = {}, posNames = {};
    const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
    records.forEach(r => {
      add(g, `${r.kind}|${r.group}|${r.branch}`, r.qty);
      add(d, `${r.kind}|${r.group}|${r.branch}|${r.date}`, r.qty);
      add(it, `${r.kind}|${r.item}|${r.branch}`, r.qty);
      (dates[r.group] = dates[r.group] || new Set()).add(r.date);
      if (r.kind !== 'wd' && r.name && !posNames[r.item]) posNames[r.item] = r.name;
    });
    return { g, d, it, dates, posNames };
  }, [records]);

  const groupName = gr => gr.name || agg.posNames[gr.code] || `รหัส ${gr.code}`;
  const gv = (kind, code, branch) => agg.g[`${kind}|${code}|${branch}`] || 0;
  const gTot = (kind, code) => shown.reduce((s, b) => s + gv(kind, code, b), 0);
  const dv = (kind, code, branch, date) => agg.d[`${kind}|${code}|${branch}|${date}`] || 0;
  const iv = (kind, item, branch) => agg.it[`${kind}|${item}|${branch}`] || 0;
  const hasCompare = gr => gr.sources.length > 0 || gr.preps.length > 0;

  const current = SCRAP_GROUPS.find(x => x.code === group) || SCRAP_GROUPS[0];
  const tone = toneOf(current.code);
  const dayList = useMemo(
    () => [...(agg.dates[current.code] || [])].sort().reverse(),
    [agg, current.code]
  );

  // ── Export Excel: 3 ชีท (สรุป / รายวัน / เทียบรายสาขา) ──
  const exportExcel = () => {
    if (!loadedRange) return toast.error('ยังไม่มีข้อมูลให้ export — กดดึงข้อมูลก่อน');
    const wb = XLSX.utils.book_new();
    const n = v => Number((Number(v) || 0).toFixed(3));

    const sum = [['รหัสเศษ', 'รายการ', ...shown.map(b => `เศษ ${b}`), 'รวมเศษ', 'ยอดเบิก', 'ยอดเตรียม', '% เตรียม/เบิก', '% เศษ/เตรียม', 'ส่วนต่าง (เบิก−เตรียม−เศษ)']];
    SCRAP_GROUPS.forEach(gr => {
      const s = gTot('scrap', gr.code), w = gTot('wd', gr.code), p = gTot('prep', gr.code);
      sum.push([gr.code, groupName(gr), ...shown.map(b => n(gv('scrap', gr.code, b))), n(s), n(w), n(p),
        w > 0 ? n((p / w) * 100) : '', p > 0 ? n((s / p) * 100) : '', hasCompare(gr) ? n(w - p - s) : '']);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'สรุป');

    const daily = [['วันที่', 'สาขา', 'รหัสเศษ', 'รายการ', 'เบิก', 'เตรียม', 'เศษ']];
    SCRAP_GROUPS.forEach(gr => {
      [...(agg.dates[gr.code] || [])].sort().forEach(date => shown.forEach(b => {
        const w = dv('wd', gr.code, b, date), p = dv('prep', gr.code, b, date), s = dv('scrap', gr.code, b, date);
        if (w || p || s) daily.push([date, b, gr.code, groupName(gr), n(w), n(p), n(s)]);
      }));
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daily), 'รายวัน');

    const cmp = [['กลุ่ม', 'ประเภท', 'รหัส', 'ไอเทม', ...shown, 'รวม']];
    const line = (gr, type, code, name, fn) => {
      const vals = shown.map(b => n(fn(b)));
      cmp.push([gr.code, type, code, name, ...vals, n(vals.reduce((a, b) => a + b, 0))]);
    };
    SCRAP_GROUPS.forEach(gr => {
      gr.sources.forEach(nm => line(gr, 'เบิก', '', nm, b => iv('wd', nameKey(nm), b)));
      gr.preps.forEach(p => line(gr, 'เตรียม', p.code, p.name, b => iv('prep', p.code, b)));
      line(gr, 'เศษ', gr.code, groupName(gr), b => gv('scrap', gr.code, b));
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cmp), 'เทียบรายสาขา');

    XLSX.writeFile(wb, `scrap_report_${loadedRange.start}_${loadedRange.end}.xlsx`);
  };

  const th = 'px-3 py-2 text-[11px] font-bold text-slate-500 bg-slate-50 border-b-2 border-slate-200 whitespace-nowrap';
  const td = 'px-3 py-1.5 border-b border-slate-100 whitespace-nowrap';
  const num = `${td} text-right tabular-nums`;

  // แถวตัวเลขของตารางเทียบ (ตารางที่ 3)
  const cmpRow = (key, label, fn, cls = '', render = fmtOrDash) => {
    const vals = shown.map(fn);
    return (
      <tr key={key} className={cls}>
        <td className={`${td} pl-8`}>{label}</td>
        {vals.map((v, i) => <td key={shown[i]} className={num}>{render(v)}</td>)}
        <td className={`${num} font-bold`}>{render(vals.reduce((a, b) => a + b, 0))}</td>
      </tr>
    );
  };
  const pctRow = (key, label, kind, base, gr, cls) => (
    <tr key={key} className={cls}>
      <td className={`${td} pl-8`}>{label}</td>
      {shown.map(b => <td key={b} className={num}>{pct(gv(kind, gr.code, b), gv(base, gr.code, b))}</td>)}
      <td className={num}>{pct(gTot(kind, gr.code), gTot(base, gr.code))}</td>
    </tr>
  );
  const secRow = (key, pillCls, pill, text) => (
    <tr key={key}>
      <td colSpan={shown.length + 2} className="px-3 pt-3 pb-1.5 text-[11.5px] text-slate-500 border-b border-slate-200">
        <span className={`ml-4 mr-2 px-2.5 py-0.5 rounded-full text-[11px] font-bold ${pillCls}`}>{pill}</span>{text}
      </td>
    </tr>
  );

  // รายการของช่องที่กด (สาขา + วัน) ในกลุ่มที่เลือก
  const cellRows = useMemo(() => {
    if (!cell) return [];
    return records
      .filter(r => r.branch === cell.branch && r.date === cell.date && r.group === current.code)
      .sort((a, b) => a.kind.localeCompare(b.kind) || String(a.name).localeCompare(String(b.name), 'th'));
  }, [cell, records, current.code]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        ยอดสะสมเศษอาหารรหัส {SCRAP_GROUPS.map(g => g.code).join(' · ')} เทียบกับยอดเบิกวัตถุดิบและยอดเตรียม (โต๊ะเตรียม) ของแต่ละสาขา · หน่วย กก.
      </p>

      {/* ── ตัวกรอง ── */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-end gap-3">
        <label className="text-[11px] font-bold text-slate-500">
          <span className="block mb-1">ตั้งแต่วันที่</span>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm font-normal text-slate-800" />
        </label>
        <label className="text-[11px] font-bold text-slate-500">
          <span className="block mb-1">ถึงวันที่</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm font-normal text-slate-800" />
        </label>
        <label className="text-[11px] font-bold text-slate-500">
          <span className="block mb-1">สาขา</span>
          <select value={branchSel} onChange={e => setBranchSel(e.target.value)}
            className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm font-normal text-slate-800 min-w-[130px]">
            <option value="all">ทุกสาขา</option>
            {allBranches.map(b => {
              const code = String(b.code).toUpperCase();
              return <option key={code} value={code}>{code}</option>;
            })}
          </select>
        </label>
        <button onClick={fetchData} disabled={loading || branchLoading}
          className="bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-bold text-sm rounded-lg px-4 py-2 flex items-center gap-2">
          {loading && <Loader2 size={15} className="animate-spin" />}
          {loading ? `กำลังดึง ${progress}` : 'ดึงข้อมูล'}
        </button>
        <button onClick={exportExcel} disabled={!loadedRange || loading}
          className="ml-auto border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 font-bold text-sm rounded-lg px-4 py-2 flex items-center gap-2">
          <Download size={15} /> Export Excel
        </button>
      </div>

      {warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded-xl p-3 text-xs">
          <div className="font-bold flex items-center gap-1.5 mb-1"><AlertTriangle size={14} /> ดึงข้อมูลได้ไม่ครบ — ตัวเลขของรายการด้านล่างนี้ยังไม่รวมอยู่ในรายงาน</div>
          <ul className="list-disc pl-5 space-y-0.5">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      {!loadedRange ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center text-sm text-slate-500">
          เลือกช่วงวันที่แล้วกด <b>ดึงข้อมูล</b> เพื่อดูรายงาน
        </div>
      ) : shown.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center text-sm text-slate-500">
          ไม่มีข้อมูลของสาขาที่เลือกในรอบที่ดึงมา
        </div>
      ) : (
        <>
          {/* ── การ์ดสรุปต่อรหัสเศษ ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {SCRAP_GROUPS.map(gr => {
              const t = toneOf(gr.code);
              const s = gTot('scrap', gr.code), w = gTot('wd', gr.code), p = gTot('prep', gr.code);
              const on = gr.code === current.code;
              return (
                <button key={gr.code} onClick={() => setGroup(gr.code)}
                  className={`text-left bg-white border border-slate-200 border-t-4 ${t.border} rounded-xl p-4 transition ${on ? `ring-2 ${t.ring} ${t.bg}` : 'hover:bg-slate-50'}`}>
                  <div className={`text-[11px] font-bold tracking-wide ${t.text}`}>{gr.code}</div>
                  <div className="font-bold text-sm text-slate-800 mb-2">{groupName(gr)}</div>
                  <div className={`text-2xl font-bold ${t.text}`}>{fmt(s)} <span className="text-xs font-normal text-slate-500">กก.</span></div>
                  <div className="text-[11px] text-slate-500 mb-2">เศษสะสม {dateLabel(loadedRange.start)} – {dateLabel(loadedRange.end)}</div>
                  {hasCompare(gr) ? (
                    <>
                      <div className="flex items-start gap-1.5 border-t border-slate-200 pt-2 text-[10.5px] text-slate-500">
                        <div className="flex-1">เบิก<b className="block text-[13px] text-slate-800">{fmtOrDash(w)}</b></div>
                        <span className="mt-2.5 text-slate-400">→</span>
                        <div className="flex-1">เตรียม<b className="block text-[13px] text-emerald-700">{fmtOrDash(p)}</b><b className="text-emerald-700">{pct(p, w)}</b></div>
                        <span className="mt-2.5 text-slate-400">→</span>
                        <div className="flex-1">เศษ<b className={`block text-[13px] ${t.text}`}>{fmtOrDash(s)}</b><b className={t.text}>{pct(s, p)}</b></div>
                      </div>
                      <div className="flex justify-between text-[11px] text-slate-500 mt-2">
                        <span>ส่วนต่าง (เบิก − เตรียม − เศษ)</span><b className="text-slate-800">{fmt(w - p - s)} กก.</b>
                      </div>
                    </>
                  ) : (
                    <div className="border-t border-slate-200 pt-2 text-[11px] text-slate-400">ยังไม่ได้กำหนดไอเทมต้นทาง / รายการเตรียม</div>
                  )}
                </button>
              );
            })}
          </div>

          {/* ── 1. ยอดเศษสะสม แยกตามสาขา ── */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-[11px] font-bold grid place-items-center">1</span>
              <h2 className="font-bold text-slate-800">ยอดเศษสะสม แยกตามสาขา</h2>
              <span className="text-xs text-slate-500">หน่วย กก. · กดแถวเพื่อดูรายวันของรหัสนั้น</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={`${th} text-left`}>รหัส / รายการเศษ</th>
                    {shown.map(b => <th key={b} className={`${th} text-right`}>เศษ {b}</th>)}
                    <th className={`${th} text-right`}>รวมเศษ</th>
                    <th className={`${th} text-right`}>ยอดเบิก</th>
                    <th className={`${th} text-right`}>ยอดเตรียม</th>
                    <th className={`${th} text-right`}>% เตรียม/เบิก</th>
                    <th className={`${th} text-right`}>% เศษ/เตรียม</th>
                    <th className={`${th} text-right`}>ส่วนต่าง</th>
                  </tr>
                </thead>
                <tbody>
                  {SCRAP_GROUPS.map(gr => {
                    const t = toneOf(gr.code);
                    const s = gTot('scrap', gr.code), w = gTot('wd', gr.code), p = gTot('prep', gr.code);
                    const on = gr.code === current.code;
                    return (
                      <tr key={gr.code} onClick={() => setGroup(gr.code)} className={`cursor-pointer ${on ? t.bg : 'hover:bg-slate-50'}`}>
                        <td className={td}>
                          {on ? <ChevronDown size={13} className="inline mr-1 text-slate-400" /> : <ChevronRight size={13} className="inline mr-1 text-slate-400" />}
                          <span className={`text-[11px] font-bold rounded px-1.5 py-0.5 mr-1.5 ${t.bg} ${t.text}`}>{gr.code}</span>
                          {groupName(gr)}
                        </td>
                        {shown.map(b => <td key={b} className={num}>{fmtOrDash(gv('scrap', gr.code, b))}</td>)}
                        <td className={`${num} font-bold bg-amber-50`}>{fmt(s)}</td>
                        <td className={num}>{hasCompare(gr) ? fmtOrDash(w) : '–'}</td>
                        <td className={`${num} font-bold text-emerald-700`}>{hasCompare(gr) ? fmtOrDash(p) : '–'}</td>
                        <td className={`${num} font-bold text-emerald-700`}>{pct(p, w)}</td>
                        <td className={`${num} font-bold text-amber-700`}>{pct(s, p)}</td>
                        <td className={num}>{hasCompare(gr) ? fmt(w - p - s) : '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-bold bg-slate-50">
                    <td className={`${td} border-t-2 border-slate-200`}>รวมทั้งหมด</td>
                    {shown.map(b => <td key={b} className={`${num} border-t-2 border-slate-200`}>{fmt(SCRAP_GROUPS.reduce((a, gr) => a + gv('scrap', gr.code, b), 0))}</td>)}
                    <td className={`${num} border-t-2 border-slate-200`}>{fmt(SCRAP_GROUPS.reduce((a, gr) => a + gTot('scrap', gr.code), 0))}</td>
                    <td className={`${num} border-t-2 border-slate-200`}>{fmt(SCRAP_GROUPS.reduce((a, gr) => a + gTot('wd', gr.code), 0))}</td>
                    <td className={`${num} border-t-2 border-slate-200`}>{fmt(SCRAP_GROUPS.reduce((a, gr) => a + gTot('prep', gr.code), 0))}</td>
                    <td className={`${td} border-t-2 border-slate-200`} colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* ── 2. รายวันของรหัสที่เลือก ── */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-[11px] font-bold grid place-items-center">2</span>
              <h2 className="font-bold text-slate-800">
                รายวัน — <span className={`text-[11px] font-bold rounded px-1.5 py-0.5 mr-1 ${tone.bg} ${tone.text}`}>{current.code}</span>{groupName(current)}
              </h2>
              <span className="text-xs text-slate-500">แต่ละวัน แต่ละสาขา เท่าไหร่ · กดช่องตัวเลขเพื่อดูรายการของวันนั้น</span>
              <div className="ml-auto flex bg-slate-100 rounded-lg p-0.5">
                {MEASURES.map(m => (
                  <button key={m.key} onClick={() => setMeasure(m.key)}
                    className={`px-3 py-1 rounded-md text-xs ${measure === m.key ? 'bg-white text-amber-700 font-bold shadow-sm' : 'text-slate-500'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            {dayList.length === 0 ? (
              <div className="text-center text-sm text-slate-400 py-8">ไม่มีรายการของรหัสนี้ในช่วงที่เลือก</div>
            ) : measure === 'cmp' ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr>
                      <th className={`${th} text-left`}>วันที่</th>
                      <th className={`${th} text-right`}>เบิก</th>
                      <th className={`${th} text-right`}>เตรียม</th>
                      <th className={`${th} text-right`}>เศษ</th>
                      <th className={`${th} text-right`}>% เตรียม/เบิก</th>
                      <th className={`${th} text-right`}>% เศษ/เตรียม</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayList.map(date => {
                      const w = shown.reduce((a, b) => a + dv('wd', current.code, b, date), 0);
                      const p = shown.reduce((a, b) => a + dv('prep', current.code, b, date), 0);
                      const s = shown.reduce((a, b) => a + dv('scrap', current.code, b, date), 0);
                      return (
                        <tr key={date} className="hover:bg-slate-50">
                          <td className={td}>{dateLabel(date)}</td>
                          <td className={num}>{fmtOrDash(w)}</td>
                          <td className={`${num} text-emerald-700`}>{fmtOrDash(p)}</td>
                          <td className={`${num} ${tone.text}`}>{fmtOrDash(s)}</td>
                          <td className={num}>{pct(p, w)}</td>
                          <td className={num}>{pct(s, p)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold bg-slate-50">
                      <td className={`${td} border-t-2 border-slate-200`}>รวม {dayList.length} วัน</td>
                      <td className={`${num} border-t-2 border-slate-200`}>{fmt(gTot('wd', current.code))}</td>
                      <td className={`${num} border-t-2 border-slate-200`}>{fmt(gTot('prep', current.code))}</td>
                      <td className={`${num} border-t-2 border-slate-200`}>{fmt(gTot('scrap', current.code))}</td>
                      <td className={`${num} border-t-2 border-slate-200`}>{pct(gTot('prep', current.code), gTot('wd', current.code))}</td>
                      <td className={`${num} border-t-2 border-slate-200`}>{pct(gTot('scrap', current.code), gTot('prep', current.code))}</td>
                    </tr>
                  </tfoot>
                </table>
                <p className="text-[11px] text-slate-400 mt-2">
                  วันที่เบิกกับวันที่เตรียม/เกิดเศษมักไม่ใช่วันเดียวกัน — % รายวันจึงแกว่งได้มาก ให้ดู % ของทั้งช่วงเป็นหลัก
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr>
                      <th className={`${th} text-left`}>วันที่</th>
                      {shown.map(b => <th key={b} className={`${th} text-right`}>{b}</th>)}
                      <th className={`${th} text-right`}>รวมวันนั้น</th>
                      <th className={`${th} text-right`}>สะสมถึงวันนั้น</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayList.map((date, di) => {
                      const dayTot = shown.reduce((a, b) => a + dv(measure, current.code, b, date), 0);
                      // dayList เรียงใหม่→เก่า สะสมถึงวันนั้น = รวมตั้งแต่วันแรกของช่วงถึงวันนี้
                      const running = dayList.slice(di).reduce((a, dd) => a + shown.reduce((x, b) => x + dv(measure, current.code, b, dd), 0), 0);
                      return (
                        <tr key={date} className="hover:bg-slate-50">
                          <td className={td}>{dateLabel(date)}</td>
                          {shown.map(b => {
                            const v = dv(measure, current.code, b, date);
                            return (
                              <td key={b} className={`${num} ${v ? 'cursor-pointer hover:bg-amber-50 hover:font-bold' : 'text-slate-300'}`}
                                onClick={() => v && setCell({ branch: b, date })}>
                                {fmtOrDash(v)}
                              </td>
                            );
                          })}
                          <td className={`${num} font-bold bg-amber-50`}>{fmt(dayTot)}</td>
                          <td className={`${num} text-slate-400`}>{fmt(running)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold bg-slate-50">
                      <td className={`${td} border-t-2 border-slate-200`}>รวม {dayList.length} วัน</td>
                      {shown.map(b => <td key={b} className={`${num} border-t-2 border-slate-200`}>{fmt(gv(measure, current.code, b))}</td>)}
                      <td className={`${num} border-t-2 border-slate-200`}>{fmt(gTot(measure, current.code))}</td>
                      <td className={`${td} border-t-2 border-slate-200`} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* ── 3. เทียบ เบิก → เตรียม → เศษ ── */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-[11px] font-bold grid place-items-center">3</span>
              <h2 className="font-bold text-slate-800">เทียบ เบิก → เตรียม → เศษ ของแต่ละสาขา</h2>
              <span className="text-xs text-slate-500">ช่วง {dateLabel(loadedRange.start)} – {dateLabel(loadedRange.end)} · หน่วย กก.</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={`${th} text-left`}>ไอเทม</th>
                    {shown.map(b => <th key={b} className={`${th} text-right`}>{b}</th>)}
                    <th className={`${th} text-right`}>รวม</th>
                  </tr>
                </thead>
                <tbody>
                  {SCRAP_GROUPS.map(gr => {
                    const t = toneOf(gr.code);
                    return (
                      <Fragment key={gr.code}>
                        <tr>
                          <td colSpan={shown.length + 2} className="px-3 py-2 font-bold bg-slate-50 border-t-2 border-slate-200">
                            <span className={`text-[11px] font-bold rounded px-1.5 py-0.5 mr-1.5 ${t.bg} ${t.text}`}>{gr.code}</span>
                            {groupName(gr)}
                            {!hasCompare(gr) && <span className="ml-2 font-normal text-slate-400">ยังไม่ได้กำหนดไอเทมต้นทาง / รายการเตรียม</span>}
                          </td>
                        </tr>
                        {hasCompare(gr) && (
                          <>
                            {secRow(`${gr.code}-s1`, 'bg-sky-100 text-sky-700', '① เบิก', 'วัตถุดิบต้นทาง — จากรายการเบิกของสาขา')}
                            {gr.sources.map(nm => cmpRow(`${gr.code}-w-${nm}`, nm, b => iv('wd', nameKey(nm), b)))}
                            {cmpRow(`${gr.code}-wt`, 'รวมยอดเบิก', b => gv('wd', gr.code, b), 'font-bold bg-slate-50', fmt)}
                            {secRow(`${gr.code}-s2`, 'bg-emerald-100 text-emerald-700', '② เตรียม', 'รายการเตรียมที่สาขาคีย์ (โต๊ะเตรียม)')}
                            {gr.preps.map(p => cmpRow(`${gr.code}-p-${p.code}`,
                              <><span className="text-[11px] font-bold text-emerald-700 mr-2">{p.code}</span>{p.name}</>,
                              b => iv('prep', p.code, b)))}
                            {cmpRow(`${gr.code}-pt`, 'รวมยอดเตรียม', b => gv('prep', gr.code, b), 'font-bold bg-slate-50 text-emerald-700', fmt)}
                            {secRow(`${gr.code}-s3`, 'bg-red-100 text-red-700', '③ เศษ', 'และผลเปรียบเทียบ')}
                          </>
                        )}
                        {cmpRow(`${gr.code}-sc`, `เศษ ${gr.code}`, b => gv('scrap', gr.code, b), `font-bold ${t.text}`, fmt)}
                        {hasCompare(gr) && (
                          <>
                            {cmpRow(`${gr.code}-df`, 'ส่วนต่าง (เบิก − เตรียม − เศษ)',
                              b => gv('wd', gr.code, b) - gv('prep', gr.code, b) - gv('scrap', gr.code, b), '', fmt)}
                            {pctRow(`${gr.code}-pp`, '% เตรียม/ยอดเบิก', 'prep', 'wd', gr, 'font-bold text-emerald-700 bg-emerald-50')}
                            {pctRow(`${gr.code}-ps`, '% เศษ/ยอดเตรียม', 'scrap', 'prep', gr, 'font-bold text-amber-700 bg-amber-50')}
                          </>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── รายการของช่องที่กด (สาขา + วัน) ── */}
      {cell && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setCell(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <div>
                <div className="font-bold text-slate-800">{cell.branch} · {dateLabel(cell.date)}</div>
                <div className="text-xs text-slate-500">{current.code} {groupName(current)}</div>
              </div>
              <button onClick={() => setCell(null)} className="p-1 rounded hover:bg-slate-100"><X size={18} /></button>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={`${th} text-left`}>ประเภท</th>
                  <th className={`${th} text-left`}>ไอเทม</th>
                  <th className={`${th} text-right`}>จำนวน (กก.)</th>
                </tr>
              </thead>
              <tbody>
                {cellRows.map((r, i) => (
                  <tr key={i}>
                    <td className={td}>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                        r.kind === 'wd' ? 'bg-sky-100 text-sky-700' : r.kind === 'prep' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {r.kind === 'wd' ? 'เบิก' : r.kind === 'prep' ? 'เตรียม' : 'เศษ'}
                      </span>
                    </td>
                    <td className={`${td} whitespace-normal`}>{r.kind === 'wd' ? r.name : `${r.item} ${r.name}`}</td>
                    <td className={`${num} font-bold`}>{fmt(r.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
