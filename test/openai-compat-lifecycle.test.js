/* node test/openai-compat-lifecycle.test.js — /v1 resource lifecycle (memory lane 2026-10-20, "eats my PC").

   Three leaks in the OpenAI-compatible surface, each proven through the production HTTP adapter over a fake runOnce:
     (a) a SYNC chat completion kept running after its client disconnected. An OpenAI SDK that times out retries the
         same request, so one slow task became up to three identical concurrent runs. The disconnect now aborts it.
     (b) a KEYED (Idempotency-Key) stream answered its waiter with body.slice(sent), where `sent` counted only delta
         frames. The waiting heartbeat is an SSE comment, so every heartbeat shifted the offset back into frames the
         waiter already had: duplicated content and a torn junk line before the final chunk. The waiter now receives
         exactly the stored response, byte for byte.
     (c) finished /v1/runs records (one event per token delta) were swept only when a NEW run was created, so the last
         runs of a session stayed in memory for the life of the station. A finished run now arms a sweep timer. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { makeOpenAiCompat } = require('../sidecar/openai-compat');
const { makeRequestReservations } = require('../sidecar/request-reservations');

const KEY = 'lifecycle-test-key-1234567';
const readBody = async req => { let s = ''; for await (const c of req) s += c; return s; };
const until = async (pred, ms) => { for (let w = 0; w < ms && !pred(); w += 10) await new Promise(r => setTimeout(r, 10)); return pred(); };

async function serve(api) {
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: 'http://127.0.0.1:' + server.address().port,
    close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

(async () => {
  let n = 0, serial = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-v1-lifecycle-'));
  try {
    // ---- (a) a sync request whose client leaves aborts its run ----
    {
      let signal = null, ended = null;
      const api = makeOpenAiCompat({ now: () => 1000, newId: () => String(++serial), apiKey: () => KEY, readBody,
        runOnce: async o => {
          o.emit('agent.run.start', { runId: o.runId });
          signal = o.signal;
          const t0 = Date.now();
          await new Promise(r => { const t = setTimeout(r, 3000); o.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
          ended = { aborted: o.signal.aborted, ms: Date.now() - t0 };
          o.emit('agent.run.end', { reason: o.signal.aborted ? 'cancelled' : 'done' });
        } });
      const s = await serve(api);
      try {
        const body = JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'a slow task' }] });
        const req = http.request(s.base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
        req.on('error', () => { /* the client hangs up on purpose */ });
        req.end(body);
        assert.ok(await until(() => !!signal, 2000), 'the sync run started'); n++;
        req.destroy();   // the SDK's own timeout: the caller is gone
        await until(() => !!ended, 4000);
        assert.equal(ended && ended.aborted, true, 'a disconnected sync client aborts its run (it ran on to its end before: ' + JSON.stringify(ended) + ')'); n++;
        assert.ok(ended.ms < 2000, 'the run stops at the disconnect, not when it would have finished (' + ended.ms + ' ms)'); n++;
      } finally { await s.close(); }
    }

    // ---- (b) a keyed stream with waiting heartbeats reaches its waiter byte-identical to the stored response ----
    {
      const api = makeOpenAiCompat({ now: () => 1000, newId: () => String(++serial), apiKey: () => KEY, readBody,
        requestReservations: makeRequestReservations({ fs, path, workspaces: root, now: () => 1000 }),
        runOnce: o => {
          o.emit('agent.run.start', { runId: o.runId });
          o.emit('agent.waiting', { phase: 'first_byte', sinceMs: 15000 });
          o.emit('agent.token', { delta: 'hel' });
          o.emit('agent.waiting', { phase: 'streaming', sinceMs: 31000 });
          o.emit('agent.token', { delta: 'lo' });
          o.emit('agent.waiting', { phase: 'streaming', sinceMs: 46000 });
          o.emit('agent.cost', { tokensIn: 4, tokensOut: 2 });
          o.emit('agent.run.end', { reason: 'done' });
        } });
      const s = await serve(api);
      try {
        const post = () => fetch(s.base + '/v1/chat/completions', { method: 'POST',
          headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Idempotency-Key': 'heartbeat-replay' },
          body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'say hello' }] }) });
        const live = await (await post()).text();
        const lines = live.split('\n').filter(Boolean);
        const junk = lines.filter(l => !(l.startsWith(': ') || l === 'data: [DONE]' || (l.startsWith('data: {') && (() => { try { JSON.parse(l.slice(6)); return true; } catch (_) { return false; } })())));
        assert.deepEqual(junk, [], 'every line the waiter received is a whole SSE frame (no torn line)'); n++;
        const data = lines.filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
        assert.equal(data.map(c => (c.choices[0].delta || {}).content || '').join(''), 'hello', 'the content arrives exactly once'); n++;
        assert.equal(lines.filter(l => l === 'data: [DONE]').length, 1, 'one [DONE]'); n++;
        assert.ok(live.endsWith('data: [DONE]\n\n'), '[DONE] closes the stream'); n++;
        const replay = await (await post()).text();   // the same key after completion: the durably stored response
        assert.equal(live, replay, 'the live waiter received the stored response byte for byte'); n++;
      } finally { await s.close(); }
    }

    // ---- (c) a finished /v1/runs record is swept without waiting for another run ----
    {
      let clock = 5000;
      const timers = [];
      const api = makeOpenAiCompat({ now: () => clock, newId: () => String(++serial), apiKey: () => KEY, readBody,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
        runOnce: o => {
          o.emit('agent.run.start', { runId: o.runId });
          for (const t of ['one ', 'token ', 'per ', 'event']) o.emit('agent.token', { delta: t });
          o.emit('agent.run.end', { reason: 'done' });
        } });
      const s = await serve(api);
      try {
        const created = await (await fetch(s.base + '/v1/runs', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: 'a short run' }) })).json();
        const runs = api._internals.runs;
        assert.ok(await until(() => runs.get(created.run_id) && runs.get(created.run_id).closed, 2000), 'the run finished'); n++;
        assert.equal(runs.get(created.run_id).events.filter(e => e.event === 'message.delta').length, 4, 'its record holds one event per token delta'); n++;
        assert.equal(timers.length, 1, 'finishing the run arms one retention sweep (nothing did before: only a NEW run swept)'); n++;
        assert.ok(timers[0].ms >= 60 * 60 * 1000 && timers[0].ms <= 60 * 60 * 1000 + 2000, 'armed for an hour after it finished (' + timers[0].ms + ' ms)'); n++;
        const status = await (await fetch(s.base + '/v1/runs/' + created.run_id, { headers: { Authorization: 'Bearer ' + KEY } })).json();
        assert.equal(status.status, 'completed', 'within the hour the run is still readable'); n++;
        clock += 60 * 60 * 1000 + 1000;
        timers[0].fn();
        assert.equal(runs.size, 0, 'an hour after it finished the record is gone, though no new run was created'); n++;
        assert.equal(timers.length, 1, 'with nothing left to expire the sweep does not re-arm'); n++;
      } finally { await s.close(); }
    }
    // ---- (d) an Idempotency-Key binds to the PAIR the request resolves to (run-wire-resolver lane), not defaultModel() ----
    // A replay after the station's pair changed would run on another provider/model: it is a different request (409). A
    // change to the legacy defaultModel the run no longer reads must not make the same request look different.
    {
      let wire = { ok: true, provider: 'codex', model: 'gpt-5.5', source: 'station' }, dm = 'env/one';
      const ran = [];
      const api = makeOpenAiCompat({ now: () => 1000, newId: () => String(++serial), apiKey: () => KEY, readBody,
        requestReservations: makeRequestReservations({ fs, path, workspaces: root, now: () => 1000 }),
        defaultModel: () => dm, resolveWire: () => wire,
        runOnce: o => { ran.push([o.provider, o.model]); o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); } });
      const s = await serve(api);
      try {
        const post = (key) => fetch(s.base + '/v1/chat/completions', { method: 'POST',
          headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'same words' }] }) });
        assert.equal((await post('wire-bound')).status, 200, 'the keyed request runs'); n++;
        assert.deepEqual(ran, [['codex', 'gpt-5.5']], 'on the resolved pair'); n++;
        dm = 'env/two';
        assert.equal((await post('wire-bound')).status, 200, 'a defaultModel change the run never reads leaves the same request the same (a replay)'); n++;
        assert.equal(ran.length, 1, '...answered from the stored response, not run again'); n++;
        wire = { ok: true, provider: 'openrouter', model: 'v1/model', source: 'env' };
        const changed = await post('wire-bound');
        assert.equal(changed.status, 409, 'the same key after the resolved pair changed is a different request (409), never the old pair\'s answer'); n++;
      } finally { await s.close(); }
    }
    console.log('openai-compat-lifecycle: OK (' + n + ' assertions)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
