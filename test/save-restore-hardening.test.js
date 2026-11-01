/* node test/save-restore-hardening.test.js — the preserved-save RESTORE after the second hostile review (10-23, lane
   save-restore-1023). Each case reproduces a review proof against the REAL code (test/_save-restore-kit.js: cloudsave.js in
   a vm -> the real /api/save + /api/save/conflicts handlers sliced out of sidecar/index.js -> the real savestore on a temp
   workspace, and the real boot offer + banner sliced out of stationui.js):

     r1. RESTORE BACKUP's erase-authority exemption ends when the station answers the import: an import refused as a conflict
         never lets that window's later autosave write a pre-reset station over a fresh one (attack2); an import whose send
         got no answer still lands on the empty file when it is sent again;
     r2. a window that kept working in a session after it was CLEARED gets those turns back (the cleared ones never)
         (attack3); a restore that brings nothing back never retires the window or drops its browser copy;
     r3. the deleted-session ledger is time-scoped: a REVIVED session's newer turns come back (attack4);
     r4. an erased-work snapshot (from before a reset) is settled, so it never starves an older restorable one (attack5),
         and the page asks again while the station says `more`, so the offer appears on the same boot;
     r5. the boot offer's settled memo is DURABLE: a fresh sidecar per app launch reaches an older restorable copy (proofA),
         also after the newest one was restored (proofA2), reads nothing once all is settled (proofC), and starts over when
         the station is put back to an older state;
     r6. "Not now" is a watermark: no older copy brings the banner back, a newer one does (proofB);
     r7. a window whose own re-seed was overtaken by another window's save is told another window saved (proofE). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const K = require('./_save-restore-kit.js');
const { workspace, turn, stationDoc, receipt, steppingDate, countingFs, sidecar, page, stationUi } = K;

const big = n => Array.from({ length: n }, (_, i) => ({ id: 'ws' + i, title: 'session ' + i, createdAt: 1000 + i, lastActiveAt: 2000 + i,
  history: [turn('user', 'q'.repeat(300) + i), turn('assistant', 'a'.repeat(600) + i)] }));
const touch = (root, name, sec) => fs.utimesSync(path.join(root, name), sec, sec);

(async () => {
  try {
    // ================= r1. the import's exemption ends when the station answers it =================
    {
      const root = workspace();
      const ref = { host: sidecar(root) };
      const proxy = { fetch: (u, o) => ref.host.fetch(u, o) };
      const cacheB = new Map(); const B = page(proxy, cacheB);
      await B.reconcile(null);
      let docB = stationDoc({ agent: { id: 'agent', name: 'OLD', createdAt: 5000 }, updatedAt: Date.now() });
      cacheB.set('starnet.save', JSON.stringify(docB)); B.push(docB); await B.flush({ force: true });
      const cacheA = new Map(); const W = page(proxy, cacheA);
      await W.reconcile(null);
      docB = JSON.parse(JSON.stringify(docB)); docB.updatedAt = Date.now() + 1; docB.workstreams.push({ id: 'b-1', history: [turn('user', 'b')] });
      cacheB.set('starnet.save', JSON.stringify(docB)); B.push(docB); await B.flush({ force: true });   // window W is now behind
      const imported = stationDoc({ agent: { id: 'agent', name: 'OLD-BACKUP', createdAt: 5000 }, updatedAt: Date.now() + 2,
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'from-backup', history: [turn('user', 'x')] }] });
      cacheA.set('starnet.save', JSON.stringify(imported)); W.push(imported, { restore: true });
      A.eq(await W.flush({ force: true }), false, 'r1: the import from a window that is behind is refused');
      A.ok(W.health().conflict && W.health().conflict.conflict === true && !W.health().conflict.reset, 'r1: as an ordinary conflict');
      // START FRESH from another window: the station's files leave the workspace, the receipt is written, the sidecar restarts
      for (const n of fs.readdirSync(root)) if (n.startsWith('agent.save')) fs.unlinkSync(path.join(root, n));
      receipt(root, Date.now());
      ref.host = sidecar(root);
      const next = JSON.parse(JSON.stringify(imported)); next.updatedAt = Date.now() + 10; next.workstreams.push({ id: 'a-later', history: [turn('user', 'later')] });
      cacheA.set('starnet.save', JSON.stringify(next)); W.push(next);
      A.eq(await W.flush({ force: true }), false, 'r1: that window\'s next autosave after START FRESH is refused');
      A.ok(W.health().conflict && W.health().conflict.reset === true, 'r1: as a reset (' + JSON.stringify(W.health().conflict) + ')');
      A.eq(ref.host.saveStore.load('agent'), undefined, 'r1: the fresh workspace stays empty: the pre-reset station never writes itself back');
    }
    {
      // an import whose first send got NO answer (an outage) is still the Commander's import when it is sent again
      const root = workspace();
      receipt(root, Date.now());
      const host = sidecar(root);
      let failNext = 1;
      const flaky = { fetch: (u, o) => (o && o.method === 'POST' && failNext-- > 0) ? Promise.reject(new Error('offline')) : host.fetch(u, o) };
      const cache = new Map(); const P = page(flaky, cache);
      const backupDoc = stationDoc({ agent: { id: 'agent', name: 'OLD-BACKUP', createdAt: 5000 }, updatedAt: Date.now(), workstreams: [{ id: 'general', title: null, history: [turn('user', 'from the backup')] }] });
      cache.set('starnet.save', JSON.stringify(backupDoc)); P.push(backupDoc, { restore: true });
      A.eq(await P.flush({ force: true }), false, 'r1: the import\'s first send gets no answer');
      A.eq(await P.flush({ force: true }), true, 'r1: sent again, the import lands on the empty file of the reset workspace');
      A.eq(host.saveStore.load('agent').agent.name, 'OLD-BACKUP', 'r1: the station is the imported backup');
    }

    // ================= r2. work typed after a CLEAR comes back; a restore of nothing never drops this window =================
    // (a station that refuses the merge, so the conflict stands and its RESTORE is what is tested; the in-session merge runs
    // the same save-restore plan: test/save-interleave.seeded.test.js)
    {
      const root = workspace();
      const host = sidecar(root, { noMerge: true });
      const T0 = Date.now();
      host.saveStore.save('agent', stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] },
        { id: 'X', title: 'Payroll', createdAt: T0 - 1000, lastActiveAt: T0 - 500, history: [turn('user', 'o1 (cleared)'), turn('assistant', 'o2 (cleared)')] }] }), { compareRevision: true });
      const cacheB = new Map(); let newestB = null, B = null;
      const AppB = { persist() { if (newestB) { const d = JSON.parse(JSON.stringify(newestB)); d._saveDirty = true; d._saveRevision = B.revision(); cacheB.set('starnet.save', JSON.stringify(d)); B.push(d); } } };
      B = page(host, cacheB, { App: AppB });
      const bootB = await B.reconcile(null);
      // another window clears X (exactly what Workstreams.clearConversation leaves) and that save lands
      const T1 = T0 + 1000;
      const cleared = JSON.parse(JSON.stringify(host.saveStore.load('agent')));
      const x = cleared.workstreams.find(w => w.id === 'X');
      cleared.sessionUndo = { kind: 'clear', at: T1, activeId: 'X', rows: [{ id: 'X', history: x.history }], count: 1 };
      x.history = []; x.lastActiveAt = T1; cleared.updatedAt = T1; cleared._saveClient = 'w1';
      A.ok(host.saveStore.save('agent', cleared, { compareRevision: true }).ok, 'r2: the clear lands');
      // window B, behind, types b1 in X after the clear; its save is preserved; B clicks "Restore this window's sessions"
      newestB = JSON.parse(JSON.stringify(bootB)); newestB.updatedAt = T1 + 1000;
      const bx = newestB.workstreams.find(w => w.id === 'X'); bx.history.push(turn('user', 'b1 typed AFTER the clear')); bx.lastActiveAt = T1 + 1000;
      AppB.persist();
      A.eq(await B.flush({ force: true }), false, 'r2: B\'s save is refused and preserved');
      const r = await B.restoreConflict(B.health().conflict.recovery);
      A.ok(r && r.ok === true && r.extended === 1, 'r2: the restore brings X\'s new turn back (' + JSON.stringify(r) + ')');
      const X = host.saveStore.load('agent').workstreams.find(w => w.id === 'X');
      A.eq(X.history.map(t => t.content), ['b1 typed AFTER the clear'], 'r2: X holds the turn typed after the clear, and none of the cleared turns');
      A.ok(!JSON.stringify(host.saveStore.load('agent').workstreams).includes('(cleared)'), 'r2: no cleared turn is in any session');
    }
    {
      // a restore that brings NOTHING back (this window's own copy holds nothing the station lacks): the window keeps its work
      // (a station that refuses the merge: the conflict stands, so the restore is what is tested)
      const root = workspace();
      const host = sidecar(root, { noMerge: true });
      host.saveStore.save('agent', stationDoc({ updatedAt: Date.now() }), { compareRevision: true });
      const cache = new Map(); const P = page(host, cache);
      const boot = await P.reconcile(null);
      host.saveStore.save('agent', Object.assign({}, host.saveStore.load('agent'), { updatedAt: Date.now() + 1, _saveClient: 'other',
        workstreams: host.saveStore.load('agent').workstreams.concat([{ id: 'other-work', history: [turn('user', 'o')] }]) }), { compareRevision: true });
      const mine = JSON.parse(JSON.stringify(boot)); mine.updatedAt = Date.now() + 2; mine.activeId = 'general';   // no new session
      cache.set('starnet.save', JSON.stringify(mine)); P.push(mine);
      A.eq(await P.flush({ force: true }), false, 'r2: the window is behind: its save is preserved');
      let threw = null;
      try { await P.restoreConflict(P.health().conflict.recovery); } catch (e) { threw = e.message; }
      A.ok(threw && /nothing was restored/i.test(threw), 'r2: the restore says nothing came back (' + threw + ')');
      A.eq(P._reloads.length, 0, 'r2: the window is not reloaded');
      A.ok(cache.has('starnet.save'), 'r2: and keeps its browser copy');
      const later = JSON.parse(JSON.stringify(mine)); later.updatedAt = Date.now() + 3; later.workstreams.push({ id: 'typed-after', history: [turn('user', 'still saving')] });
      cache.set('starnet.save', JSON.stringify(later)); P.push(later);
      await P.flush({ force: true });
      A.ok(fs.readFileSync(path.join(root, P.health().conflict.recovery), 'utf8').includes('still saving'), 'r2: and is not retired: its next save is still kept');
    }

    // ================= r3. a REVIVED session's newer turns come back (the ledger is time-scoped) =================
    {
      const root = workspace();
      const stamp = { R: 3000, gone: 3000 };
      const tombstones = { deletedAt: id => stamp[id] || 0, forgotten: (id, ts) => (stamp[id] || 0) > 0 && Number(ts) <= stamp[id] };
      const host = sidecar(root, { tombstones });
      host.saveStore.save('agent', stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] },
        { id: 'R', title: 'Briefing', createdAt: 1000, lastActiveAt: 4000, history: [turn('user', 'r1')] }] }), { compareRevision: true });
      const pre = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1500, _saveClient: 'window-r', workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] },
        { id: 'R', title: 'Briefing', createdAt: 1000, lastActiveAt: 4500, history: [turn('user', 'r1'), turn('user', 'r2 typed in the stale window')] },
        { id: 'gone', title: 'Deleted', createdAt: 1000, lastActiveAt: 2500, history: [turn('user', 'deleted on purpose')] }] }), { compareRevision: true });
      A.eq((await host.conflicts()).conflicts.map(c => c.restorable), [1], 'r3: the revived session counts; the one deleted after its last use does not');
      const r = await host.restore(pre.recovery);
      A.ok(r.ok === true && r.extended === 1 && r.added === 0, 'r3: the restore extends the revived session (' + JSON.stringify(r) + ')');
      const ids = host.saveStore.load('agent').workstreams.map(w => w.id);
      A.eq(host.saveStore.load('agent').workstreams.find(w => w.id === 'R').history.length, 2, 'r3: with the stale window\'s turn');
      A.ok(!ids.includes('gone'), 'r3: and the deleted one stays deleted (' + ids + ')');
    }

    // ================= r4. an erased-work snapshot never starves an older restorable one =================
    {
      const root = workspace();
      receipt(root, 7000);
      let host = sidecar(root, { Date: steppingDate(40) });
      const fresh = stationDoc({ agent: { id: 'agent', name: 'FRESH', createdAt: 8000 }, workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }].concat(big(50)) });
      host.saveStore.save('agent', fresh, { compareRevision: true });
      const v = JSON.parse(JSON.stringify(fresh)); v._saveRevision = 0; v._saveClient = 'window-v'; v.updatedAt = 9000; v.workstreams.push({ id: 'v-work', title: 'V', history: [turn('user', 'v')] });
      A.ok(host.saveStore.save('agent', v, { compareRevision: true }).conflict, 'r4: window V of the fresh station is preserved');
      const old = JSON.parse(JSON.stringify(fresh)); old.agent = { id: 'agent', name: 'OLD', createdAt: 5000 }; old._saveRevision = 42; old._saveClient = 'old-tab'; old.updatedAt = 9999;
      A.ok(host.saveStore.save('agent', old, { compareRevision: true }).predatesReset === true, 'r4: a stale pre-reset tab\'s copy is erased work');
      const t = Date.now() / 1000;
      touch(root, 'agent.save-conflict-window-v.json', t - 600); touch(root, 'agent.save-conflict-old-tab.json', t - 60);   // the erased copy is the NEWEST
      const first = await host.conflicts();
      A.ok(first.more === true && first.conflicts.length === 1 && first.conflicts[0].predatesReset === true, 'r4: a slow boot reads the erased copy and stops for time (' + JSON.stringify(first) + ')');
      host = sidecar(root, { Date: steppingDate(40) });   // the next app launch: a fresh sidecar
      const second = await host.conflicts();
      A.ok(second.conflicts.some(c => c.file === 'agent.save-conflict-window-v.json' && c.restorable === 1), 'r4: the next launch reaches the older restorable copy (' + JSON.stringify(second) + ')');
      // and the page itself asks again while the station says `more`: on ONE boot the offer appears
      fs.rmSync(path.join(root, 'agent.save-offer-settled.json'), { force: true });   // forget the launches above
      host = sidecar(root, { Date: steppingDate(40) });
      const banner = await stationUi(page(host, new Map()), {}).offer();
      A.ok(banner && /1 session/.test(banner.children[0].textContent), 'r4: the boot offer appears on the first boot (' + (banner && banner.children[0].textContent) + ')');
    }

    // ================= r5. the settled memo is durable across app launches =================
    {
      // proofA: the NEWEST copy holds nothing new; an OLDER one holds 5 lost sessions; one snapshot per request
      const root = workspace();
      let host = sidecar(root, { Date: steppingDate(40) });
      const st = stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }].concat(big(50)) });
      host.saveStore.save('agent', st, { compareRevision: true });
      const older = JSON.parse(JSON.stringify(st)); older._saveRevision = 0; older._saveClient = 'older-window'; older.updatedAt = 3000;
      for (let k = 0; k < 5; k++) older.workstreams.push({ id: 'lost' + k, title: 'lost work ' + k, history: [turn('user', 'only in the older window ' + k)] });
      host.saveStore.save('agent', older, { compareRevision: true });
      const newer = JSON.parse(JSON.stringify(st)); newer._saveRevision = 0; newer._saveClient = 'newer-window'; newer.updatedAt = 4000;
      host.saveStore.save('agent', newer, { compareRevision: true });
      const t = Date.now() / 1000;
      touch(root, 'agent.save-conflict-older-window.json', t - 3600); touch(root, 'agent.save-conflict-newer-window.json', t - 60);
      const offered = [];
      for (let launch = 1; launch <= 3; launch++) {
        host = sidecar(root, { Date: steppingDate(40) });
        const o = (await host.conflicts()).conflicts.find(c => c.restorable > 0);
        offered.push(o ? o.file + ':' + o.restorable : 'none');
      }
      A.eq(offered, ['none', 'agent.save-conflict-older-window.json:5', 'agent.save-conflict-older-window.json:5'], 'r5: from the second launch on, the older copy\'s 5 lost sessions are offered (proofA)');
    }
    {
      // proofA2: two copies with DIFFERENT lost work; launch 1 offers the newer one and it is restored; later launches offer the older
      const root = workspace();
      let host = sidecar(root, { Date: steppingDate(40) });
      const st = stationDoc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }].concat(big(50)) });
      host.saveStore.save('agent', st, { compareRevision: true });
      const mk = (client, extra) => { const c = JSON.parse(JSON.stringify(st)); c._saveRevision = 0; c._saveClient = client; c.updatedAt = 3000; c.workstreams.push(extra); return c; };
      host.saveStore.save('agent', mk('older', { id: 'older-lost', title: 'Q3 plan', history: [turn('user', 'only in the older window')] }), { compareRevision: true });
      host.saveStore.save('agent', mk('newer', { id: 'newer-lost', title: 'Invoice', history: [turn('user', 'only in the newer window')] }), { compareRevision: true });
      const t = Date.now() / 1000;
      touch(root, 'agent.save-conflict-older.json', t - 600); touch(root, 'agent.save-conflict-newer.json', t - 300);
      host = sidecar(root, { Date: steppingDate(40) });
      const first = (await host.conflicts()).conflicts.find(c => c.restorable > 0);
      A.eq(first && first.file, 'agent.save-conflict-newer.json', 'r5: launch 1 offers the newer copy');
      A.ok((await host.restore(first.file)).added === 1, 'r5: and it is restored');
      const reads = { station: 0, snapshot: 0 };
      const offers = [];
      for (let launch = 2; launch <= 4; launch++) {
        host = sidecar(root, { Date: steppingDate(40), fs: countingFs(reads) });
        const o = (await host.conflicts()).conflicts.find(c => c.restorable > 0);
        offers.push(o ? o.file : 'none');
      }
      A.eq(offers, ['agent.save-conflict-older.json', 'agent.save-conflict-older.json', 'agent.save-conflict-older.json'], 'r5: every later launch offers the older copy (proofA2)');
      A.eq(reads.snapshot, 3, 'r5: the restored copy is never read again: one snapshot per launch, the older one');
      // proofC: once the older one is restored too, a launch reads no snapshot and not even the station
      A.ok((await host.restore('agent.save-conflict-older.json')).added === 1, 'r5: the older copy is restored');
      reads.station = 0; reads.snapshot = 0;
      host = sidecar(root, { fs: countingFs(reads) });
      A.eq((await host.conflicts()).conflicts, [], 'r5: nothing is left to offer');
      A.eq([reads.station, reads.snapshot], [0, 0], 'r5: and a launch reads nothing at all (proofC)');
      // the station is put back to an older state (an explicit RESTORE BACKUP): every verdict starts over
      const cur = host.saveStore.load('agent');
      const back = Object.assign({}, st, { _saveRevision: cur._saveRevision, updatedAt: Date.now(), _saveClient: 'import-page', _saveRestore: true });
      A.ok(host.saveStore.save('agent', back, { compareRevision: true }).ok, 'r5: a backup from before both restores is imported');
      host = sidecar(root);
      const again = [];
      for (let ask = 0; ask < 3; ask++) { const j = await host.conflicts(); again.push(...j.conflicts.filter(c => c.restorable > 0).map(c => c.file)); if (!j.more) break; }
      A.eq(again, ['agent.save-conflict-newer.json'], 'r5: after it, the preserved copies are offered again (their sessions are missing again)');
    }
    {
      // an ordinary autosave keeps the verdicts (the station only moved forward)
      const root = workspace();
      let host = sidecar(root);
      host.saveStore.save('agent', stationDoc(), { compareRevision: true });
      host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1500, _saveClient: 'same' }), { compareRevision: true });
      A.eq((await host.conflicts()).conflicts.map(c => c.restorable), [0], 'r5: a copy with nothing new is listed once');
      const cur = host.saveStore.load('agent');
      host.saveStore.save('agent', Object.assign({}, cur, { updatedAt: Date.now(), workstreams: cur.workstreams.concat([{ id: 'n', history: [turn('user', 'n')] }]) }), { compareRevision: true });
      const reads = { station: 0, snapshot: 0 };
      host = sidecar(root, { fs: countingFs(reads) });
      A.eq([(await host.conflicts()).conflicts, reads.snapshot], [[], 0], 'r5: after an ordinary autosave and a restart it is still settled');
    }

    // ================= r6. "Not now" is a watermark =================
    {
      const root = workspace();
      const host = sidecar(root);
      host.saveStore.save('agent', stationDoc({ updatedAt: Date.now() }), { compareRevision: true });
      const lostX = { id: 'lost-x', title: 'X', history: [turn('user', 'x')] };
      const older = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1500, _saveClient: 'window-old',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, lostX] }), { compareRevision: true });
      const newer = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1600, _saveClient: 'window-new',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, lostX, { id: 'lost-y', title: 'Y', history: [turn('user', 'y')] }] }), { compareRevision: true });
      const t = Date.now() / 1000;
      touch(root, older.recovery, t - 600); touch(root, newer.recovery, t - 300);
      const uiStore = {};
      const boot1 = await stationUi(page(host, new Map()), uiStore).offer();
      A.ok(boot1 && /2 sessions/.test(boot1.children[0].textContent), 'r6: boot 1 offers the newer copy');
      boot1.children.find(n => n.textContent === 'Not now').onclick();
      A.eq(await stationUi(page(host, new Map()), uiStore).offer(), null, 'r6: after Not now, the next boot offers nothing: not the older copy holding the same declined session (proofB)');
      const newest = host.saveStore.save('agent', stationDoc({ _saveRevision: 0, updatedAt: 1700, _saveClient: 'window-later',
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'lost-z', title: 'Z', history: [turn('user', 'z')] }] }), { compareRevision: true });
      touch(root, newest.recovery, t);
      const boot3 = await stationUi(page(host, new Map()), uiStore).offer();
      A.ok(boot3 && /1 session/.test(boot3.children[0].textContent), 'r6: a copy saved after the dismissal is offered');
    }

    // ================= r7. a re-seed overtaken by another window's save: "another window saved" =================
    {
      const root = workspace();
      const host = sidecar(root, { noMerge: true });   // one sidecar process: no restart; it refuses the merge, so the conflict and its words stand
      const seed = host.saveStore.save('agent', stationDoc({ _saveRevision: 23, updatedAt: 9000, _saveClient: 'window-a' }), { compareRevision: true });
      A.ok(seed.ok && seed.seeded, 'r7: window A re-seeds the empty file (its ACK is lost)');
      const loaded = host.saveStore.load('agent');
      A.ok(host.saveStore.save('agent', Object.assign({}, loaded, { updatedAt: 9500, _saveClient: 'window-b',
        workstreams: loaded.workstreams.concat([{ id: 'b-work', title: 'B', history: [turn('user', 'newer work in B')] }]) }), { compareRevision: true }).ok, 'r7: window B saves newer changes on top');
      const asA = { fetch: (url, opts) => host.fetch(url, opts && opts.body ? Object.assign({}, opts, { body: opts.body.replace(/"_saveClient":"[^"]*"/, '"_saveClient":"window-a"').replace(/"_saveRevision":\d+/, '"_saveRevision":23') }) : opts) };
      const pa = page(asA, new Map());
      pa.push(stationDoc({ updatedAt: 9600, workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi'), turn('assistant', 'A kept going')] }] }));
      A.eq(await pa.flush({ force: true }), false, 'r7: window A\'s next save is refused');
      A.ok(!pa.health().conflict.ownSeed, 'r7: not as its own seed: another window\'s save is the station\'s newest');
      const light = stationUi(pa).light();
      A.ok(/another window saved newer/i.test(light.title) && !/restart/i.test(light.title), 'r7: the banner says another window saved, and no restart (' + light.title + ')');
    }

    // the review's cleared-then-continued case (proofD) needs a SECOND clear to push the first out of the one-slot checkpoint.
    // Nothing in the app clears a conversation any more (SESSION TOOLS' clear retired 2026-07-17, 83292661a; /clear opens a
    // new session): this pins that premise, so wiring a clear back in brings the restore planner's clear rule back to review
    {
      const callers = fs.readdirSync(path.join(K.repo, 'frontend', 'app')).filter(n => /\.js$/.test(n) && n !== 'workstreams.js')
        .filter(n => /clearConversation\s*\(/.test(fs.readFileSync(path.join(K.repo, 'frontend', 'app', n), 'utf8')));
      A.eq(callers, [], 'proofD premise: no shipped page code clears a conversation (a clear must come back with a durable per-session clear time for save-restore.js)');
    }
  } finally {
    K.cleanup();
  }
  A.report('save-restore-hardening');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
