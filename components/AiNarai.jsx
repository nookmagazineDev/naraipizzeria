import React, { useState, useRef, useEffect } from 'react';
import { Loader2, Send, AlertCircle, Trash2, Database } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts';

/*
 * AI NARAI — แชทถามข้อมูลยอดขาย/รายการขายด้วยภาษาคน
 * ส่งบทสนทนาไป /api/ai-chat → Gemini (function calling) ดึงข้อมูลจริงจาก
 * host API (SQL Server) ผ่านเครื่องมือ read-only แล้วสรุปตอบ
 */

const SUGGESTIONS = [
  'ยอดขายเดือนนี้ของทุกสาขาเป็นยังไงบ้าง',
  'เมนูขายดี 10 อันดับของ XUM เดือนที่แล้ว',
  'เทียบยอดขาย SJP กับ CRM สัปดาห์นี้',
  'สัดส่วนช่องทางการชำระเงินเดือนนี้',
];

// แยกข้อความออกเป็นส่วนข้อความ/กราฟ — AI แทรกกราฟมาเป็นบล็อก ```chart {json} ```
function splitSegments(text) {
  const segs = [];
  const re = /```chart\s*([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ kind: 'md', text: text.slice(last, m.index) });
    try {
      const spec = JSON.parse(m[1]);
      segs.push({ kind: 'chart', spec });
    } catch {
      segs.push({ kind: 'md', text: m[1] }); // JSON พัง → โชว์เป็นข้อความดิบ
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ kind: 'md', text: text.slice(last) });
  return segs;
}

const CHART_COLORS = ['#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6', '#f97316'];
const nfmt = v => (typeof v === 'number' ? v.toLocaleString('th-TH') : v);

// วาดกราฟจากสเปคที่ AI ส่งมา: bar (เปรียบเทียบ/อันดับ) / line (แนวโน้ม) / pie (สัดส่วน)
function ChartBlock({ spec }) {
  const { type = 'bar', title, xKey = 'label', series = [{ key: 'value', name: 'ค่า' }], data = [] } = spec || {};
  if (!Array.isArray(data) || data.length === 0) return null;
  const height = type === 'pie' ? 300 : Math.max(240, Math.min(340, data.length * 14));
  return (
    <div className="my-2 bg-white border border-slate-200 rounded-xl p-3">
      {title && <div className="text-xs font-bold text-slate-600 mb-1.5">{title}</div>}
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          {type === 'line' ? (
            <LineChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey={xKey} tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={nfmt} width={70} />
              <Tooltip formatter={v => nfmt(v)} />
              {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => (
                <Line key={s.key} type="monotone" dataKey={s.key} name={s.name || s.key}
                  stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={data.length <= 31} />
              ))}
            </LineChart>
          ) : type === 'pie' ? (
            <PieChart>
              <Pie data={data} dataKey={series[0]?.key || 'value'} nameKey={xKey}
                cx="50%" cy="50%" outerRadius={100}
                label={e => `${e[xKey]} (${nfmt(e[series[0]?.key || 'value'])})`}>
                {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={v => nfmt(v)} />
            </PieChart>
          ) : (
            <BarChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey={xKey} tick={{ fontSize: 10 }} interval={0}
                angle={data.length > 8 ? -35 : 0} textAnchor={data.length > 8 ? 'end' : 'middle'}
                height={data.length > 8 ? 60 : 30} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={nfmt} width={70} />
              <Tooltip formatter={v => nfmt(v)} />
              {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.name || s.key}
                  fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// แปลง markdown แบบเบา ๆ: **หนา**, ตาราง | a | b |, บรรทัดใหม่ (ไม่มี dependency เพิ่ม)
function renderLite(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let table = null;
  const flushTable = () => {
    if (table && table.length) blocks.push({ type: 'table', rows: table });
    table = null;
  };
  lines.forEach(line => {
    const t = line.trim();
    if (t.startsWith('|') && t.endsWith('|')) {
      const cells = t.slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) return; // แถวคั่นหัวตาราง
      if (!table) table = [];
      table.push(cells);
    } else {
      flushTable();
      blocks.push({ type: 'line', text: line });
    }
  });
  flushTable();
  return blocks;
}

function Bold({ text }) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p));
}

export default function AiNarai() {
  const [messages, setMessages] = useState([]); // {role:'user'|'model', text, tools?}
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  const send = async (textArg) => {
    const text = (textArg ?? input).trim();
    if (!text || loading) return;
    setInput('');
    setError('');
    const next = [...messages, { role: 'user', text }];
    setMessages(next);
    setLoading(true);
    try {
      const r = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ส่งเฉพาะ 12 ข้อความล่าสุด กัน token บวม
        body: JSON.stringify({ messages: next.slice(-12).map(m => ({ role: m.role, text: m.text })) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setMessages(m => [...m, { role: 'model', text: j.text, tools: j.toolCalls || [] }]);
    } catch (err) {
      setError(err.message || 'เกิดข้อผิดพลาด');
      setMessages(m => m.slice(0, -1)); // เอาคำถามที่ล้มเหลวออก ให้พิมพ์ใหม่ได้
      setInput(text);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 170px)' }}>
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col flex-1 overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white rounded-xl text-lg leading-none">✨</div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">AI NARAI</h2>
              <p className="text-xs text-slate-500">ถามข้อมูลยอดขาย/รายการขายด้วยภาษาคน — AI ดึงข้อมูลจริงจากฐานข้อมูล POS</p>
            </div>
          </div>
          {messages.length > 0 && (
            <button onClick={() => { setMessages([]); setError(''); }}
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-rose-500">
              <Trash2 size={13} /> ล้างบทสนทนา
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 && (
            <div className="text-center pt-10">
              <div className="text-4xl mb-3">✨</div>
              <p className="text-slate-500 text-sm mb-6">ลองถามดูได้เลย เช่น</p>
              <div className="flex flex-wrap justify-center gap-2 max-w-lg mx-auto">
                {SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => send(s)}
                    className="px-3 py-2 text-xs bg-violet-50 text-violet-700 border border-violet-100 rounded-xl hover:bg-violet-100 transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${m.role === 'user'
                ? 'bg-violet-500 text-white rounded-br-md'
                : 'bg-slate-50 border border-slate-100 text-slate-800 rounded-bl-md'}`}>
                {m.role === 'model' ? (
                  <div className="space-y-1">
                    {splitSegments(m.text).map((seg, si) => seg.kind === 'chart' ? (
                      <ChartBlock key={`c${si}`} spec={seg.spec} />
                    ) : (
                      <React.Fragment key={`t${si}`}>
                        {renderLite(seg.text).map((b, bi) => b.type === 'table' ? (
                      <div key={bi} className="overflow-x-auto my-2">
                        <table className="text-xs border-collapse">
                          <tbody>
                            {b.rows.map((row, ri) => (
                              <tr key={ri} className={ri === 0 ? 'bg-slate-100 font-bold' : 'border-t border-slate-200'}>
                                {row.map((c, ci) => <td key={ci} className="px-2.5 py-1.5 whitespace-nowrap"><Bold text={c} /></td>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                        ) : (
                          <p key={bi} className={b.text.trim() ? '' : 'h-1'}><Bold text={b.text} /></p>
                        ))}
                      </React.Fragment>
                    ))}
                    {m.tools?.length > 0 && (
                      <div className="pt-1.5 flex flex-wrap gap-1">
                        {m.tools.map((t, ti) => (
                          <span key={ti} title={JSON.stringify(t.args)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[9px] text-slate-400">
                            <Database size={8} /> {t.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : m.text}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-slate-50 border border-slate-100 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-slate-400 inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> กำลังดึงข้อมูลและวิเคราะห์…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mb-2 p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-700 flex items-center gap-2">
            <AlertCircle size={14} className="flex-shrink-0" /><span>{error}</span>
          </div>
        )}

        {/* Input */}
        <div className="p-4 border-t border-slate-100 flex gap-2">
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="พิมพ์คำถาม เช่น ยอดขาย XUM เดือนนี้เท่าไหร่…" disabled={loading}
            className="flex-1 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-slate-50" />
          <button onClick={() => send()} disabled={loading || !input.trim()}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-violet-500 hover:bg-violet-600 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-semibold rounded-xl transition-all">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
