'use strict';
/* test/cli-dashboard-drive.test.js — the REAL `starnet` dashboard (bin/lib/dashboard.js runDashboard) driven by typed keys
   against a FAKE station: an in-process HTTP server on an ephemeral 127.0.0.1 port (never a real station, no spend). It
   locks what the 0.14.0 re-cut review proved broken in the app commands the terminal runs (review 10-24):
     1. /goal: a pause during a step, then resume, sends the next step (it used to wedge for good)
     2. /goal: a step the station refuses (402) pauses the goal and says why; resume tries again
     3. /goal: /stop on a step pauses the goal — its partial reply is never judged, no next paid step starts
     4. a message queued while a turn runs stays in ITS conversation across /new (never sent into the fresh one)
     5. /loop fires only into the conversation it was set in, and skips while another one is shown
     6. a reasoning effort the station clears is no longer sent on the terminal's runs
     7. the "/" menu: a whole word typed runs as typed (/stat), a lone "/" + enter runs nothing, ↑ stays history
     8. /compress measures against the run window; /insights keeps the fold's labels and "at least"
   …and what the review of that fix proved (review 10-24, second pass):
     9. a row picked in a "/" menu given up (esc) never runs on a recalled line: enter runs the recalled command
    10. a queued message waits only for ITS conversation (never behind one for an earlier conversation), and one sent to
        an earlier conversation is shown as such
    11. a /goal steps only while its conversation is shown: after /new no paid step goes where /goal cannot see it, /goal
        status says it waits, and /resume back to it sends the next step
    12. a /loop that replaces one running says so (the replaced one was ended with no line)
    13. /yolo when the app did not confirm in time: the terminal says what the station holds now (never "still will
        ask first" while the roster says full), and a /yolo off the app's save did not take says so
   Timers: the dashboard's 1-minute loop clock and 20 s roster refresh are shortened here (setTimeout/setInterval for
   exactly those delays), so the test runs in seconds. */
const os = require('os');
const http = require('http');
const { PassThrough } = require('stream');
const A = require('./_assert.js');
const { runDashboard } = require('../bin/lib/dashboard.js');
const slash = require('../sidecar/slash.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the loop's minimum interval (60 s) and the roster refresh (20 s), shortened for this process
const realSetTimeout = global.setTimeout, realSetInterval = global.setInterval;
global.setTimeout = function (fn, ms, ...rest) { return realSetTimeout(fn, ms === 60000 ? 400 : ms, ...rest); };
global.setInterval = function (fn, ms, ...rest) { return realSetInterval(fn, ms === 20000 ? 300 : ms, ...rest); };

function fakeStation(opts) {
  const o = opts || {};
  const runs = [];            // every POST /api/run: { runId, body }
  const live = new Map();     // runId -> { body, res }
  const hits = [];            // every request: { method, path, body }
  const ended = [];           // every run that ended (GET /api/runs lists them: the /resume picker reads conversations there)
  const roster = { agents: [{ agentId: 'agent', name: 'ULTRON', model: 'test/m', provider: 'openrouter', reasoningEffort: o.effort === undefined ? null : o.effort, approvalMode: 'ask', personaId: null }].concat(o.agents || []) };
  let feed = null, evId = 0, seq = 0;
  const emit = (name, payload) => { if (feed) feed.write('id: ' + (++evId) + '\ndata: ' + JSON.stringify({ name, payload }) + '\n\n'); };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const p = u.pathname;
      let b = null; try { b = body ? JSON.parse(body) : null; } catch (_) {}
      hits.push({ method: req.method, path: p + u.search, body: b });
      if (o.routes && o.routes[p]) { const r = o.routes[p](b) || {}; return json(res, r.status || 200, r.body || {}); }   // a case's own answers
      if (p === '/api/runtime/agent') return json(res, 200, Object.assign({ configured: true, version: 'dev' }, roster));
      if (p === '/api/state/snapshot') return json(res, 200, { runs: [...live.values()].filter(r => !r.body.internal).map(r => ({ runId: r.runId, agentId: r.body.agentId, streamId: r.body.streamId, startedAt: r.at })), prompts: [] });
      if (p === '/api/runs') return json(res, 200, { runs: ended });
      if (p === '/api/agent/approval' && o.approval) { const r = o.approval(b, roster); return json(res, r.status, r.body); }
      if (p === '/api/transcript') return json(res, 200, { turns: [] });
      if (p === '/api/save') return json(res, 200, { save: { agent: { id: 'agent', name: 'ULTRON', onboarded: true, purpose: 'p' } } });
      if (p === '/api/slash/catalog') return json(res, 200, slash.catalog({}));
      if (p === '/api/slash/dispatch') return json(res, 200, { ok: true, directive: { type: 'say', title: 'SPEND', lines: ['spend: $0.00 today'] } });
      if (p === '/api/budget/status' || p === '/api/routing/lines/stats') return json(res, 200, {});
      if (p === '/api/line-jobs') return json(res, 200, { jobs: [] });
      if (p === '/api/providers/connect' && o.connect) { const r = o.connect(b); return json(res, r.status, r.body); }
      if (p === '/api/auth/claude-cli/status' && o.claude) return json(res, 200, o.claude);
      if (p === '/api/providers') return json(res, 200, { providers: (o.providers || ['openrouter']).map(id => ({ id, configured: true })) });
      if (p === '/api/models/openrouter') return json(res, 200, { models: [{ id: 'test/m', context_length: 1048576, runWindow: 200000 }] });
      if (p === '/api/insights') return json(res, 200, { totalRuns: 3, totalUsd: 0.05, totalTokens: 900, avgUsdPerRun: 0.0167, successPct: 100, usageMissingRuns: 1, unpricedRuns: 1, spendUnknownRuns: 1,
        byModel: [{ model: 'sub/model', usd: 0, spendLabel: 'subscription / unmetered' }, { model: 'paid/model', usd: 0.05 }] });
      if (p === '/api/memory/records') return json(res, 200, { records: [] });
      if (p === '/api/observe') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        feed = res;
        res.write('data: ' + JSON.stringify({ stream: 'ready' }) + '\n\n');
        return;
      }
      if (p === '/api/cancel') {
        const r = live.get(b && b.runId);
        if (r) { live.delete(b.runId); emit('agent.run.end', { runId: b.runId, agentId: r.body.agentId, reason: 'cancelled', turns: 1, usd: 0 }); r.res.end(); }
        return json(res, 200, { ok: !!r });
      }
      if (p === '/api/run' && req.method === 'POST') {
        const runId = 'r' + (++seq);
        const rec = { runId, body: b, res, at: Date.now() };
        runs.push(rec);
        if (b.internal) {   // the goal judge: answered on its own stream, never the feed (as the real observer does)
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ name: 'agent.run.start', payload: { runId, agentId: b.agentId } }) + '\n');
          res.write(JSON.stringify({ name: 'agent.token', payload: { runId, delta: '{"verdict":"continue","reason":"more to do"}' } }) + '\n');
          res.end(JSON.stringify({ name: 'agent.run.end', payload: { runId, reason: 'done' } }) + '\n');
          return;
        }
        if (o.refuse && o.refuse(b, runs)) { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end('{"error":"spend cap reached"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        live.set(runId, rec);
        emit('agent.run.start', { agentId: b.agentId, runId, streamId: b.streamId, model: b.model, trigger: 'directive' });
        return;   // held open until end(runId)
      }
      return json(res, 404, { error: 'not here' });
    });
  });
  function end(runId, text, reason) {
    const r = live.get(runId);
    if (!r) return;
    live.delete(runId);
    ended.push({ runId, agentId: r.body.agentId, streamId: r.body.streamId, startedAt: r.at });
    if (text) emit('agent.token', { runId, agentId: r.body.agentId, delta: text });
    emit('agent.run.end', { runId, agentId: r.body.agentId, reason: reason || 'done', turns: 1, usd: 0 });
    r.res.end();
  }
  const token = (runId, text) => { const r = live.get(runId); if (r) emit('agent.token', { runId, agentId: r.body.agentId, delta: text }); };
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, runs, live, hits, roster, end, token, emit })));
}

function clientFor(port) {
  const host = '127.0.0.1', base = 'http://' + host + ':' + port;
  function request(method, p, body, opts) {
    return new Promise(resolve => {
      const headers = { Origin: base };
      let payload = null;
      if (body != null) { payload = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
      const req = http.request({ host, port, method, path: p, headers }, res => {
        const c = []; res.on('data', d => c.push(d));
        res.on('end', () => { const text = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(text); } catch (_) {} resolve({ ok: true, status: res.statusCode, json: j, text }); });
      });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.setTimeout((opts && opts.timeoutMs) || 30000, () => req.destroy(new Error('timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }
  return { base, host, port, request, token: () => 't' };
}

async function boot(opts) {
  const st = await fakeStation(opts);
  const out = new PassThrough(); out.isTTY = true; out.columns = 400; out.rows = 60;
  let raw = ''; out.on('data', d => { raw += d; });
  const inp = new PassThrough(); inp.isTTY = true;
  const exited = runDashboard({ mode: 'attached', workspace: '', child: null, client: clientFor(st.port) }, { stdout: out, stdin: inp, themeFile: (opts && opts.themeFile) || '',
    env: Object.assign({ STARNET_LOGO: 'plain', NO_COLOR: '1', STARNET_STILL: '1', STARNET_MOUSE: '0' }, opts && opts.env) });
  await sleep(1200);
  const keys = async (s, gap) => { for (const ch of s) { inp.write(ch); await sleep(12); } await sleep(gap == null ? 200 : gap); };
  const key = async (seq, gap) => { inp.write(seq); await sleep(gap == null ? 150 : gap); };
  const userRuns = () => st.runs.filter(r => !r.body.internal);
  const judges = () => st.runs.filter(r => r.body.internal);
  // the screen as text: every cursor move starts a new line
  const screen = () => raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
  const mark = () => raw.length;
  const since = at => raw.slice(at).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
  const done = async () => { process.emit('SIGTERM', 'SIGTERM'); await Promise.race([exited, sleep(2000)]); for (const r of st.live.values()) { try { r.res.end(); } catch (_) {} } if (st.srv.closeAllConnections) st.srv.closeAllConnections(); st.srv.close(); };
  return { st, keys, key, userRuns, judges, screen, mark, since, done, raw: () => raw };
}
const UP = '\x1b[A', DOWN = '\x1b[B', ESC = '\x1b';

(async () => {
  process.chdir(os.homedir());   // a home folder: no TRUST THIS FOLDER card in the way

  /* 0. control: no pause — step 1 ends, the judge says continue, step 2 goes out (the harness drives the loop) */
  {
    const d = await boot();
    await d.keys('/goal ship the thing\r', 500);
    const s1 = d.userRuns()[0];
    A.ok(!!s1 && /session goal/i.test(s1.body.messages[0].content), 'control: /goal sends its first step');
    d.st.end(s1.runId, 'I did part of it.');
    await sleep(1200);
    A.eq([d.judges().length, d.userRuns().length], [1, 2], 'control: the judge ran once and step 2 went out');
    A.eq(d.userRuns()[1] && d.userRuns()[1].body.streamId, s1.body.streamId, 'control: step 2 is on the goal\'s own conversation');
    await d.done();
  }

  /* 1. /goal pause during a step, the step ends, /goal resume: the next step goes (it wedged for good) */
  {
    const d = await boot();
    await d.keys('/goal ship the thing\r', 500);
    const s1 = d.userRuns()[0];
    await d.keys('/goal pause\r');
    d.st.end(s1.runId, 'I did part of it.');
    await sleep(600);
    A.eq([d.judges().length, d.userRuns().length], [0, 1], 'pause: a step ending while paused is not judged and starts nothing');
    await d.keys('/goal resume\r', 2500);
    A.eq(d.userRuns().length, 2, 'pause→end→resume: the next step is sent');
    await d.done();
  }

  /* 1b. a message you type during a step pauses the goal (it queues); resume after both turns end sends the next step */
  {
    const d = await boot();
    await d.keys('/goal ship the thing\r', 500);
    const s1 = d.userRuns()[0];
    await d.keys('also mind the tests\r', 300);
    A.eq(d.userRuns().length, 1, 'typed during a step: the message waits (queued), the goal pauses');
    d.st.end(s1.runId, 'step one.');
    await sleep(900);
    const typed = d.userRuns()[1];
    A.ok(!!typed && typed.body.messages[0].content === 'also mind the tests', 'the queued message goes once the step ends');
    if (typed) d.st.end(typed.runId, 'noted.');
    await sleep(500);
    await d.keys('/goal resume\r', 2500);
    A.eq(d.userRuns().length, 3, 'preempt→end→resume: the next step is sent');
    await d.done();
  }

  /* 2. a step the station refuses: the goal pauses and says why; resume tries again */
  {
    let refused = 0;
    const d = await boot({ refuse: b => /session goal/i.test(b.messages[0].content) && refused++ === 0 });
    const at = d.mark();
    await d.keys('/goal ship the thing\r', 800);
    A.eq(refused, 1, 'refused: the station answered the first step 402');
    A.ok(/session goal paused: the last step was refused \(HTTP 402: spend cap reached\)/.test(d.since(at)), 'refused: the goal pauses and says the station\'s reason');
    await d.keys('/goal status\r', 300);
    A.ok(/session goal \(paused/.test(d.since(at)), 'refused: /goal status says paused, never active');
    await d.keys('/goal resume\r', 2500);
    A.eq(d.userRuns().length, 2, 'refused→resume: the step is sent again');
    await d.done();
  }

  /* 3. /stop on a goal's step: never judged on its partial text, no next paid step */
  {
    const d = await boot();
    await d.keys('/goal ship the thing\r', 500);
    const s1 = d.userRuns()[0];
    d.st.token(s1.runId, 'Starting on it: reading the repo');
    await sleep(300);
    const at = d.mark();
    await d.keys('/stop\r', 2500);
    A.ok(!d.st.live.has(s1.runId), '/stop: the step was cancelled');
    A.eq([d.judges().length, d.userRuns().length], [0, 1], '/stop: the partial reply is not judged and no next step is sent');
    A.ok(/session goal paused/.test(d.since(at)), '/stop: the terminal says the goal paused');
    await d.done();
  }

  /* 3b. a step that ends on its own with a non-done reason (budget, error, step limit) pauses, never judged */
  {
    const d = await boot();
    await d.keys('/goal ship the thing\r', 500);
    const s1 = d.userRuns()[0];
    const at = d.mark();
    d.st.end(s1.runId, 'half an answer', 'budget');
    await sleep(1500);
    A.eq([d.judges().length, d.userRuns().length], [0, 1], 'a budget-cut step is not judged and not continued');
    A.ok(/the step stopped \(budget\)/.test(d.since(at)), 'and the terminal says why it paused');
    await d.done();
  }

  /* 4. a queued message keeps its conversation across /new */
  {
    const d = await boot();
    await d.keys('hello there\r', 400);
    const r1 = d.userRuns()[0];
    await d.keys('and also check the logs\r', 300);
    A.eq(d.userRuns().length, 1, 'queue: typed while its conversation runs, the message waits');
    await d.keys('/new\r', 1200);
    A.eq(d.userRuns().length, 1, 'queue: after /new it is NOT sent into the fresh conversation while its own turn still runs');
    d.st.end(r1.runId, 'hi!');
    await sleep(900);
    const r2 = d.userRuns()[1];
    A.ok(!!r2, 'queue: it goes once its own conversation\'s turn ends');
    A.eq(r2 && r2.body.streamId, r1.body.streamId, 'queue: …into the conversation it was typed in');
    await d.done();
  }

  /* 5. /loop belongs to its conversation: after /new its ticks are skipped, back on it they fire into it */
  {
    const d = await boot();
    await d.keys('/loop 1m check the build\r', 100);
    await sleep(700);
    const t1 = d.userRuns()[0];
    A.ok(!!t1 && t1.body.messages[0].content === 'check the build', 'loop: a tick fires on its conversation');
    const loopSid = t1 && t1.body.streamId;
    d.st.end(t1.runId, 'still red');
    await d.keys('/new\r', 1300);
    A.eq(d.userRuns().length, 1, 'loop: while another conversation is shown, its ticks are skipped (never sent into the new one)');
    await d.keys('/loop status\r', 200);
    A.ok(/belongs to an earlier conversation/.test(d.screen()), 'loop: /loop status says it belongs to the earlier conversation');
    await d.keys('/loop off\r', 200);
    await d.done();
    A.ok(!!loopSid, 'loop: the conversation it was set in is known');
  }

  /* 6. a reasoning effort the station clears is no longer sent */
  {
    const d = await boot({ effort: 'xhigh' });
    await d.keys('one\r', 400);
    const r1 = d.userRuns()[0];
    A.eq(r1 && r1.body.reasoningEffort, 'xhigh', 'effort: the roster\'s effort rides the terminal\'s run');
    d.st.end(r1.runId, 'ok');
    d.st.roster.agents[0].reasoningEffort = null;   // the Commander cleared it in the app
    await sleep(900);   // the roster refresh (shortened here)
    await d.keys('two\r', 400);
    const r2 = d.userRuns()[1];
    A.ok(!!r2 && !('reasoningEffort' in r2.body), 'effort: once the roster clears it, the run carries none: ' + JSON.stringify(r2 && r2.body.reasoningEffort));
    if (r2) d.st.end(r2.runId, 'ok');
    await d.done();
  }

  /* 7. the "/" menu */
  {
    const d = await boot();
    await sleep(300);   // the catalog read
    const n0 = d.st.hits.length;
    await d.keys('/stat\r', 600);
    A.ok(d.st.hits.slice(n0).some(h => h.path === '/api/slash/dispatch' && h.body && h.body.input === '/usage'), '/stat + enter opens the STAT page (it reads /usage), not /status');
    await d.keys('hello\r', 300);
    const r1 = d.userRuns()[0];
    d.st.end(r1.runId, 'hi');
    await sleep(300);
    await d.keys('/\r', 500);
    A.eq(d.userRuns().length, 1, 'a lone "/" + enter runs nothing (it used to run /retry: a paid turn)');
    await d.key('\x1b', 100);   // esc: hide the menu, clear the line
    await d.key('\x1b', 100);
    await d.keys('/insights\r', 500);
    await d.keys('/memory\r', 500);
    const n1 = d.st.hits.filter(h => h.path.indexOf('/api/insights') === 0).length;
    await d.key(UP); await d.key(UP);   // past the recalled /memory, back to /insights
    await d.key('\r', 600);
    A.eq(d.st.hits.filter(h => h.path.indexOf('/api/insights') === 0).length, n1 + 1, '↑ ↑ steps back through history over a recalled command (it moved the menu bar), and enter runs /insights');
    await d.done();
  }

  /* 8. /compress against the run window; /insights keeps the fold's labels */
  {
    const d = await boot();
    await d.keys('one\r', 400);
    const r1 = d.userRuns()[0];
    d.st.emit('agent.cost', { runId: r1.runId, agentId: 'agent', tokensIn: 150000 });
    d.st.end(r1.runId, 'ok');
    await sleep(300);
    const at = d.mark();
    await d.keys('/compress\r', 800);
    const c = d.since(at);
    A.ok(/150000 \/ 200000 tokens/.test(c), '/compress measures against the 200k run window, not the 1M the model holds');
    A.ok(/bills a higher rate for a prompt over 200000 tokens/.test(c), '/compress says why the window is smaller');
    const at2 = d.mark();
    await d.keys('/insights\r', 800);
    const s = d.since(at2);
    A.ok(/at least \$0\.05/.test(s), '/insights: a run stopped mid-answer makes the total "at least"');
    A.ok(/sub\/model \(subscription \/ unmetered\)/.test(s) && !/sub\/model \(\$0\.00\)/.test(s), '/insights: a subscription model shows its label, never a bare $0.00');
    A.ok(/1 run with no published price/.test(s) && /1 run with spend unknown/.test(s), '/insights: the unpriced and spend-unknown runs are counted');
    await d.done();
  }

  /* 9. a row picked in a "/" menu you gave up (esc) does not run on a recalled line */
  {
    const d = await boot();
    await sleep(300);
    await d.keys('/status\r', 500);   // history holds /status (it opens the STATUS overlay)
    await d.key(ESC, 800);            // close the overlay
    await d.keys('/', 300);           // the "/" menu…
    await d.key(DOWN, 150);           // …one row down…
    await d.key(ESC, 800);            // …given up: esc hides the menu
    await d.key(ESC, 800);            // esc clears the line
    const at = d.mark();
    await d.key(UP, 200);             // recall /status
    await d.key('\r', 900);
    const out = d.since(at);
    A.ok(/STATUS · ULTRON/.test(out) && !/Chat memory/.test(out), 'enter on a recalled /status runs /status (it ran /compress, the row picked on the line given up)');
    await d.done();
  }

  /* 10. a queued message waits only for its own conversation; one for an earlier conversation is shown as such */
  {
    const d = await boot();
    await d.keys('long task in A\r', 400);
    const r1 = d.userRuns()[0];
    await d.keys('A2 follow-up\r', 300);   // queued for A (r1 runs)
    await d.keys('/new\r', 900);            // conversation B
    await d.keys('hi in B\r', 500);         // B is free: sent now
    const r2 = d.userRuns()[1];
    A.ok(!!r2 && r2.body.streamId !== r1.body.streamId, 'queue: B\'s first message goes at once, on B');
    await d.keys('B2 follow-up\r', 300);   // queued for B (r2 runs)
    d.st.end(r2.runId, 'hello from B');
    await sleep(1500);
    const b2 = d.userRuns().find(r => r.body.messages[0].content === 'B2 follow-up');
    A.ok(!!b2 && b2.body.streamId === r2.body.streamId, 'queue: B\'s follow-up goes once B\'s turn ends, while A\'s still runs (it waited behind A\'s queued one)');
    A.ok(!d.userRuns().some(r => r.body.messages[0].content === 'A2 follow-up'), 'queue: A\'s follow-up still waits for A\'s turn');
    const at = d.mark();
    d.st.end(r1.runId, 'A done');
    await sleep(1500);
    const a2 = d.userRuns().find(r => r.body.messages[0].content === 'A2 follow-up');
    A.eq(a2 && a2.body.streamId, r1.body.streamId, 'queue: A\'s follow-up goes to A once A\'s turn ends');
    A.ok(/\(to an earlier conversation\) A2 follow-up/.test(d.since(at)), 'queue: and the pane (showing B) says it went to an earlier conversation');
    await d.done();
  }

  /* 11. a goal waits while its conversation is not shown; /resume back to it goes on */
  {
    const d = await boot();
    await d.keys('/goal ship the thing\r', 500);
    const s1 = d.userRuns()[0];
    await d.keys('/new\r', 900);
    const at = d.mark();
    await d.keys('/goal status\r', 300);
    A.ok(/session goal set in an earlier conversation waits/.test(d.since(at)), 'goal: /goal status in the new conversation says the earlier one\'s goal waits (it said only "No session goal")');
    d.st.end(s1.runId, 'I did part of it.');
    await sleep(1500);
    A.eq([d.judges().length, d.userRuns().length], [1, 1], 'goal: its step is judged, but no next paid step goes while another conversation is shown');
    A.ok(/its next step waits until that conversation is shown again/.test(d.since(at).replace(/\s+/g, ' ')), 'goal: the judge\'s line says the next step waits');
    await d.keys('/resume\r', 900);   // the picker: this conversation first, then the goal's
    await d.key(DOWN, 200);
    await d.key('\r', 2000);
    const s2 = d.userRuns()[1];
    A.ok(!!s2 && /session goal/i.test(s2.body.messages[0].content) && s2.body.streamId === s1.body.streamId, 'goal: back on its conversation, the next step goes there: ' + JSON.stringify(s2 && s2.body.streamId));
    await d.done();
  }

  /* 12. a /loop that replaces one running says so */
  {
    const d = await boot();
    await d.keys('/loop 5m watch the A build\r', 300);
    await d.keys('/new\r', 900);
    const at = d.mark();
    await d.keys('/loop 5m watch the B deploy\r', 400);
    A.ok(/Loop stopped — the new \/loop replaces it \(it was set in an earlier conversation: "watch the A build"\)/.test(d.since(at).replace(/\s+/g, ' ')), 'loop: the loop it replaces is said to have stopped (it went with no line)');
    await d.keys('/loop off\r', 200);
    await d.done();
  }

  /* 13. /yolo: the app did not confirm in time; a /yolo off the app's save did not take */
  {
    let mode = 'unconfirmed';
    const d = await boot({ approval: (b, roster) => {
      if (mode === 'unconfirmed') {   // the page applied it (its roster push landed) but did not confirm within the 6 s
        roster.agents[0].approvalMode = 'full';
        return { status: 409, body: { error: 'the StarNet app did not confirm in time — it may still be applying the change', pageOpen: true, unanswered: true, station: { approvalMode: 'full' } } };
      }
      roster.agents[0].approvalMode = b.mode;
      return { status: 200, body: { ok: true, agentId: b.agentId, mode: b.mode, via: 'roster', save: 'not-saved', saveError: 'the station save is damaged' } };
    } });
    const at = d.mark();
    await d.keys('/yolo\r', 600);
    const said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/did not confirm in time/.test(said) && /The station's roster says ULTRON will run without prompts right now/.test(said), 'yolo: unconfirmed, it says what the station holds now: ' + (said.match(/The StarNet app.{0,200}/) || [''])[0]);
    A.ok(!/still will ask first/.test(said), 'yolo: never "still will ask first" while the roster says full');
    mode = 'roster';
    const at2 = d.mark();
    await d.keys('/yolo off\r', 600);
    const said2 = d.since(at2).replace(/\s+/g, ' ');
    A.ok(/the app's save did not take it \(the station save is damaged\), so the app may give ULTRON its own saved setting back when it opens/.test(said2), 'yolo off: a save that did not take it is said, never "it stays when the app opens": ' + (said2.match(/Approval mode.{0,300}/) || [''])[0]);
    await d.done();
  }

  /* 14. /theme: lists the themes, recolors the whole screen at once, keeps the pick (cli.json, its other keys kept), and
     the next starnet starts in it; an unknown name changes nothing */
  {
    const tui = require('../bin/lib/tui.js');
    const dir = require('fs').mkdtempSync(require('path').join(os.tmpdir(), 'starnet-theme-drive-'));
    const themeFile = require('path').join(dir, 'cli.json');
    require('fs').writeFileSync(themeFile, JSON.stringify({ keep: 'me' }));
    const color = { NO_COLOR: '', COLORTERM: 'truecolor' };
    const amberSgr = '38;2;255;170;51', redSgr = '38;2;255;46;62';
    const d = await boot({ env: color, themeFile });
    A.ok(d.raw().includes(redSgr) && !d.raw().includes(amberSgr), 'theme: starts in the neon red');
    let at = d.mark();
    await d.keys('/theme\r', 400);
    let said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/Theme: red/.test(said) && /▸ red/.test(said) && ['amber', 'green', 'blue', 'purple', 'white'].every(n => said.includes(n)), 'theme: /theme lists every theme, the current one marked: ' + said.slice(-300));
    at = d.mark();
    await d.keys('/theme amber\r', 600);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/Theme: amber, classic amber — kept for the next starnet/.test(said), 'theme: /theme amber says it took and is kept');
    A.ok(d.raw().slice(at).includes('\x1b[2J'), 'theme: the whole screen is redrawn');
    const typed = d.mark();   // (the paints while "/theme amber" was being typed were still red)
    await d.keys('x\x7f', 300);
    const repaint = d.raw().slice(typed);
    A.ok(repaint.includes(amberSgr) && !repaint.includes(redSgr), 'theme: what it paints next is amber, no red left');
    A.eq(JSON.parse(require('fs').readFileSync(themeFile, 'utf8')), { keep: 'me', theme: 'amber' }, 'theme: the pick is kept, cli.json\'s other keys too');
    at = d.mark();
    await d.keys('/theme neon\r', 400);
    A.ok(/No theme named neon/.test(d.since(at).replace(/\s+/g, ' ')) && JSON.parse(require('fs').readFileSync(themeFile, 'utf8')).theme === 'amber', 'theme: an unknown name changes nothing');
    await d.done();
    const d2 = await boot({ env: color, themeFile });
    A.ok(d2.raw().includes(amberSgr), 'theme: the next starnet starts in amber');
    await d2.keys('/theme red\r', 600);
    A.eq(tui.PALETTE.ph[0], '#ff3b4e', 'theme: /theme red puts the neon red back');
    await d2.done();
    require('fs').rmSync(dir, { recursive: true, force: true });
  }

  /* 15. /connect: the app's AI & MODELS list in its groups (names, what each needs, what the station proves); a key typed
     hidden — never on screen, never in ↑ history — is handed to the station once, and a refusal says why and keeps asking;
     a typed name goes straight to that provider; esc leaves with nothing connected */
  {
    const KEY = '9sk-ant-drive-secret-XYZ';   // starts with a digit: a key is text from its first character on
    let saves = [];
    const d = await boot({ providers: ['openrouter', 'codex'], claude: { installed: true, loggedIn: false },
      connect: b => { saves.push(b); return saves.length === 1 ? { status: 422, body: { ok: false, error: 'provider rejected this key (HTTP 401) — nothing was saved' } } : { status: 200, body: { ok: true, provider: b.provider, via: 'page', store: 'keychain', verified: true } }; } });
    let at = d.mark();
    await d.keys('/connect\r', 900);
    let said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/CONNECT · AI & MODELS/.test(said), 'connect: /connect opens the list');
    A.ok(['A SUBSCRIPTION YOU HAVE', 'AN API KEY', 'YOUR OWN MODELS'].every(g => said.includes(g)) && !said.includes('STARNET MANAGED'), 'connect: the app\'s groups; STARNET MANAGED only where a StarNet account can link');
    A.ok(['OPENROUTER', 'CHATGPT (CODEX)', 'GROK (XAI)', 'KIMI FOR CODING', 'CLAUDE CODE', 'ANTHROPIC', 'GEMINI', 'CEREBRAS', 'OLLAMA', 'CUSTOM'].every(n => said.includes(n)), 'connect: every provider the app lists, by the app\'s name');
    A.ok(/OPENROUTER\s+one key · 300\+ models\s+● KEY SAVED/.test(said) && /CHATGPT \(CODEX\)\s+ChatGPT subscription\s+● SIGNED IN/.test(said) && /ANTHROPIC\s+Claude native API\s+○ NO KEY/.test(said) && /CLAUDE CODE\s+your Claude subscription\s+○ NOT SIGNED IN/.test(said),
      'connect: each row says what it needs and what the station proves: ' + (said.match(/OPENROUTER.{0,80}/) || [''])[0]);
    at = d.mark();
    await d.keys('anthropic', 300);
    await d.keys('\r', 900);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/CONNECT/.test(said) && /ANTHROPIC/.test(said) && /paste your ANTHROPIC key — it stays hidden here/.test(said), 'connect: picking ANTHROPIC asks for its key: ' + said.slice(-240));
    at = d.mark();
    await d.keys(KEY, 300);
    A.ok(!d.raw().includes(KEY) && !d.raw().includes('sk-ant-drive') && d.since(at).includes('•'), 'connect: the key is never drawn — only dots');
    await d.keys('\r', 1200);
    said = d.since(at).replace(/\s+/g, ' ');
    A.eq(saves[0], { provider: 'anthropic', key: KEY }, 'connect: the key goes to the station once, whole (a leading digit is part of it)');
    A.ok(/not saved: provider rejected this key \(HTTP 401\)/.test(said) && /paste it again, or go back/.test(said), 'connect: a refusal says why and asks again');
    await d.keys(KEY, 200);
    await d.keys('\r', 1500);
    said = d.screen().replace(/\s+/g, ' ');
    A.eq(saves.length, 2, 'connect: the second try is saved');
    A.ok(/ANTHROPIC key saved in your OS keychain — ANTHROPIC accepted it\. \/model picks one of its models for ULTRON\./.test(said), 'connect: it says where the key went and that it was checked');
    A.ok(!d.raw().includes(KEY), 'connect: the key never reached the screen');
    await d.key(UP, 300);
    A.ok(!d.raw().includes(KEY), 'connect: ↑ history never brings the key back');
    await d.key(ESC, 700); await d.key(ESC, 700);   // (the first hides the "/" menu the recalled line opened; readline holds a lone esc 500 ms)
    // a name goes straight there; esc leaves it
    at = d.mark();
    await d.keys('/connect groq\r', 900);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/paste your GROQ key/.test(said), 'connect: /connect groq goes straight to GROQ: ' + said.slice(-400));
    await d.key(ESC, 900);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/nothing was connected/.test(said) && saves.length === 2, 'connect: esc leaves, nothing saved');
    at = d.mark();
    await d.keys('/connect warp\r', 600);
    A.ok(/No provider called warp/.test(d.since(at).replace(/\s+/g, ' ')), 'connect: an unknown name says so');
    await d.done();
  }

  /* 16. /floor on a terminal with no images: the lead and the worker its run sent (live from the feed: the worker's run
     names its lead run), what each is doing, and the LOG of the handoff and its return */
  {
    const d = await boot();
    d.st.emit('agent.run.start', { runId: 'L1', agentId: 'agent', streamId: 'desk-1', trigger: 'directive', prompt: 'ship the landing page' });
    d.st.emit('agent.run.start', { runId: 'W1', agentId: 'scout', streamId: 'w-1', parentRunId: 'L1', delegatedBy: 'agent', prompt: 'research pricing' });
    d.st.emit('agent.tool_call', { runId: 'W1', agentId: 'scout', name: 'web.fetch', callId: 'c1', argsSummary: '{"url":"vercel.com/pricing"}' });
    await sleep(400);
    let at = d.mark();
    await d.keys('/floor\r', 700);
    let said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/ULTRON lead ● /.test(said) && /└─▶ SCOUT ● web\.fetch/.test(said), 'floor: the lead and the worker it sent, each with what it is doing: ' + (said.match(/ULTRON lead.{0,120}/) || [''])[0]);
    A.ok(/ULTRON → SCOUT team\.dispatch "research pricing"/.test(said), 'floor: the handoff in the LOG');
    at = d.mark();
    d.st.emit('agent.run.end', { runId: 'W1', agentId: 'scout', reason: 'done', turns: 1, usd: 0 });
    await sleep(700);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/SCOUT → ULTRON done/.test(said), 'floor: its result comes back in the LOG');
    await d.done();
  }

  /* 17. /usage: each connected provider and what is left of it, as the station says (a Claude Code sign-in's window, a
     ChatGPT sign-in no run has used yet, a key with no call yet, the ledger's spend); /connect on a subscription already
     signed in offers ANOTHER account of it, signs it in through the station's /add route (polled with that account), and
     says so; going back from one leaves nothing behind (its empty account is removed) */
  {
    const added = [];
    let next = 0;
    const d = await boot({ providers: ['openrouter', 'codex'], claude: { installed: true, loggedIn: true }, routes: {
      '/api/usage/providers': () => ({ body: { subscriptions: { 'claude-cli': { primary: { windows: [{ id: 'five_hour', label: '5-hour', usedPct: 12, resetsAt: Date.now() + 3 * 3600e3, status: 'allowed' }], seenAt: Date.now() - 5 * 60000 } } }, rate: [] } }),
      '/api/budget/status': () => ({ body: { spentToday: 0.42, lifetime: 31.1 } }),
      '/api/auth/claude-cli/accounts': () => ({ body: { accounts: [{ account: '', label: 'account 1', primary: true, installed: true, loggedIn: true, coolingUntil: 0 }].concat(added.map((a, i) => ({ account: a, label: 'account ' + (i + 2), installed: true, loggedIn: true, coolingUntil: 0 }))), max: 8 } }),
      '/api/auth/codex/accounts': () => ({ body: { accounts: [{ account: '', label: 'account 1', primary: true, connected: true, coolingUntil: 0 }], max: 8 } }),
      '/api/auth/claude-cli/add': () => ({ body: { account: ['ab12cd34ef', 'cd56ef78ab'][next++], status: 'pending', login_id: 'L' + next, url: 'https://claude.ai/oauth/authorize?x=1' } }),
      '/api/auth/claude-cli/poll': b => { if (b.login_id === 'L1') { added.push(b.account); return { body: { status: 'connected' } }; } return { body: { status: 'pending' } }; },
      '/api/auth/claude-cli/cancel': () => ({ body: { ok: true } }),
      '/api/auth/claude-cli/remove': () => ({ body: { ok: true } })
    } });
    let at = d.mark();
    await d.keys('/usage\r', 1200);
    let said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/USAGE/.test(said) && /CLAUDE CODE · 1 sign-in/.test(said) && /account 1 5-hour 88% left · resets/.test(said) && /\(as of 5 min ago\)/.test(said), 'usage: a Claude Code sign-in, what is left of its window and when that was said: ' + (said.match(/CLAUDE CODE.{0,160}/) || [''])[0]);
    A.ok(/CHATGPT \(CODEX\) · 1 sign-in[│ ]+account 1 unknown — nothing reported yet/.test(said), 'usage: a ChatGPT sign-in nothing was reported for: unknown: ' + (said.match(/CHATGPT.{0,160}/) || [''])[0]);
    A.ok(/OPENROUTER · key saved — unknown until a call says/.test(said) && /Spent today \$0\.42 · all time \$31\.10/.test(said), 'usage: a key with no call yet is unknown; the ledger\'s spend last');
    A.ok(d.st.hits.some(h => h.path === '/api/auth/claude-cli/accounts') && d.st.hits.some(h => h.path === '/api/auth/codex/accounts'), 'usage: each subscription\'s own sign-ins are read');

    at = d.mark();
    await d.keys('/connect claude\r', 900);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/CLAUDE CODE is signed in\. another account of the same subscription stacks on it/.test(said) && /Add another account/.test(said) && /Keep it as is/.test(said), 'connect: a subscription already signed in offers another account: ' + said.slice(-300));
    await d.keys('1', 900);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/sign(?:ing)? in with the OTHER Claude account at https:\/\/claude\.ai\/oauth\/authorize/.test(said), 'connect: the new account\'s sign-in link, saying to use the OTHER account');
    await sleep(3800);
    said = d.since(at).replace(/\s+/g, ' ');
    const poll = d.st.hits.find(h => h.path === '/api/auth/claude-cli/poll');
    A.eq(poll && poll.body, { account: 'ab12cd34ef', login_id: 'L1' }, 'connect: it polls the NEW account\'s sign-in, by its account');
    A.ok(/another CLAUDE CODE account is connected — 2 sign-ins now; when one hits its limit the runs carry on with the next/.test(said), 'connect: it says the second sign-in landed: ' + said.slice(-260));

    at = d.mark();
    await d.keys('/connect claude\r', 900);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/CLAUDE CODE is signed in — 2 accounts/.test(said), 'connect: now it counts two');
    await d.keys('1', 900);
    await d.keys('2', 900);   // Go back
    const removed = d.st.hits.filter(h => h.path === '/api/auth/claude-cli/remove');
    A.ok(removed.length === 1 && removed[0].body.account === 'cd56ef78ab' && d.st.hits.some(h => h.path === '/api/auth/claude-cli/cancel'), 'connect: going back cancels that sign-in and removes its empty account — nothing left behind');
    await d.done();
  }

  /* 18. /split: more agents on the screen at once — a pane each; what you type goes to the pane marked (the one just added,
     then tab moves through the panes); /split close closes the one you are in, /split off goes back to one; a name that
     is no agent says so */
  {
    const d = await boot({ agents: [{ agentId: 'scout', name: 'SCOUT', model: 'test/m', provider: 'openrouter' }, { agentId: 'forge', name: 'FORGE', model: 'test/m', provider: 'openrouter' }] });
    let at = d.mark();
    await d.keys('/split scout forge\r', 700);
    let said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/COMMS ▸ ULTRON · SCOUT · FORGE/.test(said), 'split: COMMS shows ULTRON, SCOUT and FORGE at once');
    await d.keys('hello forge\r', 600);
    A.eq(d.userRuns().map(r => r.body.agentId), ['forge'], 'split: what you type goes to the pane just added');
    await d.key('\t', 300);
    await d.keys('hello ultron\r', 600);
    A.eq(d.userRuns().map(r => r.body.agentId), ['forge', 'agent'], 'split: tab moves to the next pane, and the message goes there');
    at = d.mark();
    await d.keys('/split close\r', 600);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/COMMS ▸ SCOUT · FORGE/.test(said), 'split: /split close closes the pane you were in: ' + (said.match(/COMMS ▸[^│╮]{0,40}/) || [''])[0]);
    at = d.mark();
    await d.keys('/split off\r', 600);
    said = d.since(at).replace(/\s+/g, ' ');
    A.ok(/COMMS ▸ (SCOUT|FORGE)\b(?! ·)/.test(said) && !/COMMS ▸ SCOUT · FORGE/.test(said), 'split: /split off — one agent again');
    at = d.mark();
    await d.keys('/split warp\r', 600);
    A.ok(/No agent called warp — your crew: ULTRON, SCOUT, FORGE/.test(d.since(at).replace(/\s+/g, ' ')), 'split: a name that is no agent says so, and names the crew');
    await d.done();
  }

global.setTimeout = realSetTimeout; global.setInterval = realSetInterval;
  A.report('cli-dashboard-drive.test');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
