/* node test/domain-task.metamorphic.test.js — A WORKER'S BUDGET IS ITS LEAD'S CALL, NEVER ITS BRIEF'S WORDING
   (domain-task-advisory; starnet-releases#5, gh#58, the 10-14 delegated-web-tools report).

   The dispatcher used to read each worker's brief with DomainTask.classify and, when the wording looked like a one-host
   "pure read", cut that worker to 3 turns / 3 tool calls / a 45 s slice that nobody asked for: delegated security, QA
   and automation briefs that named one site came back as broken workers (rel#5), and a resumed worker re-derived the
   same cut from its stored prompt. Only the lead knows a job is a one-page read, so only the lead says so: bounded:true.

   INV-1 (metamorphic, dispatcher face). For every report brief, and every brief the domain-terminal corpus reads as
   one exact host, team.dispatch (foreground and background), team.spawn and team.resume after a registry reload hand
   the run host the SAME maxIters, maxToolCalls and wall-clock slices as the neutral control brief, and the classifier
   carries no budget at all. Built through makeOrchestrationTools (the factory index.js wires) with a recording runOnce
   at the transport edge and a real subagent manager on a temp file. A slice is a setTimeout the dispatcher arms (no
   injected clock), read the way test/orchestration.test.js reads it.

   INV-2. A bound exists only when the lead passes bounded:true, and every reader is told so: 3 turns / 3 tool calls
   (+ the 45 s slice on dispatch); the row, the tool summary the COMMS chip shows, a timed-out row and the background
   start handle read 'bounded read (requested by lead)'; the subagent record keeps it across a reload and team.resume
   re-applies it; the explicit bound is the only producer of the maxToolCalls the run host enforces, and that host's
   tool-budget refusal names it.

   INV-4 (dispatcher face; test/domain-task.metamorphic.e2e.test.js holds the run face). The lead's onlyHost is parsed
   once (DomainTask.scopeOf: a bare host or a URL, normalized; blank is no scope; any other value that is not a dotted
   host name is refused) and never silently dropped: the worker run, its structured-result repair run, the row, the
   background start handle and the durable record carry the normalized host, team.resume re-applies it after a
   reload, and team.spawn does the same for a clone. An onlyHost that is not a host never starts that worker.

   INV-5. The classifier has one consumer, and it is advice. The sidecar classifies prose in exactly one place,
   runOnceCore's admission line; orchestration.js classifies nothing. runOnceCore hands the lead's hostScope — never the
   prose's directDomainTask — to the withholding predicate, the projection's directDomain fact, tool.search's
   explanation, parallelSafe, the dispatch refusals and afterCall's scope argument; the prose reaches only afterCall's
   advice argument and the prompt block. For every brief, no refusal exists without a scope, a missing exact host
   under advice never stops a run's tools (it does under a scope), and the advice never tells the lead to scope or
   bound its worker. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSidecarSource, sidecarSourceFiles, sidecarTopLevelFunction } = require('./helpers/source');
const DomainTask = require('../sidecar/domain-task.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');

const LABEL = 'bounded read (requested by lead)';
const CONTROL = 'Summarize what we know about the release plan.';
/* rel#5 published no verbatim briefs: its security / qa / automation rows are rebuilt from the report's observations
   1-4, and the engineering row is the one the 10-15 lane pinned as the reporter's. gh#58: the reconstructed routine
   spec and the residual domain-terminal.test.js pins. The 10-14 report: its "check/review itch.io ... site" lead. */
const REPORT = [
  ['rel#5 engineering', 'Review the deployment script for starnet-demo.io, write a unit test for it, and run it.'],
  ['rel#5 security', 'Review the security headers and TLS setup on starnet-demo.io and list the risks.'],
  ['rel#5 qa', 'Check starnet-demo.io and read the release checklist in its docs.'],
  ['rel#5 automation', 'Inspect the CI status page on ci.starnet-demo.io and summarize what failed.'],
  ['rel#5 markdown', 'Review deploy-notes.md and confirm the release steps.'],
  ['gh#58 api', 'POST to https://api.x.com/v1/items with ${MY_KEY}, then check the response'],
  ['gh#58 residual', 'check my orders on printify.com and summarize them'],
  ['gh#58 routine', 'Check status.example.com every morning and read the latest incident.'],
  ['10-14 itch', 'Review the itch.io site for our game page and check the latest reviews.']
];
// Every brief test/domain-terminal.test.js reads as ONE exact host: the class a prose bound could ever have touched.
const CORPUS = [
  // its opening rows
  'Go ahead, check out starnessos.com and then read the docs.', 'Open https://example.com/docs', 'Open docs.rs and read the crate docs.',
  'Visit example.sh and inspect the site.', 'Check starnessos.invalid and read its docs.',
  // real sites, not file names
  'check example.com', 'open starnetos.com', 'review github.io pages', 'check itch.io site', 'read the docs at docs.python.org',
  'visit www.notes.md', 'check https://main.py/', 'check docs.rs/tokio', 'Check the perplexity.ai website', 'open claude.ai',
  'check notion.so', 'Visit point.md', 'Check example.com and save the summary into notes.md', 'check about.me',
  // the #5 table: briefs that also ask for work, and briefs that only read
  'Review the deployment script for starnet-demo.io, write a unit test that covers it, then run the test and report the result.',
  'Inspect the nginx config for example.com and fix the redirect.', 'Check example.com and build a landing page like it.',
  'Review the auth flow for example.com and implement the missing token refresh.', 'Can you check example.com and fix the broken header?',
  '- review the starnet-demo.io deploy config\n- run the smoke tests', "Read example.com's pricing page and write a summary into notes.md",
  'Read the API docs at docs.example.com and write a short summary into C:\\Users\\me\\proj\\notes.md',
  'Read the API docs at docs.example.com and write a short summary into C:/Users/me/proj/notes.md',
  'Read the API docs at docs.example.com and write a short summary into C:\\Users\\me\\My Project\\notes.md',
  'Read the API docs at docs.example.com and write a short summary into "C:\\Users\\me\\My Project\\notes.md"',
  "Read the API docs at docs.example.com and write a short summary into 'C:\\Users\\me\\My Project\\notes.md'",
  'Read the API docs at docs.example.com and write a short summary into `C:\\Users\\me\\My Project\\notes.md`',
  'Read the API docs at docs.example.com and write a short summary into "C:\\Users\\me\\My Project\\notes"',
  'Read the API docs at docs.example.com and write a short summary into C:\\Users\\me\\proj\\NOTES',
  'Read the API docs at docs.example.com and write a short summary to D:\\work\\summary.txt',
  'Read the API docs at docs.example.com and write a short summary into \\\\server\\share\\notes.md',
  'Read the API docs at docs.example.com and write a short summary into ~/proj/notes.md',
  'Read the API docs at docs.example.com and write a short summary into /home/me/proj/notes.md',
  'Read the API docs at docs.example.com and write a short summary into docs/notes.md',
  'Read the API docs at docs.example.com and write a short summary into the notes folder',
  'Read the docs at docs.example.com/v1/api and write a short summary', 'Read https://docs.example.com/guide/intro and write a short summary',
  'Read the API docs at docs.example.com and write a short summary to the Commander',
  'Read the API docs at docs.example.com and write a short summary in plain English',
  "Read example.com's pricing page", 'read the pricing page on example.com', 'check claude.ai and write a summary',
  "Read example.com's pricing page and write a short summary of the plans.", 'check the latest build on ci.example.com',
  'check if example.com is up and running', 'Read the docs at bun.sh on how to install it',
  // the review of the soak lane (10-15)
  'check example.com for broken links', 'have a look at example.com', 'Can you have a quick look at example.com',
  'open bun.sh and read the docs', 'Read the docs at docs.rs', 'check the itch.sh website', 'go to point.md and read it',
  'Read the pricing on cursor.sh', 'check amazon.in prices', 'Is example.sh up? check it', 'check claude.ai for errors',
  'check the new features in claude.ai', 'check my settings in notion.so', 'check publico.pt', 'visit falabella.cl',
  // page reads that are not API calls or interactive visits
  'Read the latest post on example.com', 'Read the Stripe API docs at stripe.com', 'check the order status on printify.com',
  'Read the press release on example.com', 'What type of site is example.com? Check it.', 'check my shop on etsy.com'
];
const BRIEFS = REPORT.concat(CORPUS.filter(t => !REPORT.some(([, b]) => b === t)).map(t => ['corpus ' + JSON.stringify(t), t]));

const counter = () => { let n = 0; return () => 'child_' + (++n); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const LEAD = { agentId: 'lead', runId: 'lead-run', emit: () => {} };
const ROSTER = new Map([['eng', { system: 'E' }]]);

/* The run host at the transport edge: it records what each child run was handed. hang:true keeps a run going until its
   signal aborts (a background worker interrupted mid-job); otherwise it answers at once. */
function recordingRunOnce(hang) {
  const calls = [];
  const fn = async (o) => {
    calls.push(o);
    if (hang) await new Promise(res => { if (o.signal && o.signal.addEventListener) o.signal.addEventListener('abort', res, { once: true }); });
    return { reason: hang ? 'cancelled' : 'done', messages: [{ role: 'assistant', content: 'out' }], usd: 0 };
  };
  fn.calls = calls;
  return fn;
}
// every setTimeout the dispatcher arms while fn runs: a worker's wall-clock slice is one of them
async function armedDuring(fn) {
  const real = global.setTimeout, armed = [];
  global.setTimeout = function (cb, ms) { armed.push(ms); return real.apply(this, arguments); };
  try { return { out: await fn(), armed }; } finally { global.setTimeout = real; }
}
const budgetOf = (call, armed) => call
  ? { maxIters: call.maxIters, maxToolCalls: call.maxToolCalls === undefined ? null : call.maxToolCalls, slices: armed.slice().sort((a, b) => a - b) }
  : { run: 'never started' };
async function inTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-dta-meta-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const manager = (file, at) => makeSubagentManager({ fs, pathMod: path, file, clock: { now: () => at }, emit: () => {}, newId: counter() });

// team.dispatch, foreground: one worker, its share of the dispatch wall clock
async function dispatchOnce(worker) {
  const ro = recordingRunOnce();
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => ROSTER, key: 'k', model: 'm', newId: counter(), workerMaxIters: 16 });
  const { out, armed } = await armedDuring(() => dispatchTool.run({ workers: [Object.assign({ agentId: 'eng' }, worker)] }, LEAD));
  return { budget: budgetOf(ro.calls[0], armed), out, calls: ro.calls };
}
// team.spawn: one clone of the lead, foreground or background
async function spawnOnce(file, task, background) {
  const ro = recordingRunOnce();
  const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), workerMaxIters: 9, subagents: manager(file, 1000) });
  const { out, armed } = await armedDuring(async () => { const r = await spawnTool.run({ tasks: [task], background: background === true }, LEAD); await tick(); await tick(); return r; });
  return { budget: budgetOf(ro.calls[0], armed), out, calls: ro.calls };
}
/* team.dispatch background:true; the worker is interrupted mid-job, the station restarts (the registry is read back
   from its file), and team.resume restarts that worker from its durable record */
async function backgroundThenResume(worker, file) {
  if (!file) return inTempDir(dir => backgroundThenResume(worker, path.join(dir, 'subagents.json')));
  const subagents = manager(file, 1000);
  const ro = recordingRunOnce(true);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => ROSTER, key: 'k', model: 'm', newId: counter(), workerMaxIters: 16, subagents });
  const started = await armedDuring(async () => {
    const r = await dispatchTool.run({ workers: [Object.assign({ agentId: 'eng' }, worker)], background: true }, LEAD);
    await tick(); await tick(); return r;
  });
  const handle = JSON.parse(started.out.content)[0] || {};
  subagents.interrupt(handle.id, 'lead');
  await tick(); await tick();
  const reloaded = manager(file, 1001);
  const stored = reloaded.get(handle.id) || {};
  const listed = reloaded.list({ leadId: 'lead' })[0] || {};
  const ro2 = recordingRunOnce();
  const { resumeTool } = makeOrchestrationTools({ runOnce: ro2, roster: () => ROSTER, key: 'k', model: 'm', newId: counter(), workerMaxIters: 7, subagents: reloaded });
  const resumed = await armedDuring(async () => { const r = await resumeTool.run({ id: handle.id }, LEAD); await tick(); await tick(); return r; });
  return { background: budgetOf(ro.calls[0], started.armed), startOut: started.out, handle, stored, listed, resume: budgetOf(ro2.calls[0], resumed.armed), resumeOut: resumed.out,
    bgCall: ro.calls[0], resumeCall: ro2.calls[0] };
}

(async () => {
  // ---- INV-1: the brief's wording never moves a worker's budget, on any surface that starts one ----
  const surfaces = brief => inTempDir(async dir => {   // each brief its own small registry files
    const bg = await backgroundThenResume({ prompt: brief }, path.join(dir, 'subagents.json'));
    return {
      dispatch: (await dispatchOnce({ prompt: brief })).budget,
      'dispatch background': bg.background,
      spawn: (await spawnOnce(path.join(dir, 'spawn.json'), { prompt: brief })).budget,
      resume: bg.resume
    };
  });
  const control = await surfaces(CONTROL);
  A.eq(control, {
    dispatch: { maxIters: 16, maxToolCalls: null, slices: [600000] }, 'dispatch background': { maxIters: 16, maxToolCalls: null, slices: [] },
    spawn: { maxIters: 9, maxToolCalls: null, slices: [] }, resume: { maxIters: 7, maxToolCalls: null, slices: [] }
  }, 'INV-1: the control brief runs on the ordinary worker budgets (the knobs, the dispatch wall clock share, nothing else)');
  const violations = [];
  for (const [id, brief] of BRIEFS) {
    const got = await surfaces(brief);
    for (const s of Object.keys(control)) {
      if (JSON.stringify(got[s]) !== JSON.stringify(control[s])) violations.push(s + ' / ' + id + ' -> ' + JSON.stringify(got[s]));
    }
  }
  if (violations.length) console.log('PROSE-BUDGETED (' + violations.length + '):\n  ' + violations.join('\n  '));
  A.eq(violations.length, 0, 'INV-1: no brief\'s wording moves a worker\'s turns, tool calls or wall clock off the control\'s ('
    + BRIEFS.length + ' briefs x dispatch, background dispatch, spawn, resume after a reload)');
  A.eq(CORPUS.filter(t => !DomainTask.classify(t)), [], 'INV-1: every corpus row is still one exact host to the classifier (the corpus is the class it claims)');
  const budgeted = BRIEFS.concat([['control', CONTROL]]).filter(([, b]) => {
    const p = DomainTask.classify(b);
    return p && JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(['host', 'kind']);
  }).map(([id]) => id);
  A.eq(budgeted, [], 'INV-1: the classifier returns {kind, host} and nothing else: no pureRead, no workerMax* budget for any brief');

  // ---- INV-2: bounded:true is the one way to bound a worker, and every reader is told ----
  {
    const fg = await dispatchOnce({ prompt: CONTROL, bounded: true });
    A.eq(fg.budget, { maxIters: 3, maxToolCalls: 3, slices: [45000] }, 'INV-2 dispatch: bounded:true caps the worker at 3 turns, 3 tool calls and a 45 s slice');
    const row = JSON.parse(fg.out.content)[0] || {};
    A.eq(row.bound, LABEL, 'INV-2 dispatch: the result row says the worker was a bounded read and who asked for it');
    A.ok(String(fg.out.summary).indexOf(LABEL) >= 0, 'INV-2 dispatch: the tool summary the COMMS chip shows names the bound: ' + JSON.stringify(fg.out.summary));
    const loose = await dispatchOnce({ prompt: CONTROL, bounded: 'true' });
    A.eq(loose.budget, { maxIters: 16, maxToolCalls: null, slices: [600000] }, 'INV-2: only the boolean true bounds a worker (a truthy string is not the lead asking)');
    const looseRow = JSON.parse(loose.out.content)[0] || {};
    A.ok(!('bound' in looseRow) && String(loose.out.summary).indexOf(LABEL) < 0, 'INV-2: an unbounded worker\'s row and summary carry no bound label');
  }
  {
    const r = await backgroundThenResume({ prompt: CONTROL, bounded: true });
    A.eq(r.background, { maxIters: 3, maxToolCalls: 3, slices: [45000] }, 'INV-2 background dispatch: the same 3 turns / 3 tool calls / 45 s as a foreground bounded worker');
    A.eq(r.handle.bound, LABEL, 'INV-2: the background start handle the lead reads says the worker is a bounded read');
    A.ok(String(r.startOut.summary).indexOf(LABEL) >= 0, 'INV-2: the background start summary names the bound: ' + JSON.stringify(r.startOut.summary));
    A.eq(r.stored.bounded, true, 'INV-2: the durable subagent record keeps bounded across a reload');
    A.eq(r.listed.bounded, true, 'INV-2: team.subagents (the record\'s view) shows the worker is bounded');
    A.eq(r.resume, { maxIters: 3, maxToolCalls: 3, slices: [] }, 'INV-2 resume: team.resume re-applies the lead\'s bound from the record (turns and tool calls, as resume always bounded)');
    A.ok(String(r.resumeOut.summary).indexOf(LABEL) >= 0, 'INV-2 resume: the resume summary names the bound it re-applied: ' + JSON.stringify(r.resumeOut.summary));
  }
  await inTempDir(async dir => {
    const fg = await spawnOnce(path.join(dir, 'fg.json'), { prompt: CONTROL, bounded: true });
    A.eq(fg.budget, { maxIters: 3, maxToolCalls: 3, slices: [] }, 'INV-2 spawn: bounded:true caps the clone at 3 turns and 3 tool calls');
    A.eq((JSON.parse(fg.out.content)[0] || {}).bound, LABEL, 'INV-2 spawn: the clone\'s result row names the bound');
    A.ok(String(fg.out.summary).indexOf(LABEL) >= 0, 'INV-2 spawn: the spawn summary names the bound: ' + JSON.stringify(fg.out.summary));
    const bg = await spawnOnce(path.join(dir, 'bg.json'), { prompt: CONTROL, bounded: true }, true);
    A.eq(bg.budget, { maxIters: 3, maxToolCalls: 3, slices: [] }, 'INV-2 background spawn: the same cap');
    A.eq((JSON.parse(bg.out.content)[0] || {}).bound, LABEL, 'INV-2 background spawn: the start handle names the bound');
    A.ok(String(bg.out.summary).indexOf(LABEL) >= 0, 'INV-2 background spawn: the summary names the bound: ' + JSON.stringify(bg.out.summary));
  });
  {
    // a bounded worker's 45 s slice runs out (the clock is the dispatcher's own setTimeout, fired at once here): its row
    // names the bound that stopped it, so the lead knows the way out is a dispatch without bounded
    const real = global.setTimeout;
    global.setTimeout = function (cb, ms) { const a = Array.prototype.slice.call(arguments); if (ms === 45000) a[1] = 1; return real.apply(this, a); };
    try {
      const runOnce = async (o) => {
        await new Promise(res => {
          const t = real(res, 300);
          if (o.signal && o.signal.addEventListener) o.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
        });
        return { reason: 'done', messages: [{ role: 'assistant', content: 'partial notes' }], usd: 0 };
      };
      const { dispatchTool } = makeOrchestrationTools({ runOnce, roster: () => ROSTER, key: 'k', model: 'm', newId: counter(), workerMaxIters: 16 });
      const out = await dispatchTool.run({ workers: [{ agentId: 'eng', prompt: CONTROL, bounded: true }] }, LEAD);
      const row = JSON.parse(out.content)[0] || {};
      A.eq(row.reason, 'timeout', 'INV-2: a bounded worker that outlives its 45 s slice is a timeout row');
      A.ok(String(row.result).indexOf(LABEL) >= 0, 'INV-2: the timed-out row names the bound that stopped it: ' + JSON.stringify(row.result));
      A.eq(row.bound, LABEL, 'INV-2: the timed-out row carries the bound like any other row');
    } finally { global.setTimeout = real; }
  }
  {
    // source half: the run host enforces o.maxToolCalls (index.js toolBudgetStopFor); its only producer is the lead's bound
    const all = readSidecarSource();
    const producers = (all.match(/\bmaxToolCalls\s*:[^,\n}]*/g) || []).map(s => s.trim());
    A.ok(producers.length > 0 && producers.every(p => /^maxToolCalls:\s*bound \? bound\.maxTools : undefined$/.test(p)),
      'INV-2: every maxToolCalls the sidecar hands a run is the lead\'s explicit bound: ' + JSON.stringify(producers));
    const orch = (sidecarSourceFiles().find(f => f.rel === 'sidecar/tools/builtin/orchestration.js') || { text: '' }).text;
    const mints = orch.match(/\bconst bound = [^;\n]*/g) || [];
    A.ok(mints.length > 0 && mints.every(m => /^const bound = boundOf\((?:job|task|rec)\)$/.test(m)),
      'INV-2: orchestration.js mints a bound only from the lead\'s bounded flag (boundOf): ' + JSON.stringify(mints));
    const refusal = (sidecarTopLevelFunction('runOnceCore').match(/summary: 'tool-budget', content: [^\n]*/) || [''])[0];
    A.ok(refusal.indexOf(LABEL) >= 0, 'INV-2: the run host\'s tool-budget refusal names the bound and who asked for it: ' + JSON.stringify(refusal));
  }

  // ---- INV-4 (dispatcher face): the lead's onlyHost is parsed once, rides every run of that worker and never drops ----
  {
    const scopeOf = typeof DomainTask.scopeOf === 'function' ? DomainTask.scopeOf : () => null;
    const hostOf = v => { const s = scopeOf(v); return s ? s.host : null; };
    // [onlyHost, its host]: an '@' or '*' in a URL's path, query or fragment is part of a page, not of its host (review round 1)
    const HOSTS = [
      ['example.com', 'example.com'], [' Example.COM ', 'example.com'], ['https://www.example.com/docs?x=1', 'example.com'],
      ['http://docs.example.com:8080/a', 'docs.example.com'], ['shop.example.co.uk.', 'shop.example.co.uk'],
      ['https://www.youtube.com/@channel/about', 'youtube.com'], ['https://medium.com/@someone/a-post', 'medium.com'],
      ['https://mastodon.social/@user', 'mastodon.social'], ['https://example.com/search?q=*', 'example.com'],
      ['https://example.com/a?who=me@example.com', 'example.com'], ['youtube.com/@channel', 'youtube.com'], ['https://example.com/#@top', 'example.com']
    ];
    A.eq(HOSTS.map(([v]) => hostOf(v)), HOSTS.map(([, h]) => h), 'INV-4: onlyHost takes a bare host or a URL and keeps its normalized host name');
    A.eq((scopeOf('example.com') || {}).source, 'lead', 'INV-4: a parsed scope is marked as the lead\'s (its prompt block names the lead)');
    const NOT_HOSTS = ['', '   ', 'localhost', 'docs.localhost', 'example', '127.0.0.1', '[::1]', '0x7f.1', '*.example.com', 'not a host',
      'user@example.com', 'mailto:x@y.com', 'https://example.com\\@evil.example', 'a..b.com', '-x.example.com', 'http://', 42, true, null, undefined, {},
      'https://user:pw@example.com/', 'https://example.com@evil.example/', 'https://*.example.com/a', 'https://exa mple.com/', 'example .com/a'];
    A.eq(NOT_HOSTS.filter(v => scopeOf(v) !== null).map(v => JSON.stringify(v)), [],
      'INV-4: blank, local, IP-literal, wildcard, spaced, credentialed and non-string values are no host');
  }
  {
    // team.dispatch: the normalized host reaches the worker run, its structured-result repair run and its row
    const fg = await dispatchOnce({ prompt: CONTROL, onlyHost: 'https://www.Example.com/docs', bounded: true, resultSchema: { type: 'object' } });
    A.eq(fg.calls.map(o => [o.outputOnly === true ? 'repair' : 'worker', o.onlyHost, o.maxToolCalls === undefined ? null : o.maxToolCalls]),
      [['worker', 'example.com', 3], ['repair', 'example.com', 3]], 'INV-4 dispatch: the worker run and its repair run both carry the lead\'s scope (and its bound)');
    const row = JSON.parse(fg.out.content)[0] || {};
    A.eq([row.onlyHost, row.bound], ['example.com', LABEL], 'INV-4 dispatch: the row names the host its lead confined it to');
    const blank = await dispatchOnce({ prompt: CONTROL, onlyHost: '   ' });
    A.ok(blank.calls.length === 1 && blank.calls[0].onlyHost === undefined && !('onlyHost' in (JSON.parse(blank.out.content)[0] || {})),
      'INV-4 dispatch: a blank onlyHost is no scope, so the worker runs unscoped and its row names no host');
    const bad = await dispatchOnce({ prompt: CONTROL, onlyHost: 'localhost' });
    const badRow = JSON.parse(bad.out.content)[0] || {};
    A.ok(bad.calls.length === 0 && badRow.reason === 'error' && /^onlyHost must be a host name such as example\.com, not "localhost": fix it, or send this worker without onlyHost$/.test(String(badRow.result)),
      'INV-4 dispatch: an onlyHost that is not a host never starts the worker, and its row says why and the way out: ' + JSON.stringify(badRow));
  }
  {
    // team.dispatch background:true, then a restart: the start handle and the durable record keep the scope, and
    // team.resume re-applies it from the record
    const r = await backgroundThenResume({ prompt: CONTROL, onlyHost: 'Docs.Example.com' });
    A.eq(r.bgCall && r.bgCall.onlyHost, 'docs.example.com', 'INV-4 background dispatch: the worker run carries the lead\'s scope');
    A.eq(r.handle.onlyHost, 'docs.example.com', 'INV-4 background dispatch: the start handle the lead reads names the scope');
    A.eq([r.stored.onlyHost, r.listed.onlyHost], ['docs.example.com', 'docs.example.com'], 'INV-4: the durable record keeps the scope across a reload, and team.subagents shows it');
    A.eq(r.resumeCall && r.resumeCall.onlyHost, 'docs.example.com', 'INV-4 resume: team.resume re-applies the lead\'s scope from the record');
  }
  await inTempDir(async dir => {
    const fg = await spawnOnce(path.join(dir, 'fg-scope.json'), { prompt: CONTROL, onlyHost: 'example.com' });
    A.eq([fg.calls.length, fg.calls[0] && fg.calls[0].onlyHost, (JSON.parse(fg.out.content)[0] || {}).onlyHost], [1, 'example.com', 'example.com'],
      'INV-4 spawn: the clone runs under the lead\'s scope and its row names it');
    const bg = await spawnOnce(path.join(dir, 'bg-scope.json'), { prompt: CONTROL, onlyHost: 'example.com' }, true);
    A.eq((JSON.parse(bg.out.content)[0] || {}).onlyHost, 'example.com', 'INV-4 background spawn: the start handle names the scope');
    const bad = await spawnOnce(path.join(dir, 'bad-scope.json'), { prompt: CONTROL, onlyHost: '*.example.com' });
    const badRow = JSON.parse(bad.out.content)[0] || {};
    A.ok(bad.calls.length === 0 && badRow.reason === 'not-spawned' && /^onlyHost must be a host name such as example\.com/.test(String(badRow.result)),
      'INV-4 spawn: an onlyHost that is not a host never starts the clone, and its row says why: ' + JSON.stringify(badRow));
  });

  // ---- INV-5: the classifier has one consumer, and it is advice ----
  {
    const all = readSidecarSource();
    const core = sidecarTopLevelFunction('runOnceCore');
    const orch = (sidecarSourceFiles().find(f => f.rel === 'sidecar/tools/builtin/orchestration.js') || { text: '' }).text;
    A.eq((all.match(/\b(?:DomainTask|domainTask)\.classify\(/g) || []).length, 1, 'INV-5: the sidecar classifies prose in exactly one place');
    A.ok(/\n {2}const directDomainTask = isTask && !o\.toolsOptional \? DomainTask\.classify\(latestUserText\(messages\)/.test(core), 'INV-5: that place is runOnceCore\'s admission line');
    A.ok(!!orch && !/\.classify\(/.test(orch), 'INV-5: orchestration.js classifies nothing');
    // every code line of runOnceCore that reads the prose classification, against the only three it may be
    const proseReads = core.split('\n').map(l => l.replace(/\s+\/\/.*$/, '').trim()).filter(l => /\bdirectDomainTask\b/.test(l) && !/^(?:\/\/|\/\*|\*)/.test(l));
    const ADVICE_ONLY = [
      /^const directDomainTask = isTask && !o\.toolsOptional \? DomainTask\.classify\(/,                    // admission
      /^r = DomainTask\.afterCall\(c, r, hostScope, directDomainTask\);$/,                                    // advice argument
      /^const directDomainBlock = \(hostScope \|\| directDomainTask\) \? '\\n\\n' \+ DomainTask\.prompt\(hostScope \|\| directDomainTask\) : '';$/   // prompt block
    ];
    const strays = proseReads.filter(l => !ADVICE_ONLY.some(re => re.test(l)));
    A.ok(proseReads.length === ADVICE_ONLY.length && strays.length === 0,
      'INV-5: runOnceCore reads the prose classification only at admission, as afterCall\'s advice and in the prompt block: ' + JSON.stringify(strays.length ? strays : proseReads));
    for (const [what, re] of [
      ['the withholding predicate', /const directDomainWithheld = \(name\) => ProjectTools\.directDomainWithheld\(!!hostScope, name\);/],
      ['the projection\'s directDomain fact', /\bdirectDomain: !!hostScope\b/],
      ['tool.search\'s explanation', /policyWithheld: DomainTask\.withheldNote\(hostScope, /],
      ['parallelSafe', /if \(hostScope && real === 'web_fetch'\) return false;/],
      ['the dispatch refusals', /DomainTask\.refusalOf\(c, hostScope, directDomainWithheld\)/],
      ['afterCall\'s scope argument', /DomainTask\.afterCall\(c, r, hostScope, /],
      ['the scope itself: the lead\'s onlyHost, parsed', /const hostScope = DomainTask\.scopeOf\(o\.onlyHost\);/]
    ]) A.ok(re.test(core), 'INV-5: runOnceCore hands the lead\'s hostScope to ' + what);
    // the pure half, on every brief: prose alone refuses nothing and stops nothing; a scope does both
    const pure = ['scopeOf', 'refusalOf', 'afterCall'].every(f => typeof DomainTask[f] === 'function');
    A.ok(pure, 'INV-5: DomainTask exports scopeOf, refusalOf and afterCall');
    if (pure) {
      const elsewhere = [{ name: 'team.dispatch', args: {} }, { name: 'web_search', args: { query: 'x' } }, { name: 'web_fetch', args: { url: 'https://elsewhere.example/' } },
        { name: 'web_request', args: { url: 'https://api.elsewhere.example/' } }, { name: 'browser.navigate', args: { url: 'https://www.google.com/' } },
        { name: 'browser.login', args: { url: 'https://elsewhere.example/login' } }];
      const bad = [];
      let advised = 0;
      for (const [id, brief] of BRIEFS) {
        const advice = DomainTask.classify(brief);
        for (const c of elsewhere) if (DomainTask.refusalOf(c, null, () => true) !== null) bad.push(id + ': ' + c.name + ' refused with no scope');
        if (!advice) continue;
        advised++;
        for (const c of [{ name: 'web_fetch', args: { url: 'https://' + advice.host + '/docs' } }, { name: 'browser.navigate', args: { url: 'https://' + advice.host + '/' } }]) {
          const missing = { ok: false, isError: true, content: 'tool ' + c.name + ' failed: getaddrinfo ENOTFOUND ' + advice.host };
          const r = DomainTask.afterCall(c, missing, null, advice) || {};
          if (r.control) bad.push(id + ': prose stopped ' + c.name);
          if (String(r.content).indexOf('<terminal_domain_advice>') < 0) bad.push(id + ': ' + c.name + ' got no advice');
          const scoped = DomainTask.afterCall(c, missing, DomainTask.scopeOf(advice.host), advice) || {};
          if (!(scoped.control && scoped.control.stopTools === true)) bad.push(id + ': the lead\'s scope did not stop ' + c.name);
        }
      }
      A.ok(advised > 70, 'INV-5: the pure half covers the one-host briefs (' + advised + ' advised)');
      A.eq(bad, [], 'INV-5: for every brief, no call is refused without a scope, and a missing exact host stops tools only under the lead\'s scope');
    }
    // the advice is about the host, never a hand-off instruction: a lead that followed "dispatch it with onlyHost <host>"
    // on a report brief scoped its own worker off web_search and every other host (review round 1, rel#5 again)
    const steered = BRIEFS.filter(([, b]) => { const a = DomainTask.classify(b); return !!a && /\bonlyHost\b|\bbounded\s*:\s*true\b/.test(DomainTask.prompt(a)); }).map(([id]) => id);
    A.eq(steered.length, 0, 'INV-5: the one-host advice never tells a lead to scope or bound its worker: onlyHost and bounded are the lead\'s own call ('
      + (steered.length ? 'it does on ' + steered.slice(0, 4).join(', ') + (steered.length > 4 ? ' and ' + (steered.length - 4) + ' more' : '') : 'none') + ')');
  }
  A.report('domain-task.metamorphic.test');
})().catch(e => { console.error(e); process.exit(1); });
