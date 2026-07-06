import React, { useState, useEffect, useMemo } from 'react';
import { FileText, Search, Loader2, AlertCircle, CheckCircle, Plus, Pencil, X, Trash2, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { apiCall } from '../lib/qcrdApi';

/*
 * QC/RD — เมนู: รายชื่อเมนูจากชีท menu + สูตร (BOM) ของแต่ละเมนู
 * กดแถวเพื่อดูสูตร · ปุ่ม "เพิ่มเมนู" / "แก้ไข" เปิดฟอร์มจัดการวัตถุดิบในสูตร
 * บันทึกผ่าน Apps Script (action: saveMenu) — ต้อง deploy qcrd-apps-script.gs ก่อน
 */

const fmt = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });

const PAGE_SIZE = 50;

export default function QcRdMenu() {
  const [menus, setMenus] = useState([]);
  const [bom, setBom] = useState({});
  const [items, setItems] = useState([]); // สำหรับ picker วัตถุดิบ
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [viewCode, setViewCode] = useState(null);   // เมนูที่กำลังดูสูตร
  const [editMenu, setEditMenu] = useState(null);   // { code, name, price, items[], isNew }
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/qcrd?sheet=menu').then(r => r.json()),
      fetch('/api/qcrd?sheet=bom').then(r => r.json()),
      fetch('/api/qcrd?sheet=item').then(r => r.json()),
    ]).then(([m, b, it]) => {
      if (m.status === 'success') setMenus(m.data || []); else setError(m.message || 'โหลดชีท menu ไม่สำเร็จ');
      if (b.status === 'success') setBom(b.data || {});
      if (it.status === 'success') setItems(it.data || []);
    }).catch(err => setError(err.message)).finally(() => setLoading(false));
  };
  useEffect(loadAll, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? menus.filter(m => m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : menus;
    // เมนูที่มีสูตร (BOM) ขึ้นก่อน แล้วค่อยเรียงตามรหัส
    return [...list].sort((a, b) =>
      ((bom[b.code] ? 1 : 0) - (bom[a.code] ? 1 : 0)) || a.code.localeCompare(b.code));
  }, [menus, bom, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [search]);

  const openAdd = () => setEditMenu({ code: '', name: '', price: '', isNew: true, items: [emptyIng()] });
  const openEdit = (m) => {
    const rows = (bom[m.code]?.items || []).map(r => ({
      itemCode: r.itemCode, itemName: r.itemName, qty: r.qty ?? '', converter: r.converter ?? 1000,
    }));
    setEditMenu({ code: m.code, name: m.name, price: m.price ?? '', isNew: false, items: rows.length ? rows : [emptyIng()] });
  };
  const emptyIng = () => ({ itemCode: '', itemName: '', qty: '', converter: 1000 });

  const priceMap = useMemo(() => {
    const map = {};
    items.forEach(i => { map[i.code] = i.price || 0; });
    return map;
  }, [items]);

  const estCost = (rows) => rows.reduce((s, r) => {
    const p = priceMap[r.itemCode] || 0;
    const conv = parseFloat(r.converter) || 1000;
    const qty = parseFloat(r.qty) || 0;
    return s + (conv ? qty * (p / conv) : 0);
  }, 0);

  const handleSave = async () => {
    if (!editMenu.code.trim() || !editMenu.name.trim()) {
      setToast({ ok: false, msg: 'กรุณากรอกรหัสและชื่อเมนู' });
      return;
    }
    setSaving(true);
    setToast(null);
    try {
      const rows = editMenu.items.filter(r => r.itemCode && parseFloat(r.qty) > 0);
      const res = await apiCall('saveMenu', {
        code: editMenu.code.trim(), name: editMenu.name.trim(), price: editMenu.price,
        items: rows.map(r => ({ itemCode: r.itemCode, itemName: r.itemName, qty: parseFloat(r.qty) || 0, converter: parseFloat(r.converter) || 1000 })),
      });
      setToast({ ok: true, msg: `บันทึก "${editMenu.name}" สำเร็จ (${res.data?.bomRows ?? rows.length} วัตถุดิบ)` });
      setEditMenu(null);
      loadAll();
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  const viewMenu = viewCode ? menus.find(m => m.code === viewCode) : null;
  const viewBom = viewCode ? (bom[viewCode]?.items || []) : [];

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-indigo-100 text-indigo-600 rounded-xl"><FileText className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">เมนู (QC/RD)</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {menus.length.toLocaleString()} เมนูจากชีท menu · มีสูตร (BOM) {Object.keys(bom).length.toLocaleString()} เมนู
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {toast && (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
            <button onClick={openAdd}
              className="inline-flex items-center gap-2 bg-indigo-500 hover:bg-indigo-600 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Plus size={14} /> เพิ่มเมนู
            </button>
          </div>
        </div>

        <div className="p-4 border-b border-slate-100">
          <div className="relative max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อเมนู…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
        </div>

        {error && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-center gap-2">
            <AlertCircle size={16} /><span>{error}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">รหัส</th>
                <th className="px-4 py-3 text-left">ชื่อเมนู</th>
                <th className="px-4 py-3 text-right">ราคาขาย</th>
                <th className="px-4 py-3 text-right">ต้นทุน</th>
                <th className="px-4 py-3 text-center">วัตถุดิบ</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดข้อมูล…
                </td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">ไม่พบเมนู</td></tr>
              ) : pageRows.map(m => {
                const nIng = bom[m.code]?.items?.length || 0;
                return (
                  <tr key={m.code} className={`hover:bg-indigo-50/40 ${nIng ? 'cursor-pointer' : ''}`}
                    onClick={() => nIng && setViewCode(m.code)}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{m.code}</td>
                    <td className="px-4 py-2 text-slate-800 font-medium">{m.name}</td>
                    <td className="px-4 py-2 text-right font-mono">{fmt(m.price, 0)}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-600">{fmt(m.cost)}</td>
                    <td className="px-4 py-2 text-center">
                      {nIng ? (
                        <span className="inline-block px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full text-xs font-semibold">{nIng} รายการ</span>
                      ) : <span className="text-slate-300 text-xs">ไม่มีสูตร</span>}
                    </td>
                    <td className="px-4 py-2 text-center whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openEdit(m)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
                        <Pencil size={12} /> แก้ไข
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && totalPages > 1 && (
          <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>แสดง {pageRows.length} จาก {filtered.length.toLocaleString()} เมนู</span>
            <div className="flex items-center gap-2">
              <button disabled={pageSafe <= 1} onClick={() => setPage(p => p - 1)}
                className="p-1.5 border border-slate-200 rounded-lg disabled:opacity-30 hover:bg-slate-50"><ChevronLeft size={14} /></button>
              <span className="font-semibold">{pageSafe} / {totalPages}</span>
              <button disabled={pageSafe >= totalPages} onClick={() => setPage(p => p + 1)}
                className="p-1.5 border border-slate-200 rounded-lg disabled:opacity-30 hover:bg-slate-50"><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      {/* ───── Modal ดูสูตร ───── */}
      {viewMenu && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setViewCode(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-800">สูตร: {viewMenu.name} <span className="font-mono text-xs text-slate-400 ml-1">{viewMenu.code}</span></h3>
                <p className="text-xs text-slate-500 mt-0.5">ราคาขาย {fmt(viewMenu.price, 0)} บาท · ต้นทุนรวม {fmt(viewMenu.cost)} บาท</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { openEdit(viewMenu); setViewCode(null); }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100">
                  <Pencil size={12} /> แก้ไขสูตร
                </button>
                <button onClick={() => setViewCode(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
              </div>
            </div>
            <div className="overflow-auto p-5">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr className="text-xs font-bold">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">รหัส</th>
                    <th className="px-3 py-2 text-left">วัตถุดิบ</th>
                    <th className="px-3 py-2 text-right">ยอดใช้</th>
                    <th className="px-3 py-2 text-right">ตัวแปลงหน่วย</th>
                    <th className="px-3 py-2 text-right">ราคาวัตถุดิบ</th>
                    <th className="px-3 py-2 text-right">ต้นทุน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {viewBom.map((r, i) => (
                    <tr key={i} className={/ยกเลิก/.test(r.itemName) ? 'text-slate-300 line-through' : ''}>
                      <td className="px-3 py-1.5 text-slate-400">{r.seq || i + 1}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{r.itemCode}</td>
                      <td className="px-3 py-1.5">{r.itemName}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmt(r.qty, 2)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-slate-400">{fmt(r.converter, 0)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmt(r.itemPrice)}</td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmt(r.lineCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-indigo-200 font-bold">
                    <td colSpan={6} className="px-3 py-2 text-right">ต้นทุนรวม</td>
                    <td className="px-3 py-2 text-right font-mono text-indigo-600">
                      {fmt(viewBom.reduce((s, r) => s + (r.lineCost || 0), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ───── Modal เพิ่ม/แก้ไขเมนู ───── */}
      {editMenu && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => !saving && setEditMenu(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{editMenu.isNew ? '➕ เพิ่มเมนูใหม่' : `✏️ แก้ไขเมนู ${editMenu.code}`}</h3>
              <button onClick={() => setEditMenu(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
            </div>

            <div className="p-5 overflow-auto space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-500">รหัสเมนู (POS)</label>
                  <input value={editMenu.code} disabled={!editMenu.isNew}
                    onChange={e => setEditMenu(m => ({ ...m, code: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">ชื่อเมนู</label>
                  <input value={editMenu.name} onChange={e => setEditMenu(m => ({ ...m, name: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">ราคาขาย (บาท)</label>
                  <input type="number" value={editMenu.price} onChange={e => setEditMenu(m => ({ ...m, price: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-slate-500">วัตถุดิบในสูตร (ยอดใช้เป็นหน่วยเล็ก เช่น กรัม · ตัวแปลง = หน่วยเล็กต่อ 1 หน่วยซื้อ)</label>
                  <button onClick={() => setEditMenu(m => ({ ...m, items: [...m.items, emptyIng()] }))}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">
                    <Plus size={13} /> เพิ่มวัตถุดิบ
                  </button>
                </div>
                <div className="hidden sm:flex items-center gap-2 px-2 text-[11px] font-bold text-slate-400 uppercase tracking-wide">
                  <span className="flex-1 min-w-[240px]">วัตถุดิบ</span>
                  <span className="w-24 text-right">ยอดใช้</span>
                  <span className="w-24 text-right">ตัวแปลงหน่วย</span>
                  <span className="w-8" />
                </div>
                <div className="space-y-2">
                  {editMenu.items.map((r, idx) => (
                    <IngredientRow key={idx} row={r} items={items}
                      onChange={next => setEditMenu(m => ({ ...m, items: m.items.map((x, i) => i === idx ? next : x) }))}
                      onRemove={() => setEditMenu(m => ({ ...m, items: m.items.filter((_, i) => i !== idx) }))} />
                  ))}
                </div>
              </div>

              <div className="p-3 bg-indigo-50/60 rounded-xl text-sm flex items-center justify-between">
                <span className="text-slate-600 flex items-center gap-1.5"><Info size={14} /> ต้นทุนโดยประมาณ (คำนวณจากราคาวัตถุดิบปัจจุบัน)</span>
                <span className="font-mono font-bold text-indigo-700">฿{fmt(estCost(editMenu.items))}</span>
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2">
              <button onClick={() => setEditMenu(null)} disabled={saving}
                className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ยกเลิก</button>
              <button onClick={handleSave} disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                {saving ? 'กำลังบันทึก…' : 'บันทึกเมนู'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// แถววัตถุดิบในฟอร์ม: ค้นหาไอเทมจากชีท item + กรอกยอดใช้/ตัวแปลง
function IngredientRow({ row, items, onChange, onRemove }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items.filter(i => i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)).slice(0, 12);
  }, [items, query]);

  return (
    <div className="flex flex-wrap items-start gap-2 p-2 bg-slate-50/70 rounded-xl border border-slate-100">
      <div className="relative flex-1 min-w-[240px]">
        {row.itemCode ? (
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm">
            <span className="truncate"><span className="font-mono text-xs text-slate-400 mr-1.5">{row.itemCode}</span>{row.itemName}</span>
            <button onClick={() => { onChange({ ...row, itemCode: '', itemName: '' }); setQuery(''); }}
              className="text-slate-300 hover:text-rose-500 flex-shrink-0"><X size={14} /></button>
          </div>
        ) : (
          <>
            <input value={query} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              placeholder="พิมพ์ค้นหาวัตถุดิบ (รหัส/ชื่อ)…"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            {open && suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-auto">
                {suggestions.map(s => (
                  <button key={s.code} onMouseDown={() => { onChange({ ...row, itemCode: s.code, itemName: s.name }); setOpen(false); }}
                    className="block w-full text-left px-3 py-2 text-sm hover:bg-indigo-50">
                    <span className="font-mono text-xs text-slate-400 mr-1.5">{s.code}</span>{s.name}
                    <span className="float-right text-xs text-slate-400 font-mono">{s.price != null ? s.price.toLocaleString() : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <input type="number" value={row.qty} onChange={e => onChange({ ...row, qty: e.target.value })} placeholder="ยอดใช้"
        className="w-24 px-2 py-2 border border-slate-200 rounded-lg text-sm font-mono text-right bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      <input type="number" value={row.converter} onChange={e => onChange({ ...row, converter: e.target.value })} placeholder="ตัวแปลง" title="หน่วยเล็กต่อ 1 หน่วยซื้อ เช่น 1000 = ซื้อเป็น กก. ใช้เป็นกรัม"
        className="w-24 px-2 py-2 border border-slate-200 rounded-lg text-sm font-mono text-right bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      <button onClick={onRemove} className="p-2 text-slate-300 hover:text-rose-500"><Trash2 size={15} /></button>
    </div>
  );
}
