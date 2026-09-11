/* sidecar/inputpolicy.js — host authority for physical-input isolation.

   Every current runOnce flow is synthetic-only. This module removes physical computer.use and
   real-screen desktop.open from the resolved capability set before provider tool definitions
   are built and stamps the dispatch context with an explicit deny. Prompt text, isTask,
   surface:'interactive', Full Access, and permanent consent are deliberately irrelevant.

   A future attended-control feature must be a separate host-minted, one-shot runId+callId lease;
   it must not weaken these ordinary task/autonomous/test helpers. */
'use strict';

const REAL_DESKTOP_TOOLS = new Set(['computer.use', 'desktop.open']);
const IMPACTS = Object.freeze({
  NONE: 'none',
  SYNTHETIC_BROWSER: 'synthetic-browser',
  WORKSPACE_PROCESS: 'workspace-process',
  MEDIA_CONTROL: 'media-control',
  EXTERNAL_SERVICE: 'external-service',
  // A network call that SPENDS one of the Commander's stored credentials (web_request). Deliberately its
  // own class, between external-service and external-unknown: unlike web_fetch it can act as the user on a
  // third-party account, but unlike shell.exec it grants NO host-process capability — no spawn, no
  // filesystem, no arbitrary binary. That is why it may run unattended where a shell may not; the blast
  // radius is exactly "one HTTPS request to a host, using a key the Commander explicitly approved for
  // unattended use". The per-key grant is enforced at the tool (servicekeys.resolveForRequest), which is
  // the only layer that knows WHICH key a given call spends.
  EXTERNAL_CREDENTIALED: 'external-credentialed',
  EXTERNAL_UNKNOWN: 'external-unknown',
  VISIBLE_DESKTOP: 'visible-desktop',
  PHYSICAL_INPUT: 'physical-input'
});
const IMPACT_SET = new Set(Object.keys(IMPACTS).map(k => IMPACTS[k]));
// 'taskbrief' = the host's OWN internal Task Brief controls (brief.ask / brief.proceed): read-only
// bookkeeping against a host-side store with zero external effect. Without it they fell through to
// EXTERNAL_UNKNOWN and the host demanded a per-call confirmation for the tool whose whole job is
// asking the Commander a question (live-caught 2026-07-16: three approval cards to ask one question).
// 'toolsearch' = tool.search: reads the in-process tool registry and returns names. Zero external effect —
// it cannot even call what it finds, it only makes it advertisable. Same live-caught failure as 'taskbrief'
// above: without an entry here it fell through to EXTERNAL_UNKNOWN and the authority layer refused it, so
// every DEFERRED tool became permanently unreachable while looking, from the outside, merely "not found".
const SAFE_BUILTIN_CAPS = new Set(['compute', 'cabinet', 'memory', 'quest', 'studio', 'orchestrator', 'taskbrief', 'toolsearch', 'code', 'stationinfo']);

function impactOfTool(tool) {
  tool = tool || {};
  if (IMPACT_SET.has(tool.impact)) return tool.impact;
  const name = String(tool.name || '');
  const cap = String(tool.capability || '');
  if (name === 'computer.use' || cap === 'physical-input') return IMPACTS.PHYSICAL_INPUT;
  if (name === 'desktop.open' || cap === 'visible-desktop') return IMPACTS.VISIBLE_DESKTOP;
  if (/^browser\./.test(name)) return IMPACTS.SYNTHETIC_BROWSER;
  if (name === 'shell.exec' || name === 'verify.run') return IMPACTS.WORKSPACE_PROCESS;
  if (/^shell\.bg\.(?:status|kill)$/.test(name)) return IMPACTS.NONE;
  if (/^spotify_(?:play|pause|next|previous|queue)$/.test(name) || cap === 'jukebox') return IMPACTS.MEDIA_CONTROL;
  if (SAFE_BUILTIN_CAPS.has(cap)) return IMPACTS.NONE;
  if (cap === 'web' && !/^browser\./.test(name)) return IMPACTS.EXTERNAL_SERVICE;
  // Dynamic/unknown capabilities fail closed. MCP translation classifies every custom
  // connector as external-unknown regardless of transport or self-declared annotations.
  return IMPACTS.EXTERNAL_UNKNOWN;
}

// The capability families that may be granted for unattended use. A name outside this set is DROPPED, so a
// widened/corrupted job record can never mint authority the host does not model. 'workbench' = shell.exec +
// verify.run (the workspace-process impact class). Deliberately NOT extended to media-control or
// external-unknown: those are separate lanes with their own blast radii.
// 'connectors' = the Commander's CONNECTED MCP servers (capability 'mcp:<connectorId>'). Deliberately NOT a
// blanket external-unknown unlock: that impact class is also the FAIL-CLOSED default for any tool the host
// cannot classify, so the grant is additionally narrowed to real connector tools by isConnectorTool below.
const GRANTABLE_UNATTENDED = new Set(['workbench', 'connectors']);

// A tool projected from a configured MCP connector. sidecar/mcp/translate.js stamps every such def with
// capability 'mcp:<sanitized connectorId>'; nothing else in the registry uses that prefix.
function isConnectorTool(tool) {
  return /^mcp:/.test(String((tool && tool.capability) || ''));
}

function normalizeUnattendedGrants(list) {
  const out = new Set();
  for (const g of (Array.isArray(list) ? list : [])) {
    const name = String(g == null ? '' : g).trim();
    if (name && GRANTABLE_UNATTENDED.has(name)) out.add(name);
  }
  return out;
}

function makeRunAuthority(opts) {
  opts = opts || {};
  const surface = opts.surface === 'interactive' ? 'interactive' : 'autonomous';
  const isTask = !!opts.isTask;
  // `ownerTrusted` is minted only by an authenticated owner DM at the channel ingress. It grants that
  // Commander the same tool authority as a watched StarNet session without changing the ordinary autonomous
  // policy used by cron, delegated workers, other channels, or group messages.
  const ownerTrusted = !!opts.ownerTrusted;
  /* MASTER BYPASS (2026-08-05) — the Commander's explicit, persisted "FULL BYPASS" switch. When on, this run
     gets the SAME impact-gate reach as an authenticated owner DM (external-unknown, media-control, and the
     host process unattended) on EVERY surface. Host-sourced only: the composition root reads it from the
     token-gated persisted store — never from prompt text, model output, or a consent grant, which is why it
     may widen what a cached "Full access" click deliberately must not. The ONE thing it does not mint is the
     remote-desktop lease: physical mouse/real-screen control still requires the host-minted desktop pairing
     (it takes over the user's live pointer — a switch cannot prove someone is watching). */
  const masterBypass = !!opts.masterBypass;
  // PER-AGENT FULL ACCESS is live authority, not a prompt-cache hint. Accept a thunk so selecting Full Access
  // while a run is paused takes effect on that run's very next tool call; revocation is equally immediate.
  // The host supplies this from the persisted roster. Model text and tool output cannot mutate it.
  const fullAccessFn = typeof opts.fullAccess === 'function' ? opts.fullAccess : null;
  const fullAccess = fullAccessFn ? false : opts.fullAccess === true;
  const fullAccessNow = () => {
    if (!fullAccessFn) return fullAccess;
    try { return fullAccessFn() === true; } catch (_) { return false; }
  };
  // Master bypass and per-agent Full Access are the two scopes of the same host-minted Full Power
  // authority. It is never derived from model-controlled text or tool output.
  const unrestrictedHostNow = () => masterBypass || fullAccessNow();
  const trustedNow = () => ownerTrusted || masterBypass || fullAccessNow();
  // This bit is minted by the desktop host only when a locally paired Telegram owner reaches this run. It is
  // deliberately separate from ownerTrusted: a bare sidecar or ordinary web session cannot turn an identity
  // claim into control of the foreground Windows desktop.
  const remoteDesktopAuthorized = ownerTrusted && opts.remoteDesktopAuthorized === true;
  const environment = opts.environment || null;
  const confirm = typeof opts.confirm === 'function' ? opts.confirm : null;
  const isolated = !!(environment && environment.supports && (environment.supports.userControlIsolation === true || environment.supports.hostileCodeSandbox === true));
  /* UNATTENDED CAPABILITY GRANT (2026-07-25) — capability families the HOST has recorded as approved for
     unattended use on THIS run: a routine whose Commander ticked "may use the terminal" in the ROUTINES panel.
     The record is durable, per-routine and revocable, read off the persisted job by the composition root.

     THE SAFETY PROPERTY, stated exactly: this value is NEVER derived from prompt text, model output, tool
     results, or a cached consent grant. The model cannot reach this path, so a prompt
     injection cannot mint one — the worst an injected routine prompt can do is use a power its Commander had
     already, deliberately, granted to that specific routine. In ASK mode this is the only unattended widening;
     the separate Full Access posture is a host-persisted operator choice checked by trustedNow(). */
  const unattendedGrants = normalizeUnattendedGrants(opts.unattendedGrants);
  const workbenchGranted = unattendedGrants.has('workbench');
  const connectorsGranted = unattendedGrants.has('connectors');
  // Host-only delegation bridge. A worker keeps its own capability projection and the lead's consent
  // broker, but can reach that broker for MCP calls the lead's live authority permits. This is not a
  // general interactive-surface upgrade and cannot grant shell, desktop or unknown non-MCP effects.
  const connectorAuthority = opts.connectorAuthority;
  function connectorDelegated(tool) {
    if (!isConnectorTool(tool) || !connectorAuthority || typeof connectorAuthority.project !== 'function' || typeof connectorAuthority.authorize !== 'function') return false;
    try { return connectorAuthority.project(tool) === true; } catch (_) { return false; }
  }
  // An unattended run may call a CONNECTOR tool only when the Commander granted this routine 'connectors'
  // AND the tool really is one. A tool that merely fell through to external-unknown (the fail-closed default
  // for anything unclassifiable) is NOT a connector and stays denied — the grant must never become a
  // catch-all for "everything the host could not identify".
  function connectorAllowedUnattended(tool) {
    return connectorsGranted && isConnectorTool(tool);
  }
  function project(tool) {
    const impact = impactOfTool(tool);
    const trusted = trustedNow();
    if (impact === IMPACTS.PHYSICAL_INPUT || impact === IMPACTS.VISIBLE_DESKTOP) return remoteDesktopAuthorized || unrestrictedHostNow();
    if (impact === IMPACTS.EXTERNAL_UNKNOWN) {
      if (trusted) return true;
      if (surface === 'interactive') return !!confirm;
      return connectorAllowedUnattended(tool) || connectorDelegated(tool);
    }
    if (!trusted && surface !== 'interactive' && impact === IMPACTS.MEDIA_CONTROL) return false;
    // In ASK mode a host-process capability unattended requires the explicit per-run grant above.
    if (!trusted && surface !== 'interactive' && impact === IMPACTS.WORKSPACE_PROCESS) return workbenchGranted;
    return true;
  }
  function authorize(call, tool) {
    const impact = impactOfTool(tool);
    const agentFullAccess = fullAccessNow();
    const unrestrictedHost = masterBypass || agentFullAccess;
    const trusted = ownerTrusted || masterBypass || agentFullAccess;
    if (impact === IMPACTS.PHYSICAL_INPUT || impact === IMPACTS.VISIBLE_DESKTOP) {
      if (unrestrictedHost) return { ok: true, impact, surface, isTask, isolated, masterBypass: masterBypass || undefined, fullAccess: agentFullAccess || undefined, unrestrictedHost: true };
      return remoteDesktopAuthorized
        ? { ok: true, impact, surface: 'interactive', isTask, isolated, ownerTrusted: true, remoteDesktopAuthorized: true }
        : { ok: false, impact, reason: impact + ' requires Full Power or an authenticated remote-owner desktop lease' };
    }
    if (impact === IMPACTS.EXTERNAL_UNKNOWN) {
      if (trusted) return { ok: true, impact, surface, isTask, isolated, ownerTrusted: ownerTrusted || undefined, masterBypass: masterBypass || undefined, fullAccess: agentFullAccess || undefined };
      // A granted routine calling one of the Commander's own connected MCP servers: the recorded per-routine
      // grant IS the approval, so this needs no live confirmation. Returned BEFORE the interactive-confirm
      // branch and deliberately WITHOUT oneShot, so the ordinary consent broker still runs for it downstream.
      if (surface !== 'interactive' && connectorAllowedUnattended(tool)) {
        return { ok: true, impact, surface, isTask, isolated };
      }
      if (surface !== 'interactive' && connectorDelegated(tool)) return connectorAuthority.authorize(call, tool);
      if (surface !== 'interactive' || !confirm) return { ok: false, impact, reason: 'unknown external effects require a watched, exact per-call confirmation' };
      /* A WATCHED call to one of the Commander's OWN connected MCP servers. Hand it to the consent broker —
         WITHOUT oneShot, so registry.dispatch runs the broker, which does the asking AND records the grade the
         Commander picked (once / always / full). The one-shot path below cannot: it collapses all four
         affirmative answers to a bare boolean, so "Always" and "Full access" bought nothing and every single
         call re-prompted. Live-caught 2026-07-27: a Shopify connector agent asked four times in a row for four
         `get_draft_asset` reads while the user kept clicking Full access. A prompt the Commander already
         answered "always" to, asked again, is not consent — it is a click-through trainer.

         The catch-all STAYS closed. This is narrowed by isConnectorTool (capability 'mcp:<id>') exactly like
         connectorAllowedUnattended above — a tool that merely FELL THROUGH to external-unknown because the
         host could not classify it is not a connector and keeps the exact per-call confirmation below. The
         broker is also strictly stronger than what it replaces: same live prompt on first use, same
         fail-closed timeout/abort, plus the hardline floor and a standing grant the Commander can SEE and
         revoke in the Permissions panel — which a one-shot answer never was. */
      if (isConnectorTool(tool)) return { ok: true, impact, surface, isTask, isolated };
      // Deliberately bypass the standing-grant broker: any affirmative UI choice authorizes
      // this call ONCE only. "Always", Full Access, and cached grants are not recorded here.
      return Promise.resolve(confirm(call, tool)).then(decision => {
        const allow = /^(?:once|session|always|full)$/i.test(String(decision || ''));
        return allow
          ? { ok: true, impact, surface, isTask, isolated, oneShot: true }
          : { ok: false, impact, reason: 'exact external-effect confirmation was denied' };
      }, () => ({ ok: false, impact, reason: 'exact external-effect confirmation failed' }));
    }
    // Cached grants and task text never turn an ASK-mode unattended run into authority over a host
    // process or the user's active media session. This gate runs before consent. Apart from Full Access or a host-minted
    // authenticated owner DM, the ONLY key that opens the host-process door unattended is the host-recorded
    // per-run grant above — see its comment for why that is not the same escape: it cannot be minted by
    // anything the model can influence.
    if (!trusted && surface !== 'interactive' && impact === IMPACTS.MEDIA_CONTROL) {
      return { ok: false, impact, reason: 'ASK-mode unattended runs cannot use ' + impact };
    }
    if (!trusted && surface !== 'interactive' && impact === IMPACTS.WORKSPACE_PROCESS && !workbenchGranted) {
      return { ok: false, impact, reason: 'ASK-mode unattended runs cannot use ' + impact + ' without an explicit per-routine terminal grant' };
    }
    return { ok: true, impact, surface, isTask, isolated, ownerTrusted: ownerTrusted || undefined, masterBypass: masterBypass || undefined, fullAccess: agentFullAccess || undefined, granted: (!trusted && impact === IMPACTS.WORKSPACE_PROCESS && surface !== 'interactive') || undefined };
  }
  return Object.freeze({
    mode: unrestrictedHostNow() ? 'full-power' : (remoteDesktopAuthorized ? 'remote-owner-desktop' : 'preserve-user-control'), surface, isTask, isolated, ownerTrusted, masterBypass, remoteDesktopAuthorized, project, authorize,
    fullAccess: fullAccessNow,
    unrestrictedHost: unrestrictedHostNow,
    unattendedGrants: Object.freeze(Array.from(unattendedGrants).sort())   // diagnostics/telemetry: what this run was actually granted
  });
}

function enforceRunAuthority(resolved, registry, authority) {
  resolved = resolved || {};
  const allowed = new Set();
  for (const name of (resolved.tools || [])) {
    const tool = registry && typeof registry.get === 'function' ? registry.get(name) : null;
    const projected = tool && authority && typeof authority.project === 'function'
      ? authority.project(tool) : false;
    if (projected === true) allowed.add(name);
  }
  const approvalRules = {};
  const networkCaps = {};
  for (const name of allowed) {
    if (resolved.approvalRules && resolved.approvalRules[name]) approvalRules[name] = resolved.approvalRules[name];
    if (resolved.networkCaps && resolved.networkCaps[name]) networkCaps[name] = resolved.networkCaps[name];
  }
  return Object.assign({}, resolved, {
    tools: (resolved.tools || []).filter(name => allowed.has(name)),
    grants: (resolved.grants || []).filter(g => g && allowed.has(g.tool)),
    approvalRules,
    networkCaps
  });
}

function enforceSyntheticOnly(resolved, remoteDesktopAuthorized) {
  resolved = resolved || {};
  if (remoteDesktopAuthorized === true) return Object.assign({}, resolved, {
    tools: (resolved.tools || []).slice(), grants: (resolved.grants || []).slice(),
    approvalRules: Object.assign({}, resolved.approvalRules || {}), networkCaps: Object.assign({}, resolved.networkCaps || {})
  });
  const approvalRules = Object.assign({}, resolved.approvalRules || {});
  const networkCaps = Object.assign({}, resolved.networkCaps || {});
  for (const tool of REAL_DESKTOP_TOOLS) {
    delete approvalRules[tool];
    delete networkCaps[tool];
  }
  return Object.assign({}, resolved, {
    tools: (resolved.tools || []).filter(t => !REAL_DESKTOP_TOOLS.has(t)),
    grants: (resolved.grants || []).filter(g => g && !REAL_DESKTOP_TOOLS.has(g.tool)),
    approvalRules,
    networkCaps
  });
}

/* Per-run toolsets are attenuation only: null preserves the station grant, while an explicit array
   intersects it. Compute and the two computer freebies are not toggleable tool families. */
function enforceEnabledToolsets(resolved, registry, enabledToolsets) {
  if (enabledToolsets == null) return resolved;
  const enabled = new Set(Array.isArray(enabledToolsets) ? enabledToolsets.map(String) : []);
  const free = new Set(['quest', 'toolsearch']);
  const allowed = new Set();
  for (const name of ((resolved && resolved.tools) || [])) {
    const tool = registry && typeof registry.get === 'function' ? registry.get(name) : null;
    const cap = String((tool && tool.capability) || '');
    const family = cap.indexOf('mcp:') === 0 ? 'connectors' : cap;
    if (free.has(family) || enabled.has(family)) allowed.add(name);
  }
  const approvalRules = {}, networkCaps = {};
  for (const name of allowed) {
    if (resolved.approvalRules && resolved.approvalRules[name]) approvalRules[name] = resolved.approvalRules[name];
    if (resolved.networkCaps && resolved.networkCaps[name]) networkCaps[name] = resolved.networkCaps[name];
  }
  return Object.assign({}, resolved, {
    tools: (resolved.tools || []).filter(n => allowed.has(n)),
    deferred: (resolved.deferred || []).filter(n => allowed.has(n)),
    grants: (resolved.grants || []).filter(g => g && allowed.has(g.tool)),
    approvalRules, networkCaps
  });
}

function runInputContext(surface, isTask, remoteDesktopAuthorized, unrestrictedHost) {
  const remote = remoteDesktopAuthorized === true;
  const fullPower = unrestrictedHost === true;
  return {
    surface: remote ? 'interactive' : (surface || 'autonomous'),
    isTask: !!isTask,
    unrestrictedHost: fullPower,
    physicalInputAuthorized: remote || fullPower,
    remoteDesktopAuthorized: remote,
    inputMode: fullPower ? 'full-power' : (remote ? 'remote-owner' : 'synthetic')
  };
}

// Bind browser.test_navigate to the URL the agent-owned background server actually
// advertised, not merely a requested command-line port (Vite may fall back 5173 -> 5174).
function backgroundOwnsLoopbackUrl(status, rawUrl) {
  if (!status || !status.running || status.killed) return false;
  let requested;
  try { requested = new URL(rawUrl); } catch (_) { return false; }
  const h = String(requested.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
  const requestedPort = Number(requested.port || (requested.protocol === 'https:' ? 443 : 80));
  const tail = String(status.tail || '').replace(/\x1b\[[0-9;]*m/g, '');
  const re = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?/ig;
  let m;
  while ((m = re.exec(tail))) {
    const endpointPort = Number(m[1] || (/^https:/i.test(m[0]) ? 443 : 80));
    if (endpointPort === requestedPort) return true;
  }
  return false;
}

function loopbackPort(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return 0;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch (_) { return 0; }
}

// OS-backed listener ownership: the process listening on the requested port must be the
// background handle's PID or one of its descendants. Every ambient dependency is injected.
function makeLoopbackListenerProbe(opts) {
  opts = opts || {};
  const run = opts.execFile, platform = opts.platform || process.platform, env = opts.env || process.env;
  return async function listenerOwned(status, rawUrl) {
    const port = loopbackPort(rawUrl), rootPid = Number(status && status.pid);
    if (typeof run !== 'function' || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(rootPid) || rootPid < 1) return false;
    let exe, args;
    if (platform === 'win32') {
      exe = env.SystemRoot ? env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
      const script = '$port=' + port + ';$root=' + rootPid + ';$parents=@{};Get-CimInstance Win32_Process|%{$parents[[uint32]$_.ProcessId]=[uint32]$_.ParentProcessId};$owners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue|Select-Object -ExpandProperty OwningProcess -Unique);if($owners.Count -eq 0){exit 3};foreach($owner in $owners){$owned=$false;$p=[uint32]$owner;for($i=0;$i -lt 128 -and $p -ne 0;$i++){if($p -eq $root){$owned=$true;break};if(-not $parents.ContainsKey($p)){break};$next=$parents[$p];if($next -eq $p){break};$p=$next};if(-not $owned){exit 3}};exit 0';
      args = ['-NoProfile', '-NonInteractive', '-Command', script];
    } else if (platform === 'linux' || platform === 'darwin') {
      exe = '/bin/sh';
      const script = 'owners="$(lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"; [ -n "$owners" ] || exit 3; for owner in $owners; do p="$owner"; i=0; owned=0; while [ "$p" -gt 0 ] 2>/dev/null && [ "$i" -lt 128 ]; do if [ "$p" = "$2" ]; then owned=1; break; fi; next="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")"; [ -n "$next" ] || break; [ "$next" = "$p" ] && break; p="$next"; i=$((i+1)); done; [ "$owned" = 1 ] || exit 3; done; exit 0';
      args = ['-c', script, 'starnet-listener-probe', String(port), String(rootPid)];
    } else return false;
    return new Promise(resolve => {
      try { run(exe, args, { windowsHide: true, timeout: 5000 }, err => resolve(!err)); }
      catch (_) { resolve(false); }
    });
  };
}

async function backgroundOwnsLocalUrl(status, rawUrl, listenerProbe) {
  if (!backgroundOwnsLoopbackUrl(status, rawUrl) || typeof listenerProbe !== 'function') return false;
  try { return await listenerProbe(status, rawUrl) === true; } catch (_) { return false; }
}

module.exports = { enforceSyntheticOnly, enforceRunAuthority, enforceEnabledToolsets, runInputContext, impactOfTool, makeRunAuthority, IMPACTS, backgroundOwnsLoopbackUrl, backgroundOwnsLocalUrl, makeLoopbackListenerProbe, REAL_DESKTOP_TOOLS, GRANTABLE_UNATTENDED, normalizeUnattendedGrants, isConnectorTool };
