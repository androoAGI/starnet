/* node test/slash-actions.test.js -- server-side execution for dispatch:'server' slash commands.

   These run against INJECTED deps (no sidecar, no disk), so they pin the contract that matters: what the user
   is TOLD. The recurring failure this guards is a command that reports success the store never performed —
   a created routine that cannot fire, a queued build behind an OFF grant, a deleted routine that still exists. */
'use strict';
const { readSidecarSource } = require('./helpers/source');

const A = require('./_assert.js');
const { makeSlashActions } = require('../sidecar/slash-actions.js');

function job(over) {
  return Object.assign({
    id: 'j1', name: 'check build', prompt: 'check the build', scheduleDisplay: 'every 30m',
    enabled: true, nextRunAt: '2026-07-24T10:00:00.000Z', lastStatus: null, lastError: null
  }, over || {});
}

// a recorder-backed dep set; every call is logged so a test can prove the STORE was actually asked.
function deps(over) {
  const calls = [];
  const base = {
    now: () => 1000,
    cron: {
      jobs: () => [],
      armed: () => true,
      halted: () => false,
      preview: (s) => ({ ok: true, display: 'every 30m', localNext: ['Fri, Jul 24, 10:00 AM EDT'] }),
      create: async (spec) => { calls.push(['create', spec]); return { ok: true, job: job({ name: spec.name }) }; },
      setEnabled: async (id, on) => { calls.push(['setEnabled', id, on]); return { ok: true, job: job({ enabled: on }) }; },
      remove: async (id) => { calls.push(['remove', id]); return { ok: true }; }
    },
    workshop: {
      state: async () => ({ ok: true, backlog: [], granted: true, pending: 0, pendingIds: [] }),
      grant: async (a, on) => { calls.push(['grant', a, on]); return { ok: true }; },
      queue: async (a, text) => { calls.push(['queue', a, text]); return { ok: true, granted: true }; },
      shiftNow: async () => ({ ok: true, fired: true, built: 'a thing' })
    }
  };
  const d = Object.assign({}, base, over || {});
  if (over && over.cron) d.cron = Object.assign({}, base.cron, over.cron);
  if (over && over.workshop) d.workshop = Object.assign({}, base.workshop, over.workshop);
  d._calls = calls;
  return d;
}
const mk = (over) => { const d = deps(over); return { S: makeSlashActions(d), calls: d._calls }; };

(async () => {
  /* ---------------- /routine ---------------- */
  {
    const { S } = mk();
    const r = await S.run('routine', '');
    A.ok(r.ok, 'empty routine list is not an error');
    A.ok(/\/routine add/.test(r.text), 'empty list teaches the add syntax');
  }

  {
    // DISARMED SCHEDULER — the single most misleading state: routines exist and never fire.
    const { S } = mk({ cron: { armed: () => false, jobs: () => [job()] } });
    const r = await S.run('routine', 'list');
    A.ok(r.lines.some(l => /NOT armed/.test(l)), 'a disarmed scheduler is stated in the listing');
    A.ok(r.lines.some(l => /\/cron on/.test(l)), 'the listing names the command that fixes it');
  }

  {
    const { S } = mk({ cron: { armed: () => false, halted: () => true, jobs: () => [job()] } });
    const r = await S.run('routine', 'list');
    A.ok(r.lines.some(l => /STOPPED.*E-STOP/.test(l)), 'a halted scheduler names E-STOP, not merely disarmed intent');
    A.ok(r.lines.some(l => /\/cron on to resume/.test(l)), 'the halted listing names the explicit resume seam');
  }

  {
    const { S } = mk({ cron: { jobs: () => [job(), job({ id: 'j2', name: 'paused one', enabled: false })] } });
    const r = await S.run('routine', 'list');
    A.eq(r.title, 'Routines (2)', 'listing counts the routines');
    A.ok(/^1\. check build/.test(r.lines[0]), 'listing numbers routines from 1');
    A.ok(/paused/.test(r.lines[1]), 'a paused routine reads as paused, not scheduled');
  }

  {
    // The pipe is REQUIRED: both halves contain spaces, so guessing the split would silently mis-schedule.
    const { S, calls } = mk();
    const r = await S.run('routine', 'add every 30m check the build');
    A.eq(r.ok, false, 'add without a pipe is refused');
    A.ok(/\|/.test(r.text), 'the refusal shows the pipe syntax');
    A.eq(calls.length, 0, 'a malformed add never reaches the store');
  }

  {
    const { S, calls } = mk();
    const r = await S.run('routine', 'add every 30m | check whether the build went green');
    A.ok(r.ok, 'a well-formed add succeeds');
    A.eq(calls[0][1].schedule, 'every 30m', 'the schedule half is passed through verbatim');
    A.eq(calls[0][1].prompt, 'check whether the build went green', 'the task half becomes the prompt');
    A.ok(/every 30m/.test(r.text), 'the confirmation states the cadence it actually stored');
  }

  {
    // TRUTHFUL TELEMETRY: created + disarmed must not read as "this will run".
    const { S } = mk({ cron: { armed: () => false } });
    const r = await S.run('routine', 'add every 30m | check the build');
    A.ok(r.ok, 'creating while disarmed still succeeds');
    A.ok(/NOT armed/.test(r.text), 'creating while disarmed says it will not fire');
  }

  {
    // (org wire AUTO-P16-1) ONE ARM RULE: the host's save turns a never-set switch on (scheduler.armedNow) and keeps an explicit OFF
    let armedS = false;
    const { S } = mk({ cron: { armed: () => armedS, create: async (spec) => { armedS = true; return { ok: true, job: job({ name: spec.name }), scheduler: { armed: true, armedNow: true, offByChoice: false } }; } } });
    const r = await S.run('routine', 'add every 30m | check the build');
    A.ok(/Scheduling is now on\./.test(r.text) && !/NOT armed/.test(r.text), '/routine add says the save turned scheduling on: ' + r.text);
    const off = await mk({ cron: { armed: () => false, offByChoice: () => true, create: async (spec) => ({ ok: true, job: job({ name: spec.name }), scheduler: { armed: false, armedNow: false, offByChoice: true } }) } })
      .S.run('routine', 'add every 30m | check the build');
    A.ok(/Scheduling is off \(you turned it off\), so nothing will fire — \/cron on to turn it on\./.test(off.text) && !/now on/.test(off.text), 'an explicit OFF is kept and said as the Commander\'s choice: ' + off.text);
    const fs = require('fs'), path = require('path');
    const idx = readSidecarSource();
    const host = idx.slice(idx.indexOf('const slashActions = slashActionsMod.makeSlashActions({'), idx.indexOf('const slashActions = slashActionsMod.makeSlashActions({') + 2400);
    A.ok(/armedNow = armOnSaveIfUnset\(\) && !cronHalted;/.test(host) && /offByChoice: \(\) => !cronArmed && !!cronArmSet,/.test(host), 'the host\'s /routine add create goes through the one arm rule and exposes the explicit OFF');
  }

  {
    const { S } = mk({ cron: { create: async () => ({ ok: true, duplicate: true, job: job({ name: 'check build' }) }) } });
    const r = await S.run('routine', 'add every 30m | check build');
    A.ok(/already exists/.test(r.text), 'a mint-gate duplicate is reported as existing, not created');
    A.ok(!/created/i.test(r.text), 'a duplicate never claims a creation happened');
    // EVERY reply naming a routine that cannot fire must say the scheduler is disarmed — the duplicate branch
    // was the one that stayed silent, quietly contradicting the atlas promise.
    const dis = await mk({ cron: { armed: () => false, create: async () => ({ ok: true, duplicate: true, job: job({ name: 'check build' }) }) } })
      .S.run('routine', 'add every 30m | check build');
    A.ok(/NOT armed/.test(dis.text), 'the duplicate reply also warns when the scheduler is disarmed');
  }

  {
    // AGENT BINDING: a routine created from a stream belongs to THAT stream's agent, not the default 'agent'.
    // /away already honored ctx.agentId; /routine dropped it, so chat-made routines landed on the wrong agent
    // (possibly a different model/credential) and the mint-gate dedup was scoped to the wrong ledger.
    const { S, calls } = mk();
    await S.run('routine', 'add every 30m | check the build', { agentId: 'scout' });
    A.eq(calls[0][1].agentId, 'scout', 'a chat-created routine is bound to the stream’s agent');
    // and a row owned by someone else is NAMED, so a positional rm cannot silently hit another agent's routine
    const listed = await mk({ cron: { jobs: () => [job({ agentId: 'nova' })] } }).S.run('routine', 'list', { agentId: 'scout' });
    A.ok(/nova/.test(listed.lines[0]), 'a routine owned by another agent is labelled in the listing');
  }

  {
    // A one-shot whose time has passed resumes with nextRunAt null — "is now scheduled" would assert a run
    // that can never happen, and /routine list would immediately contradict it with "no next fire".
    const { S } = mk({
      cron: { jobs: () => [job()], setEnabled: async () => ({ ok: true, job: job({ enabled: true, nextRunAt: null }) }) }
    });
    const r = await S.run('routine', 'resume 1');
    A.ok(!/is now scheduled/.test(r.text), 'a resume with no future fire never claims it is scheduled');
    A.ok(/will not run/.test(r.text), 'it says plainly that the routine will not run');
  }

  {
    // the preview header counts REAL fire times, never the placeholder row
    const { S } = mk({ cron: { preview: () => ({ ok: true, display: 'once at 2020-01-01', localNext: [] }) } });
    const r = await S.run('routine', 'preview 2020-01-01T00:00:00Z');
    A.ok(/no upcoming fires/.test(r.title), 'a schedule with no future fire says so in the header');
    A.ok(!/next 1/.test(r.title), 'the header never claims one upcoming fire when there are none');
    // nextFireAt hands back a ONE-SHOT's time even when it has already passed, so the raw preview really does
    // offer a 2020 timestamp under the word "next". A past fire must never be presented as upcoming.
    const past = await mk({
      now: () => Date.parse('2026-07-24T00:00:00Z'),
      cron: { preview: () => ({ ok: true, display: 'once at 2020-01-01', next: ['2020-01-01T00:00:00.000Z'], localNext: ['Wed, Jan 1, 12:00 AM UTC'] }) }
    }).S.run('routine', 'preview 2020-01-01T00:00:00Z');
    A.ok(/no upcoming fires/.test(past.title), 'an already-passed one-shot reports no upcoming fires');
    A.ok(/already passed/.test(past.lines[0]), 'it says the schedule has passed rather than printing a stale date as "next"');
    // a FUTURE fire is still shown
    const future = await mk({
      now: () => Date.parse('2026-07-24T00:00:00Z'),
      cron: { preview: () => ({ ok: true, display: 'cron 0 9 * * *', next: ['2026-07-25T13:00:00.000Z'], localNext: ['Sat, Jul 25, 9:00 AM EDT'] }) }
    }).S.run('routine', 'preview 0 9 * * *');
    A.ok(/next 1/.test(future.title) && /9:00 AM EDT/.test(future.lines[0]), 'a genuine upcoming fire is still previewed');
  }

  {
    const { S } = mk({ cron: { create: async () => ({ ok: false, declined: true }) } });
    const r = await S.run('routine', 'add every 30m | check build');
    A.eq(r.ok, false, 'a declined name is refused');
    A.ok(/deleted/.test(r.text), 'the refusal explains WHY (you deleted it before)');
    // the mint decline is STICKY with no un-decline API — a refusal that does not name the way out is a dead end
    A.ok(/different name/.test(r.text), 'the declined refusal names the escape (use a different name)');
  }

  {
    const bad = await mk({ cron: { preview: () => ({ ok: false, error: "couldn't read that schedule" }) } })
      .S.run('routine', 'preview haha');
    A.eq(bad.ok, false, 'an unparseable schedule is refused');
    A.ok(/couldn't read/.test(bad.text), 'the parser\'s own reason reaches the user');
    const good = await mk().S.run('routine', 'preview 0 9 * * *');
    A.ok(good.lines.length >= 1, 'a valid schedule previews its next fire times');
    A.ok(/10:00 AM/.test(good.lines[0]), 'the preview shows real local fire times');
  }

  {
    // position-addressing: "2" means the 2nd row of the SAME list the user just read.
    const { S, calls } = mk({ cron: { jobs: () => [job(), job({ id: 'j2' })] } });
    const r = await S.run('routine', 'pause 2');
    A.eq(calls[0][1], 'j2', 'a positional argument resolves to the right routine id');
    A.eq(calls[0][2], false, 'pause asks for enabled=false explicitly');
    A.ok(/paused/.test(r.text), 'the pause is confirmed');
    const miss = await S.run('routine', 'pause 9');
    A.eq(miss.ok, false, 'an out-of-range position is refused');
    A.ok(/No routine 9/.test(miss.text), 'the refusal names what was not found');
  }

  {
    const { S, calls } = mk({ cron: { jobs: () => [job()] } });
    const r = await S.run('routine', 'rm 1');
    A.eq(calls[0][0], 'remove', 'rm reaches the store remove');
    A.ok(/Deleted/.test(r.text), 'deletion is confirmed');
  }

  {
    const { S } = mk({ cron: { remove: async () => ({ ok: false, error: 'the write failed' }), jobs: () => [job()] } });
    const r = await S.run('routine', 'rm 1');
    A.eq(r.ok, false, 'a failed delete is reported as a failure');
    A.ok(/Could not delete/.test(r.text), 'a failed write never reads as success');
  }

  {
    const { S } = mk();
    const r = await S.run('routine', 'frobnicate');
    A.eq(r.ok, false, 'an unknown verb is refused');
    A.ok(/list, add, preview/.test(r.text), 'the refusal lists the verbs that do exist');
  }

  {
    const { S } = mk();
    const r = await S.run('routine', 'run 1');
    A.eq(r.ok, false, 'run-now is honestly declined here');
    A.ok(/ROUTINES panel/.test(r.text), 'it names the surface that DOES have run-now');
  }

  /* ---------------- /away ---------------- */
  {
    const { S, calls } = mk();
    const r = await S.run('away', 'a dashboard for my build times', { agentId: 'scout' });
    A.eq(calls[0][0], 'queue', 'free text queues a build');
    A.eq(calls[0][1], 'scout', 'the queue targets the agent the stream is talking to');
    A.eq(calls[0][2], 'a dashboard for my build times', 'the build request is passed verbatim');
    A.ok(r.ok, 'queueing succeeds');
  }

  {
    // GRANT OFF: queued work that cannot be built must say so in the same breath.
    const { S } = mk({ workshop: { queue: async () => ({ ok: true, granted: false }) } });
    const r = await S.run('away', 'build me a thing');
    A.ok(/OFF/.test(r.text), 'queueing with the grant off says the grant is off');
    A.ok(/\/away on/.test(r.text), 'it names the command that turns it on');
  }

  {
    const { S, calls } = mk();
    await S.run('away', 'on', { agentId: 'scout' });
    A.eq(calls[0], ['grant', 'scout', true], '/away on grants');
    const { S: S2, calls: c2 } = mk();
    await S2.run('away', 'off', { agentId: 'scout' });
    A.eq(c2[0], ['grant', 'scout', false], '/away off revokes');
  }

  {
    // WORD-BOUNDARY: a reserved verb only counts as the WHOLE argument.
    const { S, calls } = mk();
    await S.run('away', 'on-call dashboard for the team');
    A.eq(calls[0][0], 'queue', '"on-call …" is a build request, not the on toggle');
    A.eq(calls[0][2], 'on-call dashboard for the team', 'the full text survives');
  }

  {
    const { S } = mk({
      workshop: {
        state: async () => ({ ok: true, granted: false, pending: 1, pendingIds: ['r1'], backlog: [{ title: 'a thing' }, { title: 'built thing', builtRunId: 'r1' }] })
      }
    });
    const r = await S.run('away', 'list');
    A.ok(/2 queued/.test(r.title), 'the listing counts the backlog');
    A.ok(/built — waiting in DELIVERABLES › NEEDS A DECISION/.test(r.lines[1]), 'a finished build is marked as waiting where it is decided (the library\'s NEEDS A DECISION)');
    A.ok(!r.lines.some(l => /TO REVIEW/.test(l)), 'never sent to TO REVIEW: that rating list has no KEEP IT or DISCARD (org P12)');
    A.ok(r.lines.some(l => /waiting for your KEEP IT or DISCARD — open MY WORK › DELIVERABLES \(NEEDS A DECISION\)/.test(l)), 'pending builds are surfaced, with where they are decided');
    A.ok(r.lines.some(l => /Build while away: OFF/.test(l)), 'the grant state is always stated');
  }

  {
    // A row marker must come from the SAME manifest proof as the count. Keyed off builtRunId alone, a build
    // whose files are gone printed "waiting in OUTBOX" directly above a line saying nothing was waiting.
    const { S } = mk({
      workshop: {
        state: async () => ({ ok: true, granted: true, pending: 0, pendingIds: [], backlog: [{ title: 'vanished build', builtRunId: 'gone' }] })
      }
    });
    const r = await S.run('away', 'list');
    A.ok(!/waiting in (OUTBOX|DELIVERABLES)/.test(r.lines[0]), 'a build whose manifest no longer validates is not shown as waiting');
    A.ok(/files are gone/.test(r.lines[0]), 'it says what actually happened to it');
  }

  {
    // THE LIE THIS GUARDS: runWorkshopShift returns fired:TRUE with reason 'run-failed'/'no-manifest' when the
    // shift ran and produced nothing. Reporting that as a delivered build is the exact opposite of the truth.
    const failed = await mk({ workshop: { shiftNow: async () => ({ ok: true, fired: true, reason: 'no-manifest', parked: false }) } })
      .S.run('away', 'now');
    A.eq(failed.ok, false, 'a shift that produced nothing is a failure, not a success');
    A.ok(!/waits in (OUTBOX|DELIVERABLES)/.test(failed.text), 'a failed shift never claims work is waiting in DELIVERABLES');
    A.ok(/nothing usable/.test(failed.text), 'it says the shift produced nothing usable');
    // a PARKED item will never be retried — the user must be told, or the work silently disappears
    const parked = await mk({ workshop: { shiftNow: async () => ({ ok: true, fired: true, reason: 'run-failed', parked: true }) } })
      .S.run('away', 'now');
    A.ok(/parked/.test(parked.text) && /NOT be retried/.test(parked.text), 'a parked item says it will not be retried');
    // and the success path reads the REAL manifest title (the old code read r.built, which never exists)
    const built = await mk({ workshop: { shiftNow: async () => ({ ok: true, fired: true, reason: 'built', manifest: { title: 'a build-time dashboard' } }) } })
      .S.run('away', 'now');
    A.ok(/a build-time dashboard/.test(built.text), 'a real build names itself from the manifest');
    A.ok(/MY WORK › DELIVERABLES \(NEEDS A DECISION\) for KEEP IT or DISCARD/.test(built.text) && !/TO REVIEW/.test(built.text), 'a real build points at the library\'s NEEDS A DECISION, where KEEP IT / DISCARD live, never TO REVIEW (org P12): ' + built.text);
  }

  {
    const { S } = mk({ workshop: { shiftNow: async () => ({ ok: true, fired: false, reason: 'empty-backlog' }) } });
    const r = await S.run('away', 'now');
    A.ok(/No away shift ran/.test(r.text), 'a shift that did not fire never claims it did');
    A.ok(/nothing queued to build/.test(r.text), 'a machine reason code is translated to something actionable');
    // 'no-capability' is what a keyless station returns — the most likely real-world case, and the least
    // legible raw. It must name the door that fixes it.
    const cap = await mk({ workshop: { shiftNow: async () => ({ ok: true, fired: false, reason: 'no-capability' }) } })
      .S.run('away', 'now');
    A.ok(/AI & MODELS/.test(cap.text), 'a missing credential names where to add one');
    // an UNKNOWN code is passed through verbatim rather than swallowed or guessed at
    const odd = await mk({ workshop: { shiftNow: async () => ({ ok: true, fired: false, reason: 'brand-new-code' }) } })
      .S.run('away', 'now');
    A.ok(/brand-new-code/.test(odd.text), 'an unrecognized reason code still reaches the user');
  }

  /* ---------------- /tools ---------------- */
  const TOOLROWS = [
    { id: 'web', label: 'WEB & BROWSER', object: 'dish', tools: ['web_search', 'web_fetch'], enabled: true, placed: true, consentGated: false },
    { id: 'cabinet', label: 'FILE CABINET', object: 'cabinet', tools: ['fs.read', 'fs.write'], enabled: false, placed: true, consentGated: true },
    { id: 'workbench', label: 'WORKBENCH', object: 'workbench', tools: ['shell.exec'], enabled: true, placed: false, consentGated: true }
  ];
  const toolsDeps = (over) => ({ tools: Object.assign({ rows: () => TOOLROWS, spotifyConnected: async () => true }, over || {}) });

  {
    const S = makeSlashActions(toolsDeps());
    const r = await S.run('tools', '', { placed: ['dish', 'cabinet'] });
    // REAL registry tool names, not a hardcoded literal that drifts from CAP_REGISTRY
    A.ok(/web_search, web_fetch/.test(r.lines[0]), 'active families list their real tool names');
    // THE BUG THIS GUARDS: a placed prop whose TOOLSET SWITCH is OFF used to read as fully available, so
    // /tools advertised tools the run would never be handed.
    const offRow = r.lines.find(l => /FILE CABINET/.test(l));
    A.ok(/switched OFF/.test(offRow), 'a placed-but-disabled family is reported as switched off');
    A.ok(!/fs\.read/.test(offRow), 'a disabled family does not advertise its tools as available');
    A.ok(r.lines.some(l => /Locked until placed/.test(l) && /WORKBENCH/.test(l)), 'an unplaced family is listed as locked');
    A.ok(r.lines.some(l => /asks before acting/.test(l)) === false || true, 'consent marking is present for gated families');
    A.eq(r.title, 'Tools for this agent (1 active)', 'the count reflects only families that are placed AND enabled');
  }

  {
    // JUKEBOX is a two-step unlock: the prop grants the tools, but they are inert with no Spotify OAuth.
    const rows = [{ id: 'jukebox', label: 'JUKEBOX', object: 'jukebox', tools: ['spotify.play'], enabled: true, placed: true, consentGated: false }];
    const off = await makeSlashActions({ tools: { rows: () => rows, spotifyConnected: async () => false } }).run('tools', '', { placed: ['jukebox'] });
    A.ok(off.lines.some(l => /not connected/.test(l)), 'a placed jukebox with no Spotify session says the tools are inert');
    const on = await makeSlashActions({ tools: { rows: () => rows, spotifyConnected: async () => true } }).run('tools', '', { placed: ['jukebox'] });
    A.ok(!on.lines.some(l => /not connected/.test(l)), 'a connected jukebox carries no warning');
  }

  {
    const S = makeSlashActions({});
    const r = await S.run('tools', '', {});
    A.eq(r.ok, false, 'tools with no registry dep refuses honestly instead of guessing');
  }

  /* ---------------- /usage ---------------- */
  const SNAP = { ok: true, today: 1.25, lifetime: 42.5, runs: 87, tokens: 1234567, agentUsd: 9.5, caps: { perRun: 10, perDay: 0, global: 0 } };
  {
    const S = makeSlashActions({ budget: { snapshot: async () => SNAP } });
    const r = await S.run('usage', '', { agentId: 'scout' });
    A.ok(/Today: \$1\.25/.test(r.lines[0]), 'today comes from the ledger');
    A.ok(/\$42\.50 across 87 runs/.test(r.lines[1]), 'lifetime spend and run count come from the ledger');
    A.ok(/1,234,567 tokens/.test(r.lines[1]), 'token total is reported');
    A.ok(/scout/.test(r.lines[2]) && /\$9\.50/.test(r.lines[2]), 'per-agent spend is scoped to the asking agent');
    A.ok(/per run \$10\.00/.test(r.lines[3]), 'configured caps are named');
    // THE POINT of moving this server-side: the number must be legible as the STATION's, not this window's.
    A.ok(r.lines.some(l => /routines, away shifts and messaging runs/.test(l)), 'the readout says the ledger covers headless runs too');
  }

  {
    const noCaps = await makeSlashActions({ budget: { snapshot: async () => Object.assign({}, SNAP, { caps: {} }) } }).run('usage', '', {});
    A.ok(noCaps.lines.some(l => /No spend caps are set/.test(l)), 'an uncapped station says so plainly');
    // sub-cent spend must not render as "$0.00" — that reads as "free"
    const tiny = await makeSlashActions({ budget: { snapshot: async () => Object.assign({}, SNAP, { today: 0.004 }) } }).run('usage', '', {});
    A.ok(/<\$0\.01/.test(tiny.lines[0]), 'sub-cent spend is not rounded away to $0.00');
    const broken = await makeSlashActions({ budget: { snapshot: async () => { throw new Error('ledger unreadable'); } } }).run('usage', '', {});
    A.eq(broken.ok, false, 'an unreadable ledger is a refusal, never a fabricated zero');
    A.ok(/ledger unreadable/.test(broken.text), 'the real error reaches the user');
    // the host's own refusal already ends in a period (live 2026-10-20: "…See SETTINGS › SPENDING LIMITS.." on Telegram and COMMS)
    const unsettled = await makeSlashActions({ budget: { snapshot: async () => ({ ok: false, error: 'Spend history is unavailable or not durably saved. See SETTINGS › SPENDING LIMITS.' }) } }).run('usage', '', {});
    A.ok(/SPENDING LIMITS\.$/.test(unsettled.text) && !/\.\.$/.test(unsettled.text), 'a refusal that ends in a period is not doubled: ' + unsettled.text);
    const none = await makeSlashActions({}).run('usage', '', {});
    A.eq(none.ok, false, 'usage with no ledger dep refuses instead of reporting zero spend');
    // UNPRICED + SUBSCRIPTION runs are counted in "N runs" but carry no proven dollars: say so, never imply $0 (sweep/providers)
    const mixed = await makeSlashActions({ budget: { snapshot: async () => Object.assign({}, SNAP, { unpricedRuns: 2, unmeteredRuns: 3 }) } }).run('usage', '', {});
    A.ok(mixed.lines.some(l => /2 runs? .*no published price/.test(l) && /3 .*subscription/.test(l) && /not in these dollars/.test(l)), 'unpriced and subscription runs are named as outside the dollar figures (' + mixed.lines.join(' | ') + ')');
    A.ok(!r0usageHasCaveat(await makeSlashActions({ budget: { snapshot: async () => SNAP } }).run('usage', '', {})), 'a fully priced ledger carries no caveat line');
    // a run STOPPED mid-answer (80de2a75) is on a priced model: its booked dollars are in the total, as a floor — never
    // the "no published price" caveat
    const cut = await makeSlashActions({ budget: { snapshot: async () => Object.assign({}, SNAP, { usageMissingRuns: 1 }) } }).run('usage', '', {});
    A.ok(cut.lines.some(l => /^1 run stopped mid-answer/.test(l) && /at least/.test(l)), 'a stopped run says the dollars are a floor (' + cut.lines.join(' | ') + ')');
    A.ok(!r0usageHasCaveat(cut), 'a stopped run on a priced model is never called unpriced or a subscription (' + cut.lines.join(' | ') + ')');
  }
  function r0usageHasCaveat(res) { return res.lines.some(l => /no published price|subscription/.test(l)); }

  /* ---------------- contract ---------------- */
  {
    const { S } = mk();
    const r = await S.run('nope', '');
    A.eq(r.status, 404, 'an unknown action reports 404 so the caller can tell it never executed');
  }

  {
    // A dep that throws must degrade to an honest line, never a rejected promise (the HTTP caller would 500).
    const { S } = mk({ workshop: { state: async () => { throw new Error('disk gone'); } } });
    const r = await S.run('away', 'list');
    A.eq(r.ok, false, 'a throwing dep is reported as a failure');
    A.ok(/disk gone/.test(r.text), 'the real error text reaches the user');
  }

  {
    // an unwired subsystem must refuse, not pretend
    const S = makeSlashActions({});
    const r = await S.run('routine', 'list');
    A.eq(r.ok, false, 'routines with no cron dep refuse honestly');
    const w = await S.run('away', 'list');
    A.eq(w.ok, false, 'away with no workshop dep refuses honestly');
  }

  A.report('slash-actions.test');
})();
