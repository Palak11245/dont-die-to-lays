# CLAUDE.md

## What this is

Same-day hackathon build, **two people**. Two players, **two laptops**, one LAN. A photo of
a real room becomes the arena. Each player scans real objects with their webcam; those
objects become their weapons, visibly held in first person. WASD, mouse look, shoot. Shots
that miss hit the environment. Cover takes damage, breaks into rubble, and stays broken.
First to zero HP loses.

A third slow-orbiting spectator camera on P1 is streamed through Reactor X2 and re-rendered
as photoreal footage of the real room. That is the projector view.

## Hard constraints — do not violate

1. **No physics engine.** No Rapier, Matter.js, Cannon, Ammo, Jolt. Collision is AABB and
   `THREE.Raycaster`. Particles are `pos += vel; vel.y -= g` — arithmetic, not an engine.
2. **No world-model call inside the game loop.** X2 is never on the path between an input
   and a rendered player frame. Ever.
3. **P1 is the sole authority.** P1 runs the Vite server, the `ws` relay, the simulation,
   the spectator camera and the X2 session. P2 sends inputs and renders received state.
   No prediction, no rollback, no reconciliation.
4. **No API keys in client code.** `REACTOR_API_KEY` (`rk_...`) is server-side only.
   Exchange it for a JWT via the token endpoint. If you are about to write `rk_` into
   anything the browser loads, stop.
5. **No localStorage or sessionStorage.** In-memory only; arena layout lives at
   `public/arena.json`. Simpler, and it keeps the hosted build identical to the booth build.
6. **No cloud multiplayer.** Local `ws` relay on P1 over a phone hotspot. Venue wifi is
   assumed hostile.
7. **`SHOWCASE` flag from the first commit.** `SHOWCASE=true` builds the publicly hosted
   single-player version (arena, scan, destruction on; net and X2 off). `SHOWCASE=false` is
   the booth build. **Every** net or Reactor feature checks it. Deployment must be
   `npm run build` and a drag-and-drop, not surgery.
8. **No refactors unless asked.** Smallest possible diffs. We are against a clock.

## Scope — this is the whole game

**IN:** photo backdrop, drag-box arena, WASD + mouse look + shoot, two-laptop net, obstacle
HP → rubble, vision scan → weapon stats, scanned object as viewmodel, three procedural SFX,
HP bars, win state, X2 spectator broadcast.

**OUT, and stays out:** DM narration, TTS of any kind, leaderboards, rarity and lore,
event-driven prompt updates, rounds, menus, reloading, ammo, animation, third-person weapon
on the remote player, per-box pixel textures, background segmentation.

If asked to add anything on the OUT list, decline and cite this section. Two people cannot
build the three-person plan.

## How the two laptops load and sync

**Static assets over HTTP. Dynamic state over WebSocket.** This split is the design — never
send the room photo through the socket.

P1 runs `npm run dev -- --host` and the relay. P2 opens `http://<P1-lan-ip>:5173` and
installs nothing.

**Load sequence**

1. P1 uploads the room photo → written to `public/room.jpg`
2. P1 drags boxes over it → written to `public/arena.json`
3. Both laptops `fetch('/room.jpg')` and `fetch('/arena.json')` and build an identical
   scene. No sync code — it is the same HTTP server.
4. Each player scans on their own laptop. The loadout goes over the socket **once**.
5. P1 sends `start`. The 20Hz state loop begins.

**Socket messages — only these five**

```js
// P2 → P1, on connect
{ type:'hello' }

// P1 → P2. P2 then fetches the static assets.
{ type:'init', playerIndex:1, arenaUrl:'/arena.json', photoUrl:'/room.jpg' }

// either → P1, once, after scanning
{ type:'loadout',
  weapon:{ name, damage, fireRate, spread, knockback, pellets, colour } }

// P1 → P2, 20Hz. Full obstacle array every tick, never deltas.
{ type:'state', t:12043,
  players:[{x,y,z,ry,hp},{x,y,z,ry,hp}],
  obstacles:[60,60,0,45,60],
  events:[{ e:'shot', from:0, ox,oy,oz, dx,dy,dz }, { e:'kill', from:0 }] }

// P2 → P1, ~30Hz
{ type:'input', fwd:1, str:0, ry:2.31, rx:-0.1, fire:true }
```

The viewmodel thumbnail **never leaves the laptop that captured it.** Each player sees their
own scanned object in first person; the remote player renders as a plain capsule. This is
why `thumb` is not in any message — third-person weapons are cut.

Interpolate the remote player over ~100ms. P2 has one LAN round-trip of input lag on its own
movement — 5–20ms on a hotspot. Do not build prediction to fix it.

## The memory guarantee

World models have no reliable object permanence. Ours does, because the model holds no
gameplay state. Destruction is `obstacles[i].hp = 0` in RAM on P1. Walk away, come back,
still broken.

The full obstacle HP array goes out in **every** packet. Fifteen obstacles is fifteen bytes
and a dropped packet self-heals on the next tick. Deltas are how the two laptops end up
disagreeing about whether the table is broken.

## The weapon pipeline

One Claude vision call returns five property scores plus the captured frame. Everything derives from
those. **Nothing is hand-authored per object.**

```
damage    = clamp(20·hardness + 15·mass + 10·sharpness, 4, 35)
fireRate  = clamp(2 + 9(1 − mass) + 3·energy, 1, 12)
spread    = 45(1 − sharpness)(1 − elongation)
knockback = 80 + 320·mass
pellets   = round(1 + spread / 8)
colour    = dominant pixel hue of the scan frame
name      = adjective(highest axis) + noun(archetype)
```

**The full weapon config is seven fields:**
`{ name, damage, fireRate, spread, knockback, pellets, colour }`, plus a local-only
`thumb`. `scanner-spike.html` emits four; extend it, do not redesign the axes or formulas.

**There is exactly one fire function**, config-driven, zero per-weapon branches:

1. Cooldown — `60 / fireRate` frames between shots
2. Per pellet, jitter the camera forward vector inside `spread`
3. `raycaster.intersectObjects([...obstacleMeshes, ...playerHitboxes])`, take `[0]`
4. Player → apply `damage`, and push their velocity along the ray by `knockback` decaying
   to zero over ~200ms. Obstacle → drop HP. Nothing → tracer flies off and dies.
5. Tracer in `colour`, sound derived from the property vector

**Cover blocking is not a separate check.** First-hit-wins already gives it: if a box is
between muzzle and target, the box is `[0]` and the player takes nothing. Do not add a
second line-of-sight raycast.

**Player hitboxes are explicit.** Each player owns an invisible `BoxGeometry` roughly
0.6 × 1.8 × 0.6 tracking their position, in a `hitboxes` array. Raycasts test obstacles and
hitboxes together. Without this there is nothing to shoot.

**The clamps are load-bearing.** A blank-wall scan reads ~0.5 on every axis; without clamps
that is a useless gun or a one-shot.

The scan frame is also the **viewmodel texture** — a plane parented to the camera at
`(0.35, -0.3, -0.7)`. Sine bob while moving, `position.z` kick on fire lerping home over
~120ms. A circular framing guide during the scan plus a radial alpha falloff handles the
background. Do not build segmentation.

## Architecture

```
room photo ──> box editor ──> public/arena.json ──┐
                                                  │  (both laptops fetch over HTTP)
object scan ──> vision ──> weapon config ──ws once─┤
                                                  v
                                    P1: authoritative sim
                                            │
                    ┌───────────────────────┼──────────────────┐
                    v                       v                  v
             P1 view (local)      P2 view (ws, 20Hz)     spectator cam
                                                               │      (P1 renders
                                                               v       and streams)
                                                        Reactor X2 ──> projector
```

## Stack

| Piece | Library | Notes |
|---|---|---|
| Engine | Three.js + `PointerLockControls` | lifted from the official example |
| Net | `ws` | relay on P1, 20Hz down, ~30Hz up |
| Object scan | Claude vision (`claude-sonnet-4-6`) via `server/vision.js` | key server-side; browser POSTs a frame, gets five axes |
| Broadcast | Reactor X2 | spectator cam only, P1 only |
| SFX | Web Audio, procedural | fire sound derives from the property vector |

## Files

- `scanner-spike.html` — working property scanner, same vision endpoint as the game. **The five axes and the
  stat formulas are hand-tuned. Do not rewrite them.** Extend to seven output fields.
- `PRD.md` — one page. Read once.
- `BUILD.md` — the countdown plan. Read before proposing work.
- `arena/` — Vite + Three.js app. `public/` holds `room.jpg` and `arena.json`.
  Built for static hosting: `npm run build` produces a `dist/` folder that runs anywhere.
- `server/` — token exchange + `ws` relay. P1 only.

## Reactor — X2, decided

**The model choice is settled. Do not run a bake-off.**

Only two Reactor models do video-to-video editing, which is what a broadcast layer needs.
Helios and LongLive 2 are *generation* models — they invent their own scene from a prompt
and cannot take our rendered frame as a source, so they cannot broadcast our match.

- **X2 — primary.** Documented source + reference + prompt contract with an explicit
  preservation boundary. This is the one.
- **SANA-Streaming — fallback.** 2B real-time streaming video-to-video editing. Smaller and
  cheaper. Swap to it only if X2 misbehaves in the sandbox.

Read the real schema from the `reactor-docs` MCP server before writing integration code.
**Never guess the model slug, command names, or event names** — take the slug from the
model's own page.

- SOURCE = spectator camera feed. Supplies composition, spatial position, motion.
- REFERENCE = `room.jpg`. One image, fixed for the whole match.
- PROMPT = style-transfer prefix + one preservation boundary. **Set once, never changed.**

Constraints that shape the design:

- Prefers stable framing and slow-to-moderate motion. This is why the spectator camera
  orbits at walking pace and why the FPS camera is never the source.
- Prompt changes land at generation boundaries with a settling delay. Do not re-prompt on
  gameplay events — that feature is cut.
- Run-to-run variation is cosmetic only. Composition comes from the source, so a broken
  table stays broken and stays put.

**P1 renders the spectator camera and owns the session. P2 never touches Reactor.**

**Billing is per session-second of wall-clock, including idle.** $50 ≈ 4–8 hours total.
Hard timeout, explicit disconnect in a `finally`, `recoverable=false`. One leaked session
drains the budget.

## Things you will be tempted to do. Don't.

- Adding a physics engine for the rubble. It is a box swap and a particle burst.
- Reconstructing 3D geometry from the room photo. Manual drag-boxes. Approximate is fine.
- A second raycast for line-of-sight. First-hit-wins already does it.
- Client prediction or rollback. Interpolate over ~100ms and move on.
- Putting the room photo or a base64 thumbnail into the state packet.
- Putting X2 on a player camera "just to try it." It will smear and it will cost credits.
- Testing Helios or LongLive as broadcast candidates. They cannot take a source frame.
- Rewriting the five axes into object recognition. Properties, not identity, is the point —
  it is why no object is ever unrecognised.
- Per-weapon special cases in the fire function.
- Adding TTS, narration, rarity, lore, or a leaderboard. All cut for a two-person team.
- Error boundaries and retry wrappers. If it throws we want to see it now.
- Writing any networked or Reactor feature that ignores the `SHOWCASE` flag.

## Working style

Two sentences of explanation, then the smallest diff. Ambiguity gets a question, not a guess.
After any render or Reactor change, confirm the game still plays with the session killed.
