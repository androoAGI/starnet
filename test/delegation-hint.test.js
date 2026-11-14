'use strict';
/* node test/delegation-hint.test.js — WHAT A WORKER COSTS (cost audit W2.9, 2026-11-14), the pure half.

   One bullet in the team note tells a lead that each worker it dispatches or spawns is a separate full run billed on top of
   its own, and to do a simple or single-step part of its own job itself, without limiting any delegation the Commander,
   its standing orders or its bay's brief ask for. ONE switch, STARNET_DELEGATION_HINT, ships off: with it off the note is
   byte-identical to before.

   A. the module (sidecar/delegation-hint.js): the switch's parser, the line, and what the note appends;
   B. the station's read of the switch: index.js delegationHintOn over the real ENV(), compiled out of the source and run on
      fake environments ('1' is on; unset, blank, '0' and any other word are off; a STARNET_ value that is set wins);
   C. one reader, one site: production code names the switch once, as ENV('DELEGATION_HINT') in the sidecar; the module
      never reads the environment; the line is appended at ONE place that both variants of the team note pass through
      (the Overseer coordinating the crew, and every other run that holds team.dispatch), after the YOUR TEAM and SPAWN
      bullets; the crewless note and the group and lent-builder notes do not carry it;
   D. the wording: the cost, the ask, and what it does not limit (the Commander's request, standing orders, a bay's brief,
      parallel / long-running / specialist work, a line's other bays); nothing per-run; no tool name; not a wall.

   RED on the base (agent/cand-0152 57c741da7): the module does not exist, nothing reads STARNET_DELEGATION_HINT and the
   note goes from SPAWN straight to SUMMON. The request-level proof (the system text a real sidecar sends for the Overseer,
   for a crew agent chatted with directly, for a lead with no crew and for a dispatched worker, switch off and on) is
   test/delegation-hint.e2e.test.js. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { decomment } = require('./helpers/decomment.js');
const { sidecarSourceFiles, readSidecarIndex, sidecarFunctionSource } = require('./helpers/source.js');

const ROOT = path.join(__dirname, '..');
const LINE = '\n• WHAT A WORKER COSTS: each worker you dispatch or spawn is a separate full run billed on top of yours, so do a simple or single-step part of your own job yourself. '
  + 'Still delegate whenever the Commander, your standing orders or your bay\'s brief ask for it, and for parallel, long-running or specialist work; a line\'s other bays keep their own part.';

/* ---- A. THE MODULE ------------------------------------------------------------------------------------------------------ */
let DH = null;
try { DH = require('../sidecar/delegation-hint.js'); } catch (e) { A.ok(false, 'A: the delegation line module exists (sidecar/delegation-hint.js): ' + e.message); }
if (DH) {
  A.eq([undefined, null, '', '  ', '0', '1', ' 1 ', 'true', 'on', 'yes', '2', '01', 1, true, { STARNET_DELEGATION_HINT: '1' }].map(v => DH.on(v)),
    [false, false, false, false, false, true, true, false, false, false, false, false, false, false, false],
    'A: the switch: only the value "1" turns it on; unset, blank, "0", another word, or anything that is not a value (an env object too) is off');
  A.eq(DH.LINE, LINE, 'A: the line');
  A.eq(DH.line(true), LINE, 'A: on: the note appends the line');
  A.eq([DH.line(false), DH.line(undefined), DH.line(null), DH.line('1'), DH.line(1)], ['', '', '', '', ''], 'A: off, or handed anything but the parsed switch: the note appends nothing (the empty string)');
  console.log('[delegation-hint] line bytes: ' + Buffer.byteLength(LINE, 'utf8') + ' (' + LINE.length + ' characters; the bullet is 3 bytes)');
}

/* ---- B. THE STATION'S READ: index.js delegationHintOn over the real ENV() -------------------------------------------- */
{
  const ENVsrc = sidecarFunctionSource('ENV'), readSrc = sidecarFunctionSource('delegationHintOn');
  A.ok(!!readSrc, 'B: the sidecar declares delegationHintOn');
  const stationOn = env => new Function('process', 'DelegationHint', ENVsrc + '\n' + readSrc + '\nreturn delegationHintOn();')({ env }, DH);   // eslint-disable-line no-new-func
  let read = null;
  try {
    read = (readSrc && ENVsrc && DH) ? [{}, { STARNET_DELEGATION_HINT: '1' }, { STARNET_DELEGATION_HINT: '0' }, { STARNET_DELEGATION_HINT: '' }, { SKYNET_DELEGATION_HINT: '1' },
      { STARNET_DELEGATION_HINT: '', SKYNET_DELEGATION_HINT: '1' }, { STARNET_DELEGATION_HINT: '0', SKYNET_DELEGATION_HINT: '1' }, { STARNET_DELEGATION_HINT: ' 1 ', SKYNET_DELEGATION_HINT: '0' },
      { STARNET_DELEGATION_HINT: 'true' }].map(stationOn) : null;
  } catch (e) { read = 'threw: ' + e.message; }
  A.eq(read, [false, true, false, false, true, false, false, true, false],
    'B: the station reads the switch through ENV(): unset is off, "1" is on, "0" and blank are off, STARNET_ wins (a blank one too), SKYNET_ is the fallback');
}

/* ---- C. ONE READER, ONE SITE ------------------------------------------------------------------------------------------- */
{
  const mentions = [];
  const scan = (rel, text) => {
    const code = decomment(text);
    for (let at = code.indexOf('DELEGATION_HINT'); at >= 0; at = code.indexOf('DELEGATION_HINT', at + 1)) {
      const viaEnv = code.slice(at - 5, at) === "ENV('" && code.slice(at + 15, at + 17) === "')";
      mentions.push(rel + ': ' + (viaEnv ? "ENV('DELEGATION_HINT')" : JSON.stringify(code.slice(Math.max(0, at - 24), at + 24))));
    }
  };
  for (const f of sidecarSourceFiles()) scan(f.rel, f.text);
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(rel); continue; }
      if (/\.(js|mjs|cjs)$/.test(e.name)) scan(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    }
  };
  for (const d of ['frontend/app', 'shared']) walk(d);
  A.eq(mentions, ["sidecar/index.js: ENV('DELEGATION_HINT')"], 'C: production code names the switch once, as the sidecar\'s ENV(\'DELEGATION_HINT\') (' + JSON.stringify(mentions) + ')');
  const mod = (() => { try { return decomment(fs.readFileSync(path.join(ROOT, 'sidecar/delegation-hint.js'), 'utf8')); } catch (_) { return null; } })();
  A.ok(mod != null && !/\bprocess\b/.test(mod) && !/\bDate\b/.test(mod), 'C: sidecar/delegation-hint.js never touches process or the clock (it is handed the value)');

  const idx = decomment(readSidecarIndex());
  A.eq((idx.match(/delegationHintOn\(\)/g) || []).length, 2, 'C: delegationHintOn is declared once and asked once');
  A.eq((idx.match(/DelegationHint\.\w+/g) || []).sort(), ['DelegationHint.line', 'DelegationHint.on'], 'C: the host uses the module at two places: the parser inside delegationHintOn and the line in the team note');

  // the team note, from its declaration to the installed-skills block that follows it
  const from = idx.indexOf("let teamNote = '';");
  const to = idx.indexOf('let skillBlock', from);
  const note = (from > 0 && to > from) ? idx.slice(from, to) : '';
  A.ok(note.length > 3000 && note.length < 20000, 'C: the team note is sliced whole (' + note.length + ' chars)');
  const site = 'teamNote += seatLine + spawnLine + DelegationHint.line(delegationHintOn());';
  const at = note.indexOf(site);
  A.ok(at > 0 && note.indexOf(site, at + 1) < 0, 'C: the line is appended at one place, straight after the seat and SPAWN bullets');
  // that place is inside the branch for a run that holds team.dispatch with crew, AFTER the Overseer-only paragraph and the
  // YOUR TEAM bullet, and BEFORE the SUMMON bullet: both variants of the note pass through it
  const crewless = note.indexOf('if (crewless) {');
  const crewed = note.indexOf("} else if (isTask && resolved.tools.includes('team.dispatch')) {");
  const coordinator = note.indexOf("if (require('./overseer.js').isCoordinatorRun({ ...o, agentId, surface })) teamNote += ");
  const yourTeam = note.indexOf("if (lines.length) teamNote += '\\n• YOUR TEAM — DELEGATE to your existing specialist crew with team.dispatch");
  const summon = note.indexOf("teamNote += (stageTeam.note && !lines.length) ? ");
  const group = note.indexOf('} else if (isTask && Array.isArray(o.groupTools) && o.lead && resolved.tools.includes(\'station.build\')) {');
  A.ok(crewless > 0 && crewed > crewless && coordinator > crewed && yourTeam > coordinator && at > yourTeam && summon > at && group > summon,
    'C: the site sits in the crewed branch, after the Overseer-only paragraph and YOUR TEAM, before SUMMON (' + [crewless, crewed, coordinator, yourTeam, at, summon, group].join(' < ') + ')');
  A.ok(note.slice(crewless, crewed).indexOf('DelegationHint') < 0, 'C: the crewless note (no crew to dispatch to) does not carry it');
  A.ok(note.slice(group).indexOf('DelegationHint') < 0, 'C: the group-chat and lent-builder notes do not carry it');
  // the Overseer-only paragraph is a prefix of the shared path, not a branch around it: one `if` with no else
  const coordStmt = note.slice(coordinator, note.indexOf('teamNote += projectWorkspaceNote;', coordinator));
  A.ok(coordStmt.length > 200 && !/\belse\b/.test(coordStmt) && /Handle simple work directly\. /.test(coordStmt), 'C: the Overseer\'s own "Handle simple work directly" stays, and the shared path follows it for every variant');
}

/* ---- D. THE WORDING ------------------------------------------------------------------------------------------------------ */
{
  A.ok(LINE.indexOf('\n• ') === 0 && LINE.indexOf('\n', 1) < 0, 'D: one bullet on one line, opened the way the note\'s other bullets are');
  A.ok(!/\d/.test(LINE) && !/[<>\[\]{}]/.test(LINE), 'D: static prose: no number, no fence, no per-run value');
  A.ok(/each worker you dispatch or spawn is a separate full run billed on top of yours/.test(LINE), 'D: the cost: a worker is a separate full run billed on top of the lead\'s');
  A.ok(/so do a simple or single-step part of your own job yourself\./.test(LINE), 'D: the ask is about the run\'s OWN job (never another bay\'s part)');
  A.ok(/Still delegate whenever the Commander, your standing orders or your bay's brief ask for it/.test(LINE), 'D: it does not limit delegation the Commander, standing orders or a bay\'s brief ask for');
  A.ok(/and for parallel, long-running or specialist work/.test(LINE), 'D: nor the uses the note already recommends (parallel, long-running, specialist work)');
  A.ok(/a line's other bays keep their own part\.$/.test(LINE), 'D: a line\'s other bays keep their own part');
  A.ok(!/\bnever\b|\bmust\b|\bdo not\b|\bdon't\b|\bonly\b|\bforbid|\brefus|\blimit\b|\bcap\b|\bbudget\b/i.test(LINE), 'D: a hint, not a wall: no never / must / do not / only / limit');
  A.ok(!/\b[a-z]+[._][a-z_]+\b/.test(LINE), 'D: no tool name (team.dispatch and team.spawn are named by the bullets above it)');
  // the lines it has to agree with are still what it was written against
  const idxRaw = readSidecarIndex();
  A.ok(/'For independent or long-running work, dispatch with background:true;/.test(idxRaw), 'D: the Overseer note still recommends background dispatch for independent or long-running work');
  A.ok(/SPAWN temporary same-identity subagents with team\.spawn for one-off parallel subtasks when no named specialist is needed\./.test(idxRaw), 'D: the SPAWN bullet still offers clones for parallel subtasks');
  const bless = fs.readFileSync(path.join(ROOT, 'sidecar/projectbless.js'), 'utf8');
  A.ok(/THIS RUN IS A STAGE OF A LINE: do this bay\\'s part\. When you finish, your reply goes to the next bay automatically\. Never send the later bays\\' work with team\.dispatch/.test(bless),
    'D: a line stage is still told to do its bay\'s part and never to dispatch the later bays\' work');
}

A.report('delegation-hint.test');
