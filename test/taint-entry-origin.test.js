/* node test/taint-entry-origin.test.js — the taint lock is scoped by RUN ORIGIN (sec-taint2 09-25).

   1. POLICY (taint.js postTaintBoundary): Full Access lifts the taint lock for an owner-typed run, never for a run
      whose ENTRY was untrusted third-party content (untrustedEntry).
   2. ORIGIN (run-origin.js entryUntrusted): host-minted on the run, or inherited through connectorAuthority.
   3. HUB: a line-trigger fire / forwarded message marks the entry run AND every hop of its line; an owner's own
      words mark nothing.
   4. WIRING: index.js feeds the verdict into both boundary calls and into delegated workers; every routine
      work-line hop (scheduled + Run Now) starts tainted as 'upstream agent output'.
   The behavioural end-to-end (a webhook fire on Full Access agents) is test/e2e.trigger-fullaccess-taint.test.js. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const taint = require('../sidecar/taint.js');
const { entryUntrusted, hostPowerWithheldFor } = require('../sidecar/run-origin.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

const root = path.resolve(__dirname, '..');
const SHELL = { name: 'shell.exec', capability: 'workbench', scope: 'execute' };
const FS_WRITE = { name: 'fs.write', capability: 'cabinet', scope: 'write' };
const MCP = { name: 'mcp__notes__write', capability: 'mcp:notes', scope: 'execute' };

// ---- 1. policy ----
{
  const owner = taint.postTaintBoundary(SHELL, { taintedBy: 'web_fetch', surface: 'autonomous', hasPrompt: false, fullAccess: true });
  A.eq(owner, { allow: true, needsConfirmation: false, oneShot: false }, 'an owner-typed tainted run on Full Access keeps the override');
  const trig = taint.postTaintBoundary(SHELL, { taintedBy: 'line trigger payload', surface: 'autonomous', hasPrompt: false, fullAccess: true, untrustedEntry: true });
  A.eq(trig, { allow: false, needsConfirmation: false, oneShot: false }, 'a payload-started run on Full Access loses the terminal while tainted');
  A.eq(taint.postTaintBoundary(MCP, { taintedBy: 'forwarded message', surface: 'autonomous', hasPrompt: false, fullAccess: true, untrustedEntry: true }).allow, false,
    'and loses connector calls');
  A.eq(taint.postTaintBoundary(SHELL, { taintedBy: 'forwarded message', surface: 'interactive', hasPrompt: true, fullAccess: true, untrustedEntry: true }),
    { allow: false, needsConfirmation: true, oneShot: false }, 'a WATCHED payload-started run falls back to the fresh one-call confirmation, not a silent allow');
  A.eq(taint.postTaintBoundary(FS_WRITE, { taintedBy: 'line trigger payload', surface: 'autonomous', hasPrompt: false, fullAccess: true, untrustedEntry: true }).allow, true,
    'jailed file work is untouched');
  A.eq(taint.postTaintBoundary(SHELL, { taintedBy: null, fullAccess: true, untrustedEntry: true }).allow, true, 'untrustedEntry alone (no taint) revokes nothing');
}

// ---- 2. origin ----
{
  A.eq(entryUntrusted(null), false, 'no run options -> not untrusted');
  A.eq(entryUntrusted({}), false, 'an ordinary run is owner-origin');
  A.eq(entryUntrusted({ untrustedEntry: true }), true, 'host-minted flag on the run');
  A.eq(entryUntrusted({ untrustedEntry: 'yes' }), false, 'only a literal true counts');
  A.eq(entryUntrusted({ connectorAuthority: { untrustedEntry: true } }), true, 'a delegated worker inherits it through connectorAuthority');
  A.eq(entryUntrusted({ initialTaint: 'line trigger payload' }), false, 'taint alone is not an origin verdict (owner app attachments keep the override)');
  A.eq(hostPowerWithheldFor({ untrustedEntry: true }), false, 'it does not withhold Full Power wholesale — only the taint override');
}

// ---- 3. hub propagation ----
function store() {
  const hist = new Map();
  return {
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord() { return undefined; }
  };
}
function hub(extra, runs) {
  let n = 0;
  return makeChannelHub(Object.assign({
    runOnce: async (o) => {
      runs.push({ agentId: o.agentId, initialTaint: o.initialTaint, untrustedEntry: o.untrustedEntry });
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'out of ' + o.agentId });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    },
    store: store(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm/x' }),
    classify: () => true, emit: () => {}, newId: () => 'r' + (++n),
    chain: { stopNote: () => '', advance: async (o) => {
      const a = await o.runAgent({ agentId: 'stage-two', text: 'PIPELINE HANDOFF — you are stage 2', signal: o.signal });
      return { hops: [{ agentId: 'stage-two' }], text: a.text, agentId: 'stage-two', stopped: null };
    } }
  }, extra || {}));
}
const msg = (text, extra) => Object.assign({ channel: 'telegram', chatId: '42', chatType: 'dm', userId: '42', text, messageId: String(Math.random()), ts: 1 }, extra || {});

(async () => {
  {
    const runs = [];
    await hub({ entryTaint: 'line trigger payload', bindChats: false }, runs).onInbound(msg('[Line trigger] body', { channel: 'trigger' }));
    A.eq(runs.length, 2, 'the trigger fire ran its entry dock and one hop');
    A.eq(runs[0].initialTaint, 'line trigger payload', 'entry starts tainted by the payload');
    A.eq(runs[0].untrustedEntry, true, 'the trigger ENTRY run is marked untrusted-origin');
    A.eq(runs[1].initialTaint, 'upstream agent output', 'the hop starts tainted as upstream output');
    A.eq(runs[1].untrustedEntry, true, 'the HOP of a payload-started line keeps the untrusted origin');
  }
  {
    const runs = [];
    await hub({}, runs).onInbound(msg('forward this', { forwarded: true }));
    A.eq(runs[0].untrustedEntry, true, 'a forwarded entry is untrusted-origin');
    A.eq(runs[1] && runs[1].untrustedEntry, true, '…and so is its hop');
  }
  {
    const runs = [];
    await hub({}, runs).onInbound(msg('please do the thing'));
    A.eq(runs[0].untrustedEntry, undefined, "the owner's own words are owner-origin");
    A.eq(runs[1] && runs[1].untrustedEntry, undefined, '…and its hop keeps the owner origin (tainted as upstream output, override intact)');
    A.eq(runs[1] && runs[1].initialTaint, 'upstream agent output', 'the owner-line hop is still tainted');
  }

  // ---- 4. wiring ----
  {
    const src = readSidecarSource();
    A.ok(/const untrustedEntryRun = entryUntrusted\(o\) \|\| recoverySourceEntryUntrusted\(o\);/.test(src), 'runOnce derives the origin verdict from host-minted options, or from the source run a continuation resumes');
    // crash + resume must not hand a trigger payload Full Access again: the verdict is journaled and read back
    A.ok(/runJournal\.begin\(\{[\s\S]{0,1200}?untrustedEntry: untrustedEntryRun === true/.test(src), 'the run journal records the untrusted-entry verdict');
    A.ok(/function recoverySourceEntryUntrusted\(o\) \{[\s\S]{0,400}?runJournal\.inspect\(sourceRunId\)[\s\S]{0,200}?st\.meta\.untrustedEntry === true[\s\S]{0,300}?return true;/.test(src),
      'a continuation reads its source journal and fails CLOSED (untrusted) when it cannot');
    A.eq((src.match(/fullAccess: stationBypassNow\(\) \|\| agentFullAccessNow\(\) \|\| connectorFullAccess, untrustedEntry: untrustedEntryRun/g) || []).length, 2,
      'BOTH post-taint boundary calls (first check + after the live prompt) carry the origin verdict');
    A.ok(/withholdHostPower: hostPowerWithheld,\s*\n\s*untrustedEntry: untrustedEntryRun,/.test(src), 'delegated workers inherit the origin verdict');
    A.ok(/entryTaint: hooks\.entryTaint \|\| 'line trigger payload',/.test(src), 'the trigger hub still taints its entry (a SEND TO hand-off names its own taint, never none)');
    // every chain hop the ROUTINE seams run (scheduled advanceChain + Run Now) starts tainted as upstream output
    const seams = src.split('runAgent: async (h) => {').slice(1);
    A.ok(seams.length >= 2, 'found the routine work-line hop seams (' + seams.length + ')');
    for (const s of seams) {
      const at = s.indexOf('initialTaint:');
      A.ok(at > 0 && /^initialTaint: 'upstream agent output'/.test(s.slice(at)), 'a routine work-line hop starts tainted as upstream agent output: ' + s.slice(at, at + 60));
    }
    const hubSrc = fs.readFileSync(path.join(root, 'sidecar', 'channels', 'hub.js'), 'utf8');
    A.eq((hubSrc.match(/untrustedEntry: lineEntryUntrusted \|\| undefined/g) || []).length, 2, 'the hub marks both the entry run and every hop');
  }

  A.report('taint-entry-origin.test');
})().catch(e => { console.error(e); process.exit(1); });
