import React, { useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Loader2, LogIn, ShieldAlert } from 'lucide-react';

/*
 * หน้าเข้าสู่ระบบ — ด่านแรกก่อนเข้าแดชบอร์ด
 *
 * ตัวหน้าไม่ได้ตัดสินอะไรเอง ส่งชื่อ+รหัสไปให้ /api/auth ตรวจ แล้วรอตั๋ว (คุกกี้ httpOnly)
 * ตั๋วอยู่ในคุกกี้ที่ JS อ่านไม่ได้ตามตั้งใจ — สถานะ "เป็นใคร" จึงมาจาก onSuccess ที่ pages/index.js
 *
 * แถบเตือนสองอันด้านล่างจงใจให้เห็นตั้งแต่ยังไม่ล็อกอิน เพราะคนที่ต้องเห็นคือคนตั้งระบบครั้งแรก
 * (ไม่มีอะไรลับในนั้น — บอกแค่ว่ายังตั้งค่าไม่ครบ ไม่ได้บอกรหัสผ่านของใคร)
 */
export default function LoginPage({ setup, onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', username, password }),
      });
      const res = await r.json();
      if (res.status !== 'success') { setError(res.message || 'เข้าสู่ระบบไม่สำเร็จ'); return; }
      onSuccess(res.data);
    } catch (err) {
      setError(`ติดต่อเซิร์ฟเวอร์ไม่ได้: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4 py-10">
      <div className="w-full max-w-sm">
        {/* โลโก้ชุดเดียวกับหัวแถบข้าง เพื่อให้รู้ว่ามาถูกที่ */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500 font-bold text-white text-xl">N</div>
          <span className="text-2xl font-bold tracking-wider text-white">NARAI OFFICE</span>
        </div>

        <form onSubmit={submit} className="bg-white rounded-2xl shadow-xl p-6 space-y-4">
          <div>
            <h1 className="text-lg font-bold text-slate-800">เข้าสู่ระบบ</h1>
            <p className="text-xs text-slate-400 mt-1">ใช้ชื่อผู้ใช้ที่ผู้ดูแลระบบสร้างให้</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500">ชื่อผู้ใช้</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              placeholder="เช่น magazine"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500">รหัสผ่าน</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !username || !password}
            className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-semibold text-sm px-4 py-2.5 rounded-xl transition-colors"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
            <span>{busy ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ'}</span>
          </button>
        </form>

        {setup?.setupMode && (
          <div className="mt-4 p-3 bg-rose-950/60 border border-rose-800 text-rose-200 rounded-xl text-xs space-y-1">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldAlert size={14} />
              <span>โหมดตั้งค่า — ยังไม่มีคลังผู้ใช้</span>
            </div>
            <p>
              เข้าด้วย <span className="font-mono font-bold">admin</span> /{' '}
              <span className="font-mono font-bold">admin1234</span> แล้วไปที่เมนู
              “ระบบ → จัดการผู้ใช้” กดปุ่ม “สร้างตาราง” เพื่อเริ่มใช้งานจริง
            </p>
            <p className="text-rose-300/80">
              รหัสชุดนี้อยู่ในโค้ดที่เปิดอ่านได้ — ตราบใดที่ยังไม่สร้างตาราง (หรือยังไม่ตั้ง
              APP_ADMIN_USER/APP_ADMIN_PASSWORD) ใครก็เข้าได้
            </p>
          </div>
        )}

        {setup?.weakSecret && (
          <div className="mt-3 p-3 bg-amber-950/50 border border-amber-800/70 text-amber-200 rounded-xl text-xs">
            ยังไม่ได้ตั้ง <span className="font-mono">AUTH_SECRET</span> บน Vercel — ตั๋วเข้าระบบใช้กุญแจตั้งต้น
            ซึ่งปลอมได้ ตั้งค่านี้เป็นข้อความสุ่มยาว ๆ แล้ว deploy ใหม่
          </div>
        )}
      </div>
    </div>
  );
}
