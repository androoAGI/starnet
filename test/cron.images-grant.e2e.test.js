/* node test/cron.images-grant.e2e.test.js -- a routine granted IMAGES may generate a picture with nobody watching.

   Issue (2026-10-18): "every morning at 8, make me a picture of a sunrise and send it to me on Telegram" fired, but in
   the default ASK posture image_generate was refused ("silence is not consent") and the run told the Commander to
   "pre-authorize image generation on this routine" — a setting that did not exist. Andrew approved a per-routine
   IMAGES grant: a tick in the create form and ▣ ALLOW IMAGES on an existing routine's row.

   Boots the real sidecar (ASK posture, no Full Access) against a fake model + image provider and fires routines with
   Run Now (the scheduled fire's exact posture, grant included). Proves, off what the provider actually received:
     1. a routine created WITH the grant generates the image unattended — the provider got the image request;
     2. the same routine WITHOUT the grant is still refused, the provider never sees a request, and the refusal names
        the real switch (▣ ALLOW IMAGES) instead of leaving the model to invent one;
     3. the row grant (addGrants) adds images to the grants the routine holds NOW — a grant revoked since the row was
        drawn does not come back — survives a sidecar restart, and the next Run Now generates;
     4. a granted routine whose run starts tainted (it reads another routine's output) has the grant lifted, and is
        told why. */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const RENDER_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sse(res, chunks, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

// The model: a routine whose prompt carries IMG_ calls image_generate once, then replies.
async function startModel() {
  const requests = [];
  const imageRequests = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      if (Array.isArray(body.modalities) && body.modalities.includes('image')) {
        imageRequests.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + RENDER_PNG_B64 } }] } }] }));
      }
      requests.push(body);
      const users = JSON.stringify((body.messages || []).filter(m => m && m.role === 'user'));
      const toolDone = (body.messages || []).some(m => m && m.role === 'tool');
      if (/IMG_/.test(users) && !toolDone) {
        return sse(res, [{ tool_calls: [{ index: 0, id: 'render', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a red sunrise over the station' }) } }] }], 'tool_calls');
      }
      return sse(res, [{ content: toolDone ? 'Done for today.' : 'Nothing to draw.' }]);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { requests, imageRequests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1', close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

(async () => {
  const model = await startModel();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-cron-images-grant-',
    env: {
      SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-images-grant-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-images-grant-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_AUX_BUDGET: '0',
      SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
    }
  });
  try {
    await sidecar.start();
    const perms = await sidecar.json('GET', '/api/permissions');
    A.eq(perms.status, 200, 'the permissions read answers');
    A.ok(perms.body && perms.body.masterBypass === false && perms.body.envFullAccess === false, 'the station is in the default ASK posture (no Full Access)');
    A.ok(!JSON.stringify(perms.body.grants || []).includes('studio'), 'and holds no standing studio grant');

    async function routine(name, prompt, extra) {
      const r = await sidecar.deskJson('POST', '/api/cron', Object.assign({ name, prompt, schedule: 'every 1h', agentId: 'agent', model: 'test/model', provider: 'openrouter' }, extra || {}));
      A.eq(r.status, 200, name + ': routine created' + (r.body && r.body.error ? ' (' + r.body.error + ')' : ''));
      return r.body.job;
    }
    async function runNow(job) {
      const res = await sidecar.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id }) });
      A.eq(res.status, 200, job.name + ': Run Now streams');
      const events = (await res.text()).split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      const ended = events.filter(e => e.name === 'agent.run.end').pop();
      A.eq(ended && ended.payload && ended.payload.reason, 'done', job.name + ': the run completed');
      return events;
    }
    // what the model was handed back for its image_generate call on the run whose user turn carries `marker`
    const toolResultFor = (marker) => {
      const req = model.requests.slice().reverse().find(r => JSON.stringify((r.messages || []).filter(m => m.role === 'user')).indexOf(marker) >= 0 && (r.messages || []).some(m => m.role === 'tool'));
      const tool = req && (req.messages || []).find(m => m.role === 'tool');
      return tool ? String(typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content)) : '';
    };

    /* ---- 1. granted at create -> the image is generated unattended ---- */
    const granted = await routine('Sunrise granted', 'IMG_GRANTED make me a sunrise picture', { unattendedGrants: ['studio'] });
    A.eq(granted.unattendedGrants, ['studio'], 'the images grant persisted on the job');
    let before = model.imageRequests.length;
    await runNow(granted);
    A.eq(model.imageRequests.length, before + 1, 'the image provider received exactly one generation request');
    const okResult = toolResultFor('IMG_GRANTED');
    A.ok(okResult && !/consent denied/i.test(okResult), 'image_generate was NOT refused (got: ' + okResult.slice(0, 160) + ')');
    A.ok(/\.png/i.test(okResult), 'the tool result names the saved picture');

    /* ---- 2. the same routine without the grant is still refused, and told the real switch ---- */
    const plain = await routine('Sunrise ungranted', 'IMG_PLAIN make me a sunrise picture');
    A.eq(plain.unattendedGrants, [], 'an ungranted routine carries no grant');
    before = model.imageRequests.length;
    await runNow(plain);
    A.eq(model.imageRequests.length, before, 'no image request reached the provider');
    const refused = toolResultFor('IMG_PLAIN');
    A.ok(/consent denied/i.test(refused), 'image_generate was refused (got: ' + refused.slice(0, 160) + ')');
    A.ok(/▣ ALLOW IMAGES on this routine in AUTOMATE › SCHEDULES/.test(refused), 'the refusal names the switch that exists');

    /* ---- 3. the row grant adds to what the routine holds NOW, and survives a restart ---- */
    const conn = await sidecar.deskJson('POST', '/api/cron/update', { id: plain.id, patch: { unattendedGrants: ['connectors'] } });
    A.eq(conn.body && conn.body.job && conn.body.job.unattendedGrants, ['connectors'], 'setup: the routine was given connected tools');
    const revoked = await sidecar.json('POST', '/api/cron/update', { id: plain.id, patch: { unattendedGrants: [] } });
    A.eq(revoked.body && revoked.body.job && revoked.body.job.unattendedGrants, [], 'setup: then revoked (a row drawn before this still shows connected tools)');
    const allowed = await sidecar.deskJson('POST', '/api/cron/update', { id: plain.id, patch: {}, addGrants: ['studio'] });
    A.eq(allowed.status, 200, 'ALLOW IMAGES saves');
    A.eq(allowed.body && allowed.body.job && allowed.body.job.unattendedGrants, ['studio'], 'images were added to the CURRENT grants — the revoked one did not come back');
    const junk = await sidecar.json('POST', '/api/cron/update', { id: plain.id, patch: {}, addGrants: ['root', 'studio'] });
    A.eq(junk.body && junk.body.job && junk.body.job.unattendedGrants, ['studio'], 'an unmodelled name in addGrants is dropped, never stored');
    await sidecar.restart();
    const list = await sidecar.json('GET', '/api/cron');
    const reread = ((list.body && list.body.jobs) || []).find(j => j.id === plain.id);
    A.eq(reread && reread.unattendedGrants, ['studio'], 'the row grant survives a sidecar restart');
    before = model.imageRequests.length;
    await runNow(reread);
    A.eq(model.imageRequests.length, before + 1, 'after ALLOW IMAGES the routine generates');
    const nowOk = toolResultFor('IMG_PLAIN');
    A.ok(nowOk && !/consent denied/i.test(nowOk), 'and image_generate is no longer refused');

    /* ---- 4. a tainted run has the grant lifted, and is told why ---- */
    const tainted = await routine('Sunrise from context', 'IMG_TAINT draw what the morning routine found', { unattendedGrants: ['studio'], contextFrom: [granted.id] });
    before = model.imageRequests.length;
    await runNow(tainted);
    A.eq(model.imageRequests.length, before, 'a run that starts on another routine\'s output generates nothing');
    const lifted = toolResultFor('IMG_TAINT');
    A.ok(/switched off for the rest of THIS run because it read content from outside StarNet/.test(lifted), 'the refusal says the grant was lifted for this run (got: ' + lifted.slice(0, 200) + ')');
  } catch (error) {
    error.message += '\nSidecar output (tail):\n' + sidecar.output().slice(-6000);
    throw error;
  } finally {
    await sidecar.dispose();
    await model.close();
  }
  A.report('cron.images-grant.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
