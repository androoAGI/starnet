/* node test/notebook-peer-reads.test.js — a run no longer re-reads and re-parses every agent's notebook (twice), and a
   useCount bump is ONE durable write.

   The bug (perf review 10-19, index.js memory recall): every run read the agent's own notebook, then EVERY other
   agent's notebook twice (otherAgentNotebooks for the taste block, again for the standing block), then bumped useCount
   through update(): readKey parse + writeJsonResilient's two more reads + two parses + a durable .bak copy + a durable
   main write. With 8 notebooks of 300 records that was 18 file reads, 18 parses and 4 fsyncs per run (33 ms p50 here).
   The comment above otherAgentNotebooks promised "the durable store's cache", which did not exist.

   Proves with the REAL memory store over the REAL durable store, fs and writeFileDurable (the index.js wiring):
     (1) getShared serves an unchanged notebook without touching the file again, and returns what get() returns;
     (2) the shared value is frozen (a consumer cannot poison the next run's read);
     (3) a write through the store, or a file replaced behind it, is re-read at once;
     (4) a .bak-recovered notebook is never cached (its loud onRecover path runs on every read);
     (5) the useCount bump is one durable write, the .bak is the previous version, and the main is parsed once;
     (6) index.js routes otherAgentNotebooks through getShared and reads the peers once per run. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fnBody } = require('./_fnbody.js');
const { makeMemoryStore } = require('../sidecar/memory-store.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const memcore = require('../sidecar/memcore.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nb-peers-'));
  try {
    const c = { reads: 0, writes: [] };
    const cfs = new Proxy(fs, { get(t, p) {
      if (p === 'readFileSync') return function () { c.reads++; return t.readFileSync.apply(t, arguments); };
      const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    const recovered = [];
    const store = makeMemoryStore({ fs: cfs, path, workspaces: root,
      writeDurable: (deps, file, data) => { c.writes.push(path.basename(file)); return writeFileDurable(deps, file, data); },
      onRecover: (key) => recovered.push(key) });
    const ids = ['agent', 'a1', 'a2', 'a3'];
    for (const id of ids) {
      const recs = [];
      for (let i = 0; i < 40; i++) recs.push({ id: 'n' + i, kind: 'note', content: id + ' fact ' + i, trust: 1, useCount: 0 });
      await store.update('notebook:' + id, () => recs);
    }

    // ---- (1) ----
    c.reads = 0;
    const first = ids.map(id => store.getShared('notebook:' + id));
    A.eq(c.reads, 4, 'the first peer pass reads each notebook once');
    c.reads = 0;
    const second = ids.map(id => store.getShared('notebook:' + id));
    A.eq(c.reads, 0, 'an unchanged notebook is served without re-reading the file (was a full read + parse every time)');
    A.ok(second.every((v, i) => v === first[i]), 'the same parsed value is shared');
    A.eq(JSON.stringify(second[1]), JSON.stringify(store.get('notebook:a1')), 'getShared returns exactly what get() returns');

    // ---- (2) ----
    A.ok(Object.isFrozen(second[1]) && Object.isFrozen(second[1][0]), 'the shared list and its records are frozen');
    A.throws(() => { 'use strict'; second[1][0].useCount = 99; }, 'a consumer mutating a shared record throws instead of poisoning the cache');
    A.throws(() => { 'use strict'; second[1].push({ id: 'x' }); }, 'nor can it grow the shared list');
    A.eq(store.getShared('notebook:a1')[0].useCount, 0, 'the next read is unpoisoned');
    A.eq(Object.isFrozen(store.get('notebook:a1')), false, 'get() stays an editable copy');

    // ---- (3) ----
    await store.update('notebook:a2', (cur) => cur.concat([{ id: 'n99', kind: 'note', content: 'new', trust: 1 }]));
    c.reads = 0;
    A.eq(store.getShared('notebook:a2').length, 41, 'a write through the store is visible on the next shared read');
    A.eq(c.reads, 1, 'only the written notebook was re-read');
    const a3File = path.join(root, 'a3.notebook.json');
    fs.writeFileSync(a3File + '.ext', JSON.stringify([{ id: 'z', kind: 'note', content: 'replaced', trust: 1 }]));
    fs.renameSync(a3File + '.ext', a3File);
    A.eq(store.getShared('notebook:a3')[0].content, 'replaced', 'a file replaced behind the store is re-read, never served stale');

    // ---- (4) ----
    await store.update('notebook:a1', (cur) => cur.slice());          // a second write gives a1 its .bak
    fs.writeFileSync(path.join(root, 'a1.notebook.json'), '{ torn');
    recovered.length = 0;
    const r1 = store.getShared('notebook:a1');
    const r2 = store.getShared('notebook:a1');
    A.ok(Array.isArray(r1) && r1.length === 40 && r2.length === 40, 'a torn main is recovered from .bak');
    A.eq(recovered.length, 2, 'and the recovery stays loud on every read (never cached)');

    // ---- (5) the useCount bump ----
    c.writes = []; c.reads = 0;
    const before = store.get('notebook:agent');
    c.reads = 0;
    await store.update('notebook:agent', (cur) => {
      let u = cur;
      for (const id of ['n1', 'n2']) u = memcore.reduceStats(u, { name: 'memory.used', payload: { id } }, { now: 77 });
      return u !== cur ? u : undefined;
    });
    A.eq(c.writes, ['agent.notebook.json'], 'the useCount bump is ONE durable write (the .bak is a link, not a second rewrite)');
    A.eq(c.reads, 2, 'the main is read once by update() and once by the write guard (was three reads + three parses)');
    const bak = JSON.parse(fs.readFileSync(path.join(root, 'agent.notebook.json.bak'), 'utf8'));
    A.eq(JSON.stringify(bak), JSON.stringify(before), 'the .bak is exactly the previous committed notebook');
    A.eq(store.getShared('notebook:agent').find(r => r.id === 'n1').useCount, 1, 'the bump landed');

    // ---- (6) the index.js wiring ----
    const src = readSidecarSource();
    const body = fnBody(src, 'function otherAgentNotebooks(agentId) {');
    A.ok(body.length > 50 && body.length < 2000, 'otherAgentNotebooks found');
    A.ok(/notebookStore\.getShared\('notebook:' \+ id\)/.test(body), 'otherAgentNotebooks reads through getShared');
    A.ok(!/notebookStore\.get\('notebook:' \+ id\)/.test(body), 'not through the uncached get()');
    const peerCalls = src.split('otherAgentNotebooks(agentId)').length - 2;   // minus the declaration itself
    A.ok(peerCalls <= 3, 'each run site reads the peers once (' + peerCalls + ' call sites, was 5)');
    A.ok(!src.split('\n').some(l => /FeedbackMemory\.station(Taste|Standing)\(all, otherAgentNotebooks\(agentId\)/.test(l)), 'the run recall path shares one peer read between taste and standing');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('notebook-peer-reads.test');
})().catch(e => { console.error(e); process.exit(1); });
