# Arena — scan a real object, it becomes your gun

A two-player browser FPS. Scan any real object with your webcam; Claude reads five physical
property axes off it and those numbers *are* your weapon — damage, fire rate, spread,
knockback, pellet count, colour, and the gun's silhouette. Shoot cover apart, it stays broken.

Everything is derived. Nothing is hand-authored per object.

---

## Run it locally

```bash
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY
```

Two terminals:

```bash
npm run server              # game server + relay on :8090
npm run dev:booth           # the game on :5173
```

Open <http://localhost:5173>. You are the host (P1). The loadout screen shows an **invite
link** — send it to the other player; it drops them into the same room as P2.

Single-player, no server needed:

```bash
npm run dev                 # showcase build: scan + arena + destruction, no multiplayer
```

---

## Deploy

Two pieces: a static site and one small server.

### 1. Server → Render

Create a **Web Service** from this repo.

| Setting | Value |
|---|---|
| Build command | `npm install` |
| Start command | `node server/index.js` |
| Health check | `/health` |

Add environment variables in the Render dashboard (never in the repo):

- `ANTHROPIC_API_KEY` — required, powers the object scan
- `REACTOR_API_KEY` — optional, only for the X2 spectator broadcast

Render sets `PORT` itself. `render.yaml` is included if you prefer a blueprint deploy.

Check it: `https://<your-service>.onrender.com/health` should return
`{"ok":true,"vision":true,...}`.

### 2. Site → Vercel

Import the repo. Vercel picks up `vercel.json` (`npm run build` → `dist`).

Add one environment variable:

```
VITE_API_BASE = https://<your-service>.onrender.com
```

Redeploy after setting it — Vite bakes it in at build time.

> Building without `VITE_API_BASE` produces the single-player showcase build: scanning still
> works via local pixel analysis, but there is no multiplayer.

For multiplayer on the hosted site, build with the booth flag:
set the Vercel build command to `npm run build:booth`.

---

## Two people playing

1. Host opens the site. They are P1 and run the simulation.
2. Host copies the **invite link** from the loadout screen and sends it over.
3. The other player opens it — same `?room=` code, joins as P2.
4. Both scan an object, both press enter, and you are in.

Room codes keep separate matches apart, so two pairs can play at once without colliding.
Add your own with `?room=anything`.

---

## Controls

| | |
|---|---|
| WASD | move |
| Space | jump — ledges and crates are climbable |
| Mouse | look |
| Click | fire |
| R | reload |
| B | broadcast panel (host only, needs `REACTOR_API_KEY`) |
| Esc | release the pointer |

---

## Security

- API keys live in the server environment only. Nothing secret is ever bundled into the
  browser — the client calls `/scan` and gets five numbers back.
- `.env` is gitignored. `.env.example` is the template.
- The showcase build contains no relay, no Reactor code and no key references at all.

---

## Layout

```
src/weapon.js       the five property axes and the stat formulas — the heart of it
src/scan.js         loadout screen: capture -> properties -> weapon
src/main.js         renderer, simulation, netcode
src/spectator.js    slow orbit camera for the broadcast feed
src/x2-broadcast.js Reactor X2 spectator stream (optional)
server/index.js     one server: relay + vision + token, one port
public/editor.html  drag boxes over a room photo to author an arena
```
