import React, { useState, useEffect, useMemo } from 'react';
import {
  KeyRound, Search, Loader2, AlertCircle, CheckCircle, Plus, Pencil, X, Trash2,
  AlertTriangle, Info, Save, ShieldAlert, Clock,
} from 'lucide-react';
import { useBranches } from '../lib/useBranches';
import { STATUS_INACTIVE } from '../lib/branches';

/*
 * HR — login สาขา: บัญชีที่สาขาใช้เข้าระบบลงตารางงาน (โปรเจค Narai-branch)
 *
 * เก็บที่ตาราง narai_hr.dbo.hr_user อ่าน/เขียนผ่าน /api/branch-users
 * ⚠️ คนละฐานกับทุกอย่างในแดชบอร์ดนี้ (narai_hr ไม่ใช่ InventoryNarai) แต่อยู่อินสแตนซ์
 *    เดียวกัน จึงยิงถึงด้วยชื่อสามท่อน — ไม่ได้ย้ายตาราง ระบบลงตารางงานยังใช้ตารางเดิมต่อไป
 *
 * เดิมตารางนี้ไม่มีหน้าจอเลย ต้องเปิด SSMS แล้ว UPDATE เอง
 *
 * ⚠️ รหัสผ่านที่ตั้งจากหน้านี้ถูกเข้ารหัสด้วยรูปแบบของฝั่งตารางงาน (lib/hrUserHash.mjs)
 *    ไม่ใช่รูปแบบของบัญชีออฟฟิศ — คนที่ตรวจตอนสาขาล็อกอินคือ office-server ของอีกโปรเจค
 *
 * สิ่งที่หน้านี้ทำไม่ได้:
 *   - ดูรหัสผ่านเดิม — เก็บเป็นค่าที่ย้อนกลับไม่ได้ ลืมแล้วมีทางเดียวคือตั้งใหม่
 *   - แก้ชื่อผู้ใช้ — เป็นคีย์ และบันทึกการแก้ตารางงานอ้างชื่อนี้อยู่
 */

const EMPTY_FORM = {
  username: '', branch: '', outletId: '', displayName: '', isActive: true, password: '',
};

const ALL_BRANCHES = 'all';

/** 'SUM, IPR' -> ['sum','ipr'] — กติกาเดียวกับ splitBranches ใน lib/branchUserSql.mjs */
const splitBranches = (v) =>
  String(v ?? '').trim().toLowerCase().split(/[,/|;+&]+|\s+/).map((s) => s.trim()).filter(Boolean);

const fmtLastLogin = (iso) => {
  if (!iso) return 'ยังไม่เคยเข้าใช้';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
};

export default function BranchUserList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [toast, setToast] = useState(null);
  // ข้อความในกล่อง — กล่องเป็น fixed inset-0 z-50 คลุมทั้งจอ แถบเตือนของหน้าจึงอยู่ข้างหลัง
  // บันทึกไม่ผ่านแล้วส่งไปที่นั่นอย่างเดียว = คนกดเห็นว่า "กดแล้วเงียบ" (ดู formMsg ใน EmployeeList.jsx)
  const [formMsg, setFormMsg] = useState(null);       // { ok, msg }
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);   // { ...form, isNew }
  const [saving, setSaving] = useState(false);
  const [pwdTarget, setPwdTarget] = useState(null);
  const [newPwd, setNewPwd] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // รวมสาขาที่ปิดไปแล้วด้วย — บัญชีเก่าอาจยังผูกกับสาขาที่ปิด ต้องแสดงให้เห็นว่าผูกอยู่กับอะไร
  const { branches } = useBranches({ activeOnly: false });

  const load = ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    return fetch(`/api/branch-users${quiet ? `?t=${Date.now()}` : ''}`)
      .then(async (r) => {
        const res = await r.json();
        if (r.status === 403) { setError(res.message); setUsers([]); return; }
        if (res.status !== 'success') { setError(res.message || 'โหลดรายชื่อบัญชีสาขาไม่สำเร็จ'); return; }
        setUsers(res.data || []);
        setWarning(res.warning || '');
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => { if (!quiet) setLoading(false); });
  };
  useEffect(() => { load(); }, []);

  const post = async (action, payload = {}) => {
    const r = await fetch('/api/branch-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    const res = await r.json();
    if (res.status !== 'success') throw new Error(res.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
    return res;
  };

  const activeCount = useMemo(() => users.filter((u) => u.isActive).length, [users]);
  // รหัสที่ยังเก็บเป็นข้อความล้วน = ของตกค้างจากตอนย้ายมาจากชีท ใครเปิดฐานได้ก็อ่านได้
  const plainCount = useMemo(() => users.filter((u) => u.hasPassword && !u.passwordHashed).length, [users]);
  const noPwdCount = useMemo(() => users.filter((u) => !u.hasPassword).length, [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.username.toLowerCase().includes(q)
      || u.branch.toLowerCase().includes(q)
      || (u.displayName || '').toLowerCase().includes(q));
  }, [users, search]);

  const openNew = () => { setEditing({ ...EMPTY_FORM, isNew: true }); setToast(null); setFormMsg(null); };
  const openEdit = (u) => {
    setEditing({
      username: u.username,
      branch: u.branch,
      outletId: u.outletId || '',
      displayName: u.displayName || '',
      isActive: u.isActive,
      password: '',
      isNew: false,
    });
    setToast(null);
    setFormMsg(null);
  };

  const saveEdit = async () => {
    const username = editing.username.trim();
    if (!username) { setFormMsg({ ok: false, msg: 'ต้องกรอกชื่อผู้ใช้' }); return; }
    if (!splitBranches(editing.branch).length) {
      setFormMsg({ ok: false, msg: 'ต้องเลือกสาขาของบัญชีนี้' }); return;
    }
    // ชื่อซ้ำตอนเพิ่มใหม่จะกลายเป็น "แก้ทับ" เงียบ ๆ (MERGE) — ดักตั้งแต่ในฟอร์ม
    if (editing.isNew && users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      setFormMsg({ ok: false, msg: `มีบัญชี ${username} อยู่แล้ว — กดแก้ไขที่แถวนั้นแทน` });
      return;
    }
    setSaving(true);
    setFormMsg(null);
    try {
      await post('saveBranchUser', {
        username,
        branch: editing.branch,
        outletId: editing.outletId,
        displayName: editing.displayName,
        isActive: editing.isActive,
        // ช่องว่าง = ไม่เปลี่ยนรหัสเดิม (ฝั่งเซิร์ฟเวอร์ถือว่า "ไม่ได้ส่งมา")
        ...(editing.password ? { password: editing.password } : {}),
      });
      setEditing(null);
      setToast({ ok: true, msg: `บันทึกบัญชี ${username} แล้ว` });
      await load({ quiet: true });
    } catch (err) {
      // กล่องยังเปิดค้างพร้อมค่าที่กรอกไว้ ต้องบอกในกล่อง · ส่งไปหัวหน้าด้วยเผื่อปิดกล่องไปแล้ว
      setFormMsg({ ok: false, msg: err.message });
      setToast({ ok: false, msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  const savePassword = async () => {
    setSaving(true);
    try {
      await post('setBranchUserPassword', { username: pwdTarget.username, password: newPwd });
      const who = pwdTarget.username;
      setPwdTarget(null);
      setNewPwd('');
      setToast({ ok: true, msg: `ตั้งรหัสใหม่ให้ ${who} แล้ว — แจ้งรหัสให้สาขาด้วย` });
      await load({ quiet: true });
    } catch (err) {
      setFormMsg({ ok: false, msg: err.message });
      setToast({ ok: false, msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await post('deleteBranchUser', { username: deleteTarget.username });
      const gone = deleteTarget.username;
      setDeleteTarget(null);
      setToast({ ok: true, msg: `ลบบัญชี ${gone} แล้ว` });
      await load({ quiet: true });
    } catch (err) {
      setFormMsg({ ok: false, msg: err.message });
      setToast({ ok: false, msg: err.message });
    } finally {
      setDeleting(false);
    }
  };

  const deactivate = async (u) => {
    setSaving(true);
    try {
      await post('saveBranchUser', {
        username: u.username, branch: u.branch, outletId: u.outletId,
        displayName: u.displayName, isActive: false,
      });
      setToast({ ok: true, msg: `ปิดการใช้งานบัญชี ${u.username} แล้ว` });
      await load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  /* ───────── ตัวเลือกสาขาในฟอร์ม ───────── */

  const isAll = splitBranches(editing?.branch).includes(ALL_BRANCHES);
  const picked = isAll ? [] : splitBranches(editing?.branch);

  const toggleBranch = (code) => {
    const c = code.toLowerCase();
    const next = picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c];
    setEditing((f) => ({ ...f, branch: next.join(', ') }));
  };

  return (
    <div className="w-full space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-amber-100 text-amber-600 rounded-xl"><KeyRound className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">login สาขา</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {users.length} บัญชี · ใช้งาน {activeCount}
                {users.length - activeCount > 0 && ` · ปิดการใช้งาน ${users.length - activeCount}`}
                {plainCount > 0 && (
                  <span className="text-rose-600 font-semibold"> · รหัสยังไม่ได้เข้ารหัส {plainCount}</span>
                )}
                {noPwdCount > 0 && (
                  <span className="text-amber-600 font-semibold"> · ไม่มีรหัสผ่าน {noPwdCount}</span>
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
            <button onClick={openNew} disabled={!!error}
              className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Plus size={14} /> เพิ่มบัญชี
            </button>
          </div>
        </div>

        <div className="p-4 border-b border-slate-100">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อผู้ใช้ / สาขา / ชื่อที่แสดง…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
        </div>

        {(error || warning || (toast && !toast.ok)) && (
          <div className={`m-4 p-3 rounded-xl text-sm flex items-start gap-2 border ${
            error || (toast && !toast.ok)
              ? 'bg-rose-50 border-rose-100 text-rose-700'
              : 'bg-amber-50 border-amber-100 text-amber-800'
          }`}>
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span className="break-words">{error || (toast && !toast.ok ? toast.msg : warning)}</span>
          </div>
        )}

        {plainCount > 0 && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-start gap-2">
            <ShieldAlert size={16} className="shrink-0 mt-0.5" />
            <span>
              มี <b>{plainCount} บัญชี</b> ที่รหัสผ่านยังเก็บเป็นข้อความล้วนในฐาน (ของตกค้างจากตอนย้ายมาจากชีท)
              ใครเปิดฐานได้ก็อ่านรหัสของสาขานั้นได้ทันที — กด "ตั้งรหัสใหม่" ที่แถวนั้นเพื่อเข้ารหัสทับ
            </span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">ชื่อผู้ใช้</th>
                <th className="px-4 py-3 text-left">สาขาที่เห็นได้</th>
                <th className="px-4 py-3 text-left">ชื่อที่แสดง</th>
                <th className="px-4 py-3 text-center">รหัสผ่าน</th>
                <th className="px-4 py-3 text-center">สถานะ</th>
                <th className="px-4 py-3 text-left">เข้าใช้ล่าสุด</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดรายชื่อบัญชีสาขา…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  {error ? 'ยังอ่านข้อมูลไม่ได้' : 'ไม่พบบัญชี'}
                </td></tr>
              ) : filtered.map((u) => (
                <tr key={u.username} className={`hover:bg-slate-50/60 ${u.isActive ? '' : 'bg-rose-50/40 text-slate-400'}`}>
                  <td className="px-4 py-2 font-mono text-sm font-bold text-slate-700 whitespace-nowrap">{u.username}</td>
                  <td className="px-4 py-2">
                    {splitBranches(u.branch).includes(ALL_BRANCHES) ? (
                      <span className="inline-block rounded px-2 py-0.5 text-[10px] font-semibold bg-violet-100 text-violet-700">
                        ทุกสาขา
                      </span>
                    ) : (
                      <span className="font-mono text-xs uppercase">{u.branch || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {u.displayName || <span className="text-slate-300 italic text-xs">—</span>}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {!u.hasPassword ? (
                      <span className="inline-flex items-center gap-1 text-amber-600 font-semibold text-[11px]">
                        <AlertTriangle size={11} />ไม่มีรหัส
                      </span>
                    ) : u.passwordHashed ? (
                      <span className="text-[11px] text-slate-400">เข้ารหัสแล้ว</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-rose-600 font-semibold text-[11px]">
                        <ShieldAlert size={11} />ข้อความล้วน
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${
                      u.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'
                    }`}>{u.isActive ? 'ใช้งาน' : 'ปิดการใช้งาน'}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} className="text-slate-300" />{fmtLastLogin(u.lastLoginAt)}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => { setPwdTarget(u); setNewPwd(''); setToast(null); }}
                        disabled={saving} title="ตั้งรหัสผ่านใหม่ให้บัญชีนี้"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-sky-50 disabled:text-slate-200 transition-all">
                        <KeyRound size={14} />
                      </button>
                      <button onClick={() => openEdit(u)} disabled={saving} title="แก้ไขบัญชีนี้"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 disabled:text-slate-200 transition-all">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { setFormMsg(null); setDeleteTarget(u); }} disabled={saving} title="ลบบัญชีนี้"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:text-slate-200 transition-all">
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
            บัญชีพวกนี้คือที่<b>สาขาใช้เข้าระบบลงตารางงาน</b> (คนละชุดกับผู้ใช้ออฟฟิศที่หน้า ระบบ → จัดการผู้ใช้) ·
            ดูรหัสเดิมไม่ได้ เก็บเป็นค่าที่ย้อนกลับไม่ได้ ลืมแล้วมีทางเดียวคือตั้งใหม่ ·
            เลิกใช้บัญชีให้<b>ปิดการใช้งาน</b>แทนการลบ เพราะบันทึกการแก้ตารางงานยังอ้างชื่อผู้ใช้นี้อยู่
          </span>
        </div>
      </div>

      {/* ── ฟอร์มเพิ่ม/แก้ไขบัญชี ── */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !saving && setEditing(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{editing.isNew ? 'เพิ่มบัญชีสาขา' : `แก้ไขบัญชี ${editing.username}`}</h3>
              <button onClick={() => setEditing(null)} disabled={saving} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">ชื่อผู้ใช้ *</label>
                <input value={editing.username} disabled={!editing.isNew} autoComplete="off"
                  onChange={(e) => setEditing((f) => ({ ...f, username: e.target.value }))}
                  placeholder="เช่น sjp"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500" />
                <p className="text-[11px] text-slate-400 mt-1">
                  {editing.isNew
                    ? 'ชื่อที่สาขาพิมพ์ตอนล็อกอิน · ห้ามมีช่องว่าง'
                    : 'แก้ชื่อผู้ใช้ไม่ได้ — บันทึกการแก้ตารางงานอ้างชื่อนี้อยู่ จะเปลี่ยนให้สร้างบัญชีใหม่แล้วปิดตัวเก่า'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">สาขาที่เห็นได้ *</label>
                <div className="flex gap-2 mb-2">
                  <button type="button"
                    onClick={() => setEditing((f) => ({ ...f, branch: ALL_BRANCHES }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      isAll ? 'bg-violet-100 border-violet-200 text-violet-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}>
                    ทุกสาขา
                  </button>
                  <button type="button"
                    onClick={() => setEditing((f) => ({ ...f, branch: isAll ? '' : f.branch }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      !isAll ? 'bg-amber-100 border-amber-200 text-amber-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}>
                    เลือกเฉพาะสาขา
                  </button>
                </div>
                {!isAll && (
                  <div className="border border-slate-200 rounded-xl p-2 max-h-44 overflow-y-auto grid grid-cols-3 gap-1">
                    {branches.map((b) => (
                      <label key={b.code}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs cursor-pointer hover:bg-slate-50 ${
                          b.status === STATUS_INACTIVE ? 'text-slate-300' : 'text-slate-600'
                        }`}>
                        <input type="checkbox" checked={picked.includes(b.code.toLowerCase())}
                          onChange={() => toggleBranch(b.code)} className="accent-amber-500" />
                        <span className="font-mono">{b.code}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-slate-400 mt-1">
                  {isAll
                    ? 'เห็นข้อมูลทุกสาขา — ใช้กับบัญชีของออฟฟิศ/ผู้บริหารเท่านั้น'
                    : 'ติ๊กได้มากกว่าหนึ่งสาขา (เช่นผู้จัดการที่ดูแลสองร้าน) · สาขาสีจางคือปิดการใช้งานแล้ว'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">ชื่อที่แสดง</label>
                  <input value={editing.displayName}
                    onChange={(e) => setEditing((f) => ({ ...f, displayName: e.target.value }))}
                    placeholder="เช่น ผจก.สาทร"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                  <p className="text-[11px] text-slate-400 mt-1">ใช้เป็นชื่อ "ผู้อนุมัติ" บนตารางงาน</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสร้าน POS</label>
                  <input value={editing.outletId} inputMode="numeric"
                    onChange={(e) => setEditing((f) => ({ ...f, outletId: e.target.value }))}
                    placeholder="เว้นว่างได้"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">สถานะ</label>
                <select value={editing.isActive ? '1' : '0'}
                  onChange={(e) => setEditing((f) => ({ ...f, isActive: e.target.value === '1' }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
                  <option value="1">ใช้งาน</option>
                  <option value="0">ปิดการใช้งาน</option>
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  ปิดการใช้งาน = ล็อกอินใหม่ไม่ได้ · คนที่เปิดค้างอยู่ยังใช้ต่อได้จนกว่าจะออกจากระบบ
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">
                  รหัสผ่าน {editing.isNew ? '*' : '(เว้นว่าง = ไม่เปลี่ยน)'}
                </label>
                <input type="text" value={editing.password} autoComplete="new-password"
                  onChange={(e) => setEditing((f) => ({ ...f, password: e.target.value }))}
                  placeholder={editing.isNew ? 'อย่างน้อย 8 ตัว ไม่มีช่องว่าง' : 'เว้นว่างไว้ถ้าไม่ต้องการเปลี่ยน'}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500" />
                <p className="text-[11px] text-slate-400 mt-1">
                  แสดงเป็นตัวอักษรปกติโดยตั้งใจ — ตั้งเสร็จต้องอ่านบอกสาขาทางโทรศัพท์ และหน้านี้เปิดได้เฉพาะผู้ดูแลระบบ
                </p>
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 space-y-3">
              {formMsg && <FormMsg {...formMsg} />}
              <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} disabled={saving}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button onClick={saveEdit} disabled={saving}
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-sm px-5 py-2 rounded-xl transition-all">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                บันทึก
              </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── ตั้งรหัสผ่านใหม่ ── */}
      {pwdTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !saving && setPwdTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">ตั้งรหัสใหม่ให้ {pwdTarget.username}</h3>
              <button onClick={() => setPwdTarget(null)} disabled={saving} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-3">
              <input type="text" value={newPwd} autoFocus autoComplete="new-password"
                onChange={(e) => setNewPwd(e.target.value)}
                placeholder="รหัสใหม่ อย่างน้อย 8 ตัว ไม่มีช่องว่าง"
                className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500" />
              <p className="text-xs text-slate-500">
                ตั้งแล้วรหัสเดิมใช้ไม่ได้ทันที — <b>บอกสาขาก่อนกด</b> ไม่งั้นสาขาจะล็อกอินไม่ได้โดยไม่รู้สาเหตุ
              </p>
            </div>
            <div className="p-5 pt-0 space-y-3">
              {formMsg && <FormMsg {...formMsg} />}
              <div className="flex justify-end gap-2">
              <button onClick={() => setPwdTarget(null)} disabled={saving}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button onClick={savePassword} disabled={saving || !newPwd}
                className="inline-flex items-center gap-2 bg-sky-500 hover:bg-sky-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-sm px-5 py-2 rounded-xl transition-all">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                ตั้งรหัสใหม่
              </button>
              </div>
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
                <h3 className="font-bold text-slate-800">ลบบัญชี {deleteTarget.username}?</h3>
              </div>
              <p className="text-sm text-slate-600">
                แนะนำให้<b>ปิดการใช้งานแทนการลบ</b> — บันทึกการแก้ตารางงาน (ช่อง "ผู้แก้ไข"
                และ "ผู้อนุมัติ") เก็บชื่อผู้ใช้ <b>{deleteTarget.username}</b> ไว้เป็นข้อความ
                ลบแถวนี้ไม่ได้ลบบันทึกพวกนั้น แต่จะไม่เหลืออะไรบอกว่าชื่อนั้นเคยเป็นของสาขาไหน
              </p>
            </div>
            <div className="p-5 pt-0 space-y-3">
              {formMsg && <FormMsg {...formMsg} />}
              <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button
                onClick={async () => { const u = deleteTarget; setDeleteTarget(null); await deactivate(u); }}
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
        </div>
      )}
    </div>
  );
}

// ข้อความผลการบันทึก/ลบ ที่อยู่ "ในกล่อง" — ข้อความจากเซิร์ฟเวอร์ยาวได้ จึงให้ขึ้นบรรทัดได้
function FormMsg({ ok, msg }) {
  return (
    <div className={`flex items-start gap-1.5 text-xs font-semibold max-h-28 overflow-auto ${ok ? 'text-emerald-600' : 'text-rose-600'}`}>
      {ok ? <CheckCircle size={13} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />}
      <span className="break-words whitespace-pre-wrap">{msg}</span>
    </div>
  );
}
