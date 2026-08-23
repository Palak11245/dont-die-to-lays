# PRD.md — Scavenger Arena

## What this is

Same-day hackathon build, **two people**. Two players, two laptops, one LAN. You upload a
photo of a real room; it becomes the arena. Each player scans a real object with their
webcam — a bag of chips, a water bottle, a stapler — and that object becomes a gun they
visibly hold in first person, with stats derived from the object's physical properties.
WASD, mouse look, shoot. Cover takes damage and stays broken.

A third slow-orbiting spectator camera on P1 is streamed through Reactor X2 and re-rendered
as a live photoreal broadcast of the fight in the actual venue. That is the projector view.

## Pitch, 30 seconds

> "The arena is this room. Empty your pockets — anything you're holding becomes your gun,
> with stats from what it physically is. Two players duel on two laptops. Cover breaks, and
> it stays broken. And the projector is a world model watching the match and broadcasting it
> as photoreal footage of the room you're standing in."

## Demo, staged

1. Show the room photo. "The arena is this room."
2. Judge hands you an object. Scan it. Named weapon with real stats, and you're holding it.
3. Two players fight on two laptops. Cover breaks. It stays broken.
4. Point at the projector: the same fight, re-rendered live into photoreal footage of this
   room.

Lead with the scan. Never open with architecture.

## Success criteria, priority order

1. Two laptops, two players, a real match to completion without crashing
2. Scan works; weapons feel different per object; player visibly holds the object
3. Arena is recognisably the venue
4. Destruction persists across the match
5. X2 broadcast running on the projector

Cut in reverse order. **Never cut 1–3** — they are the entire pitch.

## Non-goals

Menus, character select, reloading, ammo, minimaps, levelling, rounds, cloud multiplayer,
mobile, animated player models, custom shaders, physics engine, DM narration, leaderboards,
event-driven prompt updates, world-model gameplay rendering.

## The Reactor story, told honestly

X2 drives the live broadcast: your engine's frame is the source, a photo of the room is the
reference, and X2 repaints every frame while holding your composition, motion and spatial
position intact. Grey boxes in, photoreal footage of this venue out, live, while two people
fight inside it.

Nine layers of this game are deterministic and one is generated. **Say that plainly.** The
FPS runs in Three.js and pretending otherwise loses trust in ten seconds. The considered
version — "we put the model where it's uniquely strong and kept it out of the input loop
where it drifts" — is the stronger claim anyway.

## Team of two

- **You — Claude Code driver.** Own the repo: engine, networking, arena, destruction,
  scanner, weapons, viewmodel. Everything in `arena/`.
- **Durva — Reactor and ops.** Owns the X2 pipeline end to end, the room photo, credit
  watch, SFX, deployment, submission, demo video. Never edits game logic.

Swap these if the other split suits you better, but decide once and don't renegotiate.

Durva builds and tests the entire X2 pipeline against a looping dummy video **before the
game exists**, then swaps the source to the real spectator camera at 5:00. That removes the
biggest integration risk from the critical path.

**No Rosebud.** The FPS skeleton comes from Three.js's own `PointerLockControls` example;
hosting is a static build on Vercel or Netlify.

## Deadline

**4:00pm today.** The last 45 minutes are submission and recording, not building.

Architecture and constraints: `CLAUDE.md`. Countdown plan: `BUILD.md`.
