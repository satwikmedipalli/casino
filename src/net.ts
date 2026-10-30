import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, ServerMsg, TableView } from '../shared/types';

const SESSION_KEY = 'poker.session';
export interface Session { code: string; token: string; name: string }

export function loadSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'); } catch { return null; }
}
function saveSession(s: Session | null) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}

export interface Poker {
  state: TableView | null;
  receivedAt: number;
  connected: boolean;
  hasSession: boolean;
  error: string | null;
  clearError: () => void;
  send: (msg: ClientMsg) => void;
  create: (name: string, startingChips: number, bb: number, bots?: number) => void;
  join: (code: string, name: string) => void;
}

export function usePoker(): Poker {
  const [state, setState] = useState<TableView | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(() => !!loadSession());
  const ws = useRef<WebSocket | null>(null);
  const queue = useRef<ClientMsg[]>([]);
  const session = useRef<Session | null>(loadSession());
  const pendingName = useRef('');

  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;

    const connect = () => {
      if (stopped) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        setConnected(true);
        const s = session.current;
        if (s) sock.send(JSON.stringify({ t: 'join', code: s.code, name: s.name, token: s.token }));
        for (const m of queue.current.splice(0)) sock.send(JSON.stringify(m));
      };
      sock.onmessage = e => {
        const msg: ServerMsg = JSON.parse(e.data);
        if (msg.t === 'joined') {
          session.current = { code: msg.code, token: msg.token, name: pendingName.current || session.current?.name || '' };
          saveSession(session.current);
          setHasSession(true);
        } else if (msg.t === 'state') {
          setState(msg.state);
          setReceivedAt(performance.now());
        } else if (msg.t === 'error') {
          setError(msg.message);
          if (msg.fatal) { session.current = null; saveSession(null); setHasSession(false); setState(null); }
        } else if (msg.t === 'left') {
          session.current = null; saveSession(null); setHasSession(false); setState(null);
        }
      };
      sock.onclose = () => {
        if (ws.current === sock) ws.current = null;
        setConnected(false);
        if (!stopped) retry = window.setTimeout(connect, 1000);
      };
    };

    // iOS drops sockets when the app is backgrounded; reconnect as soon as it's visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !ws.current) { clearTimeout(retry); connect(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMsg) => {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
    else queue.current.push(msg);
  }, []);

  return {
    state, receivedAt, connected, hasSession, error,
    clearError: () => setError(null),
    send,
    create: (name, startingChips, bb, bots) => { pendingName.current = name; send({ t: 'create', name, startingChips, bb, bots }); },
    join: (code, name) => { pendingName.current = name; send({ t: 'join', code: code.trim().toUpperCase(), name }); },
  };
}
