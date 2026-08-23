// Third camera: a slow orbit for the projector feed. Renders the same scene into its own
// canvas with its own renderer, so the canvas can be handed straight to captureStream().
//
// Never on the path between an input and a rendered player frame — the game loop calls
// update() after it has already presented the player's frame, and the orbit is throttled
// to 24fps regardless of how fast the game runs.
import * as THREE from 'three';

export const SPECTATOR_FPS = 24; // X2 emits main_video at 24fps; produce at the same rate

// Layer 0 is the shared world. These two split what each camera may see.
export const VIEWMODEL_LAYER = 1;  // player camera only — the held object is first-person
export const OWN_BODY_LAYER = 2;   // spectator only — never render your own capsule in your face

const ORBIT_R = 6.5;      // inside the 20x20 room, so the camera never leaves the walls
const ORBIT_Y = 3.0;      // above head height, below the 5m ceiling
const WALK = 1.4;         // m/s — walking pace, converted to angular speed by the radius
const FOLLOW_TAU = 10.0;  // seconds; very long on purpose — see the speed budget below
const CENTRE_LIMIT = 2.5; // ORBIT_R + this stays inside the arena, so no positional clamping
const LOOK_Y = 1.2;

// Speed budget. X2 prefers stable framing and slow-to-moderate motion, and the follow drift
// stacks on top of the orbit whenever the two align:
//   orbit          WALK                       = 1.40 m/s   (29s per revolution)
//   follow drift   2*CENTRE_LIMIT / FOLLOW_TAU = 0.50 m/s
//   worst case                                 ~1.81 m/s measured, max reach 6.93m of 10m
// FOLLOW_TAU was 2.0 first: that peaked at 4.84 m/s, a sprint, which is exactly the motion
// that smears. If you retune these, re-check the peak before pointing X2 at it.

export const canvas = document.createElement('canvas');
canvas.id = 'spectator';
canvas.width = 960;
canvas.height = 540;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(canvas.width, canvas.height, false);

export const camera = new THREE.PerspectiveCamera(55, canvas.width / canvas.height, 0.1, 200);
camera.layers.enable(OWN_BODY_LAYER); // sees the world plus both player bodies, never the viewmodel

const centre = new THREE.Vector3(0, LOOK_Y, 0);
let angle = 0;
let acc = 0;

export function attach(parent = document.body) {
  parent.appendChild(canvas);
}

export function update(scene, players, dt) {
  // Loosely follow the action: ease the orbit centre toward the midpoint of the two players.
  // Clamped so the orbit itself can never reach a wall, which keeps the motion continuous —
  // clamping the camera position instead would make it stutter along the boundary.
  const mx = (players[0].x + players[1].x) / 2;
  const mz = (players[0].z + players[1].z) / 2;
  const k = 1 - Math.exp(-dt / FOLLOW_TAU);
  centre.x += (THREE.MathUtils.clamp(mx, -CENTRE_LIMIT, CENTRE_LIMIT) - centre.x) * k;
  centre.z += (THREE.MathUtils.clamp(mz, -CENTRE_LIMIT, CENTRE_LIMIT) - centre.z) * k;

  angle += (WALK / ORBIT_R) * dt; // constant linear speed, whatever the radius
  camera.position.set(
    centre.x + Math.cos(angle) * ORBIT_R,
    ORBIT_Y,
    centre.z + Math.sin(angle) * ORBIT_R
  );
  camera.lookAt(centre.x, LOOK_Y, centre.z);

  acc += dt;
  if (acc < 1 / SPECTATOR_FPS) return;
  acc = 0;
  renderer.render(scene, camera);
}

// The SOURCE feed for x2-broadcast.js. X2 wants stable framing and slow-to-moderate motion,
// which is the whole reason this orbits at walking pace and the FPS camera is never the source.
export function spectatorTrack(fps = SPECTATOR_FPS) {
  return canvas.captureStream(fps).getVideoTracks()[0];
}
