import React, { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, AlertCircle, RefreshCw, ChevronRight, Users } from 'lucide-react';
import { useBranches } from '../lib/useBranches';
import { normalizeOutletId } from '../lib/branches';
import { dateLabel } from '../lib/thaiDate';

/*
 * ACC > ค้นหาสมาชิก — ทุกบิลของสาขาหลัก (NaraiPos) ในฐาน ไม่จำกัดช่วงวันที่
 *
 *   1) เปิดหน้า → 300 คนแรกตามที่เรียง (มาล่าสุด/จำนวนบิล/ยอดรวม) จาก /api/members
 *      พิมพ์เลขสมาชิกตั้งแต่ 3 ตัว → ค้นจากทั้งฐาน (หยุดพิมพ์ครู่หนึ่งค่อยยิง) พิมพ์บางส่วนก็เจอ
 *      ไม่โหลดทั้งหมดทีเดียวแล้ว — สมาชิกเป็นแสนคน = ราว 15 MB เกินเพดานคำตอบของ Vercel (4.5 MB)
 *   2) กดสมาชิก → ดึงบิลทั้งหมดของคนนั้น (/api/members?member=…)
 *   3) กดบิล → ดึงรายการในบิลนั้นบิลเดียว (/api/members?outlet=&check=&day=)
 */

const MIN_QUERY = 3;      // พิมพ์น้อยกว่านี้ยังไม่ค้น (เลข 1-2 ตัวตรงกับแทบทุกคน)
const TYPE_DELAY = 350;  // ms — รอให้หยุดพิมพ์ก่อนค่อยยิงฐาน
const digits = (v) => String(v ?? '').replace(/[^0-9A-Za-z]/g, '').toLowerCase();
const trimMember = (v) => String(v ?? '').trim();
const money = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayOf = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : '');
const timeOf = (s) => (/\d{2}:\d{2}/.exec(String(s || '').slice(10)) || [''])[0];
const billTotal = (b) => Number(b.billTotal ?? b.amount ?? 0) || 0;
// วันเปิดบิลก่อน (กติกาเดียวกับหน้ายอดขาย) — ไม่มี/เป็นค่าหลอกค่อยใช้วันที่ของบิล
const billDay = (b) => {
  const s = dayOf(b.startTime);
  return s && s >= '2000-01-01' ? s : dayOf(b.date);
};

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json().catch(() => ({ error: `เซิร์ฟเวอร์ตอบกลับไม่ใช่ JSON (HTTP ${r.status})` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export default function MemberLookup() {
  const { branches } = useBranches({ activeOnly: false });
  const branchOf = useMemo(() => {
    const m = {};
    branches.forEach(b => { if (b.outletId) m[String(normalizeOutletId(b.outletId))] = b; });
    return (id) => {
      const b = m[String(normalizeOutletId(id))];
      return b ? b.code : (id == null ? '—' : `#${id}`);
    };
  }, [branches]);

  const [members, setMembers] = useState(null);   // ผลชุดล่าสุดจากฐาน (ไม่เกิน limit คน)
  const [listMeta, setListMeta] = useState({ total: 0, limit: 0, q: '' });
  const [listErr, setListErr] = useState('');
  const [loadMs, setLoadMs] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('last');   // last | bills | total

  const [current, setCurrent] = useState(null);   // member (ค่าดิบจากฐาน)
  const [bills, setBills] = useState(null);
  const [billsErr, setBillsErr] = useState('');
  const [billsCapped, setBillsCapped] = useState(0);

  const [openKey, setOpenKey] = useState(null);
  const [lines, setLines] = useState({});   // key → { rows, err }

  const k = digits(q);
  const tooShort = k.length > 0 && k.length < MIN_QUERY;
  const effQ = tooShort ? '' : k;   // ยังพิมพ์ไม่ถึง 3 ตัว = ใช้รายชื่อหน้าแรกไปก่อน

  // ยิงฐานเมื่อคำค้น/การเรียงเปลี่ยน — คำตอบที่มาช้ากว่าคำขอถัดไปทิ้ง (พิมพ์เร็วแล้วผลเก่ามาทับผลใหม่)
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setMembers(null);
      setListErr('');
      const t0 = performance.now();
      const qs = new URLSearchParams({ sort });
      if (effQ) qs.set('q', effQ);
      getJson(`/api/members?${qs}`)
        .then(j => {
          if (!alive) return;
          setMembers(j.data || []);
          setListMeta({ total: Number(j.total) || (j.data || []).length, limit: Number(j.limit) || 0, q: effQ });
          setLoadMs(performance.now() - t0);
        })
        .catch(err => { if (alive) setListErr(err.message); });
    }, effQ ? TYPE_DELAY : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [effQ, sort, reloadKey]);

  const list = members || [];

  const pick = (member) => {
    setCurrent(member);
    setBills(null);
    setBillsErr('');
    setOpenKey(null);
    getJson(`/api/members?member=${encodeURIComponent(member)}`)
      .then(j => {
        const rows = j.data || [];
        setBills(rows);
        setBillsCapped(j.limit && rows.length >= j.limit ? j.limit : 0);
      })
      .catch(err => setBillsErr(err.message));
  };

  const toggleBill = (b) => {
    const key = `${b.outletID}#${b.checkID}`;
    if (openKey === key) { setOpenKey(null); return; }
    setOpenKey(key);
    if (lines[key]?.rows) return;
    setLines(l => ({ ...l, [key]: { rows: null, err: '' } }));
    getJson(`/api/members?outlet=${encodeURIComponent(b.outletID)}&check=${encodeURIComponent(b.checkID)}&day=${billDay(b)}`)
      .then(j => setLines(l => ({ ...l, [key]: { rows: j.data || [], err: '' } })))
      .catch(err => setLines(l => ({ ...l, [key]: { rows: null, err: err.message } })));
  };

  const sumTotal = (bills || []).reduce((s, b) => s + billTotal(b), 0);
  const visitedBranches = [...new Set((bills || []).map(b => branchOf(b.outletID)))];

  const SortChip = ({ id, label }) => (
    <button onClick={() => setSort(id)}
      className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${sort === id ? 'bg-amber-50 border-amber-400 text-amber-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
      {label}
    </button>
  );

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)] min-h-[600px]">
        {/* ───── รายชื่อสมาชิก ───── */}
        <section className="p-4 space-y-3 border-b lg:border-b-0 lg:border-r border-slate-100">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-slate-800 flex items-center gap-1.5"><Users size={16} /> สมาชิก</h3>
            <button onClick={() => setReloadKey(n => n + 1)} disabled={!members && !listErr} title="โหลดรายชื่อใหม่"
              className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><RefreshCw size={15} /></button>
          </div>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="พิมพ์เลขสมาชิก (บางส่วนก็ได้)…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
          {tooShort && (
            <div className="text-[11px] text-amber-700">พิมพ์อย่างน้อย {MIN_QUERY} ตัวเพื่อค้นจากทั้งฐาน</div>
          )}
          {members && (
            <div className="text-[11px] text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1">
              {listMeta.q
                ? `พบ ${listMeta.total.toLocaleString()} คนที่มี "${listMeta.q}"`
                : `สมาชิกทั้งหมด ${listMeta.total.toLocaleString()} คน`}
              {listMeta.total > list.length && ` · แสดง ${list.length.toLocaleString()} คนแรก`}
              {' '}· ค้นทุกบิลในฐาน · {(loadMs / 1000).toFixed(1)} วินาที
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            เรียงตาม <SortChip id="last" label="มาล่าสุด" /><SortChip id="bills" label="จำนวนบิล" /><SortChip id="total" label="ยอดรวม" />
          </div>

          {!members && !listErr && (
            <div className="py-10 text-center text-sm text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />{effQ ? `กำลังค้น "${effQ}" ในทุกบิล…` : 'กำลังโหลดรายชื่อสมาชิก…'}</div>
          )}
          {listErr && (
            <div className="text-xs text-rose-600 flex items-start gap-1.5"><AlertCircle size={14} className="flex-shrink-0 mt-0.5" />{listErr}</div>
          )}
          {members && (
            <div className="space-y-1.5 max-h-[560px] overflow-y-auto pr-1">
              {list.map(m => {
                const on = current === m.member;
                return (
                  <button key={m.member} onClick={() => pick(m.member)}
                    className={`w-full text-left px-3 py-2 rounded-xl border transition-colors ${on ? 'border-amber-400 bg-amber-50 ring-1 ring-amber-400' : 'border-slate-200 hover:border-amber-300 bg-white'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-slate-800 truncate">{trimMember(m.member)}</span>
                      <span className="font-mono text-sm text-slate-700 whitespace-nowrap">฿{money(m.total)}</span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {Number(m.bills).toLocaleString()} บิล · มาล่าสุด {dateLabel(dayOf(m.lastDate))} · ครั้งแรก {dateLabel(dayOf(m.firstDate))}
                    </div>
                  </button>
                );
              })}
              {list.length === 0 && <div className="py-8 text-center text-sm text-slate-400">ไม่พบเลขสมาชิกนี้</div>}
              {listMeta.total > list.length && (
                <div className="py-2 text-center text-[11px] text-slate-400">
                  แสดง {list.length.toLocaleString()} จาก {listMeta.total.toLocaleString()} คน — พิมพ์เลขสมาชิกเพื่อค้นให้แคบลง
                </div>
              )}
            </div>
          )}
        </section>

        {/* ───── บิลของสมาชิก ───── */}
        <section className="p-4 space-y-3 min-w-0">
          {!current && (
            <div className="py-20 text-center text-sm text-slate-400">เลือกสมาชิกทางซ้ายเพื่อดูบิลทั้งหมด</div>
          )}
          {current && (
            <>
              <h3 className="font-bold text-slate-800">สมาชิก <span className="font-mono">{trimMember(current)}</span></h3>
              {!bills && !billsErr && (
                <div className="py-10 text-center text-sm text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังดึงบิลทั้งหมด…</div>
              )}
              {billsErr && (
                <div className="text-xs text-rose-600 flex items-start gap-1.5"><AlertCircle size={14} className="flex-shrink-0 mt-0.5" />{billsErr}</div>
              )}
              {bills && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      ['จำนวนบิล', bills.length.toLocaleString()],
                      ['ยอดรวม', `฿${money(sumTotal)}`],
                      ['เฉลี่ยต่อบิล', bills.length ? `฿${money(sumTotal / bills.length)}` : '—'],
                      ['สาขาที่ไป', visitedBranches.join(', ') || '—'],
                    ].map(([label, v]) => (
                      <div key={label} className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 min-w-0">
                        <div className="text-[11px] text-slate-500">{label}</div>
                        <div className="font-mono text-base truncate" title={v}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {billsCapped > 0 && (
                    <div className="text-[11px] text-amber-700">แสดงเฉพาะ {billsCapped.toLocaleString()} บิลล่าสุด</div>
                  )}
                  <p className="text-[11px] text-slate-400">กดที่บิลเพื่อดูรายการในบิลนั้น</p>
                  <div className="overflow-x-auto border border-slate-100 rounded-xl">
                    <table className="w-full text-sm min-w-[640px]">
                      <thead className="bg-slate-50 text-slate-500 text-xs">
                        <tr>
                          <th className="px-3 py-2 text-left">วันที่</th>
                          <th className="px-3 py-2 text-left">สาขา</th>
                          <th className="px-3 py-2 text-left">เลขบิล</th>
                          <th className="px-3 py-2 text-left">โต๊ะ</th>
                          <th className="px-3 py-2 text-left">วิธีจ่าย</th>
                          <th className="px-3 py-2 text-right">ยอดบิล</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {bills.map(b => {
                          const key = `${b.outletID}#${b.checkID}`;
                          const open = openKey === key;
                          const ln = lines[key];
                          return (
                            <React.Fragment key={key}>
                              <tr onClick={() => toggleBill(b)} className={`cursor-pointer ${open ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <ChevronRight size={13} className={`inline mr-1 text-slate-400 transition-transform ${open ? 'rotate-90 text-amber-600' : ''}`} />
                                  {dateLabel(billDay(b))} <span className="font-mono text-xs text-slate-400">{timeOf(b.startTime) || timeOf(b.date)}</span>
                                </td>
                                <td className="px-3 py-2">{branchOf(b.outletID)}</td>
                                <td className="px-3 py-2 font-mono text-xs text-slate-500">{b.checkID}</td>
                                <td className="px-3 py-2 font-mono text-xs text-slate-500">{b.tableID || '—'}</td>
                                <td className="px-3 py-2">
                                  {b.paidType ? <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[11px] font-semibold">{b.paidType}</span> : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono">{money(billTotal(b))}</td>
                              </tr>
                              {open && (
                                <tr>
                                  <td colSpan={6} className="bg-slate-50 px-3 py-2 pl-9">
                                    {!ln?.rows && !ln?.err && (
                                      <div className="py-2 text-xs text-slate-400"><Loader2 size={13} className="animate-spin inline mr-1.5" />กำลังดึงรายการในบิล…</div>
                                    )}
                                    {ln?.err && <div className="py-2 text-xs text-rose-600">{ln.err}</div>}
                                    {ln?.rows && (ln.rows.length === 0 ? (
                                      <div className="py-2 text-xs text-slate-400">ไม่พบรายการของบิลนี้</div>
                                    ) : (
                                      <table className="w-full text-xs">
                                        <thead className="text-slate-400">
                                          <tr>
                                            <th className="py-1 text-left font-semibold">รหัส</th>
                                            <th className="py-1 text-left font-semibold">รายการ</th>
                                            <th className="py-1 text-right font-semibold">จำนวน</th>
                                            <th className="py-1 text-right font-semibold">ราคา/หน่วย</th>
                                            <th className="py-1 text-right font-semibold">รวม</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {ln.rows.map((r, i) => {
                                            const isVoid = Boolean(r.void) && r.void !== '0' && r.void !== 'N';
                                            const qty = Number(r.quantity) || 0;
                                            const total = r.grossPrice != null ? Number(r.grossPrice) : qty * (Number(r.unitPrice) || 0);
                                            return (
                                              <tr key={i} className={`border-t border-dashed border-slate-200 ${isVoid ? 'text-slate-400 line-through' : ''}`}>
                                                <td className="py-1 font-mono text-slate-500">{r.itemCode}</td>
                                                <td className="py-1">
                                                  {r.nameThai || r.nameEng}
                                                  {isVoid && <span className="ml-1.5 px-1.5 rounded-full bg-rose-50 text-rose-600 text-[10px] font-bold no-underline inline-block">ยกเลิก</span>}
                                                </td>
                                                <td className="py-1 text-right font-mono">{qty.toLocaleString()}</td>
                                                <td className="py-1 text-right font-mono">{money(r.unitPrice)}</td>
                                                <td className="py-1 text-right font-mono">{money(total)}</td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    ))}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                        {bills.length === 0 && (
                          <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">ไม่พบบิลของสมาชิกนี้</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
