'use strict';
/* node test/line-hold.wiring.http.test.js — THE HOLD ON A REAL STATION, ON EVERY ESCALATION WIRING AND REPLY FORM (line-hold lane, S1;
   invariants gh122-matrix-holds-durably, no-verdict-holds-with-zero-spend, held-job-never-spends, restart-keeps-the-hold,
   approve-resumes-from-the-cursor-and-delivers-the-draft).

   The in-process tests (line-hold.matrix, line-hold.policy) prove the hold through the real chain, router and runner with the station's own
   proofs lifted out of sidecar/index.js. This one proves it through the PRODUCTION WIRING: one real sidecar over a temp workspace (a local
   OpenAI-compatible model stands in for the provider), deployed the way the page deploys a floor (POST /api/roster, POST /api/routing with
   Pipeline.compileRoutingPlan(geometry(gate, wiring)), then POST /api/routing/sample), and read back over the routes and the event feed the
   WORKFLOWS window uses.

   For each of the rig's four WIRINGS (esc unwired, esc to a dock, esc to an OUTBOX only, a human OUTBOX beside a downstream dock) four jobs
   run on a six-pass gate: the reviewer forgets its VERDICT line, or says BLOCKED at the first pass, after one revise and after five. The
   forms BLOCKED can take (the matrix's own table, line-hold-rig FORMS) rotate over the wirings and passes: UPPER, markdown, a trailing
   line and a quoted tail are read at the first pass, plain at the others, and every form at least twice. Each job:
     - ends HELD (status held, a version 1 continuation in phase held, endedAt null) for the reason the reply earned (missing_verdict | blocked);
     - made exactly the provider calls up to and including the reviewer's pass, and none after: no escalation, no publisher, no fixer;
     - delivered nothing: no line-output on the station's event feed, nothing in the deliverables library, no SEND TO, no unapproved note.
   One real restart then finds every held job byte for byte as it was, boots without a provider call, and repeated reads buy nothing. After
   the restart and the crew push, APPROVE on a human OUTBOX beside a downstream dock (the dock reaches an OUTBOX of its own, so there is a
   delivery to make) runs the publisher once from the saved draft and delivers once; a duplicate POST buys nothing; no other held job moves.
   CONTROL: a reviewer that answers with EMPTY text is a failed stage, not a verdict (stage_empty): the job ends 'problem', ships nothing and
   does NOT hold. It is pinned so that holding it instead is a deliberate change (the plan leaves that to Andrew).

   RED PROOF (working-tree mutations, never committed; 2026-11-04): with chain.js loopDecision's verdict block disabled every missing-verdict
   job, on every floor, goes six passes round the gate (12 provider calls) and ships unapproved: 200 delivered, a line-output on the feed
   (69 problems; a BLOCKED reply is still held by the stage-level heldStop). With the production lineRunner in sidecar/index.js built with
   hold: null all 18 jobs end a dead 'problem' with no continuation, the stop note still saying "held" (187 problems).
   The jobs a station may hold at once are bounded (linejobs.js MAX_HELD, 40): this file parks 18.

   Deploys: a floor is SAVED whole and its hint posted (test/helpers/saved-floor.js publishFloor), exactly as line-hold.e2e.http and
   line-hold.restart.http do: the saved floor is the routing authority and the posted plan only a hint (ported in batch 4c). */
const assert = require('node:assert/strict');
const http = require('node:http');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { sseQuery } = require('./_httpToken.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { geometry, WIRINGS, FORMS, REVISE } = require('./helpers/line-hold-rig.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');

const MISSING = 'looks fine to me, ship it';   // a reviewer that forgot its VERDICT line (the matrix's silent reviewer)
const PUBLISHED = 'The post is live: published once.';
let GATE = '12,4';                              // the LOOP gate's id on the rig's floor (the saved floor moves it: set from the first floor deployed)
const PASSES = 6;                               // its cap: a BLOCKED at the fifth revise is still a hold, not a spent gate
const STAGE_PAIR = ['draft-model', 'review-model'];
const belt = (x, y, dir) => ({ x, y, dir });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the fourth wiring with the done lane's dock given an OUTBOX of its own (the rig's dock is a dead end: an approved job has nowhere to land
// there), so APPROVE has a real delivery to make on a floor whose escalation lane still ends at a human OUTBOX
function humanBesideDockWithOutbox() {
  const g = geometry({ maxIter: PASSES }, 'human OUTBOX beside a downstream dock');
  g.belts.push(belt(17, 4, 'E'), belt(18, 4, 'E'));
  g.props.push({ id: 'p8', t: 'outbox', x: 19, y: 3, w: 2, h: 2 });
  return g;
}

/* the station's event feed (what the page reads): a job that reaches an OUTBOX is announced as `workitem.delivered`, box 'line-output'
   (chain.js), so "nothing was delivered" is read off the feed itself and not inferred from a record. A feed dies with its sidecar. */
async function openFeed(fixture) {
  const ac = new AbortController(), events = [];
  const res = await fetch(fixture.baseUrl + '/api/channels/events?' + sseQuery(fixture.token), { signal: ac.signal });
  assert.equal(res.status, 200, 'the station event feed opens');
  const reader = res.body.getReader();
  const reading = (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let end;
        while ((end = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, end).trim(); buf = buf.slice(end + 1);
          if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) { /* a partial line is not an event */ } }
        }
      }
    } catch (error) { if (!ac.signal.aborted) throw error; }
  })();
  return { events, async close() { ac.abort(); await reading; } };
}
const isDelivery = e => !!e && e.name === 'workitem.delivered' && !!e.payload && (e.payload.finalQueueId === 'outbox' || e.payload.box === 'line-output');

(async () => {
  const calls = [];                              // { model, prompt } for every provider call, in order
  let script = { replies: [], said: 0, drafts: 0 };   // what the reviewer says on each of ITS turns for the job in hand (the last repeats)
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(req.url.includes('/models') ? { data: ['draft-model', 'review-model', 'publish-model', 'fix-model'].map(id => ({ id, context_length: 8000 })) } : { ok: true }));
    }
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw), last = (body.messages || []).slice(-1)[0] || {};
      calls.push({ model: body.model, prompt: String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) });
      const text = body.model === 'review-model' ? script.replies[Math.min(script.said++, script.replies.length - 1)]
        : body.model === 'draft-model' ? 'Draft ' + (++script.drafts) + ' of the post.'
        : body.model === 'publish-model' ? PUBLISHED : 'A fix of the post.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'line-hold-wiring-', timeoutMs: 40000, env: {
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
    CUSTOM_OPENAI_KEY: 'direct-fixture', CUSTOM_OPENAI_BASE_URL: base + '/v1',
    STARNET_LIVE_PRICES: '0', STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0',
    STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: ''
  } });
  const api = (method, route, body) => fixture.json(method, route, body);
  const models = from => calls.slice(from).map(c => c.model);
  const job = async id => (await api('GET', '/api/line-jobs/' + id)).body.job;
  const jobsOf = async line => (await api('GET', '/api/line-jobs?line=' + encodeURIComponent(line))).body.jobs;
  let feed = null;
  const deliveries = (from) => feed.events.slice(from || 0).filter(isDelivery).map(e => e.payload);
  // a RESULT is waited for by polling for it, never slept on
  const poll = async (get, ok, what) => {
    for (let i = 0; i < 160; i++) { const v = await get(); if (ok(v)) return v; await sleep(100); }
    const z = await get();
    throw new Error('timed out waiting for ' + what + ': ' + JSON.stringify(z && z.status !== undefined ? { status: z.status, stop: z.stop, error: z.error, runs: z.runs && z.runs.map(r => [r.agentId, r.reason, r.outcome, r.failureCode]), term: z.continuation && z.continuation.terminal } : z));
  };
  const until = (id, pred, what) => poll(() => job(id), pred, what);
  // a NEGATIVE cannot be waited for, only watched: the provider-call count (and the feed's deliveries) are polled for `ms`, and the watch ends the moment either moves
  const stays = async (from, ms, feedFrom) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (calls.length !== from || (feedFrom !== undefined && deliveries(feedFrom).length)) return false; await sleep(50); }
    return calls.length === from && (feedFrom === undefined || !deliveries(feedFrom).length);
  };
  try {
    await fixture.start();
    feed = await openFeed(fixture);
    await api('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const agents = [{ agentId: 'drafter', name: 'Drafter', system: 'Draft.', provider: 'custom', model: 'draft-model' },
      { agentId: 'reviewer', name: 'Reviewer', system: 'Review.', provider: 'custom', model: 'review-model' },
      { agentId: 'publisher', name: 'Publisher', system: 'Publish.', provider: 'custom', model: 'publish-model' },
      { agentId: 'fixer', name: 'Fixer', system: 'Fix.', provider: 'custom', model: 'fix-model' }];
    const crew = async () => assert.equal((await api('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);   // the page pushes its crew when it connects
    await crew();
    // the floor is deployed the way line-hold.e2e.http deploys it: SAVED (the saved floor is the routing authority; a console in the room gives each bay its object)
    const deploy = async (geo, label) => {
      const published = await publishFloor({ json: api }, floorOf(geo), { label });
      A.ok(published.receipt && published.receipt.ok === true, label + ': the floor deploys: ' + JSON.stringify(published.receipt).slice(0, 200));
      GATE = Object.keys(published.plan.junctions).find(k => published.plan.junctions[k].kind === 'loop') || GATE;
      return published.plan.lineOfProp.p1;
    };
    const libraryRows = async () => (await api('GET', '/api/deliverables')).body.items || [];
    const holdWord = { blocked: /answered VERDICT: blocked/, missing_verdict: /gave no usable VERDICT line/ };
    const heldJobs = [];   // every job the matrix parked: { id, label, reason, saved }

    /* ONE JOB, down one wiring: the reviewer's words per turn (`k` revises, then `reply`), and everything it must and must not have done */
    let seq = 0;
    const runCase = async (line, wiring, c) => {
      const label = wiring + ' / ' + c.name, n = ++seq;
      script = { replies: [...Array(c.k).fill(REVISE), c.reply], said: 0, drafts: 0 };
      const from = calls.length;
      const sent = await api('POST', '/api/routing/sample', { line, text: 'Write post ' + n + ' about the moon.', name: 'Post ' + n });
      const id = sent.body.jobId, b = sent.body;
      A.ok(/^job-[a-z0-9]{8,24}$/.test(String(id)), label + ': the answer names the durable job: ' + id);
      A.eq([sent.status, b.ok, b.outcome, b.stop && b.stop.code, b.delivered], [502, false, 'blocked', 'blocked', null], label + ': the route says the job did not deliver: blocked');
      A.ok(!('sentTo' in b) && !('onwardDestinations' in b) && !('unapproved' in b) && !('shipped' in b), label + ': no SEND TO, no unapproved note, nothing shipped in the answer');
      // exactly the stages up to and including the reviewer's pass: the entry draft, then the reviewer, then a draft and a reviewer per revise
      A.eq(models(from), [...Array(c.k + 1)].flatMap(() => STAGE_PAIR), label + ': the provider was called for the stages up to the reviewer\'s pass and for nothing after it');
      const j = await job(id), cn = j.continuation || {};
      A.eq([j.status, j.outcome, j.endedAt, j.output, j.stop && j.stop.code, j.sentTo], ['held', 'blocked', null, '', 'blocked', undefined], label + ': the record is HELD, not finished, with no output and no SEND TO');
      A.eq([cn.version, cn.revision, cn.phase, cn.activeDecision, cn.terminal, cn.publication, (cn.decisions || []).length], [1, 1, 'held', null, null, null, 0], label + ': a version 1 continuation, first revision, in phase held, no decision, no result');
      A.eq([cn.hold && cn.hold.reason, cn.hold && cn.hold.gateId, cn.hold && cn.hold.pass, cn.hold && cn.hold.allowed], [c.reason, GATE, c.k, ['approve', 'send_back', 'stop']], label + ': held at the gate on the pass it stopped on, for the reason the reply earned');
      A.eq([cn.walk && cn.walk.next.kind, cn.walk && cn.walk.current.agentId, cn.walk && cn.walk.gates], ['gate', 'reviewer', [{ id: GATE, count: c.k, max: PASSES }]], label + ': the cursor is the gate and its pass count');
      A.eq([cn.walk && cn.walk.lastHanded, cn.walk && cn.walk.product.text, cn.walk && cn.walk.product.verdict], ['Draft ' + (c.k + 1) + ' of the post.', c.reply, c.reason === 'blocked' ? 'blocked' : null], label + ': the draft under review and the reviewer\'s whole word are kept');
      A.ok(cn.attempts && cn.attempts.length === c.k * 2 + 2 && cn.attempts.every(a => a.state === 'observed') && cn.accounting.dayReceipts.length === 0, label + ': one observed attempt per paid stage, and the hold noted nothing in the day ledger again');
      // WORKFLOWS lists it as held, with the sentence that says why
      const row = (await jobsOf(line)).find(x => x.id === id);
      A.eq([row && row.status, row && row.endedAt, row && row.hold && row.hold.reason, row && row.hold && row.hold.pass], ['held', null, c.reason, c.k], label + ': WORKFLOWS lists it as held');
      A.ok(row && row.hold && holdWord[c.reason].test(row.hold.why), label + ': and says why: ' + (row && row.hold && row.hold.why));
      A.ok(!(await libraryRows()).some(r => r.id === 'line:' + id), label + ': not in the deliverables library: a job waiting for a person is no finished output');
      heldJobs.push({ id, label, reason: c.reason, saved: JSON.stringify(j), line });
      return { id, from, sent };
    };
    /* CONTROL: a reviewer that answers with NOTHING is a failed stage in the run layer: one retry, then the job ends 'problem' (stage_empty).
       It is not a verdict, so it never holds, and it never ships. Pinned: a later change to hold it instead must be a deliberate one. */
    const runEmpty = async (line, wiring) => {
      const label = wiring + ' / empty reviewer reply (control)', n = ++seq;
      script = { replies: [''], said: 0, drafts: 0 };
      const from = calls.length;
      const sent = await api('POST', '/api/routing/sample', { line, text: 'Write post ' + n + ' about the sun.', name: 'Post ' + n }), b = sent.body;
      A.eq([sent.status, b.ok, b.stop && b.stop.code, b.delivered], [502, false, 'stage_empty', null], label + ': the job did not deliver: stage_empty');
      A.ok(/reviewer returned nothing/.test(String(b.stop && b.stop.why)), label + ': in words: ' + (b.stop && b.stop.why));
      const j = await job(b.jobId);
      A.eq([j.status, j.continuation === undefined, j.endedAt !== null, j.stop && j.stop.code, j.sentTo], ['problem', true, true, 'stage_empty', undefined], label + ': a finished problem, NOT a hold: no continuation, nothing sent on');
      A.ok(/reviewer returned nothing/.test(j.output) && !j.output.includes(PUBLISHED), label + ': what it shows is the stop in words, not a delivery: ' + JSON.stringify(j.output));
      A.eq(models(from), ['draft-model', 'review-model', 'review-model'], label + ': the drafter, the reviewer and its one retry, and nothing after');
      A.ok(!('sentTo' in b) && !('unapproved' in b) && !('shipped' in b), label + ': no SEND TO, no unapproved note, nothing shipped in the answer');
      A.eq((await libraryRows()).filter(r => r.id === 'line:' + b.jobId).map(r => r.status), ['failed'], label + ': the library files it as a FAILED job, never a produced one');
    };

    /* ---- 1. THE MATRIX, one wiring after another on the one station ---- */
    const feedFrom = feed.events.length;
    for (const [w, wiring] of WIRINGS.entries()) {
      const line = await deploy(geometry({ maxIter: PASSES }, wiring), wiring);
      const form = n => FORMS[(w + n) % FORMS.length];   // the first pass reads UPPER, markdown, a trailing line, a quoted tail on the four wirings; the later passes take the next two forms
      await runCase(line, wiring, { name: 'no VERDICT line', k: 0, reply: MISSING, reason: 'missing_verdict' });
      await runCase(line, wiring, { name: 'BLOCKED ' + form(1)[0], k: 0, reply: form(1)[1], reason: 'blocked' });
      await runCase(line, wiring, { name: 'BLOCKED ' + form(2)[0] + ' after 1 revise', k: 1, reply: form(2)[1], reason: 'blocked' });
      await runCase(line, wiring, { name: 'BLOCKED ' + form(3)[0] + ' after 5 revises', k: 5, reply: form(3)[1], reason: 'blocked' });
      if (w === WIRINGS.length - 1) await runEmpty(line, wiring);   // (the wiring with the most ways out; the stage fails before the gate, so the others cannot differ)
    }

    /* ---- the floor APPROVE will use: the human OUTBOX wiring, its done lane's dock given an OUTBOX of its own (deployed last: a held job is
       decided on the floor it was held on) ---- */
    const approveLine = await deploy(humanBesideDockWithOutbox(), 'human OUTBOX beside a downstream dock (with its own OUTBOX)');
    const forApprove = [];
    forApprove.push(await runCase(approveLine, 'human OUTBOX + dock OUTBOX', { name: 'BLOCKED markdown after 1 revise', k: 1, reply: FORMS[2][1], reason: 'blocked' }));
    forApprove.push(await runCase(approveLine, 'human OUTBOX + dock OUTBOX', { name: 'no VERDICT line', k: 0, reply: MISSING, reason: 'missing_verdict' }));
    A.ok(feed.events.length > feedFrom, 'the station\'s event feed is alive: it carried ' + (feed.events.length - feedFrom) + ' events while the jobs ran');
    A.ok(await stays(calls.length, 400, feedFrom), 'and not one of them is a delivery to an OUTBOX: ' + JSON.stringify(deliveries(feedFrom)));
    A.eq(heldJobs.length, 18, 'eighteen jobs are parked on the one station (the bound is forty)');
    const inLibrary = (await libraryRows()).filter(r => heldJobs.some(h => r.id === 'line:' + h.id)).map(r => r.id);
    A.eq(inLibrary, [], 'no held job is in the deliverables library');

    /* ---- 2. ONE REAL RESTART: every held job is as it was, the boot bought nothing, reading buys nothing ---- */
    await feed.close();
    const callsBefore = calls.length;
    await fixture.restart();
    feed = await openFeed(fixture);
    for (const h of heldJobs) {
      const j = await job(h.id), cn = j.continuation || {};
      A.eq([j.status, j.endedAt, cn.phase, cn.revision, cn.hold && cn.hold.reason], ['held', null, 'held', 1, h.reason], h.label + ': after the restart still HELD at the same revision (not interrupted)');
      A.ok(JSON.stringify(j) === h.saved, h.label + ': the job id, revision, draft, cursor and taint are byte for byte the saved ones');
    }
    A.ok(await stays(callsBefore, 800, 0), 'boot made zero provider calls and delivered nothing (' + callsBefore + ' calls before the restart, ' + calls.length + ' after)');
    for (let i = 0; i < 3; i++) {
      const list = await jobsOf(approveLine);
      A.eq(heldJobs.every(h => list.some(x => x.id === h.id && x.status === 'held')), true, 'read ' + (i + 1) + ': the list after the restart still shows every parked job as held');
      for (const h of heldJobs.slice(0, 4)) await job(h.id);
    }
    A.ok(await stays(callsBefore, 300, 0), 'repeated reads bought nothing');
    A.eq((await libraryRows()).filter(r => heldJobs.some(h => r.id === 'line:' + h.id)).length, 0, 'still not a deliverable after the restart');

    /* ---- 3. APPROVE, after the restart and the crew push: the publisher runs once from the saved draft, and delivers once ---- */
    await crew();
    for (const [i, held] of forApprove.entries()) {
      const rec = heldJobs.find(h => h.id === held.id), label = rec.label + ' (' + rec.reason + ')';
      let j = await job(held.id);
      if (j.status !== 'held' || !j.continuation) { A.ok(false, label + ': is not held, so there is no decision to take (it is ' + j.status + ')'); continue; }
      const draft = j.continuation.walk.lastHanded, reply = j.continuation.walk.product.text, revision = j.continuation.revision, before = calls.length, token = 'tok-wiring-' + i, deliveredBefore = deliveries(0).length;
      const d1 = await api('POST', '/api/line-jobs/' + held.id + '/decision', { action: 'approve', token, revision, note: '' });
      A.eq([d1.status, d1.body.ok, d1.body.running], [202, true, true], label + ': APPROVE is claimed and carried on: 202');
      j = await until(held.id, x => x.status === 'delivered', 'the delivery of ' + label);
      A.eq([j.outcome, models(before), j.output], ['delivered', ['publish-model'], PUBLISHED], label + ': the PUBLISHER ran once from the saved cursor, and its answer is the delivery');
      A.ok(calls[before].prompt.includes(draft) && !calls[before].prompt.includes(reply), label + ': it was handed the saved draft (' + draft + '), not the reviewer\'s word');
      const c = j.continuation;
      A.eq([c.phase, c.publication && c.publication.state, c.decisions.map(d => [d.token, d.action, d.state]), c.activeDecision, c.accounting.dayReceipts.length], ['complete', 'confirmed', [[token, 'approve', 'complete']], null, 0], label + ': the saved record is complete: the decision done, the publication confirmed, nothing re-noted in the day ledger');
      A.ok((await libraryRows()).some(r => r.id === 'line:' + held.id && r.status === 'produced'), label + ': the delivered job is in the deliverables library now');
      const made = await poll(async () => deliveries(0).slice(deliveredBefore), d => d.length >= 1, 'the OUTBOX delivery of ' + label);
      A.eq([made.length, made[0].box], [1, 'line-output'], label + ': one delivery reached the OUTBOX, announced once');
      const mark = feed.events.length, dup = await api('POST', '/api/line-jobs/' + held.id + '/decision', { action: 'approve', token, revision, note: '' });
      A.eq([dup.status, dup.body.replayed, dup.body.receipt && dup.body.receipt.token], [200, true, token], label + ': a duplicate POST is the saved receipt');
      A.ok(await stays(before + 1, 500, mark), label + ': and buys no provider call and no second delivery');
      const other = await api('POST', '/api/line-jobs/' + held.id + '/decision', { action: 'approve', token: token + '-b', revision, note: '' });
      A.eq([other.status, calls.length], [409, before + 1], label + ': another decision on the finished job is refused');
      A.eq((await jobsOf(approveLine)).filter(x => x.id === held.id).map(x => x.status), ['delivered'], label + ': one job record, delivered once');
    }
    // one decision moves only its own job: every other parked job is still the very record it was
    for (const h of heldJobs.filter(x => !forApprove.some(f => f.id === x.id))) A.ok(JSON.stringify(await job(h.id)) === h.saved, h.label + ': untouched by the decisions on the others');
    await feed.close(); feed = null;
    A.report('line-hold.wiring.http');
  } finally {
    if (feed) { try { await feed.close(); } catch (_) { /* the sidecar is going */ } }
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
