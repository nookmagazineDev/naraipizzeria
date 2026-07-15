import React, { useState, useRef, useEffect } from 'react';
import { Loader2, Send, AlertCircle, Trash2, Database } from 'lucide-react';

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
                    {renderLite(m.text).map((b, bi) => b.type === 'table' ? (
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
