/* Read-only world acceptance panel. Explicit developer URL + dev sidecar required.
 * Captures the live model, event log and actual rendered pixels. No fake run controls.
 */
'use strict';
(() => {
  if (!window.__STARNET_DEV__ || !new URLSearchParams(location.search).has('worldlab')) return;
  const boot = () => {
    const host = document.createElement('details');
    host.id = 'world-lab';
    host.style.cssText = 'position:fixed;right:12px;top:80px;z-index:10002;max-width:440px;width:calc(100vw - 24px);padding:10px;background:#091319f5;border:1px solid #78acb7;color:#ccdde0;font:13px VT323,monospace;box-shadow:0 12px 40px #0009';
    const summary = document.createElement('summary'); summary.textContent = 'WORLD II · DEVELOPMENT';
    summary.style.cursor = 'pointer'; host.appendChild(summary);
    const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;margin:10px 0';
    const capture = document.createElement('button'); capture.type = 'button'; capture.textContent = 'CAPTURE LIVE STATE'; capture.id = 'world-lab-capture';
    capture.style.cssText = 'background:#19313b;color:#d1ecef;border:1px solid #426977;padding:7px;font:inherit;cursor:pointer';
    const compare = document.createElement('a');
    const u = new URL(location.href), isClassic = u.searchParams.get('world') === 'classic';
    if (isClassic) u.searchParams.delete('world'); else u.searchParams.set('world', 'classic');
    compare.href = u.href; compare.textContent = isClassic ? 'VIEW WORLD II' : 'COMPARE CLASSIC';
    compare.style.cssText = 'color:#ffc882;padding:7px';
    bar.append(capture, compare); host.appendChild(bar);
    const output = document.createElement('pre'); output.id = 'world-lab-output';
    output.style.cssText = 'white-space:pre-wrap;max-height:50vh;overflow:auto;margin:0;font:12px VT323,monospace;color:#ccdde0';
    output.textContent = 'Capture records the current frame, station, crew and real event history.';
    host.appendChild(output); document.body.appendChild(host);
    capture.addEventListener('click', () => {
      const cv = document.querySelector('#stage'), world = typeof World !== 'undefined' ? World : null;
      let pixels = null;
      if (cv && cv.width && cv.height) {
        const c = document.createElement('canvas'); c.width = 64; c.height = 48;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(cv, 0, 0, 64, 48);
        const p = g.getImageData(0, 0, 64, 48).data;
        let sum = 0, lit = 0, unique = new Set();
        for (let i = 0; i < p.length; i += 4) {
          const l = p[i] * .2126 + p[i + 1] * .7152 + p[i + 2] * .0722;
          sum += l; if (l > 15) lit++; unique.add(p[i] + ',' + p[i + 1] + ',' + p[i + 2]);
        }
        pixels = { meanLuminance: +(sum / 3072).toFixed(2), litSamples: lit, distinctColors: unique.size };
      }
      const d = world && world.stationDoc ? world.stationDoc() : null;
      const api = window.__SKYNET_TEST__;
      const events = api && api.events ? api.events().filter(e => /agent.run|agent.tool|workitem|deliverable/.test(e.name)).slice(-20).map(e => ({name:e.name,runId:e.payload && e.payload.runId,status:e.payload && e.payload.status})) : [];
      output.textContent = JSON.stringify({ capturedAt: new Date().toISOString(),
        renderer: world && world.renderStats ? world.renderStats() : null,
        pixels, station: d ? {rooms:d.rooms,props:d.props,belts:d.belts} : null,
        bodies: world && world.bodies ? world.bodies() : [],
        link: world && world.dbg ? (world.dbg() || {}).bridge : null,
        capabilities: world && world.heroCaps ? world.heroCaps('agent') : [], events }, null, 2);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
