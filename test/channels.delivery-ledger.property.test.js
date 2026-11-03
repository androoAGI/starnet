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
   "stop", slash commands, overheard group lines, edits of older messages, CORRECTIONS (the latest message edited twice,
   each edit with its own edit_date, the second while the first one's run works) and choice TAPS (some runs end by asking,
   and the lifted hub's TaskIntent and prompt registry make that a keyboard: mostly the newest live one is tapped, now and
   then any one, a dead process's included, or a second button of it; and now and then the station dies while a tapped
   choice is worked on). It draws faults at the delivery's await boundaries: retryable, refused-for-good and
   refused-credential sends; a lost response (the platform took it); a crash before a send, after the platform took a part
   and before its mark, and inside a receipt or answer write; write failures (EBUSY, UPDATE_MUTATIONS_FROZEN) while sends
   succeed; the update barrier; a lane pushed past its backpressure mark and a channel's receipt cap; a membership kick and
   the unblock; a chat that is down for 20-50 s (every send to it fails) while its members keep writing, and the healthy
   chat (the Telegram or the Discord DM, by seed) blips once. After the script nothing new is drawn for 20 s while P3 is
   still checked; then it heals everything and drains.
     P1 every finished reply lands line for line, exactly once. THE BOUNDARY: a part the platform took in the instant the
        process died, or whose answer was lost, may land once more on Telegram (each such window event is logged and
        allows one extra copy of exactly that part); on Discord, never. A durable delivery always lands or is given up.
        "Finished" is the run host's fact (review round 1), never the ledger's own record: every run that ended 'done'
        must land in its chat, unless its signal was aborted by then (taken back), its process died in that instant, or
        its writes were failing when it ended and no later write reached the disk before its process died. And a reply
        is given up only on a fact at the transport edge: the platform refused one of its parts for good (400, 403), or
        its chat removed the bot between its finish and its tombstone.
     P2 per chat, replies land in the order they finished.
     P3 a healthy chat's reply lands within one drain, whatever another chat does: 16 s from its finish (or from the end
        of a hold or write-failure span) — its own blip costs the adapter's 1 s resend and its lane's 5 s retry. Since
        review round 1 its messages also get in: acknowledged (another chat's waiting messages never fill the channel's
        intake) and run, or joined to its working run, within one drain, unless its own lane held them back.
     P4 no (message, tool step) pair runs twice — under live write failures too, and with the station dying inside a
        write-failure span (review round 1: there is no crash boundary any more; a run starts, and a step is dispatched,
        only once its mark is on the disk). A part the platform took, or refused for good, after its process's last
        durable write is logged as a window event, like one taken in the instant of a crash; so is a keyboard whose open
        ask had not reached the disk.
     P5 every acknowledged message gets exactly one terminal outcome (a run, one re-run after a 0-step attempt, an
        interrupted notice, or a settle), nothing is left pending, and a merged batch's answer settles all its receipts.
        Edits and taps are inbound too: a correction of the latest message runs (the second one as well, never taken for
        a redelivery of the first); a tap that took its button ends once (its choice answered, said to be interrupted,
        stopped, superseded or joined to a live run), whatever crashed after it was acknowledged, and a refused tap runs
        nothing; a keyboard is stamped once at most, and nothing ever quotes a message no member sent. Since review round
        1: a follow-up joins the working run or runs, never both and never twice; a slash command runs at most once; and
        every message Discord's gateway handed over gets a receipt (it never hands a refused one over again).
     P6 a reply refused for good is reported once and never tried again; no finished reply is dropped for capacity.
     P7 a routine's parts are never resent (S4): two routines (one to the Telegram group, one to the Discord DM) fire now
        and then, each settled through the REAL cron driver and delivered by the REAL makeRoutineDelivery on the outbound
        contract, ticked every 5 s and asked again at boot; each line of a digest lands at most once under the same window
        rule as P1 (on Discord, never twice), a digest whose first part reached its chat lands whole, unless it was given
        up and said so or a newer result replaced it with no part marked (then only a part in the window can be on the
        wire), and once everything drained no result is left pending but one given up.
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
const Bags = require('./helpers/channel-hub-bags.js');

const STEPS = 40;
const FROM = process.env.CDL_SEED ? Number(process.env.CDL_SEED) : 1;
const TO = process.env.CDL_SEED ? Number(process.env.CDL_SEED) : 40;
const CLAUSES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];

(async () => {
  const bySeed = [];
  const byClause = {};
  const mix = { tapsTaken: 0, tapsRefused: 0, tapCrashes: 0, corrections: 0 };
  const rmix = { fired: 0, landed: 0, retried: 0, withdrawn: 0 };
  const xmix = { crashInWriteSpan: 0, followupsJoined: 0, slashCommands: 0, discordKept: 0 };
  for (let seed = FROM; seed <= TO; seed++) {
    const w = Sim.makeWorld(seed, {});
    const r = await w.run(STEPS);
    const m = w.mix();
    for (const k of Object.keys(mix)) mix[k] += m[k];
    const x = w.xmix();
    for (const k of Object.keys(xmix)) xmix[k] += x[k];
    const rm = w.routineMix();
    for (const k of Object.keys(rmix)) rmix[k] += rm[k];
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
  A.ok(runs === 1 || Object.keys(mix).every(k => mix[k] > 0), 'fixture: the seeds drew corrections, taps that took their button, refused taps and a crash while a tapped choice was worked on ' + JSON.stringify(mix));
  A.ok(runs === 1 || Object.keys(xmix).every(k => xmix[k] > 0), 'fixture: the seeds drew a crash inside a write-failure span, follow-ups that joined a working run, slash commands, and Discord messages kept through a refused receipt ' + JSON.stringify(xmix));
  A.eq((byClause.P1 || []).length, 0, 'P1 every finished reply lands line for line, exactly once (one extra copy per logged Telegram window) — ' + show('P1'));
  A.eq((byClause.P2 || []).length, 0, 'P2 per chat, replies land in the order they finished — ' + show('P2'));
  A.eq((byClause.P3 || []).length, 0, 'P3 a healthy chat\'s reply lands within one drain, whatever another chat does — ' + show('P3'));
  A.eq((byClause.P4 || []).length, 0, 'P4 no (message, tool step) pair runs twice — ' + show('P4'));
  A.eq((byClause.P5 || []).length, 0, 'P5 every acknowledged message, edit and tap gets exactly one terminal outcome, nothing is left pending — ' + show('P5'));
  A.eq((byClause.P6 || []).length, 0, 'P6 a reply refused for good is reported once and never retried — ' + show('P6'));
  A.ok(runs === 1 || (rmix.fired > 0 && rmix.landed > 0 && rmix.retried > 0 && rmix.withdrawn > 0), 'fixture: routines fired, landed, some had a part refused or cut by a crash, and some were replaced before anything of them went ' + JSON.stringify(rmix));
  A.eq((byClause.P7 || []).length, 0, 'P7 a routine\'s parts are never resent (one extra copy per logged Telegram window), and a started digest lands whole — ' + show('P7'));
  A.eq(bySeed.length, 0, runs + ' seeds of ' + STEPS + ' steps: ' + bySeed.length + ' failed');

  // ---- the manifest: the lifted bags are the production calls' whole bags ----
  A.eq(Sim.manifestProblems(), [], 'every key of startTelegram\'s and startTelegramBot\'s makeChannelHub and makeTelegramAdapter calls is classified real or stub');

  // ---- the source lock: every hub stands over the station's store (or a view of it), or a named one-job fire ----
  // index.js's own structure is the subject (which store each hub it builds is given), so the exact file
  const actualSource = readSidecarIndex(), lock = Sim.storeSiteProblems(actualSource);
  A.eq(lock.problems, [], 'every makeChannelHub and wireChannel site in index.js builds over channelStore, makeBotScopedStore(…) or perFireStore(…)');
  A.eq(lock.sites, 7, 'the census sees exactly the seven production constructor sites');
  A.eq(lock.kinds, ['telegram', 'telegram-bot', 'discord', 'slack', 'matrix', 'signal', 'dev', 'sample', 'trigger', 'handoff'],
    'the shared generic and trigger constructors expand to all ten effective kinds');
  const common = Bags.topLevel(actualSource, 'makeHubDeps');
  A.ok(!!common && /store: channelStore,/.test(common), 'the common factory has the actual station store binding');
  const changed = actualSource.replace(common, common.replace('store: channelStore,', 'store: unrelatedStore,'));
  A.ok(Sim.storeSiteProblems(changed).problems.length > 0, 'negative control rejects an unrelated shared factory store');
  A.eq(lock.oneJob.sort(), Object.keys(Sim.ONE_JOB_SITES).sort(), 'the one-job hubs over perFireStore are exactly the named exemptions: ' + JSON.stringify(Sim.ONE_JOB_SITES));

  A.report('channels.delivery-ledger.property.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
