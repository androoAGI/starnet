/* STARNET — assets.js : PixelLab sprite loading + per-agent recoloring */
'use strict';

const SPRITES = (() => {
  let ready = false;
  let loading = false;
  const frames = {};   // key "minion.walk.south" -> [Image]
  const tinted = {};   // key "FORGE|minion.walk.south" -> [canvas]
  // null means the manifest has not been planned yet. This distinction matters: World starts drawing
  // immediately while init() is still awaiting manifest.json, so an existing non-default crew skin can
  // reach loadSet() before its tracks exist. Memoizing that empty pre-init lookup as a finished set job
  // poisoned the skin for the whole page session; the default/maintainer skin still worked because init()
  // explicitly loads it after planning, and changing the affected agent to a new skin later also worked.
  let tracksBySet = null;
  const setJobs = {};
  const loadedSets = new Set();
  let meta = { minion: { fw: 0, fh: 0 }, ultron: { fw: 0, fh: 0 } };

  /* the crew base is a white space-suit astronaut with glowing CYAN visor eyes
     (~hue 190). the light suit is ~desaturated so hue-rotate barely shifts it;
     the saturated eyes are what recolor — so each agent's accent color lands on
     the eyes (their identity) while the suit stays a clean premium white. */
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (mx === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s, l };
  }
  const BASE_HUE = 190, BASE_SAT = 0.80;
  function filterFor(agentId) {
    // Skins are natively-colored sprite sets, so there is no per-agent hue-rotate.
    // (An agent's `color` still drives its name-tag / UI accents — just not the sprite.)
    return '';
  }

  /* crew sprites are authored on a 92px master — far larger than their ~35px on-floor footprint.
     We DON'T pre-shrink here any more: the old nearest-neighbor crush to ~35px dropped most of the
     master's pixels and mushed every agent into a shapeless blob (the picker, which shows the full
     master, looked far better than the floor). Instead we cache frames at NATIVE resolution and apply
     the per-set downscale at DRAW time with smoothing ON (drawBody) — full detail survives onto the
     floor at the SAME size, and stays sharp when the camera zooms in.
     ultron keeps more of his source size so he towers over the crew. */
  const SCALE = { ultron: 0.60 };   // skins read their scale from DATA.SKINS; ULTRON is special
  function drawScaleFor(setName) {
    return SCALE[setName] || (DATA.SKINS[setName] && DATA.SKINS[setName].scale) || 2 / 3;
  }
  /* The set drawBody will resolve for this body, and the scale it will draw at. Exported (bodyScale)
     because a surface that wants the master at its NATIVE resolution — the dossier portrait, which is a
     still, not a floor body — has to cancel this scale out exactly. Re-deriving it in the UI would drift
     the moment ULTRON, a new set, or the DATA.SKINS fallback changed; asking the engine cannot. */
  function setForBody(b) {
    return (b && b.id === 'ULTRON') ? 'ultron'
      : ((DATA.SKINS[b && b.skin] && DATA.SKINS[b.skin].set) || DATA.SKINS[DATA.DEFAULT_SKIN].set);
  }
  function bodyScale(b) { return drawScaleFor(setForBody(b)); }

  /* foot-line measurement — every PixelLab master leaves transparent padding BELOW the feet
     (the crew sets all sit ~23px up from the 92px canvas bottom). The contact shadow is drawn
     at the floor anchor (b.py), so if we anchored the IMAGE bottom there, that padding pushed
     the visible feet up off the shadow — and because the gap is `pad × scale`, the bigger skins
     (and ULTRON) floated worst. We measure the padding once per set from a STABLE idle frame
     (rot/blink/sit — never a walk frame, whose lifted foot would shift the body each stride) and
     anchor the FEET to the floor instead. Auto-derived so new skins self-correct. */
  const footPad = {};                 // set -> transparent rows below the feet, in master px
  const DEFAULT_FOOT = 23;            // crew authoring constant; only used if a frame can't be read
  function measureFootPad(img) {
    try {
      const w = img.width | 0, h = img.height | 0;
      if (!w || !h) return DEFAULT_FOOT;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const data = x.getImageData(0, 0, w, h).data;
      for (let y = h - 1; y >= 0; y--) {
        const row = y * w * 4;
        for (let px = 0; px < w; px++) {
          if (data[row + px * 4 + 3] > 16) return (h - 1) - y;   // first opaque row from the bottom
        }
      }
      return DEFAULT_FOOT;
    } catch (e) { return DEFAULT_FOOT; }   // tainted/unreadable → safe fallback
  }
  /* ---------- how far one walk CYCLE carries the body ----------
     The walk is distance-phased, so this number decides whether the feet plant or skate: if the
     body covers more ground per cycle than the animation's legs actually swing, every foot slides.
     It used to be `drawnHeight × 0.56` for everyone, which assumes every character's legs swing the
     same fraction of its height. They don't — measured across the roster the true figure lands
     between 0.58 and 1.0 of that, so most skins were over-striding by about a third.
     Derive it per set instead, from the set's OWN side view: at full extension the span across the
     foot band is one step (leading foot to trailing foot), and a cycle is two steps. Side views
     only — front and back foreshorten the swing to nothing.
     Sets whose feet never separate (pikachu, capybara — wide-stance animals whose walk is a bob,
     not a stride) have no step length to read, so they keep the old constant rather than being
     handed a fabricated one. */
  const CYCLE_PER_HEIGHT = 0.56;   // fallback when a set's swing can't be measured
  const cycleCache = {};
  function bandGap(img, lo) {
    try {
      const w = img.width | 0, h = img.height | 0;
      if (!w || !h) return null;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, w, h).data;
      let top = -1, bot = -1, minX = w, maxX = -1;
      for (let y = 0; y < h; y++) {
        for (let px = 0; px < w; px++) {
          if (d[(y * w + px) * 4 + 3] > 16) { if (top < 0) top = y; bot = y; break; }
        }
      }
      if (top < 0) return null;
      const band = Math.floor(bot - (bot - top) * (lo || 0.16));
      for (let y = band; y <= bot; y++) {
        for (let px = 0; px < w; px++) {
          if (d[(y * w + px) * 4 + 3] > 16) { if (px < minX) minX = px; if (px > maxX) maxX = px; }
        }
      }
      return maxX < minX ? null : (maxX - minX + 1);
    } catch (e) { return null; }   // tainted/unreadable → caller falls back
  }
  function cycleUnitsFor(set, sc, frameH) {
    if (cycleCache[set] != null) return cycleCache[set];
    const fallback = frameH * sc * CYCLE_PER_HEIGHT;
    const side = frames[set + '.walk.east'] || frames[set + '.walk.west'];
    const idleFr = frames[set + '.rot.east'] || frames[set + '.rot.west'];
    let out = fallback;
    if (side && side.length && idleFr && idleFr[0]) {
      const idle = bandGap(idleFr[0]);
      let widest = 0;
      for (const f of side) { const g = bandGap(f); if (g && g > widest) widest = g; }
      // a real stride has to open the feet WIDER than standing; below that there is no swing to read
      if (idle && widest && widest - idle >= 3) {
        const measured = 2 * widest * sc;
        // never trust the measurement past a sane window — a stray pixel must not halve the gait
        out = Math.max(fallback * 0.5, Math.min(fallback, measured));
      }
    }
    return (cycleCache[set] = out);
  }

  /* per-TRACK content-bottom padding, for the seat perch: the set-level footPad is measured off a
     STANDING frame, but a sit frame carries its own (often larger) transparent margin below the tucked
     legs — anchoring skeleton's sit by its standing pad hung the body in the air above the stool pad
     (Andrew, 2026-08-10). Measured once per key from the frame that will actually be drawn. */
  const trackPad = {};
  function getTrackPad(key) {
    if (trackPad[key] != null) return trackPad[key];
    const fr = frames[key];
    return (trackPad[key] = (fr && fr[0]) ? measureFootPad(fr[0]) : DEFAULT_FOOT);
  }
  function getFootPad(set) {
    if (footPad[set] != null) return footPad[set];
    let ref = null;
    for (const d of ['south', 'east', 'west', 'north']) {
      const fr = frames[set + '.rot.' + d] || frames[set + '.blink.' + d] || frames[set + '.sit.' + d];
      if (fr && fr[0]) { ref = fr[0]; break; }
    }
    if (!ref) {   // last resort: any frame of the set
      const k = Object.keys(frames).find(kk => kk.indexOf(set + '.') === 0);
      if (k && frames[k][0]) ref = frames[k][0];
    }
    return (footPad[set] = ref ? measureFootPad(ref) : DEFAULT_FOOT);
  }
  function tintFrames(agentId, key) {
    const ck = agentId + '|' + key;
    if (tinted[ck]) return tinted[ck];
    const src = frames[key];
    if (!src) return null;
    const filt = filterFor(agentId);
    tinted[ck] = src.map(img => {
      if (!filt) return img;   // no recolor (skins are natively colored) → use the master image directly, full res
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.filter = filt;
      x.drawImage(img, 0, 0);
      return c;
    });
    return tinted[ck];
  }

  /* Local light is optional presentation data; it never selects a pose or changes game state.
     drawBody's fourth argument is { reducedMotion, skipGroundShadow,
       light: { color: [r,g,b], strength, dx, dy } }.
     skipGroundShadow lets the scene own its wall-clipped cast/contact pass without doubling it;
     authored emissive spill, such as ULTRON's red pool, stays part of the skin's presentation.
     Direction points FROM the body TOWARD the source in world axes. Quantize small changes before
     caching at native sprite resolution, shared across agents. No scene readback or canvas filter.
     The 128-frame LRU bounds GPU/bitmap storage even when the whole skin catalog is in view. */
  const BODY_LIGHT_LIMIT = 128;
  const bodyLights = new Map(), frameIds = new WeakMap();
  let nextFrameId = 1, bodyLightScratch = null, bodyLightBuilds = 0;
  const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));
  function bodyLight(raw) {
    if (!raw || !Array.isArray(raw.color) || raw.color.length < 3) return null;
    const strength = Math.round(clamp01(raw.strength) * 6) / 6;
    if (!strength) return null;
    const color = raw.color.slice(0, 3).map(n =>
      Math.min(255, Math.round(Math.max(0, Math.min(255, Number(n) || 0)) / 24) * 24));
    const dx = Number(raw.dx), dy = Number(raw.dy);
    const angle = Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) > 0.001
      ? Math.atan2(dy, dx) : -2.2;
    const sector = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    return { color, strength, dx: Math.cos(sector * Math.PI / 4), dy: Math.sin(sector * Math.PI / 4),
      key: color.join(',') + '|' + strength + '|' + sector };
  }
  function releaseBodyLight(canvas) { canvas.width = canvas.height = 1; }
  function lightFrame(frame, light) {
    if (!light) return frame;
    let id = frameIds.get(frame);
    if (!id) { id = nextFrameId++; frameIds.set(frame, id); }
    const key = id + '|' + light.key;
    const hit = bodyLights.get(key);
    if (hit) {
      const context = hit.getContext('2d');
      if (context && !(context.isContextLost && context.isContextLost())) {
        bodyLights.delete(key); bodyLights.set(key, hit);
        return hit;
      }
      bodyLights.delete(key); releaseBodyLight(hit);
    }
    let canvas;
    try {
      const w = frame.width | 0, h = frame.height | 0;
      if (!w || !h || w * h > 262144) return frame;
      canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d');
      if (!g || (g.isContextLost && g.isContextLost())) { releaseBodyLight(canvas); return frame; }
      g.drawImage(frame, 0, 0);
      const cx = w / 2, cy = h * 0.43, reach = Math.max(w, h) * 0.43;
      const ramp = g.createLinearGradient(cx - light.dx * reach, cy - light.dy * reach,
        cx + light.dx * reach, cy + light.dy * reach);
      ramp.addColorStop(0, 'rgba(12,20,34,' + (0.17 * light.strength) + ')');
      ramp.addColorStop(0.48, 'rgba(12,20,34,0)');
      ramp.addColorStop(1, 'rgba(' + light.color.join(',') + ',' + (0.24 * light.strength) + ')');
      // source-atop retains the master's alpha exactly, including its antialiased silhouette.
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = ramp; g.fillRect(0, 0, w, h);
      if (!bodyLightScratch) bodyLightScratch = document.createElement('canvas');
      bodyLightScratch.width = w; bodyLightScratch.height = h;
      const edge = bodyLightScratch.getContext('2d');
      if (edge && !(edge.isContextLost && edge.isContextLost())) {
        edge.drawImage(frame, 0, 0);
        edge.globalCompositeOperation = 'destination-out';
        edge.drawImage(frame, -light.dx * 1.6, -light.dy * 1.6);
        edge.globalCompositeOperation = 'source-in';
        edge.fillStyle = 'rgb(' + light.color.join(',') + ')'; edge.fillRect(0, 0, w, h);
        g.globalAlpha = 0.42 * light.strength; g.drawImage(bodyLightScratch, 0, 0);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      bodyLights.set(key, canvas); bodyLightBuilds++;
      while (bodyLights.size > BODY_LIGHT_LIMIT) {
        const oldest = bodyLights.keys().next().value;
        releaseBodyLight(bodyLights.get(oldest)); bodyLights.delete(oldest);
      }
      return canvas;
    } catch (e) {
      if (canvas) releaseBodyLight(canvas);
      return frame;  // unsupported/lost offscreen context must never hide a real crew body
    }
  }
  function bodyAppearanceStats() {
    return { cachedFrames: bodyLights.size, limit: BODY_LIGHT_LIMIT, builds: bodyLightBuilds };
  }

  /* ---------- deck contact and directional body shadow ----------
     A broad, faint penumbra reaches south-east under the north-west key. Its
     centre converges on the feet as it darkens, rather than drawing concentric
     bullseye bands. A separate compact contact core gives the body weight.
     Fixed rings avoid gradients/canvases allocated for every walking frame.
     Lift fades the contact faster than the cast shadow; seated bodies use the
     same path with their existing reduced opacity and footprint. Coloured
     activity spill remains diffuse and never acquires a dark contact core. */
  const SHADOW_RINGS = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11;
    return [1 - t * 0.82, 0.016 + t * 0.043];
  });
  const SHADOW_SQUASH = 0.38;
  function groundShadow(ctx, cx, cy, rx, opts) {
    const o = opts || {};
    const lift = Math.max(0, o.lift || 0);
    const k = 1 - Math.min(0.5, lift * 0.14);
    const spread = rx * k * (o.spread || 1);
    if (!(spread > 0.5)) return;
    const a0 = ctx.globalAlpha, ink = ctx.fillStyle;
    const fade = k * (o.alpha != null ? o.alpha : 1);
    ctx.fillStyle = o.color || '#080d19';
    try {
      for (const [radius, alpha] of SHADOW_RINGS) {
        const reach = o.color ? 0.08 : 0.48 * radius * radius;
        ctx.globalAlpha = a0 * alpha * fade * (o.color ? 1.2 : 1);
        ctx.beginPath();
        ctx.ellipse(cx + spread * reach * (o.direction ? o.direction.x : 1),
          cy + spread * reach * (o.direction ? o.direction.y : 0.62),
          spread * radius * (o.color ? 1 : 1.14), spread * radius * SHADOW_SQUASH,
          o.color ? 0 : 0.18, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!o.color) {
        // Tight occlusion under the boots, anchored to the deck through idle bob.
        ctx.globalAlpha = a0 * 0.20 * fade * k;
        ctx.beginPath();
        ctx.ellipse(cx, cy, spread * 0.42, spread * 0.115, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } finally { ctx.globalAlpha = a0; ctx.fillStyle = ink; }
  }

  /* pick best available animation key for a body state */
  function pick(set, names, dir) {
    for (const n of names) {
      const exact = set + '.' + n + '.' + dir;
      if (frames[exact]) return exact;
    }
    // fall back to any direction of first available name, then south rot
    for (const n of names) {
      for (const d of ['south', 'east', 'west', 'north']) {
        const k = set + '.' + n + '.' + d;
        if (frames[k]) return k;
      }
    }
    return frames[set + '.rot.south'] ? set + '.rot.south' : null;
  }

  /* ---------- 8-direction render facing ----------
     world.js keeps game-logic facing 4-valued (`b.dir`) — glance/sit/OPP/social all speak that
     vocabulary and must keep doing so. Smooth turning is a RENDER concern, so it lives here:
     each body carries a render-side facing angle that slews toward what the game wants (the
     continuous walk heading `b.faceA` while walking, the bucketed `dir` otherwise) at the SAME
     rate stepGait turns a walking body, then buckets into EIGHT sectors with hysteresis. A body
     turning 180° therefore walks its pose through the diagonal in ~2 steps instead of teleporting
     it, and a body that stops on a diagonal eases to its cardinal instead of popping.
     Sets that don't ship diagonal frames are untouched: pick8 falls straight back to the old
     4-dir pick on `b.dir`, so this is a no-op for every skin until its diagonals exist. */
  const DIR8_A = {
    east: 0, 'south-east': Math.PI / 4, south: Math.PI / 2, 'south-west': 3 * Math.PI / 4,
    west: Math.PI, 'north-west': -3 * Math.PI / 4, north: -Math.PI / 2, 'north-east': -Math.PI / 4
  };
  /* A turn has WEIGHT. The first pass slewed the facing at a flat rate, which is exactly a
     turntable: the pose rotated at constant angular speed and the body appeared to slide around
     its own axis ("it just perfectly spins" — Andrew, 2026-08-01). Two things fix that, and
     neither needs new art:
       1. the facing ACCELERATES and BRAKES. `_rW` is angular velocity, ramped by TURN_ACCEL and
          capped by the sqrt term so it arrives at the target with zero speed instead of stopping
          dead. Same shape as the linear speed easing stepGait already does.
       2. the feet keep the score. `_turnAng` accumulates radians actually swept, and drawBody
          spends it on WALK frames, so a pivoting body steps its legs around instead of holding a
          frozen idle pose while the sprite rotates underneath it. */
  const TURN_MAX = 9;            // rad/s ceiling — below the old flat 12 so the turn is legible
  const TURN_ACCEL = 55;         // rad/s²: spins up in ~160ms and brakes into the target
  const TURN_STEP_W = 1.2;       // rad/s a standing body must exceed before its feet shuffle
  const TURN_STEP_FRAMES = 4 / Math.PI;   // walk frames per radian swept ≈ 2 frames per 90° pivot
  const DIR8_HYST = 0.10;        // rad a sector holds past its boundary (sectors are π/8 half-width)
  const ang = a => Math.atan2(Math.sin(a), Math.cos(a));
  function renderDir8(b, dir, glancing, nowMs) {
    // while walking (and not glancing) follow the true continuous heading; otherwise the game dir
    const want = (!glancing && b.state === 'walk' && b.faceA != null) ? ang(b.faceA) : DIR8_A[dir];
    if (want == null) return dir;
    const dt = Math.max(0, Math.min(100, nowMs - (b._rAt || 0)));   // clamp: first frame / tab-restore must not spin
    b._rAt = nowMs;
    if (b._rA == null) { b._rA = want; b._rW = 0; b._turnAng = 0; }  // new body: snap, no tween
    else {
      const turn = ang(want - b._rA), remain = Math.abs(turn);
      const s = dt / 1000;
      // brake so the facing ARRIVES at rest: v = sqrt(2·a·s) is the fastest it can still stop in time
      const target = Math.min(TURN_MAX, Math.sqrt(2 * TURN_ACCEL * remain));
      const cur = b._rW || 0;
      b._rW = cur < target ? Math.min(target, cur + TURN_ACCEL * s)
                           : Math.max(target, cur - TURN_ACCEL * s);
      const swept = Math.min(remain, b._rW * s);
      b._rA = ang(b._rA + Math.sign(turn) * swept);
      b._turnAng = (b._turnAng || 0) + swept;
    }
    const cur = b._rD8;
    if (cur && DIR8_A[cur] != null && Math.abs(ang(b._rA - DIR8_A[cur])) < Math.PI / 8 + DIR8_HYST) return cur;
    let best = dir, bd = Infinity;
    for (const d in DIR8_A) {
      const t = Math.abs(ang(b._rA - DIR8_A[d]));
      if (t < bd) { bd = t; best = d; }
    }
    return (b._rD8 = best);
  }
  /* prefer the 8-bucket direction when the set ships it, else the exact old 4-dir path */
  function pick8(set, names, dir8, dir) {
    if (dir8 !== dir) {
      for (const n of names) {
        const k = set + '.' + n + '.' + dir8;
        if (frames[k]) return k;
      }
    }
    return pick(set, names, dir);
  }

  /* main draw: foot-anchored at (x, y) */
  function drawBody(ctx, b, nowMs, appearance) {
    const reduced = !!(appearance && appearance.reducedMotion);
    const light = bodyLight(appearance && appearance.light);
    const set = b.id === 'ULTRON' ? 'ultron'
      : ((DATA.SKINS[b.skin] && DATA.SKINS[b.skin].set) || DATA.SKINS[DATA.DEFAULT_SKIN].set);
    if (!loadedSets.has(set)) { loadSet(set); return null; }
    const glancing = b.glance && b.glance.until > nowMs;   // brief look-up: overrides facing & typing
    const meeting = b.meet && b.meet.until > nowMs;        // hallway chat: stand still, face partner
    const dir = glancing ? b.glance.dir : (b.dir || 'south');
    // per-agent animation offset. Prefer the FLOAT `aph`: `phase` is an integer (world.js needs it as a
    // PHASES[] index for the mood engine), and a whole-frame offset ticks every body's cycle on the same
    // 100ms boundaries — the crew animated in lockstep. Bodies without `aph` (dossier portrait) fall back.
    const aph = (b.aph != null ? b.aph : (b.phase || 0));
    // 8-sector render facing — only locomotion + standing poses use it; seated/desk states keep
    // the plain 4-dir vocabulary (their frames are cardinal-only and their facing is furniture-set)
    const dir8 = renderDir8(b, dir, glancing, nowMs);
    let key = null, fps = 8, bob = 0, turnStep = false;

    if (meeting) {
      key = pick8(set, ['rot'], dir8, dir); fps = 4;
    } else if (b.state === 'walk') {
      key = pick8(set, ['walk'], dir8, dir); fps = 10;
    } else if (b.working && !glancing) {
      key = pick(set, ['type', 'sit'], 'north') || pick(set, ['rot'], 'north'); fps = 6;
    } else if (b.state === 'social' && b.sitting) {
      // can in hand reads best from the front; otherwise face what you came for
      key = b.hasCan ? (pick(set, ['drink', 'sit'], 'south')) : pick(set, ['sit'], dir); fps = 6;
    } else if (b.sitting) {
      key = pick(set, ['sit', 'rot'], dir); fps = 4;
    } else if (b.speaking) {
      // talking out loud: prefer a dedicated talk track (open/closed mouth chatter) when the set
      // ships one — the mouth carries the speech, so keep only the gentle idle sway. Sets without
      // a talk track keep the livelier bob + 1px head bounce so speech never reads as a frozen pose.
      key = pick(set, ['talk', 'rot'], dir); fps = 6;
      bob = (key && key.indexOf('.talk.') !== -1)
        ? Math.sin(nowMs / 600 + aph) * 0.7
        : Math.sin(nowMs / 170 + aph) * 1.1 - (Math.floor(nowMs / 150) % 2 ? 1 : 0);
    } else {
      key = pick8(set, ['rot'], dir8, dir);
      bob = Math.sin(nowMs / 600 + aph) * 0.7;
      // PIVOT STEP. A standing body that changes facing used to hold a frozen idle pose while the
      // sprite rotated under it — the "it just slides round" read. Nobody turns like that; you
      // shuffle your feet. While the facing is actively sweeping, borrow the set's WALK frames and
      // spend the swept ANGLE on them, so the legs step the body around. Angle-phased, not
      // clock-phased, so the shuffle stops dead the instant the turn does.
      // NOT while glancing: a glance is a ~380ms look toward something, i.e. a HEAD turn. Letting
      // it drive the legs made a body take a full stride to look sideways and step back again.
      // The facing still eases round; only the footwork is suppressed.
      if (!glancing && (b._rW || 0) > TURN_STEP_W) {
        const wk = pick8(set, ['walk'], dir8, dir);
        if (wk) { key = wk; turnStep = true; bob *= 0.35; }
      }
    }

    // life-like idle gesture: a standing body occasionally plays its set's one-shot `gesture`
    // track (stretch / arm movement) ONCE through, then returns to the rot pose. Staggered per
    // agent like the blink so the crew never moves in unison. The index is derived from the
    // window's own progress (fixedIdx), NOT the free-running clock — a clock index would enter
    // the animation mid-cycle. Sets without a gesture track skip this entirely.
    /* This track is a STRETCH. It is fired here, on its own slow ambient clock, and nowhere else:
       an attempt to reuse it on demand (reaching for a prop, working an arcade cabinet, waving)
       was removed 2026-08-08 because a stretch played at those moments reads as a glitch. New
       meanings need new frames, not this one re-labelled. */
    let fixedIdx = null;
    if (!reduced && key && key.indexOf('.rot.') !== -1 && b.state !== 'walk'
        && !b.working && !b.sitting && !b.speaking && !meeting && !glancing) {
      // EXACT direction only — never fall back to another facing. Most sets ship the stretch
      // on the 4 cardinals alone (the diagonals would cost 4 more generations each and are
      // unreachable in practice: a body that stops walking leaves its diagonal within ~50ms
      // and holds a cardinal while idle, and only an idle body stretches). Falling back would
      // snap the body 45° for the length of the stretch — the exact class of pop this pass
      // was built to remove.
      const kd = key.slice(key.lastIndexOf('.') + 1);
      const gk = frames[set + '.gesture.' + kd] ? set + '.gesture.' + kd : null;
      if (gk) {
        const GFPS = 8, glen = frames[gk].length, gdur = glen * (1000 / GFPS);
        // a stretch is a RARE beat (Andrew, 2026-07-31): once every ~90 minutes per body,
        // not an every-cycle tic. Each body's fire-point is spread uniformly across the
        // period via its float phase, so the crew never stretches in unison — and a fresh
        // boot still sees SOMEONE stretch early rather than everyone at minute 90.
        const GESTURE_PERIOD = 5400000;
        const gph = Math.abs(aph) % (2 * Math.PI) / (2 * Math.PI);
        const gt = (nowMs + gph * GESTURE_PERIOD) % GESTURE_PERIOD;
        if (gt < gdur) {
          key = gk; fixedIdx = Math.min(glen - 1, Math.floor(gt / (1000 / GFPS)));
          bob = 0;   // the frames carry the motion; bobbing on top reads as jitter
        }
      }
    }

    // life-like idle blink: while standing on a 'rot' pose, briefly shut the eyes.
    // staggered per-agent via b.phase so the crew doesn't blink in unison.
    // keyed off the RESOLVED key's own direction (may be a diagonal): swapping to a cardinal
    // blink frame under a diagonal pose would snap the head 45° for the blink's 130ms.
    if (!reduced && key && key.indexOf('.rot.') !== -1 && b.state !== 'walk') {
      const bk = set + '.blink.' + key.slice(key.lastIndexOf('.') + 1);
      if (frames[bk]) {
        const bt = (nowMs + aph * 900) % 3300;
        if (bt < 130) key = bk;
      }
    }
    if (!key) return null;
    // the pose this body is ACTUALLY being drawn in, recorded read-only for live verification
    // (dev/idlesoak.mjs asserts a waving body resolves to a `.gesture.` track). Nothing reads it
    // to make a decision — a rendering claim has to be provable from the render, not re-derived.
    b._pose = key;

    const fr = tintFrames(b.id, key);
    if (!fr || !fr.length) return null;
    // WALK advances on DISTANCE TRAVELLED (b.odo, world units — stepGait in world.js keeps it), not the wall
    // clock. A fixed-fps cycle made every body's feet skate, because pace is NOT fixed: crew temperament tilts
    // it 0.88-1.17x and the hero (34 u/s) outruns the crew (28 u/s), so one cycle length could never fit them all.
    //
    // The cycle DISTANCE is DERIVED per set, never hardcoded, so it stays correct for any skin without retuning:
    // stride length scales with leg length (≈ the character's DRAWN height), divided by however many walk frames
    // that set actually ships. Both vary today — ULTRON walks in 4 frames at 0.60 scale while the other 38 sets
    // use 6 frames at 0.36-0.425 — and a future skin with a different frame count or size is handled for free.
    // Do NOT replace this with a constant units-per-frame: that silently over-spins short or oversized sets.
    // Every other state keeps the clock; those aren't locomotion.
    const sc = drawScaleFor(set);
    const stride = cycleUnitsFor(set, sc, fr[0].height) / fr.length;
    const idx = fixedIdx != null ? fixedIdx
      // a pivoting body spends SWEPT ANGLE on the walk cycle, the same way a travelling one spends
      // distance — the feet are driven by what the body actually did, never by the clock
      : turnStep ? Math.floor((b._turnAng || 0) * TURN_STEP_FRAMES + aph)
      : (key.indexOf('.walk.') !== -1 && b.odo != null && stride > 0)
        ? Math.floor(b.odo / stride + aph)
        : Math.floor(nowMs / (1000 / fps) + aph);
    const f = fr.length > 1 ? fr[((idx % fr.length) + fr.length) % fr.length] : fr[0];
    // footprint = native master × per-set scale → identical on-floor size as before, but f is now the
    // full-resolution master. Draw it DOWN to that size with smoothing ON so the detail survives (and
    // stays sharp if the camera zooms in, since it resamples straight from the 92px master each frame).
    const dw = f.width * sc, dh = f.height * sc;   // `sc` resolved above (the stride derivation needs it)
    // SUB-UNIT positioning. This used to be Math.round() on the raw world coordinate — i.e. a snap to integer
    // WORLD units. But the camera scales 0.5-6x (default 2), so one unit of rounding landed as a 2-6 DEVICE-pixel
    // jump, and at 34 u/s (~0.57 units per frame) the body held still for ~2 frames and then hopped a whole unit.
    // That was the loudest "sprites aren't smooth" artefact, in every direction, independent of turning. Note the
    // camera's own panX/panY were never rounded, so the world was already sub-pixel while the body alone snapped.
    // We round to the nearest DEVICE pixel instead: still crisply pixel-aligned (no resample blur at rest), but
    // sub-unit in world space, so motion is continuous. Do NOT put Math.round back on the world coordinate.
    const _m = ctx.getTransform ? ctx.getTransform() : null;
    const zs = (_m && _m.a > 0) ? _m.a : 1;
    const snap = v => Math.round(v * zs) / zs;
    const x = snap(b.px - dw / 2);
    // anchor the FEET (not the transparent image bottom) near the floor line so the contact shadow
    // reads as sitting under them. `fp` is the scaled padding below the feet; GROUND_BITE lifts the
    // feet a few px ABOVE the shadow so it shows just beneath them — flush (0/positive) looks sunk,
    // and the old image-bottom anchor left every skin hovering well above it.
    const GROUND_BITE = -3;
    // SEAT LIFT: a body seated on a raised single-tile seat (stool/chair) draws its pixels this many px
    // higher so the hips land on the seat pad — world.js's planSeat measured it off the prop art. The
    // sort key and the ground shadow deliberately stay at b.py (the seat tile's floor line): only the
    // SPRITE rises, the shadow pool remains on the deck under the stool where light actually lands.
    // Gated on the RESOLVED track actually being a sit pose: a set with no sit frames (minionchar,
    // 2026-08-10) falls back to rot/stand, and lifting a STANDING body onto the pad reads as levitation.
    const seatLift = (b.sitting && b.seatLift && key.indexOf('.sit.') !== -1) ? b.seatLift : 0;
    // perched: anchor by THIS sit frame's own bottom padding (getTrackPad), not the standing footPad —
    // sets whose sit master carries extra empty rows below the tucked legs (skeleton) otherwise float.
    const pad = (seatLift ? getTrackPad(key) : getFootPad(set)) * sc;
    // Quiet standing breath changes the torso's height by less than a quarter world unit while
    // its measured foot line stays fixed. Existing walk/pivot, furniture, sleep, talk and gesture
    // tracks own their motion. Portraits keep their established framing. Omitting appearance
    // preserves the original three-argument renderer until the caller opts into local lighting.
    const planted = !!appearance && !b.noShadow && !b.seated && !b.sitting && !b.sleeping
      && b.state !== 'sleep' && b.state !== 'walk' && !b.working && !b.speaking
      && !meeting && !glancing && !turnStep && (key.indexOf('.rot.') !== -1 || key.indexOf('.blink.') !== -1);
    if (reduced || planted) bob = 0;
    const breath = planted && !reduced ? Math.sin(nowMs / 1050 + aph) * 0.24 : 0;
    const breathScale = 1 + breath / Math.max(12, dh - pad);
    const drawHeight = dh * breathScale;
    const y = planted ? snap(b.py + GROUND_BITE - seatLift) - (dh - pad) * breathScale
      : snap(b.py - dh + GROUND_BITE + bob + pad - seatLift);
    // the pool's outer half-width, taken from the body's DRAWN footprint. Masters carry side
    // padding, so this lands well under dw/2 — a pool wider than the boots reads as a puddle.
    const shR = Math.max(4.5, dw * 0.21);
    // the contact shadow (and ULTRON's red spill) is a GROUND cue — skip it for off-floor renders
    // like the dossier portrait (b.noShadow), where there's no floor and it scales into a blocky bar.
    // NOTE: fed the RAW b.px/b.py, not the device-snapped ones. Snapping the pool while the body
    // itself is sub-unit would let the shadow tick a pixel while the feet slid smoothly over it.
    if (!b.noShadow) {
      const lift = Math.max(0, -bob);           // bob is +down; a negative bob has raised the body
      if (set === 'ultron') {
        // the station leader's menacing red spill — a wider, slower pulse beneath his own pool
        groundShadow(ctx, b.px, b.py, shR * 1.55, { lift, color: '#ff4a3d', alpha: reduced ? 0.55 : 0.55 + 0.25 * Math.sin(nowMs / 400) });
      }
      // a perched body adds its seatLift to the shadow's lift: the pool tightens + fades the higher the
      // seat, instead of claiming full floor contact the raised feet don't have
      if (!(appearance && appearance.skipGroundShadow)) {
        const shadow = b.sitting ? { lift: lift + seatLift, alpha: 0.6, spread: 0.8 } : { lift };
        if (light) shadow.direction = { x: -light.dx, y: -light.dy * 0.62 };
        groundShadow(ctx, b.px, b.py, shR, shadow);
      }
    }
    const prevSmooth = ctx.imageSmoothingEnabled;
    const prevQuality = ctx.imageSmoothingQuality;
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    try { ctx.drawImage(lightFrame(f, light), x, y, dw, drawHeight); }
    finally {
      ctx.imageSmoothingEnabled = prevSmooth;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = prevQuality;
    }
    // geometry for overlays (alert icon, bubble, selection box) — top of the visible body
    return { top: y + Math.round(drawHeight * 0.22), w: Math.round(dw * 0.6), h: drawHeight };
  }

  /* loading */
  function loadImage(path) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = path;
    });
  }

  function loadTrack(track, paths) {
    return Promise.all(paths.map(p => loadImage('assets/sprites/' + p))).then(imgs => {
      const ok = imgs.filter(Boolean);
      if (ok.length) frames[track] = ok;
      return ok.length;
    });
  }

  function loadSet(set) {
    const key = String(set || '').trim();
    if (!key) return Promise.resolve(false);
    // Do not cache a request until the manifest is ready and proves the set has tracks. drawBody calls us
    // again on the next frame, so a pre-init request naturally recovers as soon as init() installs the plan.
    if (!tracksBySet) return Promise.resolve(false);
    const tracks = tracksBySet[key] || [];
    if (!tracks.length) return Promise.resolve(false);
    if (setJobs[key]) return setJobs[key];
    setJobs[key] = Promise.all(tracks.map(([track, paths]) => loadTrack(track, paths))).then(counts => {
      const loaded = counts.reduce((n, count) => n + count, 0);
      if (loaded) loadedSets.add(key);
      return loaded > 0;
    });
    return setJobs[key];
  }

  function setForSkin(skin) {
    const catalog = (typeof DATA !== 'undefined' && DATA.SKINS) || {};
    const fallback = typeof DATA !== 'undefined' ? DATA.DEFAULT_SKIN : '';
    const picked = catalog[skin] || catalog[fallback];
    return picked && picked.set ? picked.set : '';
  }

  function ensureSkin(skin) { return loadSet(setForSkin(skin)); }
  function isSkinReady(skin) { return loadedSets.has(setForSkin(skin)); }

  async function init() {
    loading = true;
    try {
      const resp = await fetch('assets/sprites/manifest.json', { cache: 'no-store' });
      if (!resp.ok) return;
      const man = await resp.json();
      tracksBySet = SpriteLoadPlan.groupTracks(man.sprites);
      // ready when the DEFAULT skin's base pose loaded (the old `minion` astronaut set
      // was retired in favour of DATA.SKINS — gating on it left ready=false forever, so
      // every body fell through to the procedural fallback regardless of picked skin).
      const defSet = (typeof DATA !== 'undefined' && DATA.SKINS && DATA.DEFAULT_SKIN
        && DATA.SKINS[DATA.DEFAULT_SKIN] && DATA.SKINS[DATA.DEFAULT_SKIN].set) || 'bear';
      // FIRST PAINT needs one honest body, not every animation. Fetch the default south pose first,
      // then let the other 106 default frames and ULTRON warm in parallel behind it. On the website
      // this cuts the cyan procedural placeholder from ~20 seconds to one image request.
      const primeTrack = defSet + '.rot.south';
      const primePaths = man.sprites && man.sprites[primeTrack];
      if (Array.isArray(primePaths) && await loadTrack(primeTrack, primePaths)) {
        loadedSets.add(defSet);
        ready = true;
        loading = false;
      }
      const startup = Promise.all([loadSet(defSet), loadSet('ultron')]).then(() => {
        if (frames[defSet + '.rot.south'] || frames['ultron.rot.south'] || Object.keys(frames).length) ready = true;
        console.log('[SPRITES] startup sets loaded:', Array.from(loadedSets).join(', '), '—', Object.keys(frames).length, 'animation tracks');
      });
      if (!ready) await startup;
    } catch (e) { console.warn('[SPRITES] manifest missing — procedural fallback', e); }
    finally { loading = false; }
  }

  return { init, drawBody, groundShadow, ensureSkin, isSkinReady, bodyScale, bodyAppearanceStats,
    get ready() { return ready; }, get loading() { return loading; } };
})();
