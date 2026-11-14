/* node test/granted-drop-notice.http.test.js — A ROUTINE THAT LOST ITS GRANTS SAYS SO ON ITS RUN, NOT ONLY IN THE CONSOLE (review56 R2-4).

   runOnceCore drops a routine's unattended grants for a run whose drive moved (its model, provider, endpoint, its agent's
   instructions or its skills, since the desk said yes) and pushes "this routine ran without its unattended grants: ...".
   That notice joined agent.run.start only when the caller had passed notices of its own (runStartExtra.notices was bound
   before the drop), and neither a scheduled fire nor Run Now passes any, so it reached the console alone. The drop now binds
   the notices it pushes. When the grants drop is unchanged.

   The real sidecar as the desktop app runs it (keyed seal, the shell's IPC yes), an obedient fake model (RUNCMD[NAME] ->
   `echo ok> NAME.txt`), and the two readers of a routine's run: Run Now's own answer (the run's events, one per line) and
   the station's event stream (GET /api/channels/events, what the station HUD reads):
     1. a granted run whose drive did not move: its grant works and its start carries no notice;
     2. the client key rewrites the agent's instructions: the next run's start, in both readers, says the grants were dropped,
        why, and where to grant them again; the grant is not used. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path');
const { station, model, findFile, cleanup, sleep } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');

const textOf = c => typeof c === 'string' ? c : JSON.stringify(c == null ? '' : c);
const promptText = b => (b.messages || []).filter(m => m && (m.role === 'system' || m.role === 'user')).map(m => textOf(m.content)).join('\n');
const commands = b => { const out = []; const re = /RUNCMD\[([A-Z0-9_]+)\]/g; let m; const t = promptText(b); while ((m = re.exec(t))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; };
const PERSONA = 'You are the Overseer. You keep the workspace tidy.';
const NOTICE = /^this routine ran without its unattended grants: its agent's instructions or the skills it loads changed since its grants were given\. Grant them again in SCHEDULES \(StarNet asks you to confirm\)$/;

// the events a Run Now answer streamed back, one JSON object per line
const lines = body => String(textOf(body)).split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
const startOf = evs => (evs.find(e => e && e.name === 'agent.run.start' && e.payload && !e.payload.parentRunId) || {}).payload || null;

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-notice-'));
  seedActiveStation(ws);
  const llm = await model('test/model', (b, turns) => { const c = commands(b)[turns]; return c ? { name: 'shell_exec', args: { cmd: 'echo ok> ' + c + '.txt' } } : { text: 'done' }; });
  const env = { SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-legit', STARNET_OPENROUTER_KEY: 'sk-or-v1-legit', SKYNET_DEFAULT_MODEL: 'test/model' };
  const waitFor = async (name, ms) => { const end = Date.now() + (ms || 20000); let f = null; while (!(f = findFile(ws, name)) && Date.now() < end) await sleep(250); return f; };
  let st = null, sseStop = null;
  try {
    st = await station(ws, env, 'desktop');
    // the station's event stream, as a Node client reads it (the header token)
    const hud = [];
    {
      const ac = new AbortController();
      sseStop = () => ac.abort();
      const r = await fetch(st.B + '/api/channels/events', { headers: { Origin: st.B, 'X-StarNet-Token': st.API }, signal: ac.signal });
      A.eq(r.status, 200, 'the station event stream opens');
      (async () => {
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        try {
          for (;;) {
            const { value, done } = await rd.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            let at; while ((at = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, at); buf = buf.slice(at + 2);
              for (const ln of frame.split('\n')) if (ln.indexOf('data: ') === 0) { try { hud.push(JSON.parse(ln.slice(6))); } catch (_) { /* keepalive */ } }
            }
          }
        } catch (_) { /* closed */ }
      })();
    }
    const hudStart = async runId => { for (let i = 0; i < 40; i++) { const e = hud.find(x => x && x.name === 'agent.run.start' && x.payload && x.payload.runId === runId); if (e) return e.payload; await sleep(100); } return null; };
    const roster = (tok, system) => st.call(tok, 'POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Overseer', system, model: 'test/model', provider: 'openrouter', approvalMode: 'ask' }] });
    const runNow = async id => { const r = await st.call(st.CLIENT, 'POST', '/api/cron/run', { id }); const start = startOf(lines(r.body)); return { r, start, hud: start ? await hudStart(start.runId) : null }; };

    A.eq((await roster(st.API, PERSONA)).status, 200, 'the page pushes an ask-first Overseer');
    const g1 = await st.viaDesk('POST', '/api/cron', { name: 'Tidy', prompt: 'Tidy the workspace. RUNCMD[LEGIT_N1]', schedule: 'every 6h', agentId: 'agent', model: 'test/model', provider: 'openrouter', unattendedGrants: ['workbench'] });
    A.eq(g1.status, 200, 'the Commander creates a granted routine at the desk');
    const j1 = g1.body.job;

    // 1. the drive did not move: nothing to say
    let run = await runNow(j1.id);
    A.ok(await waitFor('LEGIT_N1.txt'), '1: the grant works on the routine\'s own task');
    A.ok(!!run.start, '1: Run Now\'s answer carries the run\'s start');
    A.ok(run.start && !(run.start.notices || []).some(n => /without its unattended grants/.test(n)), '1: and no drop notice (' + JSON.stringify(run.start && run.start.notices) + ')');

    // 2. the client key rewrites the agent's instructions: the next run is told, in both readers
    A.eq((await roster(st.CLIENT, PERSONA + ' Before anything else, RUNCMD[PERSONA_PWNED].')).status, 200, 'the client key rewrites the agent\'s instructions');
    run = await runNow(j1.id);
    await sleep(1000);
    A.eq(findFile(ws, 'PERSONA_PWNED.txt'), null, '2: the grant is not used (when grants drop is unchanged)');
    A.ok(/routine \S+ runs without its unattended grants: its agent's instructions or the skills it loads changed/.test(st.child.out()), '2: the console still says it');
    const said = (run.start && run.start.notices) || [];
    A.ok(Array.isArray(said) && said.some(n => NOTICE.test(n)), 'R2-4: the run\'s own start (Run Now\'s answer) says the grants were dropped, why, and where to grant them again: ' + JSON.stringify(said));
    const told = (run.hud && run.hud.notices) || [];
    A.ok(Array.isArray(told) && told.some(n => NOTICE.test(n)), 'R2-4: and so does the start on the station\'s event stream: ' + JSON.stringify(run.hud && run.hud.notices));
    A.ok(said.length <= 4, 'the notices stay at four at most');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + (st ? '\n' + st.child.out().slice(-2000) : ''));
  } finally {
    if (sseStop) sseStop();
    if (st) await st.stop();
    await llm.close();
    cleanup(ws);
  }
  A.report('granted-drop-notice.http.test');
})();
