/* node test/roster-track.test.js — S3: the meters become LOAD-BEARING without gating anything.

   An agent's earned track record is published onto the roster and rendered on the lead's [ORCHESTRATION]
   dispatch list, so delegation is an informed pick instead of a coin flip. Three things must hold, and each
   one is a way this slice could quietly go wrong:

     1. TRIGGER DISCIPLINE — the roster republishes ONLY on a coarse credential change. Ordinary work must not
        fire it, or every run POSTs every agent's whole composed system prompt back to the sidecar.
     2. NO GATE, NO RANK — an agent that has proved nothing is described exactly as it is today. No
        "unproven" label, no threshold anywhere near the dispatch path.
     3. THE BRIEFING TELLS THE TRUTH — the sidecar renders what the browser published, and a station with no
        proven crew produces a byte-identical briefing to the pre-S3 one (no dangling legend).

   Layer 1+2 run the REAL XpStore against the real Xp engine; layer 3 is a source guard on sidecar/index.js
   (the briefing is built deep inside a 6.5k-line request path, the same reason beat-coordination.test guards
   chat.js at the source). */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const Xp = require('../frontend/app/xp.js');

/* ---------- 1 + 2: the live store's republish trigger ---------- */
global.Xp = Xp;
global.World = undefined;
global.document = { getElementById: () => null };
const { XpStore } = require('../frontend/app/xpstore.js');

const agent = { id: 'researcher', name: 'RESEARCHER', stats: Xp.fresh() };
const fired = [];
XpStore.init({
  getAgent: id => ((id === 'researcher' || id == null) ? agent : null),
  persist: () => {},
  onCredential: (agentId, key) => fired.push({ agentId, key }),
});

const runEnd = (reason, runId) => XpStore.onEvent('agent.run.end', { agentId: 'researcher', runId, reason, turns: 1, usd: 0 });

// a fresh agent publishes nothing at all — the dispatch list must describe it exactly as it does today
A.eq(Xp.credential(agent.stats).text, '', 'a fresh specialist has no track record to publish');
A.eq(fired.length, 0, 'and nothing has been republished yet');

// the first three attributable runs cross MIN_RUNS and calibrate the finish rate -> ONE republish
for (let i = 0; i < 3; i++) runEnd('done', 'r' + i);
A.eq(fired.length, 1, 'crossing into a real credential republishes the roster exactly once');
A.eq(fired[0].agentId, 'researcher', 'the republish names the agent whose record moved');
A.ok(/dependable/.test(fired[0].key), 'the new key carries the freshly-earned finish-rate band');

// crossing the FIRST experience tier is a real change too, so it republishes once (and only once)
for (let i = 3; i < 5; i++) runEnd('done', 'r' + i);
A.eq(fired.length, 2, 'crossing the 5-task tier is a genuine change and republishes once');
A.ok(/^5\|/.test(fired[1].key), 'the republished key carries the newly-earned tier');

/* THE CHURN GUARD: between boundaries, more of the same work must republish NOTHING. The window below sits
   entirely between the 5- and 25-task tiers precisely so a legitimate crossing cannot be mistaken for churn
   (the first draft of this test spanned the 5-tier and failed for that reason, not because of a defect). */
const afterFirst = fired.length;
for (let i = 5; i < 20; i++) runEnd('done', 'r' + i);
XpStore.onEvent('agent.tool_result', { agentId: 'researcher', runId: 'r5', callId: 'c', ok: true, isError: false });
XpStore.onEvent('workitem.delivered', { agentId: 'researcher', workitemId: 'w', finalQueueId: 'q' });
A.eq(fired.length, afterFirst, 'fifteen more clean runs republish NOTHING (the credential is quantized for exactly this)');
A.ok(agent.stats.counters.tasksDone >= 20, '…even though the real task count kept climbing');

// a genuine tier crossing DOES republish, once
for (let i = 20; i < 25; i++) runEnd('done', 'r' + i);
A.eq(fired.length, afterFirst + 1, 'crossing the 25-task tier republishes exactly once more');
A.ok(/^25\|/.test(fired[fired.length - 1].key), 'the republished key carries the new tier');

// and a rating that flips the Commander-rating band republishes too (a different, independent source)
const before = fired.length;
for (let i = 0; i < 3; i++) XpStore.onEvent('memory.feedback', { agentId: 'researcher', id: 'm' + i, runId: 'r1', delta: 2, reason: 'work_great' });
A.ok(fired.length > before, 'the Commander rating calibrating is itself a real credential change');
A.ok(/25\|/.test(fired[fired.length - 1].key) && fired[fired.length - 1].key.split('|').filter(Boolean).length === 3, 'the key now carries tier + both bands');

// the whole mechanism is a READOUT: none of it moved the ladder on its own
A.eq(agent.stats.level >= 1, true, 'the agent still has a level');
const xpFromRatings = agent.stats.xp;
runEnd('done', 'tail');
A.eq(agent.stats.xp, xpFromRatings, 'a completed run still mints NO XP — S3 changed nothing about the XP law');

/* ---------- 3: the sidecar renders it, and stays silent when there is nothing to say ---------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
const iTeam = src.indexOf("teamNote = '\\n\\n[ORCHESTRATION]");
A.ok(iTeam > 0, 'sidecar/index.js still builds the [ORCHESTRATION] dispatch briefing');
const teamEnd = src.indexOf('let skillBlock', iTeam);
A.ok(teamEnd > iTeam, 'the dispatch briefing has a bounded end before installed skills');
const teamBlock = src.slice(iTeam, teamEnd);
A.ok(/ident && ident\.track/.test(teamBlock), 'each crew line reads that specialist\'s published track record');
A.ok(/track \? ' \[' \+ track \+ '\]' : ''/.test(teamBlock), 'a specialist with no record gets NO bracket (byte-identical to the pre-S3 line)');
A.ok(/anyTrack \?/.test(teamBlock), 'the explanatory legend appears only when at least one bracket is actually present');
A.ok(/evidence, not a\s+'?\s*\+?\s*'?permission level/.test(teamBlock) || /evidence, not a/.test(teamBlock),
  'the briefing tells the lead the record is EVIDENCE, not a permission level');
A.ok(/an agent without one is simply new, not worse/.test(teamBlock),
  'and explicitly protects an unproven agent from reading as a worse one (the sandbox law)');
// the roster field must survive both the in-memory load and the re-save, or it silently vanishes on restart
A.ok(/track: String\(\(a && a\.track\) \|\| ''\)/.test(src), 'replaceAgentRoster accepts the pushed track field');
A.ok(/'reasoningEffort', 'track'\]/.test(src), 'track is a KNOWN roster field, so saveAgentRoster re-emits it');
A.ok(/reasoningEffort: a\.reasoningEffort \|\| null, track: a\.track \|\| ''/.test(src), 'the save path writes it back');

A.report('roster-track.test');
