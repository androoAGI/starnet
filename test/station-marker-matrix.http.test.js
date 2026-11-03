/* node test/station-marker-matrix.http.test.js — the reset seed rule is ONE rule, proven through index.js's own save wiring.

   A reset generation (ERASE EVERYTHING or START FRESH, through either door) refuses a browser copy of the station from
   BEFORE the reset, so an erased station never writes itself back (bug 5c019483, #101's erase authority). The reset's time
   used to be parsed by savestore.js on its own, every call: a marker it could not read proved nothing, so EVERY save was
   refused — the gate let a brand-new Commander onboard over a torn marker, and their station's first and second saves
   were refused (reset:true) with no station file ever written and no way out. Now the time is the station record's
   (sidecar/station-record.js, injected into the save store by index.js): the one marker parser reads every dialect, and a
   torn marker's time is bounded by when the record was derived at boot, so a station founded after it saves while a copy
   from before it is still refused. And the station file's first accepted write founds the generation in the record.

   Boots the REAL sidecar (SidecarFixture: hermetic profile, providers on a dead loopback) on each shape — fresh, a native
   ERASE (at as epoch-ms text), a sidecar START FRESH (ISO at), a numeric at, a torn marker, and an ERASE whose generation
   was onboarded since — then POSTs /api/save twice through the real route: a copy founded before the reset (refused on
   every reset shape) and a station founded after the boot (accepted on every shape; for the onboarded shape its own next
   save). GET /api/lineage must agree with test/station-marker-matrix.test.js, and the accepted save must have founded the
   record. The torn shape restarts once more: the founded station keeps saving.
   THE CREW, in WAKE's order: a window from before the reset pushes its crew as its save is refused, and the station founded
   now pushes its own before its first save lands (CloudSave debounces that save; pushRoster does not wait). Both are held,
   never written, so no roster file reads as a station before one is founded; the founding save writes the founder's crew. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const T_RESET = Date.UTC(2026, 9, 1, 12, 0, 0);   // every reset below happened at this time, well before the boot
const ENV = {
  STARNET_DEV: '0', SKYNET_DEV: '0', SKYNET_QUEST_REFRESH: '0', STARNET_QUEST_REFRESH: '0',
  STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0', STARNET_LOOP_ENABLED: '0', SKYNET_LOOP_ENABLED: '0',
  SKYNET_LIVE_PRICES: '0', STARNET_LIVE_PRICES: '0', STARNET_EDGE_TTS: '0', SKYNET_EDGE_TTS: '0',
  STARNET_CLOUD_URL: 'http://127.0.0.1:1', STARNET_CREDITS_URL: 'http://127.0.0.1:1', STARNET_DESKTOP_SHELL: '0',
  SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:1', STARNET_OPENROUTER_BASE: 'http://127.0.0.1:1',
  OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: ''
};

function write(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2)); }
function doc(name, createdAt, rev, updatedAt, client) {
  return { schema: 'starnet.save', version: 6, updatedAt, _saveRevision: rev, _saveDirty: true, _saveClient: client,
    agent: { id: 'agent', name, createdAt }, agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' };
}
const SHAPES = [
  { name: 'fresh', reset: false, station: 'none', build: ws => {} },
  { name: 'native ERASE (at as epoch-ms text)', reset: true, erase: true, station: 'erased', build: ws => {
      write(path.join(ws, '.migrated'), '1');
      write(path.join(ws, '.fresh-start.json'), { version: 1, erased: true, at: String(T_RESET), acknowledgedRoots: [], quarantine: null, moved: [] }); } },
  { name: 'sidecar START FRESH (ISO at)', reset: true, station: 'none', build: ws => {
      write(path.join(ws, '.fresh-start.json'), { version: 1, at: new Date(T_RESET).toISOString(), acknowledgedRoots: [], quarantine: null, moved: [] }); } },
  { name: 'numeric at', reset: true, station: 'none', build: ws => {
      write(path.join(ws, '.fresh-start.json'), { version: 1, at: T_RESET, acknowledgedRoots: [] }); } },
  { name: 'torn marker', reset: true, torn: true, station: 'none', build: ws => write(path.join(ws, '.fresh-start.json'), '{"version":1,"acknow') },
  { name: 'ERASE, then onboarded', reset: true, erase: true, onboarded: true, station: 'active', build: ws => {
      write(path.join(ws, '.migrated'), '1');
      write(path.join(ws, '.fresh-start.json'), { version: 1, erased: true, at: String(T_RESET), acknowledgedRoots: [], quarantine: null, moved: [] });
      const d = doc('FOUNDED-AFTER-THE-ERASE', T_RESET + 1000, 5, T_RESET + 5000, 'onboarded-window');
      write(path.join(ws, 'agent.save.json'), { version: 1, agentId: 'agent', updatedAt: T_RESET + 5000, savedAt: T_RESET + 5000, requestUpdatedAt: T_RESET + 5000,
        revision: 5, client: 'onboarded-window', doc: Object.assign({}, d, { _saveDirty: false }) }); } }
];

(async () => {
  for (const shape of SHAPES) {
    const n = shape.name;
    const fixture = SidecarFixture.create({ prefix: 'starnet-seed-matrix-', timeoutMs: 30000, env: ENV });
    const fixtureRoot = fixture.workspace;
    fixture.workspace = path.join(fixtureRoot, 'workspaces');   // its own parent: no other test's update-snapshots beside it
    fs.mkdirSync(fixture.workspace);
    try {
      shape.build(fixture.workspace);
      await fixture.start();
      const bootedAt = Date.now();
      let lineage = (await fixture.json('GET', '/api/lineage')).body.lineage;
      A.eq(lineage.onboardingAllowed, !shape.onboarded, n + ': the gate ' + (shape.onboarded ? 'sees the onboarded station' : 'lets the app onboard') + ' (as the fast matrix says)');
      A.eq(lineage.station && lineage.station.state, shape.station, n + ': GET /api/lineage reports the station record (' + JSON.stringify(lineage.station) + ')');
      const save = body => fixture.json('POST', '/api/save', body);
      const rosterFile = path.join(fixture.workspace, 'agent.roster.json');
      const crew = (name, rev, client) => fixture.json('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'You are ' + name + '.', name, model: '', provider: 'openrouter' }],
        updatedAt: Date.now(), saveRevision: rev, saveClient: client, rosterBase: { known: [], changed: ['agent'] } });
      if (shape.reset) {
        // a browser copy of the station from BEFORE the reset (an older window, a stale WebView profile)
        const old = (await save(doc('FROM-BEFORE-THE-RESET', T_RESET - 60000, 23, T_RESET - 1000, 'old-window'))).body;
        if (shape.onboarded) A.ok(old.ok === false && old.predatesReset === true, n + ': a copy from before the erase is refused as erased work (' + JSON.stringify(old) + ')');
        else A.ok(old.ok === false && old.reset === true, n + ': a copy founded before the reset is refused (reset:true): ' + JSON.stringify(old));
        if (!shape.onboarded) {
          const pushed = (await crew('FROM-BEFORE-THE-RESET', 23, 'old-window')).body;
          A.eq([pushed.ok, pushed.held], [true, true], n + ': that window\'s crew is held, not written (' + JSON.stringify(pushed) + ')');
        }
      }
      if (!shape.onboarded) {
        const wake = (await crew('FOUNDED-NOW', 0, 'new-window')).body;
        A.eq([wake.ok, wake.held], [true, true], n + ': WAKE\'s crew, pushed before its first save lands, is held too (' + JSON.stringify(wake) + ')');
        A.eq(fs.existsSync(rosterFile), false, n + ': no roster file before a station is founded');
      }
      // the station the Commander founds now (for the onboarded shape: its own next save)
      const founded = shape.onboarded ? doc('FOUNDED-AFTER-THE-ERASE', T_RESET + 1000, 5, Date.now(), 'onboarded-window')
        : doc('FOUNDED-NOW', bootedAt + 1, 0, bootedAt + 2, 'new-window');
      const first = (await save(founded)).body;
      A.ok(first.ok === true, n + ': a station founded after the reset saves (' + JSON.stringify(first) + ')');
      if (!shape.onboarded) {
        let landed = null; try { landed = JSON.parse(fs.readFileSync(rosterFile, 'utf8')); } catch (_) {}
        A.eq(landed && landed.agents.map(a => a.name), ['FOUNDED-NOW'], n + ': the founding save writes the founder\'s crew');
      }
      lineage = (await fixture.json('GET', '/api/lineage')).body.lineage;
      A.eq(lineage.station && lineage.station.state, 'active', n + ': the accepted save founded the generation in the record');
      let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(fixture.workspace, '.station.json'), 'utf8')); } catch (_) {}
      A.ok(rec && rec.state === 'active' && rec.generationId === lineage.station.generationId, n + ': durably (' + JSON.stringify(rec && { state: rec.state, by: rec.by, generationId: rec.generationId }) + ')');
      if (shape.reset && shape.torn) {
        A.ok(rec && rec.reset && rec.reset.unreadable === true && rec.reset.at > T_RESET && rec.reset.at <= bootedAt,
          n + ': the founding keeps the reset, whose time a torn marker bounds by the boot that derived it (' + JSON.stringify(rec && rec.reset) + ')');
      } else if (shape.reset) {
        A.eq(rec && rec.reset && rec.reset.at, T_RESET, n + ': the founding keeps the reset at its own time, read in its dialect, so pre-reset copies stay refused');
        A.eq(rec && rec.eraseAuthority, !!shape.erase, n + ': ' + (shape.erase ? 'and the erase authority' : 'with no erase authority'));
      }
      const second = (await save(Object.assign({}, founded, { _saveRevision: first.revision, updatedAt: Date.now() + 10 }))).body;
      A.ok(second.ok === true, n + ': and its next save lands too (' + JSON.stringify(second) + ')');
      if (shape.torn) {
        await fixture.restart();
        lineage = (await fixture.json('GET', '/api/lineage')).body.lineage;
        A.eq([lineage.onboardingAllowed, lineage.station && lineage.station.state], [false, 'active'], n + ': after a restart the founded station is the station (its save is on disk)');
        const loaded = (await fixture.json('GET', '/api/save?agent=agent')).body;
        A.eq(loaded.save && loaded.save.agent && loaded.save.agent.name, 'FOUNDED-NOW', n + ': GET /api/save serves it');
        const third = (await save(Object.assign({}, founded, { _saveRevision: second.revision, updatedAt: Date.now() + 20 }))).body;
        A.ok(third.ok === true, n + ': and it keeps saving after the restart (' + JSON.stringify(third) + ')');
        const again = (await save(doc('FROM-BEFORE-THE-RESET', T_RESET - 60000, 23, T_RESET - 1000, 'old-window'))).body;
        A.ok(again.ok === false, n + ': while the copy from before the boot still never replaces it (' + JSON.stringify(again) + ')');
      }
    } finally {
      await fixture.dispose();
      if (path.dirname(fixtureRoot) !== path.resolve(os.tmpdir()) || !path.basename(fixtureRoot).startsWith('starnet-seed-matrix-')) throw new Error('unsafe fixture root cleanup');
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
  A.report('station-marker-matrix.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
