'use strict';
/* node test/save-pre-history-ref.http.test.js — THE OLDER STATION FILE KEPT AT THE v7 UPGRADE, THROUGH A REAL SIDECAR
   (save-history-by-reference, step S3; the wiring of test/save-history-ref.engines.test.js's store cases).

   Save v7 lets a history name rows by reference, so the first save that takes the station file from v6 to v7 keeps the v6 file
   (agent.save.pre-history-ref.json) as the way back after a downgrade. That copy holds every conversation, so it must not outlive a
   delete, and it must not outlive its purpose. Over POST /api/save on a hermetic sidecar (temp workspace, real index.js wiring):
     · v6 saves keep nothing; the first v7 save keeps the v6 file, stamped, and the sidecar log names it;
     · the Commander deletes a conversation (the save's forgetIds): the sidecar's deleted-session pass cuts it, its ~restored copy
       and its undo rows out of the kept file, and the conversations that were not deleted stay;
     · the copy goes 30 days after it was kept, once the v7 main has read back: a sidecar that boots with a copy older than that
       removes it, one with a younger copy leaves it. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { readSidecarSource } = require('./helpers/source.js');
const ForgetWiring = require('../sidecar/forget-wiring.js');
const SessionTombstones = require('../sidecar/session-tombstones.js');

const KEPT = 'agent.save.pre-history-ref.json';
const SECRET = 'a-conversation-the-commander-deletes';
const DAY = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, ms) {
  const end = Date.now() + (ms || 20000);
  for (;;) { if (check()) return; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
}
const session = (id, text) => ({ id, title: id, agentId: 'agent', createdAt: 1, lastActiveAt: 2, history: [{ role: 'user', content: text }] });
const envelope = (version, revision, workstreams, extra) => Object.assign({ schema: 'starnet.save', version, updatedAt: Date.now(), _saveRevision: revision, _saveClient: 'tab1',
  agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, generalId: 'general', activeId: 'general', deletedIds: [], forgetIds: [], workstreams }, extra || null);

(async () => {
  /* THE FORGET REGISTRY OWNS THIS COPY (turn identity commit 12 adopted). The kept file follows a delete through the registered
     'save-pre-history-ref' entry, not a private call in forgetDeletedSessionMemory: RED when the entry is absent or a private
     scrubKept is the only path. */
  {
    const calls = [];
    const entries = new Map(), registry = { register: e => { entries.set(e.name, e); return e.name; }, exempt() {}, names: () => Array.from(entries.keys()) };
    ForgetWiring.wireForgetRegistry(registry, { saveStore: () => ({ scrubKept: ids => { calls.push(ids.slice()); return { files: 1, removed: 0, sessions: ids.length }; } }) });
    assert.ok(registry.names().includes('save-pre-history-ref'), 'the kept pre-v7 copy is a registered forget entry');
    const removed = await entries.get('save-pre-history-ref').forget(SessionTombstones.deletedScope([{ id: 'gone', at: 50 }, { id: 'gone2', at: 60 }], []));
    assert.deepEqual(calls, [['gone', 'gone2']], 'a forget pass calls the entry once with the deleted sessions');
    assert.equal(removed, 2, 'and counts what it cut');
    const body = readSidecarSource();
    assert.ok(!body.includes('saveStore.scrubKept('), 'no private scrubKept call is left beside the registry');
    assert.ok(body.includes('forgetRegistry.forgetAll(SessionTombstones.deletedScope('), 'the deleted-session pass goes through the registry');
  }
  const fixture = SidecarFixture.create({ prefix: 'pre-history-ref-' });
  const kept = () => path.join(fixture.workspace, KEPT);
  const readKept = () => JSON.parse(fs.readFileSync(kept(), 'utf8'));
  try {
    await fixture.start();
    const all = [session('general', 'hello'), session('keep', 'keep me'), session('gone', SECRET), session('gone~restored', SECRET + ' restored')];
    const undo = { kind: 'clear', at: 90, rows: [session('gone', SECRET + ' undo'), session('keep', 'keep me')] };
    const v6 = await fixture.json('POST', '/api/save', envelope(6, 0, all, { sessionUndo: undo }));
    assert.equal(v6.body.ok, true, 'a v6 station lands');
    assert.equal(fs.existsSync(kept()), false, 'a v6 save keeps nothing');
    const v7 = await fixture.json('POST', '/api/save', envelope(7, v6.body.revision, all, { sessionUndo: undo }));
    assert.equal(v7.body.ok, true, 'the first v7 save lands');
    assert.equal(fs.existsSync(kept()), true, 'the first v7 save keeps the older station file');
    const first = readKept();
    assert.equal(first.doc.version, 6, 'it is the v6 file');
    assert.deepEqual(first.doc.workstreams.map(w => w.id), ['general', 'keep', 'gone', 'gone~restored'], 'with every conversation of it');
    assert.ok(first.keptAt > 0 && first.keptAt <= Date.now(), 'stamped with when it was kept');
    assert.ok(fixture.output().includes(KEPT), 'the sidecar log names the file it kept');
    const after = await fixture.json('POST', '/api/save', envelope(7, v7.body.revision, all.slice(0, 2), { deletedIds: [], forgetIds: [] }));
    assert.equal(after.body.ok, true);
    assert.equal(readKept().doc.workstreams.length, 4, 'a later v7 save leaves it alone');

    // the Commander deletes a conversation: it is cut out of the kept copy, behind the reply
    const del = await fixture.json('POST', '/api/save', envelope(7, after.body.revision, all.slice(0, 2), { deletedIds: ['gone'], forgetIds: ['gone'] }));
    assert.equal(del.body.ok, true, 'the delete lands');
    await until(() => fs.existsSync(kept()) && !fs.readFileSync(kept(), 'utf8').includes(SECRET), 'the deleted conversation to leave the kept copy');
    const cut = readKept();
    assert.deepEqual(cut.doc.workstreams.map(w => w.id), ['general', 'keep'], 'the deleted conversation and its ~restored copy are cut out; the others stay');
    assert.deepEqual(cut.doc.sessionUndo.rows.map(w => w.id), ['keep'], 'and its row in the undo checkpoint');
    assert.equal(cut.keptAt, first.keptAt, 'the 30 days still count from when it was kept');
    assert.equal(fs.readdirSync(fixture.workspace).filter(n => /pre-history-ref/.test(n) && n !== KEPT).length, 0, 'no .bak or temp of the copy is left (a .bak would keep the deleted chat)');

    // 30 days after it was kept, once the v7 main has read back, a booting sidecar removes it; a younger copy stays
    await fixture.stop();
    fs.writeFileSync(kept(), JSON.stringify(Object.assign({}, cut, { keptAt: Date.now() - 29 * DAY })));
    await fixture.start();
    assert.equal(fs.existsSync(kept()), true, 'a copy kept 29 days ago stays');
    await fixture.stop();
    fs.writeFileSync(kept(), JSON.stringify(Object.assign({}, cut, { keptAt: Date.now() - 31 * DAY })));
    await fixture.start();
    assert.equal(fs.existsSync(kept()), false, 'a copy kept 31 days ago is removed when the sidecar boots');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'agent.save.json'), 'utf8')).doc.version, 7, 'the v7 station file is untouched');
    console.log('save pre-history-ref HTTP: kept once before the first v7 replace, cut on delete, gone after 30 days PASS');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exit(1); });
