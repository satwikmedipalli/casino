import { useEffect, useRef, useState } from 'react';
import { CHAT_MAX, EMOTES, QUICK_CHAT } from '../shared/types';
import type { ChatMsg, ClientMsg, TableView } from '../shared/types';
import { sfx } from './sound';

const BUBBLE_MS = 4000;
const EMOTE_MS = 2600;
const emoteOf = (id?: string) => EMOTES.find(e => e.id === id);

/**
 * Tracks which chat lines are new: the latest one per player is "fresh" for a few seconds
 * (shown over their seat), and lines from others since the panel was last open are unread.
 */
export function useChat(chat: ChatMsg[], you: string, open: boolean) {
  const lastId = chat.at(-1)?.id ?? 0;
  const seen = useRef(lastId); // anything already there when we sat down isn't replayed
  const [readId, setReadId] = useState(lastId);
  const [fresh, setFresh] = useState<Record<string, ChatMsg>>({});

  useEffect(() => {
    const added = chat.filter(m => m.id > seen.current);
    if (!added.length) return;
    seen.current = lastId;
    setFresh(f => {
      const next = { ...f };
      for (const m of added) next[m.from] = m;
      return next;
    });
    for (const m of added) {
      if (m.emote) sfx.emote();
      else if (m.from !== you) sfx.message();
      window.setTimeout(() => setFresh(f => (f[m.from]?.id === m.id ? (({ [m.from]: _, ...rest }) => rest)(f) : f)),
        m.emote ? EMOTE_MS : BUBBLE_MS);
    }
  }, [lastId]);

  useEffect(() => { if (open) setReadId(lastId); }, [open, lastId]);
  const unread = open ? 0 : chat.filter(m => m.id > readId && m.from !== you).length;
  return { fresh, unread };
}

/** A speech bubble or an animated emote above a player's seat. */
const RAIN_DELAYS = [0, 0.35, 0.15, 0.5, 0.05, 0.4, 0.2, 0.55, 0.1];

export function SeatBubble({ m, below }: { m: ChatMsg; below?: boolean }) {
  const e = emoteOf(m.emote);
  if (!e) return <div key={m.id} className={`bubble ${below ? 'below' : ''}`}>{m.text}</div>;
  return (
    <div key={m.id} className={`emote-fx ${e.anim}`}>
      <span className="emote-main">{e.e}</span>
      {e.anim === 'rain' && Array.from({ length: 9 }, (_, i) => (
        <span key={i} className="drop" style={{ left: `${(i - 4) * 16}px`, animationDelay: `${RAIN_DELAYS[i]}s` }}>{e.e}</span>
      ))}
    </div>
  );
}

export function ChatButton({ unread, onClick }: { unread: number; onClick: () => void }) {
  return (
    <button className="pill chat-btn" aria-label="Chat" onClick={onClick}>
      💬{unread > 0 && <i className="unread">{unread > 9 ? '9+' : unread}</i>}
    </button>
  );
}

export function ChatPanel({ s, send, wide, onClose }: {
  s: TableView; send: (m: ClientMsg) => void; wide: boolean; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const lastId = s.chat.at(-1)?.id ?? 0;
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [lastId]);

  const say = (t: string) => { if (t.trim()) send({ t: 'chat', text: t }); };
  const emote = (id: string) => {
    send({ t: 'chat', emote: id });
    if (!wide) onClose(); // on a phone the sheet hides the table, so close it to watch the emote land
  };

  return (
    <div className={`chat-panel ${wide ? 'side' : 'sheet'}`}>
      <div className="chat-head">
        <div className="sheet-title">Table talk</div>
        <button className="pill" onClick={onClose} aria-label="Close chat">✕</button>
      </div>
      <div className="chat-list" ref={listRef}>
        {s.chat.length === 0 && <p className="muted center">No messages yet. Say something, or throw an emote.</p>}
        {s.chat.map(m => {
          const e = emoteOf(m.emote);
          const mine = m.from === s.you;
          return (
            <div key={m.id} className={`chat-line ${mine ? 'mine' : ''}`}>
              {!mine && <b>{m.name}</b>}
              {e ? <span className="chat-emote">{e.e} <small>{e.label}</small></span> : <span>{m.text}</span>}
            </div>
          );
        })}
      </div>
      <div className="emote-grid">
        {EMOTES.map(e => (
          <button key={e.id} className="emote-btn" onClick={() => emote(e.id)} title={e.label}>
            <span>{e.e}</span><small>{e.label}</small>
          </button>
        ))}
      </div>
      <div className="quick-chat">
        {QUICK_CHAT.map(q => <button key={q} className="chip-btn" onClick={() => say(q)}>{q}</button>)}
      </div>
      <form className="chat-input" onSubmit={e => { e.preventDefault(); say(text); setText(''); }}>
        <input value={text} maxLength={CHAT_MAX} placeholder="Say something…" enterKeyHint="send"
          onChange={e => setText(e.target.value)} />
        <button className="btn gold" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}
