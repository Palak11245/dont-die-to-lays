import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { SHOWCASE } from './config.js';
import { loadoutScreen } from './scan.js';
import * as spectator from './spectator.js';
import * as sfx from './sfx.js';
import { api, relayUrl, ROOM, IS_JOINER, inviteLink } from './net-config.js';

// ARENA is the half-extent: 10 gives the 20x20 play area.
const EYE = 1.6, RADIUS = 0.3, SPEED = 40, DAMPING = 8, ARENA = 10;
const GRAVITY = 22, JUMP = 8; // apex ~1.4m — clears a low box, not a tall one, so boxes stack into steps
// SHOWCASE is single-player: no socket, no relay, no remote peer.
// Role is explicit: the plain link hosts, the invite link carries ?p2. No hostname guessing.
const ROLE = SHOWCASE ? 'solo' : IS_JOINER ? 'p2' : 'p1';
const LOCAL = ROLE === 'p2' ? 1 : 0;
const IS_P2 = ROLE === 'p2';
const RELAY_URL = relayUrl(ROOM);

console.log('[boot]', {
  SHOWCASE, // false here means the booth build: relay on, socket dialed below
  role: ROLE,
  room: ROOM,
  dialing: SHOWCASE ? 'nothing — showcase build has no socket' : RELAY_URL,
  // The broadcast panel disappears silently if either gate is closed, so say which.
  broadcastPanel: SHOWCASE ? 'OFF — showcase build, use `npm run dev:booth`'
    : IS_P2 ? 'OFF — this tab is P2; only P1 controls Reactor. Open localhost:5173 to be P1.'
    : 'ON — press B',
});

// One default gun until the scanner lands. Seven fields, exactly as the weapon config is specced.
const DEFAULT_WEAPON = {
  name: 'Blunt Slug', damage: 14, fireRate: 5, spread: 6,
  knockback: 180, pellets: 1, colour: 0xffd23f
};
const weapons = [DEFAULT_WEAPON, DEFAULT_WEAPON];

// Office palette, sampled off room.jpg. Nothing in the scene loads a texture.
const CARPET = 0x3c4048, WALL = 0x4a505c, CEILING = 0x2b2f37; // industrial, not office
// NAVY is lifted a little off the photo's true divider colour: darker than this and its lit and
// shadowed faces stop separating under Lambert, and the box reads as one flat silhouette.
const NAVY = 0x33498c, WOOD = 0xc08f57, PILLAR = 0xe8e6e0, TEAL = 0x2aa8b8;

const scene = new THREE.Scene();
scene.background = new THREE.Color(CARPET);
// No fog: the room is enclosed and 20m across, so fog only muddied the far walls.

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// Ambient fills the shadowed faces; one directional off to the side makes adjacent faces of the
// same box read at different brightnesses, which is what makes the geometry legible.
const ambient = new THREE.AmbientLight(0xc4cede, 0.7);
const sun = new THREE.DirectionalLight(0xfff3e2, 1.4);
sun.position.set(9, 16, 5);
// Lights respect layers: without this the camera-parented gun would render unlit black.
ambient.layers.enable(spectator.VIEWMODEL_LAYER);
sun.layers.enable(spectator.VIEWMODEL_LAYER);
scene.add(ambient, sun);

// --- the room. Plain surfaces; all the detail is real geometry bolted onto them.
const WALL_H = 5;
const surface = (w, h, color, x, y, z, rx, ry) => {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshLambertMaterial({ color })
  );
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, 0);
  scene.add(m);
  return m;
};

const S = ARENA * 2;
surface(S, S, CARPET, 0, 0, 0, -Math.PI / 2, 0);            // floor — always kept
// Walls and ceiling are collected so a frozen X2 frame can replace them on demand.
// Default is these flat surfaces; the skin only appears if you ask for it from the B panel.
const shell = [
  surface(S, S, CEILING, 0, WALL_H, 0, Math.PI / 2, 0),                            // ceiling
  surface(S, WALL_H, WALL, 0, WALL_H / 2, -ARENA, 0, 0),             // north
  surface(S, WALL_H, WALL, 0, WALL_H / 2, ARENA, 0, Math.PI),        // south
  surface(S, WALL_H, WALL, -ARENA, WALL_H / 2, 0, 0, Math.PI / 2),   // west
  surface(S, WALL_H, WALL, ARENA, WALL_H / 2, 0, 0, -Math.PI / 2),   // east
];

// --- frozen X2 arena. One captured frame from main_video becomes the surroundings, so you
// can play inside the generated world. A still image applied once — the game loop never
// touches X2, and the session can be stopped straight afterwards to bank credits.
let skinBox = null;

function skinArena(frame) {
  const tex = new THREE.Texture(frame); // canvas on P1, <img> on P2 — both work
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Unlit: the frame already contains X2's lighting, and relighting it looks like plastic.
  const lit = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide });
  const plain = new THREE.MeshBasicMaterial({ color: 0x10131a, side: THREE.BackSide });
  // Face order +x,-x,+y,-y,+z,-z: the frame goes on the four walls only, so a 16:9 render
  // is not stretched across the ceiling too.
  const mats = [lit, lit, plain, plain, lit, lit];

  if (skinBox) {
    skinBox.material.forEach((m) => m.map && m.map.dispose());
    skinBox.material = mats;
  } else {
    skinBox = new THREE.Mesh(new THREE.BoxGeometry(34, 14, 34), mats);
    skinBox.position.y = 7;
    scene.add(skinBox);
  }
  skinBox.visible = true;
  for (const s of shell) s.visible = false;
}

function unskinArena() {
  if (skinBox) skinBox.visible = false;
  for (const s of shell) s.visible = true;
}

// Both laptops poll for the shared skin, so when P1 freezes an X2 frame P2 walks into the
// same world a couple of seconds later. Static asset over HTTP, per the load-sequence rule.
let appliedSkin = 0;
if (!SHOWCASE) {
  setInterval(async () => {
    const r = await fetch(api(`/arena-skin?room=${encodeURIComponent(ROOM)}`)).catch(() => null);
    if (!r || !r.ok) return;
    const { version } = await r.json();
    if (!version || version === appliedSkin) return;
    appliedSkin = version;
    const img = new Image();
    // The image comes from the API host, not the page host. Without crossOrigin the texture
    // taints the WebGL context and the arena silently refuses to render. The server sends
    // Access-Control-Allow-Origin: *, so anonymous is enough.
    img.crossOrigin = 'anonymous';
    img.onerror = () => console.error('[arena] skin image failed to load —', img.src);
    img.onload = () => {
      skinArena(img);
      console.log(`[arena] shared X2 skin v${version} applied (${img.width}x${img.height})`);
      arenaReady();
    };
    img.src = api(`/arena-skin.jpg?room=${encodeURIComponent(ROOM)}&v=${version}`);
  }, 2000);
}

// --- wall structure. Real geometry bolted to the walls: crate stacks to start a climb,
// two tiers of ledge to climb onto, I-beam braces, harness rigs and pipe runs. Solid and
// standable, so the arena has verticality instead of being a flat box.
//
// staticBoxes are indestructible: they block movement, support standing and stop bullets,
// but have no HP. Kept out of `obstacles` so the state packet's HP array is unchanged.
const staticBoxes = [];

const STEEL = 0x6b7280, RUST = 0x8a5a3c, RAIL = 0x2aa8b8;

function prop(w, h, d, colour, x, y, z, ry = 0, solid = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: colour }));
  m.position.set(x, y, z);
  m.rotation.y = ry;
  scene.add(m);
  if (solid) {
    m.updateMatrixWorld();
    staticBoxes.push(new THREE.Box3().setFromObject(m));
    obstacleMeshes.push(m); // shots stop on it; userData.ob is undefined so it takes no damage
  }
  return m;
}

// Every solid box in the arena: obstacle parts plus indestructible wall structure.
function* allBoxes() {
  for (const o of obstacles) for (const b of o.boxes) yield b;
  for (const b of staticBoxes) yield b;
}

function buildWallProps() {
  const E = ARENA - 0.35; // just inside the wall plane
  // Each wall gets the same rig, rotated. Fixed layout, no randomness — both laptops
  // must build an identical arena.
  const walls = [
    { s: 1, axis: 'z' }, { s: -1, axis: 'z' },
    { s: 1, axis: 'x' }, { s: -1, axis: 'x' },
  ];
  for (const { s: sgn, axis } of walls) {
    const at = (along, y, depth, w, h, d, c, solid = true) => {
      const [x, z] = axis === 'z' ? [along, sgn * (E - depth)] : [sgn * (E - depth), along];
      return prop(axis === 'z' ? w : d, h, axis === 'z' ? d : w, c, x, y, z, 0, solid);
    };

    // two ledge tiers: 1.2m is reachable from the floor, 2.4m from the first tier
    at(-4.5, 1.2, 0.45, 4.0, 0.22, 0.9, STEEL);
    at(4.5, 2.4, 0.45, 3.4, 0.22, 0.9, STEEL);
    // crate stack under the low ledge — the first step up
    at(-6.6, 0.45, 0.75, 0.9, 0.9, 0.9, RUST);
    at(-5.75, 0.35, 0.75, 0.7, 0.7, 0.7, RUST);
    // support braces under each ledge
    at(-6.2, 0.6, 0.5, 0.18, 1.2, 0.18, STEEL, false);
    at(-2.8, 0.6, 0.5, 0.18, 1.2, 0.18, STEEL, false);
    at(3.2, 1.2, 0.5, 0.18, 2.4, 0.18, STEEL, false);
    at(5.8, 1.2, 0.5, 0.18, 2.4, 0.18, STEEL, false);
    // harness rig: vertical I-beam with a cross-bar, high on the wall
    at(0.6, 2.9, 0.3, 0.22, 4.0, 0.22, STEEL, false);
    at(0.6, 3.6, 0.55, 2.2, 0.16, 0.16, RAIL, false);
    // pipe run near the ceiling
    at(0, 4.45, 0.35, S - 1, 0.18, 0.18, RUST, false);
    at(0, 4.15, 0.55, S - 1, 0.12, 0.12, STEEL, false);
  }

  // Central raised platform — the contested high ground, reachable from the ledges.
  prop(3.2, 0.25, 3.2, STEEL, 0, 2.0, 0);
  prop(0.25, 2.0, 0.25, STEEL, -1.4, 1.0, -1.4, 0, false);
  prop(0.25, 2.0, 0.25, STEEL, 1.4, 1.0, 1.4, 0, false);
  // steps up to it
  prop(1.4, 0.25, 1.4, STEEL, -2.6, 1.0, -2.6);
  prop(1.4, 0.25, 1.4, RUST, 2.6, 1.4, 2.6);

  console.log(`[arena] ${staticBoxes.length} solid wall props built`);
}

// Teal skirting: the accent, and it gives the wall/floor join an edge to read against.
const SKIRT = 0.3;
surface(S, SKIRT, TEAL, 0, SKIRT / 2, -ARENA + 0.01, 0, 0);
surface(S, SKIRT, TEAL, 0, SKIRT / 2, ARENA - 0.01, 0, Math.PI);
surface(S, SKIRT, TEAL, -ARENA + 0.01, SKIRT / 2, 0, 0, Math.PI / 2);
surface(S, SKIRT, TEAL, ARENA - 0.01, SKIRT / 2, 0, 0, -Math.PI / 2);

// --- obstacles. Both laptops fetch the same public/arena.json over the same HTTP server,
// so the two scenes are identical with no sync code. This array is only the safety net:
// a missing or broken arena.json must never boot an empty room.
const FALLBACK = [
  { x: -5, z: -6, w: 2.4, h: 1.2, d: 1.0 }, { x: 4, z: -7, w: 1.0, h: 1.6, d: 2.4 },
  { x: 0, z: -2.5, w: 1.8, h: 1.1, d: 1.8 }, { x: -7, z: 1.5, w: 1.2, h: 2.2, d: 1.2 },
  { x: 6.5, z: 1, w: 3.0, h: 1.3, d: 1.0 }, { x: -2.5, z: 4.5, w: 2.0, h: 1.8, d: 1.0 },
  { x: 3.5, z: 5.5, w: 1.4, h: 1.0, d: 1.4 }, { x: -6, z: 8, w: 2.6, h: 1.5, d: 1.0 },
  { x: 7, z: 7.5, w: 1.0, h: 2.0, d: 2.0 }, { x: 1, z: 8.5, w: 1.8, h: 1.2, d: 1.8 }
];
const obstacles = [];
const obstacleMeshes = [];

// An obstacle is one or more parts. Intact it is a single tall box; broken it is 3-4 short ones.
// Parts carry a back-reference so a raycast hit maps to its obstacle without a lookup.
// Cover is colour-coded by what it is: chest-high dividers navy, desk-sized blocks wood,
// tall pillars white. Readable at a glance, and it matches the office it came from.
const obstacleColour = (h) => (h <= 1.4 ? NAVY : h <= 2.0 ? WOOD : PILLAR);

function addPart(ob, x, y, z, w, h, d) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: ob.colour })
  );
  mesh.position.set(x, y, z);
  mesh.userData.ob = ob;
  scene.add(mesh);
  ob.parts.push(mesh);
  ob.boxes.push(new THREE.Box3().setFromObject(mesh));
  obstacleMeshes.push(mesh);
}

function buildObstacles(list) {
  for (const o of list) {
    const ob = { spec: o, colour: obstacleColour(o.h), hp: 60, maxHp: 60,
                 broken: false, parts: [], boxes: [] };
    addPart(ob, o.x, o.h / 2, o.z, o.w, o.h, o.d);
    obstacles.push(ob);
  }
}

// Deterministic per-obstacle scatter, so the rubble is laid out identically on both laptops.
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function breakObstacle(ob) {
  if (ob.broken) return;
  ob.broken = true;
  for (const m of ob.parts) {
    scene.remove(m);
    m.geometry.dispose();
    obstacleMeshes.splice(obstacleMeshes.indexOf(m), 1);
  }
  ob.parts.length = 0;
  ob.boxes.length = 0;

  // Cover degrades rather than vanishing: 3-4 short chunks at ~40% height across the footprint.
  const s = ob.spec;
  const r = rng(Math.round((s.x * 73856093) ^ (s.z * 19349663) ^ (s.w * 83492791)) >>> 0);
  const n = 3 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const h = s.h * 0.4 * (0.75 + r() * 0.5);
    const w = s.w * (0.3 + r() * 0.25);
    const d = s.d * (0.3 + r() * 0.25);
    addPart(ob, s.x + (r() * 2 - 1) * s.w * 0.45, h / 2, s.z + (r() * 2 - 1) * s.d * 0.45, w, h, d);
  }
  paint(ob);
  dust(s.x, s.h * 0.4, s.z, Math.max(s.w, s.d) * 0.5);
}

// Note: a missing arena.json does NOT 404 here — the dev server serves index.html for unknown
// paths, so the shape has to be checked rather than the status code.
fetch('/arena.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
  .then((list) => {
    if (!Array.isArray(list) || !list.length) return Promise.reject('not a box array');
    buildObstacles(list);
    console.log(`[arena] ${list.length} boxes from arena.json`);
    buildWallProps();
  })
  .catch((e) => {
    buildObstacles(FALLBACK);
    console.log(`[arena] ${FALLBACK.length} boxes from the built-in fallback —`, e);
    buildWallProps();
  });
const paint = (ob) => {
  for (const m of ob.parts) {
    m.material.color.setHex(ob.colour).multiplyScalar(0.45 + 0.55 * (ob.hp / ob.maxHp));
  }
};

// Dust burst. `pos += vel; vel.y -= g` — arithmetic, not an engine.
const dusts = [];
function dust(x, y, z, spread) {
  const N = 26;
  const pos = new Float32Array(N * 3);
  const vel = [];
  for (let i = 0; i < N; i++) {
    pos[i * 3] = x + (Math.random() * 2 - 1) * spread;
    pos[i * 3 + 1] = y * Math.random();
    pos[i * 3 + 2] = z + (Math.random() * 2 - 1) * spread;
    vel.push(new THREE.Vector3(
      (Math.random() * 2 - 1) * 1.6, Math.random() * 2.4, (Math.random() * 2 - 1) * 1.6));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial(
    { color: 0xbfb3a0, size: 0.18, transparent: true, opacity: 0.9, depthWrite: false }));
  scene.add(pts);
  dusts.push({ pts, vel, life: 0.9 });
}

// --- players. Explicit invisible hitboxes now, not later — without these there is nothing to shoot.
// Kept out of the scene so nothing renders them; their matrices are updated by hand each frame.
const HITBOX_GEO = new THREE.BoxGeometry(0.6, 1.8, 0.6);
// A blocky FPS character built from primitives, sized to fit the 0.6 x 1.8 x 0.6 hitbox so
// what you shoot at is what you see. Origin is at the player's centre (0.9 above the feet),
// and it faces -Z at ry = 0, matching the camera convention.
function makeAvatar(suit, trim) {
  const g = new THREE.Group();
  const M = (c) => new THREE.MeshLambertMaterial({ color: c });
  const suitM = M(suit), trimM = M(trim), darkM = M(0x23262c);
  const put = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  put(0.17, 0.72, 0.19, darkM, -0.11, -0.53, 0);  // left leg
  put(0.17, 0.72, 0.19, darkM, 0.11, -0.53, 0);   // right leg
  put(0.44, 0.62, 0.26, suitM, 0, 0.16, 0);       // torso
  put(0.46, 0.10, 0.28, trimM, 0, 0.36, 0);       // chest band
  put(0.13, 0.52, 0.15, suitM, -0.29, 0.16, 0);   // left arm
  put(0.13, 0.52, 0.15, suitM, 0.29, 0.16, 0);    // right arm
  put(0.27, 0.27, 0.26, darkM, 0, 0.62, 0);       // helmet
  put(0.22, 0.09, 0.03, trimM, 0, 0.63, -0.135);  // visor — shows which way they face
  return g;
}

function makePlayer(i, x, z) {
  const hitbox = new THREE.Mesh(HITBOX_GEO, new THREE.MeshBasicMaterial());
  hitbox.userData.player = i;
  // Red for the enemy, blue for you — your own is only ever seen in the broadcast feed.
  const body = i === LOCAL ? makeAvatar(0x3d7fd6, 0x8fd0ff) : makeAvatar(0xd6443d, 0xffb07f);
  // Both bodies are in the scene so the spectator orbit sees both players. Your own avatar
  // goes on a layer the first-person camera does not render, instead of being left out.
  scene.add(body);
  if (i === LOCAL) body.traverse((o) => o.layers.set(spectator.OWN_BODY_LAYER));
  return {
    x, y: 0, z, ry: 0, hp: 100,
    vy: 0, grounded: false, // vertical state is per player: P1's sim owns both players'
    vel: new THREE.Vector3(), kb: new THREE.Vector3(), kbT: 0,
    net: { x, y: 0, z, hp: 100 }, hitbox, body
  };
}
const players = [makePlayer(0, 0, 7), makePlayer(1, 0, -7)]; // spawns inside the 20x20 arena
const hitboxes = players.map((p) => p.hitbox);

// Children of the camera only render if the camera is itself in the scene graph.
scene.add(camera);
camera.layers.enable(spectator.VIEWMODEL_LAYER); // sees the world plus its own viewmodel

// The spectator orbit is P1's alone: P2 never touches Reactor.
if (!IS_P2) spectator.attach();

// Reactor is imported dynamically inside the flag check, so the showcase bundle contains
// no X2 code at all rather than merely not calling it.
// SHOWCASE must be the FIRST term: it is the build-time constant, so `false && ...` makes the
// whole branch statically dead and the SDK chunk is never emitted. With the runtime IS_P2 test
// first the bundler cannot fold it, and 320KB of Reactor ships in the showcase build.
// If this tab is not P1 the panel would open with dead buttons, so say so instead.
if (SHOWCASE || IS_P2) {
  const bar = document.querySelector('#broadcast .bar');
  if (bar) bar.innerHTML = '<span style="color:#7c7f86">X2 is P1-only — ' +
    (SHOWCASE ? 'this is the showcase build (npm run dev:booth)' : 'this tab is P2') + '</span>';
}

if (!SHOWCASE && !IS_P2) import('./x2-broadcast.js').then(({ startBroadcast, stopBroadcast, isBroadcasting }) => {
  const panel = document.getElementById('broadcast');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const status = document.getElementById('x2status');
  const onStatus = (s) => (status.textContent = s);

  // B re-parents the live orbit canvas between the corner preview and the panel. Same element
  // either way, so the MediaStreamTrack X2 is publishing never breaks.
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB') return;
    const open = panel.style.display !== 'flex';
    panel.style.display = open ? 'flex' : 'none';
    (open ? document.getElementById('orbitSlot') : document.body).appendChild(spectator.canvas);
    if (!open) return;
    controls.unlock();
    // The <video> lives inside a display:none subtree while the panel is closed, and browsers
    // pause video there. Without this it comes back frozen and looks like X2 stopped sending.
    const out = document.getElementById('x2out');
    if (out.srcObject) void out.play();
  });

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
      await startBroadcast({
        sourceCanvas: spectator.canvas,
        outputVideo: document.getElementById('x2out'),
        onStatus,
      });
      stopBtn.disabled = false;
    } catch {
      // startBroadcast already logged the failing step and left it in the status line.
      // Caught only so it is not an unhandled rejection and the button comes back.
      startBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    await stopBroadcast('stop pressed');
    startBtn.disabled = false;
  });

  // Freeze the current X2 frame and drop into it. This is the only way the generated world
  // becomes playable — the loadout screen's "enter arena" always uses the flat geometry.
  const skinBtn = document.getElementById('skinBtn');
  let skinned = false;
  skinBtn.addEventListener('click', () => {
    if (skinned) {
      unskinArena();
      skinned = false;
      skinBtn.textContent = '2 · enter this arena';
      onStatus('back to the flat arena');
      return;
    }
    const v = document.getElementById('x2out');
    if (!v.videoWidth) return onStatus('no X2 frame yet — wait for main_video');

    const frame = document.createElement('canvas');
    frame.width = v.videoWidth;
    frame.height = v.videoHeight;
    frame.getContext('2d').drawImage(v, 0, 0);
    skinArena(frame);
    skinned = true;
    appliedSkin = -1; // do not let the poller re-apply our own upload over the top
    skinBtn.textContent = 'back to flat arena';
    console.log(`[arena] frozen X2 frame applied (${frame.width}x${frame.height})`);
    onStatus(`playing in the frozen ${frame.width}x${frame.height} frame`);

    // Publish it so P2 walks into the same world. Written to public/ and fetched over HTTP —
    // the socket stays for dynamic state only.
    fetch(api(`/arena-skin?room=${encodeURIComponent(ROOM)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: frame.toDataURL('image/jpeg', 0.85) }),
    })
      .then((r) => r.json())
      .then(({ version }) => {
        appliedSkin = version;
        console.log(`[arena] published to room "${ROOM}" as v${version}`);
        onStatus('arena published — share the link');
        showShare();
      })
      .catch((e) => console.warn('[arena] could not share the skin:', e.message));

    // Straight into the game so you see it immediately.
    panel.style.display = 'none';
    document.body.appendChild(spectator.canvas);
  });

  // Only offer it once main_video is actually producing frames.
  setInterval(() => {
    skinBtn.disabled = !document.getElementById('x2out').videoWidth;
  }, 1000);


  // The hard timeout and pagehide can end the session without the buttons being touched.
  setInterval(() => {
    if (isBroadcasting()) return;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }, 1000);
});

// Viewmodel: the scan frame on a plane parented to the camera, so the player visibly holds the
// object they scanned. depthTest off keeps it from clipping into a wall you stand against.
let muzzle = null;      // flashes in the scanned object's colour on every shot
let gunType = 'pistol'; // archetype of the held gun — picks the shot sound

// Magazine size falls out of the weapon: heavy multi-pellet guns hold few rounds, fast
// light ones hold many. Nothing hand-authored, same as every other stat.
const magSize = (w) => Math.max(4, Math.min(30,
  Math.round(150 / (w.damage * 0.55 + w.pellets * 3.5))));
let ammo = 0, magMax = 0, reloading = 0;   // reloading = seconds remaining
let recoilPitch = 0, recoilVel = 0, gunKick = 0; // camera kick + gun kickback
let localCd = 0; // local trigger cooldown, so P2 paces its own shots and ammo
let heldGun = null;

// The stats pick the silhouette. Same weapon config, five recognisable gun shapes.
function archetype(w) {
  if (w.pellets >= 4) return 'shotgun';   // wide spread, many pellets
  if (w.fireRate >= 8) return 'smg';      // light and fast
  if (w.damage >= 28) return 'cannon';    // heavy hitter
  if (w.spread <= 6) return 'rifle';      // tight and accurate
  return 'pistol';
}

// A real gun built from boxes and cylinders, painted in the scanned object's palette.
function buildGun(w, pal) {
  const g = new THREE.Group();
  // Phong with a tight highlight: a barrel needs a specular roll-off to look machined.
  const M = (c, shine) => new THREE.MeshPhongMaterial({ color: c, shininess: shine, specular: 0x9aa4b2 });
  const body = M(pal.body, 28), metal = M(pal.metal, 70), accent = M(pal.accent, 45);
  const add = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    g.add(m);
    return m;
  };
  const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
  const tube = (r, len) => new THREE.CylinderGeometry(r, r, len, 20); // smoother barrel

  const type = archetype(w);
  // Barrel length tracks accuracy, bore tracks pellet count — the shape reports the stats.
  const barrelLen = { shotgun: 0.30, smg: 0.16, cannon: 0.42, rifle: 0.40, pistol: 0.20 }[type];
  const bore = { shotgun: 0.030, smg: 0.017, cannon: 0.034, rifle: 0.020, pistol: 0.021 }[type];

  add(box(0.055, 0.075, 0.20), body, 0, 0, 0.02);            // receiver
  add(box(0.048, 0.125, 0.055), metal, 0, -0.088, 0.085, 0.22); // grip
  add(box(0.030, 0.022, 0.05), accent, 0, 0.048, 0.03);      // sight rail

  const barrel = add(tube(bore, barrelLen), metal, 0, 0.012, -0.09 - barrelLen / 2);
  barrel.rotation.x = Math.PI / 2;
  if (type === 'shotgun') { // second bore, side by side
    const b2 = add(tube(bore, barrelLen), metal, 0.034, 0.012, -0.09 - barrelLen / 2);
    b2.rotation.x = Math.PI / 2;
    barrel.position.x = -0.017;
    b2.position.x = 0.017;
  }
  if (type === 'smg' || type === 'rifle') {
    add(box(0.036, 0.10, 0.045), accent, 0, -0.075, -0.02);  // magazine
  }
  if (type === 'cannon') {
    add(tube(bore * 1.9, 0.07), accent, 0, 0.012, -0.09 - barrelLen).rotation.x = Math.PI / 2;
  }
  if (type === 'rifle') {
    add(box(0.04, 0.05, 0.11), body, 0, -0.01, 0.15);        // stock
  }

  g.userData.muzzleZ = -0.09 - barrelLen - (type === 'cannon' ? 0.07 : 0);
  // An empty at the barrel tip: tracers start from here, so shots visibly leave the gun
  // instead of appearing out of the middle of the screen.
  const tip = new THREE.Object3D();
  tip.position.set(type === 'shotgun' ? 0 : 0, 0.012, g.userData.muzzleZ);
  g.add(tip);
  g.userData.tip = tip;
  g.userData.type = type;
  return g;
}

function setViewmodel(thumbCanvas, weapon, pal) {
  // Skipping the scan means no palette — fall back to the weapon's own colour.
  const c = weapon.colour;
  const palette = pal || {
    body: c,
    metal: ((c >> 17) << 16) | (((c >> 9) & 0x7f) << 8) | ((c >> 1) & 0x7f),
    accent: 0xffffff,
  };

  const gun = buildGun(weapon, palette);
  gun.position.set(0.20, -0.20, -0.45);
  gun.rotation.set(0.03, -0.10, 0.02);
  gun.traverse((o) => { o.layers.set(spectator.VIEWMODEL_LAYER); o.renderOrder = 999; });
  camera.add(gun);
  gunType = gun.userData.type;
  heldGun = gun;
  console.log(`[viewmodel] ${gun.userData.type} built from the scan palette`,
    Object.fromEntries(Object.entries(palette).map(([k, v]) =>
      [k, '#' + v.toString(16).padStart(6, '0')])));

  // The scanned object stays present as a sticker on the receiver, so you can still see
  // what the gun came from without a photo floating in mid air.
  if (thumbCanvas) {
    const tex = new THREE.CanvasTexture(thumbCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(0.075, 0.075),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    );
    decal.position.set(-0.030, 0.004, 0.02);
    decal.rotation.y = -Math.PI / 2;
    decal.layers.set(spectator.VIEWMODEL_LAYER);
    decal.renderOrder = 1000;
    gun.add(decal);
  }

  // Muzzle flash at the actual barrel tip, sized by damage and spread.
  const size = 0.09 + weapon.damage / 160 + weapon.spread / 500;
  muzzle = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      color: palette.accent, transparent: true, opacity: 0, depthTest: false,
      blending: THREE.AdditiveBlending,
    })
  );
  muzzle.position.set(0, 0.012, gun.userData.muzzleZ - 0.02);
  muzzle.renderOrder = 1001;
  muzzle.layers.set(spectator.VIEWMODEL_LAYER);
  gun.add(muzzle);
}

const controls = new PointerLockControls(camera, document.body);
camera.position.set(players[LOCAL].x, EYE, players[LOCAL].z);
const blocker = document.getElementById('blocker');
blocker.addEventListener('click', () => { sfx.unlock(); controls.lock(); });
controls.addEventListener('lock', () => (blocker.style.display = 'none'));
controls.addEventListener('unlock', () => {
  blocker.style.display = winner === null ? 'flex' : 'none'; // the round is over: show the result, not "click to play"
});

const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyR') startReload();
});

const RELOAD_SECONDS = 1.25;
function startReload() {
  if (reloading > 0 || ammo === magMax || !magMax) return;
  reloading = RELOAD_SECONDS;
  sfx.reload(RELOAD_SECONDS);
  console.log(`[weapon] reloading ${RELOAD_SECONDS}s`);
}
addEventListener('keyup', (e) => (keys[e.code] = false));
let firing = false;
addEventListener('mousedown', () => { if (controls.isLocked) firing = true; });
addEventListener('mouseup', () => (firing = false));
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- the one fire function. Config-driven, zero per-weapon branches. Runs on P1 only.
const raycaster = new THREE.Raycaster();
const tracers = [];
const cooldowns = [0, 0];
const _fwd = new THREE.Vector3(), _dir = new THREE.Vector3();
const _origin = new THREE.Vector3(), _rpos = new THREE.Vector3();
let events = [];
let winner = null; // index of the winning player once someone hits 0 HP

function showResult() {
  const el = document.getElementById('result');
  el.innerHTML = `<b>${winner === LOCAL ? 'YOU WIN' : 'YOU LOSE'}</b><span>P${winner + 1} wins</span>`;
  el.style.display = 'flex';
  controls.unlock();
}

const _muzzleWorld = new THREE.Vector3();

function tracer(origin, end, colour) {
  // Draw from the barrel tip when the local player has a gun: the ray is still cast from the
  // camera, so accuracy is untouched — only the visible line starts somewhere believable.
  const from = (heldGun && heldGun.userData.tip)
    ? heldGun.userData.tip.getWorldPosition(_muzzleWorld).clone()
    : origin.clone();
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([from, end]),
    new THREE.LineBasicMaterial({ color: colour })
  );
  scene.add(line);
  tracers.push({ line, life: 0.08 });
}

function fire(shooter, weapon, origin, forward) {
  if (cooldowns[shooter] > 0) return;
  cooldowns[shooter] = 60 / weapon.fireRate;
  const targets = [...obstacleMeshes, ...hitboxes.filter((h) => h.userData.player !== shooter)];
  const jitter = THREE.MathUtils.degToRad(weapon.spread) / 2;
  events.push({ e: 'shot', from: shooter, ox: origin.x, oy: origin.y, oz: origin.z,
                dx: forward.x, dy: forward.y, dz: forward.z });

  for (let p = 0; p < weapon.pellets; p++) {
    _dir.copy(forward);
    _dir.x += (Math.random() * 2 - 1) * jitter;
    _dir.y += (Math.random() * 2 - 1) * jitter;
    _dir.z += (Math.random() * 2 - 1) * jitter;
    _dir.normalize();
    raycaster.set(origin, _dir);
    const hit = raycaster.intersectObjects(targets, false)[0]; // first hit wins — this IS cover blocking
    const end = hit ? hit.point.clone() : origin.clone().addScaledVector(_dir, 100);

    if (hit && hit.object.userData.player !== undefined) {
      const target = players[hit.object.userData.player];
      const was = target.hp;
      target.hp = Math.max(0, target.hp - weapon.damage);
      target.kb.copy(_dir).multiplyScalar(weapon.knockback / 100);
      target.kbT = 0.2;
      if (was > 0 && target.hp === 0) {
        events.push({ e: 'kill', from: shooter });
        winner = shooter;
        showResult();
      }
    } else if (hit && hit.object.userData.ob) {
      const ob = hit.object.userData.ob;
      ob.hp = Math.max(0, ob.hp - weapon.damage);
      if (ob.hp === 0) breakObstacle(ob); // stays broken: nothing ever repairs it
      else paint(ob);
    }
    // else: indestructible wall structure — the tracer just stops there.
    tracer(origin, end, weapon.colour);
  }
  // One sound per trigger pull, not per pellet — a 7-pellet shotgun is one bang.
  sfx.fire(shooter === LOCAL ? gunType : 'pistol', weapon, shooter === LOCAL ? 1 : 0.4);
}

// --- AABB collision. No physics engine: push out on the axis of least penetration.
// `feet` is the walker's foot height: a box whose top is at or below the feet is something
// they are standing on, not something that blocks them.
function resolve(pos, feet) {
  for (const b of allBoxes()) {
    if (b.max.y <= feet + 0.05) continue;
    if (pos.x < b.min.x - RADIUS || pos.x > b.max.x + RADIUS) continue;
    if (pos.z < b.min.z - RADIUS || pos.z > b.max.z + RADIUS) continue;
    const px = Math.min(b.max.x + RADIUS - pos.x, pos.x - (b.min.x - RADIUS));
    const pz = Math.min(b.max.z + RADIUS - pos.z, pos.z - (b.min.z - RADIUS));
    if (px < pz) pos.x += pos.x > (b.min.x + b.max.x) / 2 ? px : -px;
    else pos.z += pos.z > (b.min.z + b.max.z) / 2 ? pz : -pz;
  }
  pos.x = THREE.MathUtils.clamp(pos.x, -ARENA + RADIUS, ARENA - RADIUS);
  pos.z = THREE.MathUtils.clamp(pos.z, -ARENA + RADIUS, ARENA - RADIUS);
}

// Vertical step: `vel.y -= g` arithmetic, then land on the floor or on the highest box top
// already under the feet. Obstacle tops are standable, so boxes stack into steps.
function vertical(p, pos, dt) {
  const oldFeet = pos.y - EYE;
  p.vy -= GRAVITY * dt;
  let feet = oldFeet + p.vy * dt;
  let support = 0; // the floor
  for (const b of allBoxes()) {
    if (pos.x < b.min.x - RADIUS || pos.x > b.max.x + RADIUS) continue;
    if (pos.z < b.min.z - RADIUS || pos.z > b.max.z + RADIUS) continue;
    if (oldFeet >= b.max.y - 0.05 && b.max.y > support) support = b.max.y;
  }
  p.grounded = p.vy <= 0 && feet <= support;
  if (p.grounded) { feet = support; p.vy = 0; }
  pos.y = feet + EYE;
  return feet;
}

// --- net. Five message types, P1 authoritative, 20Hz down, ~30Hz up.
let sock = null, joined = false;
let remoteInput = { fwd: 0, str: 0, ry: 0, rx: 0, fire: false, jump: false };
const send = (m) => sock && sock.readyState === 1 && sock.send(JSON.stringify(m));

// Log the first 3 of each tag then every 40th, so 20Hz traffic stays readable.
const seenLog = new Map();
const loud = (tag) => {
  const n = (seenLog.get(tag) || 0) + 1;
  seenLog.set(tag, n);
  return n <= 3 || n % 40 === 0 ? n : 0;
};

// Broadcast unconditionally. There is no readiness gate: if no peer is attached the relay
// drops it, and the next tick self-heals. Gating this on a one-shot handshake is what broke it.
function sendState() {
  const n = loud('tx state');
  if (!sock || sock.readyState !== 1) {
    if (n) console.log(`[net] state #${n} NOT sent — readyState`, sock && sock.readyState);
    events = [];
    return;
  }
  send({
    type: 'state', t: performance.now() | 0,
    players: players.map((p) => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
                                   ry: +p.ry.toFixed(3), hp: p.hp })),
    obstacles: obstacles.map((o) => o.hp), // full array every tick, never deltas
    events
  });
  if (n) console.log(`[net] state #${n} sent`, { p0: players[0].x.toFixed(1) + ',' + players[0].z.toFixed(1),
    p1: players[1].x.toFixed(1) + ',' + players[1].z.toFixed(1), events: events.length });
  events = [];
}

function sendInput() {
  send({
    type: 'input',
    fwd: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0),
    str: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0),
    ry: +controls.object.rotation.y.toFixed(3),
    rx: +controls.object.rotation.x.toFixed(3),
    fire: firing && controls.isLocked && ammo > 0 && reloading === 0,
    jump: !!keys.Space && controls.isLocked
  });
}

// Reconnecting socket. A free host that is asleep refuses the first connection, and a single
// attempt at page load meant P2 sat there with no state and could not move. Retries with
// backoff, and re-announces itself on every successful open.
let netAttempt = 0;
let inputTimer = null;

function connectRelay() {
  netAttempt++;
  console.log(`[net] connecting (attempt ${netAttempt})`, RELAY_URL);
  sock = new WebSocket(RELAY_URL);

  const retry = () => {
    if (sock && sock.readyState === 1) return;
    const wait = Math.min(8000, 700 * netAttempt);
    console.warn(`[net] disconnected — retrying in ${wait}ms`);
    setTimeout(connectRelay, wait);
  };
  sock.addEventListener('error', retry);
  sock.addEventListener('close', retry);

  sock.addEventListener('open', () => {
    netAttempt = 0;
    console.log('[net] OPEN', RELAY_URL);
  });
  sock.addEventListener('open', () => {
    if (IS_P2) {
      // Retry until P1 answers. A single hello is lost whenever P1 connects second or reloads.
      const hi = setInterval(() => (joined ? clearInterval(hi) : send({ type: 'hello' })), 500);
      send({ type: 'hello' });
      if (!inputTimer) inputTimer = setInterval(sendInput, 33); // once, not once per reconnect
    }
    send({ type: 'loadout', weapon: weapons[LOCAL] });
  });
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const n = loud('rx ' + m.type);
    if (n) console.log(`[net] recv ${m.type} #${n}`, m.type === 'state'
      ? { t: m.t, players: m.players, obstacles: m.obstacles.length, events: m.events.length }
      : m);
    if (!joined) {
      const st = document.getElementById('shareState');
      if (st) { st.textContent = 'player 2 connected'; st.style.color = '#4ade80'; }
    }
    joined = true; // any message at all proves the peer is there — not just hello
    if (m.type === 'hello') {
      send({ type: 'init', playerIndex: 1, arenaUrl: '/arena.json', photoUrl: '/room.jpg' });
      send({ type: 'loadout', weapon: weapons[0] });
    } else if (m.type === 'init') {
      console.log('[net] joined as player', m.playerIndex);
    } else if (m.type === 'loadout') {
      weapons[IS_P2 ? 0 : 1] = m.weapon;
    } else if (m.type === 'input') {
      remoteInput = m;
    } else if (m.type === 'state') {
      for (let i = 0; i < players.length; i++) {
        players[i].net = m.players[i];
        players[i].hp = m.players[i].hp;
        if (i !== LOCAL) players[i].ry = m.players[i].ry;
      }
      // The full HP array arrives every tick, so a zero always breaks the box — even one that
      // broke before this client was looking. breakObstacle is idempotent; nothing repairs.
      for (let i = 0; i < obstacles.length; i++) {
        obstacles[i].hp = m.obstacles[i];
        if (obstacles[i].hp === 0) breakObstacle(obstacles[i]);
        else paint(obstacles[i]);
      }
      for (const e of m.events) {
        if (e.e === 'kill') { winner = e.from; showResult(); continue; }
        if (e.e !== 'shot') continue;
        _origin.set(e.ox, e.oy, e.oz);
        _dir.set(e.dx, e.dy, e.dz);
        raycaster.set(_origin, _dir);
        const hit = raycaster.intersectObjects(
          [...obstacleMeshes, ...hitboxes.filter((h) => h.userData.player !== e.from)], false)[0];
        tracer(_origin, hit ? hit.point : _origin.clone().addScaledVector(_dir, 100),
               weapons[e.from].colour);
      }
    }
  });
}

if (!SHOWCASE) {
  connectRelay();
  if (!IS_P2) setInterval(sendState, 50);
}

// P1 simulates P2 from the input packet. Same velocity model, so both players move at the same speed.
function stepRemote(p, input, dt) {
  const sin = Math.sin(input.ry), cos = Math.cos(input.ry);
  p.vel.x -= p.vel.x * DAMPING * dt;
  p.vel.z -= p.vel.z * DAMPING * dt;
  p.vel.x += (-sin * input.fwd + cos * input.str) * SPEED * dt;
  p.vel.z += (-cos * input.fwd - sin * input.str) * SPEED * dt;
  _rpos.set(p.x, p.y + EYE, p.z).addScaledVector(p.vel, dt);
  if (input.jump && p.grounded) p.vy = JUMP;
  if (p.kbT > 0) { // XZ only — vy owns height, same as the local path
    p.kbT = Math.max(0, p.kbT - dt);
    const k = (p.kbT / 0.2) * dt;
    _rpos.x += p.kb.x * k;
    _rpos.z += p.kb.z * k;
  }
  resolve(_rpos, p.y);
  p.y = vertical(p, _rpos, dt);
  p.x = _rpos.x;
  p.z = _rpos.z;
  p.ry = input.ry;
  if (input.fire) {
    _fwd.set(-sin * Math.cos(input.rx), Math.sin(input.rx), -cos * Math.cos(input.rx));
    fire(1, weapons[1], _rpos.set(p.x, p.y + EYE, p.z), _fwd);
  }
}

// Remote peer interpolated over ~100ms. P2's own position is smoothed over one packet interval;
// it is still one round-trip behind, and that is the deal — no prediction, no rollback.
const smooth = (p, tau, dt) => {
  const k = 1 - Math.exp(-dt / tau);
  p.x += (p.net.x - p.x) * k;
  p.y += (p.net.y - p.y) * k; // jump height arrives over the wire like everything else
  p.z += (p.net.z - p.z) * k;
};

const velocity = new THREE.Vector3();
const STRIDE = 2.0; // metres between footfalls
let stride = 0;
const hud = document.getElementById('hud');
const clock = new THREE.Clock();
let hudAcc = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  const me = players[LOCAL];

  if (IS_P2) {
    // Renders received state only. Mouse look stays local; everything else comes off the wire.
    smooth(players[1 - LOCAL], 0.1, dt);
    smooth(me, 0.05, dt);
    camera.position.set(me.x, me.y + EYE, me.z);
  } else {
    if (controls.isLocked && winner === null) {
      const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const str = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      velocity.x -= velocity.x * DAMPING * dt;
      velocity.z -= velocity.z * DAMPING * dt;
      velocity.z -= fwd * SPEED * dt;
      velocity.x += str * SPEED * dt;
      controls.moveRight(velocity.x * dt);
      controls.moveForward(-velocity.z * dt);
      if (keys.Space && me.grounded) me.vy = JUMP;
    }
    if (me.kbT > 0) { // knockback impulse, decaying to zero over ~200ms. XZ only — vy owns height.
      me.kbT = Math.max(0, me.kbT - dt);
      const k = (me.kbT / 0.2) * dt;
      camera.position.x += me.kb.x * k;
      camera.position.z += me.kb.z * k;
    }
    const wasGrounded = me.grounded;
    const px = me.x, pz = me.z;
    resolve(camera.position, me.y);
    me.y = vertical(me, camera.position, dt);
    me.x = camera.position.x;
    me.z = camera.position.z;

    // Footsteps are paced by distance, not time, so walking and strafing sound the same
    // and standing still is silent.
    if (me.grounded) {
      if (!wasGrounded) {
        sfx.step(true); // landed
        stride = 0;
      } else {
        stride += Math.hypot(me.x - px, me.z - pz);
        if (stride >= STRIDE) { stride -= STRIDE; sfx.step(false); }
      }
    }
    if (joined && winner === null) stepRemote(players[1], remoteInput, dt);
  }
  me.ry = controls.object.rotation.y;

  for (const p of players) {
    p.hitbox.position.set(p.x, p.y + 0.9, p.z);
    p.hitbox.updateMatrixWorld();
    p.body.position.set(p.x, p.y + 0.9, p.z);
    p.body.rotation.y = p.ry; // the visor shows which way they are actually looking
  }

  for (let i = 0; i < cooldowns.length; i++) if (cooldowns[i] > 0) cooldowns[i] -= dt * 60;
  // Reload timer, and auto-reload the moment the magazine runs dry.
  if (reloading > 0) {
    reloading = Math.max(0, reloading - dt);
    if (reloading === 0) { ammo = magMax; console.log('[weapon] reloaded'); }
  } else if (ammo === 0 && magMax) startReload();

  // Trigger handling runs for BOTH players. P1 additionally resolves the shot against the
  // world; P2 only produces local feel — flash, kick, sound, ammo — and lets its input packet
  // tell P1 to do the actual damage. Previously this whole block was gated on !IS_P2, so P2
  // had no gun feedback at all: no muzzle flash, no recoil, no sound, and ammo never moved,
  // which also meant reload could never trigger.
  if (localCd > 0) localCd -= dt * 60;
  if (firing && controls.isLocked && winner === null) {
    const w = weapons[LOCAL];
    if (ammo > 0 && reloading === 0 && localCd <= 0) {
      localCd = 60 / w.fireRate;
      ammo--;
      if (muzzle) muzzle.material.opacity = 1;
      // Recoil scales with damage and pellet count and is damped by fire rate, so a slow
      // cannon throws the view and an SMG only shudders.
      recoilVel += (0.010 + w.damage / 900 + w.pellets / 320) * (1 - Math.min(0.5, w.fireRate / 24));
      gunKick = Math.min(0.05, 0.012 + w.damage / 700);

      if (!IS_P2) {
        camera.getWorldDirection(_fwd);
        fire(LOCAL, w, _origin.copy(camera.position), _fwd); // authoritative: plays its own sound
      } else {
        sfx.fire(gunType, w); // P1 resolves the damage; this is just the feel
      }
    } else if (ammo === 0 && reloading === 0 && localCd <= 0) {
      localCd = 12;
      sfx.dryFire();
    }
  }

  // Recoil: a spring back to zero. Rises fast, settles over a few frames, never accumulates
  // into a permanently tilted camera because the pitch is applied as a delta and pulled back.
  if (recoilVel !== 0 || recoilPitch !== 0) {
    camera.rotation.x += recoilVel;
    recoilPitch += recoilVel;
    recoilVel *= 0.72;
    const back = recoilPitch * 0.16;
    camera.rotation.x -= back;
    recoilPitch -= back;
    if (Math.abs(recoilVel) < 1e-5 && Math.abs(recoilPitch) < 1e-5) { recoilVel = 0; recoilPitch = 0; }
  }
  if (heldGun) { // barrel kicks back and returns
    gunKick *= 0.82;
    heldGun.position.z = -0.45 + gunKick;
  }
  if (muzzle && muzzle.material.opacity > 0) {
    muzzle.material.opacity = Math.max(0, muzzle.material.opacity - dt * 12);
  }

  for (let i = dusts.length - 1; i >= 0; i--) {
    const d = dusts[i];
    d.life -= dt;
    const a = d.pts.geometry.attributes.position.array;
    for (let j = 0; j < d.vel.length; j++) {
      d.vel[j].y -= 9 * dt;
      a[j * 3] += d.vel[j].x * dt;
      a[j * 3 + 1] = Math.max(0, a[j * 3 + 1] + d.vel[j].y * dt);
      a[j * 3 + 2] += d.vel[j].z * dt;
    }
    d.pts.geometry.attributes.position.needsUpdate = true;
    d.pts.material.opacity = Math.max(0, d.life / 0.9);
    if (d.life > 0) continue;
    scene.remove(d.pts);
    d.pts.geometry.dispose();
    d.pts.material.dispose();
    dusts.splice(i, 1);
  }

  for (let i = tracers.length - 1; i >= 0; i--) {
    if ((tracers[i].life -= dt) > 0) continue;
    scene.remove(tracers[i].line);
    tracers[i].line.geometry.dispose();
    tracers.splice(i, 1);
  }

  // Throttled to ~8Hz. Rebuilding innerHTML every frame forces an HTML parse plus a full
  // layout 60 times a second, which is a serious framerate cost on a modest laptop.
  hudAcc += dt;
  if (hudAcc >= 0.125) {
    hudAcc = 0;
    const w = weapons[LOCAL];
    hud.innerHTML =
    `HP ${me.hp} &nbsp;·&nbsp; enemy ${players[1 - LOCAL].hp}` +
    `<br><b style="color:#${w.colour.toString(16).padStart(6, '0')}">${w.name}</b>` +
    ` &nbsp; dmg ${w.damage} &nbsp; rate ${w.fireRate}/s &nbsp; spread ${w.spread}° &nbsp; ` +
    `pellets ${w.pellets}` +
    `<br>${reloading > 0 ? 'RELOADING…' : `ammo ${ammo}/${magMax}`}` +
    `${ammo === 0 && reloading === 0 ? ' — press R' : ''}` +
      (SHOWCASE ? '<br>SHOWCASE' : `<br>${ROLE}${joined ? '' : ' waiting'}`);
  }
  renderer.render(scene, camera);

  // After the player's frame is presented, never before it.
  if (!IS_P2) spectator.update(scene, players, dt);
}
tick();

// The match is gated on the loadout screen. The weapon goes over the wire once, here; the
// thumb stays on this laptop and only ever becomes the local viewmodel.
// Host: the arena exists and is published, so this is the moment to hand over the link.
const shareEl = document.getElementById('share');
function showShare() {
  const field = document.getElementById('shareLink');
  field.value = inviteLink();
  shareEl.style.display = 'flex';
  blocker.style.display = 'none';
  controls.unlock();
}
document.getElementById('shareCopy').addEventListener('click', async () => {
  const field = document.getElementById('shareLink');
  field.select();
  try { await navigator.clipboard.writeText(field.value); } catch { document.execCommand('copy'); }
  document.getElementById('shareCopy').textContent = 'copied';
});
document.getElementById('sharePlay').addEventListener('click', () => {
  shareEl.style.display = 'none';
  if (winner === null) blocker.style.display = 'flex';
});

// P2 waits here while P1 builds the arena. Dismissable, so a P1 who never makes one
// cannot strand P2 on a loading screen.
const waiting = document.getElementById('waiting');
let waitingShown = false;
function showWaiting() {
  if (waitingShown || appliedSkin) return;
  waitingShown = true;
  waiting.style.display = 'flex';
  blocker.style.display = 'none';
}
function arenaReady() {
  if (!waitingShown) return;
  waiting.classList.add('ready');
  waiting.querySelector('b').textContent = 'arena ready';
  waiting.querySelector('span').textContent = 'dropping you in…';
  setTimeout(dismissWaiting, 1200);
}
function dismissWaiting() {
  waitingShown = false;
  waiting.style.display = 'none';
  waiting.classList.remove('ready');
  if (winner === null) blocker.style.display = 'flex';
}
document.getElementById('waitSkip').addEventListener('click', dismissWaiting);

loadoutScreen(DEFAULT_WEAPON).then(({ weapon, thumb, palette }) => {
  weapons[LOCAL] = weapon;

  // Arm the weapon BEFORE building the model. These used to be set inside setViewmodel, so
  // any error while building the gun mesh left magMax at 0 — which reads as "ammo 0/0, cannot
  // reload, cannot shoot". Ammo is game state; it must not depend on rendering succeeding.
  magMax = magSize(weapon);
  ammo = magMax;
  console.log(`[weapon] ${weapon.name} — mag ${magMax}, ${weapon.damage}dmg ${weapon.fireRate}/s`);

  try {
    setViewmodel(thumb, weapon, palette);
  } catch (e) {
    console.error('[viewmodel] failed to build the gun — playing without it:', e);
  }
  send({ type: 'loadout', weapon });
  console.log('[loadout]', weapon);
  if (IS_P2 && !SHOWCASE) showWaiting(); // P1 owns arena creation; P2 waits for it
}).catch((e) => console.error('[loadout] failed:', e));
