// Gesynthetiseerde sound effects (WebAudio) — geen externe audiobestanden
// nodig (strikte CSP) en het retro-synth-geluid past bij de lowpoly-stijl.

let ctx = null;
let master = null;

export function ensureAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function env(gainNode, t0, attack, peak, decay) {
  gainNode.gain.setValueAtTime(0, t0);
  gainNode.gain.linearRampToValueAtTime(peak, t0 + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function noiseBuffer() {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
let _noise = null;

function playNoise(t0, dur, filterType, f0, f1, peak) {
  _noise ??= noiseBuffer();
  const src = ctx.createBufferSource();
  src.buffer = _noise;
  const filt = ctx.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.setValueAtTime(f0, t0);
  filt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
  filt.Q.value = 1.1;
  const g = ctx.createGain();
  env(g, t0, 0.005, peak, dur);
  src.connect(filt).connect(g).connect(master);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

function playTone(t0, dur, type, f0, f1, peak) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
  const g = ctx.createGain();
  env(g, t0, 0.004, peak, dur);
  osc.connect(g).connect(master);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
}

export const sfx = {
  whoosh() { // aanzet van een slag/trap
    if (!ctx) return;
    const t = ctx.currentTime;
    playNoise(t, 0.13, 'bandpass', 500, 1600, 0.18);
  },
  hit(heavy = false) {
    if (!ctx) return;
    const t = ctx.currentTime;
    playNoise(t, heavy ? 0.16 : 0.09, 'highpass', 900, 300, heavy ? 0.5 : 0.35);
    playTone(t, heavy ? 0.22 : 0.12, 'sine', heavy ? 150 : 190, 55, heavy ? 0.7 : 0.45);
  },
  block() {
    if (!ctx) return;
    const t = ctx.currentTime;
    playTone(t, 0.07, 'square', 240, 180, 0.22);
    playNoise(t, 0.05, 'highpass', 2000, 1500, 0.1);
  },
  thud() { // knock-down
    if (!ctx) return;
    const t = ctx.currentTime;
    playTone(t, 0.3, 'sine', 95, 36, 0.8);
    playNoise(t + 0.01, 0.18, 'lowpass', 300, 90, 0.3);
  },
  dodge() {
    if (!ctx) return;
    playNoise(ctx.currentTime, 0.16, 'bandpass', 300, 900, 0.12);
  },
  click() {
    if (!ctx) return;
    playTone(ctx.currentTime, 0.05, 'sine', 750, 620, 0.2);
  },
  jingle(win = true) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = win ? [392, 494, 587, 784] : [330, 262, 208];
    notes.forEach((f, i) => {
      playTone(t + i * 0.13, 0.32, 'triangle', f, f, 0.3);
    });
  },

  // race-motor: doorlopende toon, toonhoogte volgt de snelheid
  _engine: null,
  engineStart() {
    if (!ctx) return;
    if (this._engine) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 420;
    const g = ctx.createGain(); g.gain.value = 0.0;
    osc.connect(filt).connect(g).connect(master);
    osc.start();
    this._engine = { osc, g };
  },
  engineUpdate(speed) { // m/s
    if (!ctx || !this._engine) return;
    this._engine.osc.frequency.value = 55 + Math.abs(speed) * 4.5;
    this._engine.g.gain.value = 0.05 + Math.min(0.06, Math.abs(speed) * 0.002);
  },
  engineStop() {
    if (this._engine) {
      try { this._engine.osc.stop(); } catch { /* al gestopt */ }
      this._engine = null;
    }
  },
};
