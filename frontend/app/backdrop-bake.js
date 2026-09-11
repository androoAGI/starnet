/* Procedural artwork is CPU work. Keep at most one bake running and one latest request
   queued per renderer; resizing must not accumulate a queue of obsolete large canvases. */
const BackdropBake = (() => {
  const url = new URL('backdrop-bake-worker.js', document.currentScript.src);
  const lanes = new Map();
  let sequence = 0;
  function release(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) { value.close(); return; }
    for (const child of Object.values(value)) release(child, seen);
  }
  function cancel(kind) {
    const lane = lanes.get(kind);
    if (lane) { clearTimeout(lane.timer); lane.active = lane.queued = null; lane.worker?.terminate(); lanes.delete(kind); }
  }
  function request(kind, key, params, accept) {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
    let lane = lanes.get(kind);
    if (lane?.failed) return false;
    if (!lane) {
      lane = { worker: null, active: null, queued: null, failed: false };
      const fail = () => {
        clearTimeout(lane.timer); lane.failed = true; lane.worker?.terminate();
        lane.active = lane.queued = null;
      };
      try {
        lane.worker = new Worker(url);
        lane.worker.onerror = e => { e.preventDefault(); fail(); };
        lane.worker.onmessage = ({ data }) => {
          if (!lane.active || data.token !== lane.active.token) { release(data); return; }
          clearTimeout(lane.timer);
          const completed = lane.active;
          lane.active = null;
          if (data.failed) { release(data); fail(); return; }
          // The consumer checks scene identity; an intermediate view can still cover a pan
          // while the newest view bakes. Dropping every intermediate reply would starve motion.
          try { completed.accept(data); } catch (_) { release(data); fail(); }
          if (lane.queued && !lane.failed) { const next = lane.queued; lane.queued = null; send(next); }
        };
      } catch (_) { fail(); }
      lanes.set(kind, lane);
      function send(job) {
        lane.active = job;
        lane.timer = setTimeout(fail, 20000);
        try { lane.worker.postMessage({ ...job.params, kind, token: job.token }); } catch (_) { fail(); }
      }
      lane.send = send;
    }
    if (lane.failed) return false;
    if (lane.active?.key === key) { lane.queued = null; return true; }
    if (lane.queued?.key === key) return true;
    const job = { key, params, accept, token: ++sequence };
    if (lane.active) lane.queued = job;
    else lane.send(job);
    return !lane.failed;
  }
  return { request, cancel, release,
    _dbgState: () => Array.from(lanes, ([kind, lane]) => ({ kind, busy: !!lane.active, queued: !!lane.queued, failed: lane.failed })) };
})();
