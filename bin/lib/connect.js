/* bin/lib/connect.js — the terminal's /connect: the providers the app lists under SETTINGS › AI & MODELS, in its four
   groups and its order, with the names the app gives them (frontend/app/stationui.js PROVIDERS + PROVIDER_GROUPS —
   test/cli-connect.test.js holds the two lists equal, so a provider added to the app shows up here or the gate fails).

   What each row says is what the station can prove: a key saved, a sign-in held, a link with its balance, Claude Code
   installed and signed in, Ollama answering. How each one connects is the app's own way:
     credits      link the station to a StarNet account (the awakening's link-code flow)
     device       a device-code sign-in (ChatGPT, Grok, Kimi)
     claude       Claude Code's own sign-in
     local        Ollama on this computer (nothing to save: it answers or it does not)
     key          an API key, typed hidden and saved where the app keeps keys (POST /api/providers/connect)
     custom       an endpoint URL, then an optional key */
'use strict';

const PROVIDERS = [
  { id: 'starnet', name: 'STARNET MANAGED', endpoint: 'managed inference · credits', blurb: 'no API key — runs on your balance' },
  { id: 'openrouter', name: 'OPENROUTER', endpoint: 'openrouter.ai/api/v1', blurb: 'one key · 300+ models' },
  { id: 'codex', name: 'CHATGPT (CODEX)', endpoint: 'OAuth · ChatGPT subscription', blurb: 'sign-in, no API key' },
  { id: 'grok', name: 'GROK (XAI)', endpoint: 'OAuth · SuperGrok / X Premium+', blurb: 'sign-in, no API key' },
  { id: 'kimi', name: 'KIMI FOR CODING', endpoint: 'OAuth · Moonshot subscription', blurb: 'sign-in, no API key' },
  { id: 'openai', name: 'OPENAI API', endpoint: 'api.openai.com/v1', blurb: 'OpenAI-compatible' },
  { id: 'anthropic', name: 'ANTHROPIC', endpoint: 'api.anthropic.com/v1', blurb: 'Claude native API' },
  { id: 'gemini', name: 'GEMINI', endpoint: 'generativelanguage.googleapis.com/v1beta', blurb: 'Google native API' },
  { id: 'xai', name: 'XAI', endpoint: 'api.x.ai/v1', blurb: 'Grok API' },
  { id: 'groq', name: 'GROQ', endpoint: 'api.groq.com/openai/v1', blurb: 'fast inference' },
  { id: 'mistral', name: 'MISTRAL', endpoint: 'api.mistral.ai/v1', blurb: 'Mistral API' },
  { id: 'deepseek', name: 'DEEPSEEK', endpoint: 'api.deepseek.com', blurb: 'DeepSeek API' },
  { id: 'together', name: 'TOGETHER', endpoint: 'api.together.ai/v1', blurb: 'Together API' },
  { id: 'fireworks', name: 'FIREWORKS', endpoint: 'api.fireworks.ai/inference/v1', blurb: 'Fireworks API' },
  { id: 'perplexity', name: 'PERPLEXITY', endpoint: 'api.perplexity.ai', blurb: 'Sonar API' },
  { id: 'cerebras', name: 'CEREBRAS', endpoint: 'api.cerebras.ai/v1', blurb: 'Cerebras API' },
  { id: 'ollama', name: 'OLLAMA', endpoint: '127.0.0.1:11434/v1', blurb: 'local models' },
  { id: 'claude-cli', name: 'CLAUDE CODE', endpoint: 'local `claude` command', blurb: 'your Claude subscription' },
  { id: 'custom', name: 'CUSTOM', endpoint: 'any /v1 base URL', blurb: 'bring your endpoint' }
];
const GROUPS = [
  { id: 'credits', label: 'STARNET CREDITS', note: 'link this station once, nothing to paste', short: 'CREDITS', ids: ['starnet'] },
  { id: 'subscription', label: 'A SUBSCRIPTION YOU HAVE', note: 'sign in, no API key', short: 'SUBSCRIPTION', ids: ['codex', 'grok', 'kimi', 'claude-cli'] },
  { id: 'key', label: 'AN API KEY', note: 'paste a key from the service’s website', short: 'API KEY' },
  { id: 'own', label: 'YOUR OWN MODELS', note: 'on this computer, or a server you run', short: 'YOUR OWN', ids: ['ollama', 'custom'] }
];
const DEVICE = { codex: 'ChatGPT', grok: 'Grok', kimi: 'Kimi' };

const groupOf = id => GROUPS.find(g => g.ids && g.ids.indexOf(id) >= 0) || GROUPS.find(g => !g.ids);
// the app's order: each group's providers in PROVIDERS order, the groups in GROUPS order
const ordered = () => GROUPS.reduce((out, g) => out.concat(PROVIDERS.filter(p => groupOf(p.id) === g)), []);
// what a card says under its name (the app's providerNeed): the subscription for a sign-in, else the blurb
const need = p => /^OAuth · /.test(p.endpoint) ? p.endpoint.slice('OAuth · '.length) : p.blurb;
function flowOf(id) {
  if (id === 'starnet') return 'credits';
  if (DEVICE[id]) return 'device';
  if (id === 'claude-cli') return 'claude';
  if (id === 'ollama') return 'local';
  if (id === 'custom') return 'custom';
  return 'key';
}
// the awakening's brain for a sign-in flow (bin/lib/awaken.js signIn takes { id, flow, path })
function brainOf(id) {
  const f = flowOf(id);
  return f === 'device' ? { id, flow: 'device', path: id } : f === 'claude' ? { id, flow: 'claude' } : f === 'credits' ? { id, flow: 'credits' } : f === 'local' ? { id, flow: 'local' } : null;
}
// a typed name -> the provider: its id, its name, or a name's first word ("chatgpt", "claude code", "grok")
function find(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return null;
  const alias = { chatgpt: 'codex', claude: 'claude-cli', 'claude code': 'claude-cli', credits: 'starnet', starnet: 'starnet', moonshot: 'kimi', google: 'gemini' };
  const id = alias[w] || w;
  return PROVIDERS.find(p => p.id === id) || PROVIDERS.find(p => p.name.toLowerCase() === w)
    || PROVIDERS.find(p => p.name.toLowerCase().split(/[\s(]+/)[0] === w) || null;
}

/* What a row says, from facts the station gave: { configured: Set of ids (/api/providers), credits: { state, balanceUsd },
   claude: /api/auth/claude-cli/status json | null, ollama: true|false|undefined }. -> [text, style]. Never a guess: a
   fact not read says so (CHECKING…), a key provider is KEY SAVED (presence, the app's own word), not "working". */
function status(p, f) {
  const facts = f || {};
  const on = !!(facts.configured && facts.configured.has(p.id));
  switch (flowOf(p.id)) {
    case 'credits': {
      const c = facts.credits || {};
      if (c.state === 'linked') return ['● LINKED' + (typeof c.balanceUsd === 'number' ? ' · $' + c.balanceUsd.toFixed(2) : ''), 'ok'];
      if (c.state === 'saved') return ['◌ LINK SAVED · SERVICE UNAVAILABLE', 'am'];
      return ['○ NOT LINKED', 'dim'];
    }
    case 'device': return on ? ['● SIGNED IN', 'ok'] : ['○ NOT SIGNED IN', 'dim'];
    case 'claude': {
      const c = facts.claude;
      if (c === undefined) return ['◐ CHECKING CLAUDE CODE…', 'dim'];
      if (!c) return ['○ COULDN’T CHECK CLAUDE CODE', 'dim'];
      if (!c.installed) return ['○ CLAUDE CODE NOT INSTALLED', 'dim'];
      return c.loggedIn ? ['● SIGNED IN', 'ok'] : ['○ NOT SIGNED IN', 'dim'];
    }
    case 'local':
      return facts.ollama === undefined ? ['◐ CHECKING…', 'dim'] : facts.ollama ? ['● REACHABLE', 'ok'] : ['○ NOT ANSWERING', 'dim'];
    case 'custom': return on ? ['● ENDPOINT SAVED', 'ok'] : ['○ NO ENDPOINT', 'dim'];
    default: return on ? ['● KEY SAVED', 'ok'] : ['○ NO KEY', 'dim'];
  }
}

// a URL the way the app stores a CUSTOM endpoint (stationui.js normEndpoint): a bare host gets a scheme; null = not a URL
function normEndpoint(raw) {
  let n = String(raw || '').trim();
  if (!n) return '';
  if (!/^https?:\/\//i.test(n)) n = (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(n) ? 'http://' : 'https://') + n.replace(/^\/+/, '');
  try { new URL(n); return n; } catch (_) { return null; }
}

/* Save a key (and a CUSTOM endpoint) where the station keeps it. st: station-io ({ post }). -> { ok, store, error }.
   The station hands it to the app's page (keychain / browser); a station with no page and no keychain (one `starnet`
   started on its own) proves it here, then keeps its copy (/api/providers/engine-key — what its runs read). */
async function saveKey(st, provider, key, baseUrl) {
  const body = { provider, key: key || '' };
  if (baseUrl) body.baseUrl = baseUrl;
  const r = await st.post('/api/providers/connect', body, 60000);
  const j = (r && r.json) || {};
  if (r && r.status === 200 && j.ok) return { ok: true, store: j.store, verified: j.verified !== false };
  if (r && r.status === 404) return { ok: false, error: 'this station is older than /connect — update StarNet, or add the key in the app (SETTINGS › AI & MODELS)' };
  if (!(r && r.status === 409 && j.code === 'no-page')) return { ok: false, error: j.error || (r && r.error) || 'HTTP ' + (r && r.status) };
  if (key) {
    const v = await st.post('/api/providers/validate', body, 45000);
    const vj = (v && v.json) || {};
    if (!vj.credentialVerified) return { ok: false, error: (vj.error || (v && v.error) || 'the key could not be checked') };
  }
  const e = await st.post('/api/providers/engine-key', body, 20000);
  const ej = (e && e.json) || {};
  if (e && e.status === 200 && ej.ok) return { ok: true, store: 'station', verified: !!key };
  return { ok: false, error: ej.error || (e && e.error) || 'HTTP ' + (e && e.status) };
}

module.exports = { PROVIDERS, GROUPS, groupOf, ordered, need, flowOf, brainOf, find, status, normEndpoint, saveKey };
