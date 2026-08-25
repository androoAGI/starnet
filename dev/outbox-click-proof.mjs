/* dev/outbox-click-proof.mjs — live proof for the two OUTBOX dead-click fixes (2026-08-24).

   The user report: "SHIPPED 18" pallet on screen, clicking it shows nothing. Two causes found in
   frontend/app/world.js and fixed:
     1. JITTER-SWALLOWED CLICKS — mouseup treated ANY down→up mouse movement as a camera drag, so a
        click carrying 1–2px of natural jitter opened nothing. Now a pan needs >4px cumulative travel.
     2. PALLET DEAD ZONE — the SHIPPED pallet draws ~42px wide under a 24px-wide chute hit box, so the
        outer crate columns were unclickable. The hit box now widens to the pallet span below the chute.

   Attaches to an ALREADY-RUNNING dev/seed-deliverables.js (SKYNET_PORT, default 8733) and drives REAL
   MouseEvents on the game canvas:
     · A: mousedown at the outbox centre, mousemove +2px, mouseup → the OUTBOX window MUST open.
     · B: hover sweep along the pallet row → the clickable span below the chute is wider than the
          footprint span at the chute row (the outer-crate dead zone is gone).
     · C: a real click on an OUTER pallet crate column opens the OUTBOX window.

   Usage:  node dev/seed-deliverables.js          (one shell, leave running)
           node dev/outbox-click-proof.mjs        (another)
   Dev-only. Shots land in dev/.shots-outbox-click/. */
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectCDP, evalJS, capture, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '.shots-outbox-click');
const PORT = process.env.SKYNET_PORT || '8733';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9783);
const PROFILE = join(OUT, '_chrome');

// Shared page-side helpers: the outbox centre in CLIENT coords (the shipped CDP-verify hook), the game
// canvas, and a real-MouseEvent dispatcher. k (client px per world px) is measured from the live hit box
// itself: sweep right from the chute centre at the CHUTE row until the cursor stops reading 'pointer' —
// that edge IS the footprint half-width (12 world px), so k = edgePx / 12.
const HELPERS = `
  const cv = document.getElementById('stage');
  const pt = World._dbgPropClientPoint('outbox');
  const ev = (type, x, y) => cv.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  const hover = (x, y) => { ev('mousemove', x, y); return cv.style.cursor; };
  const edge = (y, dir) => {                       // px from centre where 'pointer' ends, sweeping dir=±1
    let last = 0;
    for (let dx = 0; dx <= 80; dx += 1) { if (hover(pt.clientX + dir * dx, y) === 'pointer') last = dx; else if (dx - last > 6) break; }
    return last;
  };`;

const READY = `(() => {
  if (typeof World === 'undefined' || !World._dbgPropClientPoint) return 'no-world';
  const pt = World._dbgPropClientPoint('outbox');
  return pt ? JSON.stringify(pt) : 'no-outbox';
})()`;

// The seed's floor has no OUTBOX — stamp a real one through the station store (the same seam REFIT
// uses), on any free 2x2 in-room patch, so every event below rides the true placed-prop path.
const PLACE_OUTBOX = `(() => {
  const st = Build.__test__.station();
  if (st.props().some(p => p.t === 'outbox')) return 'already';
  const free = (x, y) => { for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) if (!st.roomAt(x + dx, y + dy) || st.propAt(x + dx, y + dy) || st.beltAt(x + dx, y + dy)) return false; return true; };
  const b = st.bounds();
  for (let ty = b.minTy; ty <= b.maxTy - 1; ty++) for (let tx = b.minTx; tx <= b.maxTx - 1; tx++) {
    if (!free(tx, ty)) continue;
    const r = st.addProp({ t: 'outbox', x: tx, y: ty, w: 2, h: 2 });
    if (r && r.ok) return JSON.stringify({ placed: true, at: [tx, ty] });
  }
  return 'no-spot';
})()`;

// A: the jitter click — down, +2px of movement, up. Before the fix this was swallowed as a drag.
const JITTER_CLICK = `(async () => {
  ${HELPERS}
  ev('mousedown', pt.clientX, pt.clientY);
  ev('mousemove', pt.clientX + 2, pt.clientY + 1);
  ev('mouseup',   pt.clientX + 2, pt.clientY + 1);
  await new Promise(r => setTimeout(r, 800));
  const win = [...document.querySelectorAll('.term-title')].some(t => /OUTBOX/.test(t.textContent));
  return JSON.stringify({ ok: win, opened: win });
})()`;

const CLOSE_ALL = `(() => { document.querySelectorAll('.term-x').forEach(x => x.click()); return 'closed'; })()`;

// B: hit-box geometry read off the LIVE cursor. chuteHalf ≈ footprint half-width (12 world px → k);
// palletHalf must reach the outer crate column (~19.5 world px) — wider than chuteHalf.
const SWEEP = `(async () => {
  ${HELPERS}
  const chuteHalf = Math.max(edge(pt.clientY, +1), edge(pt.clientY, -1));
  const k = chuteHalf / 12;                       // client px per world px, from the live box itself
  const palletY = pt.clientY + 18 * k;            // prop centre +18 world px = the first crate row
  const palletHalf = Math.max(edge(palletY, +1), edge(palletY, -1));
  return JSON.stringify({ ok: palletHalf > chuteHalf + 4 * k, chuteHalf, palletHalf, k: +k.toFixed(2) });
})()`;

// C: a clean real click on an OUTER crate column (world x ±15 from centre, on the crate row).
const OUTER_CLICK = `(async () => {
  ${HELPERS}
  const k = Math.max(edge(pt.clientY, +1), edge(pt.clientY, -1)) / 12;
  const x = pt.clientX + 15 * k, y = pt.clientY + 18 * k;
  ev('mousedown', x, y); ev('mouseup', x, y);
  await new Promise(r => setTimeout(r, 800));
  const win = [...document.querySelectorAll('.term-title')].some(t => /OUTBOX/.test(t.textContent));
  return JSON.stringify({ ok: win, opened: win });
})()`;

(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const { proc } = launchChrome({ cdpPort: CDP_PORT, win: '1440,980', profileDir: PROFILE });
  const fails = [];
  const claim = (label, res) => {
    let ok = false; try { ok = JSON.parse(res).ok === true; } catch (_) {}
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + '  ' + res);
    if (!ok) fails.push(label);
  };
  try {
    await sleep(1800);
    const cdp = await connectCDP(CDP_PORT);
    const diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT });
    await sleep(9000);

    let ready = await evalJS(cdp, READY);
    if (ready === 'no-outbox') {
      console.log('place ->', await evalJS(cdp, PLACE_OUTBOX));
      await sleep(1500);
      ready = await evalJS(cdp, READY);
    }
    console.log('ready ->', ready);
    if (ready === 'no-outbox' || ready === 'no-world') throw new Error('no outbox on the floor — cannot drive the proof');
    claim('A jitter click opens OUTBOX', await evalJS(cdp, JITTER_CLICK));
    console.log(' shot ->', JSON.stringify(await capture(cdp, OUT, '1-jitter-click')));
    console.log('close ->', await evalJS(cdp, CLOSE_ALL));

    claim('B pallet row clickable wider than chute', await evalJS(cdp, SWEEP));

    claim('C outer crate click opens OUTBOX', await evalJS(cdp, OUTER_CLICK));
    console.log(' shot ->', JSON.stringify(await capture(cdp, OUT, '2-outer-crate-click')));

    const errs = (diag.exceptions || []).length;
    console.log('page exceptions during capture:', errs);
    if (errs) console.log(JSON.stringify(diag.exceptions.slice(0, 3), null, 1));
    console.log(fails.length ? '\nRESULT: FAIL — ' + fails.join(' · ') : '\nRESULT: ALL PASS');
    process.exitCode = fails.length ? 1 : 0;
  } finally {
    try { proc.kill(); } catch (_) {}
  }
})();
