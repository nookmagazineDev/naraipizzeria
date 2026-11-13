import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Eye, Loader2, Search, X, Download, AlertCircle } from 'lucide-react';

/*
 * พนักงานเข้า-ออก — กล่องดูอย่างเดียวจากหน้า HR → รายชื่อพนักงาน
 * ข้อมูล: /api/employee-hr?view=movements → office-server getEmployeeMovements (ตาราง hr_employee_movement)
 * ทุกครั้งที่สาขาเพิ่มพนักงาน/แจ้งลาออกจะเกิดแถวใหม่ + ประวัติเก่าที่นำเข้าจากชีท "พนักงานเข้า"/"พนักงานออก"
 */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthStart = (offset = 0) => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth() + offset, 1); };
const monthEnd = (offset = 0) => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth() + offset + 1, 0); };

const thDate = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/);
  if (!m) return s || '-';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const text = d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
  return m[4] ? `${text} ${m[4]}:${m[5]}` : text;
};

export default function EmployeeMovements({ branches = [], onClose }) {
  const [tab, setTab] = useState('in');
  const [start, setStart] = useState(ymd(monthStart()));
  const [end, setEnd] = useState(ymd(new Date()));
  const [branch, setBranch] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notReady, setNotReady] = useState(false);

  const load = async (s = start, e = end, b = branch) => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ view: 'movements', start: s, end: e, branch: b });
      const r = await fetch(`/api/employee-hr?${qs}`, { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.status !== 'success') throw new Error([j?.message || `HTTP ${r.status}`, j?.hint].filter(Boolean).join(' — '));
      setRows(j.data || []);
      setNotReady(j.ready === false);
    } catch (err) {
      setError(err.message || 'โหลดข้อมูลไม่สำเร็จ');
      setRows([]);
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const quick = (offset) => {
    const s = ymd(monthStart(offset));
    const e = offset === 0 ? ymd(new Date()) : ymd(monthEnd(offset));
    setStart(s); setEnd(e); load(s, e, branch);
  };

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => (rows || []).filter((r) => !q
    || r.hrCode.toLowerCase().includes(q) || r.fullName.toLowerCase().includes(q)), [rows, q]);
  const ins = filtered.filter((r) => r.kind === 'in');
  const outs = filtered.filter((r) => r.kind === 'out');
  const shown = tab === 'in' ? ins : outs;

  const topReason = useMemo(() => {
    const count = {};
    outs.forEach((r) => { if (r.reason) count[r.reason] = (count[r.reason] || 0) + 1; });
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    return best ? `${best[0]} (${best[1]})` : '-';
  }, [outs]);

  const download = async () => {
    const XLSX = await import('xlsx');
    const inSheet = XLSX.utils.json_to_sheet(ins.map((r) => ({
      'บันทึกเมื่อ': r.recordedAt, 'รหัส HR': r.hrCode, 'ชื่อ - นามสกุล': r.fullName, 'สาขา': r.branch.toUpperCase(),
      'ประเภท': r.empType, 'ตำแหน่ง': r.position, 'วันเริ่มงาน': r.startDate, 'สัญชาติ': r.nationality, 'ผู้บันทึก': r.recordedBy,
    })));
    const outSheet = XLSX.utils.json_to_sheet(outs.map((r) => ({
      'บันทึกเมื่อ': r.recordedAt, 'รหัส HR': r.hrCode, 'ชื่อ - นามสกุล': r.fullName, 'สาขา': r.branch.toUpperCase(),
      'ประเภท': r.empType, 'วันเริ่มงาน': r.startDate, 'วันที่ลาออก': r.resignDate, 'สาเหตุ': r.reason,
      'อายุงาน': r.duration, 'ผู้บันทึก': r.recordedBy,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, inSheet, 'พนักงานเข้า');
    XLSX.utils.book_append_sheet(wb, outSheet, 'พนักงานออก');
    XLSX.writeFile(wb, `พนักงานเข้า-ออก_${start}_${end}${branch ? `_${branch.toUpperCase()}` : ''}.xlsx`);
  };

  const inputCls = 'px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <div className="p-2.5 bg-teal-100 text-teal-600 rounded-xl"><ArrowLeftRight className="w-5 h-5" /></div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-slate-800">พนักงานเข้า-ออก</h3>
            <p className="text-sm text-slate-500 flex items-center gap-2">
              ประวัติการรับเข้าและแจ้งลาออกจากทุกสาขา
              <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 rounded-md px-2 py-0.5 text-xs font-semibold"><Eye className="w-3 h-3" /> ดูอย่างเดียว</span>
            </p>
          </div>
          <button onClick={onClose} aria-label="ปิด" className="ml-auto p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 pt-4 flex flex-wrap items-center gap-2">
          <button onClick={() => setTab('in')} className={`px-4 py-2 rounded-xl text-sm font-bold ${tab === 'in' ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>พนักงานเข้า {rows ? ins.length : ''}</button>
          <button onClick={() => setTab('out')} className={`px-4 py-2 rounded-xl text-sm font-bold ${tab === 'out' ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>พนักงานออก {rows ? outs.length : ''}</button>
        </div>

        <div className="px-6 py-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">ช่วงวันที่บันทึก</span>
          <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} className={inputCls} />
          <span className="text-slate-400">ถึง</span>
          <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
          <select value={branch} onChange={(e) => setBranch(e.target.value)} className={inputCls}>
            <option value="">ทุกสาขา</option>
            {branches.map((b) => <option key={b} value={b}>{b.toUpperCase()}</option>)}
          </select>
          <button onClick={() => load()} disabled={loading} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} ดึงข้อมูล
          </button>
          <button onClick={() => quick(0)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">เดือนนี้</button>
          <button onClick={() => quick(-1)} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">เดือนก่อน</button>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อ/รหัส…" className={`${inputCls} md:ml-auto w-48`} />
        </div>

        <div className="px-6 grid grid-cols-2 md:grid-cols-4 gap-2.5">
          <div className="border border-slate-200 rounded-xl px-4 py-2.5"><p className="text-xs font-semibold text-slate-500">เข้า (ช่วงนี้)</p><p><b className="text-2xl text-teal-600">{ins.length}</b> คน</p></div>
          <div className="border border-slate-200 rounded-xl px-4 py-2.5"><p className="text-xs font-semibold text-slate-500">ออก (ช่วงนี้)</p><p><b className="text-2xl text-rose-600">{outs.length}</b> คน</p></div>
          <div className="border border-slate-200 rounded-xl px-4 py-2.5"><p className="text-xs font-semibold text-slate-500">สุทธิ</p><p><b className="text-2xl">{ins.length - outs.length > 0 ? '+' : ''}{ins.length - outs.length}</b> คน</p></div>
          <div className="border border-slate-200 rounded-xl px-4 py-2.5"><p className="text-xs font-semibold text-slate-500">สาเหตุออกบ่อยสุด</p><p className="font-bold text-slate-800 truncate pt-1">{topReason}</p></div>
        </div>

        <div className="flex-1 overflow-auto mt-3 border-t border-slate-100">
          {loading ? (
            <div className="py-16 flex flex-col items-center text-slate-500"><Loader2 className="w-8 h-8 animate-spin text-teal-500 mb-2" />กำลังโหลด...</div>
          ) : error ? (
            <div className="m-6 p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-start gap-2"><AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />{error}</div>
          ) : notReady ? (
            <div className="py-16 px-6 text-center text-sm text-amber-700">ยังไม่ได้สร้างตารางประวัติ — ให้รัน update-office-server.bat บนเครื่องออฟฟิศก่อน</div>
          ) : shown.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-400">ไม่มี{tab === 'in' ? 'พนักงานเข้า' : 'พนักงานออก'}ในช่วงวันที่เลือก</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  {(tab === 'in'
                    ? ['บันทึกเมื่อ', 'รหัส HR', 'ชื่อ - นามสกุล', 'สาขา', 'ประเภท', 'ตำแหน่ง', 'วันเริ่มงาน', 'สัญชาติ', 'ผู้บันทึก']
                    : ['บันทึกเมื่อ', 'รหัส HR', 'ชื่อ - นามสกุล', 'สาขา', 'ประเภท', 'วันเริ่มงาน', 'วันที่ลาออก', 'สาเหตุ', 'อายุงาน', 'ผู้บันทึก']
                  ).map((h) => <th key={h} className="px-3 py-2.5 text-left font-semibold sticky top-0 bg-slate-50 border-b border-slate-200 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-600">
                {shown.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 whitespace-nowrap">{thDate(r.recordedAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold text-purple-600">{r.hrCode || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold text-slate-900">{r.fullName || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold text-indigo-600">{r.branch.toUpperCase() || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.empType || '-'}</td>
                    {tab === 'in' ? (
                      <>
                        <td className="px-3 py-2 whitespace-nowrap">{r.position || '-'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{thDate(r.startDate)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.nationality || '-'}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 whitespace-nowrap">{thDate(r.startDate)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{thDate(r.resignDate)}</td>
                        <td className="px-3 py-2 min-w-[10rem]">{r.reason || '-'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.duration || '-'}</td>
                      </>
                    )}
                    <td className="px-3 py-2 whitespace-nowrap">{r.recordedBy || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <span>ข้อมูลจาก SQL · รวมประวัติเก่าที่นำเข้าจากชีท "พนักงานเข้า" / "พนักงานออก"</span>
          <div className="flex gap-2">
            <button onClick={download} disabled={!rows || filtered.length === 0} className="inline-flex items-center gap-1.5 px-4 py-2 bg-white text-slate-600 border border-slate-200 rounded-xl text-sm font-semibold hover:bg-slate-100 disabled:opacity-50"><Download className="w-4 h-4" /> ดาวน์โหลด Excel</button>
            <button onClick={onClose} className="px-4 py-2 bg-white text-slate-600 border border-slate-200 rounded-xl text-sm font-semibold hover:bg-slate-100">ปิด</button>
          </div>
        </div>
      </div>
    </div>
  );
}
