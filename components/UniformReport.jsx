import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShoppingBag, Store, Building2, ClipboardList, Search, Loader2, AlertCircle, Download, RefreshCw,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import * as XLSX from 'xlsx-js-style';

/*
 * NARAI OFFICE — HR → ยูนิฟอร์ม
 *
 * สามการ์ด กดที่การ์ดเพื่อเปิดรายละเอียดข้างล่าง:
 *   1) คงเหลือในสโตร์   — ยังไม่มีแหล่งข้อมูล (รอระบุตารางสต๊อกยูนิฟอร์มของสโตร์)
 *   2) อยู่ในสาขา        — dbo.UniformBranch (ยูนิฟอร์มที่แจกให้พนักงานแล้ว)
 *                          รายสาขา -> กดสาขา -> รายชื่อพนักงานที่มียูนิฟอร์ม
 *   3) ขอเบิกยูนิฟอร์ม   — dbo.stock_request (ตารางที่หน้า "นับสต๊อกและขอเบิก" ของสาขาเขียนลง)
 *                          รายไอเทม -> กดไอเทม -> ใครเบิก สาขาไหน เท่าไหร่
 *
 * ทั้งสองชุดอ่านผ่าน /api/uniform-branch (ต่อ SQL ตรง หรือ host API ที่เครื่องออฟฟิศ)
 * ชุดไหนอ่านไม่ได้ การ์ดนั้นขึ้นข้อความของตัวเอง อีกการ์ดยังใช้ได้ตามปกติ
 */

const fmt0 = (v) => (Number(v) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());
const thaiSort = (a, b) => String(a).localeCompare(String(b), 'th', { numeric: true });

/** ชื่อคอลัมน์จริงของ UniformBranch — ใช้ที่ API จับคู่ให้ก่อน ไม่มีค่อยลองชื่อที่รู้ว่าตารางใช้ */
function pickCol(layout, field, candidates) {
  const f = layout?.fields?.[field];
  if (f) return f;
  const names = new Set((layout?.columns || []).map((c) => c.name));
  return candidates.find((c) => names.has(c)) || '';
}

async function getJson(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `HTTP ${res.status}`);
  return json.data;
}

function downloadSheet(name, header, rows) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  header.forEach((_, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: 'FEF3C7' } } };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ยูนิฟอร์ม');
  XLSX.writeFile(wb, `${name}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ------------------------------ ชิ้นส่วนหน้าจอ ------------------------------ */

const TONES = {
  slate: { ring: 'ring-slate-400', icon: 'bg-slate-100 text-slate-500', num: 'text-slate-400' },
  amber: { ring: 'ring-amber-500', icon: 'bg-amber-100 text-amber-600', num: 'text-amber-700' },
  sky: { ring: 'ring-sky-500', icon: 'bg-sky-100 text-sky-600', num: 'text-sky-700' },
};

function SummaryCard({ icon: Icon, title, value, unit, sub, tone, active, disabled, loading, error, onClick }) {
  const t = TONES[tone];
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`text-left bg-white rounded-2xl border border-gray-100 shadow-sm p-5 transition
        ${disabled ? 'cursor-not-allowed opacity-70' : 'hover:shadow-md hover:-translate-y-0.5'}
        ${active ? `ring-2 ${t.ring}` : ''}`}>
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-xl ${t.icon}`}><Icon size={22} /></div>
        <div className="font-semibold text-gray-700">{title}</div>
      </div>
      <div className="mt-4 flex items-baseline gap-2 min-h-[2.5rem]">
        {loading ? <Loader2 className="animate-spin text-gray-400" size={24} />
          : error ? <span className="text-sm text-red-600 flex items-center gap-1"><AlertCircle size={14} /> อ่านข้อมูลไม่ได้</span>
            : <><span className={`text-4xl font-bold ${t.num}`}>{value}</span>{unit && <span className="text-sm text-gray-500">{unit}</span>}</>}
      </div>
      <div className="text-xs text-gray-400 mt-1">{sub}</div>
    </button>
  );
}

function Th({ children, right }) {
  return <th className={`px-4 py-3 text-xs font-semibold text-gray-500 whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function Panel({ title, back, onBack, search, onSearch, onExport, children }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2 font-semibold text-gray-700">
          {back && (
            <button onClick={onBack} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500" title="ย้อนกลับ">
              <ChevronLeft size={18} />
            </button>
          )}
          {title}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="ค้นหา…"
              className="pl-8 pr-3 py-1.5 border border-gray-200 rounded-xl text-sm w-48 focus:outline-none focus:ring-1 focus:ring-amber-500" />
          </div>
          <button onClick={onExport} className="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 text-sm rounded-xl hover:bg-gray-50 flex items-center gap-1">
            <Download size={14} /> Excel
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function ErrorBox({ message }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-2xl p-5 text-sm text-red-700">
      <div className="flex items-center gap-2 font-semibold mb-1"><AlertCircle size={16} /> อ่านข้อมูลไม่สำเร็จ</div>
      <pre className="whitespace-pre-wrap font-sans">{message}</pre>
    </div>
  );
}

const matches = (needle, ...vals) => !needle || vals.some((v) => String(v ?? '').toLowerCase().includes(needle));

/* ------------------------------ หน้าหลัก ------------------------------ */

export default function UniformReport() {
  const [issued, setIssued] = useState({ loading: true, error: '', data: null });
  const [requests, setRequests] = useState({ loading: true, error: '', data: null });

  const [view, setView] = useState('branch');        // 'branch' | 'request'
  const [branchPick, setBranchPick] = useState('');  // สาขาที่กดเข้าไปดูรายชื่อพนักงาน
  const [itemPick, setItemPick] = useState('');      // ไอเทมที่กดเข้าไปดูว่าใครเบิก
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setIssued((s) => ({ ...s, loading: true, error: '' }));
    setRequests((s) => ({ ...s, loading: true, error: '' }));
    getJson('/api/uniform-branch')
      .then((data) => setIssued({ loading: false, error: '', data }))
      .catch((err) => { setIssued({ loading: false, error: err.message, data: null }); toast.error('อ่านยูนิฟอร์มที่แจกไม่สำเร็จ'); });
    getJson('/api/uniform-branch?view=requests')
      .then((data) => setRequests({ loading: false, error: '', data }))
      .catch((err) => { setRequests({ loading: false, error: err.message, data: null }); toast.error('อ่านใบขอเบิกยูนิฟอร์มไม่สำเร็จ'); });
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ---- การ์ด 2: ยูนิฟอร์มที่อยู่ในสาขา (แจกให้พนักงานแล้ว) ---- */
  const issuedRows = useMemo(() => {
    const d = issued.data;
    if (!d) return [];
    const L = d.layout;
    const c = {
      branch: pickCol(L, 'branch', ['branch']),
      emp: pickCol(L, 'employee', ['emp_name']),
      empCode: pickCol(L, 'empCode', ['hr_code']),
      itemCode: pickCol(L, 'itemCode', ['item_code', 'item_key']),
      item: pickCol(L, 'item', ['item_name']),
      qty: pickCol(L, 'qty', ['qty']),
      date: pickCol(L, 'date', ['issued_at', 'saved_at']),
    };
    return d.rows.map((r) => ({
      branch: txt(r[c.branch]).toUpperCase() || '(ไม่ระบุ)',
      emp: txt(r[c.emp]) || '(ไม่ระบุชื่อ)',
      empCode: txt(r[c.empCode]),
      itemCode: txt(r[c.itemCode]),
      item: txt(r[c.item]),
      qty: c.qty ? toNum(r[c.qty]) : 1,
      date: txt(r[c.date]),
    }));
  }, [issued.data]);

  const byBranch = useMemo(() => {
    const map = new Map();
    issuedRows.forEach((r) => {
      const b = map.get(r.branch) || { branch: r.branch, qty: 0, emps: new Set(), items: new Set() };
      b.qty += r.qty;
      b.emps.add(r.empCode || r.emp);
      b.items.add(r.itemCode || r.item);
      map.set(r.branch, b);
    });
    return [...map.values()].sort((a, b) => thaiSort(a.branch, b.branch));
  }, [issuedRows]);

  /** รายชื่อพนักงานของสาขาที่เลือก — รวมยูนิฟอร์มทุกชิ้นของคนเดียวกันไว้แถวเดียว */
  const branchEmployees = useMemo(() => {
    if (!branchPick) return [];
    const map = new Map();
    issuedRows.filter((r) => r.branch === branchPick).forEach((r) => {
      const k = r.empCode || r.emp;
      const e = map.get(k) || { emp: r.emp, empCode: r.empCode, qty: 0, items: new Map(), last: '' };
      e.qty += r.qty;
      const label = r.item || r.itemCode;
      e.items.set(label, (e.items.get(label) || 0) + r.qty);
      if (r.date > e.last) e.last = r.date;
      map.set(k, e);
    });
    return [...map.values()].sort((a, b) => thaiSort(a.emp, b.emp));
  }, [issuedRows, branchPick]);

  /* ---- การ์ด 3: ใบขอเบิกยูนิฟอร์ม ---- */
  const requestRows = useMemo(() => requests.data?.rows || [], [requests.data]);

  const byItem = useMemo(() => {
    const map = new Map();
    requestRows.forEach((r) => {
      const k = r.itemCode || r.itemKey;
      const it = map.get(k) || { itemCode: k, itemName: r.itemName, unit: r.unit, qty: 0, count: 0, branches: new Set(), people: new Set() };
      it.qty += r.qty;
      it.count += 1;
      it.branches.add(r.branch);
      if (r.requester) it.people.add(r.requester);
      map.set(k, it);
    });
    return [...map.values()].sort((a, b) => thaiSort(a.itemCode, b.itemCode));
  }, [requestRows]);

  const itemRequests = useMemo(
    () => (itemPick ? requestRows.filter((r) => (r.itemCode || r.itemKey) === itemPick) : []),
    [requestRows, itemPick],
  );

  const issuedTotal = issuedRows.reduce((s, r) => s + r.qty, 0);
  const requestTotal = requestRows.reduce((s, r) => s + r.qty, 0);
  const needle = search.trim().toLowerCase();

  const openView = (v) => { setView(v); setBranchPick(''); setItemPick(''); setSearch(''); };
  const pickBranch = (b) => { setBranchPick(b); setSearch(''); };
  const pickItem = (i) => { setItemPick(i); setSearch(''); };

  /* ---- รายละเอียดใต้การ์ด ---- */
  let detail = null;

  const spinner = (
    <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
      <Loader2 className="animate-spin" size={20} /> กำลังโหลด…
    </div>
  );

  if (view === 'branch') {
    if (issued.loading && !issued.data) detail = spinner;
    else if (issued.error) detail = <ErrorBox message={issued.error} />;
    else if (!branchPick) {
      const list = byBranch.filter((b) => matches(needle, b.branch));
      detail = (
        <Panel title="ยูนิฟอร์มที่อยู่ในแต่ละสาขา" search={search} onSearch={setSearch}
          onExport={() => downloadSheet('uniform_by_branch', ['สาขา', 'จำนวนยูนิฟอร์ม', 'พนักงาน (คน)', 'รายการ'],
            list.map((b) => [b.branch, b.qty, b.emps.size, b.items.size]))}>
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50/60"><tr><Th>สาขา</Th><Th right>จำนวนยูนิฟอร์ม</Th><Th right>พนักงาน (คน)</Th><Th right>รายการ</Th><Th /></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((b) => (
                <tr key={b.branch} onClick={() => pickBranch(b.branch)} className="hover:bg-amber-50/50 cursor-pointer">
                  <td className="px-4 py-3 font-semibold text-gray-800">{b.branch}</td>
                  <td className="px-4 py-3 text-right font-bold text-amber-700">{fmt0(b.qty)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{fmt0(b.emps.size)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{fmt0(b.items.size)}</td>
                  <td className="px-4 py-3 text-right text-gray-400"><ChevronRight size={16} className="inline" /></td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">ยังไม่มีข้อมูล</td></tr>}
            </tbody>
            {list.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold"><tr>
                <td className="px-4 py-3">รวม</td>
                <td className="px-4 py-3 text-right text-amber-700">{fmt0(list.reduce((s, b) => s + b.qty, 0))}</td>
                <td className="px-4 py-3 text-right">{fmt0(list.reduce((s, b) => s + b.emps.size, 0))}</td>
                <td colSpan={2} />
              </tr></tfoot>
            )}
          </table>
        </Panel>
      );
    } else {
      const list = branchEmployees.filter((e) => matches(needle, e.emp, e.empCode, ...e.items.keys()));
      detail = (
        <Panel title={`สาขา ${branchPick} — พนักงานที่มียูนิฟอร์ม`} back onBack={() => pickBranch('')}
          search={search} onSearch={setSearch}
          onExport={() => downloadSheet(`uniform_${branchPick}`, ['รหัสพนักงาน', 'ชื่อพนักงาน', 'ยูนิฟอร์ม', 'จำนวน', 'รับล่าสุด'],
            list.map((e) => [e.empCode, e.emp, [...e.items].map(([n, q]) => `${n} x${q}`).join(', '), e.qty, e.last]))}>
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50/60"><tr><Th>รหัส</Th><Th>ชื่อพนักงาน</Th><Th>ยูนิฟอร์มที่มี</Th><Th right>จำนวน</Th><Th>รับล่าสุด</Th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((e) => (
                <tr key={e.empCode || e.emp} className="hover:bg-amber-50/40 align-top">
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{e.empCode || '-'}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{e.emp}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {[...e.items].map(([name, q]) => (
                      <div key={name}>{name} <span className="text-gray-400">× {fmt0(q)}</span></div>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-amber-700">{fmt0(e.qty)}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{e.last || '-'}</td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">ไม่พบพนักงาน</td></tr>}
            </tbody>
          </table>
        </Panel>
      );
    }
  }

  if (view === 'request') {
    if (requests.loading && !requests.data) detail = spinner;
    else if (requests.error) detail = <ErrorBox message={requests.error} />;
    else if (!itemPick) {
      const list = byItem.filter((i) => matches(needle, i.itemCode, i.itemName));
      detail = (
        <Panel title="ยอดขอเบิกยูนิฟอร์มรายไอเทม" search={search} onSearch={setSearch}
          onExport={() => downloadSheet('uniform_requests_by_item', ['รหัสไอเทม', 'ชื่อไอเทม', 'หน่วย', 'เบิกรวม', 'จำนวนครั้ง', 'สาขา'],
            list.map((i) => [i.itemCode, i.itemName, i.unit, i.qty, i.count, [...i.branches].sort().join(', ')]))}>
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50/60"><tr><Th>รหัสไอเทม</Th><Th>ชื่อไอเทม</Th><Th right>เบิกรวม</Th><Th right>ครั้ง</Th><Th right>สาขา</Th><Th /></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((i) => (
                <tr key={i.itemCode} onClick={() => pickItem(i.itemCode)} className="hover:bg-sky-50/50 cursor-pointer">
                  <td className="px-4 py-3 font-mono text-gray-800">{i.itemCode}</td>
                  <td className="px-4 py-3 text-gray-700">{i.itemName || '-'}</td>
                  <td className="px-4 py-3 text-right font-bold text-sky-700">{fmt0(i.qty)} <span className="text-xs font-normal text-gray-400">{i.unit}</span></td>
                  <td className="px-4 py-3 text-right text-gray-600">{fmt0(i.count)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{fmt0(i.branches.size)}</td>
                  <td className="px-4 py-3 text-right text-gray-400"><ChevronRight size={16} className="inline" /></td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">ยังไม่มีใบขอเบิกยูนิฟอร์ม</td></tr>}
            </tbody>
            {list.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold"><tr>
                <td className="px-4 py-3" colSpan={2}>รวม</td>
                <td className="px-4 py-3 text-right text-sky-700">{fmt0(list.reduce((s, i) => s + i.qty, 0))}</td>
                <td className="px-4 py-3 text-right">{fmt0(list.reduce((s, i) => s + i.count, 0))}</td>
                <td colSpan={2} />
              </tr></tfoot>
            )}
          </table>
        </Panel>
      );
    } else {
      const head = byItem.find((i) => i.itemCode === itemPick);
      const list = itemRequests.filter((r) => matches(needle, r.branch, r.requester));
      detail = (
        <Panel title={`${itemPick} ${head?.itemName || ''} — ใครเบิกบ้าง`} back onBack={() => pickItem('')}
          search={search} onSearch={setSearch}
          onExport={() => downloadSheet(`uniform_request_${itemPick}`, ['วันที่', 'สาขา', 'ผู้เบิก', 'จำนวน'],
            list.map((r) => [r.savedAt, r.branch, r.requester, r.qty]))}>
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50/60"><tr><Th>วันที่เบิก</Th><Th>สาขา</Th><Th>ผู้เบิก</Th><Th right>จำนวน</Th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((r) => (
                <tr key={r.requestId} className="hover:bg-sky-50/40">
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{r.savedAt || '-'}</td>
                  <td className="px-4 py-3 font-semibold text-gray-800">{r.branch}</td>
                  <td className="px-4 py-3 text-gray-700">{r.requester || '-'}</td>
                  <td className="px-4 py-3 text-right font-bold text-sky-700">{fmt0(r.qty)}</td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={4} className="px-4 py-10 text-center text-gray-400">ไม่พบรายการ</td></tr>}
            </tbody>
            {list.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold"><tr>
                <td className="px-4 py-3" colSpan={3}>รวม</td>
                <td className="px-4 py-3 text-right text-sky-700">{fmt0(list.reduce((s, r) => s + r.qty, 0))}</td>
              </tr></tfoot>
            )}
          </table>
        </Panel>
      );
    }
  }

  const busy = issued.loading || requests.loading;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-100 text-amber-600 rounded-xl"><ShoppingBag size={20} /></div>
          <div className="font-semibold text-gray-800">รายงานยูนิฟอร์ม</div>
        </div>
        <button onClick={load} disabled={busy}
          className="px-4 py-2 bg-white border border-amber-200 text-amber-700 text-sm rounded-xl hover:bg-amber-50 flex items-center gap-2 disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} โหลดใหม่
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard icon={Store} tone="slate" title="คงเหลือในสโตร์" value="-" disabled
          sub="ยังไม่มีข้อมูล — รอระบุตารางสต๊อกยูนิฟอร์มของสโตร์" />
        <SummaryCard icon={Building2} tone="amber" title="อยู่ในสาขา" value={fmt0(issuedTotal)} unit="ชิ้น"
          sub={`${fmt0(byBranch.length)} สาขา · กดเพื่อดูรายสาขาและรายชื่อพนักงาน`}
          loading={issued.loading} error={issued.error} active={view === 'branch'} onClick={() => openView('branch')} />
        <SummaryCard icon={ClipboardList} tone="sky" title="ขอเบิกยูนิฟอร์ม" value={fmt0(requestTotal)} unit="ชิ้น"
          sub={`${fmt0(byItem.length)} รายการ · กดเพื่อดูรายไอเทมและผู้เบิก`}
          loading={requests.loading} error={requests.error} active={view === 'request'} onClick={() => openView('request')} />
      </div>

      {detail}

      <div className="text-[11px] text-gray-400">
        อยู่ในสาขา: dbo.UniformBranch{issued.data?.source ? ` (${issued.data.source})` : ''}
        {' · '}ขอเบิก: dbo.stock_request เฉพาะไอเทมยูนิฟอร์ม{requests.data?.source ? ` (${requests.data.source})` : ''}
      </div>
    </div>
  );
}
