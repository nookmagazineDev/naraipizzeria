import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, AlertCircle, CheckCircle, X, Search, AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { apiCall } from '../lib/qcrdApi';
import { nudgeModal } from '../lib/modalNudge';
import { dateLabel } from '../lib/thaiDate';

/*
 * หน้าเมนู QC/RD — ปุ่ม "คำนวณต้นทุนใหม่"
 * recostMenus { dryRun: true } คิดต้นทุนทุกเมนูจากราคาวัตถุดิบล่าสุด (ยังไม่บันทึก) → หน้าสรุป
 * กดบันทึก → recostMenus { dryRun: false, codes } เฉพาะเมนูชุดเดียวกับที่โชว์
 * ต้นทุนเดิมฝั่งฐานย้ายไปช่อง "ต้นทุนก่อนหน้า" ให้เอง ยอดใช้ในสูตรไม่ถูกแตะ (ดู lib/qcrdSql.mjs)
 */

export const FOOD_COST_WARN = 35;   // ต้นทุน/ราคาขาย เกินนี้ (%) ขึ้นสีแดง
const fmtMoney = (n) => (n === null || n === undefined ? '—'
  : Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const costPct = (c) => (c.oldCost > 0 ? ((c.newCost - c.oldCost) / c.oldCost) * 100 : null);
const foodCost = (cost, price) => (cost !== null && cost !== undefined && price > 0 ? (cost / price) * 100 : null);

export function FoodCost({ cost, price }) {
  const fc = foodCost(cost, price);
  if (fc === null) return <span className="text-slate-300">—</span>;
  return <span className={`font-mono ${fc > FOOD_COST_WARN ? 'text-rose-600 font-semibold' : ''}`}>{fc.toFixed(1)}%</span>;
}

export function CostDelta({ from, to }) {
  if (!(from > 0) || to === null || to === undefined || Math.abs(to - from) < 0.0001) return null;
  const p = ((to - from) / from) * 100;
  return (
    <span className={`ml-1 px-1 rounded-full text-[10px] font-bold font-mono ${p > 0 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'}`}>
      {p > 0 ? '▲' : '▼'}{Math.abs(p).toFixed(1)}%
    </span>
  );
}

export function RecostDialog({ degraded, lockHint, onClose, onDone }) {
  const [preview, setPreview] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [filter, setFilter] = useState('all');   // all | up | down
  const [search, setSearch] = useState('');
  // กดหัวคอลัมน์เรียงตาม % — { key: 'cost' (ต้นทุนเปลี่ยนกี่ %) | 'fc' (food cost ใหม่ %), dir: 'desc' | 'asc' }
  const [sort, setSort] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    apiCall('recostMenus', { dryRun: true })
      .then(res => setPreview(res.data))
      .catch(err => setLoadErr(err.message || 'คำนวณต้นทุนไม่สำเร็จ'));
  }, []);

  const changes = preview?.changes || [];
  const up = changes.filter(c => c.oldCost !== null && c.newCost > c.oldCost);
  const down = changes.filter(c => c.oldCost !== null && c.newCost < c.oldCost);
  const avgFc = (key) => {
    const xs = changes.map(c => foodCost(c[key], c.price)).filter(v => v !== null);
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  };
  const fcOld = avgFc('oldCost');
  const fcNew = avgFc('newCost');

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = changes.filter(c => filter === 'all' || (c.oldCost !== null
      && (filter === 'up' ? c.newCost > c.oldCost : c.newCost < c.oldCost)));
    const hit = q ? base.filter(c => `${c.code} ${c.name}`.toLowerCase().includes(q)) : base;
    if (!sort) return hit;
    const val = sort.key === 'cost' ? costPct : (c => foodCost(c.newCost, c.price));
    // ไม่มีค่า (ไม่มีต้นทุนเดิม/ไม่มีราคาขาย) ไว้ท้ายเสมอ ไม่ว่าจะเรียงทางไหน
    return [...hit].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null) return y === null ? 0 : 1;
      if (y === null) return -1;
      return sort.dir === 'desc' ? y - x : x - y;
    });
  }, [changes, filter, search, sort]);

  // กดครั้งแรก = มากไปน้อย · ครั้งที่สอง = น้อยไปมาก · ครั้งที่สาม = เลิกเรียง
  const toggleSort = (key) => setSort(s => (!s || s.key !== key ? { key, dir: 'desc' }
    : s.dir === 'desc' ? { key, dir: 'asc' } : null));
  const SortHead = ({ id, children, hint }) => {
    const on = sort?.key === id;
    const Icon = !on ? ArrowUpDown : sort.dir === 'desc' ? ArrowDown : ArrowUp;
    return (
      <th className="px-3 py-2 text-right">
        <button onClick={() => toggleSort(id)} title={hint}
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-slate-200/70 ${on ? 'text-indigo-600 font-bold' : ''}`}>
          {children}<Icon size={12} />
          {on && <span className="text-[10px] font-normal">{sort.dir === 'desc' ? 'มาก→น้อย' : 'น้อย→มาก'}</span>}
        </button>
      </th>
    );
  };

  const apply = async () => {
    if (degraded) { setMsg({ ok: false, msg: lockHint }); return; }
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiCall('recostMenus', { dryRun: false, codes: changes.map(c => c.code) });
      setDone(true);
      setMsg({ ok: true, msg: `บันทึกต้นทุนใหม่ ${Number(res.data?.updated || 0).toLocaleString()} เมนูแล้ว · ต้นทุนเดิมเก็บไว้ในช่อง "ต้นทุนก่อนหน้า"` });
      onDone();
    } catch (err) {
      setMsg({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  const Chip = ({ id, label, n }) => (
    <button onClick={() => setFilter(id)}
      className={`px-3 py-1 rounded-full text-xs font-semibold border ${filter === id ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
      {label} <span className="font-mono font-normal ml-0.5">{n.toLocaleString()}</span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={nudgeModal}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-800">สรุปต้นทุนใหม่ก่อนบันทึก</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {done ? 'บันทึกแล้ว' : 'คิดจากราคาวัตถุดิบล่าสุดในทะเบียน · ระบบยังไม่ได้บันทึกอะไร'}
            </p>
          </div>
          <button onClick={onClose} disabled={saving} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><X size={20} /></button>
        </div>

        <div className="p-5 overflow-auto space-y-3">
          {!preview && !loadErr && (
            <div className="py-10 text-center text-slate-400 text-sm"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังคำนวณต้นทุนทุกเมนู…</div>
          )}
          {loadErr && (
            <div className="text-sm text-rose-600 flex items-start gap-1.5"><AlertCircle size={15} className="flex-shrink-0 mt-0.5" />{loadErr}</div>
          )}
          {preview && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                  <div className="text-[11px] text-slate-500">เมนูที่ต้นทุนเปลี่ยน</div>
                  <div className="font-mono text-lg">{changes.length.toLocaleString()} <span className="text-xs text-slate-400">/ {preview.menus.toLocaleString()}</span></div>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                  <div className="text-[11px] text-slate-500">ต้นทุนขึ้น / ลง</div>
                  <div className="font-mono text-lg"><span className="text-rose-600">{up.length}</span> / <span className="text-emerald-600">{down.length}</span></div>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                  <div className="text-[11px] text-slate-500">food cost เฉลี่ย (เมนูที่เปลี่ยน)</div>
                  <div className="font-mono text-lg">{fcOld === null ? '—' : `${fcOld.toFixed(1)}%`} → {fcNew === null ? '—' : `${fcNew.toFixed(1)}%`}</div>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
                  <div className="text-[11px] text-slate-500">เท่าเดิม · ยังไม่มีสูตร (ข้าม)</div>
                  <div className="font-mono text-lg">{preview.same.toLocaleString()} · {preview.noBom.toLocaleString()}</div>
                </div>
              </div>

              {changes.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip id="all" label="ทั้งหมด" n={changes.length} />
                    <Chip id="up" label="ต้นทุนขึ้น" n={up.length} />
                    <Chip id="down" label="ต้นทุนลง" n={down.length} />
                    <div className="relative flex-1 min-w-[180px]">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาเมนู…"
                        className="w-full pl-9 pr-3 py-1.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </div>
                  </div>
                  <div className="overflow-x-auto border border-slate-100 rounded-xl max-h-[45vh]">
                    <table className="w-full text-sm min-w-[720px]">
                      <thead className="bg-slate-50 text-slate-500 text-xs sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left">เมนู</th>
                          <th className="px-3 py-2 text-right">ราคาขาย</th>
                          <th className="px-3 py-2 text-right">ต้นทุนเดิม</th>
                          <SortHead id="cost" hint="เรียงตามต้นทุนที่เปลี่ยน (%) — กดซ้ำเพื่อสลับมาก/น้อย">ต้นทุนใหม่</SortHead>
                          <SortHead id="fc" hint="เรียงตาม food cost ใหม่ (%) — กดซ้ำเพื่อสลับมาก/น้อย">food cost</SortHead>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {shown.map(c => (
                          <tr key={c.code}>
                            <td className="px-3 py-1.5">
                              <span className={c.status === 'ปิดการใช้งาน' ? 'text-slate-400' : 'text-slate-800'}>{c.name}</span>
                              <span className="ml-1.5 font-mono text-[11px] text-slate-400">{c.code}</span>
                              {c.why.length > 0 && (
                                <div className="text-[11px] text-slate-500">
                                  {c.why.map((w, i) => (
                                    <span key={i}>
                                      {i > 0 && ' · '}{w.name}{' '}
                                      {w.was > 0 ? (
                                        <span className={`font-mono ${w.now > w.was ? 'text-rose-600' : 'text-emerald-600'}`}>
                                          {w.now > w.was ? '▲' : '▼'}{Math.abs((w.now - w.was) / w.was * 100).toFixed(1)}%
                                        </span>
                                      ) : <span className="text-slate-400">(มีราคาแล้ว)</span>}
                                    </span>
                                  ))}
                                  {c.whyMore > 0 && ` · และอีก ${c.whyMore}`}
                                </div>
                              )}
                              {c.noPriceCount > 0 && (
                                <div className="text-[11px] text-amber-700">
                                  ⚠ ยังไม่มีราคา: {c.noPrice.join(', ')}{c.noPriceCount > c.noPrice.length ? ` และอีก ${c.noPriceCount - c.noPrice.length}` : ''} (คิดเป็น 0)
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{c.price === null ? '—' : fmtMoney(c.price)}</td>
                            <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                              {fmtMoney(c.oldCost)}
                              {c.oldCostAt && <div className="text-[10px] text-slate-400 font-sans">{dateLabel(c.oldCostAt)}</div>}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                              {fmtMoney(c.newCost)}<CostDelta from={c.oldCost} to={c.newCost} />
                            </td>
                            <td className="px-3 py-1.5 text-right whitespace-nowrap text-xs">
                              <FoodCost cost={c.oldCost} price={c.price} /> → <FoodCost cost={c.newCost} price={c.price} />
                            </td>
                          </tr>
                        ))}
                        {shown.length === 0 && (
                          <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">ไม่มีเมนู</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {!done && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                      กดบันทึกแล้ว ต้นทุนเดิมของเมนูเหล่านี้จะถูกเก็บไว้ในช่อง &quot;ต้นทุนก่อนหน้า&quot; พร้อมวันที่
                      และต้นทุนใหม่ลงวันที่วันนี้ · ยอดใช้ในสูตรไม่ถูกแตะ
                    </p>
                  )}
                </>
              ) : (
                <div className="py-6 text-center text-sm text-emerald-600 font-semibold">
                  <CheckCircle size={16} className="inline mr-1.5" />ต้นทุนทุกเมนูตรงกับราคาวัตถุดิบล่าสุดแล้ว ไม่มีอะไรต้องบันทึก
                </div>
              )}
            </>
          )}
          {msg && (
            <div className={`text-xs font-semibold flex items-start gap-1 ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
              {msg.ok ? <CheckCircle size={13} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />}{msg.msg}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-600">
            {!done && changes.length > 0 ? `จะบันทึกต้นทุนใหม่ ${changes.length.toLocaleString()} เมนู` : ''}
          </span>
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">
              {done || !changes.length ? 'ปิด' : 'ยกเลิก'}
            </button>
            {!done && changes.length > 0 && (
              <button onClick={apply} disabled={saving || degraded} title={degraded ? lockHint : ''}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                {saving ? 'กำลังบันทึก…' : `บันทึกต้นทุนใหม่ ${changes.length.toLocaleString()} เมนู`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
