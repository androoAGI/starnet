/* node test/toolsets.test.js — the TOOLSETS console (per-capId-family kill-switch layered on object=capability).
   Three layers:
   1) DERIVATION — toolsetRows() is derived straight from CAP_REGISTRY: every toggleable family present, tool
      lists match the registry, `compute` is never a row, consent summary is truthful, granting object correct.
   2) FILTER — resolveTools drops a disabled family's grants (and ONLY that family), compute is NEVER filtered,
      and MCP-style projected tools (not in CAP_REGISTRY) are untouched by the toolset filter. The run path
      supplies those disabled families only outside explicit Full Power; Full Power projects every family.
   3) SOURCE GUARD — the sidecar store idiom (durable persist, sparse OFF-only) + endpoints exist and refuse
      compute; the frontend surfaces a TOOLSETS section while keeping every guarded connectors/Spotify string. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { toolsetRows, toggleableCaps } = require('../sidecar/capability/toolsets.js');

// a station with the given objectTypes placed in the agent's one room.
function stationWith(types) {
  return {
    agents: { hero: { id: 'hero', room: 'office' } },
    rooms: { office: { id: 'office', objects: types.map((t, i) => ({ instanceId: 'o' + i, objectType: t })) } }
  };
}

(async () => {
  // ---------- 1. DERIVATION from CAP_REGISTRY ----------
  const rows = toolsetRows(CAP_REGISTRY);
  const byId = {}; rows.forEach(r => byId[r.id] = r);

  A.ok(rows.length >= 7, 'at least the seven toggleable families are surfaced');
  A.ok(!byId.compute, 'compute is NEVER a toolset row (it is the always-on compute gate)');
  A.ok(toggleableCaps(CAP_REGISTRY).indexOf('compute') < 0, 'compute is not in the toggleable set');

  // tool list per family matches the registry exactly (derived, cannot drift)
  const webTools = CAP_REGISTRY.dish.filter(g => g.capId === 'web').map(g => g.tool);
  A.eq(byId.web.tools, webTools, 'web toolset tools == dish grants (derived from registry)');
  A.eq(byId.web.object, 'dish', 'web family granting object is the dish');
  A.eq(byId.cabinet.object, 'cabinet', 'cabinet family granting object is the cabinet');
  A.eq(byId.jukebox.object, 'jukebox', 'jukebox family granting object is the jukebox');
  A.eq(byId.memory.object, 'notebook', 'memory family granting object is the notebook');

  // consent summary is truthful: cabinet writes ask -> consentGated; web reads/exec mixed but has consent tools
  A.eq(byId.cabinet.consentGated, true, 'cabinet is consent-gated (fs.write asks first)');
  A.eq(byId.jukebox.consentGated, true, 'jukebox is consent-gated (playback control asks first)');
  // a family whose grants are ALL consent-free reports consentGated:false
  const memConsent = CAP_REGISTRY.notebook.some(g => g.requiresConsent);
  A.eq(byId.memory.consentGated, memConsent, 'memory consent summary matches its registry grants');

  // ---------- 2. FILTER: resolveTools honours disabledCaps ----------
  const full = resolveTools('hero', stationWith(['computer', 'dish', 'cabinet']));
  A.ok(full.tools.indexOf('web_search') >= 0, 'baseline: web_search granted when dish placed + no filter');
  A.ok(full.tools.indexOf('fs.read') >= 0, 'baseline: fs.read granted when cabinet placed');
  A.eq(full.hasCompute, true, 'baseline: compute present from the computer');

  // disable web -> its tools vanish, cabinet untouched, compute untouched
  const noWeb = resolveTools('hero', stationWith(['computer', 'dish', 'cabinet']), undefined, { disabledCaps: { web: true } });
  A.ok(noWeb.tools.indexOf('web_search') < 0, 'disabled web family: web_search dropped');
  A.ok(noWeb.tools.indexOf('browser.navigate') < 0, 'disabled web family: browser tools dropped too');
  A.ok(noWeb.tools.indexOf('fs.read') >= 0, 'disabling web leaves cabinet tools intact (only that family drops)');
  A.eq(noWeb.hasCompute, true, 'disabling web never touches the compute gate');

  // compute can never be filtered even if someone puts it in disabledCaps
  const tryKillCompute = resolveTools('hero', stationWith(['computer', 'dish']), undefined, { disabledCaps: { compute: true, web: true } });
  A.eq(tryKillCompute.hasCompute, true, 'compute is NEVER filtered even when named in disabledCaps');

  // disabledCaps accepts a Set and an array too (normalised)
  const viaSet = resolveTools('hero', stationWith(['computer', 'cabinet']), undefined, { disabledCaps: new Set(['cabinet']) });
  A.ok(viaSet.tools.indexOf('fs.read') < 0, 'disabledCaps as a Set works');
  const viaArr = resolveTools('hero', stationWith(['computer', 'cabinet']), undefined, { disabledCaps: ['cabinet'] });
  A.ok(viaArr.tools.indexOf('fs.read') < 0, 'disabledCaps as an array works');

  // sparse round-trip semantics of the store (mirrors index.js: only OFF families persisted):
  // enabling a family removes it from the map; disabling adds { capId:false }.
  const disabledMap = {};
  const setToolset = (id, enabled) => { if (enabled) delete disabledMap[id]; else disabledMap[id] = false; };
  const disabledView = () => { const s = {}; for (const c of toggleableCaps(CAP_REGISTRY)) if (disabledMap[c] === false) s[c] = true; return s; };
  setToolset('jukebox', false);
  A.eq(disabledMap, { jukebox: false }, 'disabling persists exactly { capId:false } (sparse)');
  A.ok(resolveTools('hero', stationWith(['computer', 'jukebox']), undefined, { disabledCaps: disabledView() }).tools.indexOf('spotify_search') < 0, 'store view drops jukebox tools');
  setToolset('jukebox', true);
  A.eq(disabledMap, {}, 're-enabling removes the key (fresh install == empty map)');
  A.ok(resolveTools('hero', stationWith(['computer', 'jukebox']), undefined, { disabledCaps: disabledView() }).tools.indexOf('spotify_search') >= 0, 'jukebox tools return once re-enabled');

  // ---------- 3. SOURCE GUARD: sidecar store + endpoints ----------
  const idx = readSidecarSource();
  A.ok(/toolsets\.json/.test(idx), 'toolsets state persists to a toolsets.json sibling file');
  A.ok(/saveResilient\(TOOLSETS_FILE/.test(idx), 'toolsets state uses the durable saveResilient idiom');
  A.ok(/handleToolsetsList/.test(idx) && /\/api\/toolsets/.test(idx), 'GET /api/toolsets wired');
  A.ok(/handleToolsetToggle/.test(idx) && /\/api\/toolsets\//.test(idx), 'POST /api/toolsets/:id wired');
  A.ok(/compute.*cannot be toggled|cannot be toggled/.test(idx), 'the toggle route refuses compute');
  A.ok(/disabledCaps:\s*unrestrictedHostNow\(\)\s*\?\s*new Set\(\)\s*:\s*disabledCapsSet\(\)/.test(idx),
    'the run path live-applies disabled toolsets in restricted modes and ignores them in Full Power');

  // ---------- 4. SOURCE GUARD: frontend surface + every guarded connectors/Spotify string kept ----------
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'connectors.js'), 'utf8');   // CONNECTORS window extracted from stationui.js (BUILDERS split)
  A.ok(/TOOLSETS/.test(station), 'the console surfaces a TOOLSETS section');
  A.ok(/\/api\/toolsets/.test(station), 'the frontend reads /api/toolsets');
  // guarded strings from connectors-ui.test.js MUST survive the retitle/reorg:
  A.ok(/function buildConnectors/.test(station), 'buildConnectors builder preserved');
  A.ok(/setupSpotify\(body\)/.test(station), 'Spotify wiring preserved');
  A.ok(/id="sp-connect"/.test(station) && /id="sp-status"/.test(station) && /id="sp-disconnect"/.test(station), 'Spotify ids preserved');
  A.ok(/Harness\.api\.post\('\/api\/spotify\/disconnect'\)[\s\S]{0,500}!out\.ok/.test(station), 'Spotify disconnect UI requires a confirmed 2xx response');
  A.ok(/Spotify was NOT disconnected/.test(station), 'Spotify disconnect UI names a refused change honestly');
  A.ok(/handleSpotifyDisconnect[\s\S]{0,500}spotifyJson\(res, 500, \{ ok: false/.test(idx), 'Spotify disconnect route fails when durable clear fails');
  // HTTP and isolated stdio are both real routes; stdio stays bound to a named Safe Cell agent.
  A.ok(/id="mc-transport"/.test(station) && /id="mc-url"/.test(station) && /id="mc-timeout"/.test(station), 'MCP HTTP form ids preserved');
  A.ok(/id="mc-agent"/.test(station) && /id="mc-command"/.test(station) && /id="mc-args"/.test(station), 'MCP Safe Cell stdio form ids preserved');
  A.ok(/function startEdit/.test(station) && /data-act="edit"/.test(station) && /data-act="reload"/.test(station), 'MCP per-row actions preserved');
  A.ok(/function badge/.test(station) && /parseKV/.test(station) && /never round-trip the token/.test(station), 'MCP helpers + token-safety preserved');

  A.report('toolsets');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
