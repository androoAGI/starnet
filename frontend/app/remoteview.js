/* AGENT OS — remoteview.js : the picture of this station that a paired phone sees.

   Agent OS Remote's phone app has a STATION view. The station is drawn by THIS page (the sidecar has no
   renderer), so this page draws it: World.renderStill() runs the real scene pass — floor, walls, props, the
   crew where they really stand, light — onto an offscreen canvas framed on the whole station, and the still is
   handed to the sidecar (POST /api/remote/view), which passes it to the phone over the sealed channel.

   WHEN IT DRAWS (an idle station does no extra work):
     · GET /api/remote/view says whether Remote is on and whether a phone is looking right now.
     · Remote off: nothing is drawn; it looks again once a minute.
     · Remote on: one picture when the floor is up (so a phone that opens later has something, stamped with its
       age), then a fresh one every few seconds only while a phone is looking. A station that is slow to draw
       is drawn less often, so the phone's picture never makes the desk stutter.

   TRUTH RULE: the picture is whatever the real renderer drew at that moment, stamped by the sidecar with the
   time it arrived. Nothing is staged for the phone, and the phone shows the picture's age.

   Plain init()/reset(), never emits, fail-open (a failed draw or upload changes nothing). */
'use strict';
const RemoteView = (() => {
  const IDLE_MS = 60000;      // Remote is off: look again this often
  const WATCH_MS = 6000;      // Remote is on, nobody looking
  const LIVE_MS = 12000;      // a phone is looking: redraw the room this often (the crew move on their own stream)
  const CREW_MS = 200;        // a phone is looking: where the crew are, this often
  const CREW_KEEPALIVE_MS = 2000;
  const SLOWEST_MS = 20000;   // …and never slower than this, however heavy the station
  const MAX_PX = 2200;        // longest side of the still (sharp enough to zoom into on a phone)
  let timer = null, busy = false, sentOnce = false, started = false;
  let lastData = '', stillScale = 0, crewTimer = null, crewUntil = 0, crewBusy = false, lastCrew = '', lastCrewAt = 0;

  const hasWorld = () => typeof World !== 'undefined' && World && typeof World.renderStill === 'function';

  async function getJson(url) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) return null; return (await r.json()) || null; }
    catch (_) { return null; }
  }

  function blobOf(canvas, type, q) {
    return new Promise((resolve) => { try { canvas.toBlob((b) => resolve(b || null), type, q); } catch (_) { resolve(null); } });
  }
  function base64Of(blob) {
    return new Promise((resolve) => {
      try {
        const fr = new FileReader();
        fr.onload = () => { const s = String(fr.result || ''); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
        fr.onerror = () => resolve('');
        fr.readAsDataURL(blob);
      } catch (_) { resolve(''); }
    });
  }
  // WebP where the engine can write it (small, sharp pixel art); JPEG otherwise. Never a multi-megabyte PNG.
  async function encode(canvas) {
    let blob = await blobOf(canvas, 'image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') blob = await blobOf(canvas, 'image/jpeg', 0.85);
    if (!blob || !/^image\/(webp|jpeg)$/.test(blob.type)) return null;
    const data = await base64Of(blob);
    return data ? { mime: blob.type, data } : null;
  }

  async function draw() {
    if (!hasWorld()) return false;
    let still = null;
    // A page that has not drawn a frame yet (a background tab) does not know how its crew look yet: one small
    // throwaway still WITH the crew draws each of them once, so the crew stream has something true to send.
    try { if (typeof World.crewFrames === 'function' && !(World.crewFrames() || []).length) World.renderStill(400); } catch (_) {}
    // the room WITHOUT the crew: the phone draws them itself from the crew stream, so they move smoothly
    try { still = World.renderStill(MAX_PX, { noBodies: true }); } catch (_) { still = null; }
    if (!still || !still.canvas) return false;
    const enc = await api._internals.encode(still.canvas);
    if (!enc) return false;
    // the same room as last time: nothing to send (the phone keeps the picture it has, and nothing is re-downloaded)
    // …unless the server no longer HOLDS that picture (a sidecar restart): then its "same" answers not-ok and the full
    // still goes up below, instead of every later step re-posting "same" while the phone gets no picture at all
    if (enc.data === lastData && stillScale) {
      let held = true;
      try { const r0 = await fetch('/api/remote/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ same: true }) }); held = !!(r0 && r0.ok); } catch (_) {}
      if (held) return true;
      lastData = null; stillScale = 0;
    }
    try {
      const r = await fetch('/api/remote/view', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mime: enc.mime, w: still.width, h: still.height, scale: Number(still.scale) || 0, bodies: still.bodies || [], crewFree: true, data: enc.data }) });
      if (r && r.ok) { stillScale = Number(still.scale) || 0; lastData = enc.data; }
      return !!(r && r.ok);
    } catch (_) { return false; }
  }

  /* THE CREW STREAM: while a phone is looking, where each agent is and which drawing of theirs the stage is
     showing (World.crewFrames), in the still's pixels. A few hundred bytes, five times a second. */
  function crewNow() {
    if (!hasWorld() || typeof World.crewFrames !== 'function' || !stillScale) return null;
    const k = stillScale, r1 = (v) => Math.round(v * k * 10) / 10;
    let list = [];
    try { list = World.crewFrames() || []; } catch (_) { return null; }
    return list.map(b => ({ agentId: b.agentId, key: b.key, idx: b.idx, x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h), at: b.at || 0, walking: !!b.walking, working: !!b.working }));
  }
  async function sendCrew() {
    if (crewBusy) return;
    const bodies = crewNow();
    if (!bodies) return;
    // the stage draws no frames while its window is hidden or minimized: the crew are frozen there, so say so
    const t = performance.now(), newest = bodies.reduce((m, b) => Math.max(m, b.at || 0), 0), paused = !newest || t - newest > 3000;
    for (const b of bodies) delete b.at;
    const json = JSON.stringify(bodies) + (paused ? '|p' : ''), now = Date.now();
    if (json === lastCrew && now - lastCrewAt < CREW_KEEPALIVE_MS) return;   // nothing moved: say so only now and then
    crewBusy = true;
    try {
      const r = await fetch('/api/remote/view/crew', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bodies, paused }) });
      if (r && r.ok) { lastCrew = json; lastCrewAt = now; }
    } catch (_) { /* the next beat tries again */ }
    finally { crewBusy = false; }
  }
  function crewWhileWanted() {
    crewUntil = Date.now() + LIVE_MS + 4000;
    if (crewTimer) return;
    crewTimer = setInterval(() => {
      if (Date.now() > crewUntil) { clearInterval(crewTimer); crewTimer = null; return; }
      sendCrew();
    }, CREW_MS);
  }

  // one look at the station's answer, maybe one picture; returns how long to wait before the next look
  async function step() {
    const s = await getJson('/api/remote/view');
    if (!s || !s.enabled) { sentOnce = false; return IDLE_MS; }
    let cost = 0;
    if (s.want || !sentOnce || !s.at) { const t0 = performance.now(); if (await draw()) sentOnce = true; cost = performance.now() - t0; }
    if (s.want) crewWhileWanted();
    // a big station takes longer to draw: never spend more than about a fifteenth of the desk's time on the phone's picture
    return s.want ? Math.max(LIVE_MS, Math.min(SLOWEST_MS, Math.round(cost * 15))) : WATCH_MS;
  }

  function schedule(ms) { if (timer) clearTimeout(timer); timer = setTimeout(tick, ms); }
  async function tick() {
    timer = null;
    if (busy) return;
    busy = true;
    let next = WATCH_MS;
    try { next = await step(); } catch (_) { next = WATCH_MS; }
    finally { busy = false; }
    if (started) schedule(next);
  }

  function init() {
    if (started) return;
    started = true;
    schedule(4000);   // after the floor is up and the first frames have drawn
  }
  function reset() { started = false; sentOnce = false; stillScale = 0; lastData = ''; if (timer) { clearTimeout(timer); timer = null; } if (crewTimer) { clearInterval(crewTimer); crewTimer = null; } }

  const api = { init, reset, _internals: { step, draw, encode, crewNow, sendCrew, IDLE_MS, WATCH_MS, LIVE_MS, CREW_MS } };
  return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RemoteView };
