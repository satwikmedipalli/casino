import { useState } from 'react';
import type { Poker } from './net';

const NAME_KEY = 'poker.name';
const readName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };
const toCents = (s: string) => Math.round(parseFloat(s) * 100);

export function Lobby({ poker }: { poker: Poker }) {
  const [name, setName] = useState(readName);
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '');
  const [chips, setChips] = useState('10');
  const [bb, setBb] = useState('0.20');
  const [showSettings, setShowSettings] = useState(false);

  if (poker.hasSession && !poker.state) {
    return (
      <div className="lobby">
        <div className="logo">♠</div>
        <p className="muted">{poker.connected ? 'Rejoining your table…' : 'Connecting…'}</p>
        <button className="link" onClick={() => { localStorage.removeItem('poker.session'); location.reload(); }}>
          Start over
        </button>
      </div>
    );
  }

  const nameOk = name.trim().length > 0;
  const create = () => {
    if (!nameOk) return;
    saveName(name.trim());
    poker.create(name.trim(), toCents(chips) || 1000, toCents(bb) || 20);
  };
  const join = () => {
    if (!nameOk || code.trim().length !== 4) return;
    saveName(name.trim());
    poker.join(code, name.trim());
  };

  return (
    <div className="lobby">
      <div className="logo">♠</div>
      <h1>Poker Night</h1>

      <label className="field">
        <span>Your name</span>
        <input value={name} maxLength={14} placeholder="Name" onChange={e => setName(e.target.value)} />
      </label>

      <div className="card-box">
        <label className="field">
          <span>Table code</span>
          <input className="code-input" value={code} maxLength={4} placeholder="ABCD"
            autoCapitalize="characters" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
        </label>
        <button className="btn primary" disabled={!nameOk || code.length !== 4} onClick={join}>Join table</button>
      </div>

      <div className="or">or</div>

      <div className="card-box">
        {showSettings && (
          <div className="row">
            <label className="field">
              <span>Starting chips</span>
              <input inputMode="decimal" value={chips} onChange={e => setChips(e.target.value)} />
            </label>
            <label className="field">
              <span>Big blind</span>
              <input inputMode="decimal" value={bb} onChange={e => setBb(e.target.value)} />
            </label>
          </div>
        )}
        <button className="btn call" disabled={!nameOk} onClick={create}>Create a new table</button>
        {!showSettings && (
          <button className="link" onClick={() => setShowSettings(true)}>
            Starting chips {chips} · blinds {(toCents(bb) / 200).toFixed(2)}/{bb}
          </button>
        )}
      </div>

      {poker.error && <div className="toast" onClick={poker.clearError}>{poker.error}</div>}
    </div>
  );
}
