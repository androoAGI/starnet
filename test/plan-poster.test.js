/* node test/plan-poster.test.js — the world's plan delivery to /api/routing must commit its dedupe hash
   ONLY on a server answer (audit 2026-08-04: the old fire-and-forget committed BEFORE the fetch and
   swallowed every failure, so one dropped POST left the sidecar routing by a STALE floor forever).

   world.js is a browser IIFE (can't require under node), so this extracts the marked PLAN-POSTER block
   (pure: params + locals only — fetch/console/setTimeout all injected) from the SOURCE and executes it —
   the shipped code is under test, not a copy (same idiom as test/social-border.test.js).

   Contract under test:
     • 200 → hash committed (same hash never re-posts — the dedupe kept from the old behavior), stale clears
     • network failure / non-422 status → hash NOT committed; bounded fixed-delay retries; stale=true + warn;
       after retries exhaust, the NEXT offer of the same hash re-attempts (rederive-driven recovery)
     • 422 → the plan itself is refused: hash committed (never re-post the same refused floor blindly),
       refusal recorded, NO retry, not stale (the sidecar holds the cleared plan; nags carry the errors)
     • a newer offer supersedes a pending retry, and a LATE stale response can never commit its hash

   THE SAVED FLOOR IS THE ROUTING AUTHORITY (lane saved-floor-routing-authority, S4): the sidecar routes by the floor the user
   SAVED, and this post only asks whether the page's floor is that floor. So the poster
     • posts the hint envelope {version:1, plan, compilerLinks}, because JSON drops the compiler's non-enumerable links;
     • awaits the durable save first (deps.saved): a refused or failed save posts nothing and keeps the floor stale, and
       flush() (World.syncPlan) resolves only after the save AND the station's verdict;
     • reads a 409 as "the station does not hold this floor yet": never committed, stale, retried as a failure is, and
       recorded as unsavedHash. 422 stays the refused commit; 503 (held) retries like any other failure. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

// ---- extract + execute the marked block from the real source ----
const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const BEGIN = 'PLAN-POSTER-BEGIN', END = 'PLAN-POSTER-END';
const i0 = src.indexOf(BEGIN), i1 = src.indexOf(END);
A.ok(i0 >= 0 && i1 > i0, 'world.js carries the PLAN-POSTER extraction markers');
const block = src.slice(src.indexOf('*/', i0) + 2, src.lastIndexOf('/*', i1));
A.ok(/function makePlanPoster\(/.test(block), 'the marked block holds makePlanPoster');
const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
A.ok(!/\bfetch\b|\bconsole\b|\bsetTimeout\b|\bapiUrl\b|\bwindow\b|\bdocument\b/.test(codeOnly),
  'the block is PURE (fetch/console/timers all injected — safe to execute standalone)');
// the block's names a newer page carries are looked up by typeof, so a page without them fails each check below instead of crashing here
const lib = eval('(function(){' + block + '\nreturn { makePlanPoster, routingKeyOf: typeof routingKeyOf === "function" ? routingKeyOf : null, floorSaved: typeof floorSaved === "function" ? floorSaved : null };})()');
const makePlanPoster = lib.makePlanPoster;

// ---- a deterministic harness: posts resolve by hand, timers fire by hand ----
// o.saved: wire the durable-save step, resolved by hand (h.saves) or by o.savedFn; the poster is otherwise built with no save step
function harness(o) {
  o = o || {};
  const h = { posts: [], warns: [], timers: [], canceled: [], saves: [], log: [] };
  const deps = {
    // the body is whatever the poster hands its transport: the hint envelope. `plan` is the plan inside it
    post: body => new Promise((resolve, reject) => { h.log.push('post'); h.posts.push({ body, plan: body && body.plan !== undefined ? body.plan : body, resolve, reject }); }),
    warn: m => h.warns.push(m),
    delay: (fn, ms) => { const id = h.timers.length; h.timers.push({ fn, ms, id, fired: false }); return id; },
    cancel: id => { h.canceled.push(id); const t = h.timers[id]; if (t) t.fired = true; }   // dead timers never fire
  };
  if (o.saved || o.savedFn) deps.saved = o.savedFn || (() => { h.log.push('saved'); return new Promise((resolve, reject) => { h.saves.push({ resolve, reject }); }); });
  h.poster = makePlanPoster(deps);
  h.pending = () => h.timers.filter(t => !t.fired);
  h.fire = () => { const t = h.pending()[0]; A.ok(t, 'a retry timer is pending to fire'); if (!t) return; t.fired = true; t.fn(); };
  return h;
}
const tick = () => new Promise(r => setImmediate(r));   // let settled promise callbacks run
// a step the poster never asked for answers nothing (its own check has already failed): the file reports every check instead of stopping at the first
const at = (list, i) => list[i] || { resolve() {}, reject() {} };

(async () => {
  // 200 commits the hash; the same hash never re-posts (dedupe preserved)
  {
    const h = harness();
    A.ok(h.poster.offer({ hash: 'p1' }, 'h1'), 'a new hash posts');
    A.eq(h.posts.length, 1, 'one POST in flight');
    A.ok(h.poster.state().lastHash === null, 'the hash is NOT committed before the server answers');
    h.posts[0].resolve({ ok: true, status: 200 }); await tick();
    A.eq(h.poster.state().lastHash, 'h1', '200 commits the hash');
    A.ok(!h.poster.state().stale, 'a confirmed post is not stale');
    A.ok(!h.poster.offer({ hash: 'p1' }, 'h1'), 'the same hash is deduped (no re-post)');
    A.eq(h.posts.length, 1, 'no second POST fired');
  }

  // network failure: no commit, warn, bounded retries, stale until a later success
  {
    const h = harness();
    h.poster.offer({ hash: 'p1' }, 'h1');
    h.posts[0].reject(new Error('down')); await tick();
    const s1 = h.poster.state();
    A.ok(s1.lastHash === null, 'a failed post commits nothing');
    A.ok(s1.stale, 'failure marks server-side routing possibly stale');
    A.eq(h.warns.length, 1, 'the failure warns (honest signal)');
    A.eq(h.pending().length, 1, 'one bounded retry is scheduled');
    // drive every retry to failure — the retry count must be BOUNDED
    let fired = 0;
    while (h.pending().length && fired < 10) { h.fire(); fired++; await tick(); h.posts[h.posts.length - 1].reject(new Error('down')); await tick(); }
    A.eq(fired, 3, 'exactly MAX_RETRIES(3) retry ticks fired — no unbounded loop');
    A.eq(h.pending().length, 0, 'no timer left after retries exhaust');
    A.ok(/next floor change/.test(h.warns[h.warns.length - 1]), 'the last warn says recovery waits for the next offer');
    // the next rederive re-offers the SAME uncommitted hash — delivery resumes
    A.ok(h.poster.offer({ hash: 'p1' }, 'h1'), 'after exhaustion the same hash re-offers (rederive retries)');
    h.posts[h.posts.length - 1].resolve({ ok: true, status: 200 }); await tick();
    A.eq(h.poster.state().lastHash, 'h1', 'the late success commits');
    A.ok(!h.poster.state().stale, '...and clears the stale flag');
  }

  // while a delivery is in flight (or a retry pending), the same hash does not double-post
  {
    const h = harness();
    h.poster.offer({ hash: 'p1' }, 'h1');
    A.ok(!h.poster.offer({ hash: 'p1' }, 'h1'), 'an in-flight hash is not re-posted');
    A.eq(h.posts.length, 1, 'still one POST');
    h.posts[0].reject(new Error('down')); await tick();
    A.ok(!h.poster.offer({ hash: 'p1' }, 'h1'), 'a retry-pending hash is not re-posted either');
    A.eq(h.posts.length, 1, 'the pending retry owns delivery');
  }

  // 422: refusal recorded, hash committed (no blind re-post), NO retry, not stale
  {
    const h = harness();
    h.poster.offer({ hash: 'bad' }, 'hBad');
    h.posts[0].resolve({ ok: false, status: 422 }); await tick();
    const s = h.poster.state();
    A.eq(s.lastHash, 'hBad', 'a 422 commits the hash — the same refused floor is never re-posted blindly');
    A.eq(s.refusedHash, 'hBad', 'the refusal is recorded');
    A.ok(!s.stale, 'a refusal is a server ANSWER — not staleness (the sidecar holds the cleared plan)');
    A.eq(h.pending().length, 0, 'a 422 schedules no retry');
    A.ok(!h.poster.offer({ hash: 'bad' }, 'hBad'), 'the refused hash is deduped');
    // a FIXED floor (new hash) posts and clears the refusal record
    h.poster.offer({ hash: 'fixed' }, 'hFix');
    h.posts[1].resolve({ ok: true, status: 200 }); await tick();
    A.eq(h.poster.state().refusedHash, null, 'a later accepted floor clears the refusal record');
  }

  // a newer offer supersedes a pending retry; a LATE stale response can never commit its hash
  {
    const h = harness();
    h.poster.offer({ hash: 'p1' }, 'h1');
    const late = h.posts[0];
    h.poster.offer({ hash: 'p2' }, 'h2');            // a newer floor while h1 is still on the wire
    A.eq(h.posts.length, 1, 'ONE POST AT A TIME: the newer floor waits — two POSTs on separate connections can arrive out of order');
    A.ok(h.poster.state().stale && h.poster.state().pendingHash === 'h2', 'meanwhile the sidecar is honestly stale and h2 is what is owed');
    late.resolve({ ok: true, status: 200 }); await tick();
    A.eq(h.poster.state().lastHash, 'h1', 'h1 was truly accepted (it is what the sidecar holds right now)');
    A.eq(h.posts.length, 2, 'the moment h1 settles, the newest floor goes out');
    A.eq(h.posts[1].plan.hash, 'p2', '...and it is h2, so the sidecar ends on the floor the page drew');
    A.ok(h.poster.state().stale, 'still stale until h2 is answered');
    h.posts[1].resolve({ ok: true, status: 200 }); await tick();
    A.eq(h.poster.state().lastHash, 'h2', 'the current delivery commits normally');
    A.ok(!h.poster.state().stale, 'and staleness clears');
    // several floors offered while one is on the wire: only the NEWEST follows (no backlog replay)
    const h3 = harness();
    h3.poster.offer({ hash: 'a' }, 'ha'); h3.poster.offer({ hash: 'b' }, 'hb'); h3.poster.offer({ hash: 'c' }, 'hc');
    A.eq(h3.posts.length, 1, 'still one POST on the wire');
    h3.posts[0].resolve({ ok: true, status: 200 }); await tick();
    A.eq(h3.posts.length, 2, 'one follow-up'); A.eq(h3.posts[1].plan.hash, 'c', 'the follow-up is the newest floor (b is skipped)');
    // the floor reverted to the one on the wire: nothing more to send
    const h4 = harness();
    h4.poster.offer({ hash: 'a' }, 'ha'); h4.poster.offer({ hash: 'b' }, 'hb'); A.ok(!h4.poster.offer({ hash: 'a' }, 'ha'), 'offering the in-flight floor again drops the queued one');
    h4.posts[0].resolve({ ok: true, status: 200 }); await tick();
    A.eq(h4.posts.length, 1, 'no follow-up POST'); A.eq(h4.poster.state().lastHash, 'ha'); A.ok(!h4.poster.state().stale, 'not stale');
    // a FAILED in-flight POST with a newer floor queued delivers the newer floor (no retry of the old one)
    const h5 = harness();
    h5.poster.offer({ hash: 'a' }, 'ha'); h5.poster.offer({ hash: 'b' }, 'hb');
    h5.posts[0].reject(new Error('down')); await tick();
    A.eq(h5.posts.length, 2, 'the newer floor goes out at once'); A.eq(h5.posts[1].plan.hash, 'b'); A.eq(h5.pending().length, 0, 'no retry of the superseded floor');
    // flush() waits for the NEWEST floor's verdict, not the one that happened to be on the wire
    const h6 = harness();
    h6.poster.offer({ hash: 'a' }, 'ha'); h6.poster.offer({ hash: 'b' }, 'hb');
    let flushed = null; h6.poster.flush().then(st => { flushed = st; });
    h6.posts[0].resolve({ ok: true, status: 200 }); await tick();
    A.ok(flushed === null, 'flush is still waiting while the newest floor is on the wire');
    h6.posts[1].resolve({ ok: true, status: 200 }); await tick();
    A.ok(flushed && flushed.lastHash === 'hb' && !flushed.stale, 'flush resolves with the newest floor delivered');
    // and a pending retry is canceled by a newer offer
    const h2 = harness();
    h2.poster.offer({ hash: 'p1' }, 'h1');
    h2.posts[0].reject(new Error('down')); await tick();
    A.eq(h2.pending().length, 1, 'h1 retry pending');
    h2.poster.offer({ hash: 'p2' }, 'h2');
    A.eq(h2.canceled.length, 1, 'the newer floor cancels the older retry timer');
    A.eq(h2.pending().length, 0, 'no stale retry remains armed');
  }

  /* =========================================================================================================================
     THE PUBLICATION IS A HINT, POSTED AFTER THE SAVE (saved floor = the routing authority)
     ========================================================================================================================= */
  const links = [{ id: 'k1', from: 'i1', to: 'b1' }, { id: 'k2', from: 'b1', to: 'o1' }];
  // a plan the way the compiler hands it over: its links ride a NON-ENUMERABLE property, which JSON drops
  const compiled = (hash, withLinks) => { const p = { hash, bays: [], errors: [] }; if (withLinks) Object.defineProperty(p, 'links', { value: withLinks, enumerable: false }); return p; };
  const keys = o => Object.keys(o).sort();

  // the body is the hint envelope: the plan, and the links JSON would drop as an explicit companion
  {
    const h = harness();
    const plan = compiled('p1', links);
    A.ok(JSON.stringify(plan).indexOf('links') < 0, 'fixture: the compiler\'s links are not enumerable, so a bare plan loses them on the wire');
    h.poster.offer(plan, 'h1');
    const body = h.posts[0].body;
    A.eq(keys(body), ['compilerLinks', 'plan', 'version'], 'the body is exactly the hint envelope {version, plan, compilerLinks}');
    A.eq(body.version, 1, 'the envelope is version 1');
    A.ok(body.plan === plan, 'the plan rides unchanged');
    A.eq(body.compilerLinks, links, 'its links ride beside it');
    const wire = JSON.parse(JSON.stringify(body));
    A.eq(wire.compilerLinks, links, 'the links survive JSON');
    A.ok(wire.plan && !('links' in wire.plan), '...and the plan itself stays what the compiler enumerates');
    const h2 = harness(); h2.poster.offer(compiled('p2', null), 'h2');
    A.eq(h2.posts[0].body.compilerLinks, null, 'a plan compiled without links posts compilerLinks: null');
    const h3 = harness(); h3.poster.offer(null, '');
    A.eq(JSON.parse(JSON.stringify(h3.posts[0].body)), { version: 1, plan: null, compilerLinks: null }, 'no plan is still an envelope, never a bare body the station could mistake for a plan');
    // a queued follow-up and a retry post the same shape
    const h4 = harness();
    h4.poster.offer(compiled('a', links), 'ha'); h4.poster.offer(compiled('b', links), 'hb');
    at(h4.posts, 0).resolve({ ok: true, status: 200 }); await tick();
    A.eq(keys(h4.posts[1].body), ['compilerLinks', 'plan', 'version'], 'the queued follow-up is an envelope too');
    A.eq(h4.posts[1].body.compilerLinks, links, '...with its links');
    at(h4.posts, 1).reject(new Error('down')); await tick(); h4.fire(); await tick();
    A.eq([h4.posts.length, keys(h4.posts[2].body), h4.posts[2].body.compilerLinks], [3, ['compilerLinks', 'plan', 'version'], links], 'a retry posts the envelope with its links again');
  }

  // a poster built with no save step (a page without a durable save) posts at once, as before
  {
    const h = harness();
    h.poster.offer(compiled('p1', links), 'h1');
    A.eq(h.posts.length, 1, 'no save step: the post goes out at once');
  }

  // the save lands FIRST: nothing is posted before it, and flush() (World.syncPlan) resolves only after save AND verdict
  {
    const h = harness({ saved: true });
    let flushed = null;
    A.ok(h.poster.offer(compiled('p1', links), 'h1'), 'a new floor is taken');
    h.poster.flush().then(s => { flushed = s; });
    A.eq([h.saves.length, h.posts.length], [1, 0], 'the save is awaited first and nothing is posted before it lands');
    A.ok(h.poster.state().inflight && h.poster.state().lastHash === null, 'the delivery is in flight while the save is awaited, and nothing is committed');
    await tick();
    A.eq(flushed, null, 'flush() does not resolve while the save is awaited');
    at(h.saves, 0).resolve(true); await tick();
    A.eq(h.log, ['saved', 'post'], 'the save came first, then the post');
    A.eq(flushed, null, 'flush() still waits for the station\'s verdict');
    at(h.posts, 0).resolve({ ok: true, status: 200 }); await tick();
    A.ok(flushed && flushed.lastHash === 'h1' && !flushed.stale && flushed.unsavedHash === null, 'flush() resolves with the committed floor only after save and verdict');
    A.ok(!h.poster.offer(compiled('p1', links), 'h1'), 'the acknowledged floor is deduped, with no second save wait');
    A.eq(h.saves.length, 1, 'no second save was asked for');
  }

  // a save that did not land posts NOTHING, keeps the floor stale with the existing warn, and the retry asks the save again
  for (const how of ['is refused', 'rejects', 'throws']) {
    const h = harness({ savedFn: () => {
      h.log.push('saved');
      if (how === 'throws') throw new Error('the flush blew up');
      return new Promise((resolve, reject) => { h.saves.push({ resolve, reject }); });
    } });
    h.poster.offer(compiled('p1', links), 'h1');
    if (how === 'is refused') at(h.saves, 0).resolve(false);
    if (how === 'rejects') at(h.saves, 0).reject(new Error('the station is down'));
    await tick();
    const s = h.poster.state();
    A.eq(h.posts.length, 0, 'a save that ' + how + ': the floor is never posted');
    A.eq([s.lastHash, s.refusedHash, s.stale, s.unsavedHash, s.inflight], [null, null, true, 'h1', false], 'a save that ' + how + ': nothing committed, stale, recorded as unsaved');
    A.eq(h.warns.length, 1, 'a save that ' + how + ': the failure warns (the existing honest signal)');
    A.ok(/save/.test(h.warns[0]) && /stale/.test(h.warns[0]) && /retrying/.test(h.warns[0]), 'a save that ' + how + ': the warn names the save and the retry (' + h.warns[0] + ')');
    A.eq(h.pending().length, 1, 'a save that ' + how + ': one bounded retry is armed');
    if (how === 'throws') continue;
    // the retry asks the save again, and posts only once it landed
    h.fire(); await tick();
    A.eq([h.saves.length, h.posts.length], [2, 0], 'a save that ' + how + ': the retry awaits the save again before it posts anything');
    at(h.saves, 1).resolve(true); await tick();
    A.eq(h.posts.length, 1, 'a save that ' + how + ': once the save landed the floor is posted');
    at(h.posts, 0).resolve({ ok: true, status: 200 }); await tick();
    const done = h.poster.state();
    A.eq([done.lastHash, done.stale, done.unsavedHash], ['h1', false, null], 'a save that ' + how + ': the late save and the verdict commit the floor and clear the record');
  }

  // and the retries are bounded: a save that never lands posts nothing, then waits for the next floor change
  {
    let asked = 0;
    const h = harness({ savedFn: () => { asked++; return Promise.resolve(false); } });
    h.poster.offer(compiled('p1', links), 'h1'); await tick();
    let fired = 0;
    while (h.pending().length && fired < 10) { h.fire(); fired++; await tick(); }
    A.eq([fired, asked, h.posts.length], [3, 4, 0], 'exactly MAX_RETRIES(3) retries after the first ask, and nothing was ever posted');
    A.ok(/next floor change/.test(h.warns[h.warns.length - 1]), 'the last warn says recovery waits for the next floor change');
    A.eq(h.pending().length, 0, 'no timer is left armed');
    h.poster.offer(compiled('p1', links), 'h1'); await tick();
    A.eq(asked, 5, 'the next offer of the same unsaved floor asks the save again (rederive-driven recovery)');
  }

  // 409: the station does not hold this floor YET. Never committed, not a refusal, stale, retried, recorded as unsaved
  {
    const h = harness();
    h.poster.offer(compiled('p1', links), 'h1');
    at(h.posts, 0).resolve({ ok: false, status: 409 }); await tick();
    const s = h.poster.state();
    A.eq([s.lastHash, s.refusedHash, s.stale, s.unsavedHash, s.pendingHash, s.inflight], [null, null, true, 'h1', 'h1', false], '409: not committed, not refused, stale, recorded as unsaved');
    A.eq(h.warns.length, 1, '409: the existing warn fires');
    A.ok(/not saved yet/.test(h.warns[0]) && /retrying/.test(h.warns[0]), '409: the warn says the floor is not saved yet (' + h.warns[0] + ')');
    A.eq(h.pending().length, 1, '409: one bounded retry is armed');
    A.ok(!h.poster.offer(compiled('p1', links), 'h1'), '409: the same floor is not re-posted while its retry is pending');
    h.fire(); await tick();
    A.eq(h.posts.length, 2, '409: the retry posts the floor again');
    at(h.posts, 1).resolve({ ok: true, status: 200 }); await tick();
    const done = h.poster.state();
    A.eq([done.lastHash, done.stale, done.unsavedHash, done.pendingHash], ['h1', false, null, null], '409 then 200: the floor commits when the station holds it, and the record clears');
    A.ok(!h.poster.offer(compiled('p1', links), 'h1'), '...and is deduped from then on');
  }
  {
    const h = harness();
    h.poster.offer(compiled('p1', links), 'h1');
    let fired = 0;
    for (;;) {
      at(h.posts, h.posts.length - 1).resolve({ ok: false, status: 409 }); await tick();
      if (!h.pending().length || fired >= 10) break;
      h.fire(); fired++; await tick();
    }
    A.eq([fired, h.posts.length], [3, 4], '409 forever: bounded at MAX_RETRIES(3) retries');
    A.eq(h.poster.state().lastHash, null, '409 forever: the floor was never committed');
    A.ok(/next floor change/.test(h.warns[h.warns.length - 1]), '409 forever: the last warn says recovery waits for the next floor change');
    A.ok(h.poster.offer(compiled('p1', links), 'h1'), '409 forever: the next offer of the same floor posts again');
  }
  // 409 never hides a refusal and a 422 after it still commits
  {
    const h = harness();
    h.poster.offer(compiled('p1', links), 'h1');
    at(h.posts, 0).resolve({ ok: false, status: 409 }); await tick(); h.fire(); await tick();
    at(h.posts, 1).resolve({ ok: false, status: 422 }); await tick();
    const s = h.poster.state();
    A.eq([s.lastHash, s.refusedHash, s.stale, s.unsavedHash], ['h1', 'h1', false, null], '409 then 422: the exactly matched, compiler-refused floor is the refused commit');
    A.eq(h.pending().length, 0, '...with no retry');
  }

  // 422 and 503 with the save step wired: 422 stays the refused commit; 503 (held) retries as a failure and is NOT an unsaved floor
  {
    const h = harness({ saved: true });
    h.poster.offer(compiled('bad', links), 'hBad'); at(h.saves, 0).resolve(true); await tick();
    at(h.posts, 0).resolve({ ok: false, status: 422 }); await tick();
    const s = h.poster.state();
    A.eq([s.lastHash, s.refusedHash, s.stale, s.unsavedHash], ['hBad', 'hBad', false, null], '422 after a save: the refused commit, not stale');
    A.eq(h.pending().length, 0, '422 after a save: no retry');
  }
  {
    const h = harness({ saved: true });
    h.poster.offer(compiled('p1', links), 'h1'); at(h.saves, 0).resolve(true); await tick();
    at(h.posts, 0).resolve({ ok: false, status: 503 }); await tick();
    const s = h.poster.state();
    A.eq([s.lastHash, s.refusedHash, s.stale, s.unsavedHash], [null, null, true, null], '503 (held): not committed, stale, and the floor is not recorded as unsaved');
    A.ok(/503/.test(h.warns[0]) && /retrying/.test(h.warns[0]), '503 (held): the warn names the status');
    A.eq(h.pending().length, 1, '503 (held): retried like any failure');
    h.fire(); await tick();
    A.eq(h.saves.length, 2, '503 (held): the retry asks the save again too');
  }

  // a newer floor offered while the save is awaited waits behind it (one delivery at a time) and follows the older one
  {
    const h = harness({ saved: true });
    h.poster.offer(compiled('a', links), 'ha');
    A.ok(h.poster.offer(compiled('b', links), 'hb'), 'a newer floor offered during the save wait is taken');
    A.eq([h.posts.length, h.saves.length], [0, 1], 'one delivery at a time: the newer floor waits behind the first save');
    A.ok(h.poster.state().stale && h.poster.state().pendingHash === 'hb', 'meanwhile the station is honestly stale and hb is what is owed');
    at(h.saves, 0).resolve(true); await tick();
    A.eq(h.posts.length, 1, 'the first floor posts once its save landed'); A.eq(h.posts[0].plan.hash, 'a', '...and it is the first floor');
    at(h.posts, 0).resolve({ ok: true, status: 200 }); await tick();
    A.eq(h.saves.length, 2, 'the follow-up awaits the save too');
    A.eq(h.posts.length, 1, '...and is not posted before it');
    at(h.saves, 1).resolve(true); await tick();
    A.eq(h.posts[1].plan.hash, 'b', 'the follow-up is the newest floor');
    at(h.posts, 1).resolve({ ok: true, status: 200 }); await tick();
    A.eq([h.poster.state().lastHash, h.poster.state().stale], ['hb', false], 'the station ends on the floor the page drew');
  }
  // a save that fails for the older floor does not strand a newer one
  {
    const h = harness({ saved: true });
    h.poster.offer(compiled('a', links), 'ha'); h.poster.offer(compiled('b', links), 'hb');
    at(h.saves, 0).resolve(false); await tick();
    A.eq(h.saves.length, 2, 'a failed save of the older floor hands the wire to the newer one at once');
    A.eq(h.poster.state().pendingHash, 'hb', '...and hb is what is owed');
    A.eq(h.pending().length, 0, 'no retry of the superseded floor');
  }

  // THE SAVE STEP. floorSaved(cloud) is the one production wiring over CloudSave: true only when the station file holds this window's
  // newest save (or nothing was waiting), and it runs one turn late so the persist the same edit queued lands first
  {
    A.ok(typeof lib.floorSaved === 'function', 'the block carries the save step floorSaved');
    const floorSaved = lib.floorSaved || (() => Promise.resolve(null));
    const cloud = ok => ({ asked: 0, flushForUpdate() { this.asked++; return Promise.resolve({ ok, hadPending: true, flushed: ok }); } });
    const yes = cloud(true), no = cloud(false);
    A.eq(await floorSaved(yes), true, 'the station file holds the newest save: landed');
    A.eq(yes.asked, 1, '...by asking CloudSave to send it');
    A.eq(await floorSaved(no), false, 'the newest save was refused or unreachable: not landed');
    A.eq(await floorSaved({ flushForUpdate: () => Promise.resolve(undefined) }), false, 'an answer that does not say ok proves nothing');
    A.eq(await floorSaved(null), true, 'a page with no durable save has nothing to wait for');
    A.eq(await floorSaved({}), true, 'a CloudSave without flushForUpdate has nothing to wait for either');
    let rejected = null;
    try { await floorSaved({ flushForUpdate: () => Promise.reject(new Error('down')) }); } catch (e) { rejected = e; }
    A.ok(rejected && /down/.test(rejected.message), 'a flush that rejects rejects the step (the poster reads it as a save that did not land)');
    const order = [];
    queueMicrotask(() => order.push('app persist'));   // app.js watchStationSave: the same edit's persist, queued at the station change
    const pending = floorSaved({ flushForUpdate() { order.push('flush'); return Promise.resolve({ ok: true }); } });
    A.eq(order, [], 'nothing runs synchronously');
    await pending;
    A.eq(order, ['app persist', 'flush'], 'the flush runs after the persist the same edit queued');
  }

  // THE DEDUPE KEY keeps every part a floor edit rides: topology, caps, a lone dock's brief, the line budget, names, SEND TO
  {
    A.ok(typeof lib.routingKeyOf === 'function', 'the block carries the dedupe key routingKeyOf');
    const key = lib.routingKeyOf || (() => null);
    const full = {
      hash: 'abcd1234',
      bays: [{ agentId: 'alpha', objects: ['computer', { objectType: 'connector', connectorId: 'c1' }] }, { agentId: 'beta', objects: [] }],
      dockBays: [{ propId: 'b1', brief: 'B' }, { propId: 'b2' }],
      lineLimits: { l1: { maxHops: 3 } },
      lines: [{ lineId: 'l1', projectRoot: '/p', name: 'N' }, { lineId: 'l2' }],
      sendTo: { o1: { toLine: 'l2' } }
    };
    A.eq(key(full), 'abcd1234|alpha:computer,connector#c1;beta:|b1:B;b2:|{"l1":{"maxHops":3}}|[["l1","/p","N"],["l2","",""]]|{"o1":{"toLine":"l2"}}', 'the key is the one every earlier page offered (byte for byte)');
    A.eq(key({ hash: 'h' }), 'h|||{}|[]|{}', 'a bare plan keys on its hash and empty parts');
    A.eq(key({}), '|||{}|[]|{}', 'a plan with no hash keys on empty parts');
    A.eq(key(null), '', 'no plan has the empty key');
    const edits = [
      ['topology', p => { p.hash = 'ffff0000'; }],
      ['capabilities', p => { p.bays[1].objects.push('dish'); }],
      ['connector binding', p => { p.bays[0].objects[1].connectorId = 'c2'; }],
      ['a lone dock\'s brief', p => { p.dockBays[1].brief = 'new brief'; }],
      ['line budget', p => { p.lineLimits.l1.maxHops = 4; }],
      ['line name', p => { p.lines[0].name = 'M'; }],
      ['line project root', p => { p.lines[1].projectRoot = '/q'; }],
      ['SEND TO', p => { p.sendTo.o1.toLine = 'l3'; }]
    ];
    const seen = new Set([key(full)]);
    for (const [name, edit] of edits) {
      const p = JSON.parse(JSON.stringify(full)); edit(p);
      A.ok(key(p) !== key(full), name + ' moves the key, so the edit is published again');
      seen.add(key(p));
    }
    A.eq(seen.size, edits.length + 1, 'every kind of edit lands on its own key');
  }

  A.report('plan-poster');
})().catch(e => { console.log('FAIL: plan-poster.test threw - ' + (e && e.stack || e)); process.exit(1); });
