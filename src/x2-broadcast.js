// Reactor X2 spectator broadcast. P1 only, and only in the booth build.
//
// Uses the typed model client, @reactor-models/x2, which is what the X2 tutorial uses.
// Everything below was read from that installed package's own type definitions, not guessed:
//
//   MODEL_NAME  = "xmax/x2"          <- namespaced. Passing "x2" is what 404'd the session.
//   X2Tracks    = [{name:"source",direction:"sendonly"},{name:"main_video",direction:"recvonly"}]
//   new X2Model(options?)            model name + tracks are baked in, so no modelName arg
//   connect(jwt)                     inherited from Reactor
//   publishSource(track: MediaStreamTrack): Promise<void>
//   uploadFile(file: File|Blob, options?): Promise<FileRef>     inherited from Reactor
//   setReferenceImage({ reference_image: FileRef }): Promise<void>
//   setPrompt({ prompt?: string })   max 1000 chars
//   onMainVideo(handler: (track, stream) => void): () => void
//   onGenerationStarted / onGenerationStopped / onCommandError / onStateUpdate
//   disconnect(recoverable?): Promise<void>
//
// There is NO start command: "A non-empty prompt is required before generation begins."
// So the prompt goes last, after the source track is already publishing.
import { SHOWCASE } from './config.js';
import { api } from './net-config.js';

const REFERENCE_URL = '/room.jpg';
const FPS = 24; // X2 emits main_video at 24fps; produce at the same rate

// Billing is per session-second of WALL CLOCK, idle included — so the clock starts at connect,
// not at first frame, and the hard timeout is armed at connect for the same reason.
const HARD_TIMEOUT_MS = 2 * 60 * 1000;
const TICK_MS = 10_000;

// Style-transfer prefix plus one preservation boundary. Set once, never changed: prompt changes
// apply from the next block with a settling delay, so re-prompting mid-match only smears.
//
// The prefix names the structure the arena geometry actually contains — ledges, crate stacks,
// I-beams, harness rigs, pipe runs, a central platform. X2 takes composition from the source,
// so telling it what those shapes ARE gets them rendered as scaffolding rather than smoothed
// into furniture. The preservation boundary stays a single clause at the end.
const PROMPT =
  'Transform the scene into a photorealistic industrial combat arena: scuffed painted metal ' +
  'walls, exposed steel scaffolding, bolted catwalk ledges, climbing rigs and safety ' +
  'harnesses, stacked shipping crates, thick pipe runs along the ceiling, grated floor ' +
  'panels, harsh practical work lighting with deep shadows and haze. Render every ledge, ' +
  'beam and crate as solid industrial structure. Preserve the original composition, spatial ' +
  'positions, geometry, motion and camera movement exactly.';

let x2 = null;
let timer = null;
let ticker = null;
let startedAt = 0;
let notify = () => {};

// connect() resolves once the coordinator hands back a session, but the WebRTC transport is
// not up yet — publishing there fails with 'Cannot publish track "source" - not connected'.
// ReactorStatus is "disconnected" | "connecting" | "waiting" | "ready"; the SDK documents the
// session schema as arriving "shortly after the session becomes ready", so "ready" is the gate.
// On timeout the last status is reported, so a wrong gate names itself instead of hanging.
const READY_TIMEOUT_MS = 30_000;

function waitForReady(m) {
  return new Promise((resolve, reject) => {
    let last = m.getStatus?.() ?? 'unknown';
    console.log('[x2] status at connect:', last);
    if (last === 'ready') return resolve(last);

    let readyTimer = null;
    let onStatus = null;
    // Declared before the handler that calls it: m.on() could replay the current status
    // synchronously, and a const declared after would be in the temporal dead zone.
    const finish = (done) => {
      clearTimeout(readyTimer);
      if (onStatus) m.off('statusChanged', onStatus);
      done();
    };

    onStatus = (s) => {
      last = s;
      console.log('[x2] status ->', s);
      if (s === 'ready') finish(() => resolve(s));
      else if (s === 'disconnected') {
        finish(() => reject(new Error('transport dropped to "disconnected" while waiting for "ready"')));
      }
    };
    readyTimer = setTimeout(() => finish(() => reject(new Error(
      `transport never reached "ready" in ${READY_TIMEOUT_MS / 1000}s (last status: "${last}")`
    ))), READY_TIMEOUT_MS);

    m.on('statusChanged', onStatus);
  });
}

export const isBroadcasting = () => x2 !== null;
export const elapsedSeconds = () => (startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0);

// Terminates the session. recoverable=false so nothing is left parked on the server billing us.
export async function stopBroadcast(why = 'stop pressed') {
  clearTimeout(timer);
  clearInterval(ticker);
  timer = ticker = null;
  const m = x2;
  if (!m) return;
  x2 = null; // cleared first, so a re-entrant call cannot disconnect twice
  const total = elapsedSeconds();
  startedAt = 0;
  try {
    await m.disconnect(false);
  } catch (e) {
    // A client that never finished connecting can throw here. Swallow it: this must never
    // replace the real setup error, which is the thing worth reading.
    console.warn('[x2] disconnect threw (ignored):', e?.message || e);
  }
  console.log(`[x2] DISCONNECTED (${why}) — billed roughly ${total}s of session time`);
  notify(`disconnected after ${total}s`);
}

/**
 * @param sourceCanvas canvas the spectator orbit renders into — this is the SOURCE feed
 * @param outputVideo  <video> that receives the restyled main_video track
 * @param onStatus     called with short human-readable status strings for the UI
 */
export async function startBroadcast({ sourceCanvas, outputVideo, onStatus, timeoutMs = HARD_TIMEOUT_MS }) {
  if (SHOWCASE) {
    console.log('[x2] SHOWCASE build — broadcast is off');
    return null;
  }
  if (x2) {
    console.warn('[x2] already connected; ignoring');
    return x2;
  }
  notify = onStatus || (() => {});

  // Named so a failure says which step died instead of just "disconnected after 0s".
  let step = 'loading SDK';
  notify('loading SDK…');
  const { X2Model, MODEL_NAME } = await import('@reactor-models/x2');
  const m = new X2Model();
  x2 = m;

  // A tab close must not leave a session billing. pagehide fires where beforeunload does not.
  addEventListener('pagehide', () => { void stopBroadcast('page hidden'); }, { once: true });

  try {
    m.onMainVideo((track) => {
      console.log('[x2] main_video track received');
      outputVideo.srcObject = new MediaStream([track]);
      void outputVideo.play();
      notify('receiving main_video');
    });
    m.onGenerationStarted(() => { console.log('[x2] generation_started'); notify('generating'); });
    m.onGenerationStopped(() => { console.log('[x2] generation_stopped'); notify('generation stopped'); });
    m.onCommandError((e) => { console.error('[x2] command_error', e); notify('command error'); });
    m.onStateUpdate((s) => console.log('[x2] state_update', s));

    // 1. CONNECT
    // Same-origin path, proxied to server/token.js on 8091 by vite.config.js — same reason
    // as /scan: no CORS, and P2's machine never needs 8091 open through the firewall.
    step = 'fetching JWT from /reactor-token';
    notify('fetching JWT…');
    const tr = await fetch(api('/reactor-token'), { signal: AbortSignal.timeout(10_000) });
    if (!tr.ok) throw new Error(`token server: HTTP ${tr.status} — is \`npm run servers\` running?`);
    const { jwt } = await tr.json();
    if (!jwt) throw new Error('token server returned no jwt');
    console.log(`[x2] got JWT (${jwt.length} chars)`);

    step = 'connect()';
    notify('connecting…');
    console.log(`[x2] connecting — model "${MODEL_NAME}"`);
    await m.connect(jwt);

    // The meter is running from here, so arm the backstops before anything else.
    startedAt = Date.now();
    timer = setTimeout(() => { void stopBroadcast('hard timeout'); }, timeoutMs);
    ticker = setInterval(() => {
      const s = elapsedSeconds();
      console.log(`[x2] session ${s}s / ${timeoutMs / 1000}s budget`);
      notify(`live — ${s}s`);
    }, TICK_MS);
    console.log(`[x2] CONNECTED, session ${m.getSessionId?.() ?? '(id n/a)'} ` +
      `— billing started, hard timeout ${timeoutMs / 1000}s`);

    // 2. WAIT FOR THE TRANSPORT. connect() returning is not the same as being able to publish.
    step = 'waiting for status "ready"';
    notify('waiting for transport…');
    await waitForReady(m);
    console.log('[x2] transport ready');

    // 3. SOURCE — publish the orbit canvas before anything can generate from it
    step = 'publishSource()';
    const track = sourceCanvas.captureStream(FPS).getVideoTracks()[0];
    if (!track) throw new Error('no video track from the spectator canvas');
    await m.publishSource(track);
    console.log(`[x2] source published at ${FPS}fps (${sourceCanvas.width}x${sourceCanvas.height})`);
    notify('source published');

    // 4. REFERENCE — one image, fixed for the whole match
    step = 'uploadFile + setReferenceImage()';
    const blob = await fetch(REFERENCE_URL).then((x) => x.blob());
    const reference_image = await m.uploadFile(blob, { name: 'room.jpg' });
    await m.setReferenceImage({ reference_image });
    console.log(`[x2] reference set (${(blob.size / 1024) | 0}KB)`);
    notify('reference set');

    // 5. PROMPT LAST — generation, and the generation bill, starts on this line
    step = 'setPrompt()';
    await m.setPrompt({ prompt: PROMPT });
    console.log('[x2] prompt set — generation starts now');
    return m;
  } catch (e) {
    // Name the step. Without this a token-server 502 and a rejected model slug look identical.
    console.error(`[x2] FAILED during "${step}":`, e);
    await stopBroadcast(`failed during ${step}`);
    // After stopBroadcast, so its "disconnected" status does not overwrite the real reason.
    notify(`failed at ${step} — ${e?.message || e}`);
    throw e; // no retry wrapper — if it breaks we want to see it now
  }
}
