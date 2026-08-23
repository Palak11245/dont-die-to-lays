// SHOWCASE=true  -> publicly hosted single-player build: arena, scan, destruction on; net and X2 off.
// SHOWCASE=false -> booth build: two laptops, ws relay, Reactor X2 on P1.
// Vite only reads this from .env files, NOT from a shell env var. Booth mode lives in .env.booth,
// selected by --mode booth; see the dev:booth / build:booth scripts. Keep .env.booth BOM-free.
export const SHOWCASE = import.meta.env.VITE_SHOWCASE !== 'false';
