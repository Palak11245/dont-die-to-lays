// Loadout screen. Runs once before the match, resolves with the seven-field weapon plus a
// local-only thumb canvas. The thumb never leaves this laptop.
import { AXES, dominantColour, toHex, toCss, weaponFrom } from './weapon.js';
import { api } from './net-config.js';

// Property scoring is a Claude vision call through our own server, which holds the API key.
// The browser sends a frame and gets the five axes back. Everything downstream — formulas,
// clamps, naming — is untouched in weapon.js.
//
// Same-origin path, proxied to server/vision.js on 8092 by vite.config.js. Start it with
// `npm run vision`; without it every scan is a connection refused.
const SCAN_URL = api('/scan');
// A free-tier host (Render, Fly) sleeps when idle and takes 30-60s to wake, so the FIRST
// scan after a quiet spell is slow. 20s was shorter than a cold start, which meant the very
// first scan always fell back to local analysis. 75s covers the wake plus the vision call.
const SCAN_TIMEOUT_MS = 75_000;

const $ = (id) => document.getElementById(id);

// Radial alpha falloff so the scan reads as a held object, not a photo pasted in the corner.
// This is what handles the background — there is no segmentation.
function feather(src) {
  const c = document.createElement('canvas');
  c.width = c.height = 224;
  const x = c.getContext('2d');
  x.drawImage(src, 0, 0);
  const g = x.createRadialGradient(112, 112, 58, 112, 112, 112);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.globalCompositeOperation = 'destination-in';
  x.fillStyle = g;
  x.fillRect(0, 0, 224, 224);
  return c;
}

// Fallback property estimator: measures the five axes off the captured frame itself when the
// vision server is unreachable. Real measurements of the real object — edge density, contrast,
// luminance, saturation, silhouette aspect — just computed here instead of by Claude. Values
// differ per object, so the demo never stalls on a dead endpoint.
function localProps(ctx) {
  const W = 224, H = 224;
  const d = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  let sumL = 0, sumS = 0, maxL = 0;

  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    lum[p] = l;
    sumL += l;
    sumS += mx > 0 ? (mx - mn) / mx : 0;
    if (l > maxL) maxL = l;
  }
  const meanL = sumL / (W * H), meanS = sumS / (W * H);

  // Gradient magnitude: crisp, busy edges read as hard and sharp; soft blobs do not.
  let edge = 0, edge2 = 0, minX = W, maxX = 0, minY = H, maxY = 0, hits = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      const g = Math.hypot(lum[p + 1] - lum[p - 1], lum[p + W] - lum[p - W]);
      edge += g;
      edge2 += g * g;
      if (g > 0.12) { // structural edge — part of the object, not the blurred background
        hits++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cells = (W - 2) * (H - 2);
  const meanE = edge / cells;
  const sdE = Math.sqrt(Math.max(0, edge2 / cells - meanE * meanE));

  // Silhouette aspect ratio -> elongation. Falls back to square if nothing was detected.
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const aspect = hits > 50 ? Math.max(bw, bh) / Math.min(bw, bh) : 1;

  const c = (v) => Math.max(0, Math.min(1, v));
  return {
    hardness: c(meanE * 9),                       // crisp edges everywhere
    mass: c((1 - meanL) * 0.65 + (1 - meanS) * 0.35), // dark and desaturated reads heavy
    sharpness: c(sdE * 11),                       // high edge contrast, spiky detail
    elongation: c((aspect - 1) / 1.6),             // long and thin vs. square
    energy: c(meanS * 0.55 + maxL * 0.45),         // bright, saturated, screen-like
  };
}

// Three colours off the scanned object, for the gun to be built from: its dominant body
// colour, a darker version for the metal parts, and its brightest pixel as the accent.
// Local-only, like the thumb — none of this goes over the wire.
const hsv2hex = (h, s, v) => {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return (f(5) << 16) | (f(3) << 8) | f(1);
};

function palette(ctx, bodyRgb) {
  // Averaging a photo gives mud, so instead histogram the HUE of every reasonably colourful
  // pixel, weighted by saturation x brightness, and take the peak. That returns "the red of
  // the crisp packet" rather than the brown-grey average of packet plus background.
  const d = ctx.getImageData(56, 56, 112, 112).data;
  const bins = new Float64Array(36), binS = new Float64Array(36), binV = new Float64Array(36);
  let total = 0;

  for (let i = 0; i < d.length; i += 8) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    const v = mx, s = mx > 0 ? c / mx : 0;
    if (s < 0.15 || v < 0.12) continue; // skip greys, whites and near-black
    let h = c === 0 ? 0
      : mx === r ? ((g - b) / c + 6) % 6
      : mx === g ? (b - r) / c + 2
      : (r - g) / c + 4;
    h *= 60;
    const bin = Math.floor(h / 10) % 36;
    const w = s * v;
    bins[bin] += w; binS[bin] += s * w; binV[bin] += v * w;
    total += w;
  }

  if (total < 1) {
    // A genuinely colourless object: build a neutral metal palette off its brightness.
    const l = (bodyRgb.r + bodyRgb.g + bodyRgb.b) / 3 / 255;
    const g = (m) => hsv2hex(210, 0.06, Math.max(0.12, Math.min(0.9, l * m)));
    return { body: g(1.15), metal: g(0.5), accent: g(1.6) };
  }

  let peak = 0;
  for (let i = 1; i < 36; i++) if (bins[i] > bins[peak]) peak = i;
  const hue = peak * 10 + 5;
  const sat = Math.min(1, (binS[peak] / bins[peak]) * 1.25);
  const val = Math.max(0.5, Math.min(0.95, (binV[peak] / bins[peak]) * 1.15));

  return {
    body: hsv2hex(hue, sat, val),                          // the object's actual colour, vivid
    metal: hsv2hex(hue, sat * 0.75, val * 0.34),           // same hue, dark, for barrel and grip
    accent: hsv2hex((hue + 26) % 360, Math.min(1, sat * 1.2), 1), // bright highlight
  };
}

export function loadoutScreen(defaultWeapon) {
  return new Promise((resolve) => {
    const cam = $('cam'), shot = $('shot'), status = $('scanStatus');
    const scanBtn = $('scanBtn'), enterBtn = $('enterBtn'), card = $('weaponCard');
    let picked = null, thumb = null, pal = null;

    const done = () => {
      $('loadout').style.display = 'none';
      if (cam.srcObject) for (const t of cam.srcObject.getTracks()) t.stop();
      if (picked) {
        console.log('[loadout] entering with SCANNED weapon:', picked.name, picked);
      } else {
        console.warn('[loadout] entering with the HARDCODED DEFAULT_WEAPON — no scan was run:',
          defaultWeapon);
      }
      resolve({ weapon: picked || defaultWeapon, thumb, palette: pal });
    };
    enterBtn.addEventListener('click', done);

    const fail = (msg) => {
      console.error('[scan]', msg);
      status.textContent = msg;
      status.style.color = '#ff5c5c';
      scanBtn.disabled = false;
      scanBtn.textContent = 'try again';
    };
    const ok = (msg) => {
      status.textContent = msg;
      status.style.color = '';
    };

    // Nothing loads in the browser — no model, no wasm, no weights — so the button is live
    // straight away. Scoring is one POST to our server at scan time and nothing before it.
    console.log('[scan] property scoring via', SCAN_URL, '— no model loads in the browser');
    scanBtn.disabled = false;
    ok('hold an object up and scan it');

    // Probe on open so a dead server says so immediately, instead of after someone presses
    // scan and waits out the timeout. Does not gate the button — the file picker and a
    // late-started server both still work.
    //
    // GET, not OPTIONS: Vite answers OPTIONS itself with a 204 even when the proxy target is
    // down, so an OPTIONS probe reports "reachable" for a server that isn't there. A GET is
    // forwarded — vision.js answers 404 (it only accepts POST), and Vite returns 502 if it
    // cannot connect. So 404 means alive; 502/503/504 means the server is not running.
    //
    // Retries, so starting `npm run servers` after the page is already open clears the error
    // by itself instead of needing a reload.
    let probeTimer = null;
    const probe = () => fetch(SCAN_URL, { method: 'GET', signal: AbortSignal.timeout(3000) })
      .then((r) => {
        if (r.status >= 502 && r.status <= 504) throw new Error(`proxy ${r.status}`);
        console.log(`[scan] vision endpoint reachable (GET ${r.status})`);
        clearInterval(probeTimer);
        if (!picked) ok('hold an object up and scan it');
        scanBtn.textContent = 'scan';
      })
      // Not an error any more: scanning still works, measured locally off the frame.
      .catch(() => {
        console.warn('[scan] vision server unreachable — scans will use local pixel analysis');
        ok('scan server offline — scanning locally, still works');
      });
    probe();
    probeTimer = setInterval(probe, 3000);
    enterBtn.addEventListener('click', () => clearInterval(probeTimer));

    // navigator.mediaDevices is UNDEFINED on an insecure origin that is not localhost — which
    // is exactly what P2 gets on http://<lan-ip>:5173. Reading .getUserMedia off it threw a
    // TypeError inside this executor, so the promise never resolved and P2 sat on a dead
    // loadout screen forever, unable to scan or enter the game. Feature-detect, never assume.
    const media = navigator.mediaDevices;
    if (!media || !media.getUserMedia) {
      cam.style.display = 'none';
      console.warn('[scan] no camera API — insecure origin (needs https or localhost). ' +
        'File picker still works, and you can enter without scanning.');
      ok('camera needs https — pick an image file, or skip');
    } else {
      // Requested in the background: awaiting it here left the button dead when the
      // permission prompt went unanswered.
      media.getUserMedia({ video: { width: 640, height: 480 } })
        .then((s) => (cam.srcObject = s))
        .catch(() => {
          cam.style.display = 'none';
          ok('no camera — use the file picker');
        });
    }

    // Any failure at all must surface. Previously only the fetch was guarded, so an error
    // after it left the screen stuck on "scanning..." with nothing in the UI to explain why.
    async function scan(source) {
      try {
        await runScan(source);
      } catch (e) {
        console.error('[scan] failed after the request:', e);
        fail(`scan failed — ${e.message}`);
        cam.style.display = cam.srcObject ? 'block' : 'none';
        shot.style.display = 'none';
      }
    }

    async function runScan(source) {
      scanBtn.disabled = true;
      ok('scanning…');
      // A cold server can take most of a minute; say so rather than looking frozen.
      const slow = setTimeout(() => ok('waking the scan server… (first scan only)'), 4000);
      const slower = setTimeout(() => ok('still waking — free hosting cold start, hold on'), 20000);
      const ctx = shot.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, 224, 224);
      shot.style.display = 'block';
      cam.style.display = 'none';

      const tScan = performance.now();
      let p;
      let source_ = 'Claude vision';
      try {
        // A dead endpoint must fail loudly and quickly, not hang the loadout screen forever.
        const r = await fetch(SCAN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: shot.toDataURL('image/jpeg') }),
          signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`);
        p = await r.json();
      } catch (e) {
        clearTimeout(slow);
        clearTimeout(slower);
        // The demo must never stall on a dead endpoint: measure the frame here instead.
        source_ = 'local pixel analysis (vision server unreachable)';
        console.warn(`[scan] vision server failed (${e.message}) — falling back to local ` +
          'pixel analysis of the captured frame');
        p = localProps(ctx);
      }
      clearTimeout(slow);
      clearTimeout(slower);
      const ms = performance.now() - tScan;

      // --- 1. the five property values
      console.log(`[scan] properties from ${source_} in ${ms.toFixed(0)}ms`);
      console.log('[scan] properties:', AXES.map((a) => `${a.key}=${p[a.key].toFixed(3)}`).join('  '));
      const missing = AXES.filter((a) => typeof p[a.key] !== 'number');
      if (missing.length) {
        console.error('[scan] BAD RESPONSE: missing axes', missing.map((a) => a.key));
      }
      if (AXES.every((a) => Math.abs(p[a.key] - 0.5) < 1e-9)) {
        console.error('[scan] SUSPICIOUS: every axis is exactly 0.500 — that is a no-signal ' +
          'default, not a measurement. The clamps are carrying the whole weapon.');
      }

      const rgb = dominantColour(ctx);
      // Split the name off FIRST. weaponFrom -> nameFor picks the dominant axis with
      // Object.keys(p).reduce, so a stray string key wins that comparison and the whole
      // derivation collapses. The formulas only ever see the five numbers.
      const { name: visionName, ...props } = p;
      picked = weaponFrom(props, toHex(rgb));
      // Claude names it from what the object actually is; the derived adjective+noun name
      // stays as the fallback when scoring came from local pixel analysis.
      if (visionName) picked.name = visionName;
      thumb = feather(shot);
      pal = palette(ctx, rgb);

      // --- 3. the seven fields that go over the wire
      console.log('[scan] weapon (seven fields):', picked);
      console.log('[scan] palette', Object.fromEntries(
        Object.entries(pal).map(([k, v]) => [k, '#' + v.toString(16).padStart(6, '0')])),
        '| thumb', thumb.width + 'x' + thumb.height, '(local only, never sent)');

      card.innerHTML =
        `<h3><i style="background:${toCss(rgb)}"></i>${picked.name}</h3>` +
        ['damage', 'fireRate', 'spread', 'knockback', 'pellets']
          .map((k) => `<div><span>${k}</span><b>${picked[k]}</b></div>`).join('');
      card.style.display = 'block';
      enterBtn.textContent = 'enter arena';
      ok('scan again to compare, or enter the arena');
      scanBtn.disabled = false;
      scanBtn.textContent = 'scan again';
    }

    scanBtn.addEventListener('click', () => {
      if (cam.style.display === 'none' && cam.srcObject) {
        cam.style.display = 'block';
        shot.style.display = 'none';
        return;
      }
      if (cam.srcObject) scan(cam);
      else fail('pick an image file first');
    });

    $('fileInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => scan(img);
      img.src = URL.createObjectURL(f);
    });
  });
}
