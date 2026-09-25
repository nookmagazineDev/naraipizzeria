import { useState, useEffect, useMemo, useCallback } from 'react';
import { ShoppingBag, Search, Loader2, AlertCircle, Download, RefreshCw, Database, Info } from 'lucide-react';
import { toast } from 'react-hot-toast';
import * as XLSX from 'xlsx-js-style';

/*
 * NARAI OFFICE — HR → ยูนิฟอร์ม
 *
 * รายงานสรุปยูนิฟอร์มของสาขา จากตาราง dbo.UniformBranch (ฐาน InventoryNarai) ผ่าน /api/uniform-branch
 * ซึ่งไปได้ทั้งทางต่อ SQL ตรง และ host API ที่เครื่องออฟฟิศ (เลือกให้เอง ดู lib/sheetsSource.js)
 *
 * ตารางนี้ไม่ได้สร้างจากรีโปนี้ — API ส่งแถวมาครบทุกคอลัมน์พร้อมบอกว่าคอลัมน์ไหนน่าจะเป็น
 * สาขา/รายการ/ไซส์/จำนวน/มูลค่า/วันที่ (layout.fields) หน้านี้ใช้เป็นค่าเริ่มต้น แล้วให้เปลี่ยนเองได้
 * ชื่อคอลัมน์จริงไม่ตรงกับที่เดา รายงานก็ยังใช้ได้ แค่เลือกคอลัมน์ใหม่จาก dropdown
 *
 * สามส่วน:
 *   1) สรุปตามกลุ่มหลัก (ค่าเริ่มต้น = สาขา) — จำนวนแถว · รวมจำนวน · รวมมูลค่า · สัดส่วน
 *   2) ตารางไขว้ กลุ่มหลัก × กลุ่มย่อย (ค่าเริ่มต้น = รายการยูนิฟอร์ม) รวมจำนวน
 *   3) ข้อมูลดิบทุกคอลัมน์ (หลังกรอง)
 */

const COUNT_ROWS = '__rows__';   // "รวมจำนวน" แบบนับแถว — ใช้เมื่อตารางไม่มีคอลัมน์จำนวน
const NONE = '';
const PIVOT_MAX_COLS = 30;       // กลุ่มย่อยเกินนี้รวมเป็น "อื่น ๆ" ตารางจะได้ไม่กว้างจนอ่านไม่ได้
const RAW_PAGE = 200;

const fmt0 = (v) => (Number(v) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const fmt2 = (v) => (Number(v) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ค่าในช่อง -> ตัวเลข (ข้อความที่มีจุลภาคก็แปลงได้) ; แปลงไม่ได้ = 0 */
const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const label = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || '(ไม่ระบุ)';
};

const thaiSort = (a, b) => String(a).localeCompare(String(b), 'th', { numeric: true });

function Select({ label: text, value, onChange, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-gray-500">
      {text}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="border border-gray-200 rounded-xl px-3 py-2 bg-white text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-amber-500 min-w-[10rem]">
        {children}
      </select>
    </label>
  );
}

function StatCard({ title, value, sub }) {
  return (
    <div className="bg-white rounded-2xl border border-amber-100 shadow-sm px-4 py-3">
      <div className="text-xs text-gray-500">{title}</div>
      <div className="text-2xl font-bold text-gray-800 mt-1">{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function UniformReport() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ตัวเลือกจัดกลุ่ม/รวมยอด — ตั้งค่าเริ่มต้นจาก layout.fields ตอนโหลดเสร็จ
  const [groupCol, setGroupCol] = useState(NONE);
  const [breakCol, setBreakCol] = useState(NONE);
  const [qtyCol, setQtyCol] = useState(COUNT_ROWS);
  const [valueCol, setValueCol] = useState(NONE);

  // ตัวกรอง
  const [groupFilter, setGroupFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [search, setSearch] = useState('');
  const [rawShown, setRawShown] = useState(RAW_PAGE);

  const load = useCallback(async (limit) => {
    setLoading(true);
    setError('');
    try {
      const qs = limit ? `?limit=${limit}` : '';
      const res = await fetch(`/api/uniform-branch${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status !== 'success') throw new Error(json.message || `HTTP ${res.status}`);
      const d = json.data;
      setData(d);

      const f = d.layout?.fields || {};
      const cols = d.layout?.columns || [];
      const firstText = cols.find((c) => c.kind === 'text')?.name || NONE;
      setGroupCol(f.branch || firstText);
      setBreakCol(f.item || (f.size && f.size !== f.branch ? f.size : NONE));
      setQtyCol(f.qty || COUNT_ROWS);
      setValueCol(f.total || NONE);
      setGroupFilter('all');
      setRawShown(RAW_PAGE);
    } catch (err) {
      setError(err.message || String(err));
      toast.error('โหลดข้อมูลยูนิฟอร์มไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const columns = data?.layout?.columns || [];
  const fields = data?.layout?.fields || {};
  // host-server ที่เครื่องออฟฟิศอาจยังเป็นเวอร์ชันที่จับคอลัมน์วันที่ไม่ได้ — ถอยไปใช้คอลัมน์ชนิดวันที่ตัวแรก
  const dateCol = fields.date || columns.find((c) => c.kind === 'date')?.name || NONE;
  const numericCols = columns.filter((c) => c.kind === 'number');

  /* ---- กรองแถว ---- */
  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (groupCol && groupFilter !== 'all' && label(r[groupCol]) !== groupFilter) return false;
      if (dateCol && (startDate || endDate)) {
        const d = String(r[dateCol] ?? '').slice(0, 10);
        if (!d) return false;
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
      }
      if (needle) {
        const hit = Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(needle));
        if (!hit) return false;
      }
      return true;
    });
  }, [data, groupCol, groupFilter, dateCol, startDate, endDate, search]);

  const qtyOf = useCallback((r) => (qtyCol === COUNT_ROWS ? 1 : toNum(r[qtyCol])), [qtyCol]);
  const valueOf = useCallback((r) => (valueCol ? toNum(r[valueCol]) : 0), [valueCol]);

  /* ---- ค่าทั้งหมดของกลุ่มหลัก (ไว้เติม dropdown กรอง) ---- */
  const groupValues = useMemo(() => {
    if (!data || !groupCol) return [];
    return [...new Set(data.rows.map((r) => label(r[groupCol])))].sort(thaiSort);
  }, [data, groupCol]);

  /* ---- สรุปตามกลุ่มหลัก ---- */
  const summary = useMemo(() => {
    const map = new Map();
    filtered.forEach((r) => {
      const k = groupCol ? label(r[groupCol]) : 'ทั้งหมด';
      const s = map.get(k) || { key: k, rows: 0, qty: 0, value: 0 };
      s.rows += 1;
      s.qty += qtyOf(r);
      s.value += valueOf(r);
      map.set(k, s);
    });
    const list = [...map.values()].sort((a, b) => b.qty - a.qty || thaiSort(a.key, b.key));
    const totals = list.reduce((t, s) => ({ rows: t.rows + s.rows, qty: t.qty + s.qty, value: t.value + s.value }),
      { rows: 0, qty: 0, value: 0 });
    return { list, totals };
  }, [filtered, groupCol, qtyOf, valueOf]);

  /* ---- ตารางไขว้ กลุ่มหลัก × กลุ่มย่อย ---- */
  const pivot = useMemo(() => {
    if (!breakCol || breakCol === groupCol) return null;
    const colTotals = new Map();
    filtered.forEach((r) => {
      const c = label(r[breakCol]);
      colTotals.set(c, (colTotals.get(c) || 0) + qtyOf(r));
    });
    const ranked = [...colTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const kept = ranked.slice(0, PIVOT_MAX_COLS).sort(thaiSort);
    const keptSet = new Set(kept);
    const hasOther = ranked.length > PIVOT_MAX_COLS;
    const cols = hasOther ? [...kept, 'อื่น ๆ'] : kept;

    const rows = new Map();
    filtered.forEach((r) => {
      const g = groupCol ? label(r[groupCol]) : 'ทั้งหมด';
      const raw = label(r[breakCol]);
      const c = keptSet.has(raw) ? raw : 'อื่น ๆ';
      const row = rows.get(g) || { key: g, cells: {}, total: 0 };
      row.cells[c] = (row.cells[c] || 0) + qtyOf(r);
      row.total += qtyOf(r);
      rows.set(g, row);
    });
    const list = [...rows.values()].sort((a, b) => thaiSort(a.key, b.key));
    const footer = {};
    cols.forEach((c) => { footer[c] = list.reduce((s, row) => s + (row.cells[c] || 0), 0); });
    return { cols, list, footer, total: list.reduce((s, row) => s + row.total, 0) };
  }, [filtered, groupCol, breakCol, qtyOf]);

  const colName = (name) => name || '-';
  const qtyLabel = qtyCol === COUNT_ROWS ? 'จำนวน (นับแถว)' : `จำนวน (${qtyCol})`;

  /* ---- ส่งออก Excel ---- */
  const exportExcel = () => {
    if (!data) return;
    const bold = { font: { bold: true }, fill: { fgColor: { rgb: 'FEF3C7' } } };
    const styleHeader = (ws, n) => {
      for (let c = 0; c < n; c += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
        if (cell) cell.s = bold;
      }
    };
    const wb = XLSX.utils.book_new();

    const sumAoa = [[colName(groupCol), 'จำนวนแถว', qtyLabel, ...(valueCol ? [`มูลค่า (${valueCol})`] : []), 'สัดส่วน %']];
    summary.list.forEach((s) => sumAoa.push([
      s.key, s.rows, s.qty, ...(valueCol ? [s.value] : []),
      summary.totals.qty ? Math.round((s.qty / summary.totals.qty) * 10000) / 100 : 0,
    ]));
    sumAoa.push(['รวม', summary.totals.rows, summary.totals.qty, ...(valueCol ? [summary.totals.value] : []), 100]);
    const wsSum = XLSX.utils.aoa_to_sheet(sumAoa);
    styleHeader(wsSum, sumAoa[0].length);
    XLSX.utils.book_append_sheet(wb, wsSum, 'สรุป');

    if (pivot) {
      const pAoa = [[`${colName(groupCol)} \\ ${breakCol}`, ...pivot.cols, 'รวม']];
      pivot.list.forEach((row) => pAoa.push([row.key, ...pivot.cols.map((c) => row.cells[c] || 0), row.total]));
      pAoa.push(['รวม', ...pivot.cols.map((c) => pivot.footer[c] || 0), pivot.total]);
      const wsP = XLSX.utils.aoa_to_sheet(pAoa);
      styleHeader(wsP, pAoa[0].length);
      XLSX.utils.book_append_sheet(wb, wsP, 'ตารางไขว้');
    }

    const names = columns.map((c) => c.name);
    const rawAoa = [names, ...filtered.map((r) => names.map((n) => r[n] ?? ''))];
    const wsRaw = XLSX.utils.aoa_to_sheet(rawAoa);
    styleHeader(wsRaw, names.length);
    XLSX.utils.book_append_sheet(wb, wsRaw, 'ข้อมูลดิบ');

    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `uniform_branch_${today}.xlsx`);
  };

  /* ------------------------------ หน้าจอ ------------------------------ */

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500 gap-2">
        <Loader2 className="animate-spin" size={20} /> กำลังโหลดข้อมูลยูนิฟอร์ม…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-sm text-red-700">
        <div className="flex items-center gap-2 font-semibold mb-2"><AlertCircle size={18} /> โหลดข้อมูลไม่สำเร็จ</div>
        <pre className="whitespace-pre-wrap font-sans">{error}</pre>
        <button onClick={() => load()} className="mt-4 px-4 py-2 bg-white border border-red-200 rounded-xl hover:bg-red-100 flex items-center gap-2">
          <RefreshCw size={14} /> ลองใหม่
        </button>
      </div>
    );
  }

  const branchCount = groupCol ? summary.list.length : 0;
  const rawRows = filtered.slice(0, rawShown);

  return (
    <div className="space-y-5">
      {/* หัว + ปุ่ม */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-100 text-amber-600 rounded-xl"><ShoppingBag size={20} /></div>
          <div>
            <div className="font-semibold text-gray-800">รายงานสรุปยูนิฟอร์มของสาขา</div>
            <div className="text-xs text-gray-500 flex items-center gap-1">
              <Database size={12} /> {data.layout?.table} · {data.source}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => load(data.limit)} disabled={loading}
            className="px-4 py-2 bg-white border border-amber-200 text-amber-700 text-sm rounded-xl hover:bg-amber-50 flex items-center gap-2 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} โหลดใหม่
          </button>
          <button onClick={exportExcel} disabled={!filtered.length}
            className="px-4 py-2 bg-amber-600 text-white text-sm rounded-xl hover:bg-amber-700 flex items-center gap-2 disabled:opacity-50">
            <Download size={14} /> ส่งออก Excel
          </button>
        </div>
      </div>

      {data.truncated && (
        <div className="px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center justify-between gap-2">
          <span>ตารางมี {fmt0(data.total)} แถว แสดง {fmt0(data.rows.length)} แถวล่าสุดเท่านั้น</span>
          {data.limit < 50000 && (
            <button onClick={() => load(50000)} className="underline font-medium">โหลดเพิ่มถึง 50,000 แถว</button>
          )}
        </div>
      )}

      {/* ตัวเลือกจัดกลุ่ม/รวมยอด + ตัวกรอง */}
      <div className="bg-white rounded-2xl border border-amber-100 shadow-sm p-4 space-y-4">
        <div className="flex flex-wrap gap-3">
          <Select label="จัดกลุ่มหลักตาม" value={groupCol} onChange={(v) => { setGroupCol(v); setGroupFilter('all'); }}>
            <option value={NONE}>— ไม่จัดกลุ่ม —</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </Select>
          <Select label="แยกย่อยตาม (ตารางไขว้)" value={breakCol} onChange={setBreakCol}>
            <option value={NONE}>— ไม่แยก —</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </Select>
          <Select label="รวมจำนวนจาก" value={qtyCol} onChange={setQtyCol}>
            <option value={COUNT_ROWS}>นับจำนวนแถว</option>
            {numericCols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </Select>
          <Select label="รวมมูลค่าจาก" value={valueCol} onChange={setValueCol}>
            <option value={NONE}>— ไม่รวมมูลค่า —</option>
            {numericCols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          {groupCol && (
            <Select label={`กรอง ${groupCol}`} value={groupFilter} onChange={setGroupFilter}>
              <option value="all">ทั้งหมด</option>
              {groupValues.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          )}
          {dateCol && (
            <>
              <label className="flex flex-col gap-1 text-xs text-gray-500">
                ตั้งแต่วันที่ ({dateCol})
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-500">
                ถึงวันที่
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700" />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-xs text-gray-500 flex-1 min-w-[12rem]">
            ค้นหา
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={(e) => { setSearch(e.target.value); setRawShown(RAW_PAGE); }}
                placeholder="ค้นหาทุกคอลัมน์ เช่น ชื่อพนักงาน ไซส์ รายการ"
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-amber-500" />
            </div>
          </label>
        </div>
      </div>

      {/* ตัวเลขรวม */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard title="จำนวนรายการ (แถว)" value={fmt0(summary.totals.rows)} sub={`จากทั้งหมด ${fmt0(data.rows.length)} แถว`} />
        <StatCard title={qtyLabel} value={fmt0(summary.totals.qty)} />
        <StatCard title={valueCol ? `มูลค่ารวม (${valueCol})` : 'มูลค่ารวม'} value={valueCol ? fmt2(summary.totals.value) : '-'}
          sub={valueCol ? 'บาท' : 'เลือกคอลัมน์มูลค่าด้านบน'} />
        <StatCard title={groupCol ? `จำนวน ${groupCol}` : 'กลุ่ม'} value={groupCol ? fmt0(branchCount) : '-'} />
      </div>

      {/* 1) สรุปตามกลุ่มหลัก */}
      <div className="bg-white rounded-2xl shadow-sm border border-amber-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700">
          สรุปตาม {groupCol || 'ทั้งหมด'}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">{groupCol || 'กลุ่ม'}</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">จำนวนแถว</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-emerald-600 bg-emerald-50/60">{qtyLabel}</th>
                {valueCol && <th className="px-4 py-3 text-right text-xs font-semibold text-amber-600 bg-amber-50/60">มูลค่า</th>}
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 w-1/4">สัดส่วน</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summary.list.map((s) => {
                const pct = summary.totals.qty ? (s.qty / summary.totals.qty) * 100 : 0;
                return (
                  <tr key={s.key} className="hover:bg-amber-50/40 cursor-pointer"
                    onClick={() => groupCol && setGroupFilter(groupFilter === s.key ? 'all' : s.key)}
                    title={groupCol ? 'กดเพื่อกรองเฉพาะกลุ่มนี้ (กดซ้ำเพื่อยกเลิก)' : undefined}>
                    <td className="px-4 py-2 font-medium text-gray-800">{s.key}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{fmt0(s.rows)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-emerald-700 bg-emerald-50/30">{fmt0(s.qty)}</td>
                    {valueCol && <td className="px-4 py-2 text-right text-amber-700 bg-amber-50/30">{fmt2(s.value)}</td>}
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-400" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-gray-500 w-12 text-right">{pct.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!summary.list.length && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">ไม่มีข้อมูลตามตัวกรองที่เลือก</td></tr>
              )}
            </tbody>
            {summary.list.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold">
                <tr>
                  <td className="px-4 py-2">รวม</td>
                  <td className="px-4 py-2 text-right">{fmt0(summary.totals.rows)}</td>
                  <td className="px-4 py-2 text-right text-emerald-700">{fmt0(summary.totals.qty)}</td>
                  {valueCol && <td className="px-4 py-2 text-right text-amber-700">{fmt2(summary.totals.value)}</td>}
                  <td className="px-4 py-2" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* 2) ตารางไขว้ */}
      {pivot && (
        <div className="bg-white rounded-2xl shadow-sm border border-amber-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700">
            {groupCol || 'ทั้งหมด'} × {breakCol} <span className="text-xs font-normal text-gray-400">({qtyLabel})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 sticky left-0 bg-gray-50">{groupCol || 'กลุ่ม'}</th>
                  {pivot.cols.map((c) => <th key={c} className="px-3 py-2 text-right text-xs font-semibold text-gray-500 whitespace-nowrap">{c}</th>)}
                  <th className="px-3 py-2 text-right text-xs font-semibold text-emerald-600 bg-emerald-50/60">รวม</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pivot.list.map((row) => (
                  <tr key={row.key} className="hover:bg-amber-50/40">
                    <td className="px-3 py-2 font-medium text-gray-800 sticky left-0 bg-white whitespace-nowrap">{row.key}</td>
                    {pivot.cols.map((c) => (
                      <td key={c} className={`px-3 py-2 text-right ${row.cells[c] ? 'text-gray-700' : 'text-gray-300'}`}>
                        {row.cells[c] ? fmt0(row.cells[c]) : '-'}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-semibold text-emerald-700 bg-emerald-50/30">{fmt0(row.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 font-semibold">
                <tr>
                  <td className="px-3 py-2 sticky left-0 bg-gray-50">รวม</td>
                  {pivot.cols.map((c) => <td key={c} className="px-3 py-2 text-right">{fmt0(pivot.footer[c])}</td>)}
                  <td className="px-3 py-2 text-right text-emerald-700">{fmt0(pivot.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* 3) ข้อมูลดิบ */}
      <div className="bg-white rounded-2xl shadow-sm border border-amber-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 flex justify-between">
          <span>ข้อมูลดิบ</span>
          <span className="text-xs font-normal text-gray-400">{fmt0(filtered.length)} แถว</span>
        </div>
        <div className="overflow-x-auto max-h-[32rem]">
          <table className="min-w-full divide-y divide-gray-200 text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {columns.map((c) => (
                  <th key={c.name} className={`px-3 py-2 font-semibold text-gray-500 whitespace-nowrap ${c.kind === 'number' ? 'text-right' : 'text-left'}`}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rawRows.map((r, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <tr key={i} className="hover:bg-amber-50/40">
                  {columns.map((c) => (
                    <td key={c.name} className={`px-3 py-1.5 whitespace-nowrap text-gray-700 ${c.kind === 'number' ? 'text-right' : ''}`}>
                      {r[c.name] === null || r[c.name] === undefined || r[c.name] === '' ? '-' : String(r[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > rawShown && (
          <div className="px-4 py-3 border-t border-gray-100 text-center">
            <button onClick={() => setRawShown((n) => n + RAW_PAGE)} className="text-sm text-amber-700 hover:underline">
              แสดงเพิ่มอีก {RAW_PAGE} แถว ({fmt0(filtered.length - rawShown)} แถวที่เหลือ)
            </button>
          </div>
        )}
      </div>

      <details className="bg-white border border-gray-100 rounded-xl p-4 text-xs text-gray-500">
        <summary className="cursor-pointer flex items-center gap-1"><Info size={12} /> คอลัมน์ในตาราง {data.layout?.table}</summary>
        <div className="mt-2 space-y-1">
          <div>คอลัมน์: {columns.map((c) => `${c.name} (${c.type})`).join(', ')}</div>
          <div>
            จับคู่อัตโนมัติ: {Object.entries(fields).map(([k, v]) => `${k} = ${v}`).join(' · ') || 'ไม่พบชื่อที่รู้จัก'}
          </div>
          {data.layout?.skipped?.length > 0 && <div>ไม่ได้แสดง (ชนิดข้อมูลไบนารี): {data.layout.skipped.join(', ')}</div>}
          <div>ชื่อคอลัมน์ไม่ตรงกับที่เดา — เลือกใหม่ได้จาก dropdown ด้านบน หรือเพิ่มชื่อลงใน UNIFORM_COLUMNS ที่ lib/uniformSql.mjs</div>
        </div>
      </details>
    </div>
  );
}
