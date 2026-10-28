/* node test/permissions.test.js — the informed-consent broker (roadmap P1.5a).
   Proves the four-tier ladder is pure, deterministic, fail-closed, and session-scoped:
   hardline floor sits BELOW the bypass flag, mutations default-deny under an autonomous surface,
   grants are per-session (not process-global), and an 'always' grant only sticks if it persisted. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeConsentBroker, ANTI_RETRY, SILENCE } = require('../sidecar/permissions.js');

// tool shapes as produced by makeTool (carry scope/capability, NOT network)
const WRITE = { name: 'fs.write', capability: 'files', scope: 'write', requiresConsent: true };
const READ = { name: 'fs.read', capability: 'files', scope: 'read' };
const NET_READ = { name: 'web_fetch', capability: 'web', scope: 'read', network: true };
const writeCall = { name: 'fs.write', args: { path: 'report.md' } };

// a hardline floor like the one index.js will inject: protected files, even inside the jail.
const hardline = (call) => (call && call.args && /(^|\/)(\.env|permissions\.allow\.json)$/.test(call.args.path)) ? 'protected file' : null;

// ---- 1. HARDLINE sits below BYPASS: a floor file is denied even with Full Access ----
{
  const consent = makeConsentBroker({ bypass: true, hardline: hardline });
  const r = consent({ name: 'fs.write', args: { path: '.env' } }, WRITE);
  A.ok(!r.allow, 'hardline denies even with bypass=true');
  A.ok(r.hardline === true, 'denial flagged hardline');
  A.ok(r.reason.indexOf('protected file') >= 0, 'hardline reason names the cause');
  A.ok(r.reason.indexOf('do not retry') >= 0, 'hardline reason carries the anti-retry suffix');
  A.ok(ANTI_RETRY.length > 0, 'ANTI_RETRY constant exported');

  // a NON-floor write WITH bypass is allowed (bypass still works above the floor)
  const ok = consent(writeCall, WRITE);
  A.ok(ok.allow, 'bypass allows a non-hardline write');
  A.eq(ok.reason, 'full-access', 'bypass reason is full-access');
  A.eq(ok.scope, 'write', 'scope echoed back');
}

// ---- 2. RESOLVE: read-only & non-network auto-allows; read+network does NOT ----
{
  const consent = makeConsentBroker({ surface: 'autonomous' });
  A.ok(consent({ name: 'fs.read', args: {} }, READ).allow, 'read-only non-network auto-allows');
  const netr = consent({ name: 'web_fetch', args: {} }, NET_READ);
  A.ok(!netr.allow, 'read-but-network is NOT auto-allowed (the !network clause)');
  A.eq(netr.reason, SILENCE, 'network read falls through to default-deny');
}

// ---- 3. un-granted mutation under autonomous -> default-deny (silence is not consent) ----
{
  const consent = makeConsentBroker(); // surface defaults to autonomous, bypass defaults false
  const r = consent(writeCall, WRITE);
  A.ok(!r.allow, 'ungranted mutation default-denies');
  A.eq(r.reason, SILENCE, 'default-deny reason is the silence rule');
}

// ---- 4. a 'session' grant is per-session, not process-global ----
{
  const grantsSession = new Map();              // shared store across both run brokers
  const run1 = makeConsentBroker({ sessionKey: 'run1', grantsSession: grantsSession });
  const run2 = makeConsentBroker({ sessionKey: 'run2', grantsSession: grantsSession });

  A.ok(!run1(writeCall, WRITE).allow, 'before grant: run1 denies');
  run1.grant('session', writeCall, WRITE);
  const after = run1(writeCall, WRITE);
  A.ok(after.allow, 'after session grant: SAME session allows');
  A.eq(after.reason, 'previously granted', 'allowed via the cache tier');
  A.ok(!run2(writeCall, WRITE).allow, 'a DIFFERENT session is unaffected (session-scoped, not global)');
}

// ---- 5. an 'always' grant persists exactly once and survives a fresh broker ----
{
  let saved = null, calls = 0;
  const persist = (arr) => { calls++; saved = arr.slice(); };
  const broker = makeConsentBroker({ sessionKey: 'r', persist: persist });

  const g = broker.grant('always', writeCall, WRITE);
  A.ok(g.allow, 'always grant succeeds when persist succeeds');
  A.eq(calls, 1, 'persist called exactly once');
  A.eq(saved, ['files:write'], 'persisted the danger CLASS only (capability:scope), never args/paths');

  // rebuild a brand-new broker from the persisted set, under an UNRELATED session
  const reborn = makeConsentBroker({ sessionKey: 'other', grantsPermanent: new Set(saved) });
  const r = reborn(writeCall, WRITE);
  A.ok(r.allow, 'permanent grant survives a fresh broker and ignores sessionKey');
  A.eq(r.reason, 'previously granted', 'allowed via the cache tier');
}

// ---- 6. a thrown persist degrades to deny and records nothing (fail-closed) ----
{
  const broker = makeConsentBroker({ persist: () => { throw new Error('disk full'); } });
  const g = broker.grant('always', writeCall, WRITE);
  A.ok(!g.allow, 'always grant denied when persist throws');
  A.ok(g.reason.indexOf('persist') >= 0, 'reason explains the persist failure');
  A.ok(!broker(writeCall, WRITE).allow, 'the failed grant was NOT recorded — consent still denies');
  A.eq(broker.snapshot().permanent.length, 0, 'snapshot shows nothing committed');
}

// ---- 7. snapshot reflects committed grants (read-only view) ----
{
  const broker = makeConsentBroker({ sessionKey: 's1' });
  broker.grant('session', writeCall, WRITE);
  broker.grant('always', writeCall, WRITE); // no persist injected -> in-memory only
  const snap = broker.snapshot();
  A.eq(snap.permanent, ['files:write'], 'snapshot lists permanent grants');
  A.eq(snap.session.s1, ['files:write'], 'snapshot lists session grants by key');
}

// ---- 8. 'once' allows without recording; 'deny'/unknown denies ----
{
  const broker = makeConsentBroker({ sessionKey: 'o' });
  A.ok(broker.grant('once', writeCall, WRITE).allow, 'once allows');
  A.ok(!broker(writeCall, WRITE).allow, 'once did not record a standing grant');
  A.ok(!broker.grant('deny', writeCall, WRITE).allow, 'explicit deny denies');
  A.ok(!broker.grant('weird', writeCall, WRITE).allow, 'unknown decision denies');
}

// ---- 9-11. the INTERACTIVE surface (async: the human-prompt branch is the only one that returns a Promise) ----
(async () => {
  const brokerWith = (decision, extra) =>
    makeConsentBroker(Object.assign({ surface: 'interactive', prompt: () => Promise.resolve(decision) }, extra || {}));

  // 9. once allows without recording; deny/unknown deny; always persists the CLASS and then short-circuits (no re-ask)
  A.ok((await brokerWith('once')(writeCall, WRITE)).allow, 'interactive once -> allow');
  A.ok(!(await brokerWith('deny')(writeCall, WRITE)).allow, 'interactive deny -> deny');
  A.ok(!(await brokerWith('zzz')(writeCall, WRITE)).allow, 'interactive unknown decision -> deny');
  let saved = null;
  const bAlways = brokerWith('always', { sessionKey: 'iv', persist: a => { saved = a.slice(); } });
  A.ok((await bAlways(writeCall, WRITE)).allow, 'interactive always -> allow');
  A.eq(saved, ['files:write'], 'interactive always persisted the danger CLASS only');
  const again = bAlways(writeCall, WRITE);   // CACHE tier now -> a SYNC object, proving no second prompt
  A.ok(again.allow === true && again.reason === 'previously granted', 'a granted class no longer prompts');

  // 10. full access: the host-persisted live posture covers every danger class, but the hardline still wins
  let full = false;
  const bFull = makeConsentBroker({
    surface: 'interactive', bypass: () => full,
    prompt: () => { full = true; return Promise.resolve('full'); }, hardline: hardline
  });
  A.ok((await bFull(writeCall, WRITE)).allow, 'full access -> allow');
  A.ok(full, 'the host posture changed to full');
  const otherClass = bFull({ name: 'shell.exec', args: {} }, { name: 'shell.exec', capability: 'shell', scope: 'write' });
  A.ok(otherClass.allow === true && otherClass.reason === 'full-access', 'live Full Access covers a different danger class without asking');
  const floor = bFull({ name: 'fs.write', args: { path: '.env' } }, WRITE);
  A.ok(!floor.allow && floor.hardline === true, 'hardline still denies under full access');

  // 11. interactive needs a wired prompt (else fail closed); autonomous IGNORES a prompt (surface gates the ask)
  const nc = makeConsentBroker({ surface: 'interactive' })(writeCall, WRITE);   // interactive, no prompt
  A.ok(!nc.allow && /no consent channel/.test(nc.reason), 'interactive with no prompt fails closed');
  let asked = false;
  const ar = makeConsentBroker({ surface: 'autonomous', prompt: () => { asked = true; return Promise.resolve('once'); } })(writeCall, WRITE);
  A.ok(!ar.allow && ar.reason === SILENCE && asked === false, 'autonomous default-denies and never consults the prompt');

  // 12. EXEC LOCKOUT: an autonomous run can NEVER execute a command — not even off a pre-blessed `always` grant.
  // Only an interactive (watched) run may approve shell; frozen FULL_ACCESS stays the one deliberate exception.
  {
    const EXEC = { name: 'shell.exec', capability: 'workbench', scope: 'execute', requiresConsent: true };
    const execCall = { name: 'shell.exec', args: { cmd: 'npm test' } };
    const blessed = () => new Set(['workbench:execute']);   // shell pre-blessed once by a human ('always')

    const auto = makeConsentBroker({ surface: 'autonomous', grantsPermanent: blessed() });
    const r = auto(execCall, EXEC);
    A.ok(!r.allow && r.reason === SILENCE, 'autonomous shell DENIES despite a permanent grant (exec lockout)');

    const inter = makeConsentBroker({ surface: 'interactive', grantsPermanent: blessed() });
    A.ok(inter(execCall, EXEC).allow === true, 'interactive shell HONORS the pre-bless (a human approved it)');

    const yolo = makeConsentBroker({ surface: 'autonomous', bypass: true });
    A.ok(yolo(execCall, EXEC).allow === true, 'frozen FULL_ACCESS still allows autonomous shell (deliberate operator override)');

    // the lockout is EXEC-ONLY: a pre-blessed WRITE still works autonomously (cron's file deliverables depend on it).
    const w = makeConsentBroker({ surface: 'autonomous', grantsPermanent: new Set(['files:write']) });
    A.ok(w(writeCall, WRITE).allow === true, 'a pre-blessed WRITE is unaffected — the lockout never touches non-exec classes');

    /* UNATTENDED TERMINAL GRANT (2026-07-25) — the ONE key that opens the exec lockout unattended: the
       Commander's recorded per-ROUTINE approval, injected by the host from the durable cron job. It is
       deliberately NOT reachable by a cached 'always' grant (proved above) or by prompt text. */
    const granted = makeConsentBroker({ surface: 'autonomous', terminalGrant: () => true });
    A.ok(granted(execCall, EXEC).allow === true, 'a granted routine may execute shell unattended');
    A.ok(/per-routine unattended terminal grant/.test(granted(execCall, EXEC).reason), 'the allow names the grant that authorized it');

    // ordering is load-bearing: the grant tier must sit ABOVE the exec lockout or it would be dead code.
    const ungranted = makeConsentBroker({ surface: 'autonomous', terminalGrant: () => false });
    A.ok(!ungranted(execCall, EXEC).allow, 'a predicate that says no leaves the lockout standing');

    // the grant is capability-SCOPED: it must never generalize past the workbench family.
    const OTHER_EXEC = { name: 'team.dispatch', capability: 'orchestrator', scope: 'execute', requiresConsent: true };
    A.ok(!granted({ name: 'team.dispatch', args: {} }, OTHER_EXEC).allow, 'a terminal grant does NOT unlock other execute-scope tools');

    // and it is surface-scoped: on the watched surface the ordinary ladder still runs. consent() returns a
    // PROMISE only when it reached the ask-the-human branch, so a thenable here proves the grant did not
    // short-circuit into an immediate allow (asserted synchronously — this suite is not async).
    const grantedInteractive = makeConsentBroker({ surface: 'interactive', terminalGrant: () => true, prompt: () => 'deny' });
    const interactiveDecision = grantedInteractive(execCall, EXEC);
    A.ok(interactiveDecision && typeof interactiveDecision.then === 'function', 'interactive still asks the human — the grant never pre-approves a watched run');

    /* UNATTENDED CONNECTOR GRANT — same tier shape for the Commander's MCP servers. A non-read MCP tool is
       scope 'execute', so this too must sit above the exec lockout. Capability is matched by the 'mcp:' PREFIX
       so ONE grant covers every connected server while refusing everything else. */
    const MCP = { name: 'mcp__demo__lookup', capability: 'mcp:demo', scope: 'execute', requiresConsent: true, network: true };
    const mcpCall = { name: 'mcp__demo__lookup', args: { query: 'x' } };
    const connOn = makeConsentBroker({ surface: 'autonomous', connectorGrant: () => true });
    A.ok(connOn(mcpCall, MCP).allow === true, 'a granted routine may call an MCP connector unattended');
    A.ok(/per-routine unattended connector grant/.test(connOn(mcpCall, MCP).reason), 'the allow names the connector grant');
    const connOff = makeConsentBroker({ surface: 'autonomous' });
    A.ok(!connOff(mcpCall, MCP).allow, 'without the grant an MCP connector stays denied unattended');
    // the two grants are independent — neither implies the other
    A.ok(!connOn(execCall, EXEC).allow, 'a connector grant does NOT unlock shell');
    A.ok(!granted(mcpCall, MCP).allow, 'a terminal grant does NOT unlock connectors');
    // and the connector grant is capability-scoped, not a blanket autonomous allow
    A.ok(!connOn(writeCall, WRITE).allow, 'a connector grant does NOT unlock ordinary writes');
  }

  /* ---- Full Access has one canonical persisted meaning ---------------------------------------------- */
  {
    const auto = makeConsentBroker({ surface: 'autonomous', bypass: () => true, hardline: hardline });
    const r = auto({ name: 'fs.write', args: { path: 'notes.md' } }, WRITE);
    A.ok(r.allow && r.reason === 'full-access', 'Full Access applies to unattended runs too');
    const floor2 = auto({ name: 'fs.write', args: { path: '.env' } }, WRITE);
    A.ok(!floor2.allow && floor2.hardline === true, 'and the hardline floor still wins over it');
  }
  // The Field Manual must describe this exact ladder, not promise that every capability always prompts.
  {
    const fs = require('fs'); const path = require('path');
    const tutorial = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'tutorial.js'), 'utf8');
    A.ok(/local file reads and private notebook saves do not prompt/i.test(tutorial), 'Field Manual names both no-prompt local exceptions');
    A.ok(/already approved or FULL ACCESS is on/i.test(tutorial), 'Field Manual names standing-grant and Full Access exceptions');
    A.ok(/ASK and narrower reach modes retain their restrictions/i.test(tutorial), 'Field Manual scopes restrictions to the selected reach and posture');
    A.ok(/FULL POWER is host-wide/i.test(tutorial), 'Field Manual describes current host-wide Full Power authority');
    A.ok(!/protected actions stay blocked/i.test(tutorial), 'Field Manual does not apply the retired universal floor to Full Power');
    A.ok(/prop grants a CAPABILITY[^']+not blanket consent/i.test(tutorial), 'Field Manual distinguishes capabilities from consent');
    A.ok(/Settings &gt; Permissions decides whether an action asks or runs without another prompt/i.test(tutorial), 'Field Manual assigns prompting to the real Settings posture');
    A.ok(!/before i touch a file or reach out i stop and ask/i.test(tutorial), 'retired every-action prompt promise is absent');
    A.ok(!/prop in my room is a PERMISSION/i.test(tutorial), 'retired prop-equals-permission claim is absent');
    A.ok(!/consent-gated, like every tool/i.test(tutorial), 'retired every-tool prompt implication is absent');
  }
  // Structural wiring lock: the endpoint persists roster Full Access and run authority reads it live.
  {
    const fs = require('fs'); const path = require('path');
    const src = readSidecarSource();
    A.ok(/persistAgentFullAccess\(agentId\)/.test(src), 'the permission-card endpoint persists Full Access');
    A.ok(/fullAccess: agentFullAccessNow/.test(src), 'run authority receives the live per-agent predicate');
    A.ok(/agentFullAccessNow\(\)/.test(src), 'the consent broker reads that posture on every call');
    A.ok(!/grantsBlanketByAgent|blanketSetFor|grantsBlanket:/.test(src), 'the obsolete process-memory wildcard is gone');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
    A.ok(/App\.setApproval\([^\n]+, 'full', \{ recorded: true \}\)/.test(ui), 'the confirmed permission-card choice updates the visible roster posture (already recorded by the station)');
  }

  A.report('permissions.test');
})();
