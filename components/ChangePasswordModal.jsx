import React, { useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { validatePassword } from '../lib/permissions';

/*
 * เปลี่ยนรหัสผ่านของตัวเอง — เรียกจากปุ่มมุมขวาบนของแดชบอร์ด
 * ต้องกรอกรหัสเดิมด้วย (ฝั่ง /api/auth ตรวจซ้ำ) กันคนอื่นมาเปลี่ยนรหัสตอนเจ้าตัวลุกจากเครื่อง
 *
 * บัญชีผู้ดูแลสำรอง (APP_ADMIN_USER) เปลี่ยนที่นี่ไม่ได้ — มันไม่ได้อยู่ในฐาน
 * ฝั่ง API จะตอบกลับมาบอกเองว่าให้ไปแก้ที่ค่า env
 */
export default function ChangePasswordModal({ onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const bad = validatePassword(newPassword);
    if (bad) { setError(bad); return; }
    if (newPassword !== confirmPassword) { setError('รหัสผ่านใหม่สองช่องไม่ตรงกัน'); return; }

    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'changePassword', currentPassword, newPassword }),
      });
      const res = await r.json();
      if (res.status !== 'success') { setError(res.message || 'เปลี่ยนรหัสผ่านไม่สำเร็จ'); return; }
      setDone(true);
    } catch (err) {
      setError(`ติดต่อเซิร์ฟเวอร์ไม่ได้: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => !busy && onClose()}>
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-bold text-slate-800">เปลี่ยนรหัสผ่าน</h3>
          <button type="button" onClick={onClose} disabled={busy} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100"><X size={18} /></button>
        </div>

        {done ? (
          <div className="p-5 space-y-3">
            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl p-3">
              เปลี่ยนรหัสผ่านเรียบร้อย — ครั้งหน้าเข้าระบบด้วยรหัสใหม่
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={onClose}
                className="bg-slate-800 hover:bg-slate-900 text-white font-semibold text-xs px-5 py-2 rounded-xl">ปิด</button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่านเดิม</label>
                <input type="password" value={currentPassword} autoComplete="current-password"
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่านใหม่</label>
                <input type="password" value={newPassword} autoComplete="new-password"
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="อย่างน้อย 6 ตัวอักษร"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">ยืนยันรหัสผ่านใหม่</label>
                <input type="password" value={confirmPassword} autoComplete="new-password"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>

              {error && (
                <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-700 flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span className="break-words">{error}</span>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} disabled={busy}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-100">ยกเลิก</button>
              <button type="submit" disabled={busy || !currentPassword || !newPassword}
                className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 text-white font-semibold text-xs px-5 py-2 rounded-xl transition-all">
                {busy && <Loader2 size={14} className="animate-spin" />}
                เปลี่ยนรหัสผ่าน
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
