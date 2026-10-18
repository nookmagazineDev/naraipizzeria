import React, { useState, useMemo } from 'react';
import { Loader2, AlertCircle, CheckCircle, X, Search, AlertTriangle } from 'lucide-react';
import { apiCall, syncOk, syncNote } from '../lib/qcrdApi';
import { nudgeModal } from '../lib/modalNudge';

/*
 * หน้าวัตถุดิบ QC/RD — "วัตถุดิบนี้ใช้ในเมนูไหนบ้าง" + แก้ยอดใช้ในแต่ละเมนูได้จากตรงนี้เลย
 *
 * ข้อมูลมาจากสูตรเมนู (qcrd_bom) ชุดเดียวกับหน้าเมนู ไม่ได้เก็บแยก
 * บันทึกด้วย saveMenu ตัวเดียวกับปุ่ม "บันทึกเมนู" ในหน้าเมนู — saveMenu เขียนทับสูตรทั้งเมนู
 * จึงต้องส่งทุกบรรทัดของเมนูนั้นกลับไปครบ (เปลี่ยนแค่ยอดใช้ของแถวที่แก้) ไม่งั้นบรรทัดอื่นจะหาย
 * ราคา/หมวด/ปริมาณที่ได้ก็ส่งค่าเดิมกลับไปด้วยเหตุผลเดียวกัน (ดู copyRcpToBom ใน QcRdMenu.jsx)
 */

// เทียบรหัสมองข้าม 0 นำหน้า (ระบบคลังใช้ 01000078 / ชีท item เก็บ 1000078)
export const itemKey = (code) => String(code || '').trim().replace(/^0+/, '').toLowerCase();

const fmtQty = (n) => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 4 });
const fmtMoney = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** { itemKey: [{ menuCode, menuName, groupName, idx, row }] } — idx = ลำดับบรรทัดในสูตรของเมนูนั้น */
export function buildUsageIndex(menus, bom) {
  const menuBy = new Map((menus || []).map(m => [m.code, m]));
  const out = {};
  Object.entries(bom || {}).forEach(([menuCode, b]) => {
    const m = menuBy.get(menuCode);
    (b.items || []).forEach((row, idx) => {
      const k = itemKey(row.itemCode);
      if (!k) return;
      (out[k] ||= []).push({
        menuCode, menuName: m?.name || b.name || menuCode, groupName: m?.groupName || '',
        inactive: m?.status === 'ปิดการใช้งาน', idx, row,
      });
    });
  });
  return out;
}

// บรรทัดสูตรที่อ่านมา → รูปที่ saveMenu รับ (เหมือน handleSave ในหน้าเมนู)
const toSaveRow = (r, qty) => ({
  itemCode: r.itemCode, itemName: r.itemName,
  qty, converter: Number(r.converter) || 1000,
  srcCode: r.srcCode || '', srcName: r.srcName || '',
  srcFactor: r.srcFactor ?? '', srcBase: r.srcBase ?? '',   // ส่งค่าเดิมกลับตามที่อ่านมา ไม่เติมค่าใหม่
  tag: r.tag || '', noDeduct: r.noDeduct ? 'Y' : '',
});

export function ItemUsageDialog({ item, uses, menus, bom, degraded, lockHint, onClose, onSaved }) {
  const [edits, setEdits] = useState({});   // `${menuCode}#${idx}` → ยอดใช้ใหม่ (ตัวเลข)
  const [draft, setDraft] = useState({});   // ข้อความในช่องระหว่างพิมพ์
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);     // { ok, msg }

  const unit = String(item.useUnit || '').trim();
  const price = Number(item.price) || 0;
  const keyOf = (u) => `${u.menuCode}#${u.idx}`;
  const qtyOf = (u) => edits[keyOf(u)] ?? (Number(u.row.qty) || 0);
  const costOf = (u) => {
    const conv = Number(u.row.converter) || Number(item.converter) || 0;
    return conv && price ? qtyOf(u) * price / conv : null;
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? uses.filter(u => `${u.menuCode} ${u.menuName}`.toLowerCase().includes(q)) : uses;
  }, [uses, search]);
  const menuCount = new Set(uses.map(u => u.menuCode)).size;
  const total = uses.reduce((s, u) => s + qtyOf(u), 0);
  const changed = uses.filter(u => edits[keyOf(u)] !== undefined);
  const changedMenus = [...new Set(changed.map(u => u.menuCode))];
  const invalid = Object.values(draft).some(v => v !== undefined && !(parseFloat(v) > 0));

  const onType = (u, v) => {
    const k = keyOf(u);
    setDraft(d => ({ ...d, [k]: v }));
    const n = parseFloat(v);
    setEdits(e => {
      const next = { ...e };
      if (n > 0 && n !== Number(u.row.qty)) next[k] = n; else delete next[k];
      return next;
    });
  };

  const save = async () => {
    if (degraded) { setMsg({ ok: false, msg: lockHint }); setConfirming(false); return; }
    setSaving(true);
    setMsg(null);
    const done = [];
    const failed = [];
    let allSynced = true;
    let note = '';
    for (const code of changedMenus) {
      const m = menus.find(x => x.code === code);
      const rows = bom[code]?.items || [];
      try {
        const res = await apiCall('saveMenu', {
          code, name: m?.name || bom[code]?.name || code, price: m?.price ?? '',
          group: m?.group || '', newGroupName: '',
          yieldQty: m?.yieldQty ?? '', yieldUnit: m?.yieldUnit || '',
          items: rows.map((r, idx) => toSaveRow(r, edits[`${code}#${idx}`] ?? (Number(r.qty) || 0))),
        });
        if (!syncOk(res)) { allSynced = false; note = syncNote(res); }
        done.push(code);
      } catch (err) {
        failed.push(`${m?.name || code}: ${err.message || 'บันทึกไม่สำเร็จ'}`);
      }
    }
    setSaving(false);
    setConfirming(false);
    if (done.length) onSaved(done, edits);
    if (failed.length) {
      // ที่บันทึกผ่านแล้วเอาออกจากรายการแก้ เหลือเฉพาะที่ยังไม่เข้า ให้กดบันทึกซ้ำได้
      setEdits(e => Object.fromEntries(Object.entries(e).filter(([k]) => !done.includes(k.split('#')[0]))));
      setMsg({ ok: false, msg: `บันทึกได้ ${done.length}/${changedMenus.length} เมนู · ไม่ผ่าน: ${failed.join(' · ')}` });
      return;
    }
    setEdits({});
    setDraft({});
    setMsg({ ok: allSynced, msg: `บันทึกแล้ว อัปเดตสูตร ${done.length} เมนูในฐานข้อมูล${note}` });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={nudgeModal}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-bold text-slate-800">{item.name} ใช้ใน {menuCount} เมนู</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              <span className="font-mono">{item.code}</span>
              {' · '}หน่วยใช้ {unit || <span className="text-amber-600">ยังไม่ได้ตั้ง</span>}
              {price > 0 && <> · {item.unit || 'หน่วยซื้อ'}ละ {fmtMoney(price)} บาท</>}
              {Number(item.converter) > 0 && <> (1 {item.unit || 'หน่วยซื้อ'} = {fmtQty(item.converter)} {unit || 'หน่วยใช้'})</>}
            </p>
          </div>
          <button onClick={onClose} disabled={saving} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><X size={20} /></button>
        </div>

        <div className="p-5 overflow-auto space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2.5 py-0.5 bg-slate-100 text-slate-600 rounded-full">รวมทุกเมนู <b className="font-mono">{fmtQty(total)}</b> {unit}</span>
            {menuCount > 0 && <span className="px-2.5 py-0.5 bg-slate-100 text-slate-600 rounded-full">เฉลี่ย <b className="font-mono">{fmtQty(total / menuCount)}</b> {unit}/เมนู</span>}
          </div>
          {uses.length > 6 && (
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาเมนู (รหัส/ชื่อ)…"
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          )}
          <div className="overflow-x-auto border border-slate-100 rounded-xl">
            <table className="w-full text-sm min-w-[620px]">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">รหัสเมนู</th>
                  <th className="px-3 py-2 text-left">ชื่อเมนู</th>
                  <th className="px-3 py-2 text-right">ยอดใช้ต่อ 1 สูตร</th>
                  <th className="px-3 py-2 text-left">หน่วย</th>
                  <th className="px-3 py-2 text-right">ต้นทุนต่อสูตร</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map(u => {
                  const k = keyOf(u);
                  const edited = edits[k] !== undefined;
                  const bad = draft[k] !== undefined && !(parseFloat(draft[k]) > 0);
                  const cost = costOf(u);
                  return (
                    <tr key={k} className={edited ? 'bg-amber-50' : ''}>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{u.menuCode}</td>
                      <td className="px-3 py-2">
                        <span className={u.inactive ? 'text-slate-400' : 'text-slate-800'}>{u.menuName}</span>
                        {u.inactive && <span className="ml-1.5 px-1.5 py-0.5 bg-rose-100 text-rose-600 rounded-full text-[10px] font-bold">ปิดใช้งาน</span>}
                        {u.row.srcName && (
                          <span title="บรรทัดนี้ดึงมาจากสูตรเมนูอื่น — ถ้าแก้สูตรเมนูต้นทาง ยอดใช้ตรงนี้จะถูกคิดใหม่ตามสัดส่วน"
                            className="ml-1.5 px-1.5 py-0.5 bg-sky-50 text-sky-600 border border-sky-100 rounded-full text-[10px]">จาก {u.row.srcName}</span>
                        )}
                        {u.groupName && <div className="text-[11px] text-slate-400">{u.groupName}</div>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <input type="number" min="0" step="any" disabled={saving || degraded}
                          value={draft[k] ?? (Number(u.row.qty) || 0)}
                          onChange={e => onType(u, e.target.value)}
                          className={`w-24 px-2 py-1 border rounded-lg text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 ${bad ? 'border-rose-400' : edited ? 'border-amber-300' : 'border-slate-200'}`} />
                        {edited && <div className="text-[10px] font-mono text-amber-700">เดิม {fmtQty(u.row.qty)}</div>}
                        {bad && <div className="text-[10px] text-rose-600">ต้องมากกว่า 0</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{unit || '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{cost === null ? '—' : `฿${fmtMoney(cost)}`}</td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">ไม่พบเมนู</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400">
            หน่วยใช้เป็นของวัตถุดิบตัวนี้ ใช้เหมือนกันทุกเมนู (แก้ได้ที่ปุ่ม "แก้ไข" ของวัตถุดิบ) · ต้นทุนคิดจากราคาต้นทุนปัจจุบัน
            · ถ้าจะเอาวัตถุดิบออกจากสูตร ให้แก้ที่หน้าเมนู
          </p>
          {msg && (
            <div className={`text-xs font-semibold flex items-start gap-1 ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
              {msg.ok ? <CheckCircle size={13} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />}{msg.msg}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <span className={`text-xs font-semibold ${changedMenus.length ? 'text-amber-700' : 'text-slate-400'}`}>
            {changedMenus.length ? `แก้แล้ว ${changedMenus.length} เมนู (ยังไม่บันทึก)` : 'ยังไม่ได้แก้'}
          </span>
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">
              {changedMenus.length ? 'ยกเลิก' : 'ปิด'}
            </button>
            <button onClick={() => setConfirming(true)} disabled={!changedMenus.length || invalid || saving || degraded}
              title={degraded ? lockHint : ''}
              className="px-5 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
              บันทึกการแก้ไข
            </button>
          </div>
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40" onClick={nudgeModal}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-800">ยืนยันแก้ยอดใช้</h3>
                <p className="text-xs text-slate-500 mt-0.5">{item.name} · {changedMenus.length} เมนู</p>
              </div>
              <button onClick={() => setConfirming(false)} disabled={saving} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><X size={20} /></button>
            </div>
            <div className="p-5 overflow-auto space-y-2">
              {changed.map(u => (
                <div key={keyOf(u)} className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-sm">
                  <span className="min-w-0 truncate">{u.menuName}</span>
                  <span className="font-mono text-xs whitespace-nowrap">
                    <s className="text-slate-400">{fmtQty(u.row.qty)}</s> → <b className="text-amber-700">{fmtQty(edits[keyOf(u)])}</b> {unit}
                  </span>
                </div>
              ))}
              <p className="flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                กดยืนยันแล้วจะอัปเดตสูตรของเมนูเหล่านี้ในฐานข้อมูลทันที ต้นทุนเมนู (และเมนูที่ดึงสูตรนี้ไปใช้) จะคิดใหม่ตามยอดใช้ใหม่
              </p>
            </div>
            <div className="p-5 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} disabled={saving}
                className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">กลับไปแก้</button>
              <button onClick={save} disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-300 rounded-xl">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                {saving ? 'กำลังบันทึก…' : 'ยืนยันบันทึก'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
