/* node test/hop-resume-seed.test.js — A HOP IS NOT A RESUME (token-burn audit 2026-10-17).

   runOnceCore's H1.2 resume seed prepends a stream's last 100 transcript rows to any run that arrives with one message
   and a streamId. Every work-line hop has exactly that shape, so each stage was re-sent the earlier stages' tool calls
   and results as its own past turns, on top of a handoff that already carries the upstream output (owner's station:
   median 64 KB, p90 205 KB per hop, on every turn of the hop). Each hop runner opts out with resumeSeed:false.

   cron.run-now.e2e proves one runner on the wire; this source lock pins EVERY runner in the fast gate, so deleting one
   opt-out (or the guard that reads it) goes red before merge. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// the host's runners wherever they live; the hub's own opt-out is counted on its own below
const idx = readSidecarSource({ except: ['sidecar/channels/hub.js'] });
const hub = read('sidecar/channels/hub.js');
const count = (s, needle) => s.split(needle).length - 1;

// the guards: the resume seed and the queued-turn re-seed both honor the opt-out
A.ok(/!o\.recovery && !o\.groupTools && !internal && o\.resumeSeed !== false && streamId && Array\.isArray\(messages\)/.test(idx),
  'runOnceCore: the resume seed skips a run that opted out (resumeSeed:false)');
A.ok(/if \(queued && o\.resumeSeed !== false && !o\.recovery/.test(idx), 'a queued turn is not re-seeded from the stream when it opted out');

// the runners: every entry's hop (the channel / trigger / SEND TO / sample hubs, the scheduled fire, Run Now and the step test) runs
// through the ONE hop executor (sidecar/routing/line-runner.js), whose runOnce opts out BY CONSTRUCTION; no runner elsewhere
const runner = read('sidecar/routing/line-runner.js');
const others = readSidecarSource({ except: ['sidecar/routing/line-runner.js'] });
A.eq(count(runner, 'resumeSeed: false,'), 1, 'line-runner.js: the one hop executor opts its hops out');
A.ok(/parallelBranch: !!h\.parallel,[^\n]*\n\s*ceilingUsd: h\.ceilingUsd,[^\n]*\n\s*handoffReads: mergeFiles\(h\.handoffReads\),[^\n]*\n\s*resumeSeed: false,/.test(runner), 'the opt-out sits on the hop runOnce, beside its ceiling and proved upstream reads');
A.eq(count(others, 'resumeSeed: false,'), 0, 'no other sidecar file runs a hop of its own (index.js, hub.js: only profiles of the one executor)');
A.eq(count(hub, 'resumeSeed: false,'), 0, 'hub.js: the channel / trigger / SEND TO hop is the executor\'s channel profile');

// …and driven: whatever a profile says, the hop's runOnce is handed resumeSeed false (a fake runOnce at the transport edge)
const { makeLineRunner, profiles } = require('../sidecar/routing/line-runner.js');
const seen = [];
const lr = makeLineRunner({ runOnce: async (o) => { seen.push(o.resumeSeed); o.emit('agent.run.end', { runId: o.runId, reason: 'done' }); return { reason: 'done', text: 'out', outcome: 'succeeded' }; } });
const routine = { config: () => ({ key: 'k', model: 'm' }), system: () => 'S', station: () => null, routine: { resumeSeed: true } };
Promise.all([profiles.channel({ channel: 'telegram', chatId: '1' }), profiles.schedule(routine), profiles.manual(routine),
  profiles.steptest({ config: () => ({ model: 'm', key: 'k' }), persona: 'P', brief: () => null, dockSystem: p => p, station: () => null, emit: () => {} })]
  .map(p => lr.hopRunner(p)({ agentId: 'b', text: 'hand-off', streamId: 's1' }))).then(() => {
  A.eq(seen, [false, false, false, false], 'every profile\'s hop opts out of its stream\'s resume seed');
  A.report('hop-resume-seed.test');
}).catch(e => { console.error(e); process.exit(1); });
