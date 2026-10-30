/* test/workshop-session-copy.test.js — a build session tells its story in ONE voice (old-UI review 10-26 #3).

   Andrew's screenshots (10-26, again 10-30): a "built while you were away" session opened on a gold prose block —
   "⚒ built while you were away – “…”. … open this session any time to review and decide." — then a dim
   "SYSTEM ✕ discarded – …" line, and after a reload "◈ nothing left to review – …". Three registers for one story:
   the saved station lines replayed through toolLine (an agent row), the live ones through localLine (the SYSTEM
   register); every line opened on a fallback-font symbol; capitals mid-sentence; and an instruction to open the
   session he was already reading.

   Locks: (1) saved station lines replay in the SYSTEM register, like the live line; (2) the store writes plain
   sentences (no symbol in front, no "open this session"); (3) older saves are re-worded on the way to the screen,
   exactly the lines he sent; (4) the build card's outcome lines carry no symbol either, and a final outcome is
   marked as one (decided) so the resolution check no longer reads the words. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const mem = new Map();
global.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const streams = new Map();
global.Workstreams = {
  adopt(o) { if (streams.has(o.id)) return streams.get(o.id); const w = Object.assign({ history: [] }, o); streams.set(w.id, w); return w; },
  get(id) { return streams.get(id) || null; }, touch() {}, markUnread() {}, activeId() { return null; }
};
global.App = { persist() {}, refreshRail() {} };
const { WorkshopStore } = require('../frontend/app/workshopstore.js');
const line = WorkshopStore.sessionLine;
const GLYPH = /^[⚒◈✦✓✕⚠↩▶]/;

/* ---- (3) the lines Andrew sent, as older saves hold them ---- */
A.eq(line('⚒ built while you were away — “Guard CPU difficulty and ledge behavior”. Adds deterministic regression checks for selected CPU difficulty and grounded ledge guarding. All 59 mechanics checks pass, and deliberate behavior regressions trigger the intended assertions. open this session any time to review and decide.'),
  'Built while you were away: “Guard CPU difficulty and ledge behavior”. Adds deterministic regression checks for selected CPU difficulty and grounded ledge guarding. All 59 mechanics checks pass, and deliberate behavior regressions trigger the intended assertions.',
  'the 10-30 intro: no ⚒, sentence case, and no "open this session" instruction inside the session');
A.eq(line('⚒ built while you were away — “Speedrun timer with checkpoint splits + test course”. A drop-in speedrun timer. open this session any time to review and decide.'),
  'Built while you were away: “Speedrun timer with checkpoint splits + test course”. A drop-in speedrun timer.', 'the 10-26 intro reads the same way');
A.eq(line('⚒ built while you were away — “Quiet one”. open this session any time to review and decide.'), 'Built while you were away: “Quiet one”.', 'an intro with no summary');
A.ok(/^Nothing left to review — /.test(line('◈ nothing left to review — this build is no longer awaiting a decision and its files are gone from the agent’s workshop.')), 'the "nothing left to review" line loses its ◈');
A.ok(/^Kept — /.test(line('◈ decided — this build was KEPT — its files were implemented/saved. find it in the DELIVERABLES library.')), 'KEPT mid-sentence becomes a plain "Kept —"');
A.ok(/^Discarded — /.test(line('◈ decided — this build was DISCARDED — its files were removed and it won’t be rebuilt.')), 'DISCARDED likewise');
A.ok(/^This build failed — /.test(line('◈ decided — this build FAILED — it never produced a reviewable deliverable.')), 'FAILED likewise');
A.eq(line('✕ discarded — this idea won’t be rebuilt or re-proposed'), 'Discarded — this idea won’t be rebuilt or re-proposed.', 'the live discard line he saw under SYSTEM');
A.eq(line('✓ implemented — files saved to C:/Users/me/Desktop'), 'Implemented — files saved to C:/Users/me/Desktop.', 'a saved keep line');
A.eq(line('⚠ patch file saved to C:/x — NOT applied to your project'), 'Patch file saved to C:/x — not applied to your project.', 'a saved patch line');
A.eq(line('↩ keep undone — removed 2 files from C:/x. This build is pending again.'), 'Keep undone — removed 2 files from C:/x. This build is pending again.', 'an undo line');
A.eq(line('▶ NOVA is building this now. The finished build arrives as its own card.'), 'NOVA is building this now. The finished build arrives as its own card.', 'a build-start line');
A.eq(line('The build didn’t finish: the station refused. This plan is still waiting — reopen this session to try again.'),
  'The build didn’t finish: the station refused. This plan is still waiting — reopen this session to try again.', 'a line already in plain words passes through untouched');

/* ---- (2) what the store writes now ---- */
const id = WorkshopStore.ensureSession({ runId: 'r1', agentId: 'agent', title: 'Guard CPU difficulty', summary: 'Adds checks.' });
const intro = streams.get(id).history[0].content;
A.eq(intro, 'Built while you were away: “Guard CPU difficulty”. Adds checks.', 'a new build session opens on a plain sentence');
A.ok(!GLYPH.test(intro) && !/open this session/.test(intro), 'no symbol in front and no instruction to open the session it is in');
A.eq(WorkshopStore.sessionTitleOf({}), 'Built while you were away', 'an untitled build names its row in sentence case');
const store = read('frontend/app/workshopstore.js');
A.ok(!/'[⚒◈✦]/.test(store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/LEAD_GLYPH = [^\n]*/, '').replace(/LEGACY_LINE = \[[\s\S]*?\n  \];/, '').replace(/const (RESOLVED|GONE)_MARK = [^\n]*/g, '').replace(/World\.say\('[^']*'\)/g, '')),
  'the store writes no ⚒ ◈ ✦ line any more (the legacy patterns it reads are the only place they appear; an in-world World.say bubble is the speech family, not this surface)');

/* ---- (1)(4) the renderer and the build card ---- */
const chat = read('frontend/app/chat.js');
const replay = /function renderHistory\(onlyTurns\) \{[\s\S]*?\n  \}\n/.exec(chat)[0];
A.ok(/if \(m && m\.sys\) \{ if \(\(m\.content \|\| ''\)\.trim\(\)\) sysLine\(m\.content, !!m\.error\); continue; \}/.test(replay), 'a saved station line replays through sysLine');
const sysLine = /function sysLine\(text, isErr\) \{[\s\S]*?\n  \}/.exec(chat)[0];
A.ok(/row\('system'\)/.test(sysLine), 'sysLine draws the SYSTEM register — the same row localLine draws live');
A.ok(/indexOf\('workshop-'\) === 0/.test(sysLine) && /WorkshopStore\.sessionLine/.test(sysLine), 'and re-words older lines only inside a build session');
const card = /function workshopReturn\(m, opts, _try\) \{[\s\S]*?\n  \}\n/.exec(chat)[0];
A.ok(!/'[✓✕⚠↩▶] /.test(card), 'the build card writes no symbol-led outcome line');
for (const [what, re] of [['discard', /decideNote\(done, true\)/], ['keep', /decideNote\(saved, true\)/], ['built', /decideNote\(okLine, true\)/]])
  A.ok(re.test(card), 'a final ' + what + ' line is marked decided');
A.ok(/decideNote\(starting\);/.test(card), 'a build that is only starting is not a decision');
A.ok(/noteDecision\(label, \{ decided: !!final \}\)/.test(card), 'decideNote hands the flag to the store');

A.report('workshop-session-copy.test');
