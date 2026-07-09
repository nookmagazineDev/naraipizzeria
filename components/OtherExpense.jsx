import React, { useState, useMemo, useEffect, useRef } from 'react';
import { DollarSign, Save, Building2, Calendar, Info, Loader2, CheckCircle, AlertCircle, Download, Upload, FileSpreadsheet } from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import { apiCall } from '../lib/expenseApi';

/*
 * NARAI OFFICE — ค่าใช้จ่ายอื่นๆ
 * เลือกสาขา + เดือน แล้วกรอกค่าใช้จ่ายแต่ละประเภท (เลขเริ่มต้น/สิ้นสุด + ราคา/หน่วย)
 * จำนวน = สิ้นสุด − เริ่มต้น (หน่วยที่ใช้ไปตามมิเตอร์) · ผลรวม = จำนวน × ราคา/หน่วย
 *
 * ข้อมูลผ่าน Google Apps Script (ผูกกับชีท 1YXOaA…) → proxy /api/expense-gas:
 *  - getExpenseRefs  : อ่านชีท "ข้อมูลค่าใช้อื่น" (A=ประเภท, B=สาขา, C=รหัส)
 *  - saveOtherExpense: เขียนชีท "ค่าใช้จ่ายอื่น" (A=เดือน B=ประเภท C=สาขา D=รหัส E=เริ่ม F=สิ้นสุด G=จำนวน H=ราคา/หน่วย I=ผลรวม)
 */

const EXPENSE_TYPES = ['ค่าเช่าพื้นที่', 'ไฟฟ้า', 'น้ำประปา', 'แก๊ส', 'tel'];

// รายชื่อสาขาสำรอง (ใช้ตอนยังต่อ GAS ไม่ได้) — เฟสจริงดึงจากชีท "ข้อมูลค่าใช้อื่น" คอลัมน์ B
const FALLBACK_BRANCHES = [
  'SJP', 'CRM', 'XCM', 'SLR', 'SUM', 'XUM', 'SCS', 'SMP', 'XSB', 'XHH',
  'HRS', 'CLK', 'P90', 'HPS', 'ZBW', 'ZPT', 'NPT', 'WRM', 'WMT', 'IPR', 'ZK3',
];

const fmt = v => {
  const n = parseFloat(v);
  return isNaN(n) ? '0.00' : n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const refKey = (type, branch) => `${String(type).trim()}||${String(branch).trim()}`;

const EMPTY = { start: '', end: '', price: '' };

export default function OtherExpense() {
  const [month, setMonth] = useState(thisMonth());
  const [branch, setBranch] = useState('');
  // rows คีย์ด้วย rowKey (type||code) เพราะประเภทเดียวอาจมีหลายรหัส (หลายมิเตอร์)
  const [rows, setRows] = useState({});

  // refs จากชีท: branches + codesMap (type||branch -> [รหัส...] เก็บครบทุกมิเตอร์ ไม่ทับกัน)
  const [refs, setRefs] = useState({ branches: FALLBACK_BRANCHES, codesMap: {}, loaded: false, error: '' });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { ok, msg }

  useEffect(() => {
    let alive = true;
    apiCall('getExpenseRefs', {})
      .then(res => {
        if (!alive) return;
        const list = res.data || [];
        const branches = [...new Set(list.map(r => String(r.branch || '').trim()).filter(Boolean))];
        const codesMap = {};
        list.forEach(r => {
          const k = refKey(r.type, r.branch);
          const code = String(r.code || '').trim();
          if (!codesMap[k]) codesMap[k] = [];
          if (code && !codesMap[k].includes(code)) codesMap[k].push(code); // เก็บครบ ไม่ซ้ำ
        });
        setRefs({ branches: branches.length ? branches : FALLBACK_BRANCHES, codesMap, loaded: true, error: '' });
      })
      .catch(err => { if (alive) setRefs(r => ({ ...r, loaded: true, error: err.message || 'โหลดข้อมูลอ้างอิงไม่สำเร็จ' })); });
    return () => { alive = false; };
  }, []);

  const rowKeyOf = (type, code) => `${type}||${code}`;
  const setCell = (rowKey, field, value) =>
    setRows(prev => ({ ...prev, [rowKey]: { ...(prev[rowKey] || EMPTY), [field]: value } }));

  // แตกแถวฟอร์มตามรหัส: ประเภทที่มีหลายรหัสจะได้หลายแถว (มิเตอร์ละแถว), ประเภทที่ไม่มีรหัสได้ 1 แถวว่าง
  const formRows = useMemo(() => {
    const out = [];
    EXPENSE_TYPES.forEach(type => {
      const codes = branch ? (refs.codesMap[refKey(type, branch)] || []) : [];
      if (codes.length === 0) {
        out.push({ type, code: '', rowKey: rowKeyOf(type, ''), codeCount: 0, codeIndex: 0 });
      } else {
        codes.forEach((code, i) => out.push({ type, code, rowKey: rowKeyOf(type, code), codeCount: codes.length, codeIndex: i }));
      }
    });
    return out;
  }, [branch, refs.codesMap]);

  // ── ประวัติที่บันทึกไว้ในชีท: สรุปรายเดือน + กดดูรายละเอียด ──
  // (ต้องประกาศก่อน computed เพราะ computed ใช้ savedMap)
  const [history, setHistory] = useState({ loading: false, loaded: false, rows: [] });
  const [expandedMonth, setExpandedMonth] = useState(null);

  const loadHistory = () => {
    setHistory(h => ({ ...h, loading: true }));
    apiCall('getExpenses', {})
      .then(res => setHistory({ loading: false, loaded: true, rows: res.data || [] }))
      .catch(() => setHistory({ loading: false, loaded: true, rows: [] }));
  };
  useEffect(loadHistory, []);

  const monthSummary = useMemo(() => {
    const g = {};
    history.rows.forEach(r => {
      const m = r.month || '?';
      if (!g[m]) g[m] = { month: m, count: 0, total: 0, byType: {} };
      const t = parseFloat(r.total) || 0;
      g[m].count++;
      g[m].total += t;
      g[m].byType[r.type] = (g[m].byType[r.type] || 0) + t;
    });
    return Object.values(g).sort((a, b) => b.month.localeCompare(a.month));
  }, [history.rows]);

  const expandedRows = useMemo(() =>
    expandedMonth ? history.rows.filter(r => r.month === expandedMonth) : [],
  [history.rows, expandedMonth]);

  // ข้อมูลที่บันทึกแล้วของ (เดือน, สาขา) ที่เลือก — คีย์ตาม (ประเภท, รหัส)
  const savedMap = useMemo(() => {
    const m = {};
    if (branch) history.rows.forEach(r => {
      if (r.month === month && r.branch === branch) m[rowKeyOf(r.type, String(r.code || '').trim())] = r;
    });
    return m;
  }, [history.rows, month, branch]);

  // เลือกเดือน/สาขา → เติมตัวเลขที่เคยบันทึกลงฟอร์มให้แก้ไขต่อได้ (ไม่มีข้อมูล = ฟอร์มว่าง)
  useEffect(() => {
    if (!branch) { setRows({}); return; }
    const next = {};
    Object.entries(savedMap).forEach(([key, r]) => {
      next[key] = {
        start: r.start !== '' && r.start != null ? String(r.start) : '',
        end: r.end !== '' && r.end != null ? String(r.end) : '',
        price: r.price !== '' && r.price != null ? String(r.price) : '',
      };
    });
    setRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, month, history.rows]);

  // จำนวน = สิ้นสุด − เริ่มต้น (หน่วยที่ใช้ไปตามมิเตอร์) ; ผลรวม = จำนวน × ราคา/หน่วย
  const computed = useMemo(() => formRows.map(fr => {
    const r = rows[fr.rowKey] || EMPTY;
    const saved = savedMap[fr.rowKey] || null;
    const start = parseFloat(r.start) || 0;
    const end = parseFloat(r.end) || 0;
    const price = parseFloat(r.price) || 0;
    const qty = end - start;
    const hasInput = r.start !== '' || r.end !== '' || r.price !== '';
    let total = qty * price;
    // แถวที่บันทึกแบบยอดเงินอย่างเดียว (import ย้อนหลัง ไม่มีเลขมิเตอร์) — โชว์ยอดที่บันทึกไว้
    if (!hasInput && saved && saved.total !== '' && saved.total != null) total = parseFloat(saved.total) || 0;
    return { ...fr, raw: r, saved, qty, total, hasInput };
  }), [formRows, rows, savedMap]);

  const grandTotal = computed.reduce((s, r) => s + (r.total || 0), 0);
  const canSave = branch && month && computed.some(r => r.hasInput) && !saving;

  const handleSave = async () => {
    setSaving(true);
    setToast(null);
    try {
      const items = computed.filter(r => r.hasInput).map(r => ({
        type: r.type, code: r.code,
        start: r.raw.start, end: r.raw.end, price: r.raw.price,
      }));
      const res = await apiCall('saveOtherExpense', { month, branch, items });
      const nNew = res.data?.appended ?? 0, nUpd = res.data?.updated ?? 0;
      setToast({ ok: true, msg: nUpd > 0 ? `บันทึกสำเร็จ — เพิ่มใหม่ ${nNew} · อัพเดตทับ ${nUpd} รายการ` : `บันทึกสำเร็จ ${nNew || items.length} รายการ` });
      loadHistory(); // โหลดใหม่ → ฟอร์มจะแสดงค่าที่บันทึกพร้อมป้าย "บันทึกแล้ว"
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  // ── เทมเพลท Excel: แถวครบทุกสาขา × ประเภท × มิเตอร์ (จากชีทอ้างอิง) กรอกแค่ตัวเลข ──
  const fileRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const HEAD_STYLE = {
    font: { name: 'Tahoma', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
    fill: { patternType: 'solid', fgColor: { rgb: 'D97706' } },
  };

  const downloadTemplate = () => {
    const aoa = [['เดือน (YYYY-MM)', 'สาขา', 'ประเภท', 'รหัสมิเตอร์', 'เลขเริ่มต้น', 'เลขสิ้นสุด', 'ราคาต่อหน่วย', 'ผลรวม (กรอกเมื่อไม่มีเลขมิเตอร์)']];
    refs.branches.forEach(b => {
      EXPENSE_TYPES.forEach(type => {
        const codes = refs.codesMap[refKey(type, b)] || [''];
        codes.forEach(code => aoa.push([month, b, type, code, '', '', '', '']));
      });
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 26 }];
    for (let c = 0; c < 8; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) cell.s = HEAD_STYLE;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'กรอกข้อมูล');
    XLSX.writeFile(wb, `expense_template_${month}.xlsx`);
    setToast({ ok: true, msg: `ดาวน์โหลดเทมเพลทแล้ว (${aoa.length - 1} แถว ${refs.branches.length} สาขา) — แถวที่ไม่กรอกตัวเลขจะถูกข้ามตอน import` });
  };

  // ── Import: อ่านไฟล์เทมเพลทที่กรอกแล้ว → แปลงเป็นแถว → ยืนยัน → bulkImport ──
  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // ให้เลือกไฟล์เดิมซ้ำได้
    if (!file) return;
    setImporting(true);
    setToast(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
      const hIdx = aoa.findIndex(r => r.some(c => String(c).includes('เดือน')) && r.some(c => String(c).includes('สาขา')));
      if (hIdx < 0) throw new Error('ไม่พบหัวตาราง — ต้องมีคอลัมน์ เดือน/สาขา/ประเภท (ใช้ไฟล์จากปุ่มดาวน์โหลดเทมเพลท)');
      const header = aoa[hIdx].map(c => String(c));
      const col = name => header.findIndex(h => h.includes(name));
      const ci = {
        month: col('เดือน'), branch: col('สาขา'), type: col('ประเภท'), code: col('รหัส'),
        start: col('เริ่มต้น'), end: col('สิ้นสุด'), price: col('ราคา'), total: col('ผลรวม'),
      };
      const fmtMonth = v => {
        if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
        if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (d) return `${d.y}-${String(d.m).padStart(2, '0')}`; }
        return String(v || '').trim();
      };
      const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? '' : parseFloat(v);
      const rows = [];
      for (let i = hIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const m = fmtMonth(r[ci.month]);
        const b = String(r[ci.branch] || '').trim().toUpperCase();
        const t = String(r[ci.type] || '').trim();
        const start = num(r[ci.start]), end = num(r[ci.end]), price = num(r[ci.price]);
        const total = ci.total >= 0 ? num(r[ci.total]) : '';
        if (!m || !b || !t) continue;
        if (start === '' && end === '' && price === '' && total === '') continue; // ไม่ได้กรอก = ข้าม
        rows.push({ month: m, branch: b, type: t, code: String(r[ci.code] || '').trim(), start, end, price, total });
      }
      if (!rows.length) throw new Error('ไม่พบแถวที่กรอกตัวเลขในไฟล์');
      const months = [...new Set(rows.map(r => r.month))].sort();
      const brs = [...new Set(rows.map(r => r.branch))].sort();
      const ok = window.confirm(
        `พบข้อมูลที่กรอก ${rows.length} แถว\nเดือน: ${months.join(', ')}\nสาขา (${brs.length}): ${brs.join(' ')}\n\nยืนยันบันทึกลงชีท? (การ import ซ้ำจะได้แถวซ้ำ)`
      );
      if (!ok) return;
      const res = await apiCall('bulkImport', { rows });
      setToast({ ok: true, msg: `นำเข้าสำเร็จ ${res.data?.appended ?? rows.length} แถว (${brs.length} สาขา)` });
      loadHistory();
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'นำเข้าไม่สำเร็จ' });
    } finally {
      setImporting(false);
    }
  };

  // ── Export ข้อมูลที่บันทึกไว้ทั้งหมดจากชีท → Excel ──
  const exportData = async () => {
    setExporting(true);
    setToast(null);
    try {
      const res = await apiCall('getExpenses', {});
      const list = res.data || [];
      if (!list.length) { setToast({ ok: false, msg: 'ยังไม่มีข้อมูลในชีท' }); return; }
      const aoa = [['เดือน', 'ประเภท', 'สาขา', 'รหัส', 'เลขเริ่มต้น', 'เลขสิ้นสุด', 'จำนวน', 'ราคาต่อหน่วย', 'ผลรวม']];
      list.forEach(r => aoa.push([r.month, r.type, r.branch, r.code, r.start, r.end, r.qty, r.price, r.total]));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
      for (let c = 0; c < 9; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
        if (cell) cell.s = HEAD_STYLE;
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ค่าใช้จ่ายอื่น');
      XLSX.writeFile(wb, `expense_data_${new Date().toISOString().split('T')[0]}.xlsx`);
      setToast({ ok: true, msg: `Export สำเร็จ ${list.length} แถว` });
    } catch (err) {
      const msg = /unknown action/.test(err.message || '')
        ? 'ต้องอัปเดต Apps Script ก่อน (วางโค้ดใหม่ + Deploy new version) จึงจะ Export ได้'
        : (err.message || 'Export ไม่สำเร็จ');
      setToast({ ok: false, msg });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 md:p-7 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center gap-3">
          <div className="p-3 bg-amber-100 text-amber-600 rounded-xl"><DollarSign className="w-6 h-6" /></div>
          <div>
            <h2 className="text-xl font-bold text-slate-800">ค่าใช้จ่ายอื่นๆ</h2>
            <p className="text-sm text-slate-500 mt-0.5">บันทึกค่าเช่า/ไฟฟ้า/น้ำประปา/แก็ส/โทรศัพท์ แยกตามสาขาและเดือน</p>
          </div>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500 flex items-center gap-1"><Calendar size={13} /> เดือน</label>
            <input type="month" value={month} onChange={e => setMonth(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500 flex items-center gap-1">
              <Building2 size={13} /> สาขา {!refs.loaded && <Loader2 size={11} className="animate-spin" />}
            </label>
            <select value={branch} onChange={e => setBranch(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
              <option value="">— เลือกสาขา —</option>
              {refs.branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        </div>

        {/* เครื่องมือ Excel: เทมเพลทกรอกหลายสาขา / Import / Export */}
        <div className="px-6 pb-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wide mr-1">Excel:</span>
          <button onClick={downloadTemplate} disabled={!refs.loaded}
            title="เทมเพลทมีแถวครบทุกสาขา×ประเภท×มิเตอร์ กรอกเฉพาะตัวเลขแล้วนำมา Import"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl hover:bg-amber-100 disabled:opacity-50 transition-all">
            <FileSpreadsheet size={14} /> ดาวน์โหลดเทมเพลท (ทุกสาขา)
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={importing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-500 border border-emerald-500 rounded-xl hover:bg-emerald-600 disabled:opacity-50 transition-all">
            {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import Excel
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />
          <button onClick={exportData} disabled={exporting}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-50 transition-all">
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Export ข้อมูลที่บันทึก
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">ประเภท</th>
                <th className="px-3 py-3 text-left">รหัส</th>
                <th className="px-4 py-3 text-right">เลขเริ่มต้น</th>
                <th className="px-4 py-3 text-right">เลขสิ้นสุด</th>
                <th className="px-4 py-3 text-right">จำนวน <span className="font-normal normal-case">(สิ้นสุด−เริ่มต้น)</span></th>
                <th className="px-4 py-3 text-right">ราคา/หน่วย</th>
                <th className="px-4 py-3 text-right">ผลรวม</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {computed.map((r, i) => {
                // แถวแรกของแต่ละประเภทแสดงชื่อประเภท (แถวมิเตอร์ถัด ๆ ไปเว้นว่างให้ดูเป็นกลุ่ม)
                const firstOfType = r.codeIndex === 0;
                return (
                  <tr key={r.rowKey} className={`hover:bg-slate-50/60 ${firstOfType && i !== 0 ? 'border-t-2 border-slate-100' : ''}`}>
                    <td className="px-4 py-2.5 font-semibold text-slate-800 whitespace-nowrap">
                      {firstOfType ? r.type : ''}
                      {r.codeCount > 1 && <span className="ml-1 text-[10px] font-normal text-slate-400">#{r.codeIndex + 1}</span>}
                      {r.saved && (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-full text-[9px] font-bold align-middle">
                          <CheckCircle size={8} /> บันทึกแล้ว
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">{r.code || '—'}</td>
                    <td className="px-2 py-2">
                      <input type="number" inputMode="decimal" value={r.raw.start} onChange={e => setCell(r.rowKey, 'start', e.target.value)} placeholder="0"
                        className="w-28 text-right border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500" />
                    </td>
                    <td className="px-2 py-2">
                      <input type="number" inputMode="decimal" value={r.raw.end} onChange={e => setCell(r.rowKey, 'end', e.target.value)} placeholder="0"
                        className="w-28 text-right border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500" />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-700">{fmt(r.qty)}</td>
                    <td className="px-2 py-2">
                      <input type="number" inputMode="decimal" value={r.raw.price} onChange={e => setCell(r.rowKey, 'price', e.target.value)} placeholder="0"
                        className="w-24 text-right border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500" />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-amber-700">฿{fmt(r.total)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-amber-50/60 border-t-2 border-amber-400 font-bold text-slate-800">
                <td className="px-4 py-3" colSpan={6}>รวมทั้งหมด</td>
                <td className="px-4 py-3 text-right font-mono text-amber-700">฿{fmt(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="p-5 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">
              {branch ? `สาขา ${branch} · เดือน ${month}` : 'ยังไม่ได้เลือกสาขา'}
              {Object.keys(savedMap).length > 0 && (
                <span className="ml-1.5 text-emerald-600 font-semibold">· เดือนนี้มีข้อมูลแล้ว {Object.keys(savedMap).length} รายการ — กดบันทึกจะอัพเดตทับรายการเดิม</span>
              )}
            </span>
            {toast && (
              <span className={`inline-flex items-center gap-1 font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
          </div>
          <button onClick={handleSave} disabled={!canSave}
            className="inline-flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-sm px-6 py-2.5 rounded-xl transition-all">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            <span>{saving ? 'กำลังบันทึก…' : 'บันทึก'}</span>
          </button>
        </div>
      </div>

      {/* ประวัติที่บันทึกไว้: สรุปรายเดือน (กดแถวเพื่อดูรายละเอียด) */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-bold text-slate-800 text-sm">ข้อมูลที่บันทึกแล้ว (รายเดือน)</h3>
          <button onClick={loadHistory} disabled={history.loading}
            className="text-xs font-semibold text-amber-600 hover:text-amber-800 inline-flex items-center gap-1">
            {history.loading ? <Loader2 size={12} className="animate-spin" /> : '↻'} รีเฟรช
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-2.5 text-left">เดือน</th>
                <th className="px-3 py-2.5 text-right">รายการ</th>
                {EXPENSE_TYPES.map(t => <th key={t} className="px-3 py-2.5 text-right">{t}</th>)}
                <th className="px-4 py-2.5 text-right">รวม</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.loading && !history.loaded ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" />กำลังโหลด…
                </td></tr>
              ) : monthSummary.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400 text-xs">ยังไม่มีข้อมูลที่บันทึก</td></tr>
              ) : monthSummary.map(s => (
                <tr key={s.month} onClick={() => setExpandedMonth(expandedMonth === s.month ? null : s.month)}
                  className={`cursor-pointer hover:bg-amber-50/40 ${expandedMonth === s.month ? 'bg-amber-50/60' : ''}`}>
                  <td className="px-4 py-2 font-semibold text-slate-800 whitespace-nowrap">
                    {expandedMonth === s.month ? '▾' : '▸'} {s.month}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500">{s.count}</td>
                  {EXPENSE_TYPES.map(t => (
                    <td key={t} className={`px-3 py-2 text-right font-mono ${(s.byType[t] || 0) < 0 ? 'text-rose-600 font-bold' : 'text-slate-600'}`}>
                      {s.byType[t] ? fmt(s.byType[t]) : '—'}
                    </td>
                  ))}
                  <td className={`px-4 py-2 text-right font-mono font-bold ${s.total < 0 ? 'text-rose-600' : 'text-amber-700'}`}>{fmt(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* รายละเอียดของเดือนที่เลือก */}
        {expandedMonth && (
          <div className="border-t-2 border-amber-200 bg-amber-50/20">
            <div className="px-4 py-2 text-xs font-bold text-amber-700">รายละเอียดเดือน {expandedMonth} ({expandedRows.length} แถว)</div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr className="font-bold">
                    <th className="px-3 py-2 text-left">สาขา</th>
                    <th className="px-3 py-2 text-left">ประเภท</th>
                    <th className="px-3 py-2 text-left">รหัส</th>
                    <th className="px-3 py-2 text-right">เลขเริ่มต้น</th>
                    <th className="px-3 py-2 text-right">เลขสิ้นสุด</th>
                    <th className="px-3 py-2 text-right">จำนวน</th>
                    <th className="px-3 py-2 text-right">ราคา/หน่วย</th>
                    <th className="px-3 py-2 text-right">ผลรวม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {[...expandedRows].sort((a, b) => a.branch.localeCompare(b.branch) || a.type.localeCompare(b.type)).map((r, i) => (
                    <tr key={i} className={parseFloat(r.total) < 0 ? 'bg-rose-50/60' : ''}>
                      <td className="px-3 py-1.5 font-semibold">{r.branch}</td>
                      <td className="px-3 py-1.5">{r.type}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-500">{r.code || '—'}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.start !== '' && r.start != null ? Number(r.start).toLocaleString() : '—'}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.end !== '' && r.end != null ? Number(r.end).toLocaleString() : '—'}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${parseFloat(r.qty) < 0 ? 'text-rose-600 font-bold' : ''}`}>{r.qty !== '' && r.qty != null ? Number(r.qty).toLocaleString() : '—'}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.price !== '' && r.price != null ? fmt(r.price) : '—'}</td>
                      <td className={`px-3 py-1.5 text-right font-mono font-bold ${parseFloat(r.total) < 0 ? 'text-rose-600' : 'text-slate-700'}`}>{fmt(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* สถานะการเชื่อมต่อชีท */}
      {refs.error && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 text-xs text-amber-800 flex gap-2.5">
          <Info size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">ยังเชื่อมต่อชีทไม่ได้ — กำลังใช้รายชื่อสาขาสำรอง</p>
            <p className="mt-0.5">ตั้งค่า Google Apps Script + URL ใน <code className="bg-white px-1 rounded">/api/expense-gas</code> ให้เรียบร้อยก่อน (รหัส/สาขาจริง + ปุ่มบันทึกจะทำงานทันที) · {refs.error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
