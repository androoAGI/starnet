/* node test/station-gathering.test.js — TIER E, THE GATHERING.

   THE ASK, verbatim: "every so often if the station is quiet, they will all be gathered into an area
   big group, and then the overseer who is by himself, looking at the agents, and talking in his
   language... they all scatter like cockroaches when the user comes back, and they pretend like
   everything's normal."

   Four of those clauses are load-bearing and each has a specific way of silently dying, so each is a
   lock rather than a comment:

     1. THE ROAM LEASH IS SUSPENDED. Every other walk target in world.js is zone-clamped to the mover's
        own 14-tile leash. A station-wide assembly is bodies leaving their areas, so if some later
        "consistency" pass re-adds tileInZone to the gathering's tile resolution, no tile is inside
        every body's leash, planGathering returns null forever, and the feature becomes nothing at
        all — with no error and no failing test. That is the most dangerous regression here.
     2. WORK OUTRANKS THE ASSEMBLY. Same law as the social beat (G2/K3).
     3. THE COMMANDER RETURNING IS AN EXIT, and it is the PRIMARY one — the trigger needs 30 minutes
        of unattended quiet, so the likely end of any gathering is somebody walking back to the desk.
     4. THE OVERSEER BREAKS LAST. Deleting the delay breaks no behaviour a normal test would notice;
        it just quietly removes the Planet-of-the-Apes shot the whole beat exists for.

   Plus the standing product law: the station must never ACKNOWLEDGE the gathering. No COMMS beat, no
   toast, no event, nothing persisted — a gathering the harness could prove would stop being
   unsettling, and would assert coordination that never happened.

   Source-text discipline as in social-trio.test.js: world.js is a browser IIFE, so this reads the
   real source. Comments are stripped before every structural sweep — a test that passes on a code
   COMMENT proves nothing (that has bitten this repo before). */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const code = strip(src);

const fn = (name, endMarker) => {
  const i = code.indexOf('function ' + name + '(');
  A.ok(i >= 0, 'world.js still defines ' + name + '()');
  const j = endMarker ? code.indexOf(endMarker, i) : -1;
  return code.slice(i, j > i ? j : i + 4000);
};

/* ---- the beat exists at all ---- */
{
  for (const f of ['planGathering', 'startGathering', 'stepGather', 'endGathering', 'gatheringBroken', 'maybeGather', 'stepGatheringStation']) {
    A.ok(code.indexOf('function ' + f + '(') >= 0, f + '() exists in the shipped source');
  }
  A.ok(/let gathering = null/.test(code), 'the assembly is ONE station-wide slot, like socialBeat');
}

/* ---- 1. THE ROAM LEASH IS SUSPENDED (the silent-death regression) ---- */
{
  const plan = fn('planGathering', 'function maybeGather');
  A.ok(/geo\.walkable\(/.test(plan), 'the formation resolves tiles against real walkability');
  A.eq(/tileInZone\(/.test(plan), false,
    'planGathering must NOT zone-clamp — no tile is inside every body\'s 14-tile leash, so a clamp here means the gathering can never assemble');
  const step = fn('stepGather', 'function gatherStateSnapshot');
  A.eq(/tileInZone\(/.test(step), false, 'and the stepper must not re-clamp the walk either');
  // the exception must be documented where someone would "fix" it — this one IS worth asserting,
  // because the whole defence against the regression is that the next reader understands why.
  A.ok(/ROAM LEASH IS SUSPENDED/.test(src), 'the deliberate exception is documented in the source');
}

/* ---- the formation is resolved UP FRONT, one distinct slot per body ---- */
{
  const plan = fn('planGathering', 'function maybeGather');
  A.ok(/free\.splice\(bi, 1\)/.test(plan), 'each body is assigned its OWN slot, removed from the free pool (no two bodies share a tile)');
  A.ok(/if \(slots\.length < audience\.length\) return null/.test(plan),
    'a floor that cannot seat the whole party stages NOTHING — better no gathering than half of one');
  A.ok(/return null/.test(plan), 'planGathering can decline');
  const start = fn('startGathering', 'function gatheringBroken');
  A.ok(/GATHER_MIN_BODIES/.test(start), 'an assembly needs a minimum party (two agents is a huddle, not a gathering)');
  A.ok(/bodyIsIdle\(b, now\)/.test(start) && /!b\.working/.test(start), 'only genuinely idle, non-working bodies are gathered');
}

/* ---- 2. WORK OUTRANKS THE ASSEMBLY ---- */
{
  const broken = fn('gatheringBroken', 'function endGathering');
  A.ok(/b\.working/.test(broken), 'any participant starting real work breaks the gathering');
  A.ok(/activity === 'task'/.test(broken), 'a summoned hero breaks it');
  A.ok(/chatHot\(now\)/.test(broken), 'a live chat stare breaks it');
  // the per-body stepper must sit BELOW the working seize, exactly where the social stepper sits
  A.ok(code.indexOf("if (self.goal === 'gather')") > code.indexOf("if (self.goal === 'social')"),
    'the gather stepper runs at the same depth as the social one — below the b.working seize in stepCrew');
}

/* ---- 3. THE COMMANDER RETURNING IS THE PRIMARY EXIT ---- */
{
  const broken = fn('gatheringBroken', 'function endGathering');
  A.ok(/cursorPresent\(now\)/.test(broken), 'the Commander moving the cursor scatters the assembly');
  A.ok(/pageVisible\(\)/.test(broken), 'the tab going away ends it too');
  const maybe = fn('maybeGather', 'function startGathering');
  A.ok(/pageVisible\(\)/.test(maybe),
    'it only STARTS while the page is visible — an idle-only trigger fires all night into an empty room and the one feature whose point is being seen goes unwitnessed');
  A.ok(/cursorPresent\(now\)/.test(maybe), 'and never while the Commander is actually there');
  A.ok(/GATHER_QUIET_MS/.test(maybe), 'the station must have been unattended for the quiet window');
  A.ok(/U\.chance\(GATHER_CHANCE\)/.test(maybe), 'even then it is a roll, not a schedule');
  A.ok(/gatherRollAt = now \+ GATHER_ROLL_EVERY_MS/.test(maybe), 'the roll is armed win OR lose, so it stays at most hourly');
}

/* ---- 4. THE OVERSEER BREAKS LAST ---- */
{
  const end = fn('endGathering', 'function releaseFromGathering');
  A.ok(/if \(b\.id === overseerId && scatter\) continue/.test(end),
    'on a scatter every OTHER body is released immediately and the overseer is skipped');
  A.ok(/phase = 'breaking'/.test(end), 'the slot survives briefly so the overseer can hold his beat');
  const station = fn('stepGatheringStation', 'function gatherSpeak');
  A.ok(/OVERSEER_BREAK_MS/.test(station), 'and he is released only after that delay');
  A.ok(/const OVERSEER_BREAK_MS = \d+/.test(code), 'the delay is a real positive constant, not zero');
  A.ok(Number((src.match(/const OVERSEER_BREAK_MS = (\d+)/) || [])[1]) > 0, 'the overseer genuinely lingers');
  // scatter must be MOVEMENT, not a state flip: released bodies re-decide immediately
  const rel = fn('releaseFromGathering', 'function stepGatheringStation');
  A.ok(/scatter \? now :/.test(rel), 'a scattered body re-decides on the NEXT tick so it visibly walks off, rather than snapping to an idle pose');
}

/* ---- the slot can never leak ---- */
{
  A.ok(/if \(now >= gathering\.until\) \{ endGathering\(now, false\); return; \}/.test(code),
    'a whole-beat hard timeout always frees the slot');
  A.ok(/const GATHER_HARD_MS = \d+/.test(code), 'the hard timeout is a real constant');
  const hard = Number((src.match(/const GATHER_HARD_MS = (\d+)/) || [])[1]);
  const holdMax = Number((src.match(/GATHER_HOLD_MIN = \d+, GATHER_HOLD_MAX = (\d+)/) || [])[1]);
  const conv = Number((src.match(/const GATHER_CONVERGE_MS = (\d+)/) || [])[1]);
  A.ok(hard > conv + holdMax, 'the hard timeout exceeds converge + longest hold, or the cap would end every gathering instead of the hold');
  A.ok(/stepGatheringStation\(now\);/.test(code) && /if \(!gathering(?: && !cineRested\(now\))?\) maybeGather\(now\);/.test(code),   // (the idle renderer's crew settle: a resting station calls no new one)
    'the phase machine + selection are ticked at STATION level, so a tick where no participant steps still frees the slot');
}

/* ---- the assembly and the ordinary social lane are mutually exclusive ---- */
{
  const elig = fn('socialEligible', 'function participantIds');
  A.ok(/b\.gather \|\| gathering/.test(elig), 'no huddle may start inside a gathering, or pull a body out of the formation');
  const maybe = fn('maybeGather', 'function startGathering');
  A.ok(/if \(gathering \|\| socialBeat\) return false/.test(maybe), 'and a gathering never starts on top of a live encounter');
}

/* ---- the overseer speaks, and the crowd does NOT ---- */
{
  const step = fn('stepGather', 'function gatherStateSnapshot');
  A.ok(/role === 'overseer'/.test(step), 'the stepper distinguishes the overseer from the audience');
  A.ok(/gatherSpeak\(self, now\)/.test(step), 'only the overseer speaks');
  A.eq(/gatherSpeak/.test(step.slice(step.indexOf('} else {'))), false,
    'the audience branch never speaks — this is a formation with one speaker, not a four-body conversation');
  const speak = fn('gatherSpeak', 'function stepGather');
  /* the glyph-speech law, re-applied: seeding a line on a TURN INDEX made every agent replay one
     identical script for the life of the station, because the index resets each encounter. */
  A.ok(/U\.hash\(String\(b\.id\) \+ '@' \+ Math\.round\(until\)\)/.test(speak),
    'the overseer\'s line is seeded on the ABSOLUTE deadline, never a turn index');
  A.ok(/glyphPhrase\(/.test(speak), 'he speaks the untranscribable tongue, not text');
}

/* ---- TRUTHFUL TELEMETRY: the station never admits it happened ---- */
{
  // bound the block by real CODE either side (the section comments are stripped above, so a comment
  // marker here silently slices to end-of-file and the sweep passes on the whole module)
  const start = code.indexOf('let gathering = null');
  const end = code.indexOf('const CURSOR_FRESH_MS', start);
  A.ok(start >= 0 && end > start, 'located the gathering block by code markers, not comments');
  const block = code.slice(start, end);
  A.ok(block.length > 500 && block.length < 20000, 'the block is the gathering itself, not half the module');
  for (const forbidden of ['U.bus.emit', 'Channels.', 'toast', 'fetch(', 'localStorage', 'beat(']) {
    A.eq(block.indexOf(forbidden) >= 0, false,
      'the gathering never announces itself (' + forbidden + ') — a provable gathering stops being unsettling and would assert coordination that never happened');
  }
}

/* ---- the dev hooks force FREQUENCY only, never legality ---- */
{
  A.ok(/_dbgGatherNow: \(\) =>/.test(src), 'the force hook exists (a 30-minute-quiet beat is unobservable without one)');
  const hook = src.slice(src.indexOf('_dbgGatherNow: () =>'), src.indexOf('_dbgGatherState:'));
  A.ok(/gatherGateUntil = -1e9/.test(hook), 'it clears the frequency cooldown');
  A.ok(/startGathering\(now\)/.test(hook), 'and then goes through the REAL startGathering, so every legality gate still runs');
  A.eq(/gathering = \{/.test(hook), false, 'it never stages an assembly of its own — a staged pass must not be able to print success');
  A.ok(/finally \{ self = keep; \}/.test(hook), 'it restores the borrowed `self` (B1)');
  const ret = src.slice(src.indexOf('_dbgGatherReturn: () =>'), src.indexOf('_dbgAffinity:'));
  A.ok(/gatheringBroken\(now\)/.test(ret), 'the scatter hook drives the REAL predicate, not a staged teardown');
}

A.report('station-gathering.test');
