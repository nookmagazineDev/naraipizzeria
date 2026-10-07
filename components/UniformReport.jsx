import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShoppingBag, Store, Building2, ClipboardList, Search, Loader2, AlertCircle, Download, RefreshCw,
  ChevronLeft, ChevronRight, CheckCircle,
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
 *   3) ขอเบิกยูนิฟอร์ม   — dbo.UniformRequest (สาขากด "ส่งคำขอเบิก" ในกล่องยูนิฟอร์มของ Narai-branch)
 *                          ตารางรายคำขอ กรองตามสถานะ แล้วกดปุ่มตามขั้น:
 *                            กำลังรออนุมัติ -> อนุมัติเบิก / รอสินค้าเข้า
 *                            รอสินค้าเข้า   -> อนุมัติเบิก
 *                            อนุมัติเบิก    -> กำลังรอจัดส่ง (ส่งใบเบิกไปคลัง ลง dbo.stock_request ตอนนี้)
 *                            กำลังรอจัดส่ง  -> สาขากด "ได้รับของแล้ว" เอง (จบงาน)
 *                          ดู lib/uniformSql.mjs
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

/* ------------------------------ สถานะคำขอเบิก ------------------------------ */

// คีย์ตรงกับ UNIFORM_REQUEST_STATUS ใน lib/uniformSql.mjs
const STATUS = {
  pending: { label: 'กำลังรออนุมัติ', badge: 'bg-gray-100 text-gray-600 border-gray-200' },
  waiting_stock: { label: 'รอสินค้าเข้า', badge: 'bg-amber-50 text-amber-700 border-amber-200' },
  approved: { label: 'อนุมัติเบิก', badge: 'bg-blue-50 text-blue-700 border-blue-200' },
  shipping: { label: 'กำลังรอจัดส่ง', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  received: { label: 'ได้รับของแล้ว', badge: 'bg-violet-50 text-violet-700 border-violet-200' },
};

const BTN = {
  approved: 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700',
  waiting_stock: 'bg-white text-amber-700 border-amber-300 hover:bg-amber-50',
  shipping: 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700',
};

/** ปุ่มขั้นถัดไปของแต่ละสถานะ — received เป็นของสาขากดเอง ออฟฟิศไม่มีปุ่ม */
const NEXT = {
  pending: [['approved', 'อนุมัติเบิก'], ['waiting_stock', 'รอสินค้าเข้า']],
  waiting_stock: [['approved', 'ของเข้าแล้ว · อนุมัติเบิก']],
  approved: [['shipping', 'กำลังรอจัดส่ง · ส่งใบเบิกไปคลัง']],
};

function StatusBadge({ status }) {
  const st = STATUS[status] || STATUS.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full border whitespace-nowrap ${st.badge}`}>
      {status === 'received' && <CheckCircle size={12} />} {st.label}
    </span>
  );
}

/** ป้ายสถานะ + ปุ่มขั้นถัดไป */
function StatusActions({ status, saving, onSave }) {
  if (saving) {
    return <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Loader2 size={14} className="animate-spin" /> กำลังบันทึก…</span>;
  }
  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge status={status} />
      {(NEXT[status] || []).map(([next, text]) => (
        <button key={next} onClick={() => onSave(next)}
          className={`px-2.5 py-1 text-xs font-medium rounded-lg border whitespace-nowrap ${BTN[next]}`}>
          {text}
        </button>
      ))}
    </div>
  );
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');    // ตัวกรองสถานะของการ์ดขอเบิก — เปิดมาเห็นงานที่ต้องทำก่อน
  const [savingIds, setSavingIds] = useState(() => new Set());   // คำขอที่กำลังบันทึกสถานะ

  const loadRequests = useCallback(() => {
    setRequests((s) => ({ ...s, loading: true, error: '' }));
    return getJson('/api/uniform-branch?view=requests')
      .then((data) => setRequests({ loading: false, error: '', data }))
      .catch((err) => { setRequests({ loading: false, error: err.message, data: null }); toast.error('อ่านคำขอเบิกยูนิฟอร์มไม่สำเร็จ'); });
  }, []);

  const load = useCallback(() => {
    setIssued((s) => ({ ...s, loading: true, error: '' }));
    getJson('/api/uniform-branch')
      .then((data) => setIssued({ loading: false, error: '', data }))
      .catch((err) => { setIssued({ loading: false, error: err.message, data: null }); toast.error('อ่านยูนิฟอร์มที่แจกไม่สำเร็จ'); });
    loadRequests();
  }, [loadRequests]);

  useEffect(() => { load(); }, [load]);

  /** ตั้งสถานะคำขอ — บันทึกสำเร็จแล้วค่อยโหลดใหม่ (กำลังรอจัดส่งได้เลขที่ใบเบิกจากฐาน จึงต้องอ่านกลับ) */
  const saveStatus = useCallback(async (ids, status) => {
    if (!ids.length) return;
    setSavingIds((prev) => new Set([...prev, ...ids]));
    try {
      const res = await fetch('/api/uniform-branch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setStatus', requestIds: ids, status }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status !== 'success') throw new Error(json.message || `HTTP ${res.status}`);
      const d = json.data || {};
      toast.success(status === 'shipping' && d.docs?.length
        ? `ส่งใบเบิกไปคลังแล้ว ${d.count} รายการ · ใบเบิก ${d.docs.join(', ')}`
        : `${STATUS[status].label} (${d.count ?? ids.length} รายการ)`);
      await loadRequests();
    } catch (err) {
      toast.error(`บันทึกสถานะไม่สำเร็จ: ${err.message}`);
    } finally {
      setSavingIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
    }
  }, [loadRequests]);

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

  /* ---- การ์ด 3: คำขอเบิกยูนิฟอร์ม ---- */
  const allRequestRows = useMemo(() => requests.data?.rows || [], [requests.data]);

  /** จำนวนคำขอแต่ละสถานะ (ก่อนกรอง) — ขึ้นบนปุ่มตัวกรอง */
  const statusCounts = useMemo(() => {
    const c = { all: allRequestRows.length };
    Object.keys(STATUS).forEach((k) => { c[k] = 0; });
    allRequestRows.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }, [allRequestRows]);

  const requestRows = useMemo(
    () => (statusFilter === 'all' ? allRequestRows : allRequestRows.filter((r) => r.status === statusFilter)),
    [allRequestRows, statusFilter],
  );

  const issuedTotal = issuedRows.reduce((s, r) => s + r.qty, 0);
  const openRequestTotal = allRequestRows.filter((r) => r.status !== 'received').reduce((s, r) => s + r.qty, 0);
  const needle = search.trim().toLowerCase();

  const openView = (v) => { setView(v); setBranchPick(''); setSearch(''); };
  const pickBranch = (b) => { setBranchPick(b); setSearch(''); };

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
    else {
      const list = requestRows.filter((r) => matches(needle, r.branch, r.requester, r.hrCode, r.itemCode, r.itemName, r.docNo, STATUS[r.status]?.label));
      const pendingIds = list.filter((r) => r.status === 'pending').map((r) => r.requestId);
      detail = (
        <Panel title="คำขอเบิกยูนิฟอร์มจากสาขา" search={search} onSearch={setSearch}
          onExport={() => downloadSheet('uniform_requests',
            ['วันที่ขอ', 'สาขา', 'รหัสพนักงาน', 'พนักงาน', 'รหัสไอเทม', 'ไอเทม', 'จำนวน', 'ต้องการรับ', 'สถานะ', 'เลขที่ใบเบิก', 'ผู้กดล่าสุด', 'เวลา'],
            list.map((r) => [r.savedAt, r.branch, r.hrCode, r.requester, r.itemCode, r.itemName, r.qty, r.wantDate,
              STATUS[r.status]?.label || r.status, r.docNo, r.status === 'received' ? r.receivedBy : r.statusBy,
              r.status === 'received' ? r.receivedAt : r.statusAt]))}>
          {pendingIds.length > 0 && (
            <div className="px-4 py-2.5 bg-sky-50 border-b border-sky-100 flex flex-wrap items-center gap-3 text-sm text-sky-800">
              <span>กำลังรออนุมัติ {fmt0(pendingIds.length)} รายการ</span>
              {pendingIds.some((id) => savingIds.has(id))
                ? <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Loader2 size={14} className="animate-spin" /> กำลังบันทึก…</span>
                : (
                  <button onClick={() => saveStatus(pendingIds, 'approved')}
                    className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700">
                    <CheckCircle size={14} /> อนุมัติเบิกทั้งหมด {fmt0(pendingIds.length)} รายการ
                  </button>
                )}
            </div>
          )}
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50/60"><tr><Th>วันที่ขอ</Th><Th>สาขา</Th><Th>พนักงาน</Th><Th>ไอเทม</Th><Th right>จำนวน</Th><Th>ใบเบิก</Th><Th>สถานะ / จัดการ</Th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((r) => {
                const who = r.status === 'received' ? [r.receivedBy && `สาขารับ: ${r.receivedBy}`, r.receivedAt] : [r.statusBy, r.statusAt];
                return (
                  <tr key={r.requestId} className="hover:bg-sky-50/40 align-top">
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                      {r.savedAt || '-'}
                      {r.wantDate && <div className="text-[11px] text-gray-400">ต้องการรับ {r.wantDate}</div>}
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-800">{r.branch}</td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.requester || '-'}
                      {r.hrCode && <div className="text-[11px] text-gray-400">{r.hrCode}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-semibold text-sky-700">{r.itemCode}</span>
                      <div className="text-gray-700">{r.itemName || '-'}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-sky-700 whitespace-nowrap">{fmt0(r.qty)} <span className="text-xs font-normal text-gray-400">{r.unit}</span></td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">{r.docNo || '—'}</td>
                    <td className="px-4 py-3">
                      <StatusActions status={r.status} saving={savingIds.has(r.requestId)}
                        onSave={(st) => saveStatus([r.requestId], st)} />
                      {r.status !== 'pending' && who.some(Boolean) && (
                        <div className="text-[11px] text-gray-400 mt-1">{who.filter(Boolean).join(' · ')}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!list.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">{statusFilter === 'all' ? 'ยังไม่มีคำขอเบิกยูนิฟอร์ม' : `ไม่มีคำขอที่สถานะ "${STATUS[statusFilter]?.label}"`}</td></tr>}
            </tbody>
            {list.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold"><tr>
                <td className="px-4 py-3" colSpan={4}>รวม {fmt0(list.length)} รายการ</td>
                <td className="px-4 py-3 text-right text-sky-700">{fmt0(list.reduce((sum, r) => sum + r.qty, 0))}</td>
                <td colSpan={2} />
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
        <SummaryCard icon={ClipboardList} tone="sky" title="ขอเบิกยูนิฟอร์ม" value={fmt0(openRequestTotal)} unit="ชิ้นที่ยังไม่จบ"
          sub={`รออนุมัติ ${fmt0(statusCounts.pending)} · รอสินค้าเข้า ${fmt0(statusCounts.waiting_stock)} · รอจัดส่ง ${fmt0(statusCounts.shipping)} · กดเพื่อจัดการ`}
          loading={requests.loading} error={requests.error} active={view === 'request'} onClick={() => openView('request')} />
      </div>

      {view === 'request' && !requests.error && requests.data && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-500 mr-1">สถานะ:</span>
          {[['all', 'ทั้งหมด'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])].map(([k, text]) => (
            <button key={k} onClick={() => { setStatusFilter(k); setSearch(''); }}
              className={`px-3 py-1.5 text-sm rounded-xl border transition ${statusFilter === k
                ? 'bg-sky-600 text-white border-sky-600'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-sky-50'}`}>
              {text} <span className={statusFilter === k ? 'text-sky-100' : 'text-gray-400'}>({fmt0(statusCounts[k] || 0)})</span>
            </button>
          ))}
        </div>
      )}

      {detail}

      <div className="text-[11px] text-gray-400">
        อยู่ในสาขา: dbo.UniformBranch{issued.data?.source ? ` (${issued.data.source})` : ''}
        {' · '}ขอเบิก: dbo.UniformRequest (กดกำลังรอจัดส่งแล้วส่งใบเบิกไปคลัง ลง dbo.stock_request){requests.data?.source ? ` (${requests.data.source})` : ''}
      </div>
    </div>
  );
}
