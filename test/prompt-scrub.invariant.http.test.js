'use strict';
/* node test/prompt-scrub.invariant.http.test.js — a key the Commander typed once never rides a LATER run's prompt
   (context-key-redact, 2026-10-28).

   THE BUG (found 10-27 in a live rig): the station's <run_context> <commander_evidence> RECENT ACTIVITY lines quoted
   EARLIER directives with their raw vendor keys, and with the value the station holds in its key vault, into every
   later run's model context — next to the redacted transcript form of the same turns. The night-shift directive, a
   clarified task's ORIGINAL REQUEST and the TOPIC evidence quotes did the same.

   A REAL sidecar (spawned, never required) on a hermetic temp profile against a local CAPTURING OpenAI-compatible
   mock that records every request body, tagged with the phase that sent it. Fake keys only (helpers/fake-keys.js).
     Phase A  legacy raw rows written to disk BEFORE boot (what older builds left): run titles holding a key whole,
              cut at a 120-char title boundary mid-key, and a vault value whole and cut; interest evidence quotes
              holding the vault value and a cut Google key; an open thread whose title and spec hold keys (a turn-in
              edit stores them raw).
     Phase B  live seeding through real routes: a dossier holding a key (and the roster persona embedding that dossier,
              as the page bakes it into every agent's system prompt), a GOAL holding a key whole plus one the 280-char
              store cut leaves mid-key, a JOURNEY goal whose text and success condition hold keys, a QUEST whose title
              holds one, one /api/run per vendor family (each in its own conversation), a shapeless value typed while
              unheld, then POST /api/servicekeys — now the station HOLDS it.
     Phase C  later lanes whose typed words hold no key (except ASK1): an interactive run (with the page persona), the
              DEV channel, a routine fire, a night-shift beat (TONIGHT'S FOCUS), a quest refresh, an internal
              evidence:true run, ASK1 (types a key; the model asks one question) and ASK2 (the answer, a LATER run
              continuing that Task Brief).
   Asserts:
     I1 no captured request carries a key, whole or as ANY 12-char window of its secret part, unless that request's
        own phase typed it (the shapeless vault value is exempt only BEFORE the station held it: no shape, no vault)
     I2 evidence still flows: RECENT ACTIVITY and TOPIC lines with placeholders reach later runs; ASK2 still carries
        its ORIGINAL REQUEST; the night directive leads with TONIGHT'S FOCUS; the quest refresh carries its goal
        progress; the internal evidence run carries the evidence pack; the persona keeps its dossier words
     I3 the live turn is untouched: ASK1's own request carries its key raw (keys.save reads it); every chat request
        ends on a user turn
     I4 at rest: new run titles hold no key; the legacy rows are still raw on disk (read-side scrub, no migration) */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const FK = require('./helpers/fake-keys.js');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-prompt-scrub-'));
const WS = path.join(tmp, 'workspace'), PROFILE = path.join(tmp, 'profile');
for (const d of [WS, path.join(PROFILE, 'AppData', 'Roaming'), path.join(PROFILE, 'AppData', 'Local'), path.join(PROFILE, 'xdg')]) fs.mkdirSync(d, { recursive: true });
const { list: KEYS, by: K } = FK.make('prompt-scrub-invariant');
const PROVIDER_KEY = 'sk-or-v1-' + FK.stream('invariant-provider', 64, '0123456789abcdef');

// ---------- the capturing mock provider ----------
let phase = 'boot', lastHit = Date.now(), panelSeq = Infinity;
const captures = [];   // { seq, phase, url, body }
const flat = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : (c == null ? '' : String(c)));
const LEAD = /^\s*<(run_context|recalled-memory|conversation_summary|crew_call)>[\s\S]*?<\/\1>\s*/;
function ownWords(t) { t = String(t || ''); for (;;) { const m = LEAD.exec(t); if (!m) break; t = t.slice(m[0].length); } return t.replace(/<crew_call>[\s\S]*<\/crew_call>\s*$/, '').trim(); }
function sse(res, msg) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id: 'inv', choices: [{ index: 0, delta: { role: 'assistant', content: msg } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'inv', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const KEYLIKE = /[A-Za-z0-9_\-]{24,}/;
function decide(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const all = msgs.map(m => flat(m && m.content)).join('\n');
  let lastUser = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; }
  const words = lastUser >= 0 ? ownWords(flat(msgs[lastUser].content)) : '';
  // the interests intake pass: quote ONE activity line verbatim, as its directive demands (a key rides along if present)
  if (/station's intake analyst/.test(all)) {
    const act = (all.split('RECENT ACTIVITY')[1] || '').split('\n').filter(l => /^\s*•/.test(l)).map(l => l.replace(/^\s*•\s*/, ''));
    if (!act.length) return 'NONE';
    const keyed = act.filter(l => KEYLIKE.test(l));
    const frag = l => { const m = KEYLIKE.exec(l); const at = m ? Math.max(0, m.index - 30) : 0; return l.slice(at, at + 120).replace(/[|\n]/g, ' ').trim(); };
    return 'TOPIC: outreach api setup | EVIDENCE: ' + frag(keyed[0] || act[0]);
  }
  if (/INV-ASK1/.test(words)) return 'I need one detail first.\nTASK_QUESTION: Which repo should the issue go in? || starnet | docs';
  return 'Done.';
}
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    lastHit = Date.now();
    if (req.method === 'GET' && /\/models/.test(req.url)) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'test/model', name: 'Invariant model', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let body = null; try { body = JSON.parse(raw); } catch (_) {}
    captures.push({ seq: captures.length + 1, phase, url: req.url, body: body == null ? raw : body });
    if (!/chat\/completions/.test(req.url)) { res.setHeader('Content-Type', 'application/json'); return res.end('{"data":{}}'); }
    let msg; try { msg = decide(body || {}); } catch (_) { msg = 'Done.'; }
    sse(res, msg);
  });
});

// ---------- Phase A: legacy raw rows, on disk before boot ----------
const NOW = Date.now(), HOUR = 3600000;
const cutTitle = (lead, k, bodyChars) => (lead + ' ' + k.value).slice(0, lead.length + 1 + k.prefix.length + bodyChars);
const LEGACY_TITLES = [
  'LEGACY-1 openai ' + K.OPENAI.value + ' list my models',
  cutTitle('LEGACY-2 geocode the office with google maps key', K.GOOGLE, 16),
  'LEGACY-3 instantly ' + K.VAULT.value + ' pull my campaigns',
  cutTitle('LEGACY-4 instantly', K.VAULT, 15)
];
fs.writeFileSync(path.join(WS, 'runs.jsonl'), LEGACY_TITLES.map((title, i) => JSON.stringify({
  runId: 'legacy-' + i, agentId: 'agent', provider: 'openrouter', reason: 'done', turns: 1, tokens: 10, usd: 0, title,
  streamId: 'legacy' + i, model: 'test/model', internal: false, surface: 'interactive', ownerDirective: true, ts: NOW - HOUR - i * 1000
})).join('\n') + '\n');
const interests = { v: 1, state: { v: 1, topics: {}, lastPassAt: NOW, runsSincePass: 0, trustedTopics: {
  'legacy-outreach': { label: 'legacy outreach', w: 3, n: 3, lastAt: NOW - HOUR, ev: [{ q: 'LEGACY-3 instantly ' + K.VAULT.value + ' pull my campaigns (today)', at: NOW - HOUR }] },
  'legacy-maps': { label: 'legacy maps', w: 2.5, n: 2, lastAt: NOW - HOUR, ev: [{ q: cutTitle('geocode with', K.GOOGLE, 18), at: NOW - HOUR }] }
} } };
fs.writeFileSync(path.join(WS, 'scout.interests.json'), JSON.stringify(interests));
// an open thread edited raw at turn-in (threads-store keeps title + spec as typed)
fs.writeFileSync(path.join(WS, 'threads.json'), JSON.stringify({ threads: [{ id: 'th_legacy', state: 'open', createdAt: NOW - HOUR, updatedAt: NOW - HOUR,
  title: 'LEGACY-T rotate the deploy key ' + K.GITHUB.value, spec: ('he said ' + 'z'.repeat(150) + ' ' + K.ANTHROPIC.value).slice(0, 180) }], declined: [] }));

// the page persona: the page bakes the Commander's dossier into every agent's stored systemPrompt (frontend/app/app.js)
const DOSSIER = 'Runs an outreach agency. Our OpenRouter key: ' + K.OPENROUTER.value;
const PAGE_SYSTEM = 'You are Hero, the station lead. Answer briefly.\n\nCOMMANDER DOSSIER\n' + DOSSIER;
// the goal: a key whole, and a second the 280-char store cut leaves mid-key (AIza + 16 body chars survive the cut)
const GOAL_HEAD = 'Ship outreach v2 using openai ' + K.OPENAI.value + ' ';
const GOAL_TEXT = GOAL_HEAD + 'outreach plan detail '.repeat(20).slice(0, 259 - GOAL_HEAD.length) + ' ' + K.GOOGLE.value + ' and finish';

// ---------- the sidecar ----------
let child = null, base = '', headers = null, log = '';
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function hermeticEnv(port, mockPort) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SKYNET|STARNET)_/i.test(k) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k) || /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(k)) continue;
    env[k] = v;
  }
  const orBase = 'http://127.0.0.1:' + mockPort + '/api/v1';
  return Object.assign(env, {
    APPDATA: path.join(PROFILE, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(PROFILE, 'AppData', 'Local'), XDG_DATA_HOME: path.join(PROFILE, 'xdg'),
    USERPROFILE: PROFILE, HOME: PROFILE,
    SKYNET_WORKSPACES: WS, SKYNET_PORT: String(port), SKYNET_DEV: '1',
    SKYNET_OPENROUTER_BASE: orBase, STARNET_OPENROUTER_BASE: orBase, SKYNET_OPENROUTER_KEY: PROVIDER_KEY,
    SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '1',
    SKYNET_EDGE_TTS: '0', SKYNET_EDGE_TTS_PROBE: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1'
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function boot(mockPort) {
  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.join(root, 'sidecar', 'index.js')], { cwd: root, env: hermeticEnv(port, mockPort), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', d => { log = (log + d).slice(-4000); }); child.stderr.on('data', d => { log = (log + d).slice(-4000); });
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('sidecar exited ' + child.exitCode + ': ' + log.slice(-1500));
    try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }); if (r.status === 200) break; } catch (_) {}
    if (Date.now() > deadline) throw new Error('sidecar never became healthy: ' + log.slice(-1500));
    await sleep(200);
  }
  const html = await (await fetch(base + '/', { headers: { Origin: base } })).text();
  const m = html.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
  headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': m ? JSON.parse(m[1]) : '', Origin: base };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(r => child.once('exit', r));
  try { child.kill(); } catch (_) {}
  await Promise.race([done, sleep(5000)]);
  if (child.exitCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch (_) {} await Promise.race([done, sleep(2000)]); }
}
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}
async function idle(ms, max) { const t0 = Date.now(); while (Date.now() - lastHit < ms && Date.now() - t0 < (max || 30000)) await sleep(150); }
async function run(label, text, o) {
  o = o || {};
  phase = label;
  // the page sends its composed persona (dossier baked in) as `system` on every interactive run
  const body = Object.assign({ agentId: 'agent', key: PROVIDER_KEY, model: 'test/model', isTask: true, placed: ['dish'], system: PAGE_SYSTEM, streamId: o.streamId || ('inv' + label), messages: o.messages || [{ role: 'user', content: text }] }, o.extra || {});
  const r = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify(body) });
  const events = (await r.text()).split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  const end = events.filter(e => e.name === 'agent.run.end').pop();
  await idle(1500);
  return end && end.payload && end.payload.reason;
}
const TYPED = {};   // phase -> the key ids its own words typed

(async () => {
  mock.listen(0, '127.0.0.1');
  await new Promise(r => mock.once('listening', r));
  try {
    await boot(mock.address().port);
    phase = 'setup';
    A.eq((await api('POST', '/api/roster', { agents: [{ agentId: 'agent', name: 'Hero', model: 'test/model', provider: 'openrouter', system: PAGE_SYSTEM }] })).status, 200, 'setup: roster saved (its persona embeds the dossier, as the page does)');
    // ---- Phase B: live seeding ----
    A.eq((await api('POST', '/api/dossier', { block: DOSSIER })).status, 200, 'setup: a dossier holding a key is saved');
    phase = 'GOAL';
    const goal = await api('POST', '/api/goals', { goal: { id: 'g1', text: GOAL_TEXT, done: 0, total: 2, pct: 0, next: 'rotate ' + K.SLACK.value + ' tonight', milestoneId: 'm1', milestones: [{ id: 'm1', text: 'step one' }, { id: 'm2', text: 'step two' }] } });
    A.ok(goal.status === 200 && goal.json && goal.json.goal && goal.json.goal.text.length === 280 && goal.json.goal.text.indexOf(K.GOOGLE.value) < 0, 'phase B: the goal is stored, its second key cut mid-key at 280');
    phase = 'JOURNEY';
    const jr = await api('POST', '/api/journey', { op: 'goal.register', epoch: 1, id: 'g1', text: 'Grow outreach with github ' + K.GITHUB.value, successCondition: 'done when anthropic ' + K.ANTHROPIC.value + ' is rotated' });
    A.ok(jr.status === 200 && jr.json && jr.json.ok !== false, 'phase B: the journey goal is registered');
    phase = 'QUEST';
    const qm = await api('POST', '/api/quests/mint', { title: 'Rotate ' + K.OPENROUTER.value, contract: { type: 'attest', key: '' }, createdBy: 'commander' });
    A.ok(qm.status === 200, 'phase B: a quest whose title holds a key is minted');
    await idle(1000);
    const FAMILY = [['P8', 'VAULT', 'instantly', 'pull my campaigns'], ['P1', 'OPENROUTER', 'openrouter', 'check my credits please'], ['P2', 'OPENAI', 'openai', 'list my models'],
      ['P3', 'ANTHROPIC', 'anthropic', 'check my usage'], ['P4', 'GOOGLE', 'google maps', 'geocode our office'], ['P5', 'GITHUB', 'github', 'list my repos'], ['P6', 'SLACK', 'slack', 'post the standup']];
    for (const [label, id, service, ask] of FAMILY) {
      TYPED[label] = [id];
      A.eq(await run(label, 'INV-' + label + ' ' + service + ' ' + K[id].value + ' ' + ask), 'done', 'phase B: ' + label + ' run completed');
    }
    phase = 'PANEL';
    const saved = await api('POST', '/api/servicekeys', { name: 'Instantly', key: K.VAULT.value });
    A.ok(saved.status === 200 && saved.json && saved.json.ok, 'phase B: the vault value is saved through the KEYS panel route');
    panelSeq = captures.length;
    await idle(1000);
    // ---- Phase C: later lanes ----
    A.eq(await run('W1', 'INV-W1 summarize what I have going on this week'), 'done', 'phase C: W1 completed');
    phase = 'DEV';
    const dev = await api('POST', '/api/dev/inbound', { text: 'INV-DEV check my outreach numbers', chatId: 'invdev' });
    await idle(1500);
    A.eq(dev.status, 200, 'phase C: the DEV channel inbound ran');
    phase = 'CRON';
    const cron = await api('POST', '/api/cron', { name: 'Invariant digest', prompt: 'INV-CRON compile a short morning digest of my outreach work', schedule: '0 9 * * *', agentId: 'agent' });
    const jobId = cron.json && cron.json.job && cron.json.job.id;
    A.ok(!!jobId, 'phase C: a routine was created');
    if (jobId) { await api('POST', '/api/cron/run', { id: jobId }); await idle(2500, 60000); }
    phase = 'NIGHT';
    const night = await fetch(base + '/api/nightshift/beat', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent' }) });
    await night.text(); await idle(1500);
    phase = 'QREF';
    await api('POST', '/api/quests/refresh/run', {});
    await idle(2500, 60000);
    A.eq(await run('INT', '', { extra: { internal: true, evidence: true, isTask: false, system: 'You recommend the Commander\'s next step. Reply with ONE line.' }, messages: [{ role: 'user', content: 'INV-INT what should the Commander do next?' }] }), 'done', 'phase C: an internal evidence:true run completed');
    TYPED.ASK1 = ['ASKKEY'];
    A.eq(await run('ASK1', 'INV-ASK1 open an issue on my tracker with openai key ' + K.ASKKEY.value + ' for the triage bot', { streamId: 'invASK' }), 'clarifying', 'phase C: ASK1 ends asking its question');
    phase = 'ASK2';
    const tr = await api('GET', '/api/transcript?agent=agent&stream=invASK&limit=200');
    const hist = ((tr.json && tr.json.turns) || []).filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string').map(t => ({ role: t.role, content: t.content }));
    A.eq(await run('ASK2', '', { streamId: 'invASK', messages: hist.concat([{ role: 'user', content: 'INV-ASK2 the starnet repo' }]) }), 'done', 'phase C: ASK2 (the answer) completed');
    phase = 'final';
  } catch (e) {
    A.ok(false, 'scenario threw: ' + ((e && e.stack) || e));
  } finally {
    await stop();
    await new Promise(r => mock.close(r));
  }

  // ---------- assertions ----------
  const chat = captures.filter(c => /chat\/completions/.test(c.url) && c.body && typeof c.body === 'object');
  A.ok(chat.length >= 14, 'the scenario reached the provider (' + chat.length + ' chat requests)');
  // I1
  const hits = [];
  for (const c of captures) {
    const wire = typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
    for (const k of KEYS) {
      if ((TYPED[c.phase] || []).indexOf(k.id) >= 0) continue;              // that request's own words typed it
      if (k.id === 'VAULT' && c.seq <= panelSeq) continue;                  // shapeless and not held yet: undetectable by design
      const leak = FK.leak(wire, k);
      if (leak) hits.push('#' + c.seq + ' ' + c.phase + ' ' + k.id + ' ' + leak);
    }
  }
  A.eq(hits, [], 'I1: no later request carries a key typed in another phase (whole or any 12-char window)');
  // I2
  const later = chat.filter(c => c.seq > panelSeq);
  const text = c => JSON.stringify(c.body);
  A.ok(later.some(c => /- RECENT ACTIVITY: [^"\\]*\[redacted-(?:key|secret)\]/.test(text(c))), 'I2: RECENT ACTIVITY lines still reach later runs, with placeholders where the keys were');
  A.ok(later.some(c => /- TOPIC: /.test(text(c))), 'I2: TOPIC evidence still reaches later runs');
  A.ok(later.filter(c => c.phase === 'NIGHT').length >= 1, 'I2: the night-shift beat asked the model');
  const ask2 = later.filter(c => c.phase === 'ASK2');
  A.ok(ask2.some(c => /ORIGINAL REQUEST: INV-ASK1 open an issue on my tracker with openai key \[redacted-key\]/.test(text(c))), 'I2: ASK2 continues the brief: its ORIGINAL REQUEST keeps the words, key replaced');
  A.ok(later.some(c => c.phase === 'NIGHT' && /TONIGHT'S FOCUS: [^"\\]*\[redacted-(?:key|secret)\]/.test(text(c))), 'I2: the night directive leads with TONIGHT\'S FOCUS, its stored key replaced');
  A.ok(later.some(c => c.phase === 'QREF' && /GOAL PROGRESS AND COMMANDER FEEDBACK/.test(text(c)) && /\[redacted-key\]/.test(text(c))), 'I2: the quest refresh still carries its goal progress, keys replaced');
  A.ok(later.some(c => c.phase === 'INT' && /RECENT ACTIVITY|<commander_evidence|<active_goal/.test(text(c))), 'I2: the internal evidence:true run still carries the evidence pack');
  A.ok(later.some(c => c.phase === 'W1' && /COMMANDER DOSSIER\\nRuns an outreach agency\. Our OpenRouter key: \[redacted-key\]/.test(text(c))), 'I2: the page persona keeps its dossier words, key replaced');
  // I3
  const ask1 = chat.filter(c => c.phase === 'ASK1');
  A.ok(ask1.some(c => { const m = c.body.messages || []; const u = m[m.length - 1]; return u && u.role === 'user' && ownWords(flat(u.content)).indexOf(K.ASKKEY.value) >= 0; }), 'I3: the live turn is untouched: ASK1 sends its own key raw (keys.save reads it there)');
  A.eq(chat.filter(c => { const m = c.body.messages || []; return !m.length || m[m.length - 1].role !== 'user'; }).map(c => c.phase), [], 'I3: every chat request ends on a user turn');
  // I4
  let rows = [];
  try { rows = fs.readFileSync(path.join(WS, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) {}
  const fresh = rows.filter(r => !/^legacy-/.test(r.runId));
  A.ok(fresh.length >= 8, 'I4: the scenario recorded its runs (' + fresh.length + ')');
  // P8's own title was written while the vault value was neither shaped nor held: undetectable then, by design (it is
  // kept out of every LATER prompt by the read side once held, which I1 proves)
  A.eq(fresh.map(r => KEYS.filter(k => FK.leak(r.title, k) && !(k.id === 'VAULT' && /^INV-P8 /.test(r.title))).map(k => k.id)).flat(), [], 'I4: new run titles hold no key (scrubbed before the 120-char cut)');
  A.ok(fresh.some(r => /^INV-P8 /.test(r.title) && r.title.indexOf(K.VAULT.value) >= 0), 'I4: (the unheld shapeless value typed in P8 is on disk raw: the documented residual)');
  A.ok(fresh.some(r => /^INV-P2 openai \[redacted-key\] list my models/.test(r.title)), 'I4: a new run title keeps its words around the placeholder');
  const legacy = rows.filter(r => /^legacy-/.test(r.runId)).map(r => r.title);
  A.eq(legacy, LEGACY_TITLES, 'I4: legacy rows stay raw on disk (the read side keeps them out of prompts; no migration)');

  if (A.fails()) console.log('sidecar log tail:\n' + log.slice(-1500));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  A.report('prompt-scrub.invariant.http.test');
})().catch(async e => { console.error(e); try { await stop(); } catch (_) {} process.exit(1); });
