// Where the game finds its server, and which match it joins.
//
// Local dev:  VITE_API_BASE is empty, so every call is same-origin and vite.config.js
//             proxies it to the server on :8090.
// Hosted:     VITE_API_BASE is the Render URL, e.g. https://arena-server.onrender.com.
//             The static site on Vercel then talks to it directly over CORS.
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export const api = (path) => `${API_BASE}${path}`;

// Websocket URL for the relay. Derived from API_BASE so https becomes wss automatically —
// a hosted page on https cannot open an insecure ws:// socket.
// In dev the socket goes straight to the server port rather than through Vite: proxying a
// websocket on the root path collides with Vite's own HMR socket.
export const DEV_SERVER_PORT = 8090;

export function relayUrl(room) {
  const base = API_BASE
    ? API_BASE.replace(/^http/, 'ws')
    : `ws://${location.hostname}:${DEV_SERVER_PORT}`;
  return `${base}/?room=${encodeURIComponent(room)}`;
}

const q = new URLSearchParams(location.search);

// Room code keeps two matches apart on a public URL, so strangers do not join each other.
// The host's invite link carries both the room and ?p2.
export const ROOM = (q.get('room') || 'main').slice(0, 24);

// Role is explicit — no hostname guessing. Whoever opens the plain link hosts (P1) and runs
// the simulation; the invite link carries ?p2. Same rule on a LAN and on a hosted URL, which
// is what the old localhost heuristic kept getting wrong.
export const IS_JOINER = q.has('p2');

export function inviteLink() {
  const u = new URL(location.href);
  u.searchParams.set('room', ROOM);
  u.searchParams.set('p2', '');
  return u.toString().replace('p2=', 'p2');
}
