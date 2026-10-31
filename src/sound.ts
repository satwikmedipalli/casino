// Table sounds synthesized with Web Audio, so there are no sound files to ship.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

// iOS only allows audio after a user gesture.
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => audio(), { passive: true });

function burst(at: number, dur: number, freq: number, q: number, gain: number) {
  const a = audio();
  if (!a) return;
  const len = Math.max(1, Math.floor(a.sampleRate * dur));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(a.destination);
  src.start(a.currentTime + at);
}

function tone(at: number, freq: number, dur: number, gain: number) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  const t = a.currentTime + at;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  chip(count = 3) {
    for (let i = 0; i < count; i++) burst(i * 0.045 + Math.random() * 0.01, 0.035, 3200 + Math.random() * 900, 6, 0.9);
  },
  card(at = 0) { burst(at, 0.09, 1800, 0.8, 0.6); },
  deal(cards: number) { for (let i = 0; i < cards; i++) this.card(i * 0.08); },
  flip(count = 1) { for (let i = 0; i < count; i++) this.card(i * 0.14); },
  turn() { tone(0, 660, 0.18, 0.15); tone(0.12, 990, 0.25, 0.12); },
  win() { this.chip(10); },
  emote() { tone(0, 520, 0.12, 0.12); tone(0.08, 780, 0.16, 0.1); },
  message() { tone(0, 880, 0.1, 0.06); },
};
