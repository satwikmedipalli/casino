import { useState } from 'react';
import { CardView } from './Card';
import type { Poker } from './net';

const NAME_KEY = 'poker.name';
const readName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };
const toCents = (s: string) => Math.round(parseFloat(s) * 100);

function Hero() {
  return (
    <div className="hero">
      <div className="hero-cards">
        <CardView card="Qh" width={78} className="fan f1" />
        <CardView card="As" width={78} className="fan f2" />
        <CardView card="Kd" width={78} className="fan f3" />
      </div>
      <div className="sign">
        <h1 aria-label="Casino">
          {'CASINO'.split('').map((ch, i) => <span key={i} className={i === 3 ? 'flick' : undefined}>{ch}</span>)}
        </h1>
      </div>
      <p className="tagline">Poker · Blackjack · your crew</p>
    </div>
  );
}

export function Lobby({ poker }: { poker: Poker }) {
  const [name, setName] = useState(readName);
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '');
  const [chips, setChips] = useState('10');
  const [bb, setBb] = useState('0.20');
  const [bots, setBots] = useState(4);
  const [showSettings, setShowSettings] = useState(false);

  if (poker.hasSession && !poker.state) {
    return (
      <div className="lobby">
        <Hero />
        <p className="muted center">{poker.connected ? 'Rejoining your table…' : 'Connecting…'}</p>
        <button className="link" onClick={() => { localStorage.removeItem('poker.session'); location.reload(); }}>
          Start over
        </button>
      </div>
    );
  }

  const nameOk = name.trim().length > 0;
  const go = (botCount?: number) => {
    if (!nameOk) return;
    saveName(name.trim());
    poker.create(name.trim(), toCents(chips) || 1000, toCents(bb) || 20, botCount);
  };
  const join = () => {
    if (!nameOk || code.trim().length !== 4) return;
    saveName(name.trim());
    poker.join(code, name.trim());
  };

  return (
    <div className="lobby">
      <Hero />

      <label className="field">
        <span>Your name</span>
        <input value={name} maxLength={14} placeholder="What should the table call you?" onChange={e => setName(e.target.value)} />
      </label>

      <section className="panel">
        <div className="panel-title">Join friends</div>
        <div className="row">
          <input className="code-input" value={code} maxLength={4} placeholder="CODE" aria-label="Table code"
            autoCapitalize="characters" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
          <button className="btn gold" disabled={!nameOk || code.length !== 4} onClick={join}>Join</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">Host a table</div>
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
        <button className="btn green" disabled={!nameOk} onClick={() => go()}>Create table</button>
        {!showSettings && (
          <button className="link" onClick={() => setShowSettings(true)}>
            Starting chips {chips} · blinds {(toCents(bb) / 200).toFixed(2)}/{bb}
          </button>
        )}
      </section>

      <section className="panel practice">
        <div className="panel-title">Practice against bots</div>
        <p className="muted">Try every game on your own. You pick the game each hand.</p>
        <div className="bot-count">
          {[1, 2, 3, 4, 5, 6, 7].map(n => (
            <button key={n} className={`chip-btn ${bots === n ? 'on' : ''}`} onClick={() => setBots(n)}>{n}</button>
          ))}
          <span className="muted">bots</span>
        </div>
        <button className="btn outline" disabled={!nameOk} onClick={() => go(bots)}>Play now</button>
      </section>

      {poker.error && <div className="toast" onClick={poker.clearError}>{poker.error}</div>}
    </div>
  );
}
