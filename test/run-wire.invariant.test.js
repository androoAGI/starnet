/* node test/run-wire.invariant.test.js — ONE {provider, model} pair AND one reasoning effort per agent, on EVERY entry point
   (run-wire-resolver lane).

   The family: the station decided which provider and which model a run goes out on separately at each entry point, so
   one agent ran one tuple in COMMS and another from Run Now, a routine tick, a Telegram DM, a team.dispatch worker, /v1,
   ACP, `starnet run`, the terminal dashboard or RUN A SAMPLE, and the Live Doctor probed a third. Each past fix patched one
   copy (bugs 0e3d3914, a496d1c7, c978e7b7; gh#24). This test is the family's invariant: for one fake station it runs each
   entry point's REAL decision code (sliced from sidecar/index.js, or the real module: cron driver, channel hub,
   orchestration, openai-compat, the CLI core, the terminal's station model, the page's focusWire), composed with the
   wiring index.js really passes them (the cron driver's, the Telegram hub's, the orchestration tools' and /v1's injected
   seams are lifted out of index.js's own calls and executed), hands what it would pass to runOnce through runOnceCore's
   own resolution, and checks the pair AND the effort that would reach the provider against ONE oracle written out below —
   never against the resolver itself. Every surface that keeps a readout must also name the pair's source; the channel
   connect gates are checked against the pair their messages run.

   It must FAIL on the commit before the lane for every entry point — see the per-entry summary it prints. Nothing here
   boots a sidecar; the recording-upstream version of the same parity is test/run-wire.parity.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { sidecarFunctionSource, sidecarTopLevelFunction, readSidecarSource, liftProp, callRegion } = require('./helpers/source.js');

const ROOT = path.join(__dirname, '..');
const SRC = readSidecarSource();
const RUN_WIRE = path.join(ROOT, 'sidecar', 'run-wire.js');
const RunWire = fs.existsSync(RUN_WIRE) ? require(RUN_WIRE) : null;   // absent before the lane

// ---------------------------------------------------------------- the station ------------------------------------------
// A: a ChatGPT-signed-in station whose Overseer runs codex / gpt-5.5 at effort high, with an OpenRouter key too. `scout`
//    is unpinned with a STALE stamped provider (an older page stamped every unpinned row); `crew` is unpinned with its own
//    class effort (low); `pin` holds a bare model (no provider); `smith` is pinned to a whole OpenRouter pair.
// B: a headless ChatGPT-only station: no OpenRouter key, no model anywhere, STARNET_DEFAULT_MODEL unset.
// C: a headless ChatGPT-only station that never received a roster, with STARNET_DEFAULT_MODEL set (an OpenRouter id it
//    cannot run: the environment rule is ChatGPT's own default model).
// THE ORACLE: [provider, model, source, effort] per agent — 'default' is the provider's default effort (nothing names one).
const KNOWN = ['openrouter', 'codex', 'anthropic', 'starnet', 'ollama', 'custom', 'gemini'];
const SCENARIOS = {
  A: {
    roster: {
      agent: { name: 'NOVA', system: 'NOVA-SYS', model: 'gpt-5.5', provider: 'codex', reasoningEffort: 'high' },
      scout: { name: 'SCOUT', system: 'SCOUT-SYS', model: null, provider: 'openrouter' },
      crew: { name: 'CREW', system: 'CREW-SYS', model: null, provider: '', reasoningEffort: 'low' },
      pin: { name: 'PIN', system: 'PIN-SYS', model: 'bare/model', provider: '' },
      smith: { name: 'SMITH', system: 'SMITH-SYS', model: 'anthropic/claude-x', provider: 'openrouter' }
    },
    env: { DEFAULT_MODEL: 'env/model', orKey: 'sk-or-test' }, codex: true,
    want: {
      agent: ['codex', 'gpt-5.5', 'agent', 'high'], scout: ['codex', 'gpt-5.5', 'station', 'high'],
      crew: ['codex', 'gpt-5.5', 'station', 'low'], pin: ['codex', 'bare/model', 'agent', 'default'],
      smith: ['openrouter', 'anthropic/claude-x', 'agent', 'default']
    }
  },
  B: {
    roster: { agent: { name: 'NOVA', system: 'NOVA-SYS', model: '', provider: 'codex' } },
    env: {}, codex: true,
    want: { agent: ['codex', 'gpt-codex-default', 'env', 'default'] }
  },
  C: {
    roster: {},
    env: { DEFAULT_MODEL: 'env/model' }, codex: true,
    want: { agent: ['codex', 'gpt-codex-default', 'env', 'default'] }
  }
};
// station A with STARNET_V1_MODEL set: /v1's generic target runs it (on openrouter); a selected roster agent keeps its pair
SCENARIOS.AV1 = Object.assign({}, SCENARIOS.A, { env: Object.assign({}, SCENARIOS.A.env, { V1_MODEL: 'v1/model' }) });
// /v1's GENERIC target runs as an ephemeral agent that is not on the roster: it follows the station default (or the env)
const V1_GENERIC = {
  A: ['codex', 'gpt-5.5', 'station', 'high'], B: ['codex', 'gpt-codex-default', 'env', 'default'],
  AV1: ['openrouter', 'v1/model', 'env', 'default']
};

function makeHost(sc) {
  const agentRoster = new Map(Object.entries(JSON.parse(JSON.stringify(sc.roster))));
  const codexTokens = sc.codex ? { access_token: 'codex-token' } : null;
  const normalizeProviderId = p => { const v = String(p || '').trim().toLowerCase().replace(/^openai-codex$/, 'codex'); return KNOWN.indexOf(v) >= 0 ? v : ''; };
  const deps = {
    agentRoster, agentRosterRaw: new Map(), RunWire, codexTokens, runtimeKey: sc.env.orKey || '',
    billing: require('../sidecar/billing-class.js').makeBilling({ profileOf: require('../sidecar/providers/registry.js').getProviderProfile, creditsConfigured: () => false }),
    normalizeProviderId, normalizeProvider: p => normalizeProviderId(p) || 'openrouter',
    registryProviderUsesCodex: p => p === 'codex', providerUsesCodex: p => normalizeProviderId(p) === 'codex', providerUsesDeviceOAuth: () => false,
    providerRuntimeKey: (id, explicit) => String(explicit || '') || ((normalizeProviderId(id) || 'openrouter') === 'openrouter' ? (sc.env.orKey || '') : ''),
    providerRuntimeBaseUrl: () => '',
    providerHasCredential: (id, key) => (normalizeProviderId(id) === 'codex' ? !!codexTokens : !!key),
    providerHasStoredCredential: (id, key) => (normalizeProviderId(id) === 'codex' ? !!codexTokens : !!key),
    // This matrix supplies credential presence; the real runtime handler now projects the common row.
    providerReadiness: (id, pair) => ({ unattendedReady: normalizeProviderId(id) === 'codex' ? !!codexTokens : !!pair.key }),
    providerCredentialError: id => 'connect ' + id,
    resolveReasoningEffort: (p, v) => v || 'default', chatModelId: (p, m) => m,
    ENV: n => sc.env[n], CRON_DEFAULT_MODEL: String(sc.env.DEFAULT_MODEL || ''), CODEX_DEFAULT_MODEL: 'gpt-codex-default',
    warnRosterMiss: () => {}, withDossier: s => s, dossierWithGoals: () => '', personaWithNote: s => s, CRON_ROUTINE_NOTE: '',
    computeVersionSurface: () => ({ harness: 'test' }), getProviderProfile: () => ({}), desktopEndpointsHeld: () => ({})
  };
  // every resolution helper any version declares; null for one this version does not have
  const names = ['runWireEnv', 'runWireFor', 'runWireOfRun', 'routineWireOf', 'cronWireFor', 'stationDefaultFor', 'cronIdentityFor',
    'cronModelFor', 'cronProviderFor', 'channelRunConfigFor', 'stationHubRunConfig', 'rosterWireRows', 'handleRuntimeAgent',
    'v1WireFor', 'devHubSecrets', 'sampleRunConfigFor', 'stationHubConnectError', 'channelFollowsReady'];
  const body = names.map(n => sidecarFunctionSource(n)).join('\n') + '\nreturn {' + names.map(n => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(', ') + '};';
  const fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
  return Object.assign({ deps, agentRoster }, fns);
}
const runtimeOf = host => { let raw = ''; host.handleRuntimeAgent({}, { writeHead() {}, end(s) { raw = s; } }); return JSON.parse(raw); };

/* THE WIRING index.js really passes a module: liftProp (test/helpers/source.js) lifts one property's expression out of a
   call's options object, and wiredSeam evaluates it over the host. A seam index.js does not inject lifts as undefined. */
function wiredSeam(region, name, scope) {
  const expr = liftProp(region, name);
  if (!expr) return undefined;
  return new Function(...Object.keys(scope), 'return (' + expr + ');')(...Object.values(scope));
}
const seamScope = (host, extra) => Object.assign({}, host.deps, {
  runWireFor: host.runWireFor, runWireEnv: host.runWireEnv, cronWireFor: host.cronWireFor, cronProviderFor: host.cronProviderFor,
  v1WireFor: host.v1WireFor, rosterWireRows: host.rosterWireRows, stationHubRunConfig: host.stationHubRunConfig
}, extra || {});

/* runOnceCore's OWN resolution of a run's options, sliced from runOnceCore: the pair and the effort that reach the
   provider, and the source the RUN ROW records (runStore.record's wireSource) — null when the version records none. */
const CORE = sidecarTopLevelFunction('runOnceCore');
const coreFrom = CORE.indexOf("  const rosterIdent = agentRoster.get(String(agentId || '')) || null;");
const coreTo = CORE.indexOf('\n  model = chatModelId(providerId, model);', coreFrom);
A.ok(coreFrom > 0 && coreTo > coreFrom && coreTo - coreFrom < 6000, "fixture: runOnceCore's pair resolution is sliced (" + coreFrom + '..' + coreTo + ')');
const CORE_REGION = CORE.slice(coreFrom, coreTo) + '\n  model = chatModelId(providerId, model);';
const RECORDS_SOURCE = /runStore\.record\(\{ runId, [^\n]*\bwireSource: runWire\.source\b/.test(CORE);
function reach(host, opts) {
  const o = opts || {};
  const d = Object.assign({}, host.deps, { runWireOfRun: host.runWireOfRun, runWireFor: host.runWireFor, runWireEnv: host.runWireEnv });
  const fn = new Function(...Object.keys(d), 'agentId', 'o', 'key', CORE_REGION + '\nreturn { provider: providerId, model, effort: reasoningEffort, source: ' + (RECORDS_SOURCE ? 'runWire.source' : 'null') + ' };');
  return fn(...Object.values(d), String(o.agentId || 'agent'), o, o.key);
}

// ---------------------------------------------------------------- the ledger -------------------------------------------
const ledger = new Map();   // entry -> [{ ok, why }]
// a state the oracle reaches only after an edit: scout after a chat /model wrote 'new/model' (a bare model: the station's provider)
const AFTER = { scout_after: ['codex', 'new/model', 'agent', 'default'] };
function expect(entry, sc, agentId, got, opts) {
  const o = Object.assign({ effort: true }, opts || {});
  const want = o.want || SCENARIOS[sc].want[agentId] || AFTER[agentId];
  const pairOk = !!got && got.provider === want[0] && got.model === want[1];
  const sourceOk = !o.source || (got && got.source === want[2]);
  const effortOk = !o.effort || (got && got.effort === want[3]);
  const why = entry + ' [' + sc + '] ' + agentId + ': got ' + (got ? (got.provider + ' / ' + got.model + (o.source ? ' (' + got.source + ')' : '') + (o.effort ? ' @' + got.effort : '')) : 'NO RUN')
    + ', want ' + want[0] + ' / ' + want[1] + (o.source ? ' (' + want[2] + ')' : '') + (o.effort ? ' @' + want[3] : '');
  if (!ledger.has(entry)) ledger.set(entry, []);
  ledger.get(entry).push({ ok: pairOk && sourceOk && effortOk, why });
}

(async () => {
  // ================================================ 1. COMMS ===========================================================
  // The page decides the pair and the effort on FOCUS (app.js focusWire -> applyWire, into the harness's per-provider
  // stores), and a run POSTs what the harness then holds (harness.js runAgent: getModel, getProv, getReasoningEffort) to
  // /api/run, where runOnceCore runs it. A per-provider effort slot outlives the focus that wrote it, so the ORDER of focus
  // matters: each order below runs through the real applyWire. The run row must say WHERE the pair came from (station
  // default vs the agent's own pin): runStore.record's wireSource.
  {
    const appjs = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'app.js'), 'utf8');
    const lift = name => { const s = appjs.indexOf('  function ' + name + '('); return s < 0 ? '' : appjs.slice(s, appjs.indexOf('\n  }\n', s) + 4); };
    A.ok(!!lift('applyWire'), "fixture: the page's applyWire is lifted");
    const page = new Function('agents', 'Harness', "let wirePinOwner = '';\n" + lift('stationDefaultWire') + lift('focusWire') + lift('applyWire') + '\nreturn { focusWire, applyWire };');
    // the harness's stores, shaped like harness.js (readScoped / writeScoped per provider): an empty slot reads as the
    // provider default, which is what the run then sends
    const makeHarness = () => {
      const slots = {}; let prov = 'openrouter', model = '';
      return {
        setProv: p => { prov = p; }, getProv: () => prov, setModel: m => { model = m; }, getModel: () => model,
        setReasoningEffort: (e, p) => { slots[p || prov] = e; }, clearReasoningEffort: p => { slots[p || prov] = ''; },
        getReasoningEffort: p => slots[p || prov] || 'default'
      };
    };
    const comms = (host, order, wants) => {
      const agents = new Map([...host.agentRoster].map(([id, a]) => [id, Object.assign({ id }, a)]));
      const Harness = makeHarness();
      const { focusWire, applyWire } = page(agents, Harness);
      for (const id of order) {
        applyWire(focusWire(agents.get(id)));
        const run = reach(host, { agentId: id, provider: host.deps.normalizeProvider(Harness.getProv()), model: Harness.getModel(), reasoningEffort: Harness.getReasoningEffort(Harness.getProv()) });
        expect('COMMS', 'A', id, run, { source: true, want: wants && wants[id] });
      }
    };
    comms(makeHost(SCENARIOS.A), Object.keys(SCENARIOS.A.want));   // the roster order: crew (its own low) is focused right before pin
    comms(makeHost(SCENARIOS.A), ['agent', 'pin']);                 // the Overseer's effort never rides into a pinned agent with none
    // an Overseer with no effort of its own, focused after a crew member with one: it runs the provider default
    const quiet = Object.assign({}, SCENARIOS.A, { roster: Object.assign({}, SCENARIOS.A.roster, { agent: Object.assign({}, SCENARIOS.A.roster.agent, { reasoningEffort: null }) }) });
    comms(makeHost(quiet), ['crew', 'agent'], { crew: ['codex', 'gpt-5.5', 'station', 'low'], agent: ['codex', 'gpt-5.5', 'agent', 'default'] });
    // a pin cleared through the 3-argument agent.model command (stationcommands.js with no effort) drops the old pin's
    // effort with it: the agent then follows the station default at the Overseer's effort, never at its dropped pin's
    {
      const cmds = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'stationcommands.js'), 'utf8');
      A.ok(/a\.effort != null \? cfg\.setModel\(x\.id, model, provider, String\(a\.effort\)\) : cfg\.setModel\(x\.id, model, provider\)/.test(cmds),
        'fixture: agent.model with no effort sets the pin through the 3-argument setModel');
      const host = makeHost(SCENARIOS.A);
      host.agentRoster.set('smith', Object.assign({}, host.agentRoster.get('smith'), { reasoningEffort: 'xhigh' }));   // smith's pin has its own effort
      const agents = new Map([...host.agentRoster].map(([id, a]) => [id, Object.assign({ id }, a)]));
      const Harness = makeHarness();
      const pushRoster = () => { for (const [id, a] of agents) host.agentRoster.set(id, Object.assign({}, a)); };   // what reaches the sidecar
      const p = new Function('agents', 'Harness', 'pushRoster', "let agent = null; let wirePinOwner = ''; const noteWirePin = () => {}; const persist = () => {};\n"
        + lift('stationDefaultWire') + lift('focusWire') + lift('applyWire') + lift('setAgentModelPin') + '\nreturn { focusWire, applyWire, setAgentModelPin };')(agents, Harness, pushRoster);
      A.ok(p.setAgentModelPin('smith', '', ''), 'the 3-argument clear is accepted');
      p.applyWire(p.focusWire(agents.get('smith')));
      const run = reach(host, { agentId: 'smith', provider: host.deps.normalizeProvider(Harness.getProv()), model: Harness.getModel(), reasoningEffort: Harness.getReasoningEffort(Harness.getProv()) });
      expect('COMMS', 'A', 'smith', run, { source: true, want: ['codex', 'gpt-5.5', 'station', 'high'] });
      // (review round 4) ...but an unpin of an agent that NEVER had a pin (crew follows the station with its own class
      // effort, low) is a no-op: its class effort stays, and it never drops to the Overseer's (high)
      A.ok(p.setAgentModelPin('crew', '', ''), 'the no-op unpin is accepted');
      A.eq(agents.get('crew').reasoningEffort, 'low', "a no-op unpin keeps the agent's class effort");
      // (review round 5) ...through the 4-argument door too: the dossier's CLEAR calls applyModel('', '', ''), which hands
      // setModel a 4th (empty) effort argument
      const ui = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'stationui.js'), 'utf8');
      A.ok(/mClear\.addEventListener\('click', \(\) => applyModel\('', '', ''\)\)/.test(ui) && /access\.config\.setModel\(a && a\.id, model, provider, effort\)/.test(ui),
        'fixture: CLEAR unpins through the 4-argument setModel');
      A.ok(p.setAgentModelPin('crew', '', '', ''), 'the 4-argument no-op unpin (CLEAR) is accepted');
      A.eq(agents.get('crew').reasoningEffort, 'low', "a no-op CLEAR keeps the agent's class effort");
      p.applyWire(p.focusWire(agents.get('crew')));
      const crewRun = reach(host, { agentId: 'crew', provider: host.deps.normalizeProvider(Harness.getProv()), model: Harness.getModel(), reasoningEffort: Harness.getReasoningEffort(Harness.getProv()) });
      expect('COMMS', 'A', 'crew', crewRun, { source: true });
      // ...while a 4-argument CLEAR of an agent that HAS a pin still drops that pin's effort with it
      A.ok(p.setAgentModelPin('smith', 'gpt-5.5', 'codex', 'xhigh'), 'a 4-argument pin with its own effort is accepted');
      A.eq(agents.get('smith').reasoningEffort, 'xhigh', '...and keeps that effort');
      A.ok(p.setAgentModelPin('smith', '', '', ''), 'the 4-argument CLEAR of a pinned agent is accepted');
      A.eq([agents.get('smith').model, agents.get('smith').reasoningEffort], [null, null], "...and drops the pin's effort with it");
    }
  }

  // ================================================ 2. Run Now ==========================================================
  // handleCronRun's own resolution lines and the effort its run carries, then the run it starts.
  {
    const runNow = sidecarTopLevelFunction('handleCronRun');
    const from = runNow.indexOf('assembledPrompt = scan.cleaned;\n  }\n') + 'assembledPrompt = scan.cleaned;\n  }\n'.length;
    const to = runNow.indexOf('  const key = cronKeyFor(provider);', from);
    A.ok(from > 100 && to > from && to - from < 800, 'fixture: Run Now resolution lines sliced');
    const region = runNow.slice(from, to);
    const effortExpr = (/\n {6}reasoningEffort: (.+),\n/.exec(runNow) || [])[1];
    A.ok(!!effortExpr, "fixture: Run Now's run carries a reasoningEffort");
    const runNowPair = (host, job) => new Function('job', 'cronWireFor', 'cronModelFor', 'cronProviderFor', 'cronIdentityFor',
      region + '\nreturn { model, provider, effort: (' + effortExpr + ') };')(job, host.cronWireFor, host.cronModelFor, host.cronProviderFor, host.cronIdentityFor);
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const p = runNowPair(host, { id: 'j-' + id, agentId: id });
        expect('Run Now', sc, id, p.model ? reach(host, { agentId: id, model: p.model, provider: p.provider, reasoningEffort: p.effort }) : null);
      }
    }
    // a routine an older form saved with the station's provider stamped on and no model (bug a496d1c7) follows its agent
    const host = makeHost(SCENARIOS.A);
    const legacy = runNowPair(host, { id: 'j-legacy', agentId: 'scout', provider: 'openrouter', model: null });
    expect('Run Now', 'A', 'scout', reach(host, { agentId: 'scout', model: legacy.model, provider: legacy.provider, reasoningEffort: legacy.effort }));
  }

  // ================================================ 3. the scheduled tick ===============================================
  // The REAL cron driver, composed the way sidecar/index.js composes it (its wireForJob / providerForJob, lifted).
  {
    const cron = require('../sidecar/cron.js');
    const cronStore = require('../sidecar/cron-store.js');
    const { makeCronDriver } = require('../sidecar/cron-driver.js');
    const driverCall = callRegion(SRC, 'const cronDriver = makeCronDriver({', '\n});');
    A.ok(driverCall.length > 100, 'fixture: index.js composes the cron driver');
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const T0 = 1700000000000;
        let store = [cronStore.makeJob({ id: 'j1', prompt: 'do it', agentId: id, schedule: cron.parseSchedule('every 1m', T0) }, { id: 'j1', now: T0 })];
        const runs = [];
        const scope = seamScope(host);
        const driver = makeCronDriver({
          getJobs: () => store, setJobs: (j) => { store = j; return true; },
          runOnce: (o) => new Promise(() => { runs.push(o); }),
          emit: () => {}, newId: () => 'run-1', newAbort: () => new AbortController(), now: () => T0 + 60000, warn: () => {},
          getKey: (provider) => host.deps.providerRuntimeKey(provider, ''),
          providerForJob: wiredSeam(driverCall, 'providerForJob', scope),
          wireForJob: wiredSeam(driverCall, 'wireForJob', scope),
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
  // The station's own Telegram hub as startTelegram builds it (its resolveEntryRunConfig, lifted): the page handed the
  // GLOBAL wire (here the focused agent's OpenRouter pin) at connect. The DM must run the routed agent's live pair — and a
  // /model change must reach it.
  {
    const { makeChannelHub } = require('../sidecar/channels/hub.js');
    const tg = sidecarTopLevelFunction('startTelegram');
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
        resolveEntryRunConfig: wiredSeam(tg, 'resolveEntryRunConfig', seamScope(host, { channelCredential: () => snap }))
      });
      await hub.onInbound({ channel: 'telegram', chatId: '777', chatType: 'dm', userId: 'owner', text, messageId: String(Date.now()), ts: 1 });
      return runs[0] || null;
    };
    const host = makeHost(SCENARIOS.A);
    for (const id of ['scout', 'crew', 'smith', 'pin', 'agent']) {
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
  // The lead is `smith` (pinned to OpenRouter); its workers must run their OWN pairs and efforts, never the lead's. The
  // real orchestration module, with the resolveWire / providerAuth runOnceCore really hands it (lifted from its call).
  {
    const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
    const orchCall = callRegion(CORE, 'makeOrchestrationTools({', '\n  }).register(registry);');
    A.ok(orchCall.length > 100, 'fixture: runOnceCore composes the orchestration tools');
    const host = makeHost(SCENARIOS.A);
    const runs = [];
    const scope = seamScope(host);
    const { dispatchTool } = makeOrchestrationTools({
      runOnce: async (o) => { runs.push(o); if (o.emit) { o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'done' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done' }); } return { reason: 'done' }; },
      roster: () => host.agentRoster, key: 'sk-or-test', model: 'anthropic/claude-x', provider: 'openrouter', baseUrl: '', reasoningEffort: 'xhigh', newId: (() => { let i = 0; return () => 'w' + (++i); })(),
      providerAuth: wiredSeam(orchCall, 'providerAuth', scope),
      resolveWire: wiredSeam(orchCall, 'resolveWire', scope)
    });
    await dispatchTool.run({ workers: [{ agentId: 'scout', prompt: 'find X' }, { agentId: 'crew', prompt: 'find W' }, { agentId: 'pin', prompt: 'find Y' }, { agentId: 'agent', prompt: 'find Z' }] },
      { agentId: 'smith', signal: { aborted: false }, emit: () => {} });
    for (const id of ['scout', 'crew', 'pin', 'agent']) {
      const run = runs.find(r => r.agentId === id);
      expect('team.dispatch worker', 'A', id, run ? reach(host, run) : null, { source: true });
    }
  }

  // ================================================ 6. /v1 ===============================================================
  // The real openai-compat surface over loopback, with the resolveWire / roster index.js really hands it (lifted).
  {
    const { makeOpenAiCompat } = require('../sidecar/openai-compat.js');
    const KEY = 'run-wire-invariant-key-123456';
    const v1Call = callRegion(SRC, 'const openaiCompat = makeOpenAiCompat({', '\n});');
    A.ok(v1Call.length > 100, 'fixture: index.js composes the /v1 surface');
    for (const sc of ['A', 'B', 'AV1']) {
      const host = makeHost(SCENARIOS[sc]);
      const runs = [];
      const scope = seamScope(host);
      const api = makeOpenAiCompat({
        now: () => 1000, newId: (() => { let i = 0; return () => 'id' + (++i); })(), apiKey: () => KEY,
        readBody: async req => { let s = ''; for await (const c of req) s += c; return s; },
        runOnce: async (o) => { runs.push(o); o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); },
        resolveProviderKey: (p) => host.deps.providerRuntimeKey(p, ''), resolveBaseUrl: () => '',
        roster: wiredSeam(v1Call, 'roster', scope),
        defaultModel: wiredSeam(v1Call, 'defaultModel', scope),
        resolveWire: wiredSeam(v1Call, 'resolveWire', scope)
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
        await post('starnet-agent');   // the generic model: the station default — or STARNET_V1_MODEL when it is set (AV1)
        expect('/v1', sc, 'generic', runs[0] ? reach(host, runs[0]) : null, { source: true, want: V1_GENERIC[sc] });
        if (sc !== 'B') {
          await post('scout');         // a roster agent selected by id: that agent's own pair, whatever STARNET_V1_MODEL says
          expect('/v1', sc, 'scout', runs[1] ? reach(host, runs[1]) : null, { source: true });
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
      const rt = runtimeOf(host);
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
      const rt = runtimeOf(host);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const sel = core.pickAgent(rt, { agent: id });
        const run = sel.ok ? reach(host, core.buildRunBody(sel, 'hi', {})) : null;
        expect('starnet run', sc, id, run);
      }
    }
  }

  // ================================================ 9. the Live Doctor ==================================================
  // handleLiveDoctor's own selection lines: the pair it probes and the effort it probes at must be what the agent's runs
  // use (E49), it names the source, and a provider-only choice it passed over is named, never silent.
  {
    const ld = sidecarTopLevelFunction('handleLiveDoctor');
    const from = ld.indexOf('  const targets = [];');
    const to = ld.indexOf("  targets.push({ kind: 'provider'", from);
    A.ok(from > 0 && to > from && to - from < 2000, 'fixture: the Live Doctor selection lines are sliced');
    const region = ld.slice(from, to);
    const namesSource = /out\.report\.wire = \{[^}]*source: doctorWire\.source/.test(ld) && /label: providerId \+ \(model \? ' \/ ' \+ model : ''\) \+ ' · ' \+ \(RunWire\.SOURCE_LABELS\[doctorWire\.source\]/.test(ld);
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const d = Object.assign({}, host.deps, { runWireFor: host.runWireFor });
        const got = new Function(...Object.keys(d), 'agentId', 'rec', region + "\nreturn { provider: providerId, model, effort: reasoningEffort, source: (typeof doctorWire === 'undefined') ? null : doctorWire.source, passedOver: (typeof passedOver === 'undefined') ? null : passedOver };")(...Object.values(d), id, host.agentRoster.get(id));
        expect('Live Doctor', sc, id, got.model ? Object.assign(got, { source: namesSource ? got.source : null }) : null, { source: true });
        if (sc === 'A' && id === 'scout') {
          A.ok(Array.isArray(got.passedOver) && got.passedOver.some(x => /^openrouter \(/.test(x)) && /passedOver\.length \? ' · passed over '/.test(ld) && /out\.report\.wire = \{[^\n]*ignored: /.test(ld),
            "the Live Doctor names the stale provider it passed over, in its label and report.wire.ignored: " + JSON.stringify(got.passedOver));
        }
      }
    }
  }

  // ================================================ 10. the terminal dashboard ==========================================
  // `starnet` (bin/lib/dashboard.js) keeps each agent in the station model (bin/lib/station-model.js setRoster, fed GET
  // /api/runtime/agent) and sends that agent's model/provider/effort on its runs; it refuses an agent with no model. An
  // unpinned agent follows the station default, so it has one.
  {
    const dash = fs.readFileSync(path.join(ROOT, 'bin', 'lib', 'dashboard.js'), 'utf8');
    A.ok(/if \(!a\.model\) \{ fail\(/.test(dash) && /const body = \{ model: a\.model, provider: a\.provider \|\| undefined, agentId,/.test(dash) && /if \(a\.reasoningEffort\) body\.reasoningEffort = a\.reasoningEffort;/.test(dash),
      "fixture: the dashboard runs the station model's pair and effort for the agent, and refuses one with no model");
    const StationModel = require('../bin/lib/station-model.js');
    for (const sc of ['A', 'B']) {
      const host = makeHost(SCENARIOS[sc]);
      const m = StationModel.makeStation();
      m.setRoster(runtimeOf(host));
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const a = m.state.agents.get(id);
        const run = (a && a.model) ? reach(host, { agentId: id, model: a.model, provider: a.provider || undefined, reasoningEffort: a.reasoningEffort || undefined }) : null;
        expect('starnet dashboard', sc, id, run);
      }
    }
  }

  // ================================================ 11. RUN A SAMPLE ====================================================
  // The sample hub's entry config (sampleRunConfigFor: also skill evaluation and restored verdict reviews): the agent's
  // pair and effort — on a roster-less ChatGPT-only station (C), the environment rule every surface reads, not openrouter
  // plus an OpenRouter-only env model.
  {
    for (const sc of ['A', 'B', 'C']) {
      const host = makeHost(SCENARIOS[sc]);
      for (const id of Object.keys(SCENARIOS[sc].want)) {
        const cfg = host.sampleRunConfigFor(id);
        const run = (cfg && cfg.configured && cfg.model) ? reach(host, { agentId: id, key: cfg.key, model: cfg.model, provider: cfg.provider, reasoningEffort: cfg.reasoningEffort, wireSource: cfg.wireSource }) : null;
        expect('RUN A SAMPLE', sc, id, run);
      }
    }
    // the dev hub's roster-less config and the DEV boot seed are that same environment rule (runWireEnv), never openrouter
    // plus an OpenRouter-only env model on a ChatGPT-only station
    const c = makeHost(SCENARIOS.C).devHubSecrets();
    A.eq([c.provider, c.model, c.configured], ['codex', 'gpt-codex-default', true], 'the dev hub, roster-less, runs the environment rule');
    A.ok(/if \(DEV_MODE\) \{ const envWire = runWireEnv\(\);[^\n]*model: envWire\.model \|\| '', prov: envWire\.provider/.test(SRC), 'the DEV boot seed is the environment rule (runWireEnv)');
  }

  // ================================================ the channel CONNECT gates ===========================================
  // Telegram, Discord and the generic channels must prove at connect the pair their messages will really run
  // (stationHubRunConfig: the configured agent's live pair), never the snapshot the page handed. Each handler's own gate
  // lines, executed. Not an entry point of its own (no run starts here), so it sits outside the ledger.
  {
    const host = makeHost(SCENARIOS.A);
    host.agentRoster.set('claude', { name: 'CLAUDE', system: 'C', model: 'claude-x', provider: 'anthropic' });   // a pin on a provider with no credential here
    for (const fn of ['handleChannelConnect', 'handleDiscordConnect', 'handleGenericChannelConnect']) {
      const h = sidecarTopLevelFunction(fn);
      const starts = ['  // the gate is the pair the channel will really run', '  if (!model) return json(400'].map(a => h.indexOf(a)).filter(i => i >= 0);
      const from = starts.length ? Math.min(...starts) : -1;
      const to = h.indexOf('  const own = credStore.putChannel(', from);
      A.ok(from > 0 && to > from && to - from < 1200, 'fixture: ' + fn + "'s connect gate is sliced");
      const gate = (snap) => {
        const d = Object.assign({}, host.deps, { stationHubConnectError: host.stationHubConnectError });
        return new Function(...Object.keys(d), 'json', 'provider', 'key', 'baseUrl', 'model', 'reasoningEffort', 'agentId', 'system',
          h.slice(from, to) + "\nreturn 'pass';")(...Object.values(d), (code, obj) => obj.error, snap.provider, snap.key, '', snap.model, 'medium', snap.agentId, 'S');
      };
      A.eq(gate({ provider: 'openrouter', key: 'sk-or-test', model: '', agentId: 'scout' }), 'pass',
        fn + ': an agent that follows the station default connects though the page sent no model');
      const refused = gate({ provider: 'openrouter', key: 'sk-or-test', model: 'focused/pin-model', agentId: 'claude' });
      A.ok(refused !== 'pass' && /connect anthropic/.test(refused),
        fn + ': a snapshot pair the agent does not run cannot prove a channel whose agent has no credential — the gate returns its error: ' + refused);
      // the gate is the bot's DEFAULT agent (a floor route is per message): the error names it and both ways out
      A.ok(/^this bot's default agent, CLAUDE \(claude\), cannot run on this station: /.test(refused) && /Fix that, or connect the bot as an agent this station can run/.test(refused),
        fn + ": the refusal names the bot's default agent and both ways out: " + refused);
    }
    A.ok(/\*\/\nfunction stationHubConnectError\(/.test(SRC) && /THE CONNECT GATE[^]*?\*\/\nfunction stationHubConnectError\(/.test(SRC.slice(SRC.indexOf('/* THE CONNECT GATE'))),
      'the CONNECT GATE note sits directly above stationHubConnectError');
  }

  // ================================================ a channel connected WITHOUT a model, after a restart ================
  // The gate above passes a channel whose agent follows the station default though the page sent no model, and the record
  // then holds model ''. The boot auto-start (each channel's own condition, executed) and the owner-revoke restart must
  // bring it back while that live pair still runs — and still refuse one whose agent can no longer run.
  {
    const boot = SRC.slice(SRC.indexOf('auto-start a previously-connected Telegram bot'), SRC.indexOf('Restore EVERY saved connector into the manager'));
    const conds = [['telegram', /if \((t\.enabled && tgTok && .+?)\) \{ startTelegram\(/, 't', 'tgTok'], ['discord', /if \((d\.enabled && dcTok && .+?)\) \{ startDiscord\(/, 'd', 'dcTok'],
      ['generic', /if \((r\.enabled && authOk && .+?)\) \{\n/, 'r', 'authOk']];
    const revoke = sidecarTopLevelFunction('restartTelegramAfterOwnerRevoke');
    A.ok(revoke.length > 50, 'fixture: the owner-revoke restart is declared');
    for (const [label, sc, rec, want] of [
      ['an agent that follows the station default', 'A', { enabled: true, model: '', provider: 'openrouter', key: '', agentId: 'scout' }, true],
      ['the Overseer, no model saved', 'A', { enabled: true, model: '', provider: 'openrouter', agentId: '' }, true],
      ['an agent pinned to a provider with no credential', 'A', { enabled: true, model: '', provider: 'openrouter', agentId: 'claude' }, false],
      ['a saved model, as before', 'A', { enabled: true, model: 'x/y', provider: 'openrouter', agentId: 'scout' }, true],
      ['a station with no model anywhere', 'B0', { enabled: true, model: '', provider: 'openrouter', agentId: 'scout' }, false]]) {
      const host = sc === 'B0' ? makeHost({ roster: { scout: { name: 'SCOUT', model: null, provider: '' } }, env: {}, codex: false, want: {} }) : makeHost(SCENARIOS[sc]);
      host.agentRoster.set('claude', { name: 'CLAUDE', system: 'C', model: 'claude-x', provider: 'anthropic' });
      const d = Object.assign({}, host.deps, { channelFollowsReady: host.channelFollowsReady });
      for (const [ch, re, recName, tokName] of conds) {
        const m = re.exec(boot);
        A.ok(!!m, 'fixture: the ' + ch + ' boot auto-start condition is found');
        const starts = !!(m && new Function(...Object.keys(d), recName, tokName, 'return (' + m[1] + ');')(...Object.values(d), rec, 'tok'));
        A.eq(starts, want, 'boot auto-start of the ' + ch + ' channel saved by ' + label + ': ' + (want ? 'starts' : 'stays off'));
      }
      let restarted = null;
      new Function(...Object.keys(d), 'telegram', 'channelToken', 'channelCredential', 'stopTelegram', 'startTelegram', revoke + '\nreturn restartTelegramAfterOwnerRevoke;')(
        ...Object.values(d), {}, () => 'tok', () => rec, () => { restarted = false; }, () => { restarted = true; })(rec);
      A.eq(restarted, want, 'the owner revoke ' + (want ? 'restarts' : 'stops') + ' the Telegram bot saved by ' + label);
    }
  }

  // ================================================ the verdict, per entry point ========================================
  const lines = [];
  for (const [entry, rows] of ledger) {
    const bad = rows.filter(r => !r.ok);
    lines.push((bad.length ? 'FAIL ' : 'ok   ') + entry + (bad.length ? ' — ' + bad.map(r => r.why).join(' | ') : ''));
    A.ok(bad.length === 0, entry + ' runs every agent on its one pair and effort, and names it: ' + (bad.map(r => r.why).join(' | ') || 'ok'));
  }
  console.log('[run-wire invariant] per entry point:\n  ' + lines.join('\n  '));
  A.eq([...ledger.keys()], ['COMMS', 'Run Now', 'scheduled tick', 'Telegram owner DM', 'team.dispatch worker', '/v1', 'ACP', 'starnet run', 'Live Doctor', 'starnet dashboard', 'RUN A SAMPLE'],
    'every entry point the lane names was exercised');
  A.report('run-wire.invariant: one pair and one effort per agent on every entry point');
})().catch(e => { A.ok(false, 'run-wire.invariant threw: ' + ((e && e.stack) || e)); A.report('run-wire.invariant'); });
