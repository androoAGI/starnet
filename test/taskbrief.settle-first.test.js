/* node test/taskbrief.settle-first.test.js — THE SETTLE RUNS FIRST (cost audit W1.2, 2026-11-08).

   taskbrief-policy.js settleFirst is the ONE rule that decides a batch's run order for the Task Brief gate: when a batch
   carries brief_proceed and no brief_ask, its brief_update / brief_proceed calls run first (listed order), then every other
   call (listed order). On e316231d7 the gate depended on the order the model listed calls in one response, and
   [fs_write, brief_proceed] cost a whole extra request. The e2e proof is test/brief-same-response.e2e.test.js; this pins
   the rule itself, including the cases where nothing may move. Also pins the wording that tells models to batch it. */
'use strict';
const A = require('./_assert.js');
const Policy = require('../sidecar/taskbrief-policy.js');
const { TaskIntent } = require('../frontend/app/fork.js');

const WIRE = { brief_ask: 'brief.ask', brief_proceed: 'brief.proceed', brief_update: 'brief.update', fs_write: 'fs.write', fs_read: 'fs.read', shell_exec: 'shell.exec' };
const nameOf = c => WIRE[c.name] || c.name;
const call = (name, id) => ({ id: id || name, name, args: {}, argsRaw: '{}' });
const ids = list => list.map(c => c.id).join(',');
const order = (...names) => names.map((n, i) => call(n, n + '#' + i));

// ---- the cost case: a write listed before the settle runs after it ----
{
  const batch = order('fs_write', 'brief_proceed');
  A.eq(ids(Policy.settleFirst(batch, nameOf)), 'brief_proceed#1,fs_write#0', '[fs_write, brief_proceed] runs the settle first');
}
// ---- already in run order: the SAME array comes back (the loop then takes its byte-identical path) ----
{
  const batch = order('brief_proceed', 'fs_write');
  A.ok(Policy.settleFirst(batch, nameOf) === batch, '[brief_proceed, fs_write] is already in run order: same array');
  const upd = order('brief_update', 'brief_proceed', 'fs_write', 'shell_exec');
  A.ok(Policy.settleFirst(upd, nameOf) === upd, 'update, proceed, then work: same array');
}
// ---- brief calls keep THEIR listed order; every other call keeps its listed order ----
{
  const batch = order('fs_read', 'fs_write', 'brief_update', 'shell_exec', 'brief_proceed');
  A.eq(ids(Policy.settleFirst(batch, nameOf)), 'brief_update#2,brief_proceed#4,fs_read#0,fs_write#1,shell_exec#3',
    'update before proceed (an answer is folded in before the settle), then the rest exactly as listed');
  const swapped = order('fs_write', 'brief_proceed', 'brief_update');
  A.eq(ids(Policy.settleFirst(swapped, nameOf)), 'brief_proceed#1,brief_update#2,fs_write#0', 'a proceed listed before its update stays before it (stable, never re-decided)');
}
// ---- a batch that ASKS keeps its order exactly: the question must pause the run before any write ----
{
  const batch = order('fs_write', 'brief_ask', 'brief_proceed');
  A.ok(Policy.settleFirst(batch, nameOf) === batch, 'brief_ask anywhere in the batch: nothing moves');
  const askFirst = order('brief_ask', 'fs_write', 'brief_proceed');
  A.ok(Policy.settleFirst(askFirst, nameOf) === askFirst, 'brief_ask listed first: nothing moves either');
}
// ---- nothing to unlock: no brief_proceed, no move ----
{
  const batch = order('fs_write', 'brief_update');
  A.ok(Policy.settleFirst(batch, nameOf) === batch, 'brief_update without brief_proceed unlocks nothing: same array');
  const plain = order('fs_read', 'fs_write');
  A.ok(Policy.settleFirst(plain, nameOf) === plain, 'a batch with no brief calls: same array');
}
// ---- names resolve through the host's mapping: a model that calls the dotted name is treated the same ----
{
  const dotted = [call('fs.write', 'w'), call('brief.proceed', 'p')];
  A.eq(ids(Policy.settleFirst(dotted, c => c.name)), 'p,w', 'dotted brief.proceed is recognised');
  const dottedAsk = [call('fs.write', 'w'), call('brief.ask', 'a'), call('brief_proceed', 'p')];
  A.ok(Policy.settleFirst(dottedAsk, nameOf) === dottedAsk, 'dotted brief.ask still blocks the move');
}
// ---- defensive: never throws, never invents or drops a call ----
{
  const batch = order('fs_write', 'brief_proceed');
  A.ok(Policy.settleFirst(batch, () => { throw new Error('boom'); }) === batch, 'a throwing name lookup moves nothing');
  A.ok(Policy.settleFirst(batch, null) === batch, 'no name lookup: same array');
  const single = order('brief_proceed');
  A.ok(Policy.settleFirst(single, nameOf) === single, 'a single call: same array');
  A.eq(Policy.settleFirst(null, nameOf), null, 'not an array: returned untouched');
  const moved = Policy.settleFirst(order('fs_write', 'fs_read', 'brief_proceed'), nameOf);
  A.eq(moved.length, 3, 'a reorder is a permutation: same length');
  A.eq(new Set(moved).size, 3, '...with every call exactly once');
}
// ---- the words the model reads say to batch the settle, and still route a material question to brief_ask ----
{
  const doctrine = TaskIntent.directive('');
  A.ok(/When you proceed, send brief_proceed in the SAME response as your first consequential tool call, listed first/.test(doctrine),
    'the Task Brief doctrine says to send brief_proceed in the same response as the first consequential call, listed first');
  A.ok(!/immediately before the first consequential tool/.test(doctrine), 'the "immediately before" wording (read as a reply of its own) is gone');
  A.ok(/use brief_ask with mode:conversation/.test(doctrine) && /Ask only when different plausible answers would materially change the outcome/.test(doctrine),
    'the asking doctrine is untouched (interview depth: brief_ask stays the route for a material question)');
  const reg = { list: [], register(t) { this.list.push(t); } };
  require('../sidecar/taskbrief-tools.js').registerTaskBriefTools(reg, {}, { brief: null }, {});
  const proceed = reg.list.find(t => t.name === 'brief.proceed');
  A.ok(proceed && /SAME response as your first write\/execute call, listed first/.test(proceed.description), 'brief_proceed\'s description says the same');
  A.ok(proceed && /brief_ask/.test(proceed.description), '...and points a material question at brief_ask');
}

A.report('taskbrief.settle-first');
