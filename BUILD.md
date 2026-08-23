# BUILD.md

**Deadline 4:00pm.** All times are offsets from when you start. **The last 45 minutes are
submission and recording, not building.** Two people, two parallel tracks, four sync points.

Total: 6h15m of building + 45m of locking. If you have less, pre-cut from the ladder at the
bottom **now** rather than discovering it at 2pm.

## Who does what

- **You — Claude Code driver.** The repo: engine, net, arena, destruction, scanner,
  weapons, viewmodel. You never touch Reactor.
- **Durva — Reactor and ops.** The entire X2 pipeline, room photo, credit watch, SFX,
  deployment, submission, video. Durva never edits game logic.

Swap if you prefer, but decide once. Below, **A = you** and **B = Durva**.

**The reason this works:** B builds and tests the whole X2 pipeline against a looping dummy
video **before the game exists.** At S3 the source swaps from dummy video to the real
spectator camera — a one-line change. The single riskiest integration is off the critical
path entirely.

---

## 0:00–0:30 · Both · Setup

**A** — scaffold and prove the spine. No Rosebud: the FPS skeleton is Three.js's own
`PointerLockControls` example (`three/examples/jsm/controls/PointerLockControls.js`), which
ships with working movement and collision. Lift it, delete what you don't need.

```bash
npm create vite@latest arena -- --template vanilla
cd arena && npm i three ws
npm run dev -- --host
```

P2 opens `http://<P1-lan-ip>:5173` on the phone hotspot. **If that page does not load on the
second laptop, stop everything.** The architecture rests on it.

Drop `PRD.md`, `CLAUDE.md`, `BUILD.md` in the repo root. Commit.

**B** — Reactor auth:

```bash
claude mcp add --transport http --scope project reactor-docs https://docs.reactor.inc/mcp
claude mcp list
```

`/mcp` inside Claude Code to confirm. Redeem the promo code, confirm $50, key into `.env`.
Build the token server. **No model bake-off** — X2 is decided in `CLAUDE.md`.

**B** — take the room photo now. Wide, well lit, furniture visible. Save to
`arena/public/room.jpg`.

**B** — no model to pre-cache: scanning is a Claude vision call through `server/vision.js`.
Doing this at 3:50pm on venue wifi is a demo-killer.

**B — deploy dry-run. Do not skip this.** Before the game exists, run `npm run build` on the
empty scaffold and drag `dist/` onto Vercel or Netlify. Confirm the URL loads on a phone.
Write the URL down. At 5:30 you are then re-running something that already worked, instead
of debugging a build config with twenty minutes left. This is the cheapest insurance on the
whole plan.

---

## Track A — the game

### 0:30–2:00 · Two laptops shooting

Strip the template to move-look-shoot. Delete menus, pickups, enemies, HUD extras. Deleting
is faster than adapting.

Then the relay exactly as specced: five message types, P1 authoritative, 20Hz down, ~30Hz up,
full obstacle array every tick.

**Player hitboxes now, not later.** Invisible 0.6 × 1.8 × 0.6 box per player in a `hitboxes`
array; raycasts test obstacles and hitboxes together. Without this there is nothing to shoot.

**`SHOWCASE` flag from the first commit.** All net code checks it. `SHOWCASE=true` must run
single-player with no relay.

**Checkpoint:** two people on two laptops shooting each other with one default gun.
`SHOWCASE=true` on the same build runs single-player.

### 2:00–3:00 · The arena

1. **Backdrop.** Large inverted box, `room.jpg` mapped inside. Twenty minutes, and the whole
   thing looks intentional.
2. **Box editor.** Load the photo, drag rectangles, each extrudes into a box. Write to
   `public/arena.json`.
3. Both laptops fetch it. No sync code — same server, same file, identical scene.

Approximate geometry is fine. The one thing to get right is that cover sits roughly where a
person expects cover.

### ⛔ 3:00 · HARD GATE

Two players duelling in a recognisable version of your room, on two laptops. **If you are
not here, go to the cut ladder.** Do not proceed with this broken.

### 3:00–3:40 · Destruction

- Obstacle HP. Shot connects, HP drops.
- At zero: swap the tall box for 3–4 short scattered boxes at ~40% height, plus a dust burst.
  Cover degrades rather than vanishing.
- **No separate line-of-sight raycast.** First-hit-wins already blocks shots.
- HP bars, win state.

**Checkpoint:** the table breaks, you walk away, you come back, still broken — on both
laptops.

### 3:40–5:00 · Scan, weapons, viewmodel

**+0:00** Extend the scanner to emit all seven fields:
`{ name, damage, fireRate, spread, knockback, pellets, colour }` plus a local-only `thumb`.
Do not redesign the axes or formulas.

**+0:15** One fire function, config-driven, no per-weapon branches. Cooldown → jitter per
pellet inside `spread` → raycast against obstacles and hitboxes → first hit wins → damage
plus knockback impulse decaying over ~200ms → tracer in `colour` → sound. **Clamps are
mandatory.**

**+0:40** Viewmodel. Scan frame as a texture on a plane parented to the camera at
`(0.35, -0.3, -0.7)`. Sine bob while moving, `position.z` kick on fire. Circular framing
guide during the scan plus radial alpha falloff for the background — no segmentation.

**+1:05** Balance. Scan ten real objects off the tables, play a round with each, adjust the
four coefficients until nothing feels useless and nothing feels broken. Tune by feel.

**Checkpoint:** scan a bag of crisps, watch yourself hold it, fire a fast wide green spray
gun. Scan a steel bottle, get a slow heavy single shot. Same code both times.

---

## Track B — Reactor and ops

### 0:30–2:00 · X2 against a dummy video

**This is the whole point of the two-track split.** You do not need the game to build this.

Point X2 at any looping video file as source, `room.jpg` as reference, style-transfer prefix
with a preservation boundary. Get a restyled stream rendering into a `<canvas>` on screen.

New file, `x2-broadcast.js`. Hard timeout. Explicit disconnect in a `finally`.
`recoverable=false`. Behind the `SHOWCASE` flag.

Read the schema off the `reactor-docs` MCP server. Never guess the slug.

**2-minute sessions with a timer.** Kill every one explicitly.

**Checkpoint:** a dummy video restyled into your room, on screen, at a known frame rate,
with a known credit cost per minute.

**Bail-out at 2:00 if nothing works:** run X2 once against `room.jpg`, screenshot a few
angles, hand them to A as arena textures. Bank the credits. This is a planned outcome.

### 2:00–3:00 · SFX

Three procedural Web Audio sounds, ~15 lines each: weapon fire (filtered noise burst with an
envelope driven by the property vector), impact, destruction crunch. Hand to A as one module
with a three-function interface.

No TTS. No announcer. Cut for a two-person team.

### 3:00–5:00 · Idle-time ops

Credit dashboard check every 30 minutes. Rehearse the demo script. Prepare the Devfolio
submission fields so 5:30 is paste-only. Set up screen recording and test it.

If A is behind at the 3:00 gate, B drops everything and takes the box editor.

---

## Sync points

| Time | What |
|---|---|
| **0:30** | B confirms the deploy dry-run URL loads. B never touches game logic. |
| **3:00** | Hard gate. Both stop and assess. B joins A if the gate fails. |
| **5:00** | B swaps the X2 source from dummy video to A's spectator camera. One line. |
| **5:30** | Both stop building. Lock begins. |

### 5:00–5:30 · The swap

A adds a third camera on P1: slow orbit at walking pace, loosely following the action.
B repoints `x2-broadcast.js` at it. Output to the projector.

**Verify the game stays fully playable with the X2 session killed mid-match.** Actually kill
it and watch. Do not assume.

---

## 5:30–6:15 · Lock, submit, record — non-negotiable

- **`SHOWCASE=true`.** Confirm net off, Reactor off, arena + scan + destruction on.
- `npm run build`, drag `dist/` onto Vercel or Netlify. Same drop zone you tested at 0:30.
  Open the URL on another device and confirm it runs.
- **Submit to Devfolio immediately.** Not at the deadline.
- Screen capture of a full two-laptop match with the broadcast visible.
- Phone video of two people actually playing in the room. This is what proves "real world."
- Queue the video on the desktop as the fallback if the live demo dies.

No new features. No refactors.

---

## Cut ladder

Behind at the 3:00 gate? Cut in this order, no deviation:

1. Viewmodel bob and recoil — keep the static held object
2. Dust burst on destruction — keep the box swap
3. X2 broadcast → pre-generated arena textures instead
4. Destruction rubble → obstacles simply disappear at 0 HP
5. Procedural SFX
6. **Two laptops → split-screen on one machine.** Last resort, but `setScissorTest` plus two
   viewports is 20 lines and it saves the demo.

**Never cut:** the room-photo arena, the scan, or the weapon-from-object pipeline.

## Credit discipline

$50 ≈ 500,000 credits, billed per session-second **including idle**. One forgotten tab is
the whole budget.

| Phase | Budget |
|---|---|
| Track B dummy-video work | 30 min, in 2-minute sessions with a timer |
| 5:00 swap and verify | 15 min |
| Demo reserve | 15 min, untouched |

B checks the dashboard every 30 minutes and may kill any session without asking.
