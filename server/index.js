// One server for everything the game needs, on ONE port — because a hosted service (Render,
// Fly, Railway) gives you exactly one. Locally it is the same server, so dev and production
// behave identically.
//
//   GET  /health            -> { ok, routes, rooms }
//   POST /scan              -> five property axes + a weapon name, from Claude vision
//   GET  /arena-skin?room=  -> { version } for the frozen X2 arena frame
//   POST /arena-skin?room=  -> publish a frozen frame to everyone in the room
//   GET  /arena-skin.jpg?room=
//   GET  /reactor-token     -> short-lived Reactor JWT (the rk_ key never leaves this process)
//   ws   /?room=CODE        -> the 20Hz relay, scoped to a room
//
// Secrets come from the environment only. Nothing here is ever bundled into the browser.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { AXES } from '../src/weapon.js';

const PORT = Number(process.env.PORT) || 8090;
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-6';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REACTOR_KEY = process.env.REACTOR_API_KEY;
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ---------------------------------------------------------------- vision
const strip = (s) => s.replace(/^a photo of an? /, '');
const SYSTEM =
  'You rate a physical object shown in an image on five property axes. ' +
  'Each value is a float from 0.0 to 1.0.\n\n' +
  AXES.map((a) => `- ${a.key}: 0.0 means ${strip(a.lo)}; 1.0 means ${strip(a.hi)}`).join('\n') +
  '\n\nJudge only the main object in the frame, ignoring the background. Use the full range — ' +
  'commit to values near 0 or 1 when the object clearly sits at an extreme.\n\n' +
  'Also name the weapon this object becomes. Work out what the object actually is, then give ' +
  'it an ominous, destructive, slightly unhinged two-or-three-word weapon name that riffs on ' +
  'that specific object — a stapler might become "Mandible Reaver", a banana "The Potassium ' +
  'Verdict", a mug "Ceramic Last Rites". Never generic: the name must only make sense for ' +
  'this exact object. No surrounding quotes, at most 34 characters.\n\n' +
  'Respond with ONLY a JSON object, no prose, no explanation, no markdown fences:\n' +
  '{"hardness":0.0,"mass":0.0,"sharpness":0.0,"elongation":0.0,"energy":0.0,"name":"..."}';

async function score(dataUrl) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set on the server');
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(dataUrl);
  const media_type = m ? m[1] : 'image/jpeg';
  const data = m ? m[2] : dataUrl;

  const t0 = Date.now();
  const res = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 256,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type, data } },
        { type: 'text', text: 'Rate this object on the five axes.' },
      ],
    }],
  });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const props = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  for (const a of AXES) {
    const v = props[a.key];
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`missing axis "${a.key}"`);
    props[a.key] = Math.max(0, Math.min(1, v));
  }
  props.name = typeof props.name === 'string'
    ? props.name.replace(/["'`]/g, '').trim().slice(0, 34) : '';
  console.log(`[vision] ${Date.now() - t0}ms "${props.name}" ` +
    AXES.map((a) => `${a.key}=${props[a.key].toFixed(2)}`).join(' '));
  return props;
}

// ---------------------------------------------------------------- reactor token
let cachedToken = null;
async function reactorToken() {
  if (!REACTOR_KEY) throw new Error('REACTOR_API_KEY not set on the server');
  if (cachedToken && cachedToken.expires_at * 1000 - Date.now() > 60_000) return cachedToken;
  const r = await fetch('https://api.reactor.inc/tokens', {
    method: 'POST',
    headers: { Authorization: `Bearer ${REACTOR_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
  cachedToken = await r.json();
  console.log('[token] minted');
  return cachedToken;
}

// ---------------------------------------------------------------- rooms
// A room is one match: up to two players plus a shared arena frame. Kept in memory — a
// restart just means everyone rejoins, and nothing here is worth persisting.
const rooms = new Map();
const room = (code) => {
  const key = (code || 'main').slice(0, 24);
  if (!rooms.has(key)) rooms.set(key, { peers: [], skin: null, version: 0 });
  return rooms.get(key);
};

const readBody = (req, limit = 12e6) =>
  new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(b));
  });

// ---------------------------------------------------------------- http
const srv = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get('room');
  const json = (o, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };

  try {
    if (url.pathname === '/health') {
      return json({
        ok: true,
        vision: Boolean(anthropic),
        reactor: Boolean(REACTOR_KEY),
        rooms: [...rooms].map(([k, r]) => ({ room: k, peers: r.peers.length })),
      });
    }

    if (url.pathname === '/scan' && req.method === 'POST') {
      const { image } = JSON.parse(await readBody(req));
      return json(await score(image));
    }

    if (url.pathname === '/arena-skin') {
      const r = room(code);
      if (req.method === 'GET') return json({ version: r.version });
      if (req.method === 'POST') {
        const { image } = JSON.parse(await readBody(req));
        r.skin = Buffer.from(String(image).replace(/^data:image\/[a-z+]+;base64,/, ''), 'base64');
        r.version = Date.now();
        console.log(`[skin] room "${code || 'main'}" ${(r.skin.length / 1024) | 0}KB v${r.version}`);
        return json({ version: r.version });
      }
    }

    if (url.pathname === '/arena-skin.jpg') {
      const r = room(code);
      if (!r.skin) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      return res.end(r.skin);
    }

    if (url.pathname === '/reactor-token') return json(await reactorToken());

    res.writeHead(404).end();
  } catch (e) {
    console.error('[http]', url.pathname, e.message);
    json({ error: e.message }, 500);
  }
});

// ---------------------------------------------------------------- relay
// Same HTTP server, so one port covers both. Peers only ever see their own room.
const wss = new WebSocketServer({ server: srv });
let nextId = 1;

wss.on('connection', (ws, req) => {
  const code = new URL(req.url, 'http://x').searchParams.get('room') || 'main';
  const r = room(code);
  ws.id = nextId++;
  ws.roomCode = code;
  r.peers.push(ws);
  console.log(`[relay] peer ${ws.id} joined "${code}" (${r.peers.length} in room)`);

  ws.on('message', (data) => {
    const s = data.toString();
    for (const p of r.peers) if (p !== ws && p.readyState === 1) p.send(s);
  });

  ws.on('close', () => {
    r.peers = r.peers.filter((p) => p !== ws);
    console.log(`[relay] peer ${ws.id} left "${code}" (${r.peers.length} in room)`);
    if (!r.peers.length && !r.skin) rooms.delete(code);
  });
});

srv.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`\n[!] port ${PORT} already in use — stop the other server first.\n`);
  process.exit(1);
});

srv.listen(PORT, () => {
  console.log(`arena server on :${PORT}`);
  console.log(`  vision  ${anthropic ? 'enabled' : 'DISABLED (no ANTHROPIC_API_KEY)'}`);
  console.log(`  reactor ${REACTOR_KEY ? 'enabled' : 'DISABLED (no REACTOR_API_KEY)'}`);
  console.log('  routes: /health /scan /arena-skin /arena-skin.jpg /reactor-token  + ws relay');
});
