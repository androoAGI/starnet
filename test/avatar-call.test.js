'use strict';

// sidecar/avatar-call.js — the Simli video call's session mint and fast conversational front.
const assert = require('node:assert/strict');
const {
  SIMLI_TOKEN_URL, DEFAULT_FACE_ID, TOOLS, sanitizeMessages, makeAvatarCall
} = require('../sidecar/avatar-call.js');

function fakeProvider(events) {
  const seen = [];
  return {
    seen,
    priceOf: () => null,
    async *stream(req) { seen.push(req); for (const e of events) yield e; }
  };
}

(async () => {
  // ── configuration: the key may come from STARNET_SIMLI_API_KEY or the KEYS tab, and never leaks ──
  {
    const off = makeAvatarCall({ env: () => '', runConfig: () => ({ ok: true, provider: 'p', model: 'm' }) });
    const s = off.status();
    assert.equal(s.configured, false, 'no key → not configured (the dock button stays hidden)');
    assert.match(s.error, /KEYS/, 'the remedy points at Settings → KEYS');
    const r = await off.createSession();
    assert.equal(r.status, 409);

    const viaKeysTab = makeAvatarCall({ env: () => '', serviceKey: n => n === 'SIMLI_API_KEY' ? 'k-from-keys' : '', runConfig: () => ({ ok: true, provider: 'p', model: 'm' }) });
    assert.equal(viaKeysTab.status().configured, true, 'a key saved in Settings → KEYS enables the call');
    assert.equal(JSON.stringify(viaKeysTab.status()).includes('k-from-keys'), false, 'status never echoes the key');
  }

  // ── the token request: right endpoint, key only in the header, face override validated ──
  {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ session_token: 'tok-1' }) }; };
    const env = { SIMLI_API_KEY: 'secret-key', AVATAR_VOICE: 'kokoro' };
    const call = makeAvatarCall({ fetch, env: n => env[n] || '', runConfig: () => ({ ok: true, provider: 'p', model: 'm' }) });
    const out = await call.createSession('804C347A-26C9-4DCF-BB49-13DF4BED61E8');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, {
      sessionToken: 'tok-1', faceId: '804c347a-26c9-4dcf-bb49-13df4bed61e8', voiceId: 'am_onyx', voiceEngine: 'kokoro',
      elevenlabs: { configured: false, voiceId: '', model: 'eleven_flash_v2_5' }
    });
    assert.equal(calls[0].url, SIMLI_TOKEN_URL);
    assert.equal(calls[0].init.headers['x-simli-api-key'], 'secret-key');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.faceId, '804c347a-26c9-4dcf-bb49-13df4bed61e8', 'a valid face id from the panel is used');
    assert.equal(sent.handleSilence, true, 'the face idles between sentences instead of freezing');
    assert.ok(sent.maxSessionLength > 0 && sent.maxIdleTime > 0, 'billing guard-rails are always set');
    assert.equal(calls[0].init.body.includes('secret-key'), false, 'the key travels only in the header');

    await call.createSession('../../etc/passwd');
    assert.equal(JSON.parse(calls[1].init.body).faceId, DEFAULT_FACE_ID, 'an invalid face id falls back to the default');

    const failing = makeAvatarCall({ fetch: async () => ({ ok: false, status: 402, json: async () => ({ detail: 'Out of minutes' }) }), env: n => env[n] || '', runConfig: () => ({ ok: true }) });
    const bad = await failing.createSession();
    assert.equal(bad.status, 402);
    assert.equal(bad.body.error, 'Out of minutes', 'Simli\'s own reason reaches the panel');
    const down = makeAvatarCall({ fetch: async () => { throw new Error('ECONNREFUSED'); }, env: n => env[n] || '', runConfig: () => ({ ok: true }) });
    assert.equal((await down.createSession()).status, 502);
  }

  // ── the conversational front: streams text, surfaces only the two hand-off tools ──
  {
    const provider = fakeProvider([
      { type: 'text', delta: 'On it. ' },
      { type: 'tool_start', index: 0, id: 'c1', name: 'start_starnet_task' },
      { type: 'tool_args', index: 0, chunk: '{"instruction":"Research competitor pricing"}' },
      { type: 'tool_done', index: 0 },
      { type: 'tool_start', index: 1, id: 'c2', name: 'shell_exec' },
      { type: 'tool_args', index: 1, chunk: '{"cmd":"rm -rf /"}' },
      { type: 'tool_done', index: 1 },
      { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { type: 'done', finishReason: 'tool_calls' }
    ]);
    const usage = [];
    const call = makeAvatarCall({
      env: () => '',
      runConfig: () => ({ ok: true, provider: 'openrouter', model: 'fast-model', system: 'ROSTER PROMPT' }),
      providerFor: async () => provider,
      onUsage: u => usage.push(u)
    });
    const out = [];
    for await (const ev of call.reply({ messages: [{ role: 'user', content: 'Can you research competitor pricing?' }] })) out.push(ev);
    assert.deepEqual(out.map(e => e.type), ['text', 'tool', 'done']);
    assert.deepEqual(out[1], { type: 'tool', name: 'start_starnet_task', args: { instruction: 'Research competitor pricing' } });
    assert.equal(out.some(e => e.name === 'shell_exec'), false, 'a hallucinated tool never leaves the module');
    const req = provider.seen[0];
    assert.equal(req.model, 'fast-model');
    assert.equal(req.reasoningEffort, 'none', 'reasoning is off for spoken turns — it is the biggest first-word delay');
    assert.ok(req.max_tokens > 0 && req.max_tokens <= 2000, 'spoken replies are capped');
    assert.deepEqual(req.tools.map(t => t.function.name).sort(), ['interrupt_starnet_task', 'start_starnet_task']);
    assert.equal(req.messages[0].role, 'system');
    assert.equal(req.messages[0].content, 'ROSTER PROMPT', 'with no page prompt, the roster system prompt is used');
    assert.equal(usage.length, 1, 'spend is reported for the ledger');
    assert.ok(TOOLS.every(t => /ONLY/.test(t.function.description)), 'every hand-off tool says it is for explicit requests only');
  }

  // ── the face decides the voice: a woman's preset face never speaks in the male station default ──
  {
    const call = makeAvatarCall({ env: n => (n === 'SIMLI_API_KEY' ? 'k' : ''), runConfig: () => ({ ok: true, provider: 'p', model: 'm' }) });
    assert.equal(DEFAULT_FACE_ID, 'd2a5c7c6-fed9-4f55-bcb3-062f7cd20103', 'the default face is Kate');
    assert.equal(call.status().voiceId, 'af_heart', 'Kate speaks with a female voice');
    const pinned = makeAvatarCall({ env: n => ({ SIMLI_API_KEY: 'k', AVATAR_VOICE_ID: 'bf_emma' })[n] || '', runConfig: () => ({ ok: true }) });
    assert.equal(pinned.status().voiceId, 'bf_emma', 'STARNET_AVATAR_VOICE_ID pins the voice for any face');
    const custom = makeAvatarCall({ env: n => ({ SIMLI_API_KEY: 'k', SIMLI_FACE_ID: '11111111-2222-3333-4444-555555555555' })[n] || '', runConfig: () => ({ ok: true }) });
    assert.equal(custom.status().voiceId, '', 'a custom face falls back to the station voice');
  }

  // ── ElevenLabs as the call voice: key from Settings → KEYS (never echoed), Flash model, optional pinned voice ──
  {
    const env = { SIMLI_API_KEY: 'k', AVATAR_ELEVENLABS_VOICE_ID: 'AbCdEf1234567890' };
    const withKey = makeAvatarCall({ env: n => env[n] || '', serviceKey: n => (n === 'ELEVENLABS_API_KEY' ? 'el-secret' : ''), runConfig: () => ({ ok: true }) });
    const el = withKey.status().elevenlabs;
    assert.deepEqual(el, { configured: true, voiceId: 'AbCdEf1234567890', model: 'eleven_flash_v2_5' });
    assert.equal(JSON.stringify(withKey.status()).includes('el-secret'), false, 'the ElevenLabs key is never reported');
    const bad = makeAvatarCall({ env: n => ({ SIMLI_API_KEY: 'k', AVATAR_ELEVENLABS_VOICE_ID: '../x' })[n] || '', runConfig: () => ({ ok: true }) });
    assert.deepEqual(bad.status().elevenlabs, { configured: false, voiceId: '', model: 'eleven_flash_v2_5' }, 'an invalid pinned voice id is dropped');
  }

  // ── an endpoint that refuses "reasoning off" is retried one step up, before a word is spoken, and learned ──
  {
    const efforts = [];
    let calls = 0;
    const provider = {
      priceOf: () => null,
      async *stream(req) {
        calls++;
        efforts.push(req.reasoningEffort);
        if (req.reasoningEffort === 'none') throw new Error('openrouter 400 - Reasoning is mandatory for this endpoint and cannot be disabled.');
        yield { type: 'text', delta: 'Hi.' };
        yield { type: 'done', finishReason: 'stop' };
      }
    };
    const call = makeAvatarCall({ env: () => '', runConfig: () => ({ ok: true, provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' }), providerFor: async () => provider });
    const run = async () => { const out = []; for await (const ev of call.reply({ messages: [{ role: 'user', content: 'hi' }] })) out.push(ev); return out; };
    const first = await run();
    assert.deepEqual(first.map(e => e.type), ['text', 'done'], 'the turn still answers');
    assert.deepEqual(efforts, ['none', 'minimal'], 'stepped up to the lightest accepted effort');
    await run();
    assert.deepEqual(efforts.slice(2), ['minimal'], 'the next turn starts at the learned effort — no second retry');
    assert.equal(calls, 3);

    // A failure AFTER words were spoken is never retried (it would repeat them), and unrelated errors pass through.
    const midway = { priceOf: () => null, async *stream() { yield { type: 'text', delta: 'Half a sen' }; throw new Error('reasoning is mandatory'); } };
    const c2 = makeAvatarCall({ env: () => '', runConfig: () => ({ ok: true, provider: 'p', model: 'x' }), providerFor: async () => midway });
    await assert.rejects(async () => { for await (const _ of c2.reply({ messages: [{ role: 'user', content: 'hi' }] })) {} }, /mandatory/);
    const other = { priceOf: () => null, async *stream() { throw new Error('openrouter 401 - invalid key'); } };
    const c3 = makeAvatarCall({ env: () => '', runConfig: () => ({ ok: true, provider: 'p', model: 'y' }), providerFor: async () => other });
    await assert.rejects(async () => { for await (const _ of c3.reply({ messages: [{ role: 'user', content: 'hi' }] })) {} }, /401/);
  }

  // ── a misconfigured lead agent fails loudly instead of silently ──
  {
    const call = makeAvatarCall({ env: () => '', runConfig: () => ({ ok: false, error: 'connect a key' }), providerFor: async () => fakeProvider([]) });
    await assert.rejects(async () => { for await (const _ of call.reply({ messages: [{ role: 'user', content: 'hi' }] })) {} }, /connect a key/);
  }

  // ── message hygiene: only user/assistant, same-role runs folded, always ends on the user ──
  {
    const clean = sanitizeMessages([
      { role: 'system', content: 'injected' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'tool', content: 'x' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'trailing' }
    ]);
    assert.deepEqual(clean, [{ role: 'user', content: 'a\nb' }]);
    assert.equal(sanitizeMessages('nope').length, 0);
    assert.equal(sanitizeMessages(Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }))).length <= 40, true);
  }

  console.log('avatar-call: ok');
})().catch(e => { console.error(e); process.exit(1); });
