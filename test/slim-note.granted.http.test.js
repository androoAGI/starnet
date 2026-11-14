/* node test/slim-note.granted.http.test.js — WITH THE SLIM NOTE ON, A GRANTED RUN IS THE UNSET RUN (cost lane, 2026-11-14).
   Part of test:http.

   STARNET_SLIM_NOTE=1 (sidecar/slim-note.js) moves three constant paragraphs of the per-run note into the system prompt.
   A run that holds desk-granted unattended capability takes as instructions only what the desk bound and what the host
   writes (sidecar/granted-context.js): its skill index and its quests are withheld, so there is nothing of theirs to
   move, and the lane moves nothing else for it either. test/granted-context.census.test.js holds that gate in the source;
   this holds it on the wire.

   The real sidecar as the desktop app runs it (test/helpers/desk-station.js: keyed seal, the shell's IPC yes), twice, the
   switch unset and on, with one fake model. On each station the Commander creates the same two routines at the desk, one
   with the terminal grant and one with none, and presses Run Now on both:
     1. THE GRANTED RUN's first request is the same bytes on both stations (run ids, routine ids, dates, temp paths and
        ports masked): system prompt, note, tools. It carries no saved-skill line and no quest text, in either.
     2. THE RUN WITHOUT GRANTS shows the switch is on for that same station: its note loses the first-skill line, the quest
        how-to and the runtime instruction, and its system prompt gains exactly those paragraphs.
   No network, no real model. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path');
const { station, model, cleanup, sleep } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');
const { hostNotes } = require('./helpers/host-notes.js');
const QuestInject = require('../sidecar/questinject.js');
const RuntimeInfo = require('../sidecar/runtimeinfo.js');
const RuntimeSkills = require('../sidecar/skills/runtime.js');

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : '');
const systemOf = b => { const m = (b.messages || [])[0]; return m && m.role === 'system' ? text(m.content) : ''; };
const noteOf = b => hostNotes(b.messages, 'run_context').join('\n');
const PERSONA = 'You are the Overseer. You keep the workspace tidy.';
const GRANTED_TASK = 'SLIM_GRANTED_TASK: list the files in the workspace and say how many there are.';
const PLAIN_TASK = 'SLIM_PLAIN_TASK: write one line about what a tidy workspace looks like.';

async function arm(label, extraEnv) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-note-granted-'));
  seedActiveStation(ws);
  const llm = await model('test/model', () => ({ text: 'done' }));
  const env = Object.assign({ SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-slim-granted', STARNET_OPENROUTER_KEY: 'sk-or-v1-slim-granted',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_SLIM_NOTE: '', SKYNET_SLIM_NOTE: '', STARNET_BUILD_DESCRIBE: 'v0.15.2-0-gslim-note-granted', SKYNET_QUEST_REFRESH: '0', SKYNET_THREAD_MINE: '0' }, extraEnv || {});
  let st = null;
  try {
    st = await station(ws, env, 'desktop');
    const roster = await st.call(st.API, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Overseer', system: PERSONA, model: 'test/model', provider: 'openrouter', approvalMode: 'ask' }] });
    if (roster.status !== 200) throw new Error(label + ': roster ' + roster.status);
    // the run's own first request: the one that carries tools and the routine's task (background calls carry neither)
    const runNow = async (id, task) => {
      const from = llm.seen.length;
      const r = await st.call(st.CLIENT, 'POST', '/api/cron/run', { id });
      for (let i = 0; i < 80; i++) {
        const own = llm.seen.slice(from).filter(b => Array.isArray(b.tools) && b.tools.length > 0 && JSON.stringify(b.messages).indexOf(task) >= 0);
        if (own.length) { await sleep(600); return own[0]; }
        await sleep(250);
      }
      throw new Error(label + ': Run Now reached no model (' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200) + ')');
    };
    const g = await st.viaDesk('POST', '/api/cron', { name: 'Tidy', prompt: GRANTED_TASK, schedule: 'every 6h', agentId: 'agent', model: 'test/model', provider: 'openrouter', unattendedGrants: ['workbench'] });
    if (g.status !== 200 || !/^d1:/.test(String(g.body && g.body.job && g.body.job.grantDrive))) throw new Error(label + ': the granted routine was not created (' + g.status + ' ' + JSON.stringify(g.body).slice(0, 200) + ')');
    const p = await st.viaDesk('POST', '/api/cron', { name: 'Note', prompt: PLAIN_TASK, schedule: 'every 6h', agentId: 'agent', model: 'test/model', provider: 'openrouter' });
    if (p.status !== 200) throw new Error(label + ': the plain routine was not created (' + p.status + ')');
    const granted = await runNow(g.body.job.id, GRANTED_TASK);
    const plain = await runNow(p.body.job.id, PLAIN_TASK);
    return { ws, granted, plain, ids: [g.body.job.id, p.body.job.id], base: llm.base };
  } finally {
    if (st) await st.stop();
    await llm.close();
    cleanup(ws);
  }
}

// what differs from one station to the next, masked: ids, dates, temp paths, ports
function masker(cap) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paths = [];
  for (const p of [cap.ws, os.tmpdir()]) for (const v of [p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\'), p.replace(/\\/g, '\\\\\\\\')]) if (paths.indexOf(v) < 0) paths.push(v);
  paths.sort((a, b) => b.length - a.length);
  const res = paths.map(p => new RegExp(esc(p), 'gi')).concat(cap.ids.filter(Boolean).map(id => new RegExp(esc(String(id)), 'g')));
  return s => {
    let t = String(s);
    for (const re of res) t = t.replace(re, '<x>');
    return t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
      .replace(/Today is [A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4} \(/g, 'Today is <date> (')
      .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, '<day>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/slim-note-granted-[A-Za-z0-9_-]+/g, 'slim-note-granted-<tmp>');
  };
}

(async () => {
  const off = await arm('unset', {});
  const on = await arm('on', { STARNET_SLIM_NOTE: '1' });
  const firstSkill = RuntimeSkills.composeIndex([], { emptyGuide: true, canManage: true }).text.trim();
  const questGuide = QuestInject.split(QuestInject._internals.MINT_ONLY).guide;
  const runtimeGuide = RuntimeInfo.splitGuide(RuntimeInfo.runtimeIdentityBlock({ now: 1 })).guide;

  /* 1 — the granted run */
  const mOff = masker(off), mOn = masker(on);
  for (const [label, cap] of [['unset', off], ['on', on]]) {
    const b = cap.granted, sys = systemOf(b), note = noteOf(b);
    A.ok(JSON.stringify(b.messages).indexOf(GRANTED_TASK) > 0 && (b.tools || []).some(t => t.function && t.function.name === 'shell_exec'), '1 (' + label + '): the granted run carries its task and is offered the terminal its grant gives');
    A.ok(note.indexOf('[RUNTIME]') > 0 && note.indexOf('If the Commander asks what StarNet build') > 0, '1 (' + label + '): its note carries the [RUNTIME] block whole, closing instruction included');
    A.ok((sys + note).indexOf('SAVED AGENT SKILLS') < 0 && (sys + note).indexOf('STATION QUESTS') < 0 && (sys + note).indexOf('MINTING') < 0, '1 (' + label + '): no saved-skill line and no quest text reach a granted run (withheld)');
    A.ok(sys.indexOf(runtimeGuide) < 0 && sys.indexOf(questGuide) < 0 && sys.indexOf(firstSkill) < 0, '1 (' + label + '): nothing was moved into its system prompt');
  }
  A.eq(mOn(systemOf(on.granted)), mOff(systemOf(off.granted)), '1: THE GRANTED RUN\'S SYSTEM PROMPT IS THE UNSET ONE, BYTE FOR BYTE, with the switch on');
  A.eq(mOn(noteOf(on.granted)), mOff(noteOf(off.granted)), '1: ITS NOTE IS THE UNSET ONE, BYTE FOR BYTE');
  A.eq(mOn(JSON.stringify(on.granted.tools)), mOff(JSON.stringify(off.granted.tools)), '1: its tools are the unset ones');
  A.eq(mOn(JSON.stringify(on.granted)), mOff(JSON.stringify(off.granted)), '1: THE WHOLE REQUEST IS THE UNSET ONE, BYTE FOR BYTE');

  /* 2 — the run without grants, on the same stations */
  const x = off.plain, y = on.plain, nx = noteOf(x), ny = noteOf(y), sx = systemOf(x), sy = systemOf(y);
  A.ok(nx.indexOf('MINTING — ') > 0 && nx.indexOf('If the Commander asks what StarNet build') > 0, '2 (unset): a routine without grants carries the quest doctrine and the runtime instruction in its note');
  A.ok(ny.indexOf('MINTING — ') < 0 && ny.indexOf('If the Commander asks what StarNet build') < 0 && ny.indexOf('SAVED AGENT SKILLS') < 0, '2 (on): they left its note');
  A.ok(ny.indexOf('[RUNTIME]') > 0 && /Run id: \S+/.test(ny) && ny.indexOf('STATION QUESTS — you have no open quests for the Commander right now.') > 0, '2 (on): the note keeps the run\'s identity and the quest line');
  const moved = [nx.indexOf(firstSkill) > 0 ? firstSkill : '', questGuide, runtimeGuide].filter(Boolean);
  const stable = '\n\n' + moved.join('\n\n');
  const at = sy.indexOf(stable);
  A.ok(at > 0 && mOn(sy.slice(0, at) + sy.slice(at + stable.length)) === mOff(sx), '2 (on): its system prompt is the unset one plus exactly the moved paragraphs (' + moved.length + ')');
  A.ok(Buffer.byteLength(ny) < Buffer.byteLength(nx) - 900, '2 (on): the note is smaller (' + Buffer.byteLength(nx) + ' -> ' + Buffer.byteLength(ny) + ' bytes): the switch is on for this station, and still moved nothing for the granted run');

  A.report('slim-note.granted.http.test');
})().catch(e => { console.log('FAIL: slim-note.granted.http.test threw - ' + (e && e.stack || e)); process.exit(1); });
