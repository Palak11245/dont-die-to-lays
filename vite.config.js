import { defineConfig } from 'vite';

// Local dev proxies everything to the one server on :8090, so the browser only ever talks to
// the Vite origin — no CORS, no extra firewall holes. In production VITE_API_BASE points at
// the hosted server instead and these proxies are unused.
const target = 'http://localhost:8090';
const proxy = {
  '/scan': target,
  '/arena-skin': target,
  '/arena-skin.jpg': target,
  '/reactor-token': target,
  '/health': target,
};

export default defineConfig({
  // strictPort: if 5173 is taken Vite would silently move to 5174 and the invite link would
  // point at a stale dev server. Fail loudly instead.
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 5173, strictPort: true, proxy },
});
