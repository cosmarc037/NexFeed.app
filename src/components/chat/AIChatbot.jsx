import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Loader2, Sparkles, SquarePen } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { chatWithAssistant } from '@/services/azureAI';
import { base44 } from "@/api/base44Client";
import { motion, AnimatePresence } from 'framer-motion';

const { Order } = base44.entities;

/* ─── Action confirmation card ─────────────────────────────────────────────── */
function ActionCard({ actionType, params, orders, onDone }) {
  const [state, setState] = useState('idle');

  const LABELS = {
    COMBINE:  { title: 'Combine Orders',         icon: '🔗' },
    DIVERT:   { title: 'Divert Order',            icon: '↪️' },
    STATUS:   { title: 'Change Order Status',     icon: '🔄' },
    SEQUENCE: { title: 'Run Auto-Sequence',       icon: '⚡' },
  };

  function buildDescription() {
    switch (actionType) {
      case 'COMBINE':
        return `Combine ${params.orderIds?.length ?? 0} orders into one? Total volume: ${params.totalVolume ?? '?'} MT.`;
      case 'DIVERT':
        return `Divert "${params.orderName}" from ${params.fromLine} to ${params.toLine}?`;
      case 'STATUS':
        return `Change "${params.orderName}" status from "${params.fromStatus}" to "${params.toStatus}"?`;
      case 'SEQUENCE':
        return `Run auto-sequence for ${params.line}? This will reorder movable orders on that line.`;
      default:
        return 'Confirm this action?';
    }
  }

  async function handleConfirm() {
    setState('running');
    try {
      let msg = '';
      if (actionType === 'STATUS') {
        const fpr = String(params.orderId ?? '').trim();
        const order = (orders ?? []).find(o =>
          String(o.fpr ?? '').trim() === fpr ||
          String(o.material_code ?? '').trim() === fpr
        );
        if (order?.id) {
          await Order.update(order.id, { status: params.toStatus });
          msg = `Status of "${params.orderName || order.item_description}" updated to "${params.toStatus}". The schedule will refresh shortly.`;
        } else {
          msg = `Could not locate the order (FPR: ${fpr}) in the current schedule. Please update it manually.`;
        }
      } else if (actionType === 'COMBINE') {
        msg = `To combine these orders, use the Smart Combine panel in the left sidebar and select the orders there.`;
      } else if (actionType === 'DIVERT') {
        msg = `To divert this order, right-click it on the schedule and choose "Divert to Line".`;
      } else if (actionType === 'SEQUENCE') {
        msg = `To run auto-sequence, open the Auto-Sequence option from the line's action menu in the schedule.`;
      } else {
        msg = 'Please apply this change using the main schedule interface.';
      }
      onDone(`✅ ${msg}`);
    } catch (err) {
      onDone(`❌ Action failed: ${err.message}`);
    } finally {
      setState('idle');
    }
  }

  const meta = LABELS[actionType] ?? { title: 'Action', icon: '⚡' };

  return (
    <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, overflow:'hidden', margin:'4px 0', fontSize:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 12px', background:'#f9fafb', borderBottom:'1px solid #e5e7eb', fontWeight:600, color:'#374151' }}>
        <span style={{ fontSize:14 }}>{meta.icon}</span>
        <span>{meta.title}</span>
      </div>
      <div style={{ padding:'10px 12px', color:'#4b5563', lineHeight:1.5 }}>
        {buildDescription()}
      </div>
      {state === 'idle' && (
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, padding:'8px 12px', borderTop:'1px solid #f3f4f6' }}>
          <button
            onClick={() => onDone('Action cancelled.')}
            style={{ padding:'6px 14px', fontSize:12, fontWeight:500, color:'#6b7280', background:'#fff', border:'1px solid #d1d5db', borderRadius:6, cursor:'pointer' }}
          >Cancel</button>
          <button
            onClick={handleConfirm}
            style={{ padding:'6px 14px', fontSize:12, fontWeight:600, color:'#fff', background:'#fd5108', border:'none', borderRadius:6, cursor:'pointer' }}
          >Confirm</button>
        </div>
      )}
      {state === 'running' && (
        <div style={{ padding:'8px 12px', color:'#9ca3af', fontSize:11, borderTop:'1px solid #f3f4f6', display:'flex', alignItems:'center', gap:6 }}>
          <Loader2 style={{ width:12, height:12, animation:'spin 1s linear infinite' }} /> Processing…
        </div>
      )}
    </div>
  );
}

/* ─── Content Parser ─────────────────────────────────────────────────────────── */
function parseMarkdownTable(lines, startIndex) {
  try {
    const headerLine = lines[startIndex].trim();
    const separatorLine = lines[startIndex + 1]?.trim();
    if (!headerLine.includes('|') || !separatorLine?.includes('---')) return null;
    const headers = headerLine.split('|').map(h => h.trim()).filter(h => h);
    const rows = [];
    let i = startIndex + 2;
    while (i < lines.length && lines[i].trim().includes('|')) {
      const cells = lines[i].trim().split('|').map(c => c.trim()).filter(c => c);
      if (cells.length > 0) rows.push(cells);
      i++;
    }
    return { section: { type: 'table', headers, rows }, endIndex: i - 1 };
  } catch { return null; }
}

function parseDataBlock(lines, startIndex) {
  const items = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    const headerMatch = line.match(/^(Line \d+|Feedmill \d+|Powermix)[\s(:]*(.*)$/i);
    if (headerMatch) {
      const item = { title: headerMatch[1], details: {} };
      if (headerMatch[2]) item.subtitle = headerMatch[2].replace(/^[:\s]+/, '').trim();
      i++;
      while (i < lines.length && lines[i].trim() &&
             !lines[i].trim().match(/^(Line \d+|Feedmill \d+|Powermix)/i) &&
             !lines[i].trim().match(/^(This|These|If|The|Overall|Total)/i)) {
        const subLine = lines[i].trim();
        const kvMatch = subLine.match(/^([^:]+):\s*(.+)/);
        if (kvMatch) item.details[kvMatch[1].trim()] = kvMatch[2].trim();
        i++;
      }
      items.push(item);
    } else break;
  }
  return { section: { type: 'lineCard', data: items }, endIndex: i - 1 };
}

function parseNumberedList(lines, startIndex) {
  const items = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = line.match(/^\d+\.\s+(.*)/);
    if (match) { items.push(match[1]); i++; } else break;
  }
  return { section: { type: 'list', items, ordered: true }, endIndex: i - 1 };
}

function parseBulletList(lines, startIndex) {
  const items = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = line.match(/^[-•*]\s+(.*)/);
    if (match) { items.push(match[1]); i++; } else break;
  }
  return { section: { type: 'list', items, ordered: false }, endIndex: i - 1 };
}

function parseResponseContent(content) {
  if (!content) return [{ type: 'text', content: '' }];
  const sections = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    if (line.includes('|') && lines[i + 1]?.includes('---')) {
      const table = parseMarkdownTable(lines, i);
      if (table) { sections.push(table.section); i = table.endIndex + 1; continue; }
    }

    if (line.match(/^(Line \d+|Feedmill \d+|Powermix)/i) && line.includes(':')) {
      const block = parseDataBlock(lines, i);
      if (block.section.data.length > 0) { sections.push(block.section); i = block.endIndex + 1; continue; }
    }

    if (line.match(/^\d+\.\s/)) {
      const list = parseNumberedList(lines, i);
      sections.push(list.section); i = list.endIndex + 1; continue;
    }

    if (line.match(/^[-•*]\s/)) {
      const list = parseBulletList(lines, i);
      sections.push(list.section); i = list.endIndex + 1; continue;
    }

    if (line.match(/^\*\*.*\*\*$/) || line.match(/^#+\s/)) {
      const headerText = line.replace(/\*\*/g, '').replace(/^#+\s/, '').trim();
      sections.push({ type: 'header', content: headerText });
      i++; continue;
    }

    let textBlock = line;
    i++;
    while (i < lines.length && lines[i].trim() &&
           !lines[i].trim().match(/^[\|#\d]/) &&
           !lines[i].trim().match(/^[-•*]\s/) &&
           !lines[i].trim().match(/^(Line \d+|Feedmill \d+|Powermix)/i)) {
      textBlock += ' ' + lines[i].trim();
      i++;
    }
    sections.push({ type: 'text', content: textBlock });
  }
  return sections.length > 0 ? sections : [{ type: 'text', content }];
}

/* ─── Inline text renderer (handles **bold**) ─────────────────────────────── */
function InlineText({ text }) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/* ─── Visual components ──────────────────────────────────────────────────── */
function formatCellValue(value) {
  if (!value) return '—';
  const lv = value.toLowerCase();
  if (lv === 'critical') return <span className="chat-status-critical">{value}</span>;
  if (lv === 'urgent')   return <span className="chat-status-urgent">{value}</span>;
  if (lv === 'monitor')  return <span className="chat-status-monitor">{value}</span>;
  if (lv === 'sufficient') return <span className="chat-status-sufficient">{value}</span>;
  if (value.startsWith('-')) return <span className="chat-value-negative">{value}</span>;
  return value;
}

function ChatTable({ headers, rows }) {
  return (
    <div className="chat-table-wrapper">
      <table className="chat-table">
        <thead>
          <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => <td key={ci}>{formatCellValue(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineCard({ data }) {
  return (
    <div className="chat-line-cards">
      {data.map((item, i) => (
        <div key={i} className="chat-line-card">
          <div className="chat-line-card-header">
            <span className="chat-line-card-title">{item.title}</span>
            {item.subtitle && <span className="chat-line-card-subtitle">{item.subtitle}</span>}
          </div>
          {Object.keys(item.details).length > 0 && (
            <div className="chat-line-card-details">
              {Object.entries(item.details).map(([k, v], j) => (
                <div key={j} className="chat-line-card-detail">
                  <span className="chat-detail-key">{k}</span>
                  <span className="chat-detail-value">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ChatList({ items, ordered }) {
  if (ordered) {
    return (
      <ol className="chat-ordered-list">
        {items.map((item, i) => <li key={i}><InlineText text={item} /></li>)}
      </ol>
    );
  }
  return (
    <ul className="chat-bullet-list">
      {items.map((item, i) => <li key={i}><InlineText text={item} /></li>)}
    </ul>
  );
}

function FormattedResponse({ content }) {
  const sections = parseResponseContent(content);
  return (
    <div className="chat-formatted">
      {sections.map((section, i) => {
        switch (section.type) {
          case 'table':
            return <ChatTable key={i} headers={section.headers} rows={section.rows} />;
          case 'list':
            return <ChatList key={i} items={section.items} ordered={section.ordered} />;
          case 'lineCard':
            return <LineCard key={i} data={section.data} />;
          case 'header':
            return <div key={i} className="chat-section-header">{section.content}</div>;
          case 'divider':
            return <div key={i} className="chat-divider" />;
          default:
            return <p key={i} className="chat-text"><InlineText text={section.content} /></p>;
        }
      })}
    </div>
  );
}

/* ─── Helpers ───────────────────────────────────────────────────────────────── */
function parseResponse(text) {
  const results = [];
  const actionRe = /\[ACTION:(COMBINE|DIVERT|STATUS|SEQUENCE)\]([\s\S]*?)\[\/ACTION\]/g;
  let cleaned = text;
  let m;
  while ((m = actionRe.exec(text)) !== null) {
    try {
      const params = JSON.parse(m[2]);
      results.push({ kind: 'action', actionType: m[1], params });
      cleaned = cleaned.replace(m[0], '').trim();
    } catch { /* ignore bad JSON */ }
  }
  if (cleaned.trim()) results.unshift({ kind: 'text', content: cleaned.trim() });
  if (!results.length) results.push({ kind: 'text', content: text });
  return results;
}

const QUICK_ACTIONS = [
  { label: '🔴 Critical Stock',     query: 'Which products are critical right now?' },
  { label: '📊 Line Status',         query: 'Show me the current load for all feedmill lines' },
  { label: '🔗 Combine Suggestions', query: 'Which orders can be combined?' },
  { label: '📋 Today\'s Summary',    query: "Give me a summary of today's production schedule" },
  { label: '📦 Stock Alerts',        query: 'Show me all urgent and critical stock alerts' },
  { label: '⏰ Delay Risks',         query: 'Are there any orders at risk of delay?' },
];

const WELCOME = {
  kind: 'text',
  role: 'assistant',
  id: 0,
  content: "Hi! I'm your NexFeed production planning assistant. I have full access to your orders, N10D stock data, and master data. Ask me anything about schedules, stock levels, line loads, or combine opportunities.",
};

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function AIChatbot({ orders = [], n10dRecords = [], kbRecords = [], hidden }) {
  const [isOpen, setIsOpen]       = useState(false);
  const [messages, setMessages]   = useState([WELCOME]);
  const [input, setInput]         = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const sessionRef = useRef(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen]);

  function addMessage(msg) {
    setMessages(prev => [...prev, { id: Date.now() + Math.random(), ...msg }]);
  }

  async function handleSend(text) {
    const q = (text ?? input).trim();
    if (!q || isLoading) return;
    setInput('');
    const session = sessionRef.current;

    addMessage({ kind: 'text', role: 'user', content: q });
    setIsLoading(true);

    try {
      const history = messages
        .filter(m => m.kind === 'text')
        .map(m => ({ role: m.role, content: m.content }))
        .concat({ role: 'user', content: q });

      const reply = await chatWithAssistant(history, { orders, n10dRecords, kbRecords });
      if (sessionRef.current !== session) return;

      const parts = parseResponse(reply);
      parts.forEach(p => addMessage({ ...p, role: 'assistant' }));
    } catch (err) {
      if (sessionRef.current !== session) return;
      addMessage({ kind: 'text', role: 'assistant', content: "Sorry, I ran into an error. Please try again." });
    } finally {
      if (sessionRef.current === session) setIsLoading(false);
    }
  }

  function handleActionDone(msg) {
    addMessage({ kind: 'text', role: 'assistant', content: msg });
  }

  function resetChat() {
    sessionRef.current++;
    setMessages([WELCOME]);
    setInput('');
    setIsLoading(false);
  }

  const showQuickActions = messages.length <= 1;

  return (
    <div style={hidden ? { display:'none' } : undefined}>
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            data-testid="button-smart-assistant"
            initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
            onClick={() => setIsOpen(true)}
            className="chat-bubble fixed bottom-6 right-6 w-14 h-14 rounded-full bg-[#fd5108] text-white shadow-lg hover:bg-[#fe7c39] transition-colors flex items-center justify-center z-50"
            data-tour="chat-bubble"
          >
            <MessageCircle className="h-6 w-6" />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity:0, y:20, scale:0.95 }}
            animate={{ opacity:1, y:0, scale:1 }}
            exit={{ opacity:0, y:20, scale:0.95 }}
            className="fixed bottom-6 right-6 bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden z-50"
            style={{ width:440, height:580 }}
            data-testid="panel-smart-assistant"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-[#fd5108] to-[#fe7c39] flex-shrink-0">
              <div className="flex items-center gap-2 text-white">
                <Sparkles className="h-4 w-4" />
                <div>
                  <div className="font-semibold text-[13px] leading-none">Smart Assistant</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button onClick={resetChat} className="text-white/80 hover:text-white p-1" data-testid="button-new-chat">
                        <SquarePen className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">New conversation</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <button onClick={() => setIsOpen(false)} className="text-white/80 hover:text-white p-1" data-testid="button-close-assistant">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2" style={{ scrollBehavior:'smooth' }}>
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.kind === 'text' && (
                    <div className={`chat-msg-bubble ${msg.role === 'user' ? 'chat-msg-user' : 'chat-msg-assistant'}`}>
                      {msg.role === 'user'
                        ? <p style={{ margin:0, fontSize:12, lineHeight:'1.5' }}>{msg.content}</p>
                        : <FormattedResponse content={msg.content} />
                      }
                    </div>
                  )}
                  {msg.kind === 'action' && (
                    <div className="w-full max-w-[96%]">
                      <ActionCard
                        actionType={msg.actionType}
                        params={msg.params}
                        orders={orders}
                        onDone={handleActionDone}
                      />
                    </div>
                  )}
                </div>
              ))}

              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5 text-[12px] text-gray-400 flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Thinking…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Quick actions */}
            {showQuickActions && (
              <div className="flex-shrink-0 flex flex-wrap gap-1.5 px-3 py-2 border-t border-gray-100">
                {QUICK_ACTIONS.map((a, i) => (
                  <button
                    key={i}
                    onClick={() => handleSend(a.query)}
                    disabled={isLoading}
                    className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 bg-gray-50 hover:bg-orange-50 hover:border-orange-200 text-gray-600 hover:text-gray-900 transition-colors whitespace-nowrap disabled:opacity-40"
                    data-testid={`button-quick-action-${i}`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2.5 border-t border-gray-100 bg-gray-50">
              <input
                ref={inputRef}
                data-testid="input-chat-message"
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder="Ask about orders, stock, lines…"
                disabled={isLoading}
                className="flex-1 text-[12px] px-3 py-2 rounded-full border border-gray-200 bg-white outline-none focus:border-[#fd5108] placeholder-gray-400"
              />
              <button
                data-testid="button-send-message"
                onClick={() => handleSend()}
                disabled={!input.trim() || isLoading}
                className="w-8 h-8 rounded-full bg-[#fd5108] text-white flex items-center justify-center hover:bg-[#e8490b] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
