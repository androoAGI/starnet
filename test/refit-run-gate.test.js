/* node test/refit-run-gate.test.js — a run trigger fired while REFIT is open must run the line the user
   just drew, not the last one the sidecar heard about (2026-08-22 truthful-telemetry fix).

   REFIT freezes the world (world.stop), so a floor edit set geoDirty but the recompile + POST to
   /api/routing only ran on the next frame — at REFIT close. The FINISH card's sample and the ROUTINES
   RUN NOW therefore dispatched against the LAST POSTED plan. Contract under test:
     1. PLAN POSTER — flush() resolves on the server's verdict (200 / 422 / failure), at once when idle;
        the shipped block is executed (plan-poster idiom), not a copy.
     2. RUN GATE — finPlanGate (extracted from build.js) awaits World.syncPlan() and REFUSES with the floor's
        own nag copy on blocking errors, on a 422-refused floor, and on an unanswered POST; a clean,
        committed plan passes. A dirty plan is posted BEFORE the sample dispatches (call order).
     3. SOURCE — the sample and the ROUTINES RUN NOW both gate on syncPlan before their fetch, and the
        button copy walks "posting line…" → "running". */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const src = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const world = src('world.js'), build = src('build.js'), routines = src('windows/routines.js');
const extract = (s, B, E) => { const i0 = s.indexOf(B), i1 = s.indexOf(E); A.ok(i0 >= 0 && i1 > i0, B + ' markers present'); return s.slice(s.indexOf('*/', i0) + 2, s.lastIndexOf('/*', i1)); };
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  /* ---------- 1. poster flush ---------- */
  const makePlanPoster = eval('(function(){' + extract(world, 'PLAN-POSTER-BEGIN', 'PLAN-POSTER-END') + '\nreturn makePlanPoster;})()');
  {
    const posts = [];
    const poster = makePlanPoster({ post: () => new Promise((res, rej) => posts.push({ res, rej })), warn: () => {}, delay: () => 1, cancel: () => {} });
    let idle = null; poster.flush().then(s => { idle = s; }); await tick();
    A.ok(idle && idle.lastHash === null && !idle.stale, 'flush() on an idle poster resolves at once');
    poster.offer({ hash: 'p1' }, 'h1');
    let got = null; poster.flush().then(s => { got = s; }); await tick();
    A.eq(got, null, 'flush() waits while the POST is in flight');
    posts[0].res({ ok: true, status: 200 }); await tick();
    A.ok(got && got.lastHash === 'h1' && !got.stale, 'flush() resolves on the 200 with the committed hash');
    poster.offer({ hash: 'p2' }, 'h2');
    got = null; poster.flush().then(s => { got = s; }); await tick();
    posts[1].res({ ok: false, status: 422 }); await tick();
    A.ok(got && got.refusedHash === 'h2' && got.lastHash === 'h2', 'flush() resolves on a 422 with the refusal recorded');
    poster.offer({ hash: 'p3' }, 'h3');
    got = null; poster.flush().then(s => { got = s; }); await tick();
    posts[2].rej(new Error('down')); await tick();
    A.ok(got && got.stale && got.lastHash === 'h2', 'flush() resolves on a failed attempt with stale=true (never commits the new hash)');
  }

  /* ---------- 2. the run gate ---------- */
  const gateSrc = extract(build, 'RUN-GATE-PURE-BEGIN', 'RUN-GATE-PURE-END');
  const VAL_LABEL = { CYCLE: 'LOOP! — BREAK THE CIRCLE', UNBOUND_BAY: 'NO AGENT — CLICK' };
  const mkGate = w => new Function('opts', 'VAL_LABEL', gateSrc + '\nreturn finPlanGate;')({ world: w }, VAL_LABEL);
  const clean = { errors: [], lastHash: 'h', refusedHash: null, stale: false, inflight: false, retryPending: false };
  A.eq(await mkGate({ syncPlan: () => Promise.resolve(clean) })({}), null, 'a clean committed plan passes the gate');
  const r1 = await mkGate({ syncPlan: () => Promise.resolve(Object.assign({}, clean, { errors: [{ code: 'CYCLE' }, { code: 'CYCLE' }] })) })({});
  A.ok(r1 && /LOOP! — BREAK THE CIRCLE/.test(r1.refuse) && r1.refuse.split('LOOP!').length === 2, 'blocking errors refuse with the floor\'s own nag copy (deduped)');
  const r2 = await mkGate({ syncPlan: () => Promise.resolve(Object.assign({}, clean, { refusedHash: 'h' })) })({});
  A.ok(r2 && /refused this line/.test(r2.refuse), 'a 422-refused floor refuses');
  const r3 = await mkGate({ syncPlan: () => Promise.resolve(Object.assign({}, clean, { stale: true, retryPending: true })) })({});
  A.ok(r3 && /NOT run/.test(r3.refuse), 'an unanswered POST refuses — the old line is never run');
  const r4 = await mkGate({ syncPlan: () => Promise.reject(new Error('x')) })({});
  A.ok(r4 && r4.refuse, 'a throwing sync refuses');
  A.eq(await mkGate(null)({}), null, 'no world (headless harness) = no gate, unchanged behavior');
  // ORDER: a dirty plan is posted (sync resolves) BEFORE the sample dispatch — the gate is awaited, never raced
  {
    const order = [];
    const gate = mkGate({ syncPlan: () => { order.push('post'); return new Promise(r => setTimeout(() => { order.push('committed'); r(clean); }, 5)); } });
    await gate({}).then(g => { A.eq(g, null, 'gate passes'); order.push('dispatch'); });
    A.eq(order, ['post', 'committed', 'dispatch'], 'the sample dispatches only AFTER the server committed the plan');
  }

  /* ---------- 3. source wiring ---------- */
  /* the WHOLE function, never a fixed character window: a 2500-char slice went red the day finRunSample's settle grew a
     field (the sample POST slid past the window while the gate order was still right). Brace-count from the body's own
     `{` — after the parameter list, because `options = {}` holds the first brace — with A.fnBody, plus the length guard
     its header note asks for (a mis-scan runs long, so the body must be non-empty and far shorter than the file). */
  const fn = (s, name) => {
    const i = s.indexOf('function ' + name + '('); A.ok(i >= 0, name + ' exists');
    const open = s.indexOf(') {', i);
    const body = s.slice(i, open + 2) + A.fnBody(s.slice(open + 2), '{');
    A.ok(body.length > 200 && body.length < 12000, name + ' body scanned to its own closing brace (' + body.length + ' chars)');
    return body;
  };
  const rs = fn(build, 'finRunSample');
  A.ok(rs.indexOf('finPlanGate(c).then') >= 0 && rs.indexOf('finPlanGate(c).then') < rs.indexOf('/api/routing/sample'), 'finRunSample gates on finPlanGate BEFORE the sample POST');
  A.ok(/phase: 'post'/.test(rs) && /phase: 'run'/.test(rs), 'the sample walks phase post → run');
  A.ok(/POSTING LINE…/.test(build) && /RUNNING — THE JOB IS RIDING THE LINE…/.test(build), 'the FINISH card reads "posting line…" then "running"');
  A.ok(/syncPlan: \(\) => \{/.test(world) && /if \(station && \(geoDirty \|\| !geo\)\) rederive\(\);/.test(world), 'World.syncPlan recompiles a dirty floor before flushing');
  const ri = routines.indexOf("if (act === 'run')");
  const run = routines.slice(ri, ri + 3000);
  A.ok(run.indexOf('W.syncPlan()') >= 0 && run.indexOf('W.syncPlan()') < run.indexOf("fetch('/api/cron/run'"), 'ROUTINES RUN NOW awaits World.syncPlan before /api/cron/run');
  A.ok(/… posting line/.test(run) && /… running/.test(run), 'RUN NOW reads "posting line" then "running"');
  A.ok(/Build\.nagLabel/.test(run) && /nagLabel: code => VAL_LABEL\[code\]/.test(build), 'RUN NOW refuses with the floor\'s nag copy via Build.nagLabel');
  A.report('refit-run-gate');
})();
