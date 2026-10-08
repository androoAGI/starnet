/* node test/taint-refusal-copy.test.js — the untrusted-content refusal says only what the harness can prove.

   Since 8a985a4c7 a run whose earlier context cannot be checked starts LOCKED (taint-replay.js UNPROVABLE = TAINTED:
   an unreadable source journal, or a replay proof that throws). That fail-closed policy stays. But the refusal then
   told the agent "This run started with outside content already in its context", which nothing proved — the harness
   only knows it could not verify. And a delegated worker (surface 'autonomous', no run prompt) was offered "a watched
   chat can ask to approve this exact call", an approval it can never receive for a non-connector tool.

   The refusal block is lifted out of sidecar/index.js verbatim and run against stub run state, so this checks the
   shipped words, not a copy of them. The lock decision itself (postTaint.allow) is an INPUT here: no policy changes. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeReplayedTaint, isUnverifiedTaint } = require('../sidecar/taint-replay.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
const from = src.indexOf('const postTaintConfirmed = postTaint.oneShot;');
const to = src.indexOf('const internalBriefControl = internalBriefTools.indexOf(c.name) >= 0;');
A.ok(from > 0 && to > from, 'index.js still has the refusal block between the post-taint decision and the brief gate');
const block = src.slice(from, to);
const refusal = new Function('postTaint', 'execution', 'taintAtStart', 'taintHandedIn', 'inheritedTaint', 'taintSource', 'o', 'c',
  'effectSurface', 'effectPrompt', 'isUnverifiedTaint', block + '\nreturn null;');

const ask = () => 'deny';
function refuse(s) {
  const own = s.own || null;
  const r = refusal({ allow: false, oneShot: false }, { taintedBy: () => own }, s.atStart === undefined ? own : s.atStart,
    s.handedIn || null, s.inherited || null, own || s.inherited, s.o || {}, { name: s.tool || 'web_request' },
    s.surface || 'autonomous', s.prompt || null, isUnverifiedTaint);
  A.ok(r && r.summary === 'untrusted-content-lockout' && /^BLOCKED: "/.test(r.content), 'still the same lockout (' + s.label + ')');
  return (r && r.content) || '';
}
const COULD_NOT = "StarNet could not verify this run's earlier context, so it is treated as outside content";
const OFFER = 'a watched chat can ask to approve this exact call';

// ---- the predicate agrees with the reasons the fail-closed paths actually latch ----
{
  const busy = makeReplayedTaint({ journal: { inspect() { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } }, transcript: null });
  const produced = busy({ recovery: { sourceRunId: 'r0' }, streamId: '', msgs: [] });
  A.ok(isUnverifiedTaint(produced), 'an unreadable source journal reason is unverified: ' + produced);
  A.ok(isUnverifiedTaint('replayed context (taint check failed)'), "index.js's fixed fail-closed latch is unverified");
  A.ok(isUnverifiedTaint('replayed history (tainted by replayed context (taint check failed))'), 'a chained replay of an unverified run stays unverified');
  A.ok(isUnverifiedTaint('resumed run (tainted by resumed run (taint unverifiable: run journal unreadable EPERM))'), 'a chained continuation stays unverified');
  for (const real of ['user attachment', 'web_fetch', 'resumed run (tainted by web_fetch)', 'replayed history (tainted by channel attachment)', '', null, undefined]) {
    A.ok(!isUnverifiedTaint(real), 'a PROVEN source is not "unverified": ' + JSON.stringify(real));
  }
  A.ok(/const \{ isUnverifiedTaint \} = require\('\.\/taint-replay\.js'\);/.test(src), 'index.js reads the predicate from taint-replay.js (one definition beside the reasons it matches)');
}

// ---- 1. a fail-closed replay says what is known: StarNet could not verify, so it is TREATED as outside content ----
for (const reason of ['resumed run (taint unverifiable: run journal unreadable EBUSY)', 'replayed context (taint check failed)']) {
  const watched = refuse({ label: 'unverified, watched', own: reason, surface: 'interactive', prompt: ask });
  A.ok(watched.indexOf(COULD_NOT) >= 0, 'unverified start: says StarNet could not verify (' + reason + ')');
  A.ok(watched.indexOf('(via ' + reason + ')') >= 0, 'and still names the exact reason for diagnostics');
  A.ok(watched.indexOf('started with outside content already in its context') < 0, 'never claims outside content WAS in the context');
  A.ok(watched.indexOf('could contain instructions from whoever wrote it') < 0, 'never describes an author of content nobody saw');
  A.ok(watched.indexOf(OFFER) >= 0, 'a watched chat keeps its one-call approval offer');
  const unattended = refuse({ label: 'unverified, routine', own: reason });
  A.ok(unattended.indexOf(COULD_NOT) >= 0, 'an unattended (non-worker) run gets the same honest cause');
}

// ---- 2. a PROVEN start-time source keeps the wording it had ----
{
  const att = refuse({ label: 'attachment', own: 'user attachment', surface: 'interactive', prompt: ask });
  A.ok(/This run started with outside content already in its context \(via user attachment\), which could contain instructions/.test(att), 'a real attachment keeps the started-with wording');
  A.ok(att.indexOf(COULD_NOT) < 0, 'and is not softened into "could not verify"');
  const read = refuse({ label: 'own read', own: 'web_fetch', atStart: null, surface: 'interactive', prompt: ask });
  A.ok(/This run has already read outside content \(via web_fetch\)/.test(read), 'a run that read the content itself keeps the own-read wording');
}

// ---- 3. a delegated worker is never offered an approval it cannot receive ----
{
  const o = { delegatedBy: 'lead-1' };
  const worker = refuse({ label: 'worker web_request', own: 'user attachment', handedIn: 'user attachment', o });
  A.ok(/handed over by lead-1/.test(worker) && /user attachment/.test(worker), 'the worker refusal still names the lead and the real source');
  A.ok(worker.indexOf(OFFER) < 0, 'a worker (autonomous, no prompt) is NOT offered "a watched chat can ask to approve this exact call"');
  A.ok(worker.indexOf('without that confirmation') < 0, 'and is not told to wait for a confirmation that never comes');
  A.ok(/For the Commander: a new session whose history has no attachments or outside pages/.test(worker), 'the structural remedy remains, as the Commander\'s way forward');
  A.ok(/report the withheld step plainly/.test(worker), 'the worker is still told to report the withheld step');
  // a connector (mcp:) call is forwarded to the lead's live prompt — there an approval IS possible, so it stays offered
  const connector = refuse({ label: 'worker connector', own: 'user attachment', handedIn: 'user attachment', o, tool: 'mcp.github.create_issue', surface: 'interactive', prompt: ask });
  A.ok(connector.indexOf(OFFER) >= 0, 'a worker connector call that reached the watched lead\'s prompt keeps the offer');
  // a lead whose own context was unverifiable hands that over: the worker hears the same honest cause
  const unv = 'resumed run (taint unverifiable: run journal unreadable ENOENT)';
  const handed = refuse({ label: 'worker unverified', own: unv, handedIn: unv, o });
  A.ok(/handed over by lead-1/.test(handed), 'an unverified hand-over still names the lead');
  A.ok(/could not verify/.test(handed) && /treated as outside content/.test(handed), 'and says StarNet could not verify that context');
  A.ok(handed.indexOf('whose chat has outside content') < 0, 'never claims the lead\'s chat HAS outside content');
  A.ok(handed.indexOf(OFFER) < 0, 'and offers the worker no approval');
}

// ---- 4. the owner-facing remedies never point at a taint-clearing control or Full Access ----
A.ok(!/clear (the )?taint|turn on Full Access/i.test(block), 'the refusal never suggests clearing taint or Full Access as the way out');

A.report('taint-refusal-copy.test');
