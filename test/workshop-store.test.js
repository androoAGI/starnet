/* node test/workshop-store.test.js — the durable per-agent AWAY WORKSHOP store (grant + backlog + denylist).

   Proves grant persistence round-trips, the backlog queue is idempotent + FIFO-capped, claim/build/release track
   the building runId, and DISCARD both removes the item AND permanently denylists its backlogId so it is never
   silently re-queued (the memory-question "discard = never again" invariant, ported). Runs against an in-memory
   fs so it needs no disk and stays deterministic (timestamps are injected). */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeWorkshopStore, normalize } = require('../sidecar/workshop-store.js');

// ---- a tiny in-memory fs sufficient for durable-store (readFileSync/writeFileSync/rename/mkdirSync/...) ----
function memFs() {
  const files = new Map();
  return {
    _files: files,
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); },
    mkdirSync() {},
    unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
}
// a durable-write shim that just does the atomic replace over the mem fs (no real fsync).
const writeDurable = ({ fs }, file, data) => { fs.writeFileSync(file, data); };

function freshStore() {
  return makeWorkshopStore({ fs: memFs(), path: path, workspaces: '/ws', writeDurable });
}

(async () => {
  // ---- 1. grant defaults false, round-trips true, and a fresh store over the SAME fs reads it back ----
  {
    const fs = memFs();
    const s1 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    A.ok(s1.hasGrant('hero') === false, 'grant defaults to false for a brand-new agent');
    await s1.setGrant('hero', true);
    A.ok(s1.hasGrant('hero') === true, 'grant reads back true after setGrant');
    const s2 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });   // fresh instance, same disk
    A.ok(s2.hasGrant('hero') === true, 'grant SURVIVES a fresh store (persisted, restart-safe)');
    await s2.setGrant('hero', false);
    A.ok(s2.hasGrant('hero') === false, 'grant flips back to false');
  }

  // ---- 1b. grantIfUndecided (autonomy-dial path): grants when undecided, NEVER overrides an explicit decision ----
  {
    const fs = memFs();
    const s = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    // undecided (no record at all) → the dial records the grant
    const g1 = await s.grantIfUndecided('hero');
    A.ok(g1.granted === true && g1.changed === true, 'dial path grants a never-decided agent (changed:true)');
    A.ok(s.hasGrant('hero') === true, 'the auto-grant reads back true');
    A.ok(s.read('hero').grantAuto === true && s.read('hero').grantExplicit === false, 'the grant is marked auto, not explicit');
    // idempotent: a second dial write changes nothing
    const g2 = await s.grantIfUndecided('hero');
    A.ok(g2.granted === true && g2.changed === false, 'a repeat dial write is a no-op (changed:false)');
    // survives a fresh store over the same disk (restart-safe)
    const s2 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    A.ok(s2.hasGrant('hero') === true && s2.read('hero').grantAuto === true, 'auto-grant + provenance SURVIVE a fresh store');
    // an EXPLICIT revoke wins over the dial, permanently
    await s2.setGrant('hero', false);
    const g3 = await s2.grantIfUndecided('hero');
    A.ok(g3.granted === false && g3.changed === false, 'the dial NEVER overrides an explicit OFF');
    A.ok(s2.hasGrant('hero') === false, 'the explicit revoke stands after a dial write');
    // an explicit ON also stays explicit (dial no-ops over it)
    await s2.setGrant('hero', true);
    const g4 = await s2.grantIfUndecided('hero');
    A.ok(g4.granted === true && g4.changed === false && s2.read('hero').grantExplicit === true, 'an explicit ON is untouched by the dial');
  }

  // ---- 2. queue: idempotent by id, denylisted ids refused, FIFO order preserved, returns { item, reason } ----
  {
    const s = freshStore();
    const a = await s.queue('hero', { id: 'b1', title: 'Build a CSV cleaner', source: 'queued' }, 1000);
    A.ok(a && a.item && a.item.id === 'b1' && a.reason === 'added', 'queue returns { item, reason:added }');
    const dup = await s.queue('hero', { id: 'b1', title: 'again' }, 2000);
    A.ok(dup.reason === 'exists' && dup.item.title === 'Build a CSV cleaner', 'idempotent by id (reason:exists, keeps the first)');
    await s.queue('hero', { id: 'b2', title: 'second' }, 3000);
    const bl = s.backlogOf('hero');
    A.eq(bl.map(x => x.id), ['b1', 'b2'], 'backlog preserves FIFO insertion order');
  }

  // ---- 2b. DEDUP BY NORMALIZED TITLE: never re-create work that already exists (mint-ledger doctrine) ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'x1', title: 'Build a CSV Cleaner' }, 1);
    const dupTitle = await s.queue('hero', { id: 'x2', title: '  build   a csv cleaner ' }, 2);   // same normalized title, diff id
    A.ok(dupTitle.reason === 'duplicate', 'a same-normalized-title add is rejected as a duplicate');
    A.ok(dupTitle.item && dupTitle.item.id === 'x1', 'duplicate returns the EXISTING lined-up item');
    A.eq(s.backlogOf('hero').map(x => x.id), ['x1'], 'the duplicate never enters the backlog');
    // a genuinely different title still queues
    const diff = await s.queue('hero', { id: 'x3', title: 'Build a JSON validator' }, 3);
    A.ok(diff.reason === 'added', 'a distinct title still queues normally');
  }

  // ---- 2c. a DISCARDED title cannot be re-queued under a fresh id ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'd1', title: 'Write the onboarding doc' }, 1);
    await s.discard('hero', 'd1');
    const reId = await s.queue('hero', { id: 'd2', title: 'write the ONBOARDING doc' }, 2);   // same work, new id
    A.ok(reId.reason === 'discarded' && reId.item === null, 'a discarded title is refused even under a fresh id');
    A.eq(s.backlogOf('hero').length, 0, 'the discarded work never re-enters the backlog');
  }

  // ---- 3. claimNext pops the top un-built item and stamps the building runId; empty queue -> null ----
  {
    const s = freshStore();
    A.ok((await s.claimNext('nobody', 'runX')) === null, 'claimNext on an empty backlog returns null (silent no-op)');
    await s.queue('hero', { id: 'b1', title: 'first' }, 1);
    await s.queue('hero', { id: 'b2', title: 'second' }, 2);
    const c = await s.claimNext('hero', 'run-1');
    A.ok(c && c.id === 'b1', 'claimNext returns the TOP item');
    A.eq(s.itemForRun('hero', 'run-1').id, 'b1', 'itemForRun maps the building runId back to the item');
    const c2 = await s.claimNext('hero', 'run-2');
    A.ok(c2 && c2.id === 'b2', 'a second claim skips the already-building item and takes the next');
    A.ok((await s.claimNext('hero', 'run-3')) === null, 'no un-built items left -> null');
  }

  // ---- 4. markBuilt records the runId; releaseClaim frees an un-built claim back to the queue ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'b1', title: 'x' }, 1);
    await s.claimNext('hero', 'run-1');
    await s.markBuilt('hero', 'b1', 'run-1', 5555);
    A.eq(s.itemForRun('hero', 'run-1').builtRunId, 'run-1', 'markBuilt stamps builtRunId');
    // TIMESTAMP HONESTY (2026-07-19): markBuilt records WHEN the build landed (injected ms) — the surfaces
    // that show a deliverable's age read this, never the queue ts and never a fresh now() at poll time.
    A.eq(s.itemForRun('hero', 'run-1').builtAt, 5555, 'markBuilt stamps builtAt (the real build-landed moment)');
    A.eq(s.itemForRun('hero', 'run-1').ts, 1, 'the queue ts is untouched (two different events, two stamps)');
    // a built item is not re-claimed
    A.ok((await s.claimNext('hero', 'run-2')) === null, 'a built item is not re-claimed by a later shift');

    const s2 = freshStore();
    await s2.queue('hero', { id: 'c1', title: 'y' }, 1);
    await s2.claimNext('hero', 'run-9');
    await s2.releaseClaim('hero', 'run-9');
    const again = await s2.claimNext('hero', 'run-10');
    A.ok(again && again.id === 'c1', 'releaseClaim returns an un-built item to the queue for a later shift');
  }

  // ---- 4c. TIMESTAMP HONESTY on undo: restorePending keeps the ORIGINAL builtAt (an undo relocates the
  //          copy — it does not re-produce the work), while its queue ts is honestly the undo moment. ----
  {
    const s = freshStore();
    const r = await s.restorePending('hero', 'run-u', { backlogId: 'bu', title: 'undone build', builtAt: 7777 }, 9999);
    A.ok(r.restored === true, 'restorePending re-lists the build');
    const it = s.itemForRun('hero', 'run-u');
    A.eq(it.builtAt, 7777, 'the restored item keeps the ORIGINAL build time (never the undo moment)');
    A.eq(it.ts, 9999, 'the restored item\'s queue ts is the undo moment (a separate, honest event)');
    const s2 = freshStore();
    const r2 = await s2.restorePending('hero', 'run-v', { title: 'legacy undo' }, 100);
    A.ok(r2.restored === true && s2.itemForRun('hero', 'run-v').builtAt === undefined,
      'a caller with no known build time stamps nothing — never a fabricated builtAt');
  }

  // ---- 4b. RETRY CAP: a FAILED build counts an attempt; at MAX_BUILD_ATTEMPTS (2) the item PARKS and is never
  //          silently re-claimed (the token-leak guard). A no-capability release is NOT an attempt. An explicit
  //          re-queue (same id or same normalized title) un-parks — a human re-ask means try again. ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'f1', title: 'doomed build' }, 1);
    // failed build #1 → attempt counted, still claimable
    await s.claimNext('hero', 'run-1');
    const r1 = await s.releaseClaim('hero', 'run-1', { failed: true });
    A.ok(r1.parked === null, 'one failed build does not park (attempts below the cap)');
    const c2 = await s.claimNext('hero', 'run-2');
    A.ok(c2 && c2.id === 'f1', 'the item is retried once');
    // failed build #2 → PARKED, reported to the caller, never re-claimed
    const r2 = await s.releaseClaim('hero', 'run-2', { failed: true });
    A.ok(r2.parked && r2.parked.id === 'f1' && r2.parked.attempts === 2, 'the second failed build PARKS the item (reported to the caller)');
    A.ok((await s.claimNext('hero', 'run-3')) === null, 'a parked item is never silently re-claimed');
    A.eq(s.backlogOf('hero').length, 1, 'the parked item stays VISIBLE in the backlog (not silently dropped)');
    // an explicit re-ask (idempotent re-queue by id) un-parks it
    const re = await s.queue('hero', { id: 'f1', title: 'doomed build' }, 9);
    A.ok(re.reason === 'exists', 're-queue by id is still idempotent');
    const c4 = await s.claimNext('hero', 'run-4');
    A.ok(c4 && c4.id === 'f1', 'an explicit re-queue clears the attempts (human re-ask = try again)');
    // a NO-CAPABILITY release (no failed flag) never counts an attempt
    const s2 = freshStore();
    await s2.queue('hero', { id: 'n1', title: 'fine build' }, 1);
    for (let i = 0; i < 5; i++) { await s2.claimNext('hero', 'run-' + i); await s2.releaseClaim('hero', 'run-' + i); }
    const still = await s2.claimNext('hero', 'run-final');
    A.ok(still && still.id === 'n1', 'no-capability releases never park an item (the build never started)');
    // re-queue by TITLE (fresh id) also un-parks
    const s3 = freshStore();
    await s3.queue('hero', { id: 't1', title: 'Tricky Tool' }, 1);
    await s3.claimNext('hero', 'ra'); await s3.releaseClaim('hero', 'ra', { failed: true });
    await s3.claimNext('hero', 'rb'); await s3.releaseClaim('hero', 'rb', { failed: true });
    A.ok((await s3.claimNext('hero', 'rc')) === null, 'parked by title-case too');
    await s3.queue('hero', { id: 't2', title: '  tricky   tool ' }, 5);   // same normalized title, fresh id
    const c5 = await s3.claimNext('hero', 'rd');
    A.ok(c5 && c5.id === 't1', 'a same-title re-ask un-parks the ORIGINAL item (no duplicate minted)');
  }

  // ---- 5. DISCARD removes the item AND denylists its id forever (never re-queued) — the core invariant ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'b1', title: 'bad idea' }, 1);
    await s.discard('hero', 'b1');
    A.eq(s.backlogOf('hero').map(x => x.id), [], 'discard removes the item from the backlog');
    A.ok(s.isDenied('hero', 'b1') === true, 'discarded id is on the permanent denylist');
    const re = await s.queue('hero', { id: 'b1', title: 'sneaking it back' }, 5);
    A.ok(re.item === null && re.reason === 'discarded', 'a discarded id is REFUSED on re-queue (discard = never again)');
    A.eq(s.backlogOf('hero').length, 0, 'the denylisted item never re-enters the backlog');
    // denylist survives a fresh store
    const fs = s._durable; A.ok(fs, 'durable handle exposed');
  }

  // ---- 5b. COMPLETE (kept): retires the item WITHOUT denylisting — a kept build never resurrects as pending,
  //          but the same work may legitimately be queued again later (unlike discard) ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'k1', title: 'good tool' }, 1);
    await s.claimNext('hero', 'run-k');
    await s.markBuilt('hero', 'k1', 'run-k');
    await s.complete('hero', 'k1');
    A.eq(s.backlogOf('hero').length, 0, 'complete removes the kept item from the backlog');
    A.ok(s.itemForRun('hero', 'run-k') === null, 'a kept build no longer maps to a backlog item (pending cannot re-list it)');
    A.ok(s.isDenied('hero', 'k1') === false, 'complete does NOT denylist the id (kept ≠ discarded)');
    const again = await s.queue('hero', { id: 'k2', title: 'good tool' }, 9);
    A.ok(again.reason === 'added', 'the same title CAN be queued again after a keep (only discard denies the title)');
    await s.complete('hero', 'missing-id');   // unknown id → silent no-op, never throws
    A.eq(s.backlogOf('hero').length, 1, 'complete on an unknown id is a no-op');
  }

  // ---- 6. denylist persists across a fresh store instance ----
  {
    const fs = memFs();
    const s1 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    await s1.queue('hero', { id: 'z1', title: 'q' }, 1);
    await s1.discard('hero', 'z1');
    const s2 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    A.ok(s2.isDenied('hero', 'z1') === true, 'denylist survives a restart (durable)');
    A.ok((await s2.queue('hero', { id: 'z1', title: 'q2' }, 2)).reason === 'discarded', 'restart-loaded denylist still refuses');
  }

  // ---- 7. normalize is defensive: partial/legacy/absent records load to a full safe shape ----
  {
    A.eq(normalize(null), { grant: false, grantExplicit: false, grantAuto: false, backlog: [], denylist: [], deniedTitles: [], lastShift: null }, 'null -> empty safe record');
    A.eq(normalize({ grant: true }).grant, true, 'partial record keeps its grant');
    A.eq(normalize({ backlog: [{ id: 'ok' }, { nope: 1 }, 'junk'] }).backlog.length, 1, 'backlog drops entries without an id');
    A.eq(normalize({ denylist: ['a', 1, null, 'b'] }).denylist, ['a', '1', 'b'], 'denylist coerces to non-empty strings');
  }

  // ---- 8. bad agentId is rejected (no path traversal into the sibling store filename) ----
  {
    const s = freshStore();
    A.ok(s.hasGrant('../evil') === false, 'a traversal agentId cannot read a grant (rejected -> false)');
    let threw = false;
    try { await s.setGrant('../evil', true); } catch (_) { threw = true; }
    A.ok(threw, 'setGrant rejects a bad agentId (fileFor throws before any write)');
  }

  // ---- 9. ZOMBIE-CLAIM RECLAIM: a buildingRunId whose run is NOT live is reaped so the item is claimable again ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'w1', title: 'build a thing' }, 1);
    // shift 1 claims it (stamps buildingRunId), then the sidecar "crashes" — the run is never marked built/released.
    const first = await s.claimNext('hero', 'run-dead', () => false);
    A.eq(first.id, 'w1', 'first shift claims the item');
    A.eq(s.read('hero').backlog[0].buildingRunId, 'run-dead', 'the item is stamped in-flight');

    // WITHOUT reclaim (no predicate), the next shift skips it forever — it still looks in-flight.
    A.eq(await s.claimNext('hero', 'run-2'), null, 'without a liveness predicate the stuck item is NOT re-claimed');

    // WITH the liveness predicate reporting run-dead as NOT live, the zombie stamp is cleared and the item is re-claimed.
    const reclaimed = await s.claimNext('hero', 'run-3', (rid) => rid === 'run-3');
    A.ok(reclaimed && reclaimed.id === 'w1', 'a zombie claim (dead run) is reaped and the item is re-claimed by the live shift');
    A.eq(s.read('hero').backlog[0].buildingRunId, 'run-3', 'the item is now stamped with the LIVE run');

    // a LIVE buildingRunId is respected — it is NOT reaped, so a second concurrent claim still skips it.
    A.eq(await s.claimNext('hero', 'run-4', (rid) => rid === 'run-3' || rid === 'run-4'), null, 'a LIVE claim is respected (not reaped)');
  }

  // ---- 10. sweepStaleClaims: the boot sweep clears every dead-run stamp; a fresh boot (all-dead) frees them all ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'a', title: 'A' }, 1);
    await s.queue('hero', { id: 'b', title: 'B' }, 2);
    // stamp a as in-flight under a live probe (a stays, b skipped), then stamp b similarly — two crashed shifts.
    await s.claimNext('hero', 'ra', (rid) => rid === 'ra');   // claims a, stamps buildingRunId=ra
    await s.claimNext('hero', 'rb', (rid) => rid === 'ra' || rid === 'rb');   // a is live -> skipped; b claimed, stamped rb
    const before = s.read('hero').backlog.filter(x => x.buildingRunId).length;
    A.eq(before, 2, 'both items are stamped in-flight (two shifts)');
    // boot sweep: no run is live -> both stamps cleared.
    const n = await s.sweepStaleClaims('hero', () => false);
    A.eq(n, 2, 'boot sweep un-stuck both zombie claims');
    A.eq(s.read('hero').backlog.filter(x => x.buildingRunId).length, 0, 'no stamps remain after the boot sweep');
    // idempotent: a second sweep with nothing stuck is a no-op (no write, count 0).
    A.eq(await s.sweepStaleClaims('hero', () => false), 0, 'a second boot sweep is a no-op');
    // a builtRunId item is NEVER touched by the sweep (it is done, not in-flight). Fresh store so the only
    // claimable item is 'c' (claimNext pops the TOP un-built item).
    const s2 = freshStore();
    await s2.queue('cap', { id: 'c', title: 'C' }, 3);
    const built = await s2.claimNext('cap', 'rc', (rid) => rid === 'rc');
    A.eq(built.id, 'c', 'the only queued item is claimed');
    await s2.markBuilt('cap', 'c', 'rc');
    A.eq(await s2.sweepStaleClaims('cap', () => false), 0, 'a built item is not swept (has builtRunId, not buildingRunId)');
  }

  // ---- 8. remove(): a queued idea leaves WITHOUT the denylist; a built item is refused (2026-07-15 UX audit) ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'q1', title: 'idea one' }, 1);
    await s.queue('hero', { id: 'q2', title: 'idea two' }, 2);
    const r1 = await s.remove('hero', 'q1');
    A.ok(r1.removed === true, 'a queued item is removable');
    A.eq(s.read('hero').backlog.length, 1, 'the queue shrank');
    A.eq(s.read('hero').denylist.length, 0, 'remove does NOT denylist (unlike discard)');
    const re = await s.queue('hero', { id: 'q1', title: 'idea one' }, 3);
    A.eq(re.reason, 'added', 'a removed idea can be queued again later');
    // built items are protected: they must be decided from their delivery session
    await s.claimNext('hero', 'r2', () => false);
    await s.markBuilt('hero', 'q2', 'r2');
    const r2 = await s.remove('hero', 'q2');
    A.ok(r2.removed === false && r2.reason === 'built', 'a BUILT item refuses remove (decide it from its session)');
    A.ok(await s.remove('hero', 'nope').then(x => x.reason === 'not-found'), 'an unknown id reports not-found');
  }

  // ---- 9. setLastShift(): shift health persists + survives a fresh store (2026-07-15 UX audit) ----
  {
    const fs = memFs();
    const s = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    A.eq(s.read('hero').lastShift, null, 'a new agent has no lastShift');
    await s.setLastShift('hero', { at: 1000, reason: 'no-capability', title: 'a build' });
    const ls = s.read('hero').lastShift;
    A.ok(ls && ls.at === 1000 && ls.reason === 'no-capability' && ls.title === 'a build', 'lastShift round-trips');
    const s2 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    A.ok(s2.read('hero').lastShift && s2.read('hero').lastShift.reason === 'no-capability', 'lastShift SURVIVES a fresh store (restart-safe)');
    await s.setLastShift('hero', { at: 2000, reason: 'built', runId: 'r9', title: 'thing' });
    A.eq(s.read('hero').lastShift.reason, 'built', 'a newer shift outcome replaces the old one');
  }

  // PRIOR-WORK provenance (2026-10-05): the focus a build served + the build it continues round-trip; junk is refused.
  {
    const fs = memFs();
    const s = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    await s.queue('hero', { id: 'ns-act-a', title: 'Continue: parkour', focusRef: 'C:/code/parkour', continuesRunId: 'run-1' }, 10);
    await s.queue('hero', { id: 'ns-act-b', title: 'other', continuesRunId: '../../etc' }, 11);
    const s2 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    const a = s2.backlogOf('hero').find(b => b.id === 'ns-act-a');
    A.ok(a && a.focusRef === 'C:/code/parkour' && a.continuesRunId === 'run-1', 'focusRef + continuesRunId survive a fresh store');
    A.eq(s2.backlogOf('hero').find(b => b.id === 'ns-act-b').continuesRunId, undefined, 'a non-id continuesRunId is not stored');
  }

  A.report('workshop-store.test');
})();
