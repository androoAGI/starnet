/* node test/budget-desk.http.test.js — SPENDING MORE IS CONFIRMED AT THE DESK (GHSA-2hpj-9wm7-rvg5; the route census's last
   open routes, sidecar/index.js budget-raise / budget-resume / budget-settle).

   A real station (bare: it prints its desk codes on its own console, test/helpers/desk-code.js) and its real routes:
     · /api/budget/caps: a higher figure or none (0) asks; lowering, tightening and a no-change save never ask; a proof for
       one raise is never good for another;
     · /api/budget/resume: asks, bound to the pool and its cap; a pool with no limit, a bad scope and a pool over unknown spend
       are refused without a question;
     · /api/budget/settle: the last unknown charge, or a figure below what it counts at, asks; booking a charge at its estimate
       while another stays open does not;
     · a chosen PER DAY going back to the shipped rail asks only while a charge is unsettled;
     · /api/config/reset {budget} and /api/config/import with a budget section ask for a raise like the caps route, and a backup
       that also restores a permission asks once for both;
     · desktop mode: the page's client key is told the change belongs to the StarNet window (desk_only); the window's own key
       is asked, and the shell's yes (its IPC key) lets it through.
   Every refusal leaves the limits exactly as they were. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture');

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.log('FAIL: ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { expected: b, got: a });

const QUIET = { SKYNET_AUX_BUDGET: '0', SKYNET_QUEST_REFRESH: '0', SKYNET_QUEST_REFRESH_MS: '0', SKYNET_SCOUT: '0', SKYNET_CRON_ENABLED: '0',
  STARNET_CRON_ENABLED: '0', SKYNET_REFLECT: '0', SKYNET_THREAD_MINE: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_EDGE_TTS: '0' };
const challengeOf = r => (r && r.status === 403 && r.body && r.body.code === 'desk_confirm_required' && r.body.deskConfirm) || null;
function pending(f, runId, receipt) {
  const dir = path.join(f.workspace, '.spend-pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, crypto.createHash('sha256').update(runId).digest('hex') + '.json'), JSON.stringify(Object.assign({ runId, agentId: 'agent', ts: Date.now() }, receipt || {})));
}

async function bare() {
  const f = SidecarFixture.create({ prefix: 'budget-desk-', timeoutMs: 150000, env: Object.assign({}, QUIET) });
  try {
    await f.start();
    const caps = async () => (await f.json('GET', '/api/budget/status')).body.caps;
    const post = (route, body) => f.json('POST', route, body);
    eq((await caps()).perDay, 25, 'a fresh station runs on the shipped $25 day limit');

    // ---- lowering and tightening never ask ----
    let r = await post('/api/budget/caps', { perDay: 10 });
    eq([r.status, (await caps()).perDay], [200, 10], 'lowering PER DAY saves at once, no question');
    r = await post('/api/budget/caps', { perRun: 5 });
    eq([r.status, (await caps()).perRun], [200, 5], 'a per-run limit where there was none is a tightening: no question');
    r = await post('/api/budget/caps', { perRun: 5, perDay: 10 });
    eq(r.status, 200, 'saving the same figures again asks nothing');

    // ---- a raise asks, and nothing changes until it is confirmed ----
    r = await post('/api/budget/caps', { perDay: 40 });
    let ch = challengeOf(r);
    ok(ch && ch.action === 'budget-raise' && ch.mode === 'page', 'raising PER DAY is answered with the desk challenge', r.body);
    ok(ch && /PER DAY: \$10\.00 → \$40\.00/.test(ch.summary), 'the confirmation names the limit and both figures', ch && ch.summary);
    eq((await caps()).perDay, 10, 'nothing changed before the desk said yes');
    r = await f.deskJson('POST', '/api/budget/caps', { perDay: 40 });
    eq([r.status, (await caps()).perDay], [200, 40], 'with the code the station printed, the raise is saved');

    r = await post('/api/budget/caps', { perRun: 0 });
    ch = challengeOf(r);
    ok(ch && /PER RUN: \$5\.00 → no limit/.test(ch.summary), 'removing a limit (0 = none) asks too', r.body);
    eq((await caps()).perRun, 5, 'the per-run limit stays until it is confirmed');

    // a proof is for exactly the raise it was issued for
    ch = challengeOf(await post('/api/budget/caps', { perAgent: 3 }));
    eq(ch, null, 'a per-agent limit where there was none never asks');
    ch = challengeOf(await post('/api/budget/caps', { perAgent: 9 }));
    ok(!!ch, 'raising PER AGENT asks');
    const code = ch ? await f.desk.codeFor(ch.code) : '';
    ok(/^\d{6}$/.test(code), 'the station printed a six-digit code for it on its own console');
    r = await f.json('POST', '/api/budget/caps', { perAgent: 0 }, { headers: { 'X-StarNet-Desk-Proof': ch && ch.id, 'X-StarNet-Desk-Code': code } });
    ok(r.status === 403 && r.body.code === 'desk_confirm_required', 'that proof does not remove the limit instead (another change)', r.body);
    eq((await caps()).perAgent, 3, 'and the limit is untouched');

    // back to the shipped default from a higher chosen figure is a lowering while the history is whole
    r = await post('/api/budget/caps', { perDay: null });
    eq([r.status, (await caps()).perDay], [200, 25], 'clearing a $40 PER DAY back to the shipped $25 asks nothing');

    // ---- RESUME ----
    r = await post('/api/budget/resume', { scope: 'bogus' });
    eq(r.status, 400, 'a bad scope is refused without a question');
    r = await post('/api/budget/resume', { scope: 'global' });
    eq([r.status, r.body && r.body.code], [409, undefined], 'a pool with no limit is refused without a question');
    r = await post('/api/budget/resume', { scope: 'day' });
    ch = challengeOf(r);
    ok(ch && ch.action === 'budget-resume' && /DAY pool another \$25\.00/.test(ch.summary) && /from \$25\.00 to \$50\.00/.test(ch.summary), 'RESUME asks, naming the pool and the new limit', r.body);
    eq((await f.json('GET', '/api/budget/status')).body.day.cap, 25, 'no headroom before the desk said yes');
    r = await f.deskJson('POST', '/api/budget/resume', { scope: 'day' });
    eq([r.status, r.body.cap], [200, 50], 'confirmed, the day pool gets its headroom');

    // ---- reset and import ----
    await post('/api/budget/caps', { perDay: 10 });
    r = await post('/api/config/reset', { section: 'budget' });
    ch = challengeOf(r);
    ok(ch && ch.action === 'budget-raise' && /^Resetting your spending limits/.test(ch.summary) && /PER RUN: \$5\.00 → no limit/.test(ch.summary), 'a reset that lifts chosen limits asks', r.body);
    eq((await caps()).perDay, 10, 'the reset waits for the desk');
    r = await f.deskJson('POST', '/api/config/reset', { section: 'budget' });
    const reset = await caps();
    eq([r.status, reset.perDay, reset.perRun, reset.perAgent], [200, 25, 0, 0], 'confirmed, every limit is back to its default');
    r = await post('/api/config/reset', { section: 'budget' });
    eq(r.status, 200, 'a reset that lifts nothing asks nothing');

    const envelope = sections => ({ envelope: { starnetExport: 1, sections } });
    r = await post('/api/config/import', envelope({ budget: { perDay: 0 } }));
    ch = challengeOf(r);
    ok(ch && ch.action === 'budget-raise' && /^This backup raises/.test(ch.summary) && /PER DAY: \$25\.00 → no limit/.test(ch.summary), 'a backup that removes a limit asks', r.body);
    eq((await caps()).perDay, 25, 'and nothing of it applies first');
    r = await post('/api/config/import', envelope({ budget: { perDay: 12 } }));
    eq([r.status, (await caps()).perDay], [200, 12], 'a backup that lowers a limit applies without a question');
    r = await post('/api/config/import', envelope({ budget: { perDay: 30 }, permissions: { allow: ['cabinet:write'] } }));
    ch = challengeOf(r);
    ok(ch && ch.action === 'grant-import' && /cabinet:write/.test(ch.summary) && /PER DAY: \$12\.00 → \$30\.00/.test(ch.summary), 'a backup that grants and raises asks ONCE, for both', r.body);
    r = await f.deskJson('POST', '/api/config/import', envelope({ budget: { perDay: 30 }, permissions: { allow: ['cabinet:write'] } }));
    const perms = (await f.json('GET', '/api/permissions')).body;
    ok(r.status === 200 && (await caps()).perDay === 30 && JSON.stringify(perms).indexOf('cabinet:write') >= 0, 'one confirmation restores both', { status: r.status, body: r.body });

    // ---- unknown history: three charges nobody recorded ----
    await f.stop();
    pending(f, 'lost-a', { runCapUsd: 1.5 });
    pending(f, 'lost-b', { runCapUsd: 1 });
    pending(f, 'lost-c', {});
    await f.start();
    let st = (await f.json('GET', '/api/budget/status')).body;
    eq(st.unsettled.map(u => u.runId).sort(), ['lost-a', 'lost-b', 'lost-c'], 'the three interrupted runs are listed');

    // a chosen PER DAY going back to the shipped rail lets a watched run spend while they are unknown: it asks now
    r = await post('/api/budget/caps', { perDay: null });
    ch = challengeOf(r);
    ok(ch && /PER DAY: \$30\.00 \(your limit\) → \$25\.00 \(the shipped limit/.test(ch.summary), 'while a charge is unsettled, a chosen PER DAY back to the shipped rail asks', r.body);
    r = await post('/api/budget/resume', { scope: 'day' });
    eq([r.status, r.body.code], [409, 'spend_history_unavailable'], 'RESUME over unknown spend is refused without a question');

    r = await post('/api/budget/settle', { runId: 'lost-a', usd: 0.2 });
    ch = challengeOf(r);
    ok(ch && ch.action === 'budget-settle' && /less than the \$1\.50/.test(ch.summary) && /\$1\.30 more room/.test(ch.summary) && !/last charge/.test(ch.summary),
      'booking a charge below what it counts at asks, and says how much room it gives', r.body);
    eq((await f.json('GET', '/api/budget/status')).body.unsettled.length, 3, 'nothing booked before the desk said yes');
    r = await f.deskJson('POST', '/api/budget/settle', { runId: 'lost-a', usd: 0.2 });
    eq([r.status, r.body.unsettled.length], [200, 2], 'confirmed, it is booked');

    r = await post('/api/budget/settle', { runId: 'lost-b', mode: 'limit' });
    eq([r.status, r.body.unsettled && r.body.unsettled.length], [200, 1], 'COUNT AS its own limit while another stays unknown asks nothing');

    r = await post('/api/budget/settle', { runId: 'lost-c', mode: 'bound' });
    ch = challengeOf(r);
    ok(ch && /last charge StarNet does not know/.test(ch.summary) && !/less than/.test(ch.summary), 'the last unknown charge asks even at its own COUNT AS figure', r.body);
    r = await f.deskJson('POST', '/api/budget/settle', { runId: 'lost-c', mode: 'bound' });
    st = r.body;
    eq([r.status, st.unsettled.length, st.accounting && st.accounting.complete], [200, 0, true], 'confirmed, the history is whole again');
  } finally { await f.dispose(); }
}

async function desktop() {
  const api = crypto.randomBytes(24).toString('hex'), ipc = crypto.randomBytes(24).toString('hex');
  const f = SidecarFixture.create({ prefix: 'budget-desk-shell-', timeoutMs: 150000, env: Object.assign({}, QUIET, {
    STARNET_DESKTOP_SHELL: '1', STARNET_API_TOKEN: api, STARNET_IPC_TOKEN: ipc,
    STARNET_CONNECTOR_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') }) });
  try {
    await f.start();
    ok(f.token && f.token !== api, 'the page holds the client key, not the window\'s');
    let r = await f.json('POST', '/api/budget/caps', { perDay: 10 });
    eq(r.status, 200, 'the page lowers a limit with its own key');
    r = await f.json('POST', '/api/budget/caps', { perDay: 0 });
    eq([r.status, r.body.code], [403, 'desk_only'], 'the client key cannot raise one: it belongs to the StarNet window');
    r = await f.json('POST', '/api/budget/caps', { perDay: 0 }, { headers: { 'X-StarNet-Token': api } });
    const ch = challengeOf(r);
    ok(ch && ch.mode === 'desktop' && ch.action === 'budget-raise', 'the window\'s key is asked to confirm in the shell\'s dialog', r.body);
    r = await f.deskJson('POST', '/api/budget/caps', { perDay: 0 });
    eq([r.status, (await f.json('GET', '/api/budget/status')).body.caps.perDay], [200, 0], 'the shell\'s yes lifts the limit');
    r = await f.json('POST', '/api/budget/resume', { scope: 'day' });
    eq([r.status, r.body.code], [409, undefined], 'no day limit now: RESUME has nothing to grant and asks nothing');
  } finally { await f.dispose(); }
}

(async () => {
  try { await bare(); } catch (e) { failed++; console.log('FAIL: bare station threw — ' + (e && e.stack || e)); }
  try { await desktop(); } catch (e) { failed++; console.log('FAIL: desktop station threw — ' + (e && e.stack || e)); }
  console.log(failed ? 'budget-desk.http: ' + failed + ' problem(s), ' + passed + ' ok' : 'budget-desk.http: OK (' + passed + ' assertions)');
  process.exit(failed ? 1 : 0);
})();
