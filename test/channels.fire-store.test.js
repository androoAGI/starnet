/* node test/channels.fire-store.test.js — a one-job hub's hop history belongs to THAT job (quick win 27).

   A downstream hop replays its prior turns from store.loadHistory(hopKey), keyed by chat + line + dock. The sample hub
   (RUN ONE REAL JOB / station.test_line) always uses chat 'sample', so on the REAL store every test job of a line replayed
   the hand-offs of every earlier test job at that dock. The trigger hub already wrapped its store per fire; that wrapper
   is now sidecar/channels/fire-store.js and both hubs use it.

   Proves: (A) perFireStore keeps turns in the current fire's map and passes everything else to the real store; (B) through
   the REAL makeChannelHub + the REAL channel store, a second job's hop sees none of the first job's hand-off (and, as the
   control, the bare store DOES leak it); (C) index.js builds the sample hub and the trigger hub over perFireStore, and a
   sample job starts with a fresh turn map. */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { perFireStore } = require('../sidecar/channels/fire-store.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

function memFs() {
  const files = new Map();
  return {
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
}
const mkStore = () => makeChannelStore({ fs: memFs(), pathMod, root: '/ws/channels', clock: { now: () => 1 } });

(async () => {
  // ---- A. the wrapper ----
  {
    const real = mkStore();
    let fire = { turns: {} };
    const s = perFireStore(real, (a) => fire.turns[a] || (fire.turns[a] = []));
    s.appendTurn('hop_x', 'user', 'job one hand-off');
    A.eq(s.loadHistory('hop_x'), [{ role: 'user', content: 'job one hand-off' }], 'turns land in the current fire');
    A.eq(real.loadHistory('hop_x'), [], 'and never in the real store');
    fire = { turns: {} };
    A.eq(s.loadHistory('hop_x'), [], 'the next fire starts empty');
    s.saveChatRecord('c1', { agentId: 'a' });
    A.eq(real.getChatRecord('c1').agentId, 'a', 'every other method is the real store\'s');
    A.eq(s.clearHistory('hop_x'), 0, 'clearHistory touches nothing and says so');
    A.throws(() => perFireStore(real), 'a turns source is required');
  }

  // ---- B. the REAL hub: a second job's hop does not replay the first job's hand-off ----
  async function twoJobs(wrap) {
    const real = mkStore();
    let fire = { turns: {} };
    const store = wrap ? perFireStore(real, (a) => fire.turns[a] || (fire.turns[a] = [])) : real;
    const hopSaw = [];
    const runOnce = async (o) => {
      if (o.agentId === 'writer') hopSaw.push(o.messages.map(m => m.content));
      o.emit('agent.run.start', { runId: o.runId });
      o.emit('agent.token', { delta: o.agentId === 'writer' ? 'draft' : 'findings' });
      o.emit('agent.run.end', { reason: 'done' });
    };
    let n = 0;
    const chain = {
      advance: async (o) => { n++; const r = await o.runAgent({ agentId: 'writer', text: 'HAND-OFF OF JOB ' + n, signal: o.signal }); return { text: r.text, agentId: 'writer', hops: [{ agentId: 'writer' }], usd: 0, stopped: null }; },
      stopNote: () => ''
    };
    const hub = makeChannelHub({
      channel: 'sample', agentPrefix: 'smp_', textBatchWaitMs: 0, bindChats: false, ownerSurface: true,
      runOnce, store, chain, lineOriginFor: () => 'L1', classify: () => true,
      resolveRunConfig: () => ({ key: 'k', model: 'm' }), resolveEntryRunConfig: () => ({ key: 'k', model: 'm' }),
      send: () => Promise.resolve({ ok: true }), secrets: () => ({}),
      newId: (() => { let i = 0; return () => 'id-' + (++i); })(), now: () => 1
    });
    for (let job = 1; job <= 2; job++) {
      fire = { turns: {} };   // a new job: a fresh turn map (runSampleJob)
      await hub.onInbound({ channel: 'sample', chatId: 'sample', chatType: 'dm', userId: 'u', text: 'job ' + job, messageId: 'm' + job, ts: job });
    }
    hub.close();
    return hopSaw;
  }
  const leaked = await twoJobs(false);
  A.eq(leaked.length, 2, 'fixture: the line ran its hop on both jobs');
  A.ok(leaked[1].some(c => /HAND-OFF OF JOB 1/.test(c)), 'control: over the bare store the second job\'s hop replays the first job\'s hand-off');
  const kept = await twoJobs(true);
  A.eq(kept.length, 2, 'the line ran its hop on both jobs');
  A.eq(kept[1], ['HAND-OFF OF JOB 2'], 'over perFireStore the second job\'s hop sees only its own hand-off');

  // ---- C. index.js: both one-job hubs over perFireStore, and a sample job starts fresh ----
  {
    const sample = sidecarTopLevelFunction('getSampleHub');
    A.ok(sample.length > 500, 'fixture: getSampleHub is sliced');
    A.ok(/store: perFireStore\(channelStore, /.test(sample), 'the sample hub\'s turn history is per job (perFireStore)');
    const trig = sidecarTopLevelFunction('makeTriggerHub');
    A.ok(/store: perFireStore\(channelStore, hooks\.turns\)/.test(trig), 'the trigger hub uses the same wrapper');
    A.ok(!/new Proxy\(channelStore/.test(trig), 'and no longer carries its own copy');
    const run = sidecarTopLevelFunction('runSampleJob');
    A.ok(/sampleInFlight = \{[^}]*turns: \{\}/.test(run), 'every sample job starts with a fresh turn map');
  }

  A.report('channels.fire-store.test');
})().catch(e => { console.error(e); process.exit(1); });
