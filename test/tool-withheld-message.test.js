/* node test/tool-withheld-message.test.js - locks the WITHHELD-vs-UNKNOWN tool answer.

   The bug (2026-07-25, from a user report): every tool is REGISTERED on every run, but the gates
   decide which reach the wire list. A gated-away tool therefore had no fromWire entry, its name
   never translated back to the dotted form, and registry.dispatch answered "unknown tool:
   shell_exec" — false, since the tool exists. On an unattended routine that string was the last
   thing the agent saw before reporting fabricated success, and it is what made Commanders (and
   their agents) hunt for a broken tool instead of a withheld one.

   Two halves are locked here:
     1. The message seam in runOnce distinguishes WITHHELD (real tool, not granted to this run)
        from genuinely unknown, names the gate via the authority's OWN predicate, and never
        false-positives a GRANTED tool the model called by its real dotted name.
     2. The ROUTINES panel tells the user, where routines are written, that an unattended run has
        no terminal — the remedy users actually reached for (placing a WORKBENCH) cannot work,
        because enforceRunAuthority strips shell.exec/verify.run on every non-interactive surface. */
'use strict';
const { readSidecarSource } = require('./helpers/source');

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
// the host: cron-driver.js is read on its own below (`driver`), and skills.js / code.js / inputpolicy.js / taint.js use the same words
const src = readSidecarSource({ except: ['sidecar/cron-driver.js', 'sidecar/tools/builtin/skills.js', 'sidecar/tools/builtin/code.js', 'sidecar/inputpolicy.js', 'sidecar/taint.js'] });
const panel = fs.readFileSync(path.join(root, 'frontend', 'app', 'windows', 'routines.js'), 'utf8');

// ---- 1. the dispatch seam ----
A.ok(/const allWire = new Map\(\);/.test(src), 'a wire-name map over ALL registered tools exists');
A.ok(/for \(const t of registry\.list\(\)\) allWire\.set\(/.test(src), 'the map is built from the FULL registry, not the granted subset');
A.ok(/const grantedSet = new Set\(resolved\.tools \|\| \[\]\);/.test(src), 'the grant set is materialized for the withheld check');
// The guard MUST consult the grant set, not merely the absence of a fromWire entry: a granted tool
// called by its dotted real name also misses fromWire and must keep its ordinary capability path.
A.ok(/else if \(!grantedSet\.has\(c\.name\) && registry\.get\(allWire\.get\(c\.name\) \|\| c\.name\)\)/.test(src),
  'withheld branch requires BOTH not-granted AND a really-registered tool');
A.ok(/summary: 'withheld'/.test(src), 'a withheld answer is telemetered distinctly from a plain error');
A.ok(/WITHHELD: "' \+ realName \+ '"/.test(src), 'the message names the REAL dotted tool name');
A.ok(/impactOfTool/.test(src) && /impactOfTool\s*\}?\s*=?[^\n]*require\('\.\/inputpolicy\.js'\)|impactOfTool,/.test(src),
  'the reason comes from inputpolicy\'s own impact classifier, not a second copy of the policy');
A.ok(/userControlAuthority\.project\(t\) === false/.test(src), 'surface gating is decided by the authority\'s own predicate');
A.ok(/no attended-control lease exists/.test(src), 'desktop/physical tools get the no-lease reason, not "needs a watched session"');
A.ok(/UNATTENDED ' \+ surface \+ ' run/.test(src), 'an unattended run is told it is unattended');
A.ok(/Do NOT retry it and do NOT report its work as done/.test(src), 'the model is told not to fabricate the withheld work');
// the honest fallback must survive: a name matching NO registered tool still reports unknown
A.ok(/unknown tool: /.test(fs.readFileSync(path.join(root, 'sidecar', 'tools', 'registry.js'), 'utf8')),
  'a genuinely unknown tool still answers "unknown tool"');

// ---- 2. the ROUTINES panel ----
A.ok(/off unless you grant them below/i.test(panel), 'the ROUTINES brief states the extra powers are off by default');
A.ok(/placing a WORKBENCH on the floor does not grant them/i.test(panel), 'it kills the workaround users actually reach for');
A.ok(/id="rt-term"/.test(panel), 'the CREATE form carries the terminal-grant control');
A.ok(/id="rt-conn"/.test(panel), 'the CREATE form carries the connected-tools grant control');
A.ok(/unattendedGrants: grants\.length \? grants : undefined/.test(panel), 'grants are sent ONLY when ticked (an untouched form posts the old body)');
A.ok(/\['#rt-term', '#rt-conn', '#rt-img'\]\.forEach/.test(panel), 'no grant is sticky across creates');
A.ok(/mc-term-grant/.test(panel), 'a routine holding a standing grant is visibly badged on its row');
A.ok(/connected tools/.test(panel), 'the connector grant is described in plain language, not as "MCP"');

// the mirror the website build serves must carry the same copy (website/app is GENERATED)
const mirror = path.join(root, 'website', 'app', 'app', 'windows', 'routines.js');
if (fs.existsSync(mirror)) {
  A.ok(/off unless you grant them below/i.test(fs.readFileSync(mirror, 'utf8')), 'the generated website mirror carries the terminal-honesty copy');
}

/* ---- THE SELF-GRANT HOLE (must stay closed) ----
   The entire safety property of the unattended grant is that a MODEL cannot mint one. There are three routine
   creation paths; only the Commander's own panel request may carry grants. If either agent-reachable path ever
   spreads its caller args into the spec, an agent could schedule itself a terminal — silently. Lock both. */
{
  const agentTool = fs.readFileSync(path.join(root, 'sidecar', 'tools', 'builtin', 'routines.js'), 'utf8');
  const slashActions = fs.readFileSync(path.join(root, 'sidecar', 'slash-actions.js'), 'utf8');
  A.ok(!/unattendedGrants/.test(agentTool),
    'the agent-facing routine.create tool never names unattendedGrants (it builds an explicit whitelist spec)');
  A.ok(!/\.\.\.args|Object\.assign\(\{\}, args\)/.test(agentTool),
    'routine.create never spreads caller args into the spec (that would smuggle a grant through)');
  /* routine.manage (the agent-facing EDIT path) is the same hole in a second door: cron-store's updateJob
     patches the grant field too, so an agent that could hand it an arbitrary patch could escalate an existing
     routine instead of a new one. It must build the patch from a named allowlist, key by key. */
  A.ok(/const AGENT_PATCHABLE = \[/.test(agentTool),
    'the agent-facing edit path declares an explicit patchable-field allowlist');
  A.ok(/AGENT_PATCHABLE\.indexOf\(k\) >= 0/.test(agentTool),
    'routine.manage filters its patch THROUGH that allowlist before it reaches the store');
  A.ok(!/updateRoutine\(job\.id, args/.test(agentTool),
    'routine.manage never hands raw caller args to the store as a patch');
  A.ok(!/unattendedGrants/.test(slashActions), 'the /routine slash action cannot set a grant either');
}

// ---- 3. the grant is wired end to end, and defaults to OFF everywhere ----
const store = fs.readFileSync(path.join(root, 'sidecar', 'cron-store.js'), 'utf8');
const driver = fs.readFileSync(path.join(root, 'sidecar', 'cron-driver.js'), 'utf8');
const policy = fs.readFileSync(path.join(root, 'sidecar', 'inputpolicy.js'), 'utf8');
const perms = fs.readFileSync(path.join(root, 'sidecar', 'permissions.js'), 'utf8');

A.ok(/unattendedGrants: normGrants\(spec\.unattendedGrants\)/.test(store), 'the job record normalizes the grant through the store whitelist');
A.ok(/hasOwnProperty\.call\(patch, 'unattendedGrants'\)\) next\.unattendedGrants = normGrants/.test(store),
  'the PATCH path re-normalizes too (the EDITABLE loop copies raw values)');
A.ok(/unattendedGrants: Array\.isArray\(job\.unattendedGrants\)/.test(driver), 'the scheduled tick passes the job grant into the run');
A.ok(/unattendedGrants: Array\.isArray\(job\.unattendedGrants\)/.test(src), 'Run Now passes it too, so "test it now" exercises the real posture');
A.ok(/const GRANTABLE_UNATTENDED = new Set\(\['workbench', 'connectors', 'studio'\]\)/.test(policy), 'the authority owns a closed whitelist of grantable families');
A.ok(/function isConnectorTool\(tool\) \{\s*return \/\^mcp:\/\.test/.test(policy), 'connector tools are identified by the mcp: capability prefix');
A.ok(/connectorsGranted && isConnectorTool\(tool\)/.test(policy),
  'the connector grant is narrowed to REAL connectors — it never opens the external-unknown catch-all');
A.ok(/connectorAutonomy\(call, tool\)\) return \{ allow: true/.test(perms), 'the consent broker has a matching connector tier');
A.ok(perms.indexOf('connectorAutonomy(call, tool)) return { allow: true') <
     perms.indexOf("surface === 'autonomous' && scope === 'execute'"),
  'the connector tier also sits ABOVE the exec lockout (a non-read MCP tool is scope execute)');
A.ok(/connectorGrant: \(call, tool\) => !execution\.taintedBy\(\) && \(ownerTrusted \|\| unattendedGrants\.indexOf\('connectors'\) >= 0\)/.test(src),
  'connector standing grants apply only before untrusted content, including for an owner DM');
A.ok(/stationWithConnectors\(station, agentId, connectors\.ids\(\)\)/.test(src),
  'connector portals are injected into a bay-docked room too (composeOffice is bypassed there)');
// the capability note must not re-assert the old blanket "no connectors unattended" lie
const capsum = fs.readFileSync(path.join(root, 'sidecar', 'capability', 'capsummary.js'), 'utf8');
A.ok(!/shell\/terminal, desktop control and live connector tools/.test(capsum),
  'the unattended note no longer hardcodes a blanket no-shell/no-connector claim');
A.ok(/lackAutonomous/.test(capsum), 'the unattended note names only what is genuinely absent from THIS run');
// `trustedNow()` includes only host-sourced wideners: admitted owner DM, persisted master bypass, or the
// persisted per-agent Full Access posture. None is reachable from prompt text.
A.ok(/if \(!trusted && surface !== 'interactive' && impact === IMPACTS\.MEDIA_CONTROL\) return false;/.test(policy),
  'media-control stays denied to ordinary ASK-mode unattended automation');
A.ok(/const trustedNow = \(\) => ownerTrusted \|\| masterBypass \|\| fullAccessNow\(\);/.test(policy),
  'trusted is exactly the three host-sourced authority postures, including persisted per-agent Full Access');
A.ok(/terminalAutonomy\(call, tool\)\) return \{ allow: true/.test(perms), 'the consent broker has the matching grant tier');
// ORDERING IS LOAD-BEARING: below the exec lockout the tier would be dead code.
A.ok(perms.indexOf('terminalAutonomy(call, tool)) return { allow: true') <
     perms.indexOf("surface === 'autonomous' && scope === 'execute'"),
  'the grant tier sits ABOVE the exec lockout');
// the grant must never be derivable from anything the model can influence
A.ok(/terminalGrant: \(call, tool\) => !execution\.taintedBy\(\) && \(ownerTrusted \|\| unattendedGrants\.indexOf\('workbench'\) >= 0\)/.test(src),
  'terminal standing grants apply only before untrusted content, including for an owner DM');
A.ok(/surface === 'interactive' \? \[\] : Array\.from\(normalizeUnattendedGrants\(o\.unattendedGrants\)\)/.test(src),
  'the grant is ignored on the watched surface, where floor placement governs');

/* ---- 4. the injection tripwire is wired at EVERY door ----
   Behavior lives in test/cron-guard.test.js; this locks the WIRING, which is where a scanner silently dies.
   Five doors: HTTP create, the /routine slash (same funnel), the AGENT tool, edit-by-patch, and both fire
   paths. Miss any one and a payload reaches an auto-approving granted run. */
{
  const guard = fs.readFileSync(path.join(root, 'sidecar', 'cron-guard.js'), 'utf8');
  A.ok(/scanRoutinePrompt/.test(guard) && /scanAssembled/.test(guard), 'the guard exposes both tiers');
  // create door (POST /api/cron + the /routine slash action both funnel through createCronJobFromSpec)
  A.ok(/cronGuard\.scanRoutinePrompt\(body\.prompt\)/.test(src), 'the HTTP/slash create path scans before persisting');
  // the agent-authored door — the one that matters most (an agent that just read a hostile page)
  A.ok(/cronGuard\.scanRoutinePrompt\(spec\.prompt\)/.test(src), 'the AGENT routine.create path scans too');
  // edit door — a clean routine must not be patchable into a payload
  A.ok(/cronGuard\.scanRoutinePrompt\(patch\.prompt\)/.test(src), 'the update/patch path scans the new prompt');
  // fire doors — defense in depth for prompts authored before the scanner, and for runtime-loaded content
  A.ok(/cronGuard\.scanAssembled\(assembledPrompt/.test(src), 'Run Now re-scans the actual prompt after upstream context assembly');
  A.ok(/cronGuard\.scanAssembled\(assembledPrompt/.test(driver), 'the scheduled tick re-scans the actual prompt after upstream context assembly');
  // a fire-time block must be VISIBLE, not a silent skip
  A.ok(/status: 'error', reason: 'blocked'/.test(driver), 'a blocked fire is recorded as a real failed run');
  A.ok(/outcome: 'failed', reason: 'blocked: '/.test(driver), 'and reported on the cron.result event');
  // the tripwire must run BEFORE the capability/credential gate, or a blocked payload still costs a model call
  A.ok(driver.indexOf('cronGuard.scanAssembled') < driver.indexOf('const ident = identityForAgent'),
    'the fire-time scan runs before the run is prepared (no spend on a blocked routine)');
}

if (require.main === module) A.report('tool-withheld-message.test');
