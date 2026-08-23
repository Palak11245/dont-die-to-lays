// Procedural Web Audio. No sample files — every sound is a filtered noise burst plus a
// sine "body", with the envelope driven by the weapon's own stats.
//
// The AudioContext starts suspended until a user gesture, so unlock() is called from the
// pointer-lock click. Every play() is a no-op until then rather than an error.

let ctx = null;
let noiseBuf = null;

export function unlock() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function audio() {
  if (!ctx || ctx.state !== 'running') return null;
  return ctx;
}

function noise(c) {
  if (noiseBuf) return noiseBuf;
  const n = Math.floor(c.sampleRate * 0.5);
  noiseBuf = c.createBuffer(1, n, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// One profile per gun archetype: big bores are low and long, small ones tight and bright.
const PROFILE = {
  cannon:  { cut: 900,  q: 0.7, decay: 0.55, body: 46,  bodyGain: 0.85 },
  shotgun: { cut: 1700, q: 0.8, decay: 0.38, body: 68,  bodyGain: 0.65 },
  rifle:   { cut: 3200, q: 2.2, decay: 0.20, body: 120, bodyGain: 0.35 },
  pistol:  { cut: 2600, q: 1.4, decay: 0.16, body: 105, bodyGain: 0.40 },
  smg:     { cut: 4400, q: 1.6, decay: 0.09, body: 170, bodyGain: 0.22 },
};

/**
 * @param type  gun archetype from buildGun()
 * @param w     weapon config — damage lengthens and lowers it, fireRate shortens it,
 *              spread opens the filter so a wide spray hisses rather than cracks
 * @param vol   0..1, lower for a shot fired by the other player
 */
export function fire(type, w, vol = 1) {
  const c = audio();
  if (!c) return;
  const p = PROFILE[type] || PROFILE.pistol;
  const t = c.currentTime;

  const heavy = w.damage / 35;                       // 0..1
  const decay = p.decay * (0.65 + heavy * 0.7) * (1 - Math.min(0.45, w.fireRate / 26));
  const cut = p.cut * (1.25 - heavy * 0.45) * (1 + w.spread / 90);

  // 1. CRACK — a 6ms burst of hard-clipped bright noise. This transient is what makes the ear
  //    hear "gunshot" rather than "whoosh"; without it the rest is just a filtered hiss.
  const crk = c.createBufferSource();
  crk.buffer = noise(c);
  crk.playbackRate.value = 1.6 + Math.random() * 0.5;
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const shaper = c.createWaveShaper();
  const curve = new Float32Array(257);
  for (let i = 0; i < 257; i++) {
    const v = (i / 128) - 1;
    curve[i] = Math.tanh(v * 5); // saturate: adds the harmonics a clean sine cannot
  }
  shaper.curve = curve;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.9 * vol, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  crk.connect(hp).connect(shaper).connect(cg).connect(c.destination);
  crk.start(t);
  crk.stop(t + 0.06);

  // 2. BLAST — the filtered body of the report, sweeping down into the tail.
  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.playbackRate.value = 0.8 + Math.random() * 0.4; // never twice the same

  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.Q.value = p.q;
  filt.frequency.setValueAtTime(cut * 2.2, t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(110, cut * 0.14), t + decay);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.7 * vol, t + 0.002); // near-instant attack
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + decay + 0.02);

  // Low sine thump under the crack — this is what makes a cannon feel heavy.
  const osc = c.createOscillator();
  const og = c.createGain();
  osc.frequency.setValueAtTime(p.body * (1.15 - heavy * 0.3), t);
  osc.frequency.exponentialRampToValueAtTime(p.body * 0.5, t + decay * 0.8);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(p.bodyGain * vol, t + 0.006);
  og.gain.exponentialRampToValueAtTime(0.0001, t + decay * 0.9);
  osc.connect(og).connect(c.destination);
  osc.start(t);
  osc.stop(t + decay);
}

// Two mechanical clacks: magazine out, magazine in. Spaced across the reload duration.
export function reload(seconds) {
  const c = audio();
  if (!c) return;
  for (const [at, pitch, gain] of [[0.02, 1.5, 0.22], [seconds * 0.72, 1.0, 0.30]]) {
    const t = c.currentTime + at;
    const src = c.createBufferSource();
    src.buffer = noise(c);
    src.playbackRate.value = pitch;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1500 * pitch;
    f.Q.value = 3;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
    src.stop(t + 0.09);
  }
}

// Dry click on an empty magazine.
export function dryFire() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.playbackRate.value = 2.2;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 3200;
  f.Q.value = 6;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + 0.05);
}

// Short damped thud. `hard` is used for landing a jump.
export function step(hard = false) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const decay = hard ? 0.13 : 0.07;

  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.playbackRate.value = 0.55 + Math.random() * 0.3;

  const filt = c.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = (hard ? 900 : 620) + Math.random() * 180;
  filt.Q.value = 0.9;

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(hard ? 0.30 : 0.13, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + decay + 0.02);
}
