/* sidecar/avatar-call.js — the Simli video call: a FAST conversational front, the harness behind it.

   WHY THIS EXISTS BESIDE /api/run. Local Live voice sends every utterance through Chat.sendOrQueue, i.e. a full
   harness run: tool registry, office composition, task brief, memory recall, consent broker. That is the right
   machinery for WORK and far too much for "how are we doing on the launch?" — a spoken exchange paid a full
   agentic turn before the first word. The call separates the two, exactly like the OpenAI Realtime path
   (realtime-voice.js): the avatar TALKS through one streamed completion on the lead agent's own provider with
   its own composed prompt, and anything that needs doing is handed to the real harness through the SAME
   start_starnet_task / interrupt_starnet_task contract, which the page executes via Chat.sendOrQueue. The
   harness itself is untouched: no new run surface, no new tool grants, no consent bypass.

   THE SIMLI KEY NEVER REACHES THE PAGE. The page asks for a short-lived session token; this module mints it with
   the key held in the sidecar's environment. Simli is a pure face: it receives 16 kHz PCM audio and returns
   lip-synced video. Hearing (STT) and voice (TTS) are StarNet's own existing /api/stt and /api/tts, so no
   StarNet prompt, state or transcript is ever sent to Simli — only the synthesized audio of what is said.

   Kept dependency-free and injection-driven so it is testable without the host (see test/avatar-call.test.js). */
'use strict';

const { note: failNote } = require('./failopen.js');

const SIMLI_TOKEN_URL = 'https://api.simli.ai/compose/token';
// Simli's preset face "Kate". Any face from app.simli.com (preset or created from a photo) can be picked in the
// call panel, or pinned station-wide with STARNET_SIMLI_FACE_ID.
const DEFAULT_FACE_ID = 'd2a5c7c6-fed9-4f55-bcb3-062f7cd20103';
const FACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* A face and its voice must agree — a woman's face speaking in the station's male default reads as broken.
   Simli's preset faces are listed here with the StarNet voice (sidecar/local-voice.js ids) that fits them; a
   custom face defaults to the station voice, and the call panel's VOICE picker overrides either way. */
const PRESET_FACE_VOICES = {
  'cace3ef7-a4c4-425d-a8cf-a5358eb0c427': 'af_bella',   // Tina
  'b9e5fba3-071a-4e35-896e-211c4d6eaa7b': 'af_bella',   // Laila
  'd2a5c7c6-fed9-4f55-bcb3-062f7cd20103': 'af_heart',   // Kate
  '7e74d6e7-d559-4394-bd56-4923a3ab75ad': 'am_michael', // Sabour
  '1c6aa65c-d858-4721-a4d9-bda9fde03141': 'am_michael', // Fred
  '5fc23ea5-8175-4a82-aaaf-cdd8c88543dc': 'af_nova',    // Madison
  '804c347a-26c9-4dcf-bb49-13df4bed61e8': 'am_onyx',    // Mark
  'afdb6a3e-3939-40aa-92df-01604c23101c': 'af_bella',   // Zahra
  'dd10cb5a-d31d-4f12-b69f-6db3383c006e': 'am_onyx',    // Hank
  'b1f6ad8f-ed78-430b-85ef-2ec672728104': 'bf_emma'     // Charlotte
};
const VOICE_ID_RE = /^[ab][fm]_[a-z]+$/;
/* ElevenLabs as the call's voice (chosen in the call panel). The key is the one Settings → KEYS publishes as
   ELEVENLABS_API_KEY, read by /api/tts's existing ElevenLabs route; it never reaches the page. Calls use the
   Flash model: ~75 ms model latency, built for real-time conversation (the station default elsewhere stays
   eleven_multilingual_v2). */
const ELEVENLABS_CALL_MODEL = 'eleven_flash_v2_5';
const ELEVENLABS_VOICE_RE = /^[A-Za-z0-9]{8,48}$/;
const DEFAULT_MAX_SESSION_SECONDS = 1800;
const DEFAULT_MAX_IDLE_SECONDS = 300;
// How the avatar's voice is made (frontend reads this from /api/avatar/status):
//   edge    — free neural Edge voice via /api/tts's local path. Fast, no key. The default.
//   kokoro  — the on-device Kokoro voice (falls back to Edge). Private, CPU-bound.
//   station — the station's locked neural voice through the keyed provider chain. Best match, slowest.
const VOICE_ENGINES = ['edge', 'kokoro', 'station'];

// Spoken replies are short by design; a cap keeps a runaway answer from monologuing for a minute.
const DEFAULT_MAX_TOKENS = 700;
// Reasoning is the single biggest time-to-first-word cost on modern models. Talk does not need it; work does,
// and work goes to the harness. Override with STARNET_AVATAR_REASONING if a station insists.
const DEFAULT_REASONING = 'none';
/* Some endpoints refuse to switch reasoning off (OpenRouter, for instance: "reasoning is mandatory for this
   endpoint and cannot be disabled"). The call then steps up this ladder to the lightest effort the model takes,
   and remembers the answer per provider/model so only the first turn of a session pays the retry. */
const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium'];
const REASONING_REQUIRED_RE = /reasoning[^.]{0,40}(?:mandatory|required|cannot be disabled)|(?:cannot|can't|must not) (?:be )?disable[ds]?[^.]{0,20}(?:reasoning|thinking)|thinking[^.]{0,40}(?:mandatory|required)|unsupported[^.]{0,40}(?:reasoning|effort)/i;

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8000;
const MAX_SYSTEM_CHARS = 120000;

/* The ONLY tools the conversational front can call. Both are executed by the page, never here: this module
   just reports that the model asked. Deliberately no status tool — the live station snapshot is already in the
   prompt every turn, so answering "what's running?" costs zero extra round-trips. */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'start_starnet_task',
      description: 'Hand a concrete piece of work to the StarNet crew (research, code, files, messages, any tool use or sustained work). ONLY call this when the Commander explicitly asks you to do, run, create, change, send or look something up. Never call it for conversation, opinions, status questions or planning talk.',
      parameters: {
        type: 'object',
        properties: { instruction: { type: 'string', description: 'The complete, self-contained instruction for the StarNet agent, in the Commander\'s intent.' } },
        required: ['instruction'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'interrupt_starnet_task',
      description: 'Stop the running StarNet task. ONLY when the Commander clearly asks to stop, cancel or change direction on running work.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Short reason the Commander gave.' } },
        additionalProperties: false
      }
    }
  }
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

/* Validate and bound what the page sends. Roles are restricted to user/assistant: the system prompt travels in
   its own field, and tool-role turns are never replayed (the page records a completed hand-off as a plain
   assistant line), so the wire shape stays identical across every provider adapter. */
function sanitizeMessages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content == null ? '' : m.content).slice(0, MAX_MESSAGE_CHARS);
    if (!content.trim()) continue;
    // Providers reject two consecutive same-role turns on some wires (Anthropic); fold them instead.
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n' + content;
    else out.push({ role: m.role, content });
  }
  // A completion must end on the Commander's turn.
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  return out;
}

function parseArgs(raw) {
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' ? v : {}; }
  catch (_) { return {}; }
}

function makeAvatarCall(opts) {
  opts = opts || {};
  const fetchFn = opts.fetch || globalThis.fetch;
  const env = typeof opts.env === 'function' ? opts.env : (() => '');
  // () => { ok, provider, model, reasoningEffort?, system? } | { ok:false, error } — resolved by the host from the
  // lead agent's roster entry, with STARNET_AVATAR_MODEL / _PROVIDER overrides applied there.
  const runConfig = typeof opts.runConfig === 'function' ? opts.runConfig : (() => ({ ok: false, error: 'no run config' }));
  // async (cfg) => LLMProvider — the host's selectProvider with its OAuth/codex branches. Credentials stay there.
  const providerFor = opts.providerFor;
  const onUsage = typeof opts.onUsage === 'function' ? opts.onUsage : null;
  // The KEYS tab (Settings) publishes enabled service keys as bare env vars (SIMLI_API_KEY); the host passes a
  // reader for those so a key pasted there works without a restart or a STARNET_-prefixed variable.
  const serviceKey = typeof opts.serviceKey === 'function' ? opts.serviceKey : (() => '');
  const learnedEffort = new Map();   // "provider|model" -> the lightest reasoning effort that endpoint accepted

  function apiKey() { return String(env('SIMLI_API_KEY') || serviceKey('SIMLI_API_KEY') || '').trim(); }
  function seconds(name, fallback) {
    const n = Math.floor(Number(env(name)));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  function face() {
    const engine = String(env('AVATAR_VOICE') || '').trim().toLowerCase();
    return {
      faceId: String(env('SIMLI_FACE_ID') || '').trim() || DEFAULT_FACE_ID,
      maxSessionLength: seconds('SIMLI_MAX_SESSION_SECONDS', DEFAULT_MAX_SESSION_SECONDS),
      maxIdleTime: seconds('SIMLI_MAX_IDLE_SECONDS', DEFAULT_MAX_IDLE_SECONDS),
      voiceEngine: VOICE_ENGINES.indexOf(engine) >= 0 ? engine : 'edge'
    };
  }
  // The voice for a face: a station-wide STARNET_AVATAR_VOICE_ID wins, then the preset face's own voice, then
  // '' (the frontend falls back to the station's chosen local voice).
  function elevenLabs() {
    const voice = String(env('AVATAR_ELEVENLABS_VOICE_ID') || '').trim();
    return {
      configured: !!String(serviceKey('ELEVENLABS_API_KEY') || '').trim(),
      voiceId: ELEVENLABS_VOICE_RE.test(voice) ? voice : '',
      model: ELEVENLABS_CALL_MODEL
    };
  }
  function voiceFor(faceId) {
    const pinned = String(env('AVATAR_VOICE_ID') || '').trim();
    if (VOICE_ID_RE.test(pinned)) return pinned;
    return PRESET_FACE_VOICES[String(faceId || '').toLowerCase()] || '';
  }
  function missingConfig() {
    return apiKey() ? '' : 'add a Simli key in Settings → KEYS (or set STARNET_SIMLI_API_KEY) to enable video calls';
  }
  function maxTokens() {
    const n = Math.floor(Number(env('AVATAR_MAX_TOKENS')));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
  }
  function reasoning() { return String(env('AVATAR_REASONING') || '').trim() || DEFAULT_REASONING; }

  function status(agentId) {
    let brain;
    try { brain = runConfig(agentId); } catch (e) { brain = { ok: false, error: String((e && e.message) || e) }; }
    const f = face();
    const missing = missingConfig();
    return {
      configured: !missing,
      error: missing || undefined,
      faceId: f.faceId,
      voiceEngine: f.voiceEngine,
      voiceId: voiceFor(f.faceId),
      elevenlabs: elevenLabs(),
      brain: brain && brain.ok ? { ok: true, provider: brain.provider, model: brain.model } : { ok: false, error: String((brain && brain.error) || 'the lead agent has no provider/model') }
    };
  }

  /* The token request body (Simli /compose/token, StartStreamingSessionRequest). handleSilence keeps the face
     alive and idling between sentences instead of freezing; the length/idle caps are the billing guard-rails —
     a call left open in a background tab ends on its own. */
  function tokenBody(faceId) {
    const f = face();
    return { faceId: FACE_ID_RE.test(String(faceId || '')) ? String(faceId).toLowerCase() : f.faceId, apiVersion: 'v2', handleSilence: true, maxSessionLength: f.maxSessionLength, maxIdleTime: f.maxIdleTime, audioInputFormat: 'pcm16' };
  }

  // Mint a short-lived Simli session token for this call. Only the face id and limits leave this machine.
  async function createSession(faceId) {
    const missing = missingConfig();
    if (missing) return { status: 409, body: { error: missing } };
    let upstream;
    try {
      upstream = await fetchFn(SIMLI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-simli-api-key': apiKey() },
        body: JSON.stringify(tokenBody(faceId))
      });
    } catch (_) {
      return { status: 502, body: { error: 'Simli could not be reached' } };
    }
    let data = null;
    try { data = await upstream.json(); } catch (e) { failNote('avatar.session.body', e); }   // non-JSON error page: fall through to the status code
    const token = data && data.session_token;
    if (!upstream.ok || !token || token === 'FAIL TOKEN') {
      // Simli's own reason is safe to surface (it never echoes the key); fall back to the status code.
      // `detail` is a string for business errors and a FastAPI validation array ([{ msg, loc }]) for bad requests.
      const d = data && data.detail;
      const detail = typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x && x.msg && ((x.loc || []).slice(-1)[0] + ': ' + x.msg)).filter(Boolean).join('; ') : '';
      const msg = String(detail || (data && (data.message || data.error)) || ('Simli refused the session (' + upstream.status + ')'));
      return { status: upstream.status >= 400 ? upstream.status : 502, body: { error: msg.slice(0, 300) } };
    }
    const usedFace = tokenBody(faceId).faceId;
    return { status: 200, body: { sessionToken: String(token), faceId: usedFace, voiceId: voiceFor(usedFace), voiceEngine: face().voiceEngine, elevenlabs: elevenLabs() } };
  }

  /* One conversational turn. Yields { type:'text', delta } as the model streams, { type:'tool', name, args }
     for a completed hand-off request, then exactly one { type:'done', finishReason }. Throws on configuration or
     provider failure; the host turns that into an NDJSON error line. */
  async function* reply(input) {
    input = input || {};
    const cfg = runConfig(input.agentId);
    if (!cfg || !cfg.ok) throw Object.assign(new Error((cfg && cfg.error) || 'the lead agent has no provider/model'), { status: 409 });
    const messages = sanitizeMessages(input.messages);
    if (!messages.length) throw Object.assign(new Error('nothing to answer'), { status: 400 });
    const system = String(input.system || cfg.system || '').slice(0, MAX_SYSTEM_CHARS);
    const provider = await providerFor(cfg);
    const req = {
      model: cfg.model,
      stream: true,
      signal: input.signal,
      max_tokens: maxTokens(),
      reasoningEffort: reasoning(),
      tools: TOOLS,
      messages: (system ? [{ role: 'system', content: system }] : []).concat(messages)
    };
    const learnedKey = String(cfg.provider || '') + '|' + String(cfg.model || '');
    const start = learnedEffort.get(learnedKey) || req.reasoningEffort;
    const ladder = EFFORT_LADDER.indexOf(start) >= 0 ? EFFORT_LADDER.slice(EFFORT_LADDER.indexOf(start)) : [start];
    const calls = new Map();   // index -> { name, args }
    let usage = null, finishReason = null;
    for (let step = 0; step < ladder.length; step++) {
      req.reasoningEffort = ladder[step];
      let emitted = false;
      try {
        for await (const ev of provider.stream(req)) {
          if (!ev) continue;
          if (ev.type === 'text' && ev.delta) { emitted = true; yield { type: 'text', delta: String(ev.delta) }; }
          else if (ev.type === 'tool_start') calls.set(ev.index, { name: String(ev.name || ''), args: '' });
          else if (ev.type === 'tool_args') { const c = calls.get(ev.index); if (c) c.args += String(ev.chunk || ''); }
          else if (ev.type === 'tool_done') {
            const c = calls.get(ev.index);
            calls.delete(ev.index);
            // Only the two declared hand-off tools ever leave this module; anything else a model hallucinates is dropped.
            if (c && TOOL_NAMES.has(c.name)) { emitted = true; yield { type: 'tool', name: c.name, args: parseArgs(c.args) }; }
          }
          else if (ev.type === 'usage') usage = ev.usage;
          else if (ev.type === 'done') finishReason = ev.finishReason || null;
        }
        learnedEffort.set(learnedKey, ladder[step]);
        break;
      } catch (e) {
        // Retry ONLY a refusal that happened before anything was said — never repeat words already spoken.
        const refused = !emitted && step < ladder.length - 1 && REASONING_REQUIRED_RE.test(String((e && e.message) || e));
        if (!refused) throw e;
        calls.clear();
      }
    }
    // Adapters that stream tool args without a per-call tool_done still finish the call at end of stream.
    for (const c of calls.values()) if (TOOL_NAMES.has(c.name)) yield { type: 'tool', name: c.name, args: parseArgs(c.args) };
    if (usage && onUsage) { try { onUsage({ usage, provider, cfg }); } catch (e) { failNote('avatar.reply.usage', e); } }
    yield { type: 'done', finishReason };
  }

  return { status, tokenBody, createSession, reply };
}

module.exports = {
  SIMLI_TOKEN_URL, DEFAULT_FACE_ID, FACE_ID_RE, ELEVENLABS_CALL_MODEL, PRESET_FACE_VOICES, EFFORT_LADDER, REASONING_REQUIRED_RE, DEFAULT_MAX_SESSION_SECONDS, DEFAULT_MAX_IDLE_SECONDS, VOICE_ENGINES,
  DEFAULT_MAX_TOKENS, DEFAULT_REASONING, TOOLS, sanitizeMessages, makeAvatarCall
};
