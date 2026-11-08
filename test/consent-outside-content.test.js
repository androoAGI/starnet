/* node test/consent-outside-content.test.js — an approval after outside content never offers or confirms "Always".

   Customer report (Whop, 11-04..11-08, Gmail app-password card): "Every time an agent reads a different email, it asks
   for approval again, despite selecting 'Always allowed' each time." The report guessed the grant was keyed by message
   id. It is not: a connector grant is keyed by the connector and its read/write class (permissions.js dangerKey,
   'mcp:<connector>:read'), the same for every message. What asks again is the untrusted-content boundary (taint.js
   postTaintBoundary): once an email is in the chat, each later connector call needs a fresh human yes, and any yes there
   approves that one call. The card still offered Always ("Always stops asking for … from now on"), and the station
   echoed "always allowed". The boundary is unchanged here; what changes is that every surface says what it does:
   the prompt carries outsideContent, the card offers Approve once / Full access / Deny with one line saying why, voice
   asks for approve or deny, and the station echoes an Always or Session answer there as once. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
const { readSidecarSource, sidecarFunctionSource } = require('./helpers/source');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const part = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('slice ' + a); return s.slice(i, j); };

(async () => {
  /* ---- the verdict on the report: the read grant is per connector, never per message; the boundary is one call ---- */
  {
    const { dangerKey } = require('../sidecar/permissions.js');
    const { makeMcpToolDef } = require('../sidecar/mcp/translate.js');
    const gmail = require('../sidecar/mcp/transport.gmail-imap.js');
    const tools = (gmail.TOOLS || []);
    const readTool = tools.find(t => t.name === 'read_message');
    if (readTool) {
      const def = makeMcpToolDef({ connectorId: 'gmail-app-password', mcpTool: readTool, call: async () => ({}) });
      A.eq(dangerKey(def), 'mcp:gmail-app-password:read', 'reading any message is one grant class for the account: no message id in the key');
    } else {
      A.ok(/tool\('read_message'/.test(read('sidecar/mcp/transport.gmail-imap.js')), 'the Gmail read tool exists');
    }
    const taint = require('../sidecar/taint.js');
    const connectorRead = { name: 'mcp__gmail__read_message', capability: 'mcp:gmail-app-password', scope: 'read', impact: 'external-unknown' };
    const ask = taint.postTaintBoundary(connectorRead, { taintedBy: 'mcp__gmail__read_message', surface: 'interactive', hasPrompt: true });
    A.ok(ask.needsConfirmation && !ask.allow, 'after an email is in the chat, the next Gmail read asks (the boundary is unchanged)');
    const always = taint.postTaintBoundary(connectorRead, { taintedBy: 'mcp__gmail__read_message', surface: 'interactive', hasPrompt: true, decision: 'always' });
    A.ok(always.allow && always.oneShot, 'and any yes there is one call');
    const unattended = taint.postTaintBoundary(connectorRead, { taintedBy: 'mcp__gmail__read_message', surface: 'autonomous', hasPrompt: false });
    A.ok(!unattended.allow && !unattended.needsConfirmation, 'an unattended tainted run is still refused');
  }

  /* ---- the station marks the post-taint ask and echoes a standing answer there as once ---- */
  {
    const src = readSidecarSource();
    const promptSrc = part(src, '  function promptConsent(call, tool, ask) {', '\n  }\n') + '\n  }\n';
    const seen = [];
    const ctx = vm.createContext({ askHuman: (fields) => { seen.push(fields); return 'asked'; }, consentSummary: () => 'sum', consentArgsFull: () => null, streamId: 's1' });
    vm.runInContext(promptSrc + '\n;this.promptConsent = promptConsent;', ctx);
    const plain = { scope: 'read', capability: 'mcp:gmail-app-password' };
    ctx.promptConsent({ name: 'mcp__gmail__read_message', args: {} }, plain, { outsideContent: true });
    ctx.promptConsent({ name: 'mcp__gmail__read_message', args: {} }, plain);
    ctx.promptConsent({ name: 'station.power', args: {} }, { scope: 'write', freshConsent: true }, { outsideContent: true });
    A.eq(seen.map(f => f.outsideContent), [true, false, false], 'only a post-taint ask is marked, and never a fresh-consent card (it already offers once only)');
    A.eq(seen.map(f => f.fresh), [false, false, true], 'the fresh-consent mark is unchanged');

    const ask = sidecarFunctionSource('askHuman');
    A.ok(/if \(fields && fields\.outsideContent === true\) row\.outsideContent = true;[^\n]*\n\s*say\('permission\.prompt', row\);/.test(ask), 'the permission.prompt row carries outsideContent to every surface (desk, phone, terminal)');
    A.ok(/if \(orig && fields && fields\.outsideContent === true\) orig\.outsideContent = true;/.test(ask), 'and the answer slot knows it');
    A.ok(/prompt: typeof prompt === 'function' \? \(call, tool, ask\) => signal\?\.aborted \? 'deny' : prompt\(call, tool, ask\) : null,/.test(src), 'a delegated worker\'s post-taint ask is marked too');

    const handle = sidecarFunctionSource('handleConsent');
    A.ok(handle.length > 200 && handle.length < 8000, 'handleConsent sliced');
    async function answer(decision, finishFlags) {
      let got = null, persistedFor = null, body = null;
      const finish = Object.assign(d => { got = d; }, finishFlags || {});
      const ctx2 = vm.createContext({
        JSON, Object,
        readBody: async () => JSON.stringify({ runId: 'r1', promptId: 'p1', decision }),
        pendingByRun: new Map([['r1', new Map([['p1', finish]])]]), channelPendingByRun: new Map(),
        runTable: new Map([['r1', { agentId: 'agent' }]]),
        persistAgentFullAccess: id => { persistedFor = id; return true; }
      });
      vm.runInContext(handle + '\n;this.handleConsent = handleConsent;', ctx2);
      const res = { writeHead() {}, end(t) { body = JSON.parse(t); } };
      await ctx2.handleConsent({}, res);
      return { got, persistedFor, body };
    }
    const a = await answer('always', { outsideContent: true });
    A.eq([a.got, a.body.decision], ['once', 'once'], 'Always on a post-taint ask is applied and echoed as once: no surface says "always allowed"');
    const s = await answer('session', { outsideContent: true });
    A.eq(s.got, 'once', 'Session there is once too');
    const f = await answer('full', { outsideContent: true });
    A.eq([f.got, f.persistedFor], ['full', 'agent'], 'Full access keeps its meaning (the agent\'s standing posture, which the boundary reads)');
    const d = await answer('deny', { outsideContent: true });
    A.eq(d.got, 'deny', 'a No is a No');
    const plainAlways = await answer('always', {});
    A.eq(plainAlways.got, 'always', 'an ordinary ask still records Always');
    const fresh = await answer('full', { freshConsent: true });
    A.eq([fresh.got, fresh.persistedFor], ['once', null], 'a fresh-consent card is unchanged: any yes is once and nothing is persisted');
  }

  /* ---- the desk card and voice offer only what the station will do ---- */
  {
    const chat = read('frontend/app/chat.js');
    const branches = part(chat, "    if (p.tool === 'browser.login') {", "    appendConsentDetails(r.body, p, 'plan');");
    const card = part(branches, '} else if (p.outsideContent === true) {', "} else if (p.tool === 'station.power'");
    A.ok(/mk\('Approve once', 'once'/.test(card) && /mk\('Full access', 'full'/.test(card) && /mk\('Deny', 'deny'/.test(card), 'the post-taint card offers Approve once, Full access and Deny');
    A.ok(!/mk\('Always'/.test(card) && !/consentHintFor\(/.test(card), 'and never Always, nor the line that teaches Always');
    A.ok(/outside content/.test(card) && /Always cannot skip that/.test(card), 'it says in one line why it asks each time');
    A.ok(branches.indexOf('} else if (p.outsideContent === true) {') < branches.lastIndexOf('    } else {'), 'it is a branch before the default card');
    const voice = read('frontend/app/voice-live.js');
    A.ok(/ONCE_ONLY\.has\(p\.tool\) \|\| p\.workerAgentId \|\| p\.outsideContent === true \? '\. Say approve or deny\.'/.test(voice), 'voice asks for approve or deny');
    A.ok(/const onceOnly = decision === 'always' && \(ONCE_ONLY\.has\(pending\.tool\) \|\| pending\.outsideContent === true\);/.test(voice), 'and a spoken "always allow" there is approved once, said as once');
    A.eq(read('website/app/app/chat.js') === chat && read('website/app/app/voice-live.js') === voice, true, 'the website copy carries the same card');
  }

  A.report('consent-outside-content.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
