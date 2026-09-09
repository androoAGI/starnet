/* Keep real backdrop rendering off the interaction thread. Unsupported workers fall back
   to the existing renderer; late replies never paint into a replacement or closed window. */
const BackdropPreview = (() => {
  const scriptUrl = document.currentScript?.src || new URL('app/backdrop-preview.js', location.href).href;
  let worker = null, unavailable = false, sequence = 0;
  const pending = new Map();
  function fail() {
    unavailable = true;
    if (worker) worker.terminate();
    worker = null;
    for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(false); }
    pending.clear();
  }
  function paint(canvas, id) {
    if (unavailable || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return Promise.resolve(false);
    try {
      if (!worker) {
        worker = new Worker(new URL('backdrop-preview-worker.js', scriptUrl));
        worker.onerror = event => { event.preventDefault(); fail(); };
        worker.onmessage = ({ data }) => {
          const item = pending.get(data.token);
          if (!item) { data.bitmap?.close(); return; }
          pending.delete(data.token); clearTimeout(item.timer);
          let painted = !item.canvas.isConnected;
          try {
            if (data.bitmap && item.canvas.isConnected) {
              const ctx = item.canvas.getContext('2d');
              ctx.clearRect(0, 0, item.canvas.width, item.canvas.height);
              ctx.drawImage(data.bitmap, 0, 0); painted = true;
            }
          } catch (_) { painted = false; }
          finally { data.bitmap?.close(); }
          item.resolve(painted);
        };
      }
      return new Promise(resolve => {
        const token = ++sequence;
        const timer = setTimeout(() => { pending.delete(token); resolve(false); }, 8000);
        pending.set(token, { canvas, resolve, timer });
        try { worker.postMessage({ token, id, width: canvas.width, height: canvas.height,
          dpr: window.devicePixelRatio || 1, screen: { width: screen.width, height: screen.height },
          reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }); }
        catch (_) { fail(); }
      });
    } catch (_) { fail(); return Promise.resolve(false); }
  }
  return { paint };
})();
