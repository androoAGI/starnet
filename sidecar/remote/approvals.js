/* sidecar/remote/approvals.js — every open approval on this station, in one place.

   Before this, an approval lived only with whoever started the run: a desktop run's prompt sat in
   pendingByRun (answerable only by the page holding that run's stream), a Telegram run's prompt sat in
   channelPendingByRun (answerable only on Telegram). A phone could answer neither. This registry is a
   READ-SIDE index over both, plus the prompts of runs a phone started. It never replaces the waiters: the
   fail-closed timing still lives in consentwait.js, and each entry resolves by calling the SAME finisher
   the original surface would have called. First answer wins; a late answer is a harmless no-op.

     const reg = makeApprovals({ now, onChange })
     const done = reg.add({ runId, promptId, agentId, surface, tool, scope, argsSummary, finish })
     done()                                  // the waiter settled (answered, timed out, or aborted)
     reg.list()                              -> public rows (no finisher)
     reg.answer(runId, promptId, decision)   -> { ok, decision?, error? }   decision: once | session | deny (decision = what was applied)
     reg.reply(runId, promptId, text)        -> { ok, error? }   a clarify (tool 'brief.ask') answer

   Remote answers are deliberately narrower than the desk's: a phone can approve ONCE or for the SESSION,
   or deny. It can never grant ALWAYS or FULL ACCESS; standing grants are made at the desk. And it never grants
   "for this session" to anything that RUNS (scope 'execute': a command, a web request, a click, a message sent;
   GHSA-2hpj #4): such an answer is applied as ONCE, and the phone offers only Once and Deny for it. */
'use strict';

const { note } = require('../failopen.js');

const REMOTE_DECISIONS = new Set(['once', 'session', 'deny']);

function makeApprovals(deps) {
  const now = deps && deps.now;
  if (typeof now !== 'function') throw new Error('makeApprovals needs an injected clock (deps.now)');
  const onChange = (deps && typeof deps.onChange === 'function') ? deps.onChange : () => {};
  const open = new Map();   // runId + '\u0000' + promptId -> entry

  const keyOf = (runId, promptId) => String(runId || '') + '\u0000' + String(promptId || '');
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

  function fire(kind, row) { try { onChange(kind, row); } catch (e) { note('remote.approvals.onChange', e); } }

  function add(o) {
    if (!o || typeof o.finish !== 'function') return () => {};
    const k = keyOf(o.runId, o.promptId);
    const e = {
      runId: String(o.runId || ''), promptId: String(o.promptId || ''), agentId: String(o.agentId || ''),
      surface: o.surface === 'channel' || o.surface === 'remote' ? o.surface : 'desk',
      tool: clip(o.tool || 'tool', 80), scope: clip(o.scope || 'write', 20), argsSummary: clip(o.argsSummary, 4000),
      exactCommand: o.exactCommand === true,
      createdAt: now(), finish: o.finish
    };
    open.set(k, e);
    fire('opened', publicRow(e));
    let removed = false;
    return function done() {
      if (removed) return;
      removed = true;
      const cur = open.get(k);
      if (cur === e) { open.delete(k); fire('closed', { runId: e.runId, promptId: e.promptId }); }
    };
  }

  function publicRow(e) {
    const row = { runId: e.runId, promptId: e.promptId, agentId: e.agentId, surface: e.surface, tool: e.tool, scope: e.scope,
      argsSummary: e.argsSummary, kind: e.tool === 'brief.ask' ? 'question' : 'approval', createdAt: e.createdAt };
    if (e.exactCommand) row.exactCommand = true;   // additive (GHSA-2hpj #4)
    return row;
  }

  function list() { return Array.from(open.values()).sort((a, b) => a.createdAt - b.createdAt).map(publicRow); }

  function take(runId, promptId) {
    const k = keyOf(runId, promptId);
    const e = open.get(k);
    if (!e) return null;
    open.delete(k);
    fire('closed', { runId: e.runId, promptId: e.promptId });
    return e;
  }

  function answer(runId, promptId, decision) {
    let d = String(decision || '');
    if (!REMOTE_DECISIONS.has(d)) return { ok: false, error: 'a phone can approve once or for this session, or deny. Standing grants are made at the desk.' };
    const e = open.get(keyOf(runId, promptId));
    if (!e) return { ok: false, error: 'that request was already answered or has expired' };
    if (e.tool === 'brief.ask' && d !== 'deny') return { ok: false, error: 'this is a question — answer it with text' };
    // GHSA-2hpj #4: a phone never grants "for this session" to something that runs; an older phone's tap is taken as once
    if (d === 'session' && (e.scope === 'execute' || e.exactCommand)) d = 'once';
    take(runId, promptId);
    try { e.finish(d); } catch (err) { note('remote.approvals.finishDecision', err); }
    return { ok: true, decision: d };
  }

  function reply(runId, promptId, text) {
    const t = String(text == null ? '' : text).trim().slice(0, 4000);
    if (!t) return { ok: false, error: 'the answer is empty' };
    const e = open.get(keyOf(runId, promptId));
    if (!e) return { ok: false, error: 'that question was already answered or has expired' };
    if (e.tool !== 'brief.ask') return { ok: false, error: 'this is an approval — approve or deny it' };
    take(runId, promptId);
    try { e.finish({ __clarify: true, text: t }); } catch (err) { note('remote.approvals.finishReply', err); }
    return { ok: true };
  }

  // The phone rendered this prompt to a person: earn the waiter's one bounded extension, exactly like the
  // desk's POST /api/consent/ack. Unattended surfaces never call this, so their fail-closed floor is unchanged.
  function extend(runId, promptId) {
    const e = open.get(keyOf(runId, promptId));
    return !!(e && typeof e.finish.extend === 'function' && e.finish.extend());
  }

  function size() { return open.size; }

  return { add, list, answer, reply, extend, size };
}

module.exports = { makeApprovals, REMOTE_DECISIONS };
