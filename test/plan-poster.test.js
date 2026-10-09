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
     • a newer offer supersedes a pending retry, and a LATE stale response can never commit its hash */
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
const makePlanPoster = eval('(function(){' + block + '\nreturn makePlanPoster;})()');

// ---- a deterministic harness: posts resolve by hand, timers fire by hand ----
function harness() {
  const h = { posts: [], warns: [], timers: [], canceled: [] };
  h.poster = makePlanPoster({
    post: plan => new Promise((resolve, reject) => { h.posts.push({ plan, resolve, reject }); }),
    warn: m => h.warns.push(m),
    delay: (fn, ms) => { const id = h.timers.length; h.timers.push({ fn, ms, id, fired: false }); return id; },
    cancel: id => { h.canceled.push(id); const t = h.timers[id]; if (t) t.fired = true; }   // dead timers never fire
  });
  h.pending = () => h.timers.filter(t => !t.fired);
  h.fire = () => { const t = h.pending()[0]; A.ok(t, 'a retry timer is pending to fire'); t.fired = true; t.fn(); };
  return h;
}
const tick = () => new Promise(r => setImmediate(r));   // let settled promise callbacks run

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

  A.report('plan-poster');
})().catch(e => { console.log('FAIL: plan-poster.test threw - ' + (e && e.stack || e)); process.exit(1); });
