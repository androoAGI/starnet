/* node test/channels.buttons.test.js — inline keyboards end to end (C6).

   Covers the three things a "full Telegram experience" needs and the fallbacks that keep every other channel
   unchanged:
     · prompts.js — the bounded token→meaning registry + the callback_data codec (64-byte cap, single-use,
       oldest-first eviction, cross-chat rejection).
     · multiple-choice — a TASK_QUESTION reply ships a keyboard; a tap re-enters as the option's OWN text
       (identical to typing it); a typed "2" coerces to the same canonical text.
     · approve/deny — a chat that opted in runs surface:'interactive' with a live prompt; a tap resolves the
       REAL consentwait waiter; an expired tap is reported honestly instead of silently swallowed.
   Plus the regression guard that matters most: a hub with NO button deps renders exactly the old numbered text.

   Fakes are transport-level only (send/answerCallback/editMessage). The consent waiter is the REAL
   sidecar/consentwait.js — the same module index.js wires — so the fail-closed timing under test is production's. */
'use strict';
const A = require('./_assert.js');
const { makeChannelHub, coerceChoice, menuCommands, helpText, COMMANDS, parseCommand } = require('../sidecar/channels/hub.js');
const { makePromptRegistry, MAX_CALLBACK_BYTES } = require('../sidecar/channels/prompts.js');
const { makeConsentWait } = require('../sidecar/consentwait.js');
const { TaskIntent } = require('../frontend/app/fork.js');

function fakeStore(recs) {
  const hist = new Map(), records = new Map(Object.entries(recs || {}));
  return {
    hist, records,
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord(c) { return records.get(String(c)); },
    saveChatRecord(c, patch) { const m = Object.assign({}, records.get(String(c)), patch); records.set(String(c), m); return m; }
  };
}
const idGen = (p) => { let i = 0; return () => (p || 'id') + (++i); };
const dm = (text, chatId) => ({ channel: 'telegram', chatId: chatId || '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });
async function waitFor(pred, ticks) {
  for (let i = 0; i < (ticks || 300); i++) { if (pred()) return; await new Promise(r => setTimeout(r, 0)); }
  throw new Error('waitFor: predicate never became true');
}
// pull the keyboard off whatever the hub last sent with one
function lastKeyboard(sends) {
  for (let i = sends.length - 1; i >= 0; i--) if (sends[i].opts && sends[i].opts.reply_markup) return sends[i].opts.reply_markup.inline_keyboard;
  return null;
}

async function run() {
  // =========================================================================================================
  // PART 1 — prompts.js: the registry and the codec
  // =========================================================================================================

  // ---- 1A. codec round-trip, and every button stays under Telegram's 64-BYTE callback_data cap ----
  {
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const e = reg.create({ kind: 'choice', chatId: '555', options: ['staging', 'production'] });
    A.ok(!!e && !!e.token, 'create returns an entry carrying a token');
    const d0 = reg.data(e.token, 0);
    A.eq(reg.parse(d0), { kind: 'choice', token: e.token, idx: 0 }, 'callback_data round-trips to {kind,token,idx}');
    // the whole point of the token indirection: a 4000-char option must not widen callback_data at all.
    const big = reg.create({ kind: 'choice', chatId: '555', options: ['x'.repeat(4000), 'y'.repeat(4000)] });
    const dBig = reg.data(big.token, 1);
    A.ok(Buffer.byteLength(dBig, 'utf8') <= MAX_CALLBACK_BYTES, 'callback_data stays under the 64-byte cap regardless of option length');
    A.ok(Buffer.byteLength(dBig, 'utf8') < 20, 'callback_data is actually tiny (token indirection, not truncation)');
  }

  // ---- 1B. SINGLE-USE: a second tap on the same button finds nothing (no double-resolve) ----
  {
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const e = reg.create({ kind: 'choice', chatId: '555', options: ['a', 'b'] });
    A.ok(!!reg.take(e.token), 'first take resolves');
    A.eq(reg.take(e.token), null, 'second take on the same token finds nothing — a double-tap cannot re-run a decision');
  }

  // ---- 1C. concurrent prompts never cross-resolve (the reference harness resolves FIFO and gets this wrong) ----
  {
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const first = reg.create({ kind: 'consent', chatId: '555', options: [{ label: 'ok', value: 'once' }], meta: { promptId: 'P1' } });
    const second = reg.create({ kind: 'consent', chatId: '555', options: [{ label: 'ok', value: 'once' }], meta: { promptId: 'P2' } });
    const got = reg.take(second.token);
    A.eq(got.meta.promptId, 'P2', 'tapping the SECOND prompt resolves the second — never the queue head');
    A.eq(reg.take(first.token).meta.promptId, 'P1', 'the first prompt is still independently resolvable');
  }

  // ---- 1D. bounded: an ignored keyboard costs one slot, then the oldest is evicted (no unbounded leak) ----
  {
    const reg = makePromptRegistry({ newId: idGen('tok'), max: 3 });
    const kept = [];
    for (let i = 0; i < 5; i++) kept.push(reg.create({ kind: 'choice', chatId: 'c' + i, options: ['a', 'b'] }));
    A.eq(reg.size(), 3, 'registry never grows past max');
    A.eq(reg.take(kept[0].token), null, 'the oldest entry was evicted');
    A.ok(!!reg.take(kept[4].token), 'the newest entry survived its own insert');
  }

  // ---- 1E. junk / hostile callback_data is refused, never thrown on ----
  {
    const reg = makePromptRegistry({ newId: idGen('tok') });
    for (const bad of [null, '', 'nope', 'q:tok1', 'q:tok1:2:3', 'z:tok1:0', 'q:tok 1:0', 'q:tok1:abc', 'q:' + 'x'.repeat(80) + ':0']) {
      A.eq(reg.parse(bad), null, 'malformed callback_data "' + String(bad) + '" parses to null');
    }
  }

  // ---- 1F. peekChat/dropChat are chat-scoped ----
  {
    const reg = makePromptRegistry({ newId: idGen('tok') });
    reg.create({ kind: 'choice', chatId: 'A', options: ['a', 'b'] });
    const newest = reg.create({ kind: 'choice', chatId: 'A', options: ['c', 'd'] });
    reg.create({ kind: 'choice', chatId: 'B', options: ['e', 'f'] });
    A.eq(reg.peekChat('A', 'choice').token, newest.token, 'peekChat returns the NEWEST prompt for that chat');
    A.eq(reg.dropChat('A', 'choice'), 2, 'dropChat retires only that chat/kind');
    A.eq(reg.peekChat('A', 'choice'), null, 'chat A has no live choice left');
    A.ok(!!reg.peekChat('B', 'choice'), 'chat B is untouched');
  }

  // =========================================================================================================
  // PART 2 — coerceChoice: typing and tapping must produce the IDENTICAL canonical answer
  // =========================================================================================================
  {
    const opts = [{ value: 'staging' }, { value: 'production' }, { value: 'a local dry run' }];
    A.eq(coerceChoice(opts, '2'), 'production', 'a bare number picks by position');
    A.eq(coerceChoice(opts, '2.'), 'production', 'trailing dot tolerated');
    A.eq(coerceChoice(opts, ' 3) '), 'a local dry run', 'trailing paren + whitespace tolerated');
    A.eq(coerceChoice(opts, 'PRODUCTION'), 'production', 'exact option text matches case-insensitively, canonicalised');
    A.eq(coerceChoice(opts, '9'), null, 'an out-of-range number is NOT an answer');
    A.eq(coerceChoice(opts, 'use your judgment'), null, 'free text passes through as a new instruction, never silently re-read as a pick');
    A.eq(coerceChoice(opts, ''), null, 'empty is not an answer');
    A.eq(coerceChoice(null, '1'), null, 'no options -> no coercion, no throw');
  }

  // =========================================================================================================
  // PART 3 — the command menu is SYNCED with what the hub actually implements
  // =========================================================================================================
  {
    const menu = menuCommands();
    A.ok(menu.length >= 4, 'a non-trivial menu is published');
    for (const c of menu) {
      // Telegram rejects setMyCommands outright if any name breaks this grammar — an invalid entry would mean
      // NO menu at all, silently.
      A.ok(/^[a-z0-9_]{1,32}$/.test(c.command), 'menu command /' + c.command + ' matches Telegram\'s name grammar');
      A.ok(!!c.description && c.description.length <= 256, 'menu command /' + c.command + ' has a bounded description');
      // the sync that matters: everything Telegram offers must actually be handled by the parser.
      A.ok(!!parseCommand('/' + c.command), 'menu command /' + c.command + ' is accepted by parseCommand');
    }
    const help = helpText();
    for (const c of COMMANDS) A.ok(help.indexOf('/' + c.command) !== -1, '/help lists /' + c.command);
    A.ok(!!parseCommand('/approvals@mybot on'), '/approvals tolerates the @botname suffix Telegram adds in groups');
  }

  // =========================================================================================================
  // PART 4 — multiple choice
  // =========================================================================================================

  // ---- 4A. REGRESSION GUARD: a hub with no button deps renders the OLD numbered text, no keyboard ----
  {
    const sends = []; const store = fakeStore();
    const runOnce = async (o) => {
      o.emit('agent.token', { delta: 'TASK_QUESTION: Which target? || staging | production' });
      o.emit('agent.run.end', { reason: 'clarifying' });
    };
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, taskIntent: TaskIntent,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('deploy it'));
    A.eq(lastKeyboard(sends), null, 'no button deps -> no reply_markup (every other channel is byte-identical)');
    A.ok(/1\. staging/.test(sends[0].t) && /2\. production/.test(sends[0].t), 'numbered options still rendered in the body');
    A.ok(/Reply with a choice/.test(sends[0].t), 'and still asks for a typed reply, since typing is the only way to answer');
  }

  // ---- 4B. a TASK_QUESTION ships a keyboard; the FULL text stays in the body; the tap re-enters as that text ----
  {
    const sends = [], acks = [], edits = []; const store = fakeStore();
    const runs = [];
    const runOnce = async (o) => {
      runs.push(o);
      if (runs.length === 1) {
        o.emit('agent.token', { delta: 'TASK_QUESTION: Which deployment target? || staging | production' });
        o.emit('agent.run.end', { reason: 'clarifying' });
      } else {
        o.emit('agent.token', { delta: 'Deploying.' });
        o.emit('agent.run.end', { reason: 'done' });
      }
    };
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, taskIntent: TaskIntent, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'msg7' }); },
      answerCallback: (id, text) => { acks.push({ id, text }); return Promise.resolve({ ok: true }); },
      editMessage: (c, m, t) => { edits.push({ c, m, t }); return Promise.resolve({ ok: true }); },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('deploy it'));

    const kb = lastKeyboard(sends);
    A.ok(!!kb, 'a TASK_QUESTION reply ships an inline keyboard');
    A.eq(kb.length, 2, 'one button per option');
    A.eq(kb[0].length, 1, 'one button per ROW (a vertical list stays readable on a phone)');
    A.eq(kb[0][0].text, '1. staging', 'button label is the short numbered echo');
    A.ok(/1\. staging/.test(sends[0].t) && /2\. production/.test(sends[0].t), 'the FULL option text still rides in the message body');
    A.ok(/Tap a choice below/.test(sends[0].t), 'copy offers the buttons now that they exist');

    // TAP the second button
    const data = kb[1][0].callback_data;
    await hub.onCallback({ chatId: '555', userId: 'u1', data, callbackId: 'cb1', messageId: 'msg7' });
    await waitFor(() => runs.length === 2);

    A.eq(acks.length, 1, 'the tap is acknowledged (otherwise Telegram spins the button and then errors)');
    A.ok(/production/.test(acks[0].text), 'the ack toast names the choice');
    A.eq(edits.length, 1, 'the original message is edited in place');
    A.ok(/▸ production/.test(edits[0].t), 'the edit stamps the chosen option');
    A.eq(edits[0].m, 'msg7', 'it edits the message the keyboard was actually attached to');
    A.eq(runs[1].messages[runs[1].messages.length - 1], { role: 'user', content: 'production' },
      'the tap re-enters the run as the option\'s OWN text — identical to the Commander typing it');
    A.ok(store.hist.get('tg_555').some(m => m.role === 'user' && m.content === 'production'),
      'and it is persisted to the transcript like any other user turn');

    // a SECOND tap on the same (now spent) button must not run anything again
    const before = runs.length;
    await hub.onCallback({ chatId: '555', userId: 'u1', data, callbackId: 'cb2', messageId: 'msg7' });
    A.eq(acks.length, 2, 'the stale tap is still acknowledged');
    A.ok(/no longer open/i.test(acks[1].text), 'and is honestly reported as closed');
    A.eq(runs.length, before, 'a double-tap never starts a second run');
  }

  // ---- 4C. a TYPED "2" resolves to the same canonical option text the button would have produced ----
  {
    const sends = []; const store = fakeStore(); const runs = [];
    const runOnce = async (o) => {
      runs.push(o);
      if (runs.length === 1) { o.emit('agent.token', { delta: 'TASK_QUESTION: Which target? || staging | production' }); o.emit('agent.run.end', { reason: 'clarifying' }); }
      else { o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); }
    };
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, taskIntent: TaskIntent, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('deploy it'));
    await hub.onInbound(dm('2'));
    A.eq(runs[1].messages[runs[1].messages.length - 1], { role: 'user', content: 'production' },
      'a typed "2" reaches the model as "production", not as a bare "2" it has to guess at');
  }

  // ---- 4D. an unrelated reply is NOT swallowed as an answer ----
  {
    const store = fakeStore(); const runs = [];
    const runOnce = async (o) => {
      runs.push(o);
      if (runs.length === 1) { o.emit('agent.token', { delta: 'TASK_QUESTION: Which target? || staging | production' }); o.emit('agent.run.end', { reason: 'clarifying' }); }
      else { o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); }
    };
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, taskIntent: TaskIntent, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: () => Promise.resolve({ ok: true, messageId: 'm1' }),
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('deploy it'));
    await hub.onInbound(dm('actually, cancel that'));
    A.eq(runs[1].messages[runs[1].messages.length - 1], { role: 'user', content: 'actually, cancel that' },
      'a change of mind reaches the model verbatim, never rewritten into an option');
  }

  // =========================================================================================================
  // PART 5 — approve / deny
  // =========================================================================================================

  // A fake host consent channel with the SAME contract index.js provides — and the REAL consentwait module, so
  // the fail-closed timing under test is production's, not a stand-in.
  function makeHostConsent(timeoutMs) {
    const byRun = new Map();
    return {
      byRun,
      ask(o) {
        let pend = byRun.get(String(o.runId));
        if (!pend) { pend = new Map(); byRun.set(String(o.runId), pend); }
        const fields = { tool: (o.call && o.call.name) || 'tool', scope: (o.tool && o.tool.scope) || 'write', argsSummary: 'path=notes.md' };
        return makeConsentWait({
          pending: pend, signal: o.signal, timeoutMs: timeoutMs || 50, extendMs: 100,
          uuid: idGen('prompt'),
          emitPrompt: (promptId) => { try { o.onPrompt(promptId, fields); } catch (_) {} }
        }).ask();
      },
      resolve(runId, promptId, decision) {
        const pend = byRun.get(String(runId));
        const finish = pend && pend.get(String(promptId));
        if (!finish) return false;
        finish(decision);
        return true;
      }
    };
  }

  // ---- 5A. DEFAULT OFF: a chat that never opted in is byte-identical to today (autonomous, no prompt) ----
  {
    const store = fakeStore(); let lastRun = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); };
    const host = makeHostConsent();
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: () => Promise.resolve({ ok: true, messageId: 'm1' }),
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('write a file'));
    A.eq(lastRun.surface, 'autonomous', 'no opt-in -> the safe autonomous floor, exactly as before');
    A.eq(lastRun.prompt, undefined, 'and no live consent channel is offered');
  }

  // ---- 5B. /approvals on persists, and is honest about the trade ----
  {
    const sends = []; const store = fakeStore();
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce: async () => {}, store, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      askConsent: () => Promise.resolve('deny'), resolveConsent: () => true,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('/approvals'));
    A.ok(/OFF/.test(sends[0]), 'status reads OFF by default');
    await hub.onInbound(dm('/approvals on'));
    A.eq(store.records.get('555').approvals, true, 'the opt-in is persisted to the chat record');
    A.ok(/denied and the run moves on/.test(sends[1]), 'turning it ON states the downside (an unanswered prompt denies), not just the upside');
    await hub.onInbound(dm('/approvals off'));
    A.eq(store.records.get('555').approvals, false, 'and it can be turned back off');
  }

  // ---- 5C. opted in: the run goes interactive, the ask renders a keyboard, and a tap resolves it ----
  {
    const sends = [], acks = [], edits = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    let lastRun = null, decision = null;
    const host = makeHostConsent(5000);
    const runOnce = async (o) => {
      lastRun = o;
      decision = await o.prompt({ name: 'fs.write', args: { path: 'notes.md' } }, { scope: 'write' });
      o.emit('agent.token', { delta: 'wrote it' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'consent-msg' }); },
      answerCallback: (id, text) => { acks.push({ id, text }); return Promise.resolve({ ok: true }); },
      editMessage: (c, m, t) => { edits.push({ c, m, t }); return Promise.resolve({ ok: true }); },
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    const inflight = hub.onInbound(dm('write notes.md'));

    // wait for the keyboard to be fully REGISTERED (sent AND stitched to its message id) — that is the state a
    // human can actually tap in, since the message only reaches the phone after the send resolves.
    await waitFor(() => { const e = reg.peekChat('555', 'consent'); return !!(e && e.messageId); });
    A.eq(lastRun.surface, 'interactive', 'an opted-in chat runs interactive so the broker can pause and ask');
    const kb = lastKeyboard(sends);
    A.eq(kb.length, 4, 'four decisions offered');
    A.eq(kb.map(r => r[0].text), ['✅ Allow once', '✅ Allow for this session', '♾️ Always allow', '❌ Deny'], 'the buttons are the broker\'s own vocabulary');
    const promptText = sends.find(s => s.opts && s.opts.reply_markup).t;
    A.ok(/fs\.write/.test(promptText), 'the ask names the tool');
    A.ok(/denied and the run moves on/.test(promptText), 'and states what silence means');

    // tap "Always allow"
    await hub.onCallback({ chatId: '555', userId: 'u1', data: kb[2][0].callback_data, callbackId: 'cb9', messageId: 'consent-msg' });
    await inflight;
    A.eq(decision, 'always', 'the tap resolves the REAL waiter with the decision the button carried');
    A.ok(/Always allow/.test(acks[0].text), 'the tap is acknowledged with the decision');
    A.ok(/▸ ♾️ Always allow/.test(edits[0].t), 'the consent message is stamped and its buttons stripped');
    A.eq(sends[sends.length - 1].t, 'wrote it', 'the run continued and delivered its reply');
  }

  // ---- 5D. FAIL-CLOSED: an unanswered ask denies on schedule and the run still finishes ----
  {
    const sends = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    let decision = null;
    const host = makeHostConsent(20);   // real consentwait timer, 20ms
    const runOnce = async (o) => {
      decision = await o.prompt({ name: 'fs.write', args: { path: 'notes.md' } }, { scope: 'write' });
      o.emit('agent.token', { delta: 'could not write' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('write notes.md'));
    A.eq(decision, 'deny', 'silence auto-denies (fail-closed) — a forgotten prompt never holds a billable run open');
    A.eq(sends[sends.length - 1].t, 'could not write', 'and the run still completes and replies');
  }

  // ---- 5D2. (2026-10-11) an EXPIRED approval is said out loud, and is not a "no" -------------------------------
  // The host's channelAskConsent now asks the waiter for timeoutDecision:'timeout' + onTimeout (index.js). Silence still
  // fail-closes — the action does not run — but the chat is told, and the decision the broker gets is 'timeout' (it
  // maps that to a distinct closed result, so the agent never tells the user "you declined").
  {
    const sends = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    let decision = null;
    const ask = (o) => makeConsentWait({
      pending: new Map(), signal: o.signal, timeoutMs: 20, extendMs: 100, uuid: idGen('prompt'),
      timeoutDecision: 'timeout',
      onTimeout: (pid) => { if (typeof o.onTimeout === 'function') o.onTimeout(pid, { tool: 'fs.write' }); },
      emitPrompt: (promptId) => { o.onPrompt(promptId, { tool: 'fs.write', scope: 'write', argsSummary: 'path=notes.md' }); }
    }).ask();
    const runOnce = async (o) => {
      decision = await o.prompt({ name: 'fs.write', args: { path: 'notes.md' } }, { scope: 'write' });
      o.emit('agent.token', { delta: 'it timed out, so nothing was written' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    const hub = makeChannelHub({
      isOwner: () => true, runOnce, store, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); },
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      askConsent: ask, resolveConsent: () => false,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('write notes.md'));
    A.eq(decision, 'timeout', 'an unanswered approval settles as a TIMEOUT (still closed), not a human "deny"');
    A.ok(sends.some(s => /No answer in time — fs\.write was NOT run/.test(s.t)), 'the chat is told the approval expired and the action did not run');
    A.eq(sends[sends.length - 1].t, 'it timed out, so nothing was written', 'the run still finishes and replies');
  }

  // ---- 5E. a tap that lost the race is reported honestly, never as a success ----
  // The PERMANENT RECORD matters as much as the follow-up: the ack toast and the message stamp both assert the
  // decision took effect, and both used to be written BEFORE resolveConsent was asked. A late tap therefore
  // rewrote the permission message to end "▸ ✅ Allow once" on a request the harness had DENIED — the thing a
  // Commander scrolls back to said the opposite of what happened. So this case records the edits and the acks;
  // stubbing editMessage without a recorder (and asserting only the follow-up) is what let it hide.
  {
    const sends = [], acks = [], edits = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    const host = makeHostConsent(20);
    let decision = null;
    const runOnce = async (o) => { decision = await o.prompt({ name: 'fs.write', args: {} }, { scope: 'write' }); o.emit('agent.token', { delta: 'done' }); o.emit('agent.run.end', { reason: 'done' }); };
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      answerCallback: (id, text) => { acks.push(text); return Promise.resolve({ ok: true }); },
      editMessage: (c, mid, text) => { edits.push({ c, mid, text }); return Promise.resolve({ ok: true }); },
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('write it'));   // the ask times out during this await
    const kb = lastKeyboard(sends);
    A.ok(!!kb, 'the consent keyboard was sent');
    A.eq(decision, 'deny', 'the RUN was denied by the fail-closed timer');
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    // (quick win 24) the expiry itself stamped the message — before any tap — so the late tap only acknowledges
    A.eq(edits.length, 1, 'the expiry stamped the permission message before anyone tapped');
    await hub.onCallback({ chatId: '555', userId: 'u1', data: kb[0][0].callback_data, callbackId: 'late', messageId: 'm1' });
    A.ok(!sends.some(s => /already expired/.test(s.t)), 'a late tap adds no correction message: the stamp already says what happened');
    A.eq(edits.length, 1, 'the original permission message is stamped exactly once');
    A.ok(/DENIED/.test(edits[0].text), 'the PERMANENT record states the decision the broker applied');
    A.ok(!/▸ ✅ Allow/.test(edits[0].text), 'and never stamps the button as though the grant landed');
    A.ok(acks.every(a => !/^✓|Allow once/.test(String(a || ''))), 'the ack toast does not read as a success either');
    A.ok(acks.some(a => /expired/i.test(String(a || ''))), 'the ack toast names the expiry');
  }

  // ---- 5E2. a tap that WINS the race is still stamped with the button it granted ----
  // The control for 5E: reordering the settle ahead of the writes must not change the happy path.
  {
    const sends = [], acks = [], edits = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    const host = makeHostConsent(5000);   // long enough that the tap lands first
    let decision = null;
    const runOnce = async (o) => { decision = await o.prompt({ name: 'fs.write', args: {} }, { scope: 'write' }); o.emit('agent.run.end', { reason: 'done' }); };
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      answerCallback: (id, text) => { acks.push(text); return Promise.resolve({ ok: true }); },
      editMessage: (c, mid, text) => { edits.push({ c, mid, text }); return Promise.resolve({ ok: true }); },
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    const running = hub.onInbound(dm('write it'));
    await new Promise(r => setTimeout(r, 10));
    const kb = lastKeyboard(sends);
    await hub.onCallback({ chatId: '555', userId: 'u1', data: kb[0][0].callback_data, callbackId: 'live', messageId: 'm1' });
    await running;
    A.ok(decision && decision !== 'deny', 'the tap that won the race really granted (decision: ' + decision + ')');
    A.eq(edits.length, 1, 'the message is stamped once');
    A.ok(/▸ /.test(edits[0].text) && !/DENIED/.test(edits[0].text), 'a granted tap is stamped with its own button, not an expiry');
    A.ok(!sends.some(s => /already expired/.test(s.t)), 'and no expiry correction is sent');
  }

  // ---- 5E3. an ask ALLOWED on another surface is never stamped "expired — DENIED" by a late Telegram tap ----
  // Live-caught 2026-10-20 (sweep/channels): STARNET REMOTE answers a channel prompt through the same finisher, so
  // the action ran — then a tap on the still-live Telegram keyboard lost the race and the permanent record, the
  // toast and a follow-up message all said the request had expired and been denied. The host remembers how each
  // settled prompt actually ended (consentOutcome); the late tap reports THAT.
  {
    const sends = [], acks = [], edits = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    const host = makeHostConsent(5000);
    const settled = new Map();
    let decision = null, promptSeen = null;
    const runOnce = async (o) => { decision = await o.prompt({ name: 'fs.write', args: {} }, { scope: 'write' }); o.emit('agent.token', { delta: 'Wrote it.' }); o.emit('agent.run.end', { reason: 'done' }); };
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const hub = makeChannelHub({
      isOwner: () => true,
      runOnce, store, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      answerCallback: (id, text) => { acks.push(text); return Promise.resolve({ ok: true }); },
      editMessage: (c, mid, text) => { edits.push({ c, mid, text }); return Promise.resolve({ ok: true }); },
      askConsent: (o) => host.ask(Object.assign({}, o, { onPrompt: (pid, f) => { promptSeen = { runId: o.runId, promptId: pid }; o.onPrompt(pid, f); } }))
        .then(d => { if (promptSeen) settled.set(promptSeen.promptId, d); return d; }),
      resolveConsent: host.resolve,
      consentOutcome: (runId, promptId) => settled.get(String(promptId)) || '',
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    const running = hub.onInbound(dm('write it'));
    await waitFor(() => !!promptSeen && !!lastKeyboard(sends));
    A.ok(host.resolve(promptSeen.runId, promptSeen.promptId, 'once'), 'fixture: another surface (STARNET REMOTE) allows the ask through the same finisher');
    await running;
    A.eq(decision, 'once', 'the run really got the allow');
    const kb = lastKeyboard(sends);
    await hub.onCallback({ chatId: '555', userId: 'u1', data: kb[3][0].callback_data, callbackId: 'late', messageId: 'm1' });
    A.eq(edits.length, 1, 'the permission message is stamped once');
    const stamp = edits[0].text.split('\n').pop();   // the outcome line under the original ask
    A.ok(!/DENIED|expired/i.test(stamp), 'the PERMANENT record never says DENIED for an ask that was allowed: ' + stamp);
    A.ok(/ALLOWED/.test(stamp), 'it states the decision that was applied');
    A.ok(acks.every(a => !/denied|expired/i.test(String(a || ''))), 'the toast does not claim a denial: ' + JSON.stringify(acks));
    A.ok(!sends.some(s => /already expired|was denied/.test(s.t)), 'and no "expired — denied" correction is sent');
  }

  // ---- 5H. (quick win 24) THE SETTLE STAMPS THE KEYBOARD, whoever settled it ----
  // The permission message used to be stamped only by a TAP. An ask answered on STARNET REMOTE, expired by the fail-closed
  // timer, or ended by a superseding message kept four live-looking buttons under it until someone tapped one (bug 9e60dd9f's
  // "not fixed here"). The hub now .then()s the broker's own decision and edits the message ONCE with it, stripping the
  // buttons; a tap only acknowledges.
  {
    // (a) allowed on another surface: stamped ALLOWED at settle, with no tap at all
    const sends = [], edits = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    const host = makeHostConsent(5000);
    let promptSeen = null;
    const runOnce = async (o) => { await o.prompt({ name: 'fs.write', args: {} }, { scope: 'write' }); o.emit('agent.token', { delta: 'Wrote it.' }); o.emit('agent.run.end', { reason: 'done' }); };
    const hub = makeChannelHub({
      isOwner: () => true, runOnce, store, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'kb1' }); },
      answerCallback: () => Promise.resolve({ ok: true }),
      editMessage: (c, mid, text, opts) => { edits.push({ c, mid, text, opts }); return Promise.resolve({ ok: true }); },
      askConsent: (o) => host.ask(Object.assign({}, o, { onPrompt: (pid, f) => { promptSeen = { runId: o.runId, promptId: pid }; o.onPrompt(pid, f); } })),
      resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    const running = hub.onInbound(dm('write it'));
    await waitFor(() => !!promptSeen && !!lastKeyboard(sends));
    await waitFor(() => sends.length >= 1);
    A.ok(host.resolve(promptSeen.runId, promptSeen.promptId, 'once'), 'fixture: STARNET REMOTE allows the ask through the same finisher');
    await running;
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    A.eq(edits.length, 1, 'the permission message is stamped once the ask settles — no tap needed');
    A.eq(edits[0] && edits[0].mid, 'kb1', 'it edits the keyboard message itself');
    A.ok(edits[0] && /ALLOWED/.test(edits[0].text.split('\n').pop()), 'the stamp states the broker\'s decision: ' + (edits[0] && edits[0].text.split('\n').pop()));
    A.ok(edits[0] && !(edits[0].opts && edits[0].opts.reply_markup), 'and the edit carries no keyboard: the spent buttons are stripped');
  }
  {
    // (b) the fail-closed timer: stamped at the expiry, with no tap
    const sends = [], edits = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    const host = makeHostConsent(20);
    const runOnce = async (o) => { await o.prompt({ name: 'fs.write', args: {} }, { scope: 'write' }); o.emit('agent.run.end', { reason: 'done' }); };
    const hub = makeChannelHub({
      isOwner: () => true, runOnce, store, prompts: makePromptRegistry({ newId: idGen('tok') }),
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'kb2' }); },
      answerCallback: () => Promise.resolve({ ok: true }),
      editMessage: (c, mid, text, opts) => { edits.push({ c, mid, text, opts }); return Promise.resolve({ ok: true }); },
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('write it'));
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    A.eq(edits.length, 1, 'an expired ask is stamped when it expires — not left live-looking until a tap');
    A.ok(edits[0] && /DENIED|did not run/.test(edits[0].text.split('\n').pop()), 'the stamp says the action did not run: ' + (edits[0] && edits[0].text.split('\n').pop()));
  }
  {
    // (c) a tap that wins: the message is still stamped exactly ONCE (by the settle), with the button that granted it
    const sends = [], acks = [], edits = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    const host = makeHostConsent(5000);
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const runOnce = async (o) => { await o.prompt({ name: 'fs.write', args: {} }, { scope: 'write' }); o.emit('agent.run.end', { reason: 'done' }); };
    const hub = makeChannelHub({
      isOwner: () => true, runOnce, store, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'kb3' }); },
      answerCallback: (id, text) => { acks.push(text); return Promise.resolve({ ok: true }); },
      editMessage: (c, mid, text, opts) => { edits.push({ c, mid, text, opts }); return Promise.resolve({ ok: true }); },
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    const running = hub.onInbound(dm('write it'));
    await waitFor(() => { const e = reg.peekChat('555', 'consent'); return !!(e && e.messageId); });
    const kb = lastKeyboard(sends);
    await hub.onCallback({ chatId: '555', userId: 'u1', data: kb[1][0].callback_data, callbackId: 'cbS', messageId: 'kb3' });
    await running;
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    A.eq(edits.length, 1, 'a winning tap leaves exactly ONE stamp (the settle\'s), never a second edit');
    A.ok(/▸ ✅ Allow for this session/.test(edits[0].text), 'stamped with the button that granted it');
    A.ok(/Allow for this session/.test(acks[0] || ''), 'the tap itself is acknowledged');
  }

  // ---- 5G. an UNDELIVERABLE keyboard denies AT ONCE instead of stalling out the consent timeout ----
  // Asserted on TIMING, not on the decision: a regression here still ends in 'deny' (the fail-closed timer gets
  // there eventually), so only the wait distinguishes correct from broken. The Commander was never asked, so
  // making them sit through CONSENT_TIMEOUT_MS for a foregone answer would be worse than the autonomous floor.
  {
    const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    let decision = null;
    const host = makeHostConsent(3000);   // long enough that waiting it out is unmistakable
    const runOnce = async (o) => {
      decision = await o.prompt({ name: 'fs.write', args: {} }, { scope: 'write' });
      o.emit('agent.token', { delta: 'could not write' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, prompts: makePromptRegistry({ newId: idGen('tok') }),
      // the keyboard send fails; ordinary replies still succeed
      send: (c, t, opts) => Promise.resolve((opts && opts.reply_markup) ? { ok: false, error: 'chat not found' } : { ok: true, messageId: 'm1' }),
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      askConsent: host.ask, resolveConsent: host.resolve,
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    const settled = hub.onInbound(dm('write it')).then(() => 'finished');
    const raced = await Promise.race([settled, new Promise(r => setTimeout(() => r('STALLED'), 800))]);
    A.eq(raced, 'finished', 'an undeliverable consent keyboard resolves immediately — it does NOT wait out the fail-closed timer');
    A.eq(decision, 'deny', 'and it resolves to deny (fail-closed), never a silent allow');
  }

  // ---- 5G. a TYPED follow-up while the run waits on an approval keyboard is not told "it picks this up at its next
  //          step" — the run is paused on the keyboard, and a typed "yes" does not answer it (review voice-remote-channels-03)
  {
    const sends = []; const steers = []; const store = fakeStore({ 555: { agentId: 'tg_555', approvals: true } });
    const host = makeHostConsent(5000);
    let releaseRun = null;
    const runOnce = async (o) => {
      await o.prompt({ name: 'fs.write', args: { path: 'notes.md' } }, { scope: 'write' });
      await new Promise(res => { releaseRun = res; });
      o.emit('agent.token', { delta: 'done' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const hub = makeChannelHub({
      isOwner: () => true, runOnce, store, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'consent-msg' }); },
      answerCallback: () => Promise.resolve({ ok: true }), editMessage: () => Promise.resolve({ ok: true }),
      askConsent: host.ask, resolveConsent: host.resolve,
      steerRun: (runId, text) => { steers.push(text); return { ok: true }; },
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    const inflight = hub.onInbound(dm('write notes.md'));
    await waitFor(() => { const e = reg.peekChat('555', 'consent'); return !!(e && e.messageId); });
    await hub.onInbound(dm('yes go ahead'));
    A.eq(steers, ['yes go ahead'], 'the typed note still reaches the running task');
    const waitingReply = sends[sends.length - 1].t;
    A.ok(/permission request/.test(waitingReply) && /Tap Allow or Deny/.test(waitingReply) && !/picks this up at its next step/.test(waitingReply),
      'the reply says the run is paused on the open approval and how to answer it: ' + waitingReply);
    const kb = lastKeyboard(sends);
    await hub.onCallback({ chatId: '555', userId: 'u1', data: kb[3][0].callback_data, callbackId: 'cbG', messageId: 'consent-msg' });
    await waitFor(() => typeof releaseRun === 'function');
    await hub.onInbound(dm('also add a title'));
    const afterReply = sends[sends.length - 1].t;
    A.ok(/picks this up at its next step/.test(afterReply), 'once the approval is answered a follow-up gets the ordinary reply: ' + afterReply);
    releaseRun();
    await inflight;
  }

  // ---- 5F. a token from one chat cannot resolve another chat's prompt ----
  {
    const sends = [], acks = []; const store = fakeStore();
    const reg = makePromptRegistry({ newId: idGen('tok') });
    const runOnce = async (o) => { o.emit('agent.token', { delta: 'TASK_QUESTION: Which? || a | b' }); o.emit('agent.run.end', { reason: 'clarifying' }); };
    const hub = makeChannelHub({
      isOwner: () => true,   // these scenarios are the paired owner (the non-owner gate: channels.owner-gates.test.js)
      runOnce, store, taskIntent: TaskIntent, prompts: reg,
      send: (c, t, opts) => { sends.push({ c, t, opts }); return Promise.resolve({ ok: true, messageId: 'm1' }); },
      answerCallback: (id, text) => { acks.push(text); return Promise.resolve({ ok: true }); },
      editMessage: () => Promise.resolve({ ok: true }),
      secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen('run')
    });
    await hub.onInbound(dm('go', '111'));
    const kb = lastKeyboard(sends);
    await hub.onCallback({ chatId: '222', userId: 'u1', data: kb[0][0].callback_data, callbackId: 'x', messageId: 'm1' });
    A.ok(/no longer open/i.test(acks[0]), 'a token minted for chat 111 is refused when tapped from chat 222');
  }

  A.report('channels.buttons.test');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
