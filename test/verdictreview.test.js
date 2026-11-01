/* node test/verdictreview.test.js — the consistency loop's slice 1 (sidecar/verdictreview.js + skillreview.js).
   Ratchet: a Commander `ok`/`miss` verdict on a SMALL run MUST earn a skill review (the 08-17 law — a background
   pass owes a test that proves it FIRES); `great` never spends a packet; a packet is taken once; the packet store is
   bounded (cap + TTL); the review prompt carries the verdict and the Commander's own correction. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeVerdictReview, VERDICTS_THAT_TEACH } = require('../sidecar/verdictreview.js');
const SR = require('../sidecar/skillreview.js');

/* ---------- the gate: verdict beats size ---------- */
const tiny = { reason: 'done', turns: 1, messages: [{ role: 'user', content: 'brief me' }, { role: 'assistant', content: 'ok' }] };
A.eq(SR.shouldReviewRun(tiny), false, 'a tiny run earns no size-review (unchanged)');
A.eq(SR.shouldReviewRun(tiny, { verdict: 'miss' }), true, 'RATCHET: a tiny run rated miss earns a review');
A.eq(SR.shouldReviewRun(tiny, { verdict: 'ok' }), true, 'a tiny run rated ok (close) earns a review');
A.eq(SR.shouldReviewRun(tiny, { verdict: 'great' }), false, 'praise is not a lesson: great never triggers by itself');
A.eq(SR.shouldReviewRun({ reason: 'error', turns: 1, messages: [] }, { verdict: 'miss' }), false, 'a failed run is the failure review\'s job, not this one');
A.eq(SR.shouldReviewRun(tiny, { verdict: 'miss', enabled: false }), false, 'the enabled=false kill switch still wins');

/* ---------- the prompt: verdict + correction ride in ---------- */
const p = SR.buildPrompt({ verdict: 'miss', correction: '  shorter,   bullets only  ', correctionSource: 'message', messages: tiny.messages });
A.ok(p.indexOf('COMMANDER VERDICT ON THIS RUN: MISSED the mark') !== -1, 'a miss is named as a miss');
A.ok(p.indexOf('in their words: "shorter, bullets only"') !== -1, 'the correction is quoted verbatim, whitespace collapsed');
A.ok(p.indexOf('NEXT run of this class of task does not repeat') !== -1, 'the reviewer is given the one job');
const pOk = SR.buildPrompt({ verdict: 'ok', messages: tiny.messages });
A.ok(pOk.indexOf('CLOSE, but short of the mark') !== -1 && pOk.indexOf('No written correction') !== -1, 'ok without a correction says so honestly');
A.eq(SR.buildPrompt({ verdict: 'great', messages: tiny.messages }).indexOf('COMMANDER VERDICT'), -1, 'a great verdict adds no block');
A.eq(SR.buildPrompt({ messages: tiny.messages }).indexOf('COMMANDER VERDICT'), -1, 'a size-triggered review is byte-identical in shape (no block)');
A.ok(SR.buildPrompt({ verdict: 'miss', correction: 'x'.repeat(2000), messages: [] }).indexOf('x'.repeat(601)) === -1, 'a correction is capped at 600 chars');

/* ---------- the packet store ---------- */
let t = 1000;
const vr = makeVerdictReview({ cap: 3, ttlMs: 500, now: () => t });
A.eq(vr.stash('', {}), false, 'no runId → no packet');
A.eq(vr.stash('r1', null), false, 'no packet → nothing stored');
A.eq(vr.stash('r1', { agentId: 'a' }), true, 'a packet parks');
A.eq(vr.shouldTrigger('r1', 'great'), false, 'great never triggers');
A.eq(vr.take('r1', 'great'), null, 'great never takes the packet');
A.eq(vr.has('r1'), true, '…and the packet is still there for a later honest verdict');
A.eq(vr.shouldTrigger('r1', 'miss'), true, 'miss triggers');
A.eq(vr.shouldTrigger('nope', 'miss'), false, 'an unknown run never triggers');
const got = vr.take('r1', 'miss');
A.eq(got && got.agentId, 'a', 'take returns the packet');
A.eq(vr.take('r1', 'miss'), null, 'taken ONCE — a second verdict on the same run reviews nothing');
// cap: oldest evicted
vr.stash('a', {}); vr.stash('b', {}); vr.stash('c', {}); vr.stash('d', {});
A.eq(vr.size(), 3, 'cap holds');
A.eq(vr.has('a'), false, 'the oldest packet is the one evicted');
A.eq(vr.has('d'), true, 'the newest survives');
// re-stash moves to newest
vr.stash('b', { v: 2 }); vr.stash('e', {});
A.eq(vr.has('c'), false, 're-stashing b made c the oldest → evicted');
A.eq(vr.take('b', 'ok').v, 2, 'a re-stash replaces the packet (latest state wins)');
// ttl
t += 501;
A.eq(vr.has('d'), false, 'a packet past its TTL is gone (a day-old verdict never reviews against a moved skillbase)');
A.eq(vr.size(), 0, 'sweep drains everything stale');
A.ok(VERDICTS_THAT_TEACH.has('ok') && VERDICTS_THAT_TEACH.has('miss') && !VERDICTS_THAT_TEACH.has('great'), 'the teaching set is exactly ok+miss');

/* ---------- slice 2: correction grace (fake timers, injected) ---------- */
{
  const timers = []; let tick = 0;
  const fakeSet = (fn, ms) => { const h = { fn, ms, id: ++tick, live: true }; timers.push(h); return h; };
  const fakeClear = (h) => { if (h) h.live = false; };
  const runTimers = () => { for (const h of timers.splice(0)) if (h.live) h.fn(); };
  const fired = [];
  const g = makeVerdictReview({ now: () => 1, graceMs: 5000, setTimeout: fakeSet, clearTimeout: fakeClear });
  g.stash('r1', { agentId: 'a' }); g.stash('r2', { agentId: 'a' }); g.stash('r3', { agentId: 'a' });
  A.eq(g.arm('r1', 'great', j => fired.push(j)), false, 'great never arms');
  A.eq(g.arm('r1', 'miss', null), false, 'no fire fn → no arm');
  A.eq(g.arm('r1', 'miss', j => fired.push(j)), true, 'a miss arms a held review');
  A.eq(fired.length, 0, 'RATCHET: the review does NOT fire on the verdict alone — it waits for the correction');
  A.eq(g.holding('r1'), true, 'held');
  A.eq(g.arm('r1', 'miss', j => fired.push(j)), false, 'a duplicate verdict never double-arms');
  A.eq(g.correct('r1', 'too long — tighter', false, 'chip').fired, false, 'a chip attaches but keeps waiting');
  A.eq(g.correct('r1', '  shorter, bullets   only ', true, 'message').fired, true, 'the typed message fires NOW');
  A.eq(fired.length, 1, 'exactly one review fired');
  A.eq(fired[0].runId, 'r1', 'with the run id');
  A.eq(fired[0].verdict, 'miss', 'with the verdict');
  A.eq(fired[0].correction, 'shorter, bullets only', 'the typed message REPLACES the chip (their words win), whitespace collapsed');
  A.eq(fired[0].correctionSource, 'message', 'source names the message');
  A.eq(fired[0].firedBy, 'correction', 'fired by the correction');
  A.eq(fired[0].agentId, 'a', 'the packet rides through');
  A.eq(g.holding('r1'), false, 'no longer held');
  A.eq(g.correct('r1', 'again', true).ok, false, 'a correction after firing changes nothing (single-shot)');
  runTimers();
  A.eq(fired.length, 1, 'the cancelled timer never fires a second review');
  // grace expiry with only a chip
  g.arm('r2', 'ok', j => fired.push(j));
  g.correct('r2', 'wrong audience / tone', false, 'chip');
  runTimers();
  A.eq(fired.length, 2, 'the grace timer fires the review');
  A.eq(fired[1].correction, 'wrong audience / tone', 'with the chip as the correction');
  A.eq(fired[1].firedBy, 'grace', 'fired by grace');
  // initial correction from the ratings body, then nothing
  g.arm('r3', 'miss', j => fired.push(j), 'from body');
  runTimers();
  A.eq(fired[2].correction, 'from body', 'a correction carried on the rating body survives to the grace fire');
  A.eq(fired[2].correctionSource, 'verdict', 'source = verdict');
  // graceMs 0 = immediate (the old behaviour, opt-in)
  const g0 = makeVerdictReview({ now: () => 1, graceMs: 0, setTimeout: fakeSet, clearTimeout: fakeClear });
  g0.stash('x', {}); const f0 = []; g0.arm('x', 'miss', j => f0.push(j));
  A.eq(f0.length === 1 && f0[0].firedBy, 'immediate', 'graceMs 0 fires immediately');
  A.eq(makeVerdictReview({ now: () => 1 }).graceMs, 90000, 'default grace is 90s');
}

// ---- DURABILITY: packets survive a restart (compacted, provider-free) ----
{
  const { compactPacket } = require('../sidecar/verdictreview.js');
  const big = [{ role: 'system', content: 'SYSTEM PROMPT' }, { role: 'user', content: 'write the weekly report' }];
  for (let i = 0; i < 30; i++) big.push({ role: 'assistant', content: 'x'.repeat(5000), tool_calls: [{ id: 'c' + i, function: { name: 'fs.write', arguments: '{"secret":"sk-live"}' } }] });
  const provider = { stream() {}, key: 'sk-or-v1-SECRET' };
  const c = compactPacket({ agentId: 'nova', messages: big, provider, cost: {}, model: 'm/x', loadedSkills: [{ id: 's1', name: 'Brief', body: 'long body' }], unmetered: true, failed: true });
  A.ok(!('provider' in c) && !('cost' in c), 'no live provider/cost handle is persisted');
  A.ok(JSON.stringify(c).indexOf('SECRET') < 0 && JSON.stringify(c).indexOf('sk-live') < 0, 'no credential reaches disk; safe structured arguments remain available');
  A.ok(JSON.stringify(c.messages).length < 25000, 'transcript is compacted (' + JSON.stringify(c.messages).length + ' chars)');
  A.ok(c.messages.every(m => m.role !== 'system'), 'the system prompt is not persisted');
  A.eq(c.messages[0].role, 'user', 'the directive is kept even when the tail cut it off');
  A.eq(c.messages[0].content, 'write the weekly report', 'directive text intact');
  A.eq(c.loadedSkills[0].body, undefined, 'skill refs only, never bodies');
  A.eq(c.agentId + '/' + c.model + '/' + c.unmetered + '/' + c.failed, 'nova/m/x/true/true', 'review inputs kept');

  // review fixes: the final answer is kept whole (goldens measure it) · a redact fn scrubs every persisted turn
  const longFinal = 'word '.repeat(3000).trim();   // ~15k chars, well past the 4k per-message cap
  const withFinal = compactPacket({ messages: [{ role: 'user', content: 'write it' }, { role: 'tool', content: 'KEY=sk-or-v1-abcdef0123456789' }, { role: 'assistant', content: longFinal }] }, t => String(t).replace(/sk-or-v1-[a-z0-9]+/g, '[REDACTED]'));
  A.eq(withFinal.messages[withFinal.messages.length - 1].content.length, longFinal.length, 'the final answer survives whole');
  A.ok(JSON.stringify(withFinal).indexOf('sk-or-v1-abcdef') < 0 && JSON.stringify(withFinal).indexOf('[REDACTED]') >= 0, 'a credential a tool read is redacted before disk');
  const vrR = makeVerdictReview({ now: () => 1, redact: t => String(t).replace(/SECRET\w*/g, '[R]') });
  let snap = null; const vrS = makeVerdictReview({ now: () => 1, redact: t => String(t).replace(/SECRET\w*/g, '[R]'), onChange: rows => { snap = rows; } });
  vrS.stash('rr', { agentId: 'a', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'token SECRET123 used' }] });
  A.ok(snap && JSON.stringify(snap).indexOf('SECRET123') < 0, 'makeVerdictReview passes its redact to every persisted snapshot');
  A.ok(vrR && vrS.peek('rr').messages[1].content.indexOf('SECRET123') >= 0, 'the in-RAM packet (for a live review) is untouched');

  let disk = null, t = 1000;
  const a = makeVerdictReview({ now: () => t, onChange: rows => { disk = JSON.parse(JSON.stringify(rows)); } });
  a.stash('run-1', { agentId: 'nova', messages: big.slice(0, 3), provider, model: 'm/x' });
  A.ok(Array.isArray(disk) && disk.length === 1 && disk[0].runId === 'run-1', 'a stash persists');
  A.ok(!('provider' in disk[0].packet), 'persisted packet is provider-free');
  // "restart": a fresh instance restores from disk; the verdict still finds its packet
  t = 5000;
  const b = makeVerdictReview({ now: () => t, onChange: rows => { disk = JSON.parse(JSON.stringify(rows)); } });
  A.eq(b.restore(disk), 1, 'restored one packet');
  A.ok(b.shouldTrigger('run-1', 'miss'), 'a verdict after the restart still triggers the review');
  const p = b.take('run-1', 'miss');
  A.ok(p && p.restored === true && !p.provider && p.agentId === 'nova', 'restored packet is marked, with no provider (the host rebuilds one)');
  A.eq(disk.length, 0, 'taking it persists the removal');
  // expired rows are not resurrected
  const c2 = makeVerdictReview({ now: () => 10 * 60 * 60 * 1000, ttlMs: 1000 });
  A.eq(c2.restore([{ runId: 'old', at: 1, packet: { agentId: 'a', messages: [] } }]), 1, 'restore reads the row…');
  A.eq(c2.has('old'), false, '…but an expired one is swept, never reviewed');
  A.eq(c2.restore(null) + c2.restore([{ runId: '', at: 1, packet: {} }, { runId: 'x', packet: {} }]), 0, 'malformed rows are skipped');
}

/* ---------- the HOST's persistence (sidecar/index.js), run for real against stub stores ----------
   skills-eval-09 / sidecar-index-08 / sidecar-index-12: every run end used to rewrite, fsync, read back and compare the
   whole packet file synchronously on the event loop. A stash/take (meta.ack === false: nobody waits on it) is batched
   again (1 s, unref'd); an acknowledged transition (arm, correct, fire, complete, retry) still writes and verifies
   synchronously and drops any pending batch first, so a stale stash snapshot can never overwrite it; shutdown's flush
   writes a pending batch instead of being a no-op. */
{
  const src = readSidecarSource();
  const from = src.indexOf('const VERDICT_PACKETS_FILE'), to = src.indexOf('function launchVerdictReview(');
  A.ok(from > 0 && to > from, 'index.js: the verdict packet persistence block is where this test reads it');
  const writes = [], timers = [];
  let disk = null;
  const host = new Function('path', 'WORKSPACES', 'saveResilient', 'loadResilient', 'failNote', 'setTimeout', 'clearTimeout',
    src.slice(from, to) + '\nreturn { persistVerdictPackets, flushVerdictPackets };')(
    require('path'), '/ws',
    (file, value) => { writes.push(JSON.parse(JSON.stringify(value))); disk = JSON.parse(JSON.stringify(value)); },
    () => disk,
    () => {},
    (fn, ms) => { const t = { fn, ms, cleared: false, unref() { this.unrefd = true; } }; timers.push(t); return t; },
    t => { if (t) t.cleared = true; });
  const live = () => timers.filter(t => !t.cleared && !t.fired);
  const fire = () => { for (const t of live()) { t.fired = true; t.fn(); } };
  A.eq(host.persistVerdictPackets([{ runId: 'r1' }], { ack: false }), true, 'a stash is accepted');
  A.eq(writes.length, 0, 'a stash does not write the whole file on the event loop at run end');
  host.persistVerdictPackets([{ runId: 'r1' }, { runId: 'r2' }], { ack: false });
  A.eq(live().length, 1, 'several stashes share one pending write');
  const batch = live()[0] || {};
  A.ok(batch.unrefd === true && batch.ms <= 1000, 'the batch timer is short and never holds the process open');
  fire();
  A.eq(writes.length, 1, 'the batch writes once');
  A.eq(((writes[0] || {}).rows || []).map(r => r.runId), ['r1', 'r2'], 'with the newest snapshot');
  host.persistVerdictPackets([{ runId: 'r3' }], { ack: false });
  A.eq(host.persistVerdictPackets([{ runId: 'r3', state: 'held' }], { ack: true }), true, 'an acknowledged transition is written and verified');
  A.eq(writes.length, 2, 'synchronously');
  A.eq(live().length, 0, 'and the pending stash batch is dropped (its snapshot is older)');
  host.persistVerdictPackets([{ runId: 'r4' }]);
  A.eq(writes.length, 3, 'a transition with no meta is treated as acknowledged');
  host.persistVerdictPackets([{ runId: 'r5' }], { ack: false });
  host.flushVerdictPackets();
  A.eq(writes.length, 4, 'shutdown flushes a pending batch');
  A.eq((((writes[3] || {}).rows || [])[0] || {}).runId, 'r5', 'the flushed batch is the newest');
  host.flushVerdictPackets();
  A.eq(writes.length, 4, 'a flush with nothing pending writes nothing');
  A.ok(/redactGeneration:/.test(src.slice(src.indexOf('const verdictReview = makeVerdictReview('), src.indexOf('const verdictReview = makeVerdictReview(') + 900)),
    'the host keys cached compact packets to its known-secret generation, so a newly saved key leaves saved rows');
}

// ---- an ARMED review is never evicted by the cap or aged out by its run's TTL (audit 10-11) ----
{
  let t = 1000, timers = [];
  const fakeSet = (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; };
  const fakeClear = (h) => { if (h) h.live = false; };
  const runTimers = () => { for (const h of timers.splice(0)) if (h.live) h.fn(); };
  const fired = [];
  const g = makeVerdictReview({ cap: 3, ttlMs: 10000, graceMs: 500, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear });
  g.stash('run-old', { agentId: 'a' }); t += 10; g.stash('run-b', {}); t += 10; g.stash('run-c', {});
  A.eq(g.arm('run-old', 'miss', j => { fired.push(j.runId); return true; }), true, 'the oldest parked run is rated miss and armed');
  t += 10; g.stash('run-d', {});
  A.eq(g.holding('run-old'), true, 'RATCHET: another run ending on a full station does not evict the armed review');
  A.eq(timers.filter(h => h.live).length, 1, 'its grace timer is still live');
  A.ok(g.has('run-b') && g.has('run-d'), 'an armed review does not count against the parked-packet cap');
  t += 10; g.stash('run-e', {});
  A.eq(g.has('run-b'), false, 'the cap still evicts the oldest PARKED packet');
  runTimers();
  A.eq(fired.join(','), 'run-old', 'the armed review fires after its grace');
  // negative: a DORMANT held row (retry-exhausted) is still capped, oldest first
  const d = makeVerdictReview({ cap: 2, ttlMs: 10000, graceMs: 0, maxAttempts: 1, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear });
  d.stash('dead', {}); d.arm('dead', 'miss', () => false);
  A.eq(d.snapshot()[0].reviewStatus, 'retry-exhausted', 'a review out of attempts goes dormant');
  t += 10; d.stash('p1', {}); A.eq(d.holding('dead'), true, 'a dormant row within the cap stays');
  t += 10; d.stash('p2', {});
  A.eq(d.holding('dead'), false, 'a dormant row past the cap is evicted like a parked packet');
  // an ARMED run rated near its TTL keeps its own grace + retry schedule (counted from the rating)
  const n = makeVerdictReview({ ttlMs: 10000, graceMs: 500, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear });
  const nearFired = [];
  n.stash('near', {}); t += 9900;
  A.eq(n.arm('near', 'miss', j => { nearFired.push(j); return true; }), true, 'a run rated just inside its TTL arms');
  t += 500; runTimers();
  A.eq(nearFired.length, 1, 'RATCHET: and its review fires after the grace window instead of being aged out mid-grace');
  // negative: a held job past its run TTL AND its bounded schedule (a long downtime / sleep) is still dropped
  const late = [];
  n.stash('late', {}); n.arm('late', 'miss', j => { late.push(j); return true; });
  t += 10000 + 500 + 3 * 60000 + 1; runTimers();
  A.eq(late.length + (n.holding('late') ? 1 : 0), 0, 'a held job past its run TTL and its own grace+retry schedule is dropped');
}

// ---- the TTL is the RUN's: arm() never stretches a held job's age by a full TTL from the rating (audit 10-12) ----
{
  let t = 0, timers = [];
  const fakeSet = (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; };
  const fakeClear = (h) => { if (h) h.live = false; };
  const runTimers = () => { for (const h of timers.splice(0)) if (h.live) h.fn(); };
  // the reviewer's probe: TTL 10s, one attempt, rated at 9.9s, the attempt fails, a typed correction at 18.9s
  let fires = 0;
  const v = makeVerdictReview({ ttlMs: 10000, graceMs: 0, maxAttempts: 1, retryMs: 1000, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear });
  v.stash('dormant', { agentId: 'a' }); t = 9900;
  v.arm('dormant', 'miss', () => { fires++; return false; });
  A.eq(v.snapshot()[0].reviewStatus + '/' + fires, 'retry-exhausted/1', 'the one attempt failed: the row is dormant');
  A.eq(v.snapshot()[0].at, 0, 'a held row keeps its RUN\'s time, not the rating\'s');
  A.eq(v.snapshot()[0].ratedAt, 9900, 'and records the rating separately');
  t = 18900;
  const late = v.correct('dormant', 'do it this way instead', true);
  A.eq(late.ok + '/' + late.reason, 'false/nothing held for this run', 'RATCHET: a final correction cannot revive a dormant run past its TTL');
  A.eq(fires + '/' + v.holding('dormant'), '1/false', 'so no second review fires against a skillbase that has moved');
  // negative: the same correction inside the run's TTL still fires the review
  let inside = 0;
  const w = makeVerdictReview({ ttlMs: 10000, graceMs: 0, maxAttempts: 1, retryMs: 1000, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear });
  t = 0; w.stash('fresh', { agentId: 'a' }); t = 9000;
  w.arm('fresh', 'miss', () => { inside++; return inside > 1; });
  t = 9950;
  const ok = w.correct('fresh', 'do it this way instead', true);
  A.eq(ok.ok + '/' + ok.fired + '/' + inside, 'true/true/2', 'a final correction inside the run TTL re-fires the dormant review');
  // negative: an ARMED job whose retry falls just past the run TTL still runs its bounded schedule
  let tries = 0;
  const r = makeVerdictReview({ ttlMs: 10000, graceMs: 100, maxAttempts: 3, retryMs: 1000, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear });
  t = 0; r.stash('edge', { agentId: 'a' }); t = 9800;
  r.arm('edge', 'miss', () => { tries++; return tries > 1; });
  t = 9900; runTimers();
  A.eq(tries + '/' + r.snapshot()[0].reviewStatus, '1/pending', 'the first armed attempt failed inside the TTL and is queued for retry');
  t = 10900; runTimers();
  A.eq(tries + '/' + r.holding('edge'), '2/false', 'its retry past the run TTL (inside grace+retries from the rating) still runs and completes');
  // a restored held row keeps both anchors
  let disk = null;
  const s1 = makeVerdictReview({ ttlMs: 10000, graceMs: 5000, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear, onChange: rows => { disk = JSON.parse(JSON.stringify(rows)); } });
  t = 0; s1.stash('saved', { agentId: 'a' }); t = 9000; s1.arm('saved', 'miss', () => true);
  const s2 = makeVerdictReview({ ttlMs: 10000, graceMs: 5000, maxAttempts: 1, now: () => t, setTimeout: fakeSet, clearTimeout: fakeClear });
  s2.restore(disk);
  A.eq(s2.snapshot()[0].at + '/' + s2.snapshot()[0].ratedAt, '0/9000', 'restore keeps the run time and the rating time apart');
}

// ---- the launcher's finished/retry answer: a pass that did its work is never retried (audit 10-11) ----
{
  const { reviewPassFinished } = require('../sidecar/verdictreview.js');
  for (const reason of ['done', 'empty', 'budget', 'max_iters', 'cancelled']) A.eq(reviewPassFinished({ reason }, false), true, 'a pass that reached its own ' + reason + ' stop is finished (no paid retry)');
  A.eq(reviewPassFinished({ reason: 'error' }, false), false, 'a pass that failed before changing anything is retried');
  A.eq(reviewPassFinished({ reason: 'error' }, true), true, 'a pass that failed AFTER staging a candidate is finished (a retry would re-stage it)');
  A.eq(reviewPassFinished(null, false), false, 'no loop result is a retry');
  // the 45s deadline cancelling a pass BEFORE the model produced anything (cold local model, a one-off hang)
  const prompt = [{ role: 'system', content: 'quiet worker' }, { role: 'user', content: 'review this run' }];
  const cold = { reason: 'cancelled', turns: 1, usd: 0, tokens: 0, messages: prompt.concat([{ role: 'assistant', content: '' }]) };
  A.eq(reviewPassFinished(cold, false), false, 'RATCHET: a deadline cancel before the model produced anything keeps its bounded retry');
  A.eq(reviewPassFinished(Object.assign({}, cold, { turns: 0, messages: prompt }), false), false, 'and so does a cancel before the first call went out');
  A.eq(reviewPassFinished(cold, true), true, 'a cancelled pass that changed the skillbase is finished');
  // negative: a cancelled pass that DID produce something is its own end (no paid re-run)
  const produced = [
    ['visible text', Object.assign({}, cold, { messages: prompt.concat([{ role: 'assistant', content: 'Looking at the skills now' }]) })],
    ['a tool call', Object.assign({}, cold, { turns: 2, messages: prompt.concat([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill_list', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '[]' }, { role: 'assistant', content: '' }]) })],
    ['reasoning', Object.assign({}, cold, { messages: prompt.concat([{ role: 'assistant', content: '', reasoning: [{ type: 'thinking', thinking: 'the run missed because' }] }]) })],
    ['billed spend', Object.assign({}, cold, { usd: 0.002 })],
    ['booked tokens', Object.assign({}, cold, { tokens: 900 })],
    ['no message list to prove otherwise', { reason: 'cancelled', turns: 1, usd: 0, tokens: 0 }]
  ];
  for (const [what, res] of produced) A.eq(reviewPassFinished(res, false), true, 'a deadline cancel after ' + what + ' is finished (no retry)');
  const v = makeVerdictReview({ now: () => 1, graceMs: 0, retryMs: 100 });
  let passes = 0;
  v.stash('cap-stop', {}); v.arm('cap-stop', 'miss', () => { passes++; return reviewPassFinished({ reason: 'budget' }, true); });
  A.eq(passes + '/' + v.holding('cap-stop'), '1/false', 'a budget-stopped pass completes the held review: one paid pass, nothing left to retry');
}

A.report('verdictreview');
