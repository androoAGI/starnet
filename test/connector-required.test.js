/* node test/connector-required.test.js — beginner seam Lane 1: "connector_required" at the moment of need.

   1) SIDECAR: a tool call against a connector that is not wired STILL throws the historic
      'connector "<id>" is not connected' error (the model needs the text), and ALSO emits a structured
      connector_required {runId, connectorId, kind, reason, toolName} on the run's own emit (ctx.emit) —
      validated against the frozen shared/events.js contract. Both the unknown-id and the known-but-down
      paths fire it; a healthy call fires nothing. The ctx rides through makeMcpToolDef's run(args, ctx).
   2) FRONTEND: Friendly.connectorDoor(ev) builds the post-run chip ("⇄ CONNECT GMAIL — 2 clicks") whose
      run() opens ABILITIES on the CATALOG section and pre-fills the console search with the connector id
      (the existing "what are you trying to connect?" router window), re-asserting the filter until the
      async catalog has rendered a card.
   3) chat.js SEAM (source lock — chat.js is DOM flow and not require-able): the bus listener is wired at
      init, the chip is offered from the run-end branch ONLY on a clean end, through the same choices()
      row offerRetry uses (one post-run layer), and the listener's catch is never bare. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');
const { makeMcpToolDef } = require('../sidecar/mcp/translate.js');

function stack(opts) {
  opts = opts || {};
  return {
    makeTransport: () => ({ send() {}, onMessage() {}, close() {} }),
    makeClient: () => ({
      initialize: () => opts.failInit ? Promise.reject(new Error('server down')) : Promise.resolve({}),
      listTools: () => Promise.resolve([{ name: 'send_email' }]),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'sent' }] }),
      close() {}
    })
  };
}
function ctxFor(runId) {
  const emitted = [];
  return { runId, emit: (name, payload) => emitted.push({ name, payload }), emitted };
}

(async () => {
  // ---------- 1a. unknown connector id: throw + event ----------
  {
    const m = makeConnectorManager(Object.assign({ makeToolDef: makeMcpToolDef, timeoutMs: 1000 }, stack()));
    const ctx = ctxFor('run-1');
    let err = null;
    try { await m.call('gmail', 'send_email', { to: 'x' }, ctx); } catch (e) { err = e; }
    A.ok(err && /connector "gmail" is not connected/.test(err.message), 'the historic not-connected error still throws');
    A.eq(ctx.emitted.length, 1, 'exactly one event rides the run emit');
    const ev = ctx.emitted[0];
    A.eq(ev.name, 'connector_required', 'event name');
    A.eq(ev.payload, { runId: 'run-1', connectorId: 'gmail', kind: 'mcp', reason: 'connector "gmail" is not connected', toolName: 'send_email' }, 'structured payload');
    const v = events.validate(ev.name, ev.payload);
    A.ok(v.ok, 'payload validates against shared/events.js: ' + JSON.stringify(v.errors || []));
  }
  // ---------- 1b. known connector whose server is DOWN: same event through the tool def's run(args, ctx) ----------
  {
    const seen = [];
    const m = makeConnectorManager(Object.assign({ makeToolDef: makeMcpToolDef, timeoutMs: 1000, onEvent: e => seen.push(e) }, stack({ failInit: true })));
    const r = await m.configure('gmail', { transport: 'http', url: 'https://mcp.example/gmail' });
    A.eq(r.ok, false, 'connector configured but its server refused to start');
    const ctx = ctxFor('run-2');
    let err = null;
    try { await m.call('gmail', 'send_email', {}, ctx); } catch (e) { err = e; }
    A.ok(err && /not connected/.test(err.message), 'down connector throws not-connected');
    A.eq(ctx.emitted.map(e => e.name), ['connector_required'], 'down connector emits connector_required on the run');
    A.eq(ctx.emitted[0].payload.runId, 'run-2', 'runId comes from the dispatch ctx');
    A.ok(seen.some(e => e.type === 'connector_required' && e.connectorId === 'gmail'), 'the host onEvent sees it too (boot log line)');
  }
  // ---------- 1c. the tool def threads ctx into the manager; a healthy call emits NOTHING ----------
  {
    const m = makeConnectorManager(Object.assign({ makeToolDef: makeMcpToolDef, timeoutMs: 1000 }, stack()));
    const r = await m.configure('gmail', { transport: 'http', url: 'https://mcp.example/gmail' });
    A.eq(r.ok, true, 'healthy connector is up');
    const defs = m.toolDefsFor('gmail');
    const def = defs.find(d => /send_email/.test(d.name));
    A.ok(def, 'the projected tool def exists');
    const ctx = ctxFor('run-3');
    const res = await def.run({ to: 'x' }, ctx);
    A.ok(/sent/.test(res.content), 'healthy call returns the server result');
    A.eq(ctx.emitted.length, 0, 'a healthy call emits no connector_required');
    // no ctx at all (a caller outside a run) still throws cleanly and never crashes on the missing emit
    let err = null;
    try { await m.call('nope', 'x', {}); } catch (e) { err = e; }
    A.ok(err && /not connected/.test(err.message), 'ctx-less caller still gets the throw');
    // the catch around the emit is NOT fail-open: a throwing emit still yields the same error, with the loss pinned on it
    const bad = { runId: 'run-4', emit: () => { throw new Error('bus dead'); } };
    err = null;
    try { await m.call('nope', 'x', {}, bad); } catch (e) { err = e; }
    A.ok(err && /not connected/.test(err.message), 'a throwing emit never changes the error the model sees');
    A.eq(err.telemetryLost, ['emit: bus dead'], 'the lost event is pinned on the error (the catch fires, and says so)');
  }
  // ---------- 1d. the ratchet: the emit sites are try-wrapped but NEVER a bare silent promise catch ----------
  {
    const src = fs.readFileSync(path.join(__dirname, '../sidecar/mcp/manager.js'), 'utf8');
    const body = A.fnBody(src, 'function notConnected(');
    A.ok(body.length > 50 && body.length < 2000, 'notConnected helper is present and bounded');
    A.ok(/ctx\.emit\('connector_required'/.test(body), 'the helper emits connector_required on the run ctx');
    A.ok(/onEvent\(Object\.assign\(\{ type: 'connector_required' \}/.test(body), 'the helper reports to the host onEvent');
    A.ok(!/\.catch\(/.test(body), 'no promise .catch in the helper (sync try/catch only — nothing to swallow)');
  }

  // ---------- 1e. suggestFor: the beginner case — NOTHING wired, no tool call, the GOAL names the connector ----------
  {
    const { makeConnectorTools } = require('../sidecar/tools/builtin/connectors.js');
    const catalog = require('../sidecar/mcp/catalog.js');   // the REAL catalog (gmail's aliases include "email")
    const withRows = rows => makeConnectorTools({ connectors: { list: () => rows }, connectorCatalog: catalog, keysCatalog: null, keysOf: () => [] });
    // gmail NOT connected -> suggested + the same connector_required event on the run ctx
    {
      const t = withRows([]);
      const sg = t.suggestFor('send my newsletter to subscribers');
      A.eq(sg[0] && sg[0].id, 'gmail', 'newsletter goal suggests gmail FIRST (outranks the aggregators): ' + JSON.stringify(sg));
      A.ok(sg.length <= 3, 'at most 3 suggestions');
      A.eq(sg.find(x => x.id === 'gmail').reason, 'needed for: send my newsletter to subscribers', 'reason names the goal');
      const ctx = ctxFor('run-5');
      const r = await t.listTool.run({ goal: 'send my newsletter to subscribers', scope: 'available' }, ctx);
      A.ok(/SUGGESTED for "send my newsletter to subscribers"/.test(r.content) && /- gmail/.test(r.content), 'tool result leads with SUGGESTED gmail');
      const ev = ctx.emitted.find(e => e.name === 'connector_required' && e.payload.connectorId === 'gmail');
      A.ok(ev, 'connector_required fired for gmail from connectors.list');
      A.eq(ev.payload, { runId: 'run-5', connectorId: 'gmail', kind: 'mcp', reason: 'needed for: send my newsletter to subscribers', toolName: 'connectors.list' }, 'same event shape as the manager path');
      A.ok(events.validate('connector_required', ev.payload).ok, 'validates against shared/events.js');
      A.ok(/suggested:\d/.test(r.summary), 'summary counts the suggestions');
    }
    // gmail CONNECTED (up) -> not suggested, no event
    {
      const t = withRows([{ id: 'gmail', label: 'Gmail', state: 'up', enabled: true, toolCount: 3 }]);
      const sg = t.suggestFor('send my newsletter to subscribers');
      A.ok(!sg.some(x => x.id === 'gmail'), 'a connected gmail is never suggested: ' + JSON.stringify(sg));
      const ctx = ctxFor('run-6');
      await t.listTool.run({ goal: 'send my newsletter to subscribers', scope: 'available' }, ctx);
      A.ok(!ctx.emitted.some(e => e.name === 'connector_required' && e.payload.connectorId === 'gmail'), 'no gmail event when gmail is up');
    }
    // a configured-but-DEAD gmail still counts as not connected (the host read-back, not the config)
    {
      const t = withRows([{ id: 'gmail', label: 'Gmail', state: 'error', enabled: true, toolCount: 0 }]);
      A.ok(t.suggestFor('email my notes to myself').some(x => x.id === 'gmail'), 'a dead gmail is still suggested');
    }
    // no goal / no topic -> nothing, and no event; a throwing emit is reported in the result, not swallowed
    {
      const t = withRows([]);
      A.eq(t.suggestFor('summarize this pdf'), [], 'no topic -> no suggestion');
      const ctx = ctxFor('run-7');
      await t.listTool.run({ scope: 'available' }, ctx);
      A.eq(ctx.emitted.length, 0, 'no goal -> no event');
      const bad = { runId: 'run-8', emit: () => { throw new Error('bus dead'); } };
      const r = await t.listTool.run({ goal: 'email my notes to myself', scope: 'available' }, bad);
      A.ok(/could not be raised for: gmail: bus dead/.test(r.content), 'a lost emit is named in the result (catch fires, says so)');
    }
    // a card whose sign-in is DISABLED in this build is not a door: no chip event, and the model is told not to
    // send the Commander to sign in (first-hour walk 2026-09-28: "sign in with Google, no setup" beside a disabled button)
    {
      const reason = 'Google sign-in is not available in this build.';
      const t = makeConnectorTools({ connectors: { list: () => [] }, connectorCatalog: catalog, keysCatalog: null,
        signInUnavailable: e => (e && e.googleApi ? reason : '') });
      const sg = t.suggestFor('send my newsletter to subscribers');
      A.eq(sg.find(x => x.id === 'gmail').unavailable, reason, 'the suggestion carries the card\'s own unavailable reason');
      const ctx = ctxFor('run-9');
      const r = await t.listTool.run({ goal: 'send my newsletter to subscribers', scope: 'available' }, ctx);
      A.ok(!ctx.emitted.some(e => e.name === 'connector_required' && e.payload.connectorId === 'gmail'), 'no CONNECT chip for a disabled sign-in');
      A.ok(/CANNOT BE CONNECTED IN THIS BUILD/.test(r.content) && /- gmail — Google sign-in is not available in this build\./.test(r.content), 'the model is told gmail cannot be connected, with the reason');
      A.ok(/never tell them to sign in/.test(r.content), 'the model is told not to send the Commander to sign in');
      // blocked cards must not take the 3 slots from connectable ones (review nit 2026-09-28)
      const allBlocked = makeConnectorTools({ connectors: { list: () => [] }, connectorCatalog: catalog,
        signInUnavailable: e => (e && e.id !== 'composio' ? 'off in this build' : '') });
      const slots = allBlocked.suggestFor('send my newsletter to subscribers');
      A.ok(slots.some(x => x.id === 'composio' && !x.unavailable), 'a connectable fit still gets a slot when higher-scored cards are blocked: ' + JSON.stringify(slots.map(x => x.id)));
      A.ok(slots.filter(x => !x.unavailable).length <= 3 && slots.filter(x => x.unavailable).length <= 3, 'at most 3 connectable + 3 blocked');
      const listed = await t.listTool.run({ query: 'gmail', scope: 'available' }, ctxFor('run-10'));
      A.ok(/Gmail \[[^\]]*\] — connector, sign-in — SIGN-IN NOT AVAILABLE in this build/.test(listed.content), 'the AVAILABLE list marks the disabled card too');
      A.ok(ctx.emitted.some(e => e.name === 'connector_required' && e.payload.connectorId !== 'gmail') || !/SUGGESTED for/.test(r.content) || /SUGGESTED \(0\)/.test(r.content), 'connectable suggestions still raise their chip');
      const thrower = makeConnectorTools({ connectors: { list: () => [] }, connectorCatalog: catalog, signInUnavailable: () => { throw new Error('boom'); } });
      A.eq(thrower.suggestFor('send my newsletter to subscribers')[0].unavailable, '', 'a throwing availability probe fails open to the old behavior');
    }
    // every ABILITIES path the agent quotes names a tab or section the window actually draws (the walk found "KEYS tab",
    // "ABILITIES › CONNECTORS" and "ABILITIES › KEYS" — doors renamed away long ago, still quoted to users)
    {
      const win = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/connectors.js'), 'utf8');
      const labels = new Set((win.match(/label: '([^']+)'/g) || []).map(m => m.slice(8, -1)));
      (win.match(/data-ab-to="[a-z]+">([^<]+)</g) || []).forEach(m => labels.add(m.replace(/^.*">/, '').replace(/<$/, '')));
      const files = ['sidecar/manual.js', 'sidecar/harness-import.js', 'sidecar/index.js', 'sidecar/tools/builtin/connectors.js', 'frontend/app/marketplace.js'];
      const bad = [];
      for (const f of files) {
        const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        // segments are the window's UPPERCASE labels; prose after a label ("… is where …") must not join the path
        for (const m of text.match(/ABILITIES(?: › [A-Z][A-Z0-9 /&]*[A-Z0-9])+/g) || []) {
          m.split(' › ').slice(1).forEach(seg => { if (!labels.has(seg.trim())) bad.push(f + ': ' + m + ' (' + seg + ')'); });
        }
        text.split('\n').forEach((line, i) => {
          const code = line.trim();
          if (/^(\/\/|\/\*|\*)/.test(code)) return;   // internal comments may keep the old nickname
          if (/['"`][^'"`]*KEYS tab/.test(line)) bad.push(f + ':' + (i + 1) + ' quotes the retired "KEYS tab"');
        });
      }
      A.eq(bad, [], 'every quoted ABILITIES door exists in the ABILITIES window');
    }
    // the lead is TOLD to call it before declining (system-prompt guidance)
    const manual = fs.readFileSync(path.join(__dirname, '../sidecar/manual.js'), 'utf8');
    A.ok(/BEFORE DECLINING a task for lack of email, website, calendar, docs/.test(manual) && /connectors\.list/.test(manual), 'manual tells the lead to call connectors.list {goal} before declining');
  }

  // ---------- 2. the chip door (friendlyerror.js is require-able) ----------
  {
    const Friendly = require('../frontend/app/friendlyerror.js');
    A.eq(Friendly.connectorChipLabel({ connectorId: 'gmail' }), '⇄ CONNECT GMAIL', 'chip label does not promise unverified setup effort');
    A.eq(Friendly.connectorChipLabel({ connectorId: 'google-calendar' }), '⇄ CONNECT GOOGLE CALENDAR', 'dashes read as spaces');
    A.eq(Friendly.connectorDoor({}), null, 'no connector id -> no chip (never an empty door)');
    const door = Friendly.connectorDoor({ runId: 'r', connectorId: 'gmail', kind: 'mcp', reason: 'x', toolName: 'send_email' });
    A.eq(door.connectorId, 'gmail', 'door names its connector');
    // run(): opens the ABILITIES window on CATALOG and pre-fills the console search
    const opened = [];
    const inputEvents = [];
    const input = { value: '', dispatchEvent: e => inputEvents.push(e.type) };
    const list = { closest: () => ({ querySelector: sel => sel === '.con-search-in' ? input : null }), querySelector: sel => sel === '.cc-card' ? {} : null };
    const timers = [];
    global.StationUI = { openTerm: (k, s) => opened.push([k, s]) };
    global.document = { querySelector: sel => sel === '#cc-list' ? list : null, defaultView: { Event: function (type) { this.type = type; } } };
    try {
      A.eq(door.run(), true, 'run() reports it opened the door');
      A.eq(opened, [['connectors', 'catalog']], 'opens ABILITIES on the CATALOG section (the router window)');
      A.eq(input.value, 'gmail', 'console search pre-filled with the connector id');
      A.eq(inputEvents, ['input'], 'search filter fired once a card exists');
      // catalog not rendered yet: the filter re-arms on a timer until a card appears (bounded)
      const listEmpty = { closest: list.closest, querySelector: () => null };
      global.document.querySelector = sel => sel === '#cc-list' ? listEmpty : null;
      Friendly.routeConsoleSearch(global.document, 'gmail', (fn, ms) => timers.push({ fn, ms }));
      A.eq(timers.length, 1, 'no card yet -> one re-assert timer armed');
      A.eq(timers[0].ms, 250, 'poll cadence');
      for (let i = 0; i < 20 && timers.length; i++) { const t = timers.shift(); t.fn(); }
      A.ok(timers.length === 0, 'the re-assert loop is bounded (stops without a card)');
    } finally { delete global.StationUI; delete global.document; }
    // no StationUI at all (a test/headless context) -> false, never a throw
    A.eq(door.run(), false, 'run() without StationUI is a clean false');
  }

  // ---------- 3. chat.js seam (source lock) ----------
  {
    const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
    const wire = A.fnBody(src, 'function wireConnectorRequired(');
    A.ok(wire.length > 50 && wire.length < 1500, 'wireConnectorRequired exists and is bounded');
    A.ok(/U\.bus\.on\('connector_required'/.test(wire), 'chat subscribes to connector_required on U.bus');
    A.ok(!/\.catch\(/.test(wire) && !/catch\s*\(\s*_?\w*\s*\)\s*\{\s*\}/.test(wire), 'the listener has no bare catch');
    A.ok(/wireConnectorRequired\(\);/.test(src), 'the listener is wired at init');
    const offer = A.fnBody(src, 'function offerConnectorDoor(');
    A.ok(offer.length > 50 && offer.length < 1500, 'offerConnectorDoor exists and is bounded');
    A.ok(/Friendly\.connectorDoor\(ev\)/.test(offer), 'the chip comes from Friendly.connectorDoor (one door source)');
    A.ok(/choices\(\[\{ label: door\.label, value: 'connect' \}\], \(\) => door\.run\(\)\)/.test(offer), 'rendered through the shared choices() row (one post-run layer)');
    A.ok(/CONNECTOR_NEEDED\.delete\(runId\)/.test(offer), 'the pending event is consumed once offered');
    // offered from the run-end branch, on a CLEAN end only (a stopped run owns the slot with its retry chip)
    A.ok(/if \(!taskQuestion && \(!endReason \|\| endReason === 'done'\)\) offerConnectorDoor\(thisRunId, ws\);/.test(src),
      'stored on the originating stream at clean run end, including background streams');
    const callAt = src.indexOf('offerConnectorDoor(thisRunId, ws)');
    const stopAt = src.indexOf("if (endReason === 'budget') offerBudgetDoor(budgetCapIsBalance); else offerTryAgain();");
    A.ok(stopAt > 0 && callAt > stopAt, 'the connect offer sits AFTER the stop-reason branch in the same run-end block');
    // A run that ends on a TASK_QUESTION owns the slot, but connectors.list already told the model the chip exists
    // (first-hour walk 2026-09-28: the agent said "tap the ⇄ CONNECT chip" three times and none was drawn).
    A.ok(/if \(taskQuestion \|\| endReason === 'clarifying'\) holdConnectorDoor\(thisRunId, ws\);/.test(src), 'a question-ending run (parsed, or restored from the store) still records the connector handoff');
    // …held as awaitingAnswer: CONTINUE TASK sends a continuation prompt that send() would record as the question's ANSWER
    const cont = A.fnBody(src, 'async function continueConnectorTask(');
    const guardAt = cont.indexOf('if (h.awaitingAnswer)'), sendAt = cont.indexOf('await send(');
    A.ok(guardAt > 0 && sendAt > guardAt && /App\.openWorkstream\(streamId\);[\s\S]{0,200}return false;/.test(cont.slice(guardAt, sendAt)), 'continueConnectorTask returns to the open question instead of answering it');
    const winSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/connectors.js'), 'utf8');
    A.ok(/const supported = !h\.awaitingAnswer && /.test(winSrc) && /btn\.textContent = h\.awaitingAnswer \? 'RETURN TO TASK'/.test(winSrc), 'ABILITIES offers RETURN TO TASK, never CONTINUE TASK, while the question is open');
    {
      const W = require('../frontend/app/workstreams.js');
      W.reset();
      const g = W.all()[0];
      W.setConnectorHandoff(g.id, { connectorId: 'composio', runId: 'r9', agentId: g.agentId || 'agent', awaitingAnswer: true });
      const plain = W.setConnectorHandoff(g.id, { connectorId: 'composio', runId: 'r9', agentId: g.agentId || 'agent' });
      A.ok(plain && !('awaitingAnswer' in plain), 'an ordinary handoff keeps its exact old shape');
      const held = W.setConnectorHandoff(g.id, { connectorId: 'composio', runId: 'r9', agentId: g.agentId || 'agent', awaitingAnswer: true });
      A.eq(held && held.awaitingAnswer, true, 'the awaiting-answer mark survives normalization (and so persistence)');
      W.reset();
    }
    const tqFn = A.fnBody(src, 'function offerTaskQuestion(');
    A.eq((tqFn.match(/taskQuestionDoor\((?:r|q)\.body, tq\.runId\)/g) || []).length, 2, 'both task-question cards (chips and conversation) carry the door');
    // a FORK's chips take the same slot and replaced the connect chip live (2026-09-28: composio door lost) — it carries the door too
    A.ok(/taskQuestionDoor\(q\.body, runId\)/.test(A.fnBody(src, 'function offerFork(')), 'the FORK card carries the door');
    A.ok(/offerFork\(fk, thisRunId\)/.test(src) && /presentTaskQuestion\(ws, Object\.assign\(\{ runId: thisRunId \}, taskQuestion\)\)/.test(src), 'fresh question cards are scoped to their own run');
    // behavior: hold records the handoff once; the door renders inside the given card and opens the connect screen
    const vm = require('node:vm');
    const hold = A.fnBody(src, 'function holdConnectorDoor(');
    const door = A.fnBody(src, 'function taskQuestionDoor(');
    const handoffs = {}, opened = [];
    const made = [];
    const ctx = {
      CONNECTOR_NEEDED: new Map([['run-1', { runId: 'run-1', connectorId: 'gmail', kind: 'mcp' }]]),
      activeWs: { id: 'ws-1', agentId: 'agent' }, persisted: 0,
      App: { persist() { ctx.persisted++; } },
      Workstreams: { setConnectorHandoff(id, h) { handoffs[id] = h; }, connectorHandoff(id) { return handoffs[id] || null; } },
      Friendly: { connectorDoor(h) { return { label: '⇄ CONNECT ' + h.connectorId.toUpperCase(), run() { opened.push(h.connectorId); return true; } }; } },
      document: { createElement() { const el = { children: [] }; made.push(el); return el; } }
    };
    vm.createContext(ctx);
    vm.runInContext(hold + '\n' + door + '\nthis.held = holdConnectorDoor("run-1", activeWs); this.again = holdConnectorDoor("run-1", activeWs);', ctx);
    A.eq(ctx.held, true, 'hold records the pending connector'); A.eq(ctx.again, false, 'the pending event is consumed once');
    A.eq(handoffs['ws-1'] && handoffs['ws-1'].connectorId, 'gmail', 'the handoff lands on the originating stream'); A.eq(ctx.persisted, 1, 'the handoff is persisted');
    A.eq(handoffs['ws-1'].awaitingAnswer, true, 'a held handoff is marked as waiting on the question\'s answer');
    const card = { kids: [], appendChild(el) { this.kids.push(el); } };
    ctx.card = card;
    vm.runInContext('this.btn = taskQuestionDoor(card);', ctx);
    A.ok(ctx.btn && card.kids[0] === ctx.btn, 'the door is appended inside the question card, not as a second row');
    A.eq(ctx.btn.textContent, '⇄ CONNECT GMAIL', 'the door names the connector');
    ctx.btn.onclick();
    A.eq(opened.join(), 'gmail', 'tapping the door opens the connect screen for that connector');
    vm.runInContext('this.other = taskQuestionDoor(card, "run-2"); this.same = taskQuestionDoor(card, "run-1");', ctx);
    A.eq(ctx.other, null, 'an older run\'s handoff never rides on a later run\'s question card');
    A.ok(ctx.same && ctx.same.textContent === '⇄ CONNECT GMAIL', 'the run that raised the connector gets its door');
    delete handoffs['ws-1'];
    vm.runInContext('this.none = taskQuestionDoor(card);', ctx);
    A.eq(ctx.none, null, 'no handoff, no door');
  }
  A.report('connector-required.test');
})().catch(e => { console.error(e); process.exit(1); });
