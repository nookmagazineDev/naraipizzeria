import React, { useState, useEffect, useMemo } from 'react';
import { PackageOpen, Search, Loader2, AlertCircle, Download, Info, ImageOff, Calendar } from 'lucide-react';
import * as XLSX from 'xlsx-js-style';

/*
 * จัดซื้อ — เบิกของสาขา: อ่านชีท "ใบเบิก" + "data" ผ่าน /api/branch-requisition
 * API ส่งแถวดิบ (logs) มา — หน้านี้กรองตามเดือนที่เลือกแล้วค่อย pivot (แถว=ไอเทม, คอลัมน์=สาขา, ช่อง=จำนวนรวม)
 */

const fmtNum = v => (v === null || v === undefined || v === 0 || isNaN(v)) ? '' : Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const fmtMoney = v => (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HEAD_STYLE = {
  font: { name: 'Tahoma', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '0E7490' } }, // cyan-700
};

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

// timestamp ในชีทใบเบิก: "DD/MM/YYYY HH:MM:SS" — ดึงคีย์เดือน "YYYY-MM" ไว้กรอง/จัดกลุ่ม
const monthKeyOf = timestamp => {
  const [datePart] = String(timestamp || '').split(' ');
  const [d, m, y] = (datePart || '').split('/');
  if (!d || !m || !y) return '';
  return `${y}-${m.padStart(2, '0')}`;
};
const monthLabel = key => {
  const [y, m] = key.split('-');
  const mi = parseInt(m, 10) - 1;
  return `${THAI_MONTHS[mi] || m} ${y}`;
};

function ItemImage({ src, alt }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-300 flex-shrink-0">
        <ImageOff size={14} />
      </div>
    );
  }
  return (
    <img src={src} alt={alt} onError={() => setBroken(true)}
      className="w-9 h-9 rounded-lg object-cover border border-slate-100 flex-shrink-0" />
  );
}

export default function BranchRequisition() {
  const [branches, setBranches] = useState([]);
  const [logs, setLogs] = useState([]);
  const [itemInfo, setItemInfo] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState(''); // '' = ทุกเดือน, ไม่งั้น 'YYYY-MM'

  const load = () => {
    setLoading(true);
    fetch('/api/branch-requisition')
      .then(r => r.json())
      .then(res => {
        if (res.status === 'success') {
          setBranches(res.data?.branches || []);
          setLogs(res.data?.logs || []);
          setItemInfo(res.data?.itemInfo || {});
          setError('');
        } else setError(res.message || 'โหลดข้อมูลไม่สำเร็จ');
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // เดือนที่มีข้อมูลจริงในชีทใบเบิก เรียงล่าสุดก่อน
  const months = useMemo(() => {
    const set = new Set(logs.map(r => monthKeyOf(r.timestamp)).filter(Boolean));
    return [...set].sort().reverse();
  }, [logs]);

  const emptyInfo = { code: '', oldCode: '', unit: '', image: '', price: null, remainNew: '', remainOld: '', supplier: '' };

  // pivot ไอเทม × สาขา จาก log ที่กรองเดือนแล้ว — คำนวณสดทุกครั้งที่เปลี่ยนตัวกรองเดือน
  const items = useMemo(() => {
    const rows = monthFilter ? logs.filter(r => monthKeyOf(r.timestamp) === monthFilter) : logs;
    const map = {};
    rows.forEach(r => {
      if (!map[r.itemName]) {
        map[r.itemName] = {
          itemName: r.itemName,
          ...(itemInfo[r.itemName] || emptyInfo),
          total: 0,
          qtyByBranch: {},
          lastRequested: '',
        };
      }
      const it = map[r.itemName];
      it.total += r.qty;
      it.qtyByBranch[r.branch] = (it.qtyByBranch[r.branch] || 0) + r.qty;
      if (r.timestamp > it.lastRequested) it.lastRequested = r.timestamp;
    });
    return Object.values(map).sort((a, b) => a.itemName.localeCompare(b.itemName, 'th'));
  }, [logs, itemInfo, monthFilter]);

  const visibleBranches = useMemo(
    () => branchFilter ? branches.filter(b => b === branchFilter) : branches,
    [branches, branchFilter]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = items;
    if (branchFilter) list = list.filter(x => (x.qtyByBranch[branchFilter] || 0) > 0);
    if (!q) return list;
    return list.filter(x => x.itemName.toLowerCase().includes(q) || x.code.toLowerCase().includes(q));
  }, [items, search, branchFilter]);

  const grandTotal = useMemo(
    () => filtered.reduce((s, x) => s + (branchFilter ? (x.qtyByBranch[branchFilter] || 0) : x.total), 0),
    [filtered, branchFilter]
  );

  const branchTotals = useMemo(() => {
    const t = {};
    visibleBranches.forEach(b => { t[b] = filtered.reduce((s, x) => s + (x.qtyByBranch[b] || 0), 0); });
    return t;
  }, [filtered, visibleBranches]);

  const exportExcel = () => {
    if (!filtered.length) return;
    const wb = XLSX.utils.book_new();
    const head = ['รหัส', 'ชื่อ', 'หน่วย', 'ราคา', 'คงเหลือใหม่', 'คงเหลือเก่า', 'ซัพ', ...visibleBranches, 'รวม'];
    const aoa = [head];
    filtered.forEach(x => aoa.push([
      x.code, x.itemName, x.unit, x.price ?? '', x.remainNew, x.remainOld, x.supplier,
      ...visibleBranches.map(b => x.qtyByBranch[b] || 0),
      branchFilter ? (x.qtyByBranch[branchFilter] || 0) : x.total,
    ]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
      ...visibleBranches.map(() => ({ wch: 8 })), { wch: 10 }];
    for (let cIdx = 0; cIdx < head.length; cIdx++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c: cIdx })];
      if (cell) cell.s = HEAD_STYLE;
    }
    XLSX.utils.book_append_sheet(wb, ws, 'เบิกของสาขา');
    const suffix = monthFilter || new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `branch_requisition_${suffix}.xlsx`);
  };

  return (
    <div className="max-w-full mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-cyan-100 text-cyan-700 rounded-xl"><PackageOpen className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">เบิกของสาขา</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {filtered.length.toLocaleString()} รายการ · จำนวนเบิกรวม {fmtNum(grandTotal) || 0}
                {branchFilter && <span className="ml-1.5 text-cyan-600 font-semibold">· เฉพาะสาขา {branchFilter}</span>}
                {monthFilter && <span className="ml-1.5 text-cyan-600 font-semibold">· เดือน{monthLabel(monthFilter)}</span>}
              </p>
            </div>
          </div>
          <button onClick={exportExcel} disabled={loading || !filtered.length}
            className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
            <Download size={14} /> Export Excel
          </button>
        </div>

        <div className="p-4 flex flex-wrap gap-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อสินค้า…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500">
            <option value="">ทุกสาขา ({branches.length})</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <div className="flex items-center gap-2 bg-cyan-50/60 border border-cyan-100 rounded-xl px-3 py-1.5">
            <Calendar size={14} className="text-cyan-600 flex-shrink-0" />
            <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)}
              className="border-0 bg-transparent text-xs font-semibold text-cyan-700 focus:outline-none">
              <option value="">ทุกเดือน</option>
              {months.map(mk => <option key={mk} value={mk}>{monthLabel(mk)}</option>)}
            </select>
          </div>
        </div>

        {error && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-center gap-2">
            <AlertCircle size={16} /><span>{error}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-3 py-3 text-left">รูป</th>
                <th className="px-3 py-3 text-left">รหัส</th>
                <th className="px-4 py-3 text-left">ชื่อ</th>
                <th className="px-3 py-3 text-center">หน่วย</th>
                <th className="px-3 py-3 text-right">ราคา</th>
                <th className="px-3 py-3 text-right">คงเหลือใหม่</th>
                <th className="px-3 py-3 text-right">คงเหลือเก่า</th>
                <th className="px-3 py-3 text-left">ซัพ</th>
                {visibleBranches.map(b => (
                  <th key={b} className="px-3 py-3 text-center whitespace-nowrap">{b}</th>
                ))}
                <th className="px-4 py-3 text-right">รวม</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={9 + visibleBranches.length} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดข้อมูล…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9 + visibleBranches.length} className="px-4 py-10 text-center text-slate-400">ไม่พบรายการ</td></tr>
              ) : filtered.map(x => (
                <tr key={x.itemName} className="hover:bg-cyan-50/50 transition-colors">
                  <td className="px-3 py-2"><ItemImage src={x.image} alt={x.itemName} /></td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{x.code || '—'}</td>
                  <td className="px-4 py-2 text-slate-800 font-medium">{x.itemName}</td>
                  <td className="px-3 py-2 text-center text-slate-500 whitespace-nowrap">{x.unit || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{fmtMoney(x.price)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">{x.remainNew || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{x.remainOld || '—'}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{x.supplier || '—'}</td>
                  {visibleBranches.map(b => (
                    <td key={b} className="px-3 py-2 text-center font-mono">
                      {x.qtyByBranch[b] ? (
                        <span className="inline-block px-2 py-0.5 bg-cyan-50 text-cyan-700 rounded-full font-semibold">{fmtNum(x.qtyByBranch[b])}</span>
                      ) : <span className="text-slate-200">—</span>}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right font-mono font-bold text-slate-800">
                    {fmtNum(branchFilter ? (x.qtyByBranch[branchFilter] || 0) : x.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            {!loading && filtered.length > 0 && (
              <tfoot className="bg-slate-50 border-t-2 border-slate-200">
                <tr className="text-xs font-bold text-slate-600">
                  <td colSpan={8} className="px-4 py-2.5 text-right">รวมทั้งหมด</td>
                  {visibleBranches.map(b => (
                    <td key={b} className="px-3 py-2.5 text-center font-mono">{fmtNum(branchTotals[b]) || '—'}</td>
                  ))}
                  <td className="px-4 py-2.5 text-right font-mono text-cyan-700">{fmtNum(grandTotal)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!loading && (
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-400 flex items-center gap-2">
            <Info size={13} />
            ข้อมูลไอเทม (รหัส/หน่วย/รูป/ราคา/คงเหลือ/ซัพ) จากชีท data · จำนวนเบิกต่อสาขา รวมจากชีทใบเบิกทุกแถว
          </div>
        )}
      </div>
    </div>
  );
}
