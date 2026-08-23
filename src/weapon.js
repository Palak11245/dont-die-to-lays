// The five property axes and the stat formulas are hand-tuned. Do not rewrite them.
// This module is the single source of truth: scanner-spike.html and the in-game loadout
// screen both derive from here, so the spike can never drift from what the game plays.

export const AXES = [
  { key: 'hardness',   hi: 'a photo of a hard rigid solid object',      lo: 'a photo of a soft squishy flexible object' },
  { key: 'mass',       hi: 'a photo of a heavy dense metal object',     lo: 'a photo of a light flimsy hollow object' },
  { key: 'sharpness',  hi: 'a photo of a sharp pointed spiky object',   lo: 'a photo of a blunt rounded smooth object' },
  { key: 'elongation', hi: 'a photo of a long thin narrow object',      lo: 'a photo of a wide flat broad object' },
  { key: 'energy',     hi: 'a photo of an electronic powered device',   lo: 'a photo of an inert unpowered object' },
];

export const LABELS = AXES.flatMap((a) => [a.hi, a.lo]);

export function propsFromScores(score) {
  const p = {};
  for (const a of AXES) {
    const hi = score[a.hi] ?? 0, lo = score[a.lo] ?? 0;
    p[a.key] = hi + lo > 0 ? hi / (hi + lo) : 0.5;
  }
  return p;
}

// Dominant colour of the scan frame — same sampling and saturation boost as the spike.
export function dominantColour(ctx) {
  const d = ctx.getImageData(56, 56, 112, 112).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  r /= n; g /= n; b /= n;
  const mean = (r + g + b) / 3, k = 1.7;
  const cl = (v) => Math.max(0, Math.min(255, Math.round(mean + (v - mean) * k)));
  return { r: cl(r), g: cl(g), b: cl(b) };
}

export const toHex = ({ r, g, b }) => (r << 16) | (g << 8) | b;
export const toCss = ({ r, g, b }) => `rgb(${r},${g},${b})`;

// Naming only — the axes, the archetype thresholds and every stat formula below are unchanged.
// The adjective still comes from the dominant axis and the noun still from the archetype; each
// is now a set rather than a single word, indexed by a hash of the property vector. That is
// deterministic: rescanning the same object always yields the same name, and both laptops
// derive the same name from the same numbers.
const ADJECTIVES = {
  hardness:   ['Tempered', 'Adamant', 'Petrified', 'Ironbound', 'Obsidian', 'Calcified'],
  mass:       ['Leaden', 'Ponderous', 'Gravebound', 'Anvilborn', 'Dreadweight', 'Sunken'],
  sharpness:  ['Serrated', 'Lacerating', 'Barbed', 'Flensing', 'Splintered', 'Razorwrought'],
  elongation: ['Slender', 'Spindled', 'Harrowing', 'Lanceform', 'Whipthin', 'Attenuate'],
  energy:     ['Live', 'Galvanic', 'Arcfed', 'Overclocked', 'Seething', 'Voltaic'],
};

// The old code named a flat reading "Sad Nothing", which fired on nearly every real scan
// because most objects sit mid-range on all five axes. A weak reading still deserves a
// weapon name — just a wretched one.
const FEEBLE = ['Whimpering', 'Hollow', 'Rusted', 'Forsaken', 'Mouldering', 'Wretched'];

const NOUNS = {
  Lance:      ['Lance', 'Impaler', 'Skewer', 'Perforator', 'Spitfang', 'Bodkin'],
  Scattergun: ['Scattergun', 'Maw', 'Bloomcannon', 'Shrapnelcaster', 'Widowmaker', 'Screamer'],
  Slugger:    ['Slugger', 'Sledge', 'Anvilgun', 'Concussor', 'Gravemaker', 'Bonebreaker'],
  Arc:        ['Arc', 'Coilspitter', 'Stormlash', 'Dynamo', 'Faultline', 'Thunderhead'],
  Popper:     ['Popper', 'Rattler', 'Chitterbox', 'Snapjaw', 'Peppergun', 'Hexvent'],
};

// Deterministic index from the property vector — same object, same name, every time.
function pick(list, p, salt) {
  let h = salt >>> 0;
  for (const a of AXES) h = (Math.imul(h, 397) + Math.round(p[a.key] * 1000)) >>> 0;
  return list[h % list.length];
}

export function nameFor(p) {
  // Only the five numeric axes take part — a caller passing extra keys (a name, a note)
  // must not be able to win the dominant-axis comparison and break the lookup.
  const keys = AXES.map((a) => a.key).filter((k) => typeof p[k] === 'number');
  if (!keys.length) return 'Unmarked Relic';
  const top = keys.reduce((a, b) => (p[a] > p[b] ? a : b));
  const archetype =
    p.sharpness > 0.6 && p.elongation > 0.6 ? 'Lance'
    : p.elongation < 0.4 && p.sharpness < 0.4 ? 'Scattergun'
    : p.mass > 0.65 ? 'Slugger'
    : p.energy > 0.6 ? 'Arc'
    : 'Popper';
  const feeble = Math.max(...keys.map((k) => p[k])) < 0.55;
  const adj = pick(feeble ? FEEBLE : ADJECTIVES[top], p, feeble ? 11 : 7);
  return `${adj} ${pick(NOUNS[archetype], p, 23)}`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The seven fields the socket carries. The clamps are load-bearing: a blank-wall scan reads
// ~0.5 on every axis, and without them that is either a useless gun or a one-shot.
export function weaponFrom(p, colour) {
  const spread = 45 * (1 - p.sharpness) * (1 - p.elongation);
  return {
    name: nameFor(p),
    damage: Math.round(clamp(20 * p.hardness + 15 * p.mass + 10 * p.sharpness, 4, 35)),
    fireRate: +clamp(2 + 9 * (1 - p.mass) + 3 * p.energy, 1, 12).toFixed(1),
    spread: Math.round(spread),
    knockback: Math.round(80 + 320 * p.mass),
    pellets: Math.round(1 + spread / 8),
    colour,
  };
}
