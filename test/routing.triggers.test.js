/* node test/routing.triggers.test.js — LINE TRIGGERS, the pure core + the runner + the folder watcher (headless).

   Locks: the durable record normalizes (unknown kinds/ids dropped, no secret in the public view), input validation
   (email refused honestly — there is no mail connector), the webhook secret (sha256 at rest, constant-time match,
   wrong/empty keys refused), the per-trigger RATE LIMIT (a burst can't buy more than maxPerHour; the window is on
   the durable record so a new runner — a restart — keeps it), the bounded queue + one fire in flight, the folder
   watcher's settle/debounce, temp-name ignores and name+mtime+size DEDUPE, the arming BASELINE (files already in
   the folder never fire), a CHANGED file firing once more, restart NO-REFIRE (a new runner over the same stores),
   the folder JAIL (system dirs, drive roots, the station's own data, outside home), and the dispatch outcome truth
   (ok only when every recorded run is done AND the line reached its OUTBOX; the crate only for the routed dock). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const T = require('../sidecar/routing/triggers.js');
const { makeTriggerRunner, MAX_PENDING } = require('../sidecar/routing/trigger-runner.js');
const { makeFolderWatcher, makeFolderPolicy } = require('../sidecar/routing/trigger-folder.js');

(async () => {
  /* ---- 1. records ---- */
  const good = T.normalizeTrigger({ id: 'trg_abc123def456', lineId: 'p12', kind: 'webhook', secretHash: 'a'.repeat(64), config: { task: 'sum it' }, maxPerHour: 9999 });
  A.ok(good && good.kind === 'webhook', 'a well-formed webhook record normalizes');
  A.eq(good.maxPerHour, T.MAX_PER_HOUR_CEILING, 'maxPerHour is clamped to the ceiling');
  A.eq(T.normalizeTrigger({ id: 'trg_abc123def456', lineId: 'p12', kind: 'email' }), null, 'an email kind is not a record (not built)');
  A.eq(T.normalizeTrigger({ id: 'nope', lineId: 'p12', kind: 'folder' }), null, 'a bad id is dropped');
  A.eq(T.normalizeTrigger({ id: 'trg_abc123def456', lineId: 'p 12!', kind: 'folder' }), null, 'a bad lineId is dropped');
  const pv = T.publicView(good, 1000);
  A.ok(!('secretHash' in pv) && !('recent' in pv) && pv.hasSecret === true, 'the public view never carries the secret hash (only hasSecret)');
  A.ok(JSON.stringify(pv).indexOf('a'.repeat(64)) < 0, 'the hash string appears nowhere in the view');
  const all = T.normalizeAll({ triggers: [good, good, { id: 'x' }] });
  A.eq(all.triggers.length, 1, 'normalizeAll de-duplicates and drops junk');

  /* ---- 2. validation ---- */
  A.ok(!T.validateInput({ kind: 'email', lineId: 'p1' }).ok, 'email is refused');
  A.ok(/no mail connector/.test(T.validateInput({ kind: 'email', lineId: 'p1' }).error), 'with the honest reason');
  A.ok(!T.validateInput({ kind: 'folder', lineId: 'p1', config: {} }).ok, 'a folder needs a path');
  A.ok(T.validateInput({ kind: 'webhook', lineId: 'p1' }).ok, 'a webhook needs only its line');
  A.ok(!T.validateInput({ kind: 'webhook', lineId: 'p1', maxPerHour: 0 }).ok, 'maxPerHour 0 is refused');
  const part = T.validateInput({ config: { path: 'C:\\x' } }, { partial: true });
  A.ok(part.ok && !('task' in part.fields.config), 'a partial config edit never clobbers the task');

  /* ---- 3. the secret ---- */
  const secret = T.mintSecret(Buffer.alloc(32, 7));
  A.ok(/^whk_[A-Za-z0-9_-]{40,}$/.test(secret), 'a minted secret is url-safe: ' + secret);
  A.throws(() => T.mintSecret(Buffer.alloc(8)), 'too few random bytes are refused');
  const h = T.hashSecret(secret);
  A.ok(T.secretMatches(secret, h), 'the right key matches');
  A.ok(!T.secretMatches(secret + 'x', h), 'a longer key does not');
  A.ok(!T.secretMatches(secret.slice(0, -1), h), 'a shorter key does not');
  A.ok(!T.secretMatches('', h), 'an empty key does not');
  A.ok(!T.secretMatches(secret, ''), 'no stored hash matches nothing');
  A.ok(!T.secretMatches(secret, null), 'a null hash matches nothing');

  /* ---- 4. the rate limit ---- */
  let rec = { maxPerHour: 3, recent: [] };
  const t0 = 10 * T.HOUR_MS;
  for (let i = 0; i < 3; i++) { const a = T.admit(rec, t0 + i); A.ok(a.ok, 'fire ' + (i + 1) + ' of 3 admitted'); rec = { maxPerHour: 3, recent: a.recent }; }
  const over = T.admit(rec, t0 + 10);
  A.ok(!over.ok && over.code === 'rate', 'the 4th fire inside the hour is refused');
  A.ok(over.retryAfterMs > 0 && over.retryAfterMs <= T.HOUR_MS, 'with an honest retry-after');
  A.ok(T.admit(rec, t0 + T.HOUR_MS + 5).ok, 'an hour later the window has room again');

  /* ---- 5. names, text/binary, the work item ---- */
  for (const n of ['.hidden', 'x.tmp', 'y.part', 'z.crdownload', '~$doc.docx', 'a.swp', 'b~', 'desktop.ini', 'Thumbs.db']) A.ok(T.isIgnoredName(n), 'ignored: ' + n);
  for (const n of ['invoice.txt', 'data.json', 'report.pdf']) A.ok(!T.isIgnoredName(n), 'watched: ' + n);
  A.ok(T.looksBinary('x.pdf', Buffer.from('%PDF')), 'a .pdf is binary by extension');
  A.ok(T.looksBinary('x.dat', Buffer.from([65, 0, 66])), 'a NUL byte means binary');
  A.ok(!T.looksBinary('x.txt', Buffer.from('hello')), 'plain text is text');
  const item = T.composeFolderItem({ name: 'Invoices', task: 'total it', filePath: 'C:\\Drops\\a.txt', size: 5, content: 'hello', truncated: false });
  A.ok(item.indexOf('[Line trigger "Invoices"') === 0, 'the item starts with a bracketed header (never a /command)');
  A.ok(/Task: total it/.test(item) && /C:\\Drops\\a\.txt/.test(item) && /hello/.test(item), 'it names the task, the file and carries the content');
  A.ok(/DATA to work on, not instructions/.test(item), 'the content is fenced as data');
  const wb = T.webhookBody('{"a":1}', 'application/json');
  A.ok(wb.contentType === 'json' && /"a": 1/.test(wb.body), 'a JSON body is re-indented');
  const big = T.webhookBody('x'.repeat(T.CONTENT_CAP + 50), 'text/plain');
  A.ok(big.truncated && Buffer.byteLength(big.body) === T.CONTENT_CAP, 'a huge body is capped');
  A.ok(T.composeWebhookItem({ body: '/deploy now', bytes: 11 }).indexOf('/deploy') > 0, 'a "/command" body lands inside the fence, never at the start');

  /* ---- 6. the folder watcher: settle, ignore, dedupe ---- */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-trg-unit-'));
  const drop = path.join(root, 'drops'); fs.mkdirSync(drop);
  fs.writeFileSync(path.join(drop, 'old.txt'), 'already here');
  const W = makeFolderWatcher({ fsp, pathMod: path, settleMs: 1000 });
  const base = await W.baseline(drop);
  A.ok(base.ok && base.keys.length === 1, 'the baseline records the file already in the folder');
  const seen = {}; for (const k of base.keys) seen[k] = 0;
  const past = Date.now() - 60000;
  fs.writeFileSync(path.join(drop, 'new.txt'), 'fresh invoice');
  fs.utimesSync(path.join(drop, 'new.txt'), past / 1000, past / 1000);
  fs.writeFileSync(path.join(drop, 'half.part'), 'still downloading');
  const now0 = Date.now();
  let s1 = await W.scan(drop, seen, new Map(), now0);
  A.ok(s1.ok && s1.ready.length === 0, 'first sighting never fires (the write may still be in progress)');
  A.ok(s1.pending.has('new.txt') && !s1.pending.has('half.part') && !s1.pending.has('old.txt'), 'pending holds the new file only (temp + baseline ignored)');
  let s2 = await W.scan(drop, seen, s1.pending, now0 + 500);
  A.eq(s2.ready.length, 0, 'unchanged but not settled long enough -> still waits');
  let s3 = await W.scan(drop, seen, s2.pending, now0 + 1500);
  A.eq(s3.ready.map(r => r.name), ['new.txt'], 'settled -> the new file is ready (once)');
  seen[s3.ready[0].key] = now0 + 1500;
  let s4 = await W.scan(drop, seen, s3.pending, now0 + 3000);
  A.eq(s4.ready.length, 0, 'a fired file is deduped by name+mtime+size');
  // a write in progress: the size moves between scans -> the settle clock restarts
  fs.writeFileSync(path.join(drop, 'grow.txt'), 'a');
  let g1 = await W.scan(drop, seen, s4.pending, now0 + 4000);
  fs.appendFileSync(path.join(drop, 'grow.txt'), 'bbbb');
  let g2 = await W.scan(drop, seen, g1.pending, now0 + 6000);
  A.ok(!g2.ready.some(r => r.name === 'grow.txt'), 'a file still growing does not fire');
  const body = await W.readItem(path.join(drop, 'new.txt'), 'new.txt');
  A.ok(body.ok && !body.binary && body.content === 'fresh invoice', 'readItem returns the text');
  fs.writeFileSync(path.join(drop, 'pic.png'), Buffer.from([137, 80, 78, 71, 0, 1]));
  const pb = await W.readItem(path.join(drop, 'pic.png'), 'pic.png');
  A.ok(pb.ok && pb.binary && pb.content === '', 'a binary file yields path + size only (no content)');
  const miss = await W.scan(path.join(root, 'gone'), {}, new Map(), now0);
  A.ok(!miss.ok && /no longer exists/.test(miss.error), 'a vanished folder is an honest error');

  /* ---- 7. the folder jail ---- */
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, 'inbox'), { recursive: true });
  const station = path.join(home, 'station'); fs.mkdirSync(station);
  const sys = path.join(root, 'sysdir'); fs.mkdirSync(sys);
  const policy = makeFolderPolicy({ fsp, pathMod: path, winish: path.sep === '\\',
    hardlineReason: (raw) => /[\\/]\.git([\\/]|$)/.test(raw) ? 'git internals' : null,
    homeRoots: () => [home], blessedRoots: () => [drop], forbiddenRoots: () => [station], systemRoots: () => [sys] });
  A.ok((await policy.check(path.join(home, 'inbox'))).ok, 'a folder inside home is allowed');
  A.ok((await policy.check(drop)).ok, 'a folder inside a blessed project is allowed');
  const refused = async (p, code, what) => { const r = await policy.check(p); A.ok(!r.ok && r.code === code, what + ' -> ' + code + ' (' + JSON.stringify(r) + ')'); };
  await refused('relative/dir', 'relative', 'a relative path');
  await refused(path.join(home, 'nope'), 'missing', 'a missing folder');
  await refused(path.join(drop, 'new.txt'), 'notdir', 'a file');
  await refused(sys, 'system', 'a system folder');
  await refused(path.parse(root).root, 'system', 'a whole drive');
  await refused(station, 'station', 'the station data folder');
  await refused(home, 'broad', 'home itself');
  await refused(root, 'outside', 'a folder outside home and every project');
  fs.mkdirSync(path.join(home, 'inbox', '.git'));
  await refused(path.join(home, 'inbox', '.git'), 'hardline', 'a .git folder');

  /* ---- 8. the runner: admission, queue, dispatch truth, restart ---- */
  let clock = Date.now();   // the folder watcher compares against REAL file mtimes
  let n = 0;
  const disk = { triggers: { triggers: [] }, seen: {} };
  const plan = { lines: [{ lineId: 'L1' }], reach: { 'agent-a': true }, lineOfAgent: { 'agent-a': 'L1' } };
  const emitted = [];
  const hubCalls = [];
  let runsByStream = {};
  let hubMode = 'ok';
  function fakeHub(hooks) {
    return {
      onInbound(msg) {
        hubCalls.push(msg);
        const routed = hooks.onRouted(hubMode === 'noroute' ? null : { agentId: 'agent-a', dockId: 'b1' });
        const agentId = routed ? routed.agentId : 'trg_fallback';
        hooks.onResolved({ chatId: msg.chatId, agentId, isTask: true, lineId: routed ? 'L1' : null, dockId: routed ? 'b1' : undefined });
        const sid = hooks.streamId();
        return Promise.resolve().then(() => {
          if (!hooks.entryAllowed(agentId)) { hooks.send('⚠ ' + 'this trigger\'s line routed the work to no crewed dock'); return; }
          const reason = hubMode === 'fail' ? 'error' : 'done';
          runsByStream[sid] = [{ runId: 'r1', agentId: 'agent-a', reason: 'done', usd: 0.01, streamId: sid }, { runId: 'r2', agentId: 'agent-b', reason, usd: 0.02, streamId: sid }];
          hooks.onLineOutcome(Object.assign({ agentId: 'agent-b', dockId: 'b2', stopped: null, hops: [1] }, hubMode !== 'deadend' ? { outboxId: 'outbox-L1' } : {}, hubMode === 'partial' ? { partial: 'agent-c failed' } : {}));
        });
      }, close() {}
    };
  }
  const mk = (extra) => makeTriggerRunner(Object.assign({
    load: () => JSON.parse(JSON.stringify(disk.triggers)), save: v => { disk.triggers = JSON.parse(JSON.stringify(v)); },
    seen: { load: () => JSON.parse(JSON.stringify(disk.seen)), save: v => { disk.seen = JSON.parse(JSON.stringify(v)); } },
    makeHub: fakeHub, plan: () => plan, shipsToOutbox: (a) => a === 'agent-b', dayCap: () => ({ cap: null, spent: 0 }),
    runsFor: sid => runsByStream[sid] || [], emit: (nm, p) => emitted.push({ nm, p }),
    watcher: makeFolderWatcher({ fsp, pathMod: path, settleMs: 0 }),
    now: () => clock, newId: () => 'id' + (++n) + 'abcdef0123456789'
  }, extra));
  let R = mk();
  const cw = R.create({ kind: 'webhook', lineId: 'L1', name: 'hook', maxPerHour: 3 }, { secretHash: T.hashSecret('k') });
  A.ok(cw.ok && T.ID_RE.test(cw.trigger.id), 'create returns a trigger with a well-formed id');
  const wid = cw.trigger.id;
  A.ok(JSON.stringify(disk.triggers).indexOf(T.hashSecret('k')) >= 0, 'the hash (never the key) is what reached disk');
  A.ok(JSON.stringify(disk.triggers).indexOf('"k"') < 0, 'the key itself never reached disk');
  const e1 = R.enqueue(wid, { text: 'job one', preview: 'HOOK' });
  A.ok(e1.ok, 'the first fire is admitted');
  await new Promise(r => setTimeout(r, 30));
  let v = R.view(wid);
  A.eq(v.fires, 1, 'fires counts the dispatch');
  A.ok(v.lastOutcome && v.lastOutcome.ok === true && v.lastOutcome.runs === 2, 'a clean two-dock run to the OUTBOX is ok: ' + JSON.stringify(v.lastOutcome));
  A.eq(v.lastError, null, 'no error on a clean fire');
  A.ok(emitted.some(e => e.nm === 'workitem.placed' && e.p.kind === 'trigger' && e.p.agentId === 'agent-a' && e.p.lineId === 'L1'), 'a trigger crate is placed at the routed dock, stamped with the line');
  A.ok(emitted.some(e => e.nm === 'workitem.delivered' && e.p.finalQueueId === 'outbox'), 'and it is delivered to the OUTBOX');
  A.ok(/^\[|job one/.test(hubCalls[0].text) && hubCalls[0].chatId === 'trg-' + wid, 'the hub got the work item on the trigger\'s own chat');
  // failure truth
  hubMode = 'fail';
  R.enqueue(wid, { text: 'job two' });
  await new Promise(r => setTimeout(r, 30));
  v = R.view(wid);
  A.ok(v.lastOutcome.ok === false && v.lastOutcome.code === 'stage_failed' && /agent-b failed/.test(v.lastError || ''), 'a failed stage is recorded honestly: ' + v.lastError);
  /* (runtime repair 2026-10-12) a PARTIAL joined job: every recorded row ended done (a COPY branch the host refused before it ran
     writes none), but the joiner sent on without it — not a clean fire, and the reason says so */
  hubMode = 'partial';
  const deliveredBefore = emitted.filter(e => e.nm === 'workitem.delivered' && e.p.finalQueueId === 'outbox').length;
  const pw = R.create({ kind: 'webhook', lineId: 'L1', name: 'hook-partial', maxPerHour: 3 }, { secretHash: T.hashSecret('kp') });   // its own hourly budget
  A.ok(pw.ok, 'a second webhook for the partial job');
  R.enqueue(pw.trigger.id, { text: 'job partial' });
  await new Promise(r => setTimeout(r, 30));
  v = R.view(pw.trigger.id);
  A.ok(v.lastOutcome.ok === false && /joiner sent on without every branch \(agent-c failed\)/.test(v.lastError || ''), 'a partial joined job is not a clean fire: ' + v.lastError);
  A.eq(emitted.filter(e => e.nm === 'workitem.delivered' && e.p.finalQueueId === 'outbox').length, deliveredBefore, '…and nothing is delivered to the OUTBOX for it');
  hubMode = 'deadend';
  R.enqueue(pw.trigger.id, { text: 'job dead end' });
  await new Promise(r => setTimeout(r, 30));
  v = R.view(pw.trigger.id);
  A.ok(v.lastOutcome.ok === false && v.lastOutcome.code === 'no_outbox', 'successful stages without an arrival receipt stop short, even if current topology reaches OUTBOX');
  A.eq(emitted.filter(e => e.nm === 'workitem.delivered' && e.p.finalQueueId === 'outbox').length, deliveredBefore, 'a dead end publishes no OUTBOX crate');
  hubMode = 'noroute';
  const placedBefore = emitted.filter(e => e.nm === 'workitem.placed').length;
  R.enqueue(wid, { text: 'job three' });
  await new Promise(r => setTimeout(r, 30));
  v = R.view(wid);
  A.ok(/routed the work to no crewed dock/.test(v.lastError || ''), 'no route -> no run, and the reason is recorded: ' + v.lastError);
  A.eq(v.lastOutcome.code, 'refused', 'missing route is refused, not a claim that another line ran the work');
  A.eq(emitted.filter(e => e.nm === 'workitem.placed').length, placedBefore, 'a fallback agent never gets a crate');
  // rate limit: 3 per hour were admitted above
  const e4 = R.enqueue(wid, { text: 'job four' });
  A.ok(!e4.ok && e4.code === 'rate', 'the 4th fire in the hour is refused (rate limit)');
  A.ok(/rate limit/.test(R.view(wid).lastError || ''), 'and the refusal shows as lastError');
  // restart: a NEW runner over the same disk keeps the window
  R = mk();
  A.ok(!R.enqueue(wid, { text: 'after restart' }).ok, 'a restart does not hand the burst a fresh allowance');
  clock += T.HOUR_MS + 1;
  hubMode = 'ok';
  // queue bound: one in flight + MAX_PENDING waiting
  const R2 = mk();
  const cq = R2.create({ kind: 'webhook', lineId: 'L1', maxPerHour: 100 }, { secretHash: T.hashSecret('q') });
  const res = []; for (let i = 0; i < MAX_PENDING + 3; i++) res.push(R2.enqueue(cq.trigger.id, { text: 'burst ' + i }));
  A.eq(res.filter(r => r.ok).length, MAX_PENDING + 1, 'a burst admits one in flight + ' + MAX_PENDING + ' waiting');
  A.ok(res.slice(MAX_PENDING + 1).every(r => r.code === 'busy'), 'the rest are refused busy (a burst cannot buy 500 runs)');
  await new Promise(r => setTimeout(r, 60));
  // halt + line checks
  plan.lines = [];
  A.ok(/no longer on the floor/.test(R2.preflight(R2.get(cq.trigger.id)) || ''), 'a trigger whose line left the floor refuses with the reason');
  plan.lines = [{ lineId: 'L1' }];
  /* THE SAVED FLOOR CANNOT BE PROVED RIGHT NOW (routing/saved-hold.js, deps.held): nothing fires from a guess about it. The trigger's own
     lastError says why, in the hold's words, the hub is never reached, a waiting item is dropped with the same reason, and when the floor
     is readable again the same trigger fires. */
  {
    const HELD = 'the saved floor is corrupt; routing is held until it is readable';
    let held = HELD;
    const RH = mk({ held: () => held });
    const hh = RH.create({ kind: 'webhook', lineId: 'L1', name: 'held', maxPerHour: 100 }, { secretHash: T.hashSecret('h') });
    const callsAtHold = hubCalls.length;
    A.eq(RH.preflight(RH.get(hh.trigger.id)), HELD, 'a held saved floor: the preflight says so, in the hold\'s words');
    const noGo = RH.enqueue(hh.trigger.id, { text: 'a job while the floor is held' });
    A.ok(!noGo.ok && noGo.code === 'refused' && noGo.error === HELD, 'the fire is refused with those words: ' + JSON.stringify(noGo));
    A.eq(RH.view(hh.trigger.id).lastError, HELD, 'and the trigger\'s own lastError says why');
    A.eq(hubCalls.length, callsAtHold, 'the hub (and so the model) was never reached');
    A.ok(!RH.canAccept(hh.trigger.id).ok, 'a folder poll asks canAccept first and leaves its file where it is');
    held = null; hubMode = 'ok';
    const goes = RH.enqueue(hh.trigger.id, { text: 'a job once it is readable' });
    A.ok(goes.ok, 'the floor is readable again: the same trigger fires');
    await new Promise(r => setTimeout(r, 30));
    A.eq(hubCalls.length, callsAtHold + 1, 'and exactly that one job reached the hub');
    // the floor goes held while a second item waits behind the one in flight: the check at dispatch asks again and drops it, with the reason on record
    const callsBeforePair = hubCalls.length;
    const pair = [RH.enqueue(hh.trigger.id, { text: 'first of two' }), RH.enqueue(hh.trigger.id, { text: 'second of two' })];
    A.ok(pair.every(x => x.ok), 'two items are admitted while the floor is readable');
    held = HELD;
    await new Promise(r => setTimeout(r, 60));
    A.eq(hubCalls.length, callsBeforePair + 1, 'the one in flight finished; the one waiting never reached the hub');
    const dropped = RH.view(hh.trigger.id).lastError || '';
    A.ok(dropped.indexOf('1 waiting item was dropped before running: ' + HELD) === 0, 'it was dropped with the hold\'s words on the record: ' + dropped);
  }

  /* ---- 9. folder trigger end to end through the runner + restart no-refire ---- */
  const fdir = path.join(root, 'fdrop'); fs.mkdirSync(fdir);
  fs.writeFileSync(path.join(fdir, 'before.txt'), 'was here before arming');
  const R3 = mk();
  const b3 = await makeFolderWatcher({ fsp, pathMod: path }).baseline(fdir);
  const cf = R3.create({ kind: 'folder', lineId: 'L1', config: { path: fdir, task: 'file it' } }, { baselineKeys: b3.keys });
  A.ok(cf.ok, 'a folder trigger is created');
  const fid = cf.trigger.id;
  const callsBefore = hubCalls.length;
  const back = Date.now() - 60000;
  fs.writeFileSync(path.join(fdir, 'landed.txt'), 'INVOICE 42');
  fs.utimesSync(path.join(fdir, 'landed.txt'), back / 1000, back / 1000);
  await R3.tickFolders();   // first sighting
  await R3.tickFolders();   // settled (settleMs 0) -> fires
  await new Promise(r => setTimeout(r, 30));
  const fired = hubCalls.slice(callsBefore);
  A.eq(fired.length, 1, 'exactly one work item for the one new file (the baseline file never fires)');
  A.ok(fired[0] && /landed\.txt/.test(fired[0].text) && /INVOICE 42/.test(fired[0].text) && /Task: file it/.test(fired[0].text), 'it names the file, carries its content and the task');
  A.ok(!fired.some(c => /before\.txt/.test(c.text)), 'the file that was there before arming never fired');
  A.eq(R3.view(fid).fires, 1, 'the folder trigger counts one fire');
  // restart: a fresh runner over the same stores must not refire landed.txt
  const R4 = mk();
  await R4.tickFolders(); await R4.tickFolders();
  await new Promise(r => setTimeout(r, 30));
  A.eq(hubCalls.length - callsBefore, 1, 'after a restart the fired file does NOT fire again');
  // a CHANGED file fires once more
  fs.writeFileSync(path.join(fdir, 'landed.txt'), 'INVOICE 42 (amended)');
  fs.utimesSync(path.join(fdir, 'landed.txt'), (back + 5000) / 1000, (back + 5000) / 1000);
  await R4.tickFolders(); await R4.tickFolders();
  await new Promise(r => setTimeout(r, 30));
  A.eq(hubCalls.length - callsBefore, 2, 'a changed file (new mtime/size) fires once more');
  // a folder that vanishes blocks the trigger honestly; when it is back the scan error clears itself
  fs.renameSync(fdir, fdir + '-gone');
  await R4.tickFolders();
  A.ok(/no longer exists/.test(R4.view(fid).blockedBy || '') && /no longer exists/.test(R4.view(fid).lastError || ''), 'a vanished folder shows as blockedBy + lastError: ' + R4.view(fid).blockedBy);
  fs.renameSync(fdir + '-gone', fdir);
  await R4.tickFolders();
  A.ok(R4.view(fid).blockedBy === null && R4.view(fid).lastError === null, 'once the folder is back the scan failure clears');
  // a file that leaves and comes back (a copy+delete move, a sync placeholder) is NOT a new landing: no refire
  fs.renameSync(path.join(fdir, 'landed.txt'), path.join(root, 'landed.txt'));
  await R4.tickFolders(); await R4.tickFolders();
  fs.renameSync(path.join(root, 'landed.txt'), path.join(fdir, 'landed.txt'));
  await R4.tickFolders(); await R4.tickFolders();
  await new Promise(r => setTimeout(r, 30));
  A.eq(hubCalls.length - callsBefore, 2, 'a file that vanished for a moment and came back unchanged does not refire');
  // disabled: nothing fires
  R4.update(fid, { enabled: false });
  fs.writeFileSync(path.join(fdir, 'while-off.txt'), 'x');
  fs.utimesSync(path.join(fdir, 'while-off.txt'), back / 1000, back / 1000);
  await R4.tickFolders(); await R4.tickFolders();
  A.eq(hubCalls.length - callsBefore, 2, 'a disabled folder trigger fires nothing');
  // delete forgets the seen record
  A.ok(R4.remove(fid).ok && !(fid in disk.seen), 'delete removes the trigger and its fired-file record');

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  A.report('routing.triggers.test');
})().catch(e => { console.log('FAIL: routing.triggers.test threw - ' + (e && e.stack || e)); process.exit(1); });
