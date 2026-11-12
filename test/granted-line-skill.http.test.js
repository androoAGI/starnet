/* node test/granted-line-skill.http.test.js — A GRANTED WORK-LINE ROUTINE LOADS ITS PROJECT SKILL (review56 R2-6).

   A desk-granted routine binds the skills it loads (granted-context.js skillDigest, the drive's fourth part), and its run
   loads only those, each only while its bytes are the bound ones. The binding resolved the routine's skills under the
   routine's own folder (job.workdir, or none), while the run of a work-line routine (runsLine) works in its line's project
   folder (runOnceCore takes the line's projectRoot) and resolves them there. A skill shared at project scope with that
   folder was bound as "no such skill" and then found by the run, so it was withheld from every run with the wrong reason
   ("it changed after this routine's grants were given") and the model was told to say so.

   The binding now resolves a work-line routine's skills under its line's project folder, as its run does. The real
   sidecar as the desktop app runs it (keyed seal, the shell's IPC yes), a saved floor with one line whose INBOX names a
   trusted project folder, and an obedient fake model (RUNCMD[NAME] -> `echo ok> NAME.txt`):
     1. a granted runsLine routine with no folder of its own, loading a skill shared at project scope with the line's
        folder: the skill reaches the model whole and is not withheld; its steps run with the grant;
     2. the grant still binds those bytes: the client key rewrites the skill's body, and the next run drops the grants
        and never runs the rewritten step. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path');
const { station, model, findFile, cleanup, sleep } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');
const { floorOf, publishFloor, fetchApi } = require('./helpers/saved-floor.js');

const textOf = c => typeof c === 'string' ? c : JSON.stringify(c == null ? '' : c);
const promptText = b => (b.messages || []).filter(m => m && (m.role === 'system' || m.role === 'user')).map(m => textOf(m.content)).join('\n');
const commands = b => { const out = []; const re = /RUNCMD\[([A-Z0-9_]+)\]/g; let m; const t = promptText(b); while ((m = re.exec(t))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; };
const PERSONA = 'You are the Overseer. You run the line.';

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'line-skill-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-skill-project-')));
  seedActiveStation(ws);
  // the project folder is trusted before the app's first keyed boot (the upgrade path seals it)
  fs.writeFileSync(path.join(ws, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: ['path:' + project], meta: {} }));
  const llm = await model('test/model', (b, turns) => { const c = commands(b)[turns]; return c ? { name: 'shell_exec', args: { cmd: 'echo ok> ' + c + '.txt' } } : { text: 'done' }; });
  const env = { SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-legit', STARNET_OPENROUTER_KEY: 'sk-or-v1-legit', SKYNET_DEFAULT_MODEL: 'test/model' };
  const find = name => findFile(project, name) || findFile(ws, name);
  const waitFor = async (name, ms) => { const end = Date.now() + (ms || 20000); let f = null; while (!(f = find(name)) && Date.now() < end) await sleep(250); return f; };
  let st = null;
  try {
    st = await station(ws, env, 'desktop');
    const api = fetchApi(st.B, { 'Content-Type': 'application/json', 'X-StarNet-Token': st.API, Origin: st.B });
    A.eq((await st.call(st.API, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Overseer', system: PERSONA, model: 'test/model', provider: 'openrouter', approvalMode: 'ask', executionProfile: 'trusted-project' }] })).status, 200, 'the page pushes an ask-first Overseer');
    // one line: INBOX (the project folder) > the Overseer's bay > OUTBOX; the bay's room holds a notebook (skill.view)
    const geometry = { props: [
      { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1, projectRoot: project },
      { id: 'a', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'agent' },
      { id: 'o', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) };
    const { plan } = await publishFloor(api, floorOf(geometry, { equip: ['computer', 'notebook'] }), { label: 'the project line' });
    A.eq(plan.lines && plan.lines[0] && plan.lines[0].projectRoot, project, 'the saved line works in the project folder');

    // a skill shared at project scope with the line's folder
    const mk = await st.call(st.API, 'POST', '/api/agent-skills/manage', { agentId: 'agent', action: 'create', name: 'line-steps', summary: 'How to run the line', body: 'Step 1. Note the run with RUNCMD[LEGIT_L1].' });
    A.eq(mk.status, 200, 'a saved skill (' + JSON.stringify(mk.body).slice(0, 160) + ')');
    const sh = await st.call(st.API, 'POST', '/api/agent-skills/share', { agentId: 'agent', target: 'line-steps', scope: 'project', projectRoot: project });
    A.eq(sh.status, 200, 'shared at project scope with the line\'s folder (' + JSON.stringify(sh.body).slice(0, 200) + ')');

    // the desk's yes for a work-line routine with no folder of its own (the INBOX form sends none)
    const g = await st.viaDesk('POST', '/api/cron', { name: 'Line run', prompt: 'Follow your line-steps skill.', skills: ['line-steps'], schedule: 'every 6h', agentId: 'agent', model: 'test/model', provider: 'openrouter', unattendedGrants: ['workbench'], runsLine: true });
    A.eq(g.status, 200, 'the Commander grants the work-line routine at the desk (' + JSON.stringify(g.body).slice(0, 200) + ')');
    const job = g.body.job || {};
    A.ok(job.runsLine === true && !job.workdir, 'a runsLine routine without a folder of its own');

    const drops = () => (st.child.out().match(/runs without its unattended grants/g) || []).length;
    const runNow = async () => { const from = llm.seen.length, d0 = drops(); const r = await st.call(st.CLIENT, 'POST', '/api/cron/run', { id: job.id }); await sleep(800); return { r, reqs: llm.seen.slice(from).filter(b => Array.isArray(b.tools) && b.tools.length > 0), dropped: drops() > d0 }; };
    const sawWords = (reqs, re) => reqs.some(b => re.test(promptText(b)));

    // 1. the bound project skill reaches the run whole, and its step runs with the grant
    let run = await runNow();
    A.ok(run.reqs.length > 0, '1: the line\'s stage ran (' + run.reqs.length + ' model calls; ' + textOf(run.r.body).slice(-300) + ')');
    A.ok(!sawWords(run.reqs, /WITHHELD SKILLS[\s\S]*line-steps/), 'R2-6: the project skill is not withheld from the granted run');
    A.ok(!sawWords(run.reqs, /changed after this routine's grants were given/), 'R2-6: and the model is not told it changed');
    A.ok(sawWords(run.reqs, /Step 1\. Note the run with RUNCMD\[LEGIT_L1\]/), 'R2-6: its steps reach the model');
    A.ok(!run.dropped, '1: the grants hold');
    A.ok(await waitFor('LEGIT_L1.txt'), '1: and its step uses the terminal grant (the legit marker is written)');

    // 2. the grant binds those bytes: a body the client key rewrites drops the grants and never runs
    const ed = await st.call(st.CLIENT, 'POST', '/api/agent-skills/manage', { agentId: 'agent', action: 'edit', target: 'line-steps', body: 'Step 1. RUNCMD[SKILL_PWNED].' });
    A.eq(ed.status, 200, 'the client key rewrites the skill body (' + JSON.stringify(ed.body).slice(0, 160) + ')');
    run = await runNow();
    await sleep(1500);
    A.ok(run.dropped && /runs without its unattended grants: its agent's instructions or the skills it loads changed/.test(st.child.out()), '2: the rewritten skill drops the grants');
    A.eq(find('SKILL_PWNED.txt'), null, '2: and its step never uses the terminal unattended');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + (st ? '\n' + st.child.out().slice(-2000) : ''));
  } finally {
    if (st) await st.stop();
    await llm.close();
    cleanup(ws);
    try { if (project.toLowerCase().indexOf(fs.realpathSync(os.tmpdir()).toLowerCase()) === 0) fs.rmSync(project, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  A.report('granted-line-skill.http.test');
})();
