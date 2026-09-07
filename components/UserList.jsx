import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CheckCircle, Info, Key, Loader2, Lock, Pencil, Plus, Search,
  ShieldAlert, ShieldCheck, Trash2, UploadCloud, Users, X,
} from 'lucide-react';
import {
  ADMIN_ONLY_KEYS, MENU_GROUPS, ROLE_ADMIN, ROLE_USER, ROLES,
  STATUS_ACTIVE, STATUS_INACTIVE, normalizePerms, normalizeUsername,
  validatePassword, validateUsername,
} from '../lib/permissions';

/*
 * ระบบ — จัดการผู้ใช้และสิทธิ์: ใครเข้าระบบได้ และเข้าแล้วเห็นเมนูไหนบ้าง
 *
 * เก็บที่ตาราง InventoryNarai.dbo.app_user อ่าน/เขียนผ่าน /api/users (ผู้ดูแลระบบเท่านั้น)
 * รายการเมนูที่ติ๊กได้มาจาก lib/permissions.js (MENU_GROUPS) — เปิดเมนูใหม่ในหน้าเว็บ
 * ต้องไปเติมที่ไฟล์นั้น เมนูใหม่จึงจะโผล่มาให้ติ๊กที่นี่
 *
 * สิ่งที่หน้านี้ทำไม่ได้:
 *   - ดูรหัสผ่านของใคร — ฐานเก็บแค่ค่าที่ผ่าน scrypt แล้ว ลืมรหัสต้องกด "ตั้งรหัสใหม่"
 *   - เตะคนที่ล็อกอินค้างอยู่ออกทันที — ตั๋วที่ออกไปแล้วเรียกคืนไม่ได้ ปิดบัญชีแล้ว
 *     เขายังใช้ต่อได้จนตั๋วหมดอายุ (สูงสุด 12 ชม.)
 *   - คุมสิทธิ์ละเอียดกว่าระดับเมนู (เช่น "ดูได้แต่แก้ไม่ได้") ยังไม่มี
 */

const EMPTY_FORM = {
  username: '', displayName: '', password: '', role: ROLE_USER,
  status: STATUS_ACTIVE, branchCode: '', note: '', perms: [],
};

/** คีย์เมนูที่ให้ติ๊กได้จริงในกลุ่มหนึ่ง (เมนูเฉพาะผู้ดูแลไม่ต้องเอามาให้ติ๊ก) */
const grantableItems = (group) => group.items.filter((i) => !ADMIN_ONLY_KEYS.includes(i.key));

const GRANTABLE_GROUPS = MENU_GROUPS
  .map((g) => ({ ...g, items: grantableItems(g) }))
  .filter((g) => g.items.length > 0);

const ALL_GRANTABLE = GRANTABLE_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export default function UserList({ me }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);          // { ok, msg }
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [tableReady, setTableReady] = useState(true);
  const [canWrite, setCanWrite] = useState(true);
  const [setupMode, setSetupMode] = useState(false);
  const [weakSecret, setWeakSecret] = useState(false);
  const [creating, setCreating] = useState(false);
  const [branches, setBranches] = useState([]);
  const [editing, setEditing] = useState(null);      // { ...form, isNew }
  const [savingItem, setSavingItem] = useState(false);
  const [pwdTarget, setPwdTarget] = useState(null);  // { username, password }
  const [savingPwd, setSavingPwd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // quiet = โหลดใหม่เบื้องหลังหลังกดบันทึก (ตารางเดิมยังอ่านได้ระหว่างรอ)
  const load = ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    return fetch(`/api/users${quiet ? `?t=${Date.now()}` : ''}`)
      .then(async (r) => ({ code: r.status, res: await r.json() }))
      .then(({ code, res }) => {
        if (code === 403) { setError(res.message || 'ไม่มีสิทธิ์เข้าหน้านี้'); return; }
        if (res.status !== 'success') { setError(res.message || 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ'); return; }
        setUsers(res.data || []);
        setTableReady(res.tableReady !== false);
        setCanWrite(res.canWrite !== false);
        setSetupMode(Boolean(res.setupMode));
        setWeakSecret(Boolean(res.weakSecret));
        setError('');
        if (res.warning) setToast({ ok: false, msg: res.warning });
      })
      .catch((err) => setError(err.message))
      .finally(() => { if (!quiet) setLoading(false); });
  };

  useEffect(() => {
    load();
    // ทะเบียนสาขาเอาไว้เติม dropdown "ผูกกับสาขา" — ดึงไม่ได้ก็ไม่เป็นไร ช่องนั้นพิมพ์เองได้
    fetch('/api/branches')
      .then((r) => r.json())
      .then((res) => setBranches(res.status === 'success' ? (res.data || []) : []))
      .catch(() => setBranches([]));
  }, []);

  const post = async (action, payload = {}) => {
    const r = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    const res = await r.json();
    if (res.status !== 'success') throw new Error(res.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
    return res;
  };

  const adminCount = useMemo(
    () => users.filter((u) => u.role === ROLE_ADMIN && u.status !== STATUS_INACTIVE).length,
    [users]
  );
  const activeCount = useMemo(() => users.filter((u) => u.status !== STATUS_INACTIVE).length, [users]);

  const editable = tableReady && canWrite;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter && (u.status || STATUS_ACTIVE) !== statusFilter) return false;
      if (!q) return true;
      return u.username.includes(q)
        || (u.displayName || '').toLowerCase().includes(q)
        || (u.branchCode || '').toLowerCase().includes(q);
    });
  }, [users, search, statusFilter]);

  const doCreateTable = async () => {
    setCreating(true);
    setToast(null);
    try {
      await post('createTable');
      setToast({ ok: true, msg: 'สร้างตารางผู้ใช้แล้ว — บัญชีตั้งต้นคือ admin / admin1234 เปลี่ยนรหัสทันที' });
      await load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setCreating(false);
    }
  };

  const openNew = () => { setEditing({ ...EMPTY_FORM, isNew: true }); setToast(null); };

  const openEdit = (u) => {
    setEditing({
      username: u.username,
      displayName: u.displayName || '',
      password: '',
      role: u.role || ROLE_USER,
      status: u.status || STATUS_ACTIVE,
      branchCode: u.branchCode || '',
      note: u.note || '',
      perms: normalizePerms(u.perms),
      isNew: false,
    });
    setToast(null);
  };

  const togglePerm = (key) => setEditing((f) => ({
    ...f,
    perms: f.perms.includes(key) ? f.perms.filter((k) => k !== key) : [...f.perms, key],
  }));

  const toggleGroup = (group) => setEditing((f) => {
    const keys = group.items.map((i) => i.key);
    const allOn = keys.every((k) => f.perms.includes(k));
    return {
      ...f,
      perms: allOn ? f.perms.filter((k) => !keys.includes(k))
        : [...new Set([...f.perms, ...keys])],
    };
  });

  const saveEdit = async () => {
    const username = normalizeUsername(editing.username);
    const bad = validateUsername(username);
    if (bad) { setToast({ ok: false, msg: bad }); return; }
    if (editing.isNew && users.some((u) => u.username === username)) {
      setToast({ ok: false, msg: `มีผู้ใช้ ${username} อยู่แล้ว — กดแก้ไขที่แถวนั้นแทน` });
      return;
    }
    if (editing.isNew || editing.password) {
      const badPwd = validatePassword(editing.password);
      if (badPwd) { setToast({ ok: false, msg: badPwd }); return; }
    }
    // ผู้ใช้ทั่วไปที่ไม่ได้ติ๊กเมนูสักอัน = ล็อกอินเข้ามาแล้วเจอหน้าว่าง ๆ ดักไว้ก่อนบันทึก
    if (editing.role !== ROLE_ADMIN && editing.perms.length === 0) {
      setToast({ ok: false, msg: 'ยังไม่ได้ติ๊กเมนูให้สักอัน — ผู้ใช้คนนี้จะเข้ามาแล้วไม่เห็นอะไรเลย' });
      return;
    }

    setSavingItem(true);
    try {
      await post('saveUser', {
        username,
        displayName: editing.displayName,
        password: editing.password || '',
        role: editing.role,
        status: editing.status,
        branchCode: editing.branchCode,
        note: editing.note,
        perms: editing.perms,
      });
      setEditing(null);
      setToast({ ok: true, msg: `บันทึกผู้ใช้ ${username} แล้ว` });
      await load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setSavingItem(false);
    }
  };

  const doResetPassword = async () => {
    const bad = validatePassword(pwdTarget.password);
    if (bad) { setToast({ ok: false, msg: bad }); return; }
    setSavingPwd(true);
    try {
      await post('resetPassword', { username: pwdTarget.username, password: pwdTarget.password });
      const who = pwdTarget.username;
      setPwdTarget(null);
      setToast({ ok: true, msg: `ตั้งรหัสผ่านใหม่ให้ ${who} แล้ว — ส่งรหัสให้เจ้าตัวแล้วบอกให้เปลี่ยนเอง` });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setSavingPwd(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await post('deleteUser', { username: deleteTarget.username });
      const who = deleteTarget.username;
      setDeleteTarget(null);
      setToast({ ok: true, msg: `ลบผู้ใช้ ${who} แล้ว` });
      await load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="w-full space-y-5">
      {setupMode && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-sm text-rose-700 flex items-start gap-3">
          <ShieldAlert size={18} className="shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-bold">ยังอยู่ในโหมดตั้งค่า — ตอนนี้ใครก็เข้าระบบได้</div>
            <div>
              บัญชี <span className="font-mono font-bold">admin / admin1234</span> ที่ฝังไว้ในโค้ดยังใช้ได้อยู่
              เพราะยังไม่มีคลังผู้ใช้จริง · กดปุ่ม <b>สร้างตาราง</b> ด้านล่าง (หรือตั้ง
              <span className="font-mono"> APP_ADMIN_USER / APP_ADMIN_PASSWORD</span> บน Vercel) แล้วโหมดนี้จะปิดเอง
            </div>
          </div>
        </div>
      )}

      {weakSecret && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-sm text-amber-800 flex items-start gap-3">
          <Lock size={18} className="shrink-0 mt-0.5" />
          <div>
            ยังไม่ได้ตั้ง <span className="font-mono font-semibold">AUTH_SECRET</span> บน Vercel —
            ตั๋วเข้าระบบเซ็นด้วยกุญแจตั้งต้นซึ่งปลอมได้ ตั้งเป็นข้อความสุ่มยาว ๆ แล้ว deploy ใหม่
            (ตั้งแล้วทุกคนจะถูกให้ล็อกอินใหม่รอบหนึ่ง)
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-amber-100 text-amber-600 rounded-xl"><Users className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">จัดการผู้ใช้และสิทธิ์</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {users.length} บัญชี · ใช้งาน {activeCount} · ผู้ดูแลระบบ {adminCount}
                {!tableReady && <span className="text-rose-600 font-semibold"> · ยังไม่มีตารางผู้ใช้ในฐาน</span>}
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
                title="สร้างตาราง InventoryNarai.dbo.app_user แล้วใส่บัญชี admin ตั้งต้น (รันซ้ำได้ ไม่ทับข้อมูลเดิม)"
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
                {creating ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
                สร้างตาราง
              </button>
            )}
            <button onClick={openNew} disabled={!editable}
              title={editable ? 'เพิ่มผู้ใช้ใหม่'
                : canWrite ? 'ต้องสร้างตารางก่อนจึงจะเพิ่มผู้ใช้ได้'
                : 'ยังไม่ได้ตั้งรหัสฐานข้อมูลบน Vercel จึงแก้คลังผู้ใช้ไม่ได้'}
              className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Plus size={14} /> เพิ่มผู้ใช้
            </button>
          </div>
        </div>

        <div className="p-4 flex flex-wrap gap-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อผู้ใช้ / ชื่อที่แสดง / สาขา…"
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

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">ชื่อผู้ใช้</th>
                <th className="px-4 py-3 text-left">ชื่อที่แสดง</th>
                <th className="px-4 py-3 text-center">บทบาท</th>
                <th className="px-4 py-3 text-center">สาขา</th>
                <th className="px-4 py-3 text-left">สิทธิ์เมนู</th>
                <th className="px-4 py-3 text-center">สถานะ</th>
                <th className="px-4 py-3 text-center">เข้าล่าสุด</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดรายชื่อผู้ใช้…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  {tableReady ? 'ไม่พบผู้ใช้'
                    : canWrite ? 'ยังไม่มีตารางผู้ใช้ — กดปุ่ม "สร้างตาราง" ด้านบน'
                    : 'ยังต่อฐานข้อมูลไม่ได้ จึงเก็บผู้ใช้ลงฐานยังไม่ได้ (ดูคำเตือนด้านบน)'}
                </td></tr>
              ) : filtered.map((u) => (
                <tr key={u.username} className={`hover:bg-slate-50/60 ${u.status === STATUS_INACTIVE ? 'bg-rose-50/40 text-slate-400' : ''}`}>
                  <td className="px-4 py-2 font-mono text-sm font-bold text-slate-700 whitespace-nowrap">
                    {u.username}
                    {u.username === me?.username && <span className="ml-2 text-[10px] font-sans font-semibold text-amber-600">(คุณ)</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {u.displayName || <span className="text-slate-300 italic text-xs">—</span>}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {u.role === ROLE_ADMIN ? (
                      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold bg-violet-100 text-violet-700">
                        <ShieldCheck size={11} />ผู้ดูแลระบบ
                      </span>
                    ) : (
                      <span className="inline-block rounded px-2 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-600">ผู้ใช้ทั่วไป</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center font-mono text-xs text-slate-500">{u.branchCode || '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {u.role === ROLE_ADMIN
                      ? <span className="text-violet-600 font-semibold">ทุกเมนู</span>
                      : `${u.perms.length} เมนู`}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${
                      u.status === STATUS_INACTIVE ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-700'
                    }`}>{u.status || STATUS_ACTIVE}</span>
                  </td>
                  <td className="px-4 py-2 text-center text-[11px] font-mono text-slate-400 whitespace-nowrap">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : 'ยังไม่เคย'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => openEdit(u)} disabled={!editable} title="แก้ไขบัญชีและสิทธิ์"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 disabled:text-slate-200 disabled:hover:bg-transparent transition-all">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { setPwdTarget({ username: u.username, password: '' }); setToast(null); }}
                        disabled={!editable} title="ตั้งรหัสผ่านใหม่ให้คนนี้"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-sky-50 disabled:text-slate-200 disabled:hover:bg-transparent transition-all">
                        <Key size={14} />
                      </button>
                      <button onClick={() => setDeleteTarget(u)} disabled={!editable || u.username === me?.username}
                        title={u.username === me?.username ? 'ลบบัญชีตัวเองไม่ได้' : 'ลบบัญชีนี้'}
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
            สิทธิ์ที่ตั้งที่นี่คุมว่า <b>เห็นเมนูไหน</b> · ผู้ดูแลระบบเห็นทุกเมนูเสมอโดยไม่ต้องติ๊ก ·
            เลิกใช้บัญชีให้ตั้งเป็น <b>ปิดการใช้งาน</b> แทนการลบ (ประวัติการแก้ไขยังอ้างชื่อนั้นอยู่) ·
            ปิดบัญชีตอนเจ้าตัวล็อกอินค้างอยู่ เขายังใช้ต่อได้จนตั๋วหมดอายุ (สูงสุด 12 ชม.)
          </span>
        </div>
      </div>

      {/* ── ฟอร์มเพิ่ม/แก้ไขผู้ใช้ ── */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !savingItem && setEditing(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
              <h3 className="font-bold text-slate-800">{editing.isNew ? 'เพิ่มผู้ใช้ใหม่' : `แก้ไขผู้ใช้ ${editing.username}`}</h3>
              <button onClick={() => setEditing(null)} disabled={savingItem} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">ชื่อผู้ใช้ *</label>
                  <input value={editing.username} disabled={!editing.isNew}
                    onChange={(e) => setEditing((f) => ({ ...f, username: e.target.value.toLowerCase() }))}
                    placeholder="เช่น magazine, acc.somchai"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500" />
                  <p className="text-[11px] text-slate-400 mt-1">
                    {editing.isNew
                      ? 'ตัวอักษรอังกฤษเล็ก ตัวเลข . _ - ยาว 3–50 ตัว'
                      : 'แก้ชื่อผู้ใช้ไม่ได้ — จะเปลี่ยนชื่อให้เพิ่มบัญชีใหม่แล้วปิดตัวเก่าแทน'}
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">ชื่อที่แสดง</label>
                  <input value={editing.displayName} onChange={(e) => setEditing((f) => ({ ...f, displayName: e.target.value }))}
                    placeholder="เช่น สมชาย (บัญชี)"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">
                    รหัสผ่าน {editing.isNew ? '*' : '(เว้นว่าง = ไม่เปลี่ยน)'}
                  </label>
                  <input type="password" value={editing.password} autoComplete="new-password"
                    onChange={(e) => setEditing((f) => ({ ...f, password: e.target.value }))}
                    placeholder={editing.isNew ? 'อย่างน้อย 6 ตัวอักษร' : '••••••'}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">บทบาท</label>
                  <select value={editing.role} onChange={(e) => setEditing((f) => ({ ...f, role: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
                    {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">สถานะ</label>
                  <select value={editing.status} onChange={(e) => setEditing((f) => ({ ...f, status: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
                    <option value={STATUS_ACTIVE}>{STATUS_ACTIVE}</option>
                    <option value={STATUS_INACTIVE}>{STATUS_INACTIVE}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">ผูกกับสาขา (ไม่บังคับ)</label>
                  <select value={editing.branchCode} onChange={(e) => setEditing((f) => ({ ...f, branchCode: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
                    <option value="">— ไม่ผูกสาขา (ดูได้ทุกสาขา) —</option>
                    {branches.map((b) => (
                      <option key={b.code} value={b.code}>{b.name ? `${b.code} — ${b.name}` : b.code}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-400 mt-1">
                    ตอนนี้เป็นข้อมูลอ้างอิงเฉย ๆ — หน้าเว็บยังไม่ได้เอาไปกรองข้อมูลตามสาขา
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">หมายเหตุ</label>
                <input value={editing.note} onChange={(e) => setEditing((f) => ({ ...f, note: e.target.value }))}
                  placeholder="เช่น บัญชีของผู้จัดการสาขา ใช้ดูยอดอย่างเดียว"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>

              {/* ── ช่องติ๊กสิทธิ์เมนู ── */}
              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-slate-600">สิทธิ์เมนู</label>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setEditing((f) => ({ ...f, perms: [...ALL_GRANTABLE] }))}
                      className="text-[11px] font-semibold text-slate-500 hover:text-amber-600">เลือกทั้งหมด</button>
                    <span className="text-slate-200">|</span>
                    <button type="button" onClick={() => setEditing((f) => ({ ...f, perms: [] }))}
                      className="text-[11px] font-semibold text-slate-500 hover:text-rose-600">ล้างทั้งหมด</button>
                  </div>
                </div>

                {editing.role === ROLE_ADMIN && (
                  <div className="mb-3 p-3 bg-violet-50 border border-violet-100 rounded-xl text-xs text-violet-700 flex items-start gap-2">
                    <ShieldCheck size={14} className="shrink-0 mt-0.5" />
                    <span>
                      ผู้ดูแลระบบเห็นทุกเมนูเสมอ ไม่ว่าจะติ๊กช่องไหนไว้ · ที่ยังให้ติ๊กได้เพราะถ้าวันหลัง
                      ลดเป็นผู้ใช้ทั่วไป ระบบจะใช้ชุดที่ติ๊กไว้นี้ทันที
                    </span>
                  </div>
                )}

                <div className="space-y-3">
                  {GRANTABLE_GROUPS.map((g) => {
                    const on = g.items.filter((i) => editing.perms.includes(i.key)).length;
                    return (
                      <div key={g.key} className="border border-slate-100 rounded-xl overflow-hidden">
                        <button type="button" onClick={() => toggleGroup(g)}
                          className="w-full flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 transition-colors">
                          <span className="text-xs font-bold text-slate-700">{g.label}</span>
                          <span className={`text-[11px] font-semibold ${on === g.items.length ? 'text-emerald-600' : on ? 'text-amber-600' : 'text-slate-400'}`}>
                            {on}/{g.items.length}
                          </span>
                        </button>
                        <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {g.items.map((i) => (
                            <label key={i.key} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer hover:text-slate-900">
                              <input type="checkbox" checked={editing.perms.includes(i.key)} onChange={() => togglePerm(i.key)}
                                className="rounded border-slate-300 text-amber-500 focus:ring-amber-500" />
                              <span>{i.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p className="text-[11px] text-slate-400 mt-2">
                  เมนู “จัดการผู้ใช้” ไม่มีให้ติ๊ก — เปิดได้เฉพาะบทบาทผู้ดูแลระบบเท่านั้น
                </p>
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2 sticky bottom-0 bg-white">
              <button onClick={() => setEditing(null)} disabled={savingItem}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button onClick={saveEdit} disabled={savingItem}
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all">
                {savingItem && <Loader2 size={14} className="animate-spin" />}
                บันทึก
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ตั้งรหัสผ่านใหม่ ── */}
      {pwdTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !savingPwd && setPwdTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">ตั้งรหัสผ่านใหม่ให้ {pwdTarget.username}</h3>
              <button onClick={() => setPwdTarget(null)} disabled={savingPwd} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-3">
              <input type="text" value={pwdTarget.password} autoComplete="off"
                onChange={(e) => setPwdTarget((f) => ({ ...f, password: e.target.value }))}
                placeholder="รหัสผ่านใหม่ อย่างน้อย 6 ตัวอักษร"
                className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500" />
              <p className="text-[11px] text-slate-400">
                ตั้งเสร็จแล้วรหัสนี้จะดูย้อนหลังไม่ได้อีก (ฐานเก็บแค่ค่าที่เข้ารหัสแล้ว) —
                คัดลอกส่งให้เจ้าตัวก่อนปิดหน้าต่าง แล้วบอกให้เขาเปลี่ยนเองที่ปุ่มมุมขวาบน
              </p>
            </div>
            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2">
              <button onClick={() => setPwdTarget(null)} disabled={savingPwd}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button onClick={doResetPassword} disabled={savingPwd || !pwdTarget.password}
                className="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-700 disabled:bg-slate-200 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all">
                {savingPwd && <Loader2 size={14} className="animate-spin" />}
                ตั้งรหัสผ่าน
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ยืนยันลบ ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 space-y-2">
              <h3 className="font-bold text-slate-800">ลบผู้ใช้ {deleteTarget.username}?</h3>
              <p className="text-sm text-slate-500">
                ลบแล้วเอากลับไม่ได้ · ถ้าแค่อยากให้เข้าไม่ได้ชั่วคราว ให้กดแก้ไขแล้วตั้งสถานะเป็น
                “{STATUS_INACTIVE}” แทน จะได้ไม่เสียประวัติที่อ้างชื่อผู้ใช้นี้
              </p>
            </div>
            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button onClick={doDelete} disabled={deleting}
                className="inline-flex items-center gap-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-200 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all">
                {deleting && <Loader2 size={14} className="animate-spin" />}
                ลบผู้ใช้
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
