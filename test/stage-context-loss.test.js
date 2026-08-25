/* node test/stage-context-loss.test.js — THE STAGE ITSELF MAY NEVER SILENTLY GO BLACK.

   User report, 2026-08-24: the world viewport FULLY black — no agents, no props — HUD chrome
   alive, every 10-20 minutes, permanent until an app restart. That is a DIFFERENT mode from
   the 08-15 black station (test/canvas-loss-recovery.test.js): there, the offscreen plates
   died and the stage kept drawing agents+props (~15% of pixels survived). Here NOTHING
   survives, which only one mechanism produces: the visible stage canvas's own 2D context is
   dead, so every draw call is a silent no-op. preventDefault() on 'contextlost' asks for a
   restore, but when 'contextrestored' never arrives the page holds a context that will never
   work again — the ONLY recovery is a new canvas element with a new context.

   Measured live on trunk (seeded app, 647x572 stage) before the fix:
       healthy frame          87.41% non-black px
       stage context killed    0.00% non-black px, bake watchdog blind (recoveries unchanged)
   — the bake sentinel probes only the OFFSCREEN plate, so a dead stage is invisible to it.

   world.js is a browser-flow IIFE with no module.exports (the house pattern), so the wiring
   is SOURCE-LOCKED here and the pixel proof above is the live half. COMMENTS ARE STRIPPED
   BEFORE MATCHING — this file describes the very identifiers it asserts. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'world.js'), 'utf8');

function stripComments(s) {
  let out = '', i = 0, n = s.length;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = s.indexOf('\n', i); i = e < 0 ? n : e; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) { const t = s[i]; out += t; i++; if (t === '\\') { out += s[i]; i++; continue; } if (t === q) break; }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const w = stripComments(src);
A.ok(!/FULLY black/.test(stripComments('/* FULLY black */ var x = 1;')), 'stripComments removes block comments');

/* ---- 1. THE HEARTBEAT: the frame's LAST act paints one opaque pixel ----
   Alpha at (0,0) is the one property a dead context cannot fake: a live context leaves 255,
   a no-oping one leaves the transparent void of its zeroed backing store. It must be painted
   AFTER every other pass (curve, scanlines), or a late pass on a healthy context could be
   mistaken for proof while the earlier world passes are dead. */
A.ok(/function paintStageHeartbeat\(\)/.test(w), 'world.js defines paintStageHeartbeat');
A.ok(/function paintStageHeartbeat\(\)[\s\S]{0,400}?fillRect\(0, 0, 1, 1\)/.test(w),
  'the heartbeat is a single pixel at the vignetted origin corner');
A.ok(/drawCRT\(now\);\s*\n\s*paintStageHeartbeat\(\);/.test(w),
  'the heartbeat is the LAST paint of frameBody (after the CRT passes)');

/* ---- 2. THE SENTINEL arms on proof and keys on alpha ----
   A fresh canvas is transparent and innocent — blank may only mean LOSS after one opaque
   read proved this stage can paint at all. Taint (SecurityError) stands the probe down
   forever; any OTHER readback throw is treated as loss, because a lost context may throw
   on getImageData and an unreadable stage is no healthier than a blank one. */
A.ok(/function stageWentBlank\(\)/.test(w), 'world.js defines stageWentBlank');
A.ok(/if \(a > 0\) \{ stageProbeArmed = true; return false; \}/.test(w),
  'an opaque heartbeat read arms the sentinel (proof this stage can paint)');
A.ok(/return stageProbeArmed;/.test(w),
  'a blank read reports loss ONLY once armed — a fresh canvas is not a loss');
A.ok(/e\.name === 'SecurityError'\) \{ stageProbeOff = true;/.test(w),
  'only taint disables the probe; a lost-context throw must still count as loss');

/* ---- 3. THE WATCHDOG runs in the frame, with grace, and heals in the SAME frame ---- */
A.ok(/function watchStageLoss\(now\)/.test(w), 'world.js defines watchStageLoss');
A.ok(/watchCanvasLoss\(now\);[\s\S]{0,200}?watchStageLoss\(now\);/.test(w),
  'frameBody runs the stage watchdog beside the bake watchdog, BEFORE drawing (the rest of the frame paints the replacement)');
A.ok(/isContextLost/.test(w), 'the watchdog also consults isContextLost when the runtime offers it');
A.ok(/now - stageDeadSince < STAGE_GRACE_MS\) return;/.test(w),
  "a grace window lets 'contextrestored' win first and absorbs innocent one-probe blanks (a resize clears the bitmap)");
A.ok(/if \(!lost && !stageWentBlank\(\)\) \{ stageDeadSince = 0; stageFutile = 0; return; \}/.test(w),
  'a healthy read clears both the dead clock and the futile count — success is proof, per the bake watchdog law');
A.ok(/stageFutile > 0 && now - lastStageRebuildAt < RECOVER_COOLDOWN_MS\) return;/.test(w),
  'retries back off ONLY while unproven (never a flat cooldown — the law the bake watchdog earned live)');

/* ---- 4. RECOVERY is a TRANSPLANT: new element, new context, same identity ----
   Invalidating caches cannot revive a dead context. The replacement must keep the id (the
   CSS binds to #stage), the bitmap size, the input wiring, and the ResizeObserver watch. */
A.ok(/function rebuildStage\(reason\)/.test(w), 'world.js defines rebuildStage');
A.ok(/for \(const a of old\.attributes\)/.test(w), 'the replacement carries every attribute (id carries the CSS)');
A.ok(/old\.parentNode\.replaceChild\(fresh, old\)/.test(w), 'the dead node is swapped in place');
A.ok(/cv = fresh; ctx = g;/.test(w),
  'the closure references swap — everything else reaches the stage through cv/ctx');
A.ok(/function rebuildStage\(reason\)[\s\S]*?wireStageInput\(\);/.test(w), 'the replacement is re-wired for input');
A.ok(/function rebuildStage\(reason\)[\s\S]*?ro\.observe\(cv\.parentElement \|\| cv\)/.test(w),
  'the ResizeObserver follows the replacement');
A.ok(/function rebuildStage\(reason\)[\s\S]*?resize\(\);/.test(w), 'the replacement is sized before the frame draws on it');

/* ---- 5. INPUT WIRING is shared, not duplicated ----
   init() binds once (listenersBound) and rebuildStage() re-binds the fresh node; both must go
   through the same function or the two sets drift. The old node's listeners died with it, so
   re-wiring can never double-bind. */
A.ok(/function wireStageInput\(\)/.test(w), 'world.js defines wireStageInput');
const wireCalls = (w.match(/wireStageInput\(\);/g) || []).length;
A.ok(wireCalls >= 2, 'wireStageInput is called from BOTH init and rebuildStage (saw ' + wireCalls + ')');
for (const evName of ['contextlost', 'contextrestored', 'wheel', 'mousedown', 'mousemove', 'mouseup', 'mouseleave']) {
  A.ok(new RegExp("function wireStageInput\\(\\)[\\s\\S]*?addEventListener\\('" + evName + "'").test(w),
    "wireStageInput owns the '" + evName + "' listener (a rebuilt stage keeps full input)");
}

/* ---- 6. THE FAILURE STAYS REPRODUCIBLE ----
   No JS API loses a 2D context on demand; the hook reproduces its EFFECT (draws no-op, bitmap
   gone, reads answer zeros) on the LIVE context instance, so the watchdog cannot tell it from
   the real thing. */
A.ok(/_dbgKillStageContext/.test(w) && /return \{[\s\S]*\b_dbgKillStageContext\b/.test(w),
  'World exports _dbgKillStageContext so the fully-black viewport can be reproduced on demand');
A.ok(/_dbgStageState/.test(w) && /return \{[\s\S]*\b_dbgStageState\b/.test(w),
  'World exports _dbgStageState so a verify script can assert the REBUILD, not just returned pixels');
A.ok(/cv\.width = cv\.width;/.test(w), 'the repro zeroes the visible bitmap, as the lost backing store does');

A.report('stage-context-loss');
