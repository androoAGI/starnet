/* node test/channels.delivery-ledger.property.test.js — the doneMeans of channel-delivery-ledger, as a seeded property:
   every finished channel reply reaches its chat exactly once and in order, a dead chat never delays another, and no tool
   step runs twice, under random send failures and crashes.

   The world (test/helpers/channel-station-sim.js): 3 chats on 2 channels — a Telegram owner DM 4242, a Telegram group
   -100777 the owner admitted, and a Discord DM 4242 (the same id on two platforms). The station Telegram hub and adapter
   are startTelegram's own calls, lifted out of sidecar/index.js property by property; Discord is built through
   wireChannel. Fakes stand only at the transport edge (a Bot API fetch, a Discord REST that honours nonce with
   enforce_nonce for 5 minutes), the disk (in memory, with a generation fence: a crash is real, the dead process can neither
   write nor send) and the scripted run host (the shared/events.js agent.* contract, validated; each tool step journaled).

   Each seed scripts messages (two bubbles within the 350 ms batch window), follow-ups steered into a live run, a plain
   "stop", slash commands, overheard group lines and edits of older messages, and draws faults at the delivery's await
   boundaries: retryable, refused-for-good and refused-credential sends; a lost response (the platform took it); a crash
   before a send, after the platform took a part and before its mark, and inside a receipt or answer write; write
   failures (EBUSY, UPDATE_MUTATIONS_FROZEN) while sends succeed; the update barrier; a lane pushed past its backpressure
   mark and a channel's receipt cap; a membership kick and the unblock; a chat that is down for 20-50 s (every send to it
   fails) while its members keep writing, and the healthy chat (the Telegram or the Discord DM, by seed) blips once. After
   the script nothing new is drawn for 20 s while P3 is still checked; then it heals everything and drains.
     P1 every finished reply lands line for line, exactly once. THE BOUNDARY: a part the platform took in the instant the
        process died, or whose answer was lost, may land once more on Telegram (each such window event is logged and
        allows one extra copy of exactly that part); on Discord, never. A durable delivery always lands or is given up.
     P2 per chat, replies land in the order they finished.
     P3 a healthy chat's reply lands within one drain, whatever another chat does: 16 s from its finish (or from the end
        of a hold or write-failure span) — its own blip costs the adapter's 1 s resend and its lane's 5 s retry.
     P4 no (message, tool step) pair runs twice — under live write failures too (no crash is drawn while writes fail or
        before the ledger's retry has surely landed after them: a mark that never reached the disk protects nothing
        across a crash).
     P5 every acknowledged message gets exactly one terminal outcome (a run, one re-run after a 0-step attempt, an
        interrupted notice, or a settle), nothing is left pending, and a merged batch's answer settles all its receipts.
     P6 a reply refused for good is reported once and never tried again; no finished reply is dropped for capacity.
   After the property: the MANIFEST (every key of the production calls is classified real or stub, so a new bag field
   fails here until it is), and the SOURCE LOCK (every hub index.js builds stands over the station's store, a view of it,
   or — named, with the reason — a one-job fire's own in-memory ledger).

   On failure it prints each failing seed and the command that replays it:
     CDL_SEED=<n> node test/channels.delivery-ledger.property.test.js
   The soak (test/channels.delivery-ledger.soak.test.js) runs ~800 more seeds and adds an agent bot. */
'use strict';
const A = require('./_assert.js');
const Sim = require('./helpers/channel-station-sim.js');
const { readSidecarIndex } = require('./helpers/source.js');

const STEPS = 40;
const FROM = process.env.CDL_SEED ? Number(process.env.CDL_SEED) : 1;
const TO = process.env.CDL_SEED ? Number(process.env.CDL_SEED) : 40;
const CLAUSES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

(async () => {
  const bySeed = [];
  const byClause = {};
  for (let seed = FROM; seed <= TO; seed++) {
    const r = await Sim.makeWorld(seed, {}).run(STEPS);
    if (r.problems.length) bySeed.push({ seed, problems: r.problems });
    for (const p of r.problems) {
      const clause = CLAUSES.find(c => p.indexOf(c + ' ') === 0) || 'setup';
      (byClause[clause] = byClause[clause] || []).push('seed ' + seed + ': ' + p);
    }
  }
  for (const s of bySeed.slice(0, 6)) {
    console.log('  seed ' + s.seed + ' (replay: CDL_SEED=' + s.seed + ' node test/channels.delivery-ledger.property.test.js)');
    for (const p of s.problems.slice(0, 4)) console.log('    ' + String(p).slice(0, 400));
  }
  const runs = TO - FROM + 1;
  const show = (c) => (byClause[c] || []).slice(0, 2).join(' || ').slice(0, 500);
  A.eq((byClause.setup || []).length, 0, 'the world runs: the lifted hubs build and every agent.* payload fits shared/events.js — ' + show('setup'));
  A.eq((byClause.P1 || []).length, 0, 'P1 every finished reply lands line for line, exactly once (one extra copy per logged Telegram window) — ' + show('P1'));
  A.eq((byClause.P2 || []).length, 0, 'P2 per chat, replies land in the order they finished — ' + show('P2'));
  A.eq((byClause.P3 || []).length, 0, 'P3 a healthy chat\'s reply lands within one drain, whatever another chat does — ' + show('P3'));
  A.eq((byClause.P4 || []).length, 0, 'P4 no (message, tool step) pair runs twice — ' + show('P4'));
  A.eq((byClause.P5 || []).length, 0, 'P5 every acknowledged message gets exactly one terminal outcome, nothing is left pending — ' + show('P5'));
  A.eq((byClause.P6 || []).length, 0, 'P6 a reply refused for good is reported once and never retried — ' + show('P6'));
  A.eq(bySeed.length, 0, runs + ' seeds of ' + STEPS + ' steps: ' + bySeed.length + ' failed');

  // ---- the manifest: the lifted bags are the production calls' whole bags ----
  A.eq(Sim.manifestProblems(), [], 'every key of startTelegram\'s and startTelegramBot\'s makeChannelHub and makeTelegramAdapter calls is classified real or stub');

  // ---- the source lock: every hub stands over the station's store (or a view of it), or a named one-job fire ----
  // index.js's own structure is the subject (which store each hub it builds is given), so the exact file
  const lock = Sim.storeSiteProblems(readSidecarIndex());
  A.eq(lock.problems, [], 'every makeChannelHub and wireChannel site in index.js builds over channelStore, makeBotScopedStore(…) or perFireStore(…)');
  A.ok(lock.sites >= 7, 'the lock saw the station Telegram, agent bot, Discord, generic, dev, sample and trigger hubs (' + lock.sites + ' sites)');
  A.eq(lock.oneJob.sort(), Object.keys(Sim.ONE_JOB_SITES).sort(), 'the one-job hubs over perFireStore are exactly the named exemptions: ' + JSON.stringify(Sim.ONE_JOB_SITES));

  A.report('channels.delivery-ledger.property.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
