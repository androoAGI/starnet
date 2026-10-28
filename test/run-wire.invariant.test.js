/* node test/run-wire.invariant.test.js — ONE {provider, model} pair per agent, on EVERY entry point (run-wire-resolver lane).

   The family: the station decided which provider and which model a run goes out on separately at each entry point, so
   one agent ran one tuple in COMMS and another from Run Now, a routine tick, a Telegram DM, a team.dispatch worker, /v1,
   ACP or `starnet run`, and the Live Doctor probed a third. Each past fix patched one copy (bugs 0e3d3914, 8b22d414,
   7ed4a93c, a496d1c7, c978e7b7; gh#12, #24, #98). This test is the family's invariant: for one fake station it runs
   each entry point's REAL decision code (sliced from sidecar/index.js, or the real module: cron driver, channel hub,
   orchestration, openai-compat, the CLI core, the page's focusWire), hands what it would pass to runOnce through
   runOnceCore's own resolution, and checks the pair that would reach the provider against ONE oracle written out
   below — never against the resolver itself. Every surface that keeps a readout must also name the pair's source.

   It must FAIL on the pre-fix commit (959c7c5b4) for every entry point — see the per-entry summary it prints. Nothing
   here boots a sidecar; the recording-upstream version of the same parity is test/run-wire.parity.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { sidecarFunctionSource, sidecarTopLevelFunction, readSidecarSource } = require('./helpers/source.js');

const ROOT = path.join(__dirname, '..');
const SRC = readSidecarSource();
const RUN_WIRE = path.join(ROOT, 'sidecar', 'run-wire.js');
const RunWire = fs.existsSync(RUN_WIRE) ? require(RUN_WIRE) : null;   // absent on the pre-fix commit

// ---------------------------------------------------------------- the station ------------------------------------------
// A: a ChatGPT-signed-in station whose Overseer runs codex / gpt-5.5, with an OpenRouter key too. `scout` is unpinned
//    with a STALE stamped provider (an older page stamped every unpinned row); `pin` holds a bare model (no provider);
//    `smith` is pinned to a whole OpenRouter pair.
// B: a headless ChatGPT-only station: no OpenRouter key, no model anywhere, STARNET_DEFAULT_MODEL unset.
const KNOWN = ['openrouter', 'codex', 'anthropic', 'starnet', 'ollama', 'custom', 'gemini'];
const SCENARIOS = {
  A: {
    roster: {
      agent: { name: 'NOVA', system: 'NOVA-SYS', model: 'gpt-5.5', provider: 'codex', reasoningEffort: 'high' },
      scout: { name: 'SCOUT', system: 'SCOUT-SYS', model: null, provider: 'openrouter' },
      pin: { name: 'PIN', system: 'PIN-SYS', model: 'bare/model', provider: '' },
      smith: { name: 'SMITH', system: 'SMITH-SYS', model: 'anthropic/claude-x', provider: 'openrouter' }
    },
    env: { DEFAULT_MODEL: 'env/model', orKey: 'sk-or-test' }, codex: true,
    // THE ORACLE: the pair each agent must run on every surface, and where it comes from
    want: {
      agent: ['codex', 'gpt-5.5', 'agent'], scout: ['codex', 'gpt-5.5', 'station'],
      pin: ['codex', 'bare/model', 'agent'], smith: ['openrouter', 'anthropic/claude-x', 'agent']
    }
  },
  B: {
    roster: { agent: { name: 'NOVA', system: 'NOVA-SYS', model: '', provider: 'codex' } },
    env: {}, codex: true,
    want: { agent: ['codex', 'gpt-codex-default', 'env'] }
  }
};

function makeHost(sc) {
  const agentRoster = new Map(Object.entries(JSON.parse(JSON.stringify(sc.roster))));
  const codexTokens = sc.codex ? { access_token: 'codex-token' } : null;
  const normalizeProviderId = p => { const v = String(p || '').trim().toLowerCase().replace(/^openai-codex$/, 'codex'); return KNOWN.indexOf(v) >= 0 ? v : ''; };
  const deps = {
    agentRoster, agentRosterRaw: new Map(), RunWire, codexTokens, runtimeKey: sc.env.orKey || '',
    normalizeProviderId, normalizeProvider: p => normalizeProviderId(p) || 'openrouter',
    registryProviderUsesCodex: p => p === 'codex', providerUsesCodex: p => normalizeProviderId(p) === 'codex', providerUsesDeviceOAuth: () => false,
    providerRuntimeKey: (id, explicit) => String(explicit || '') || ((normalizeProviderId(id) || 'openrouter') === 'openrouter' ? (sc.env.orKey || '') : ''),
    providerRuntimeBaseUrl: () => '',
    providerHasCredential: (id, key) => (normalizeProviderId(id) === 'codex' ? !!codexTokens : !!key),
    providerCredentialError: id => 'connect ' + id,
    resolveReasoningEffort: (p, v) => v || 'medium', chatModelId: (p, m) => m,
    ENV: n => sc.env[n], CRON_DEFAULT_MODEL: String(sc.env.DEFAULT_MODEL || ''), CODEX_DEFAULT_MODEL: 'gpt-codex-default',
    warnRosterMiss: () => {}, withDossier: s => s, dossierWithGoals: () => '', CRON_ROUTINE_NOTE: '',
    computeVersionSurface: () => ({ harness: 'test' }), getProviderProfile: () => ({})
  };
  // every resolution helper either version declares; '' for one this version does not have
  const names = ['runWireEnv', 'runWireFor', 'runWireOfRun', 'routineWireOf', 'cronWireFor', 'stationDefaultFor', 'cronIdentityFor',
    'cronModelFor', 'cronProviderFor', 'channelRunConfigFor', 'stationHubRunConfig', 'rosterWireRows', 'handleRuntimeAgent'];
  const body = names.map(n => sidecarFunctionSource(n)).join('\n') + '\nreturn {' + names.map(n => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(', ') + '};';
  const fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
  return Object.assign({ deps, agentRoster }, fns);
}

/* runOnceCore's OWN resolution of a run's options, sliced from runOnceCore: the pair that reaches the provider, and the
   source the run row records (null when the version records none). */
const CORE = sidecarTopLevelFunction('runOnceCore');
const coreFrom = CORE.indexOf("  const rosterIdent = agentRoster.get(String(agentId || '')) || null;");
const coreTo = CORE.indexOf('\n  model = chatModelId(providerId, model);', coreFrom);
A.ok(coreFrom > 0 && coreTo > coreFrom && coreTo - coreFrom < 6000, "fixture: runOnceCore's pair resolution is sliced (" + coreFrom + '..' + coreTo + ')');
const CORE_REGION = CORE.slice(coreFrom, coreTo) + '\n  model = chatModelId(providerId, model);';
function reach(host, opts) {
  const o = opts || {};
  const d = Object.assign({}, host.deps, { runWireOfRun: host.runWireOfRun, runWireFor: host.runWireFor, runWireEnv: host.runWireEnv });
  const fn = new Function(...Object.keys(d), 'agentId', 'o', 'key', CORE_REGION + "\nreturn { provider: providerId, model, source: (typeof runWire === 'undefined' || !runWire) ? null : runWire.source };");
  return fn(...Object.values(d), String(o.agentId || 'agent'), o, o.key);
}

// ---------------------------------------------------------------- the ledger -------------------------------------------
const ledger = new Map();   // entry -> [{ ok, why }]
// a state the oracle reaches only after an edit: scout after a chat /model wrote 'new/model' (a bare model: the station's provider)
const AFTER = { scout_after: ['codex', 'new/model', 'agent'] };
function expect(entry, sc, agentId, got, opts) {
  const want = SCENARIOS[sc].want[agentId] || AFTER[agentId];
  const pairOk = !!got && got.provider === want[0] && got.model === want[1];
  const sourceOk = !(opts && opts.source) || (got && got.source === want[2]);
  const why = entry + ' [' + sc + '] ' + agentId + ': got ' + (got ? (got.provider + ' / ' + got.model + (opts && opts.source ? ' (' + got.source + ')' : '')) : 'NO RUN')
    + ', want ' + want[0] + ' / ' + want[1] + (opts && opts.source ? ' (' + want[2] + ')' : '');
  if (!ledger.has(entry)) ledger.set(entry, []);
  ledger.get(entry).push({ ok: pairOk && sourceOk, why });
}
const wired = (re) => re.test(SRC);   // does sidecar/index.js wire this seam? (the emulation follows the real composition)

(async () => {
  // ================================================ 1. COMMS ===========================================================
  // The page decides the pair (app.js focusWire: the station default for an unpinned agent), POSTs it to /api/run, and
  // runOnceCore runs it. The run row must say WHERE the pair came from (station default vs the agent's own pin).
  {
    const appjs = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'app.js'), 'utf8');
    const lift = name => { const s = appjs.indexOf('  function ' + name + '('); return s < 0 ? '' : appjs.slice(s, appjs.indexOf('\n  }\n', s) + 4); };
    const page = new Function('agents', lift('stationDefaultWire') + lift('focusWire') + '\nreturn { focusWire };');
    const host = makeHost(SCENARIOS.A);
    const agents = new Map([...host.agentRoster].map(([id, a]) => [id, Object.assign({ id }, a)]));
    const { focusWire } = page(agents);
    for (const id of Object.keys(SCENARIOS.A.want)) {
      const w = focusWire(agents.get(id));
      expect('COMMS', 'A', id, reach(host, { agentId: id, provider: host.deps.normalizeProvider(w.provider), model: w.model }), { source: true });
    }
  }

  // ================================================ 2. Run Now ==========================================================
  // handleCronRun's own resolution lines, then the run it starts.
  {
    const runNow = sidecarTopLevelFunction('handleCronRun');
    const from = runNow.indexOf('assembledPrompt = scan.cleaned;\n  }\n') + 'assembledPrompt = scan.cleaned;\n  }\n'.length;
    const to = runNow.indexOf('  const key = cronKeyFor(provider);', from);
    A.ok(from > 100 && to > from && to - from < 800, 'fixture: Run Now resolution lines sliced');
    const region = runNow.slice(from, to);
    const runNowPair = (host, job) => new Function('job', 'cronWireFor', 'cronModelFor', 'cronProviderFor', region + '\nreturn { model, provider };')(job, host.cronWireFor, host.cronModelFor, host.cronProviderFor);
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const p = runNowPair(host, { id: 'j-' + id, agentId: id });
        expect('Run Now', sc, id, p.model ? reach(host, { agentId: id, model: p.model, provider: p.provider }) : null);
      }
    }
    // a routine an older form saved with the station's provider stamped on and no model (bug a496d1c7) follows its agent
    const host = makeHost(SCENARIOS.A);
    const legacy = runNowPair(host, { id: 'j-legacy', agentId: 'scout', provider: 'openrouter', model: null });
    expect('Run Now', 'A', 'scout', reach(host, { agentId: 'scout', model: legacy.model, provider: legacy.provider }));
  }

  // ================================================ 3. the scheduled tick ===============================================
  // The REAL cron driver, composed the way sidecar/index.js composes it.
  {
    const cron = require('../sidecar/cron.js');
    const cronStore = require('../sidecar/cron-store.js');
    const { makeCronDriver } = require('../sidecar/cron-driver.js');
    const injectsWire = wired(/wireForJob: \(job\) => cronWireFor\(job\)/);
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const T0 = 1700000000000;
        let store = [cronStore.makeJob({ id: 'j1', prompt: 'do it', agentId: id, schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 })];
        const runs = [];
        const driver = makeCronDriver({
          getJobs: () => store, setJobs: (j) => { store = j; return true; },
          runOnce: (o) => new Promise(() => { runs.push(o); }),
          emit: () => {}, newId: () => 'run-1', newAbort: () => new AbortController(), now: () => T0 + 60000, warn: () => {},
          getKey: (provider) => host.deps.providerRuntimeKey(provider, ''),
          providerForJob: (job) => host.cronProviderFor(job),
          wireForJob: injectsWire && host.cronWireFor ? (job) => host.cronWireFor(job) : undefined,
          hasCredential: (provider, key) => host.deps.providerHasCredential(provider, key),
          identityForAgent: (agentId) => host.cronIdentityFor(agentId),
          defaultModel: host.deps.CRON_DEFAULT_MODEL, persona: 'P', maxRunMs: 480000
        });
        driver.applyTick(T0 + 60000);
        expect('scheduled tick', sc, id, runs[0] ? reach(host, runs[0]) : null, { source: true });
      }
    }
  }

  // ================================================ 4. a Telegram owner DM ==============================================
  // The station's own Telegram hub as startTelegram builds it: the page handed the GLOBAL wire (here the focused agent's
  // OpenRouter pin) at connect. The DM must run the routed agent's live pair — and a /model change must reach it.
  {
    const { makeChannelHub } = require('../sidecar/channels/hub.js');
    const tg = sidecarTopLevelFunction('startTelegram');
    const liveEntry = /resolveEntryRunConfig: \(agentId\) => stationHubRunConfig\(agentId, \(channelSecrets && channelSecrets\.telegram\) \|\| \{\}\)/.test(tg);
    const dmOnce = async (host, snap, text) => {
      const runs = [];
      const store = { loadHistory: () => [], appendTurn: () => [], getChatRecord: () => null };
      const hub = makeChannelHub({
        channel: 'telegram', store, send: () => Promise.resolve({ ok: true, messageId: 'm1' }), classify: () => false, newId: (() => { let i = 0; return () => 'r' + (++i); })(),
        ownerTrusted: () => true, isOwner: () => true,
        runOnce: async (o) => { runs.push(o); o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); },
        // secrets(): exactly the snapshot index.js returns from channelSecrets.telegram
        secrets: () => {
          const provider = host.deps.normalizeProvider(snap.provider), key = host.deps.providerRuntimeKey(provider, snap.key || '');
          return { key, model: snap.model, provider, baseUrl: '', configured: host.deps.providerHasCredential(provider, key), reasoningEffort: 'medium', agentId: snap.agentId, system: snap.system };
        },
        resolveEntryRunConfig: liveEntry && host.stationHubRunConfig ? (agentId) => host.stationHubRunConfig(agentId, snap) : undefined
      });
      await hub.onInbound({ channel: 'telegram', chatId: '777', chatType: 'dm', userId: 'owner', text, messageId: String(Date.now()), ts: 1 });
      return runs[0] || null;
    };
    const host = makeHost(SCENARIOS.A);
    for (const id of ['scout', 'smith', 'pin', 'agent']) {
      const snap = { provider: 'openrouter', key: 'sk-or-test', model: 'focused/pin-model', agentId: id, system: 'SNAP-SYS' };
      const run = await dmOnce(host, snap, 'hello');
      expect('Telegram owner DM', 'A', id, run ? reach(host, run) : null);
    }
    // /model writes the roster (setAgentModelFromChannel: the model only) — the next DM runs it, on the station's provider
    {
      const h2 = makeHost(SCENARIOS.A);
      h2.agentRoster.set('scout', Object.assign({}, h2.agentRoster.get('scout'), { model: 'new/model', provider: '' }));
      const run = await dmOnce(h2, { provider: 'openrouter', key: 'sk-or-test', model: 'focused/pin-model', agentId: 'scout', system: 'SNAP-SYS' }, 'again');
      expect('Telegram owner DM', 'A', 'scout_after', run ? reach(h2, run) : null);
    }
  }

  // ================================================ 5. a team.dispatch worker ===========================================
  // The lead is `smith` (pinned to OpenRouter); its workers must run their OWN pairs, never the lead's model.
  {
    const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
    const injects = wired(/resolveWire: \(aid\) => runWireFor\(aid\)/);
    const host = makeHost(SCENARIOS.A);
    const runs = [];
    const { dispatchTool } = makeOrchestrationTools({
      runOnce: async (o) => { runs.push(o); if (o.emit) { o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'done' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); } return { reason: 'done' }; },
      roster: () => host.agentRoster, key: 'sk-or-test', model: 'anthropic/claude-x', provider: 'openrouter', baseUrl: '', newId: (() => { let i = 0; return () => 'w' + (++i); })(),
      providerAuth: (pid) => { const id = host.deps.normalizeProviderId(pid); const k = host.deps.providerRuntimeKey(id, ''); return host.deps.providerHasCredential(id, k) ? { provider: id, key: k, baseUrl: '' } : null; },
      resolveWire: injects && host.runWireFor ? (aid) => host.runWireFor(aid) : undefined
    });
    await dispatchTool.run({ workers: [{ agentId: 'scout', prompt: 'find X' }, { agentId: 'pin', prompt: 'find Y' }, { agentId: 'agent', prompt: 'find Z' }] },
      { agentId: 'smith', signal: { aborted: false }, emit: () => {} });
    for (const id of ['scout', 'pin', 'agent']) {
      const run = runs.find(r => r.agentId === id);
      expect('team.dispatch worker', 'A', id, run ? reach(host, run) : null, { source: true });
    }
  }

  // ================================================ 6. /v1 ===============================================================
  // The real openai-compat surface over loopback, wired as index.js wires it.
  {
    const { makeOpenAiCompat } = require('../sidecar/openai-compat.js');
    const KEY = 'run-wire-invariant-key-123456';
    const resolves = wired(/resolveWire: \(agentId\) => \{\s*const v1Model = String\(ENV\('V1_MODEL'\)/);
    const wiredRows = wired(/makeOpenAiCompat\(\{[\s\S]{0,2500}roster: \(\) => rosterWireRows\(false\)/);
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      const runs = [];
      const api = makeOpenAiCompat({
        now: () => 1000, newId: (() => { let i = 0; return () => 'id' + (++i); })(), apiKey: () => KEY,
        readBody: async req => { let s = ''; for await (const c of req) s += c; return s; },
        runOnce: async (o) => { runs.push(o); o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); },
        resolveProviderKey: (p) => host.deps.providerRuntimeKey(p, ''), resolveBaseUrl: () => '',
        roster: () => (wiredRows && host.rosterWireRows) ? host.rosterWireRows(false) : [...host.agentRoster].map(([agentId, a]) => ({ agentId, name: a.name, model: a.model, provider: a.provider })),
        defaultModel: () => String(host.deps.ENV('V1_MODEL') || host.deps.ENV('DEFAULT_MODEL') || '').trim(),
        resolveWire: resolves && host.runWireFor ? (agentId) => host.runWireFor(agentId) : undefined
      });
      const server = http.createServer((req, res) => api.handle(req, res));
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const post = (model) => new Promise((resolve) => {
        const body = JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'hi' }] });
        const req = http.request('http://127.0.0.1:' + server.address().port + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          res => { res.resume(); res.on('end', resolve); });
        req.on('error', resolve); req.end(body);
      });
      try {
        await post('starnet-agent');   // the generic model: the station default (the Overseer's pair)
        expect('/v1', sc, 'agent', runs[0] ? reach(host, runs[0]) : null);
        if (sc === 'A') {
          await post('scout');         // a roster agent selected by id: that agent's own pair
          expect('/v1', sc, 'scout', runs[1] ? reach(host, runs[1]) : null);
        }
      } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    }
  }

  // ================================================ 7. ACP ===============================================================
  // GET /api/runtime/agent, then the bridge's /api/run body (acp/serve.js: rt.model + rt.provider as agent 'agent').
  {
    const serve = fs.readFileSync(path.join(ROOT, 'sidecar', 'acp', 'serve.js'), 'utf8');
    A.ok(/model: rt\.model,\s*provider: rt\.provider \|\| 'openrouter',\s*agentId: 'agent'/.test(serve), 'fixture: the ACP bridge runs what /api/runtime/agent reports, as the Overseer');
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      let raw = ''; host.handleRuntimeAgent({}, { writeHead() {}, end(s) { raw = s; } });
      const rt = JSON.parse(raw);
      const run = rt.configured ? reach(host, { agentId: 'agent', model: rt.model, provider: rt.provider || 'openrouter' }) : null;
      // the readout names its source too
      expect('ACP', sc, 'agent', run && Object.assign({}, run, { source: rt.wireSource }), { source: true });
    }
  }

  // ================================================ 8. `starnet run` ====================================================
  {
    const core = require('../bin/lib/cli-core.js');
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      let raw = ''; host.handleRuntimeAgent({}, { writeHead() {}, end(s) { raw = s; } });
      const rt = JSON.parse(raw);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const sel = core.pickAgent(rt, { agent: id });
        const run = sel.ok ? reach(host, core.buildRunBody(sel, 'hi', {})) : null;
        expect('starnet run', sc, id, run);
      }
    }
  }

  // ================================================ 9. the Live Doctor ==================================================
  // handleLiveDoctor's own selection lines: the pair it probes must be the pair the agent's runs use, and it names the source.
  {
    const ld = sidecarTopLevelFunction('handleLiveDoctor');
    const from = ld.indexOf('  const targets = [];');
    const to = ld.indexOf("  targets.push({ kind: 'provider'", from);
    A.ok(from > 0 && to > from && to - from < 1500, 'fixture: the Live Doctor selection lines are sliced');
    const region = ld.slice(from, to);
    const namesSource = /out\.report\.wire = \{[^}]*source: doctorWire\.source/.test(ld) && /label: providerId \+ \(model \? ' \/ ' \+ model : ''\) \+ ' · ' \+ \(RunWire\.SOURCE_LABELS\[doctorWire\.source\]/.test(ld);
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const d = Object.assign({}, host.deps, { runWireFor: host.runWireFor });
        const got = new Function(...Object.keys(d), 'agentId', 'rec', region + "\nreturn { provider: providerId, model, source: (typeof doctorWire === 'undefined') ? null : doctorWire.source };")(...Object.values(d), id, host.agentRoster.get(id));
        expect('Live Doctor', sc, id, got.model ? Object.assign(got, { source: namesSource ? got.source : null }) : null, { source: true });
      }
    }
  }

  // ================================================ the verdict, per entry point ========================================
  const lines = [];
  for (const [entry, rows] of ledger) {
    const bad = rows.filter(r => !r.ok);
    lines.push((bad.length ? 'FAIL ' : 'ok   ') + entry + (bad.length ? ' — ' + bad.map(r => r.why).join(' | ') : ''));
    A.ok(bad.length === 0, entry + ' runs every agent on its one pair and names it: ' + (bad.map(r => r.why).join(' | ') || 'ok'));
  }
  console.log('[run-wire invariant] per entry point:\n  ' + lines.join('\n  '));
  A.eq([...ledger.keys()], ['COMMS', 'Run Now', 'scheduled tick', 'Telegram owner DM', 'team.dispatch worker', '/v1', 'ACP', 'starnet run', 'Live Doctor'],
    'every entry point the lane names was exercised');
  A.report('run-wire.invariant: one pair per agent on every entry point');
})().catch(e => { A.ok(false, 'run-wire.invariant threw: ' + ((e && e.stack) || e)); A.report('run-wire.invariant'); });
