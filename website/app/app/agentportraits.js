/* Static portrait thumbnails. Crop transparent master padding once per sprite set,
   reuse the same result across crew and COMMS, and never touch the world sprite. */
'use strict';
const AgentPortraits = (() => {
  const cache = new Map();
  function crop(set) {
    if (cache.has(set)) return cache.get(set);
    const promise = new Promise(resolve => {
      const source = new Image();
      source.onload = () => {
        const cv = document.createElement('canvas'); cv.width = source.naturalWidth; cv.height = source.naturalHeight;
        const ctx = cv.getContext('2d'); ctx.drawImage(source, 0, 0);
        const pixels = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let left = cv.width, top = cv.height, right = -1, bottom = -1;
        for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
          if (pixels[(y * cv.width + x) * 4 + 3] <= 16) continue;
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        if (right < left) { resolve(null); return; }
        const out = document.createElement('canvas'); out.width = right - left + 1; out.height = bottom - top + 1;
        out.getContext('2d').drawImage(cv, left, top, out.width, out.height, 0, 0, out.width, out.height);
        resolve(out.toDataURL());
      };
      source.onerror = () => { cache.delete(set); resolve(null); };
      source.src = 'assets/sprites/' + set + '/rot_south.png';
    });
    cache.set(set, promise); return promise;
  }
  function paint(img, agent) {
    if (!img) return;
    const skins = typeof DATA !== 'undefined' ? DATA.SKINS : null;
    const skin = agent && skins && ((agent.id === 'ULTRON' && skins.ultron) || skins[agent.skin] || skins[DATA.DEFAULT_SKIN]);
    const set = skin && skin.set;
    if (!set) { delete img.dataset.portraitSet; img.hidden = true; return; }
    if (img.dataset.portraitSet === set) return;
    img.dataset.portraitSet = set; img.hidden = true;
    crop(set).then(src => {
      if (img.dataset.portraitSet !== set || !img.isConnected) return;
      if (src) { img.src = src; img.hidden = false; }
      else delete img.dataset.portraitSet;
    });
  }

  /* ---------- the station body at NATIVE resolution (the dossier portrait's pipeline, shared) ----------
     Moved here from stationui.js drawPortrait (which now calls it) so every surface that shows an agent draws
     the SAME figure the floor renders — SPRITES.drawBody, its own frame choice and foot anchor — instead of a
     letter or a second crop of a PNG. drawBody draws at the FLOOR scale; 1/bodyScale cancels it so the 92px
     master lands 1:1 in the buffer (asked of the engine, never re-derived), then the drawn body's real bounds
     (alpha > 16) are measured so a fit ignores the master's transparent padding. Returns the shared buffer and
     the bounds — callers copy what they need before the next call reuses it. */
  let buf = null;
  function renderBody(a, nowMs) {
    if (!a || typeof SPRITES !== 'object' || !SPRITES || !SPRITES.ready || !SPRITES.isSkinReady(a.skin)) return null;
    const BW = 220, BH = 220;
    if (!buf) buf = document.createElement('canvas');
    buf.width = BW; buf.height = BH;
    const bctx = buf.getContext('2d', { willReadFrequently: true });
    bctx.clearRect(0, 0, BW, BH);
    bctx.imageSmoothingEnabled = false;   // the blit below is 1:1; keep it exact
    bctx.save();
    bctx.translate(BW / 2, BH - 40);
    // 1/sc makes drawBody's own `dw = frame.width * sc` resolve to frame.width — an exact, unresampled
    // 1:1 blit of the master. A missing/zero scale falls back to the old 3× rather than dividing by zero.
    const sc = (typeof SPRITES.bodyScale === 'function') ? SPRITES.bodyScale({ id: a.id, skin: a.skin }) : 0;
    bctx.scale(sc > 0 ? 1 / sc : 3, sc > 0 ? 1 / sc : 3);
    SPRITES.drawBody(bctx, { id: a.id, skin: a.skin, px: 0, py: 0, dir: 'south', color: a.color, state: 'idle', sitting: false, working: false, phase: 0, noShadow: true }, nowMs);
    bctx.restore();
    const d = bctx.getImageData(0, 0, BW, BH).data;
    let minX = BW, minY = BH, maxX = 0, maxY = 0, any = false;
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      if (d[(y * BW + x) * 4 + 3] > 16) { any = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (!any) return null;
    return { canvas: buf, minX, minY, sw: maxX - minX + 1, sh: maxY - minY + 1 };
  }

  /* ---------- SKIN THUMBS (2026-09-24, Andrew: "agents need to be shown by their skin, not a letter") ----------
     thumbHTML(agent, w, h, cls) is the small-size path every Workflow surface (Who works here?, the strip, the
     trigger rows, the step-test log, the crate card) uses. It is a STRING (those surfaces repaint by innerHTML
     on many events), so once an agent's thumb exists a repaint costs a Map lookup — the portrait pipeline runs
     once per skin, and the finished image once per skin + size + device scale.

     Resolution law (the dossier portrait's, applied at thumb size): the backing image is the box in DEVICE px
     (css × devicePixelRatio × TEXT SIZE body zoom), so the browser never resamples it. Inside it:
       · the body fits at an INTEGER nearest-neighbour factor when that fills the box well (≥ 75%) — crisp,
         chunky pixels, the intended look;
       · otherwise it is NN-prescaled to the next whole factor and then SMOOTH-DOWNSCALED to fit ("sharp
         bilinear"): the blend is confined to the seams between art pixels, never a bilinear blow-up of the
         sprite (that is what made the white blobs);
       · a box smaller than the art is a plain smooth DOWNSCALE — the floor draw's own law, never an NN crush.
     A skin that is not loaded yet shows a neutral silhouette (never a letter), asks SPRITES.ensureSkin, and every
     placeholder for it swaps in place when the art lands — no panel repaint needed. */
  const THUMB_FILL = 0.75;
  function fitPlan(sw, sh, W, H) {
    const t = Math.min(W / sw, H / sh);
    if (!(t > 0) || !isFinite(t)) return null;
    if (t >= 1) {
      const k = Math.floor(t);
      if (k / t >= THUMB_FILL) return { mode: 'nn', pre: k, dw: sw * k, dh: sh * k };
      const pre = k + 1;
      return { mode: 'sharp', pre, dw: Math.max(1, Math.round(sw * t)), dh: Math.max(1, Math.round(sh * t)) };
    }
    return { mode: 'smooth', pre: 1, dw: Math.max(1, Math.round(sw * t)), dh: Math.max(1, Math.round(sh * t)) };
  }
  const crops = new Map();     // body key -> { cv, sw, sh } (the native-res body, copied out of the shared buffer)
  const thumbs = new Map();    // body key @ w×h @ device scale -> PNG data URL
  const pending = new Map();   // body key -> agent (a skin still loading)
  let retryTimer = 0, retries = 0;
  function bodyKey(a) { return String((a && a.id === 'ULTRON') ? 'ULTRON' : ((a && a.skin) || (typeof DATA !== 'undefined' && DATA.DEFAULT_SKIN) || 'default')).replace(/[^\w.-]/g, '_'); }
  function devScale() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const z = (typeof U !== 'undefined' && U.uiZoom) ? U.uiZoom() : 1;
    return Math.max(1, Math.round(dpr * z * 100) / 100);
  }
  function cropOf(a) {
    const bk = bodyKey(a);
    if (crops.has(bk)) return crops.get(bk);
    // t = 0 and phase 0: one stable idle frame, so a thumb never changes between repaints
    const r = renderBody(a, 0);
    if (!r) return null;
    const cv = document.createElement('canvas'); cv.width = r.sw; cv.height = r.sh;
    cv.getContext('2d').drawImage(r.canvas, r.minX, r.minY, r.sw, r.sh, 0, 0, r.sw, r.sh);
    const c = { cv, sw: r.sw, sh: r.sh };
    crops.set(bk, c);
    return c;
  }
  function thumbURL(a, w, h) {
    const dev = devScale(), key = bodyKey(a) + '@' + w + 'x' + h + '@' + dev;
    if (thumbs.has(key)) return thumbs.get(key);
    const c = cropOf(a);
    if (!c) return null;
    const W = Math.max(1, Math.round(w * dev)), H = Math.max(1, Math.round(h * dev));
    const pad = Math.max(1, Math.round(2 * dev));   // the figure never kisses the well's edge
    const fp = fitPlan(c.sw, c.sh, W - pad * 2, H - pad * 2);
    if (!fp) return null;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const o = out.getContext('2d');
    let src = c.cv;
    if (fp.pre > 1) {   // integer NN prescale — the only upscale pixel art may take
      const up = document.createElement('canvas'); up.width = c.sw * fp.pre; up.height = c.sh * fp.pre;
      const u = up.getContext('2d'); u.imageSmoothingEnabled = false; u.drawImage(c.cv, 0, 0, up.width, up.height);
      src = up;
    }
    o.imageSmoothingEnabled = fp.mode !== 'nn';   // 'nn' is an exact 1:1 copy of the prescale; the others DOWNSCALE
    if (o.imageSmoothingEnabled && 'imageSmoothingQuality' in o) o.imageSmoothingQuality = 'high';
    // feet on the well's floor (the crew rail's framing), centred; integer origin — a half pixel re-blurs it
    o.drawImage(src, 0, 0, src.width, src.height, Math.round((W - fp.dw) / 2), H - pad - fp.dh, fp.dw, fp.dh);
    const url = out.toDataURL();
    thumbs.set(key, url);
    return url;
  }
  const SIL = '<svg class="agt-sil" viewBox="0 0 16 20" aria-hidden="true"><path d="M8 2.2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM3.2 19v-4.6c0-2.4 2-4.3 4.8-4.3s4.8 1.9 4.8 4.3V19z"/></svg>';
  const escA = s => (typeof U !== 'undefined' ? U : require('../js/util.js')).esc(s);
  function inner(url, w, h) { return url ? '<img src="' + url + '" width="' + w + '" height="' + h + '" alt="" draggable="false">' : SIL; }
  function thumbHTML(a, w, h, cls) {
    w = Math.max(8, Math.round(+w || 34)); h = Math.max(8, Math.round(+h || 42));
    const url = a ? thumbURL(a, w, h) : null;
    if (a && !url) want(a);
    // the box is sized so it covers a WHOLE number of device pixels (css × dpr × body zoom) — the image is exactly that
    // many pixels, so it lands 1:1 instead of being resampled by a fraction of a pixel
    const dev = devScale(), bw = Math.round(w * dev) / dev, bh = Math.round(h * dev) / dev;
    return '<span class="agt' + (cls ? ' ' + escA(cls) : '') + (url ? '' : ' agt-wait') + '" style="width:' + +bw.toFixed(3) + 'px;height:' + +bh.toFixed(3) + 'px"'
      + (a ? ' data-agt="' + escA(bodyKey(a)) + '" data-agt-w="' + w + '" data-agt-h="' + h + '"' : '') + ' aria-hidden="true">' + inner(url, w, h) + '</span>';
  }
  // fill every silhouette still waiting on this skin, wherever it is in the document. False = not drawable yet (a
  // set can report loaded a beat before its first frame draws) — the caller schedules a retry.
  function flush(bk) {
    const a = pending.get(bk);
    if (!a || typeof document === 'undefined') return true;
    if (!cropOf(a)) return false;
    pending.delete(bk);
    document.querySelectorAll('.agt.agt-wait[data-agt="' + bk + '"]').forEach(n => {
      const w = +n.dataset.agtW, h = +n.dataset.agtH, url = thumbURL(a, w, h);
      if (url) { n.innerHTML = inner(url, w, h); n.classList.remove('agt-wait'); }
    });
    return true;
  }
  function want(a) {
    const bk = bodyKey(a);
    if (pending.has(bk)) return;
    pending.set(bk, { id: a.id, skin: a.skin, color: a.color });
    if (typeof SPRITES === 'object' && SPRITES && SPRITES.ready && typeof SPRITES.ensureSkin === 'function') {
      SPRITES.ensureSkin(a.skin).then(ok => { if (!ok || !flush(bk)) schedule(); }, schedule);
    } else schedule();
  }
  // SPRITES not initialised yet (early boot): retry on a bounded backoff until the engine can load the skin
  function schedule() {
    if (retryTimer || retries > 40 || typeof setTimeout === 'undefined') return;
    retryTimer = setTimeout(() => {
      retryTimer = 0; retries++;
      for (const [bk, a] of Array.from(pending)) {
        if (typeof SPRITES === 'object' && SPRITES && SPRITES.ready) {
          if (SPRITES.isSkinReady(a.skin)) flush(bk);   // a false here stays pending: the loop below re-arms
          else SPRITES.ensureSkin(a.skin).then(ok => { if (ok) flush(bk); }, () => {});
        }
      }
      if (pending.size) schedule(); else retries = 0;
    }, Math.min(2000, 150 * (retries + 1)));
  }
  return { paint, renderBody, thumbHTML, fitPlan, _thumbKeys: () => Array.from(thumbs.keys()) };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = AgentPortraits;
