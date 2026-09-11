/* node test/inputpolicy.test.js — ordinary run capabilities are synthetic-only. */
'use strict';
const A = require('./_assert.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeConsentBroker } = require('../sidecar/permissions.js');
const { makeComputerTools } = require('../sidecar/tools/builtin/computer.js');
const { makeDesktopTools } = require('../sidecar/tools/builtin/desktop.js');
const { enforceSyntheticOnly, enforceRunAuthority, enforceEnabledToolsets, runInputContext, impactOfTool, makeRunAuthority, IMPACTS, backgroundOwnsLoopbackUrl, backgroundOwnsLocalUrl, makeLoopbackListenerProbe, normalizeUnattendedGrants, isConnectorTool } = require('../sidecar/inputpolicy.js');

const station = {
  agents: { ag: { id: 'ag', room: 'r' } },
  rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }, { objectType: 'workbench' }, { objectType: 'dish' }] } }
};
const raw = resolveTools('ag', station);
A.ok(!raw.tools.includes('computer.use'), 'ordinary capability telemetry never advertises physical input');
A.ok(!raw.tools.includes('desktop.open'), 'ordinary capability telemetry never advertises real-screen launch');
// Also simulate a stale/forged legacy resolver result: the per-run policy must still strip it.
const legacyRaw = Object.assign({}, raw, {
  tools: raw.tools.concat('computer.use', 'desktop.open'),
  grants: raw.grants.concat(
    { capId: 'workbench', tool: 'computer.use', scope: 'execute', requiresConsent: true, network: false },
    { capId: 'web', tool: 'desktop.open', scope: 'execute', requiresConsent: true, network: true }
  ),
  approvalRules: Object.assign({}, raw.approvalRules, {
    'computer.use': { requiresConsent: true, scope: 'execute', network: false },
    'desktop.open': { requiresConsent: true, scope: 'execute', network: true }
  }),
  networkCaps: Object.assign({}, raw.networkCaps, { 'computer.use': false, 'desktop.open': true })
});
const safe = enforceSyntheticOnly(legacyRaw);
A.ok(!safe.tools.includes('computer.use'), 'physical input is absent from provider/dispatch tool names');
A.ok(!safe.tools.includes('desktop.open'), 'real-window launch is absent from provider/dispatch tool names');
A.ok(!safe.grants.some(g => g.tool === 'computer.use'), 'physical input is absent from resolved grant telemetry');
A.ok(!safe.grants.some(g => g.tool === 'desktop.open'), 'real-window launch is absent from resolved grant telemetry');
A.eq(safe.approvalRules['computer.use'], undefined, 'physical input has no ordinary approval rule');
A.eq(safe.approvalRules['desktop.open'], undefined, 'real-window launch has no ordinary approval rule');
A.ok(safe.tools.includes('shell.exec') && safe.tools.includes('verify.run'), 'workbench build/test tools remain available');
A.ok(safe.tools.includes('browser.test_navigate') && safe.tools.includes('browser.test_input') && safe.tools.includes('browser.test_state'), 'safe local CDP route replaces physical input');
A.ok(legacyRaw.tools.includes('computer.use') && legacyRaw.tools.includes('desktop.open'), 'policy returns an isolated copy and does not corrupt source results');

{
  const defs = {};
  for (const g of safe.grants) defs[g.tool] = { capability: g.capId };
  defs['mcp:notion.read'] = { capability: 'mcp:notion' };
  const projected = Object.assign({}, safe, {
    tools: safe.tools.concat('mcp:notion.read'),
    deferred: (safe.deferred || []).concat('mcp:notion.read'),
    approvalRules: Object.assign({}, safe.approvalRules, { 'mcp:notion.read': { requiresConsent: false } }),
    networkCaps: Object.assign({}, safe.networkCaps, { 'mcp:notion.read': true })
  });
  const onlyWeb = enforceEnabledToolsets(projected, { get: n => defs[n] }, ['web']);
  A.ok(onlyWeb.tools.includes('web_search'), 'enabled web family remains available');
  A.ok(!onlyWeb.tools.includes('shell.exec'), 'per-job toolsets remove workbench instead of adding authority');
  A.ok(!onlyWeb.tools.includes('mcp:notion.read'), 'connectors require the explicit connectors family');
  A.ok(onlyWeb.tools.includes('quest.update') && onlyWeb.tools.includes('tool.search'), 'non-toggleable computer freebies remain available');
  A.eq(onlyWeb.approvalRules['shell.exec'], undefined, 'parallel approval map is attenuated with tool names');
  A.eq(enforceEnabledToolsets(projected, { get: n => defs[n] }, null), projected, 'null keeps legacy station grants unchanged');
}

for (const [surface, isTask] of [['interactive', true], ['autonomous', true], ['test', false]]) {
  const ctx = runInputContext(surface, isTask);
  A.eq(ctx.physicalInputAuthorized, false, surface + ' context has explicit physical-input deny');
  A.eq(ctx.inputMode, 'synthetic', surface + ' context is synthetic-only');
}

const interactiveAuthority = makeRunAuthority({ surface: 'interactive', isTask: true, environment: { supports: { hostileCodeSandbox: false } } });
const autonomousAuthority = makeRunAuthority({ surface: undefined, isTask: true, environment: { supports: { hostileCodeSandbox: false } } });
A.eq(autonomousAuthority.surface, 'autonomous', 'missing surface fails closed to unattended');
A.ok(interactiveAuthority.authorize({}, { name: 'shell.exec', capability: 'workbench' }).ok, 'watched workspace commands remain available behind their command/consent floors');
A.ok(!autonomousAuthority.authorize({}, { name: 'shell.exec', capability: 'workbench' }).ok, 'UNGRANTED unattended shell is denied above Full Access');

/* UNATTENDED TERMINAL GRANT (2026-07-25) — a routine the Commander explicitly granted may use the terminal
   unattended. The grant is host-recorded (read off the durable cron job), never derivable from prompt text or
   Full Access; these lock both directions plus the whitelist that stops it widening. */
const grantedAuthority = makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: ['workbench'] });
A.ok(grantedAuthority.authorize({}, { name: 'shell.exec', capability: 'workbench' }).ok, 'a GRANTED unattended run may use shell');
A.ok(grantedAuthority.authorize({}, { name: 'verify.run', capability: 'workbench' }).ok, 'the grant covers verify.run (same workspace-process class)');
A.ok(grantedAuthority.project({ name: 'shell.exec', capability: 'workbench' }), 'a granted run is OFFERED shell in the wire list');
A.ok(!autonomousAuthority.project({ name: 'shell.exec', capability: 'workbench' }), 'an ungranted run is not offered shell');
// the grant is scoped: it must not leak into other denied classes
A.ok(!grantedAuthority.authorize({}, { name: 'spotify_play', capability: 'jukebox' }).ok, 'a terminal grant does NOT unlock media-control');
A.ok(!grantedAuthority.authorize({}, { name: 'computer.use', capability: 'physical-input' }).ok, 'a terminal grant does NOT unlock physical input');
A.ok(!grantedAuthority.authorize({}, { name: 'future.magic', capability: 'future-cap' }).ok, 'a terminal grant does NOT unlock unknown external effects');
// an ungrantable/bogus family name is dropped rather than honored
const bogusGrant = makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: ['jukebox', 'physical-input', '*', ''] });
A.eq(bogusGrant.unattendedGrants.length, 0, 'non-whitelisted grant names are dropped');
A.ok(!bogusGrant.authorize({}, { name: 'spotify_play', capability: 'jukebox' }).ok, 'a dropped grant grants nothing');
A.eq(normalizeUnattendedGrants(['workbench', 'workbench', 'nope']).size, 1, 'grant normalization dedupes and whitelists');
// the grant is meaningless on the watched surface (THE MOAT governs there)
const grantedInteractive = makeRunAuthority({ surface: 'interactive', isTask: true, unattendedGrants: ['workbench'] });
A.ok(grantedInteractive.authorize({}, { name: 'shell.exec', capability: 'workbench' }).ok, 'interactive shell is unchanged by the grant');

/* AUTHENTICATED TELEGRAM OWNER — the ingress mints this bit only after adapter ownership admission. It grants
   the owner the desktop agent's non-physical control surface without weakening the physical/visible floors. */
const ownerAuthority = makeRunAuthority({ surface: 'autonomous', isTask: true, ownerTrusted: true });
A.ok(ownerAuthority.ownerTrusted, 'owner authority retains its host-minted diagnostic bit');
A.ok(ownerAuthority.project({ name: 'shell.exec', capability: 'workbench' }), 'an owner DM is offered shell without a routine grant');
A.ok(ownerAuthority.authorize({}, { name: 'shell.exec', capability: 'workbench' }).ok, 'an owner DM may execute shell commands');
A.ok(ownerAuthority.authorize({}, { name: 'spotify_play', capability: 'jukebox' }).ok, 'an owner DM may control the active media session');
A.ok(ownerAuthority.authorize({}, { name: 'mcp__demo__lookup', capability: 'mcp:demo' }).ok,
  'an owner DM may call the Commander\'s connected tools');
A.ok(ownerAuthority.authorize({}, { name: 'future.magic', capability: 'future-cap' }).ok,
  'an owner DM has the desktop surface\'s non-physical external authority');
A.ok(!ownerAuthority.authorize({}, { name: 'computer.use', capability: 'physical-input' }).ok,
  'owner Telegram parity never fabricates a physical-input lease');
A.ok(!ownerAuthority.authorize({}, { name: 'desktop.open', capability: 'visible-desktop' }).ok,
  'owner Telegram parity never fabricates a visible-desktop lease');
const remoteOwnerAuthority = makeRunAuthority({ surface: 'autonomous', isTask: true, ownerTrusted: true, remoteDesktopAuthorized: true });
A.ok(remoteOwnerAuthority.remoteDesktopAuthorized, 'a host-minted paired-owner desktop lease is visible in authority diagnostics');
A.ok(remoteOwnerAuthority.project({ name: 'computer.use', capability: 'physical-input' }), 'only that lease projects physical input');
A.ok(remoteOwnerAuthority.authorize({}, { name: 'computer.use', capability: 'physical-input' }).ok, 'only that lease authorizes physical input');
A.ok(remoteOwnerAuthority.authorize({}, { name: 'desktop.open', capability: 'visible-desktop' }).ok, 'only that lease authorizes visible desktop launch');
const remoteCtx = runInputContext('autonomous', true, true);
A.eq(remoteCtx.inputMode, 'remote-owner', 'remote owner context is explicitly distinct from synthetic input');
A.ok(remoteCtx.remoteDesktopAuthorized, 'remote owner context carries the host lease bit');
const fullPowerCtx = runInputContext('autonomous', true, false, true);
A.eq(fullPowerCtx.inputMode, 'full-power', 'Full Power context is explicitly host-wide');
A.ok(fullPowerCtx.physicalInputAuthorized && fullPowerCtx.unrestrictedHost, 'Full Power context carries physical and unrestricted host authority');

/* UNATTENDED CONNECTOR GRANT — the Commander's own MCP servers, callable by a granted routine. The critical
   property: external-unknown is ALSO the fail-closed default for anything the host cannot classify, so the
   grant must reach connector tools ONLY (capability 'mcp:<id>'), never that catch-all. */
const MCP_TOOL = { name: 'mcp__demo__lookup', capability: 'mcp:demo' };
const UNCLASSIFIED = { name: 'future.magic', capability: 'future-cap' };
const connGranted = makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: ['connectors'] });
A.eq(impactOfTool(MCP_TOOL), IMPACTS.EXTERNAL_UNKNOWN, 'connector tools are still classified external-unknown');
A.ok(connGranted.authorize({}, MCP_TOOL).ok, 'a GRANTED unattended run may call a connector tool');
A.ok(connGranted.project(MCP_TOOL), 'a granted run is OFFERED its connector tools');
A.ok(!autonomousAuthority.project(MCP_TOOL), 'an ungranted run is not offered connector tools');
A.ok(!autonomousAuthority.authorize({}, MCP_TOOL).ok, 'an ungranted run may not call them');
// THE CATCH-ALL MUST STAY CLOSED — this is the assertion that stops the grant becoming "allow anything odd".
A.ok(!connGranted.project(UNCLASSIFIED), 'a connector grant does NOT open the external-unknown catch-all');
A.ok(!connGranted.authorize({}, UNCLASSIFIED).ok, 'an unclassifiable tool is still denied under a connector grant');
// cross-grant isolation: each grant unlocks only its own family
A.ok(!connGranted.authorize({}, { name: 'shell.exec', capability: 'workbench' }).ok, 'a connector grant does NOT unlock the terminal');
A.ok(!grantedAuthority.authorize({}, MCP_TOOL).ok, 'a terminal grant does NOT unlock connectors');
const bothGranted = makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: ['workbench', 'connectors'] });
A.ok(bothGranted.authorize({}, MCP_TOOL).ok && bothGranted.authorize({}, { name: 'shell.exec', capability: 'workbench' }).ok, 'both grants together unlock both families');
// interactive connector behavior is UNCHANGED: still an exact per-call confirmation, never the grant
const connInteractiveNoConfirm = makeRunAuthority({ surface: 'interactive', isTask: true, unattendedGrants: ['connectors'] });
A.ok(!connInteractiveNoConfirm.project(MCP_TOOL), 'interactive without a confirm channel still refuses connector tools');
A.ok(isConnectorTool(MCP_TOOL) && !isConnectorTool(UNCLASSIFIED), 'connector classification keys on the mcp: capability prefix');
A.ok(!interactiveAuthority.authorize({}, { name: 'computer.use', capability: 'physical-input' }).ok, 'physical input has no ordinary-run authority');
A.ok(!interactiveAuthority.authorize({}, { name: 'desktop.open', capability: 'visible-desktop' }).ok, 'visible desktop has no ordinary-run authority');
A.eq(impactOfTool({ name: 'future.magic', capability: 'future-cap' }), IMPACTS.EXTERNAL_UNKNOWN, 'unknown future tools fail closed instead of defaulting safe');
A.eq(impactOfTool({ name: 'station.inspect', capability: 'stationinfo' }), IMPACTS.NONE, 'local secret-free harness inspection is a safe built-in read');
A.eq(impactOfTool({ name: 'browser.test_input', capability: 'workbench' }), IMPACTS.SYNTHETIC_BROWSER, 'synthetic CDP input is explicitly classified');

const fakeDefs = {
  'shell.exec': { name: 'shell.exec', capability: 'workbench' },
  'browser.test_input': { name: 'browser.test_input', capability: 'workbench' },
  'future.magic': { name: 'future.magic', capability: 'future-cap' }
};
const matrixResolved = { tools: Object.keys(fakeDefs), grants: Object.keys(fakeDefs).map(tool => ({ tool })), approvalRules: {}, networkCaps: {} };
const filteredAutonomous = enforceRunAuthority(matrixResolved, { get: n => fakeDefs[n] }, autonomousAuthority);
A.ok(!filteredAutonomous.tools.includes('shell.exec') && !filteredAutonomous.tools.includes('future.magic'), 'provider projection removes unattended/unknown effects');
A.ok(filteredAutonomous.tools.includes('browser.test_input'), 'provider projection retains synthetic input');

const viteFallback = { running: true, killed: false, cmd: 'vite --port 5173', tail: '\u001b[32mLocal: http://localhost:5174/\u001b[0m' };
A.eq(backgroundOwnsLoopbackUrl(viteFallback, 'http://127.0.0.1:5173/'), false, 'requested command port cannot impersonate another localhost service after dev-server fallback');
A.eq(backgroundOwnsLoopbackUrl(viteFallback, 'http://127.0.0.1:5174/'), true, 'actual advertised loopback endpoint is accepted for the owned background handle');
A.eq(backgroundOwnsLoopbackUrl(Object.assign({}, viteFallback, { running: false }), 'http://127.0.0.1:5174/'), false, 'exited background server owns no local test URL');
A.eq(backgroundOwnsLoopbackUrl({ running: true, tail: 'Local: https://[::1]:4443/' }, 'https://localhost:4443/'), true, 'IPv6 loopback advertisement binds by actual port');

(async () => {
  const probeCalls = [];
  const ownedProbe = makeLoopbackListenerProbe({
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    execFile: (exe, args, options, cb) => { probeCalls.push({ exe, args, options }); cb(null, '', ''); }
  });
  const ownedStatus = { running: true, killed: false, pid: 4321, tail: 'Local: http://localhost:5174/' };
  A.eq(await backgroundOwnsLocalUrl(ownedStatus, 'http://127.0.0.1:5174/', ownedProbe), true, 'advertised endpoint is accepted only after OS listener ancestry proof');
  A.ok(/powershell/i.test(probeCalls[0].exe) && probeCalls[0].args.some(x => /\$root=4321/.test(x)), 'Windows listener probe binds the check to the background root PID');
  A.ok(probeCalls[0].args.some(x => /foreach\(\$owner in \$owners\)[\s\S]*if\(-not \$owned\)\{exit 3\}[\s\S]*exit 0/.test(x)), 'mixed owned/unowned listeners fail closed instead of accepting the first owned PID');
  A.eq(await backgroundOwnsLocalUrl(ownedStatus, 'http://127.0.0.1:5174/', async () => false), false, 'spoofed stdout URL cannot authorize a listener owned by another process');
  A.eq(await backgroundOwnsLocalUrl(Object.assign({}, ownedStatus, { pid: null }), 'http://127.0.0.1:5174/', ownedProbe), false, 'missing background PID fails listener ownership closed');

  /* THE UNCLASSIFIABLE TOOL — anything that merely FELL THROUGH to external-unknown keeps the exact,
     non-cacheable, one-shot per-call confirmation. This is the catch-all, and it stays shut. */
  let exactPrompts = 0, standingPrompts = 0, unknownRuns = 0;
  const exactAuthority = makeRunAuthority({
    surface: 'interactive', isTask: true,
    environment: { supports: { hostileCodeSandbox: false } },
    confirm: async () => { exactPrompts++; return 'full'; }   // even the STRONGEST answer buys nothing here
  });
  const unknownRegistry = makeRegistry();
  unknownRegistry.register({
    name: 'future.magic', capability: 'future-cap', impact: 'external-unknown',
    scope: 'read', requiresConsent: true, schema: { type: 'object', properties: {} },
    run: async () => { unknownRuns++; return { content: 'ok' }; }
  });
  const unknownCtx = { authorize: exactAuthority.authorize, consent: async () => { standingPrompts++; return { allow: true }; } };
  const unknownResult = await unknownRegistry.dispatch({ id: 'u1', name: 'future.magic', args: {} }, unknownCtx);
  A.eq(unknownResult.ok, true, 'unknown external effect runs only after exact live confirmation');
  A.eq(exactPrompts, 1, 'unknown external effect receives one exact per-call prompt');
  A.eq(standingPrompts, 0, 'exact one-shot authority does not fall through to a weaker cached-consent prompt');
  await unknownRegistry.dispatch({ id: 'u2', name: 'future.magic', args: {} }, unknownCtx);
  A.eq(exactPrompts, 2, 'an unclassifiable tool re-asks every call — "full" is deliberately NOT recorded for it');
  A.eq(unknownRuns, 2, 'each confirmed unclassifiable call executes exactly once');

  /* THE CONNECTOR TOOL (capability 'mcp:<id>') — a server the Commander deliberately connected. It routes to
     the consent BROKER instead, so the grade they pick is recorded and the next call is answered from cache.
     REGRESSION (2026-07-27): the one-shot path collapsed once/always/full to a boolean, so a user clicking
     "Full access" was re-prompted on every single connector call — four times in a row on a live Shopify run. */
  let connPrompts = 0, connRuns = 0;
  let connectorFull = false;
  const connAuthority = makeRunAuthority({
    surface: 'interactive', isTask: true,
    environment: { supports: { hostileCodeSandbox: false } },
    confirm: async () => 'once', fullAccess: () => connectorFull
  });
  const connRegistry = makeRegistry();
  connRegistry.register({
    name: 'mcp__custom__maybe_read', capability: 'mcp:custom', impact: 'external-unknown',
    scope: 'read', requiresConsent: true, schema: { type: 'object', properties: {} },
    run: async () => { connRuns++; return { content: 'ok' }; }
  });
  const connBroker = makeConsentBroker({
    surface: 'interactive', sessionKey: 'r1', bypass: () => connectorFull,
    networkOf: () => true,                                   // every MCP call is an outward network effect
    prompt: async () => { connPrompts++; connectorFull = true; return 'full'; }
  });
  const connCtx = { authorize: connAuthority.authorize, consent: connBroker };
  const c1 = await connRegistry.dispatch({ id: 'c1', name: 'mcp__custom__maybe_read', args: {} }, connCtx);
  A.eq(c1.ok, true, 'a watched connector call runs after the broker prompt');
  A.eq(connPrompts, 1, 'the FIRST connector call still asks a live human');
  const c2 = await connRegistry.dispatch({ id: 'c2', name: 'mcp__custom__maybe_read', args: {} }, connCtx);
  A.eq(c2.ok, true, 'the second connector call is allowed');
  A.eq(connPrompts, 1, 'THE BUG: "Full access" must silence every later connector prompt, not re-ask each call');
  A.eq(connRuns, 2, 'both connector calls executed');
  // "Always" records the danger CLASS (capability:scope) rather than the blanket — same no-re-prompt result.
  let alwaysPrompts = 0;
  const alwaysBroker = makeConsentBroker({
    surface: 'interactive', sessionKey: 'r2', networkOf: () => true,
    prompt: async () => { alwaysPrompts++; return 'always'; }
  });
  const alwaysCtx = { authorize: connAuthority.authorize, consent: alwaysBroker };
  await connRegistry.dispatch({ id: 'a1', name: 'mcp__custom__maybe_read', args: {} }, alwaysCtx);
  await connRegistry.dispatch({ id: 'a2', name: 'mcp__custom__maybe_read', args: {} }, alwaysCtx);
  A.eq(alwaysPrompts, 1, '"Always" on a connector is recorded as a standing grant, not re-asked');
  A.ok(alwaysBroker.snapshot().permanent.indexOf('mcp:custom:read') >= 0, 'the standing grant is visible/revocable in the Permissions panel snapshot');
  // A DENY still refuses, and is NOT remembered as a yes.
  let denyPrompts = 0, denyRuns = 0;
  const denyRegistry = makeRegistry();
  denyRegistry.register({
    name: 'mcp__custom__maybe_read', capability: 'mcp:custom', impact: 'external-unknown',
    scope: 'read', requiresConsent: true, schema: { type: 'object', properties: {} },
    run: async () => { denyRuns++; return { content: 'ok' }; }
  });
  const denyBroker = makeConsentBroker({
    surface: 'interactive', sessionKey: 'r3', networkOf: () => true,
    prompt: async () => { denyPrompts++; return 'deny'; }
  });
  const denied1 = await denyRegistry.dispatch({ id: 'd1', name: 'mcp__custom__maybe_read', args: {} }, { authorize: connAuthority.authorize, consent: denyBroker });
  A.eq(denied1.summary, 'denied', 'a denied connector call performs no action');
  A.eq(denyRuns, 0, 'a denied connector tool never runs');
  A.eq(denyPrompts, 1, 'the deny went through the broker, which asked exactly once');
  // The autonomous floor is untouched: no grant, no connector call, whatever consent says.
  const deniedUnattended = await connRegistry.dispatch(
    { id: 'u3', name: 'mcp__custom__maybe_read', args: {} },
    { authorize: autonomousAuthority.authorize, consent: async () => ({ allow: true }) }
  );
  A.eq(deniedUnattended.summary, 'user-control-denied', 'autonomous connector calls are denied despite consent state');
  A.eq(connRuns, 4, 'the denied autonomous connector never executed');

  let driverCalls = 0, openerCalls = 0;
  const registry = makeRegistry();
  makeComputerTools({ allowPhysicalInput: true, driver: { perform: async () => { driverCalls++; return {}; } } }).register(registry);
  makeDesktopTools({ allowRemoteDesktop: true, opener: async () => { openerCalls++; return 'opened'; } }).register(registry);
  const exposed = registry.wireFormat(registry.list(safe.tools)).map(x => x.function.name);
  A.ok(!exposed.includes('computer.use') && !exposed.includes('desktop.open'), 'provider wire format contains no real-input/real-screen tool');
  const ctx = Object.assign(makeCapCtx(safe), {
    // Simulate the strongest consent bypass: capability denial must still win first.
    consent: async () => ({ allow: true, reason: 'full-access' }),
    surface: 'interactive', isTask: false, physicalInputAuthorized: true, inputMode: 'attended'
  });
  const computer = await registry.dispatch({ id: 'c1', name: 'computer.use', args: { action: 'screenshot' } }, ctx);
  const desktop = await registry.dispatch({ id: 'c2', name: 'desktop.open', args: { target: 'notepad' } }, ctx);
  A.eq(computer.summary, 'user-control-denied', 'forged computer.use is denied even when a caller forgot to attach run authority');
  A.eq(desktop.summary, 'user-control-denied', 'forged desktop.open is denied even when a caller forgot to attach run authority');
  A.eq(driverCalls, 0, 'forged physical-input dispatch never reaches the driver');
  A.eq(openerCalls, 0, 'forged real-window dispatch never reaches the opener');

  const forgedResolved = Object.assign({}, safe, { tools: safe.tools.concat('computer.use', 'desktop.open') });
  const hardCtx = Object.assign(makeCapCtx(forgedResolved), {
    authorize: interactiveAuthority.authorize,
    consent: async () => ({ allow: true, reason: 'full-access' })
  });
  const hardComputer = await registry.dispatch({ id: 'c3', name: 'computer.use', args: { action: 'screenshot' } }, hardCtx);
  const hardDesktop = await registry.dispatch({ id: 'c4', name: 'desktop.open', args: { target: 'notepad' } }, hardCtx);
  A.eq(hardComputer.summary, 'user-control-denied', 'central authority denies forged physical input before Full Access');
  A.eq(hardDesktop.summary, 'user-control-denied', 'central authority denies forged visible desktop before Full Access');

  const fullAuthority = makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: true });
  const fullResolved = enforceRunAuthority(enforceSyntheticOnly(legacyRaw, true), registry, fullAuthority);
  const fullCtx = Object.assign(makeCapCtx(fullResolved), runInputContext('autonomous', true, false, true), {
    authorize: fullAuthority.authorize,
    consent: async () => ({ allow: true, reason: 'full-power' })
  });
  const fullComputer = await registry.dispatch({ id: 'c5', name: 'computer.use', args: { action: 'wait', durationMs: 1 } }, fullCtx);
  const fullDesktop = await registry.dispatch({ id: 'c6', name: 'desktop.open', args: { target: 'notepad' } }, fullCtx);
  A.ok(fullComputer.ok === true && fullDesktop.ok === true, 'Full Power reaches physical input and visible desktop through every dispatch gate');
  A.eq(driverCalls, 1, 'Full Power reaches the native input driver exactly once');
  A.eq(openerCalls, 1, 'Full Power reaches the visible desktop opener exactly once');
  // Delegation only bridges MCP authority; cached consent cannot widen other unattended effects.
  const mcp = { name: 'mcp__crm__read', capability: 'mcp:crm', scope: 'read' };
  let parentAllows = true;
  const parent = makeRunAuthority({ surface: 'interactive', confirm: async () => 'once' });
  const delegated = makeRunAuthority({ surface: 'autonomous', connectorAuthority: {
    project: tool => parentAllows && parent.project(tool), authorize: parent.authorize
  } });
  A.ok(delegated.project(mcp), 'watched lead can expose MCP to delegated worker');
  A.ok((await delegated.authorize({}, mcp)).ok, 'delegated MCP reaches the separate consent broker');
  for (const tool of [{ name: 'unknown', capability: 'unclassified' }, { name: 'shell.exec', capability: 'workbench' }, { name: 'computer.use', capability: 'physical-input' }]) {
    A.eq(delegated.project(tool), false, 'MCP bridge cannot expose ' + tool.name);
    A.eq((await delegated.authorize({}, tool)).ok, false, 'MCP bridge cannot authorize ' + tool.name);
  }
  parentAllows = false;
  A.eq(delegated.project(mcp), false, 'live parent revocation removes delegated MCP authority');
  A.eq((await delegated.authorize({}, mcp)).ok, false, 'previous projection cannot bypass parent revocation');
  const unattended = makeRunAuthority({ surface: 'autonomous' });
  const unattendedChild = makeRunAuthority({ connectorAuthority: unattended });
  A.eq(unattendedChild.project(mcp), false, 'an ungranted unattended lead cannot mint a connector grant');
  A.report('inputpolicy.test');
})().catch(e => { console.error(e); process.exit(1); });
