import React, { useState, useEffect, useMemo } from 'react';
import { Building2, Search, Loader2, AlertCircle, CheckCircle, Plus, Pencil, X, Trash2, AlertTriangle, Info, Save, ArrowRightLeft, UploadCloud } from 'lucide-react';
import { STATUS_ACTIVE, STATUS_INACTIVE, validateCode, normalizeCode } from '../lib/branches';

/*
 * HR — จัดการสาขา: ทะเบียนสาขากลางที่ dropdown ทุกหน้าดึงไปใช้
 * (ดูสแกนหน้า · QC/RD วัตถุดิบ "สาขาที่ใช้" · ค่าใช้จ่ายอื่นๆ)
 *
 * เก็บที่ตาราง InventoryNarai.dbo.hr_branch อ่าน/เขียนผ่าน /api/branches
 * ⚠️ คนละตัวกับ narai_hr.dbo.hr_branch ของระบบลงตารางงาน (โปรเจกต์ Narai-branch)
 *    ปุ่ม "เทียบกับตารางงาน" มีไว้ดูว่ารหัสสาขาสองที่ยังตรงกันอยู่ไหม
 *
 * สิ่งที่หน้านี้ทำไม่ได้ (ต้องไปทำที่ระบบปลายทาง):
 *   - ขอรหัสร้าน POS ให้สาขาใหม่ — ต้องได้เลขมาจากฝั่ง POS แล้วเอามากรอกที่นี่
 *   - ตั้ง area_alias บนเครื่องสแกนหน้า ZKBio — ไม่ตั้ง หน้า "ดูสแกนหน้า" จะไม่เห็นสาขานั้น
 */

const EMPTY_FORM = { code: '', name: '', outletId: '', status: STATUS_ACTIVE, note: '', sortOrder: '' };

export default function BranchList() {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);          // { ok, msg }
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [source, setSource] = useState('sql');       // 'sql' = อ่านจากฐานจริง, 'fallback' = รายชื่อในโค้ด
  const [tableReady, setTableReady] = useState(true);
  const [canWrite, setCanWrite] = useState(true);    // false = ยังไม่ได้ตั้งรหัสฐานบน Vercel แก้อะไรไม่ได้เลย
  const [creating, setCreating] = useState(false);   // กำลังสร้างตาราง
  const [comparing, setComparing] = useState(false); // กำลังเทียบกับระบบตารางงาน
  const [compare, setCompare] = useState(null);      // ผลเทียบล่าสุด
  const [editing, setEditing] = useState(null);      // { ...form, isNew }
  const [savingItem, setSavingItem] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // quiet = โหลดใหม่เบื้องหลังหลังกดบันทึก (ตารางเดิมยังอ่านได้ระหว่างรอ)
  // ?t= กันไม่ให้ CDN คืนของที่แคชไว้ก่อนการบันทึกรอบนี้
  const load = ({ quiet = false, withCompare = false } = {}) => {
    if (!quiet) setLoading(true);
    const qs = [quiet ? `t=${Date.now()}` : '', withCompare ? 'compare=1' : ''].filter(Boolean).join('&');
    return fetch(`/api/branches${qs ? `?${qs}` : ''}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.status !== 'success') { setError(res.message || 'โหลดทะเบียนสาขาไม่สำเร็จ'); return; }
        setBranches(res.data || []);
        setSource(res.source || 'sql');
        setTableReady(res.tableReady !== false);
        setCanWrite(res.canWrite !== false);
        setError('');
        if (res.compare) setCompare(res.compare);
        // ตั้ง toast เฉพาะตอนมี warning จริง ไม่งั้นจะไปลบข้อความ "บันทึกสำเร็จ" ที่เพิ่งขึ้น
        if (res.warning) setToast({ ok: false, msg: res.warning });
      })
      .catch((err) => setError(err.message))
      .finally(() => { if (!quiet) setLoading(false); });
  };
  useEffect(() => { load(); }, []);

  const post = async (action, payload = {}) => {
    const r = await fetch('/api/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    const res = await r.json();
    if (res.status !== 'success') throw new Error(res.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
    return res;
  };

  const activeCount = useMemo(() => branches.filter((b) => b.status !== STATUS_INACTIVE).length, [branches]);
  const noOutletCount = useMemo(() => branches.filter((b) => !b.outletId).length, [branches]);
  const noNameCount = useMemo(() => branches.filter((b) => !b.name).length, [branches]);

  // แก้ทะเบียนได้ก็ต่อเมื่อมีตารางแล้วและต่อฐานเพื่อเขียนได้จริง
  const editable = tableReady && canWrite;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return branches.filter((b) => {
      if (statusFilter && (b.status || STATUS_ACTIVE) !== statusFilter) return false;
      if (!q) return true;
      return b.code.toLowerCase().includes(q)
        || (b.name || '').toLowerCase().includes(q)
        || String(b.outletId || '').includes(q);
    });
  }, [branches, search, statusFilter]);

  const openNew = () => {
    // ลำดับถัดจากตัวท้ายสุด — สาขาใหม่จะได้ไปต่อท้าย dropdown ไม่ไปแทรกกลาง
    const nextSort = branches.reduce((max, b) => Math.max(max, b.sortOrder || 0), 0) + 1;
    setEditing({ ...EMPTY_FORM, sortOrder: String(nextSort), isNew: true });
    setToast(null);
  };

  const openEdit = (b) => {
    setEditing({
      code: b.code,
      name: b.name || '',
      outletId: b.outletId == null ? '' : String(b.outletId),
      status: b.status || STATUS_ACTIVE,
      note: b.note || '',
      sortOrder: String(b.sortOrder || 0),
      isNew: false,
    });
    setToast(null);
  };

  const saveEdit = async () => {
    const code = normalizeCode(editing.code);
    const bad = validateCode(code);
    if (bad) { setToast({ ok: false, msg: bad }); return; }
    // รหัสซ้ำตอนเพิ่มใหม่ ฝั่งฐานจะกลายเป็น "แก้ทับ" เงียบ ๆ (MERGE) — ดักตั้งแต่ในฟอร์ม
    if (editing.isNew && branches.some((b) => normalizeCode(b.code) === code)) {
      setToast({ ok: false, msg: `มีสาขา ${code} ในทะเบียนอยู่แล้ว — กดแก้ไขที่แถวนั้นแทน` });
      return;
    }
    setSavingItem(true);
    try {
      await post('saveBranch', {
        code,
        name: editing.name,
        outletId: editing.outletId,
        status: editing.status,
        note: editing.note,
        sortOrder: editing.sortOrder,
      });
      setEditing(null);
      setToast({ ok: true, msg: `บันทึกสาขา ${code} แล้ว` });
      await load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setSavingItem(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await post('deleteBranch', { code: deleteTarget.code });
      const gone = deleteTarget.code;
      setDeleteTarget(null);
      setToast({ ok: true, msg: `ลบสาขา ${gone} ออกจากทะเบียนแล้ว` });
      await load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setDeleting(false);
    }
  };

  const doCreateTable = async () => {
    setCreating(true);
    setToast(null);
    try {
      const res = await post('createTable');
      setToast({ ok: true, msg: `สร้างตารางทะเบียนสาขาแล้ว (รัน ${res.data?.ran ?? 0} คำสั่ง) — เริ่มแก้ไขได้เลย` });
      await load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setCreating(false);
    }
  };

  const doCompare = async () => {
    setComparing(true);
    setToast(null);
    await load({ quiet: true, withCompare: true });
    setComparing(false);
  };

  /* เติมชื่อไทยจากระบบตารางงานให้สาขาที่ยังไม่มีชื่อ — ทีละตัวผ่าน saveBranch
     ไม่เขียนทับชื่อที่กรอกไว้เองแล้ว เพราะฝั่งตารางงานอาจสะกดคนละแบบ */
  const fillNamesFromSchedule = async () => {
    const names = compare?.names || {};
    const targets = branches.filter((b) => !b.name && names[normalizeCode(b.code)]);
    if (!targets.length) { setToast({ ok: false, msg: 'ไม่มีสาขาที่เติมชื่อได้จากระบบตารางงาน' }); return; }
    setSavingItem(true);
    let ok = 0;
    const failed = [];
    for (const b of targets) {
      try {
        await post('saveBranch', {
          code: b.code, name: names[normalizeCode(b.code)], outletId: b.outletId,
          status: b.status, note: b.note, sortOrder: b.sortOrder,
        });
        ok++;
      } catch { failed.push(b.code); }
    }
    setSavingItem(false);
    setToast({
      ok: failed.length === 0,
      msg: `เติมชื่อสาขาแล้ว ${ok} รายการ${failed.length ? ` · ไม่สำเร็จ ${failed.length} (${failed.join(', ')})` : ''}`,
    });
    await load({ quiet: true });
  };

  const nameFillable = useMemo(() => {
    const names = compare?.names || {};
    return branches.filter((b) => !b.name && names[normalizeCode(b.code)]).length;
  }, [branches, compare]);

  return (
    <div className="w-full space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-amber-100 text-amber-600 rounded-xl"><Building2 className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">จัดการสาขา</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {branches.length} สาขา · ใช้งาน {activeCount}
                {branches.length - activeCount > 0 && ` · ปิดการใช้งาน ${branches.length - activeCount}`}
                {noNameCount > 0 && ` · ยังไม่ได้ตั้งชื่อ ${noNameCount}`}
                {noOutletCount > 0 && (
                  <span className="text-amber-600 font-semibold"> · ไม่มีรหัสร้าน POS {noOutletCount}</span>
                )}
                {source === 'fallback' && (
                  <span className="text-rose-600 font-semibold"> · กำลังใช้รายชื่อสำรองในโค้ด</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {toast?.ok && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                <CheckCircle size={13} />{toast.msg}
              </span>
            )}
            {!tableReady && canWrite && (
              <button onClick={doCreateTable} disabled={creating}
                title="สร้างตาราง InventoryNarai.dbo.hr_branch แล้วใส่สาขาตั้งต้น 21 สาขา (รันซ้ำได้ ไม่ทับข้อมูลเดิม)"
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
                {creating ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
                สร้างตาราง
              </button>
            )}
            <button onClick={doCompare} disabled={comparing}
              title="เทียบรหัสสาขาในทะเบียนนี้ กับรายชื่อสาขาของระบบลงตารางงาน (narai_hr) ว่ายังตรงกันไหม"
              className="inline-flex items-center gap-2 bg-white hover:bg-slate-50 disabled:text-slate-300 border border-slate-200 text-slate-600 font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              {comparing ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
              เทียบกับตารางงาน
            </button>
            <button onClick={openNew} disabled={!editable}
              title={editable ? 'เพิ่มสาขาใหม่ลงทะเบียน'
                : canWrite ? 'ต้องสร้างตารางก่อนจึงจะเพิ่มสาขาได้'
                : 'ยังไม่ได้ตั้งรหัสฐานข้อมูลบน Vercel จึงแก้ทะเบียนไม่ได้'}
              className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Plus size={14} /> เพิ่มสาขา
            </button>
          </div>
        </div>

        <div className="p-4 flex flex-wrap gap-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อสาขา / รหัสร้าน POS…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
            <option value="">ทุกสถานะ</option>
            <option value={STATUS_ACTIVE}>{STATUS_ACTIVE}</option>
            <option value={STATUS_INACTIVE}>{STATUS_INACTIVE}</option>
          </select>
        </div>

        {(error || (toast && !toast.ok)) && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span className="break-words">{error || toast.msg}</span>
          </div>
        )}

        {/* ผลเทียบกับระบบลงตารางงาน — ทะเบียนสองที่คนละฐาน ต้องตามให้ตรงกันเอง */}
        {compare && (
          <div className={`m-4 p-3 rounded-xl text-sm border flex items-start gap-2 ${
            !compare.ok ? 'bg-slate-50 border-slate-200 text-slate-600'
              : (compare.missingInRegistry.length || compare.missingInSchedule.length)
                ? 'bg-amber-50 border-amber-100 text-amber-800'
                : 'bg-emerald-50 border-emerald-100 text-emerald-700'
          }`}>
            <Info size={16} className="shrink-0 mt-0.5" />
            <div className="space-y-1 break-words">
              {!compare.ok ? (
                <div>เทียบกับระบบตารางงานไม่ได้: {compare.message} (เครื่องออฟฟิศอาจไม่ได้เปิดอยู่)</div>
              ) : (
                <>
                  <div className="font-semibold">
                    ระบบลงตารางงาน (narai_hr) มี {compare.scheduleCount} สาขา · ทะเบียนนี้มี {branches.length} สาขา
                  </div>
                  {compare.missingInRegistry.length > 0 && (
                    <div>มีในตารางงานแต่ยังไม่มีในทะเบียนนี้: <b>{compare.missingInRegistry.join(', ')}</b> — กด "เพิ่มสาขา" เพื่อเติม</div>
                  )}
                  {compare.missingInSchedule.length > 0 && (
                    <div>มีในทะเบียนนี้แต่ระบบตารางงานไม่รู้จัก: <b>{compare.missingInSchedule.join(', ')}</b> — สาขาพวกนี้จะลงตารางงานไม่ได้</div>
                  )}
                  {!compare.missingInRegistry.length && !compare.missingInSchedule.length && (
                    <div>รหัสสาขาสองที่ตรงกันครบทุกตัว</div>
                  )}
                  {nameFillable > 0 && (
                    <button onClick={fillNamesFromSchedule} disabled={savingItem}
                      className="mt-1 inline-flex items-center gap-1.5 bg-white hover:bg-slate-50 border border-amber-200 text-amber-700 font-semibold text-xs px-3 py-1.5 rounded-lg transition-all">
                      {savingItem ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      เติมชื่อไทยจากตารางงานให้ {nameFillable} สาขาที่ยังไม่มีชื่อ
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-right w-16">ลำดับ</th>
                <th className="px-4 py-3 text-left">รหัสสาขา</th>
                <th className="px-4 py-3 text-left">ชื่อสาขา</th>
                <th className="px-4 py-3 text-right">รหัสร้าน POS</th>
                <th className="px-4 py-3 text-center">สถานะ</th>
                <th className="px-4 py-3 text-left">หมายเหตุ</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดทะเบียนสาขา…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">ไม่พบสาขา</td></tr>
              ) : filtered.map((b) => (
                <tr key={b.code} className={`hover:bg-slate-50/60 ${b.status === STATUS_INACTIVE ? 'bg-rose-50/40 text-slate-400' : ''}`}>
                  <td className="px-4 py-2 text-right font-mono text-xs text-slate-400">{b.sortOrder || '—'}</td>
                  <td className="px-4 py-2 font-mono text-sm font-bold text-slate-700 whitespace-nowrap">{b.code}</td>
                  <td className="px-4 py-2 text-slate-700">
                    {b.name || <span className="text-slate-300 italic text-xs">ยังไม่ได้ตั้งชื่อ</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {b.outletId != null ? b.outletId : (
                      <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                        <AlertTriangle size={11} />ยังไม่มี
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${
                      b.status === STATUS_INACTIVE ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-700'
                    }`}>{b.status || STATUS_ACTIVE}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500 max-w-[240px] truncate" title={b.note}>{b.note || '—'}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => openEdit(b)} disabled={!editable} title="แก้ไขสาขานี้"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 disabled:text-slate-200 disabled:hover:bg-transparent transition-all">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => setDeleteTarget(b)} disabled={!editable} title="ลบสาขานี้ออกจากทะเบียน"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:text-slate-200 disabled:hover:bg-transparent transition-all">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-slate-100 bg-slate-50/60 text-xs text-slate-500 flex items-start gap-2">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            รายชื่อนี้คุม dropdown เลือกสาขาของหน้า <b>ดูสแกนหน้า</b>, <b>QC/RD วัตถุดิบ</b> และ <b>ค่าใช้จ่ายอื่นๆ</b> ·
            เปิดสาขาใหม่ให้ใช้ได้จริงต้องขอ <b>รหัสร้าน POS</b> จากฝั่ง POS และตั้ง <b>area_alias</b> ที่เครื่องสแกนหน้าด้วย ·
            รายงานยอดขาย/ต้นทุนยังใช้ตารางแมป outlet ชุดของตัวเองอยู่ ยังไม่ได้ต่อกับทะเบียนนี้
          </span>
        </div>
      </div>

      {/* ── ฟอร์มเพิ่ม/แก้ไขสาขา ── */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !savingItem && setEditing(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{editing.isNew ? 'เพิ่มสาขาใหม่' : `แก้ไขสาขา ${editing.code}`}</h3>
              <button onClick={() => setEditing(null)} disabled={savingItem} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสสาขา *</label>
                <input value={editing.code} disabled={!editing.isNew}
                  onChange={(e) => setEditing((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                  placeholder="เช่น SJP, P90"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500" />
                <p className="text-[11px] text-slate-400 mt-1">
                  {editing.isNew
                    ? 'ตัวอักษรอังกฤษหรือตัวเลข 2–10 ตัว · ต้องตรงกับ area_alias ที่ตั้งไว้บนเครื่องสแกนหน้า'
                    : 'แก้รหัสสาขาไม่ได้ — ข้อมูลเก่า (ตารางงาน สแกนหน้า ค่าใช้จ่าย สาขาที่ใช้วัตถุดิบ) อ้างรหัสนี้อยู่ จะเปลี่ยนรหัสให้เพิ่มสาขาใหม่แล้วปิดตัวเก่าแทน'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">ชื่อสาขา (ภาษาไทย)</label>
                <input value={editing.name} onChange={(e) => setEditing((f) => ({ ...f, name: e.target.value }))}
                  placeholder="เช่น สาขาเซ็นทรัลพระราม 9"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสร้าน POS</label>
                  <input value={editing.outletId} inputMode="numeric"
                    onChange={(e) => setEditing((f) => ({ ...f, outletId: e.target.value }))}
                    placeholder="เช่น 7"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500" />
                  <p className="text-[11px] text-slate-400 mt-1">เว้นว่างได้ถ้ายังไม่ได้เลขมา · ห้ามซ้ำกับสาขาอื่น</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">ลำดับใน dropdown</label>
                  <input value={editing.sortOrder} inputMode="numeric"
                    onChange={(e) => setEditing((f) => ({ ...f, sortOrder: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">สถานะ</label>
                <select value={editing.status} onChange={(e) => setEditing((f) => ({ ...f, status: e.target.value }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
                  <option value={STATUS_ACTIVE}>{STATUS_ACTIVE}</option>
                  <option value={STATUS_INACTIVE}>{STATUS_INACTIVE}</option>
                </select>
                <p className="text-[11px] text-slate-400 mt-1">ปิดการใช้งาน = ไม่โผล่ใน dropdown ของหน้าอื่น แต่ข้อมูลเก่ายังอ้างรหัสนี้ได้</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">หมายเหตุ</label>
                <input value={editing.note} onChange={(e) => setEditing((f) => ({ ...f, note: e.target.value }))}
                  placeholder="เช่น เปิด 1 ม.ค. 69 / ปิดปรับปรุง"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>

              {editing.isNew && (
                <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800 flex items-start gap-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span>
                    เพิ่มที่นี่แล้วสาขาจะโผล่ใน dropdown ทันที แต่ยัง<b>ไม่พร้อมใช้จริง</b>จนกว่าจะ
                    ตั้ง area_alias ที่เครื่องสแกนหน้า ZKBio และเพิ่มสาขาในระบบลงตารางงานด้วย
                  </span>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} disabled={savingItem}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button onClick={saveEdit} disabled={savingItem}
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-sm px-5 py-2 rounded-xl transition-all">
                {savingItem ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                บันทึก
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ยืนยันการลบ ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 space-y-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-rose-100 text-rose-600 rounded-xl"><AlertTriangle className="w-5 h-5" /></div>
                <h3 className="font-bold text-slate-800">ลบสาขา {deleteTarget.code}?</h3>
              </div>
              <p className="text-sm text-slate-600">
                แนะนำให้<b>ตั้งสถานะเป็น "ปิดการใช้งาน" แทนการลบ</b> — ข้อมูลเก่าอย่างตารางงาน
                เวลาสแกนหน้า ค่าใช้จ่ายรายเดือน และคอลัมน์ "สาขาที่ใช้" ของวัตถุดิบ ยังอ้างรหัส
                <b> {deleteTarget.code} </b> อยู่ ลบทิ้งแล้วรายงานย้อนหลังจะหาชื่อสาขาไม่เจอ
              </p>
              <p className="text-xs text-slate-400">
                การลบนี้แตะเฉพาะทะเบียนในฐาน InventoryNarai ไม่ได้ไปลบข้อมูลที่ระบบอื่นเก็บไว้
              </p>
            </div>
            <div className="p-5 pt-0 flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button
                onClick={async () => {
                  const b = deleteTarget;
                  setDeleteTarget(null);
                  setSavingItem(true);
                  try {
                    await post('saveBranch', {
                      code: b.code, name: b.name, outletId: b.outletId,
                      status: STATUS_INACTIVE, note: b.note, sortOrder: b.sortOrder,
                    });
                    setToast({ ok: true, msg: `ปิดการใช้งานสาขา ${b.code} แล้ว` });
                    await load({ quiet: true });
                  } catch (err) {
                    setToast({ ok: false, msg: err.message });
                  } finally { setSavingItem(false); }
                }}
                disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200">
                ปิดการใช้งานแทน
              </button>
              <button onClick={doDelete} disabled={deleting}
                className="inline-flex items-center gap-2 bg-rose-500 hover:bg-rose-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-sm px-4 py-2 rounded-xl transition-all">
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                ลบถาวร
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
