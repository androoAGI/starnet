/* node test/consentwait.test.js — EL-11 FIX 1c: the extendable fail-closed consent waiter.

   THE ESCAPE: a live permission.prompt on a NON-displayed session was invisible (no global surface) and the
   sidecar auto-DENIED it at CONSENT_TIMEOUT_MS — a timeout deny on a prompt nobody ever saw is a consent
   violation. The timeout exists to protect UNATTENDED runs (no browser, telegram silence, dead tab) from
   hanging open forever — that intent must survive.

   The fix: sidecar/consentwait.js — the waiter behind askHuman. Same fail-closed contract as before
   (timeout → deny, abort → deny, settle exactly once), PLUS a one-shot bounded `extend()` that only the
   browser can trigger (POST /api/consent/ack) AFTER it has actually rendered the prompt to a human
   (active consent card OR the new background toast + rail marker). No ack ⇒ the old 120s deny is
   byte-identical, so unattended surfaces are untouched. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeConsentWait } = require('../sidecar/consentwait.js');

// deterministic fake timer bed — we control the clock, no real waiting.
function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
    pendingCount() { return timers.size; }
  };
}
function makeSignal() {
  const ls = [];
  return {
    aborted: false,
    addEventListener(_n, fn) { ls.push(fn); },
    removeEventListener() {},
    abort() { this.aborted = true; ls.forEach(fn => fn()); }
  };
}

async function settled(p) { let v, done = false; p.then(x => { v = x; done = true; }); await Promise.resolve(); return { v, done }; }

(async () => {
  // 1) UNATTENDED PATH UNCHANGED: no ack → auto-deny at exactly timeoutMs (fail-closed floor intact).
  {
    const clock = makeClock(), pending = new Map(), emitted = [];
    const wait = makeConsentWait({
      pending, signal: makeSignal(), timeoutMs: 120000, extendMs: 600000,
      uuid: () => 'p1', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock),
      emitPrompt: (id) => emitted.push(id)
    });
    const p = wait.ask();
    A.eq(emitted, ['p1'], 'unattended: permission.prompt emitted');
    A.ok(pending.has('p1'), 'unattended: finisher registered under promptId');
    clock.advance(119999);
    A.ok(!(await settled(p)).done, 'unattended: still pending just before the timeout');
    clock.advance(1);
    const r = await settled(p);
    A.ok(r.done, 'unattended: settled at timeoutMs');
    A.eq(r.v, 'deny', 'unattended: auto-DENY (fail-closed) with no ack — old behavior byte-identical');
    A.ok(!pending.has('p1'), 'unattended: finisher cleaned up');
  }

  // 2) INTERACTIVE PATH: an ack (prompt provably rendered to a human) extends the deny deadline ONCE,
  //    bounded by extendMs — never indefinite, so an AFK human still fail-closes eventually.
  {
    const clock = makeClock(), pending = new Map();
    const wait = makeConsentWait({
      pending, signal: makeSignal(), timeoutMs: 120000, extendMs: 600000,
      uuid: () => 'p2', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock),
      emitPrompt: () => {}
    });
    const p = wait.ask();
    const fin = pending.get('p2');
    A.ok(typeof fin === 'function' && typeof fin.extend === 'function', 'interactive: finisher carries extend()');
    A.eq(fin.extend(), true, 'interactive: first ack extends');
    clock.advance(120000);
    A.ok(!(await settled(p)).done, 'interactive: survives the original 120s deadline after ack');
    A.eq(fin.extend(), false, 'interactive: second ack is a no-op (one-shot, bounded)');
    clock.advance(600000);
    const r = await settled(p);
    A.ok(r.done && r.v === 'deny', 'interactive: STILL fail-closes at the extended bound — never indefinite');
  }

  // 3) a real human answer resolves and clears the timer (with or without a prior ack).
  {
    const clock = makeClock(), pending = new Map();
    const wait = makeConsentWait({
      pending, signal: makeSignal(), timeoutMs: 120000, extendMs: 600000,
      uuid: () => 'p3', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock),
      emitPrompt: () => {}
    });
    const p = wait.ask();
    pending.get('p3').extend();
    pending.get('p3')('always');
    const r = await settled(p);
    A.ok(r.done && r.v === 'always', 'answer resolves the decision');
    A.eq(clock.pendingCount(), 0, 'answer clears the timer (no leak)');
    A.ok(!pending.has('p3'), 'answer cleans up the finisher');
  }

  // 4) DISCONNECT still denies INSTANTLY, even after an ack — abort trumps any extension.
  {
    const clock = makeClock(), pending = new Map(), sig = makeSignal();
    const wait = makeConsentWait({
      pending, signal: sig, timeoutMs: 120000, extendMs: 600000,
      uuid: () => 'p4', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock),
      emitPrompt: () => {}
    });
    const p = wait.ask();
    pending.get('p4').extend();
    sig.abort();
    const r = await settled(p);
    A.ok(r.done && r.v === 'deny', 'abort after ack: instant deny (disconnect always fail-closes)');
  }

  // 5) already-aborted signal denies immediately (mirror of the old askHuman guard).
  {
    const clock = makeClock(), pending = new Map(), sig = makeSignal(); sig.aborted = true;
    const wait = makeConsentWait({
      pending, signal: sig, timeoutMs: 120000, extendMs: 600000,
      uuid: () => 'p5', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock),
      emitPrompt: () => {}
    });
    const r = await settled(wait.ask());
    A.ok(r.done && r.v === 'deny', 'pre-aborted signal: immediate deny');
  }

  // 6) settle-exactly-once: a late timeout fire after an answer must not double-resolve or throw.
  {
    const clock = makeClock(), pending = new Map();
    const wait = makeConsentWait({
      pending, signal: makeSignal(), timeoutMs: 1000, extendMs: 5000,
      uuid: () => 'p6', setTimeoutFn: (fn) => { fn._late = fn; return 9; }, clearTimeoutFn: () => {},
      emitPrompt: () => {}
    });
    const p = wait.ask();
    const fin = pending.get('p6');
    fin('once');
    A.notThrows(() => fin('deny'), 'second settle is a swallowed no-op');
    const r = await settled(p);
    A.eq(r.v, 'once', 'first settle wins');
  }

  // 7) a prompt nobody answered (timeout) or whose run dropped (abort) tells its surfaces — onAutoDeny — so the desk card
  //    and the CREW "needs your OK" frame stop asking; an ANSWER never fires it (sweep 2026-10-02)
  {
    const clock = makeClock(), pending = new Map(), denied = [], why = [];
    const mk = (id, sig) => makeConsentWait({ pending, signal: sig || makeSignal(), timeoutMs: 1000, extendMs: 5000, uuid: () => id,
      setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock), emitPrompt: () => {}, onAutoDeny: (pid, expired) => { denied.push(pid); why.push(expired); } });
    const pt = mk('t1').ask(); clock.advance(1000);
    A.eq([(await settled(pt)).v, denied], ['deny', ['t1']], 'a timed-out prompt denies AND announces it');
    const sig = makeSignal(); const pa = mk('a1', sig).ask(); sig.abort();
    A.eq([(await settled(pa)).v, denied], ['deny', ['t1', 'a1']], 'a dropped run denies AND announces it');
    const po = mk('o1').ask(); pending.get('o1')('once'); clock.advance(5000);
    A.eq([(await settled(po)).v, denied], ['once', ['t1', 'a1']], 'an answered prompt never announces an auto-deny');
    // the announcer is told which it was: a timeout (nobody answered) or an abort (the asker stopped) — a background
    // worker's stopped ask must not read "no answer in time" (index.js askHuman)
    A.eq(why, [true, false], 'onAutoDeny says whether the prompt expired (true) or its run was stopped (false)');
  }

  // 2026-10-11 TIMEOUT IS NOT A NO: a channel approval nobody answered used to resolve exactly like a tapped ❌ Deny, so
  // the agent told the user "you declined". A caller can ask for its own timeout word + hear about the expiry; an abort
  // stays a plain deny; the broker maps the word to a still-CLOSED result and the tool result says "timed out".
  {
    const clock = makeClock(), pending = new Map(), heard = [];
    const wait = makeConsentWait({
      pending, signal: makeSignal(), timeoutMs: 1000, extendMs: 5000, timeoutDecision: 'timeout', onTimeout: id => heard.push(id),
      uuid: () => 'pt', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock), emitPrompt: () => {}
    });
    const p = wait.ask();
    clock.advance(1000);
    A.eq((await settled(p)).v, 'timeout', 'an unanswered prompt settles with the caller\'s timeout word');
    A.eq(heard, ['pt'], 'and the caller hears about the expiry (the channel is told)');
    const sig = makeSignal(), heard2 = [];
    const wait2 = makeConsentWait({
      pending: new Map(), signal: sig, timeoutMs: 1000, extendMs: 5000, timeoutDecision: 'timeout', onTimeout: id => heard2.push(id),
      uuid: () => 'pa', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock), emitPrompt: () => {}
    });
    const p2 = wait2.ask();
    sig.abort();
    A.eq([(await settled(p2)).v, heard2.length], ['deny', 0], 'an abort is still a plain deny, never announced as a timeout');
    const { makeConsentBroker } = require('../sidecar/permissions.js');
    const broker = makeConsentBroker({ surface: 'interactive' });
    const g = broker.grant('timeout', { name: 'fs_write' }, { scope: 'write', capability: 'cabinet' });
    A.ok(g.allow === false && g.timedOut === true, 'the broker keeps a timeout CLOSED but marks it timed out');
    const { makeRegistry } = require('../sidecar/tools/registry.js');
    const reg = makeRegistry();
    reg.register({ name: 'fs_write', requiresConsent: true, scope: 'write', capability: 'cabinet', schema: { type: 'object' }, run: async () => 'wrote' });
    const r = await reg.dispatch({ name: 'fs_write', args: {}, id: 'c1' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', consent: async () => g });
    A.ok(/approval timed out for fs_write/.test(r.content) && /not a refusal/i.test(r.content) && !/consent denied/.test(r.content), 'the model reads "timed out", never "denied": ' + r.content);
    A.eq(r.summary, 'denied', 'still a terminal non-run (the loop never routes around it)');
    /* the Commander's own No reads as theirs, said to them (rc walk 10-14: "consent denied for team.dispatch: denied" came
       back to the Commander as "The Commander declined the dispatch" — they ARE the Commander) */
    const no = broker.grant('deny', { name: 'team_dispatch' }, { scope: 'execute', capability: 'orchestrator' });
    A.ok(no.allow === false && no.reason === 'denied', 'a Deny on the card is the broker\'s "denied"');
    let ran = false;
    reg.register({ name: 'team_dispatch', requiresConsent: true, scope: 'execute', capability: 'orchestrator', schema: { type: 'object' }, run: async () => { ran = true; return 'ran'; } });
    const d = await reg.dispatch({ name: 'team_dispatch', args: {}, id: 'c2' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', consent: async () => no });
    A.ok(!ran && d.summary === 'denied', 'a denied call never runs and stays terminal');
    A.ok(/^consent denied for team_dispatch: the Commander said no on the approval card, so it was NOT run\./.test(d.content), 'it says who said no: ' + d.content);
    A.ok(/If you mention it, say it to them as "you" \("you declined …"\)\./.test(d.content) && !/the Commander declined/i.test(d.content), 'and how to say it to them (second person), never planting the third-person words: ' + d.content);
    const other = await reg.dispatch({ name: 'team_dispatch', args: {}, id: 'c3' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', consent: async () => ({ allow: false, reason: 'no consent channel — interactive prompt not wired' }) });
    A.ok(/consent denied for team_dispatch: no consent channel/.test(other.content) && !/said no/.test(other.content), 'a refusal nobody gave keeps its own reason (never "the Commander said no")');
  }

  /* A WITHDRAWN ASK IS NOT A NO (review 10-14): an ask whose run stopped (abort) or that was never shown resolves with the
     caller's abortDecision; the capability consent passes 'cancelled', the broker keeps it CLOSED but withdrawn, and the
     model reads "withdrawn — nobody said no", never "the Commander said no" (a worker would tell them "you declined"). */
  {
    const clock = makeClock(), sig = makeSignal(), pending = new Map();
    const wait = makeConsentWait({ pending, signal: sig, timeoutMs: 1000, extendMs: 5000, timeoutDecision: 'timeout', abortDecision: 'cancelled',
      uuid: () => 'pc', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock), emitPrompt: () => {} });
    const p = wait.ask();
    A.eq(pending.get('pc').abortDecision, 'cancelled', 'the finisher carries its withdrawn word (the host teardown answers with it)');
    sig.abort();
    A.eq((await settled(p)).v, 'cancelled', 'an abort settles with the withdrawn word of the caller');
    const shut = makeSignal(); shut.abort();
    const never = makeConsentWait({ pending: new Map(), signal: shut, timeoutMs: 1000, extendMs: 5000, abortDecision: 'cancelled',
      uuid: () => 'pn', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock), emitPrompt: () => {} }).ask();
    A.eq((await settled(never)).v, 'cancelled', 'a prompt never shown is withdrawn too');
    const plain = makeConsentWait({ pending: new Map(), signal: shut, timeoutMs: 1000, extendMs: 5000,
      uuid: () => 'pp', setTimeoutFn: clock.setTimeout.bind(clock), clearTimeoutFn: clock.clearTimeout.bind(clock), emitPrompt: () => {} }).ask();
    A.eq((await settled(plain)).v, 'deny', 'no abortDecision = a plain deny (path.trust, browser.login, brief.ask read any other word as "not refused")');
    const { makeConsentBroker } = require('../sidecar/permissions.js');
    const broker = makeConsentBroker({ surface: 'interactive' });
    for (const tool of [{ scope: 'write', capability: 'cabinet' }, { scope: 'write', capability: 'station', freshConsent: true }]) {
      const g = broker.grant('cancelled', { name: 'fs_write' }, tool);
      A.ok(g.allow === false && g.cancelled === true && g.reason !== 'denied', 'the broker keeps a withdrawn ask CLOSED, never "denied"' + (tool.freshConsent ? ' (fresh-consent tool too)' : ''));
    }
    const { makeRegistry } = require('../sidecar/tools/registry.js');
    const reg = makeRegistry();
    let ran = false;
    reg.register({ name: 'fs_write', requiresConsent: true, scope: 'write', capability: 'cabinet', schema: { type: 'object' }, run: async () => { ran = true; return 'wrote'; } });
    const r = await reg.dispatch({ name: 'fs_write', args: {}, id: 'c9' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', consent: async () => broker.grant('cancelled', { name: 'fs_write' }, { scope: 'write', capability: 'cabinet' }) });
    A.ok(!ran && /^approval withdrawn for fs_write: the request ended before anyone answered it, so it was NOT run\. Nobody said no/.test(r.content) && !/declined|said no on/.test(r.content), 'the model reads "withdrawn", never a No: ' + r.content);
    A.eq(r.summary, 'cancelled', 'a terminal non-run (loop terminalHumanDecision), not counted as a denial');
    const host = readSidecarSource();
    A.ok(/\{ timeoutDecision: 'timeout', abortDecision: 'cancelled' \}\);/.test(host) && /timeoutDecision: opts && opts\.timeoutDecision, abortDecision: opts && opts\.abortDecision,/.test(host), 'the capability consent asks with the withdrawn word');
    A.ok(/try \{ f\(\(f && f\.abortDecision\) \|\| 'deny'\); \}/.test(host), 'the run teardown answers each open ask with its own withdrawn word');
    A.ok(/=== 'cancelled'\) \{\s*return \{ ok: false, isError: true, summary: 'cancelled',/.test(host), 'and a withdrawn post-taint confirmation never reads as the taint lock');
    const gs = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sidecar', 'group-sessions.js'), 'utf8');
    // (the stop also marks the ask as settled by the stop, so the transcript retires its card as unanswered: group-stop-truth)
    A.ok(/const onAbort = \(\) => \{ stoppedFirst = true; finish\('cancelled'\); \};/.test(gs), 'a stopped group turn withdraws its ask the same way');
  }

  A.report('consentwait');
})();
