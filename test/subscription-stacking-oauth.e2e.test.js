/* node test/subscription-stacking-oauth.e2e.test.js — ChatGPT (Codex) subscription stacking, end to end.

   Boots the real sidecar with TWO ChatGPT sign-ins already stored: the primary (WORKSPACES/codex/tokens.json) and
   one extra account (WORKSPACES/.secrets/accounts/codex/<id>/tokens.json, as provider-accounts.js writes it). A
   local fake of the Codex responses endpoint answers the primary's token with the real spent-plan 429
   (code usage_limit_reached) and the extra account's token normally.

   Proves: /api/auth/codex/accounts lists both sign-ins (email from the token, never the token); a run on the spent
   primary rotates to account 2 inside the SAME run with the right bearer; the next run opens on account 2; a
   primary that is signed OUT no longer blocks runs while an extra account works; and remove forgets the account. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const jwt = (who) => 'fixture.' + Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/profile': { email: who + '@example.test' } })).toString('base64url') + '.fixture';
const PRIMARY = jwt('primary'), EXTRA = jwt('extra');
const ACCT = 'abcdef12';

function startMock() {
  const calls = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        if (req.method !== 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [], data: [] })); return; }
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        let marker = '?';
        marker = (raw.match(/STACK-OAUTH-[A-Z]+/) || ['?'])[0];   // codex sends `input`, grok `messages`
        if (/^GROK-/.test(bearer)) {   // Grok rides chat/completions with the device-OAuth access token as the bearer
          calls.push({ who: bearer, marker });
          if (bearer === 'GROK-A') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'You have hit your weekly usage limit', code: 'usage_limit_reached' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answered by grok account 2' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
          return;
        }
        calls.push({ who: bearer === PRIMARY ? 'primary' : bearer === EXTRA ? 'extra' : 'unknown', marker });
        if (bearer === PRIMARY) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'The usage limit has been reached' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
        send({ type: 'response.output_text.delta', delta: 'answered by the extra account' });
        send({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } });
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, HOST, () => resolve({ server, calls, base: `http://${HOST}:${server.address().port}` }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const onData = (data) => {
      output += data.toString();
      if (!settled && output.includes(`http://${HOST}:${port}`)) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(output)) {
        settled = true;
        try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + output)); } }, 15000);
  });
}

(async () => {
  const mock = await startMock();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-stacking-oauth-'));
  fs.mkdirSync(path.join(workspace, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'codex', 'tokens.json'), JSON.stringify({ access_token: PRIMARY, refresh_token: 'fixture-a', token_type: 'Bearer' }));
  const acctDir = path.join(workspace, '.secrets', 'accounts', 'codex', ACCT);
  fs.mkdirSync(acctDir, { recursive: true });
  fs.writeFileSync(path.join(acctDir, 'account.json'), JSON.stringify({ id: ACCT, seq: 1 }));
  fs.writeFileSync(path.join(acctDir, 'tokens.json'), JSON.stringify({ access_token: EXTRA, refresh_token: 'fixture-b', token_type: 'Bearer' }));
  // Grok (device OAuth): the same shape — a primary in WORKSPACES/grok/tokens.json and one extra account
  const grokLife = { expires_at: 4102444800000, token_type: 'Bearer' };
  fs.mkdirSync(path.join(workspace, 'grok'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'grok', 'tokens.json'), JSON.stringify(Object.assign({ access_token: 'GROK-A', refresh_token: 'grok-ra' }, grokLife)));
  const grokDir = path.join(workspace, '.secrets', 'accounts', 'grok', 'feed1234');
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(path.join(grokDir, 'account.json'), JSON.stringify({ id: 'feed1234', seq: 1 }));
  fs.writeFileSync(path.join(grokDir, 'tokens.json'), JSON.stringify(Object.assign({ access_token: 'GROK-B', refresh_token: 'grok-rb' }, grokLife)));

  let { child, port } = await boot(await allocatePort(), { SKYNET_WORKSPACES: workspace, SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0' }, 20);
  const B = () => `http://${HOST}:${port}`;
  try {
    let token = await bootToken(B(), B());
    const H = () => ({ 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B() });
    const get = async (p) => (await fetch(B() + p, { headers: H() })).json();
    const post = async (p, body) => (await fetch(B() + p, { method: 'POST', headers: H(), body: JSON.stringify(body || {}) })).json();
    const run = async (marker) => {
      const r = await fetch(B() + '/api/run', { method: 'POST', headers: H(),
        body: JSON.stringify({ provider: 'codex', model: 'gpt-5.5', baseUrl: mock.base, agentId: 'stacking-oauth-e2e', isTask: false, messages: [{ role: 'user', content: marker }] }) });
      A.eq(r.status, 200, marker + ' streams through the real /api/run route');
      return await r.text();
    };
    const whoRan = marker => mock.calls.filter(c => c.marker === marker).map(c => c.who);

    const list = await get('/api/auth/codex/accounts');
    A.eq(list.accounts.map(a => [a.label, a.primary, a.connected, a.email]),
      [['account 1', true, true, 'primary@example.test'], ['account 2', false, true, 'extra@example.test']], '/accounts lists both ChatGPT sign-ins');
    A.ok(!JSON.stringify(list).includes('fixture.'), 'no token material in the accounts payload');

    const first = await run('STACK-OAUTH-FIRST');
    A.eq(whoRan('STACK-OAUTH-FIRST'), ['primary', 'extra'], 'first run: the spent primary is tried once, then the extra account answers');
    A.ok(/"toAccount":"account 2"/.test(first) && /"reason":"quota_exhausted"/.test(first), 'provider.fallback names account 2 and the spent allowance');
    A.ok(first.includes('answered by the extra account'), 'the run finished on account 2');

    await run('STACK-OAUTH-SECOND');
    A.eq(whoRan('STACK-OAUTH-SECOND'), ['extra'], 'second run opens on account 2 while the primary cools');

    // Grok: the same rotation through the generic device-OAuth account keeper
    const g = await fetch(B() + '/api/run', { method: 'POST', headers: H(),
      body: JSON.stringify({ provider: 'grok', model: 'grok-4', baseUrl: mock.base + '/grok', agentId: 'stacking-grok-e2e', isTask: false, messages: [{ role: 'user', content: 'STACK-OAUTH-GROK' }] }) });
    const gt = await g.text();
    A.eq(mock.calls.filter(c => c.marker === 'STACK-OAUTH-GROK').map(c => c.who), ['GROK-A', 'GROK-B'], 'Grok: the spent primary, then account 2');
    A.ok(/"toAccount":"account 2"/.test(gt) && gt.includes('answered by grok account 2'), 'Grok run finished on account 2');
    A.eq((await get('/api/auth/grok/accounts')).accounts.map(a => [a.label, a.connected]), [['account 1', true], ['account 2', true]], 'Grok lists both sign-ins');

    // a SIGNED-OUT primary no longer blocks the subscription while an extra account works (fresh process: no cooldown)
    A.eq((await post('/api/auth/codex/logout')).connected, false, 'the primary signs out');
    try { child.kill(); } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
    ({ child, port } = await boot(await allocatePort(), { SKYNET_WORKSPACES: workspace, SKYNET_QUEST_REFRESH: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0' }, 20));
    token = await bootToken(B(), B());
    await run('STACK-OAUTH-THIRD');
    A.eq(whoRan('STACK-OAUTH-THIRD'), ['extra'], 'with the primary signed out, the run goes straight to the connected account');

    // remove forgets the extra account
    A.eq((await post('/api/auth/codex/remove', { account: ACCT })).ok, true, 'remove answers ok');
    A.ok(!fs.existsSync(acctDir), 'its folder (and tokens) are gone');
    A.eq((await get('/api/auth/codex/accounts')).accounts.length, 1, 'only the primary row remains');
    A.eq((await post('/api/auth/codex/remove', { account: '../codex' })).code, 'account_not_found', 'a forged id reaches nothing');
    A.eq((await post('/api/auth/codex/account-poll', { device_auth_id: 'nope' })).code, 'login_not_found', 'an unknown device login is refused');
    // SIGN IN AGAIN posts its account in the QUERY (codexsignin.js signIn). The route used to be an exact-URL match,
    // so every re-sign fell through to the static server's 404 and the button said "could not start sign-in".
    for (const p of ['codex', 'grok', 'kimi']) {
      const r = await fetch(B() + '/api/auth/' + p + '/account-start?account=no-such-acct', { method: 'POST', headers: H() });
      const j = await r.json().catch(() => null);
      A.eq(j && j.code, 'account_not_found', p + ' account-start?account= reaches the sign-in handler (not the static 404)');
    }
    const cs = await fetch(B() + '/api/auth/claude-cli/status?account=no-such-acct', { headers: H() });
    A.eq(((await cs.json().catch(() => null)) || {}).code, 'account_not_found', 'claude-cli status?account= reaches its handler');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('subscription-stacking-oauth.e2e.test');
})().catch((error) => {
  console.log('FAIL: subscription-stacking-oauth.e2e.test threw - ' + (error && error.stack || error));
  process.exit(1);
});
