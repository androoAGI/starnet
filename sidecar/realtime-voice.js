'use strict';

const DEFAULT_MODEL = 'gpt-realtime-2.1';
const DEFAULT_VOICE = 'ash';   // MALE by default: the station voice is written as a low American male, and the crew sprites read male
/* The provider's own voice set. It was hardcoded to one name, which read as "you cannot change the voice" —
   that limit was OURS, not the provider's. Validated against this list rather than passed through, so a
   caller cannot push an arbitrary string into the session payload. */
const VOICES = ['ash', 'cedar', 'ballad', 'echo', 'verse', 'marin', 'alloy', 'coral', 'sage', 'shimmer'];
function normalizeVoice(name) {
  const v = String(name || '').trim().toLowerCase();
  return VOICES.indexOf(v) >= 0 ? v : '';
}
// Only the fallback for a caller that supplies no provider descriptor. The real endpoint comes from the
// provider registry, so adding a provider is a row there rather than an edit here.
const OPENAI_REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';

const TOOLS = [
  {
    type: 'function',
    name: 'get_starnet_status',
    description: 'Read the visible Starnet workstreams, active task state, and approval state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'start_starnet_task',
    description: 'Send a concrete instruction to Starnet. If its current workstream is busy, the instruction is queued as a follow-up.',
    parameters: {
      type: 'object',
      properties: { instruction: { type: 'string', description: 'The complete instruction to send to the active Starnet agent.' } },
      required: ['instruction'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'interrupt_starnet_task',
    description: 'Stop the active Starnet task when the user explicitly asks to stop, cancel, or change direction.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'A short user-stated reason for the interruption.' } },
      additionalProperties: false
    }
  }
];

function sessionConfig(opts) {
  opts = opts || {};
  return {
    type: 'realtime',
    model: opts.model || DEFAULT_MODEL,
    output_modalities: ['audio'],
    /* PLACEHOLDER ONLY. The page replaces these over the data channel the instant it opens, with the selected
       agent's own composed prompt and the live station context — only the page knows who is selected. Written
       so that even this first second does not claim a separate identity: the previous text opened with "You
       are Starnet Voice, a control layer", which is exactly the separate-entity feel being fixed. */
    instructions: [
      'You are the Agent OS agent the Commander is currently speaking with. Fuller instructions, including your name and character, arrive immediately over the session channel — adopt them as your own identity when they do.',
      'Speak naturally and briefly. Let the user interrupt you.',
      'For requests that require research, coding, file changes, tools, or sustained work, call start_starnet_task instead of claiming you performed the work yourself.',
      'Use get_starnet_status for progress questions. Never invent task state, tool results, approvals, or files.',
      'Use interrupt_starnet_task only after the user clearly asks to stop or redirect current work.',
      'After starting or queuing work, confirm in one short sentence and explain that progress remains visible in Starnet.',
      'Do not ask for credentials or repeat secrets aloud.'
    ].join(' '),
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'auto',
          create_response: true,
          interrupt_response: true
        }
      },
      output: { voice: opts.voice || DEFAULT_VOICE }
    },
    tools: TOOLS,
    tool_choice: 'auto'
  };
}

function safetyIdentifier(seed) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(String(seed || 'starnet-local')).digest('hex').slice(0, 64);
}

/* THE CONNECTED PROVIDER IS THE CREDENTIAL. Live voice must never ask for a second, voice-only key: the
   whole promise is "connect your provider or subscription and talk to your agent". A ChatGPT subscription
   authorizes this endpoint directly — its access token carries `aud: https://api.openai.com/v1`, and a call
   with a stub offer comes back `invalid_offer` ("Offer did not have an audio media section"), i.e. it passed
   AUTH and session validation and failed only on the dummy SDP. The earlier wiring resolved an OpenAI API
   KEY, which a subscription user simply does not have, so this reported itself unavailable to the very users
   it was built for.

   `resolveCredential` is async on purpose: a subscription's access token has to be refreshed when it nears
   expiry, and that is a network round-trip. `hasCredential` stays synchronous so `status()` can answer a
   poll without touching the network. */
function makeRealtimeVoice(opts) {
  opts = opts || {};
  const fetchFn = opts.fetch || globalThis.fetch;
  const legacyResolve = opts.resolveKey || (() => '');
  const resolveCredential = opts.resolveCredential || (async () => legacyResolve());
  const hasCredential = opts.hasCredential || (() => !!String(legacyResolve() || '').trim());
  // The provider's own descriptor decides the endpoint, model and voice. Falling back to the OpenAI
  // constants keeps the older single-provider construction working for tests.
  const profileFor = opts.profileFor || (() => ({ transport: 'webrtc', url: OPENAI_REALTIME_URL, model: opts.model || DEFAULT_MODEL, voice: opts.voice || DEFAULT_VOICE }));
  const safetyId = safetyIdentifier(opts.safetySeed);

  /* What can THIS provider do for live voice, right now?
       mode 'native'     — the provider speaks and listens itself (best: its own voice, true barge-in)
       mode 'composed'   — it has no voice API, so its INTELLIGENCE drives the session while speech is
                           handled around it. Still one window, still no second key.
       connected:false   — nothing is connected yet, which is a Settings problem, not a voice problem. */
  function status(provider) {
    const lv = profileFor(provider);
    const connected = !!hasCredential(provider);
    return {
      provider: provider || '',
      connected,
      mode: lv ? 'native' : 'composed',
      available: connected && !!lv,
      model: (lv && lv.model) || '',
      voice: (lv && lv.voice) || '',
      transport: (lv && lv.transport) || '',
      voices: lv ? VOICES.slice() : []
    };
  }

  async function createCall(sdp, provider, wantVoice) {
    /* ⛔ NEVER `.trim()` AN SDP. Every line must be CRLF-terminated, including the last one: strip that final
       newline and the parser at the far end runs off the end and answers `failed to unmarshal SDP: EOF`. That
       one call was the whole reason a live call could never connect — the offer was valid, the credential was
       valid, and the byte-identical body posted straight to the provider returned 201 while the same body
       through here returned 400. Validate on a trimmed COPY; send the original, newline-terminated. */
    const raw = String(sdp == null ? '' : sdp);
    if (!raw.trim() || raw.length > (1 << 20)) {
      return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid SDP offer' }) };
    }
    const offer = /\r?\n$/.test(raw) ? raw : raw + '\r\n';
    const lv = profileFor(provider);
    if (!lv) {
      return { status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'this provider has no native voice endpoint', mode: 'composed' }) };
    }
    let key = '';
    try { key = String((await resolveCredential(provider)) || '').trim(); }
    catch (e) {
      // A refresh that failed is NOT "no provider connected" — say which it is, or the panel tells the user
      // to connect an account they already connected.
      return { status: 401, contentType: 'application/json', body: JSON.stringify({ error: (e && e.message) || 'provider sign-in expired — reconnect it in Settings' }) };
    }
    if (!key) {
      return { status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'connect an AI provider or subscription to use live voice' }) };
    }
    const form = new FormData();
    form.set('sdp', offer);
    form.set('session', JSON.stringify(sessionConfig({ model: lv.model, voice: normalizeVoice(wantVoice) || lv.voice })));
    let upstream;
    try {
      upstream = await fetchFn(lv.url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'OpenAI-Safety-Identifier': safetyId
        },
        body: form
      });
    } catch (_) {
      return { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Realtime service could not be reached' }) };
    }
    const body = await upstream.text();
    const contentType = upstream.headers && upstream.headers.get
      ? (upstream.headers.get('content-type') || (upstream.ok ? 'application/sdp' : 'application/json'))
      : (upstream.ok ? 'application/sdp' : 'application/json');
    return { status: upstream.status, contentType, body };
  }

  return { status, createCall };
}

module.exports = { DEFAULT_MODEL, DEFAULT_VOICE, VOICES, normalizeVoice, TOOLS, sessionConfig, safetyIdentifier, makeRealtimeVoice };
