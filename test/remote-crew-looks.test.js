/* node test/remote-crew-looks.test.js — a phone's status polls and file chunks no longer re-parse the whole station save.

   The bug (perf review 10-19, index.js phone gateway): the remote host lists the agents (with each one's skin and
   colour) for every status and activity poll (10 s per open phone), every portrait and every 256 KB file chunk, and
   crewLooks parsed the WHOLE save each time to read those few strings — a 20 MB download did 80 parses.

   Drives the REAL remoteCrewLooks sliced out of sidecar/index.js over the REAL savestore (temp dir, piece 2's
   stamp/loadStamped) inside the REAL remote host (sidecar/remote/host.js):
     (1) repeated status polls + an 80-chunk download parse the save ONCE while it is unchanged;
     (2) a save (a new skin) is visible on the very next poll; an outside edit of the file is too;
     (3) a save that is absent or corrupt (recovered from .bak) is never kept, and the looks stay truthful;
     (4) the host is wired to it;
     (5) the desk persists (debounced POST /api/save) between polls, moving the stamp each time: the save handler seeds
         the looks from the doc it just stored, so the next poll shows the new look with no parse. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fnBody } = require('./_fnbody.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { makeRemoteHost } = require('../sidecar/remote/host.js');

const src = readSidecarSource();
const looksFn = fnBody(src, 'function remoteCrewLooks()');
A.ok(looksFn.startsWith('function remoteCrewLooks()') && looksFn.length < 1500, 'sliced exactly the host crewLooks reader');
const looksOfFn = fnBody(src, 'function crewLooksOf(save)');
A.ok(looksOfFn.startsWith('function crewLooksOf(save)') && looksOfFn.length < 800, 'and the looks projection it shares with the save seed');
const seedFn = fnBody(src, 'function seedSaveMemos(agentId, doc)');
const saveFn = fnBody(src, 'async function handleSaveWrite(req, res)');
A.ok(seedFn.startsWith('function seedSaveMemos(agentId, doc)') && seedFn.length < 1500 && saveFn.startsWith('async function handleSaveWrite(req, res)') && saveFn.length < 6000, 'and the POST /api/save handler that seeds it');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-remote-looks-'));
  try {
    const saveFile = path.join(root, 'agent.save.json');
    let parses = 0;
    const cfs = new Proxy(fs, { get(t, p) {
      if (p === 'readFileSync') return function (f) { if (String(f) === saveFile) parses++; return t.readFileSync.apply(t, arguments); };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    let T = 1000;
    const saveStore = makeSaveStore({ fs: cfs, pathMod: path, root, clock: { now: () => ++T } });
    const big = Array.from({ length: 200 }, (_, i) => ({ id: 'ws' + i, title: 'session ' + i, history: [{ role: 'user', content: 'x'.repeat(2000) }] }));
    saveStore.save('agent', { updatedAt: 1, agent: { id: 'agent', skin: 'nova', color: '#f00' }, agents: [{ id: 'forge', skin: 'smith', color: '#0f0' }], workstreams: big });
    const api = vm.runInNewContext("let _remoteLooksMemo = { stamp: '', looks: null };\nlet _stationEpochMemo = { stamp: '', epoch: 1 };\n" + [looksOfFn, looksFn, seedFn, saveFn].join('\n') + '\n({ remoteCrewLooks, handleSaveWrite })',
      { saveStore, workspaceDegraded: false, growthRatings: { latestTs: () => 0 }, readBody: async (req) => req.body, failNote: () => {},
        observeDeletedSessions: () => [] });   // the deleted-session ledger feed (qa/bugs/3e926b6a)
    const host = makeRemoteHost({ now: () => 5000, newId: () => 'id', broadcast: () => {},
      roster: () => [{ agentId: 'agent', name: 'Nova' }, { agentId: 'forge', name: 'Forge' }], liveRuns: () => [],
      transcript: { streams: () => [], history: () => [] },
      crewLooks: () => api.remoteCrewLooks(),
      readFile: async (agentId, rel, offset, length) => ({ ok: true, agentId, rel, offset, length, data: '' }) });

    // ---- (1) ----
    parses = 0;
    for (let i = 0; i < 6; i++) await host.status();
    for (let c = 0; c < 80; c++) await host.fetchFile({ agentId: 'forge', path: 'out/big.bin', offset: c * 262144, length: 262144 });
    A.eq(parses, 1, '6 status polls + an 80-chunk download parsed the save once (was 86 parses)');
    const st = await host.status();
    A.eq(st.agents.map(a => a.skin), ['nova', 'smith'], 'the polled crew carries each agent\'s skin');
    A.eq(st.agents.map(a => a.color), ['#f00', '#0f0'], 'and colour');

    // ---- (2) ----
    saveStore.save('agent', { updatedAt: 2, agent: { id: 'agent', skin: 'ghost', color: '#00f' }, agents: [{ id: 'forge', skin: 'smith', color: '#0f0' }], workstreams: big });
    A.eq((await host.status()).agents[0].skin, 'ghost', 'a save is visible on the very next poll');
    const wrapped = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    wrapped.doc.agents[0].skin = 'outside';
    fs.writeFileSync(saveFile + '.ext', JSON.stringify(wrapped)); fs.renameSync(saveFile + '.ext', saveFile);
    A.eq((await host.status()).agents[1].skin, 'outside', 'an outside replace of the save is visible on the next poll');

    // ---- (5) the desk persists (POST /api/save) between phone polls: the save seeds the looks, no re-parse ----
    let rev = 0;
    for (let i = 0; i < 5; i++) {
      const doc = { updatedAt: 100 + i, _saveRevision: rev, agent: { id: 'agent', skin: 'skin' + i, color: '#00' + i }, agents: [{ id: 'forge', skin: 'smith', color: '#0f0' }], workstreams: big };
      let text = '';
      await api.handleSaveWrite({ body: JSON.stringify(doc) }, { writeHead: () => {}, end: (b) => { text = b; } });
      const out = JSON.parse(text);
      A.eq(out.ok, true, 'desk save ' + i + ' lands through the real handler');
      rev = out.revision;
      parses = 0;
      const polled = await host.status();
      A.eq(polled.agents[0].skin, 'skin' + i, 'the poll right after desk save ' + i + ' shows the saved skin');
      A.eq(parses, 0, 'and parsed the save 0 times (the stamp-only memo re-parsed after every save)');
    }

    // ---- (3) ----
    fs.writeFileSync(saveFile, '{ torn');
    parses = 0;
    const r1 = await host.status(); const r2 = await host.status();
    A.ok(parses >= 2, 'a corrupt (recovered) save is re-read on every poll, never kept');
    A.ok(r1.agents.length === 2 && r2.agents.length === 2, 'and the crew list still renders');
    for (const n of fs.readdirSync(root)) if (n.indexOf('agent.save.json') === 0) fs.rmSync(path.join(root, n), { force: true });
    const gone = await host.status();
    A.eq(gone.agents.map(a => a.skin), ['', ''], 'no save -> no skins (never a stale one)');

    // ---- (4) ----
    const wiring = src.slice(src.indexOf("const remoteHost = require('./remote/host.js').makeRemoteHost({"), src.indexOf("const remoteHost = require('./remote/host.js').makeRemoteHost({") + 6000);
    A.ok(/crewLooks: \(\) => remoteCrewLooks\(\),/.test(wiring), 'the remote host reads the crew through remoteCrewLooks');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('remote-crew-looks.test');
})().catch(e => { console.error(e); process.exit(1); });
