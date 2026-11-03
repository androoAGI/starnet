/* node test/friendlyerror-codes.test.js — COMMS maps the station's failure CODE to words through one table
   (frontend/app/friendlyerror.js CODE_TO_KIND, typed-outcomes lane 2026-10-29).

   The page used to re-classify every failure from its words, a second ladder beside the sidecar's classifier, and the two
   disagreed: a ChatGPT 429 the station classed as a rate limit (its body's code said so) read on the page as a spent plan
   ("Codex quota exceeded" + the subscription re-read), a refused chat template and a server nothing answered at read
   "Something went wrong — try again". The station's code now rides agent.run.error / agent.run.end (failureCode) and
   Harness.chat hands it over; friendlyError(err, status, { code }) reads the kind from the table. Both loads are checked:
   node (the classifier delegated) and the browser shape (no require — the path real users run). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ErrorClass = require('../sidecar/providers/errorClass.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8');
const NodeF = require('../frontend/app/friendlyerror.js');
const BrowserF = (() => { const sb = { console }; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(src + '\nthis.__F = Friendly;', sb); return sb.__F; })();

// the station's real classification of each failure (the adapter's error shape, through errorClass)
const codex429 = ErrorClass.classifyApiError(Object.assign(new Error('codex http 429 — Codex quota exceeded'),
  { status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'Codex quota exceeded' } }, ownMessage: true }), {});
const codexPlan = ErrorClass.classifyApiError(Object.assign(new Error('codex http 429 — The usage limit has been reached'),
  { status: 429, body: { error: { code: 'usage_limit_reached', message: 'The usage limit has been reached' } }, ownMessage: true }), {});
const template = ErrorClass.classifyApiError(Object.assign(new Error('ollama http 500 - {"error":"Jinja Exception: System message must be at the beginning."}'),
  { status: 500, requestHost: 'localhost' }), { model: 'gemma3' });
const unreachable = ErrorClass.classifyApiError(Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 11434 }) }), {});
A.eq([codex429.reason, codexPlan.reason, template.reason, unreachable.reason], ['rate_limit', 'quota_exhausted', 'template_refusal', 'unreachable'],
  'fixture: the station classifies the four failures');
// a silent local /v1 server's turn end, as openai-compatible.js localSilenceError words it (local-runtime-silence.test.js pins the
// adapter's real text through the same reader), the wording before review M2, and native Ollama's loaded-model silence
const LOCAL_SILENT = "The model server at 127.0.0.1:1234 on this computer sent no response headers for 5 min after the request went out (connect phase), so this turn ended. StarNet did not re-send the request: a re-send would start the same prompt over on a server that may still be working on it. Check the server's own log (a model too big for that machine's memory can stall there), pick a smaller model in the COMMS model dock, or raise SKYNET_LOCAL_CONNECT_TIMEOUT_MS if it needs longer. [provider stream connect timed out after 300000ms with no bytes received]";
const LOCAL_SILENT_OLD = LOCAL_SILENT.replace("the server's own log (a model too big for that machine's memory can stall there)", "the server's own log and the context length it loaded the model with");
const OLLAMA_SILENT = 'provider stream connect timed out after 300000ms with no bytes received — Ollama on this computer had qwen3:8b loaded entirely on the CPU (no part of it is on a GPU) at a 8k window but sent no response to a ~6k-token prompt. A model running on the CPU reads StarNet task prompts slowly; a smaller model, or one that fits the GPU, answers sooner.';
A.eq(ErrorClass.classifyApiError(new Error(LOCAL_SILENT_OLD), {}).reason, 'context_overflow', 'fixture: the older wording re-read from text alone is a context overflow upstream (why COMMS must recognise the sentence)');
// what COMMS persists for an error row (chat.js errorHistoryLine): the verdict's userMessage
const historyLine = new Function(A.fnBody(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8'), 'function errorHistoryLine(') + '\nreturn errorHistoryLine;')();

for (const [where, F] of [['node', NodeF], ['browser', BrowserF]]) {
  // 1. the code decides — a ChatGPT 429 the classifier called a rate limit is a rate limit (doneMeans), a spent plan stays one
  const rl = F.friendlyError(codex429.message, null, { engineAlive: true, code: codex429.reason });
  A.eq([rl.kind, rl.retryable], ['rate_limit', true], where + ': a coded ChatGPT 429 renders as a rate limit');
  A.ok(!/allowance|plan/i.test(rl.userMessage), where + ': and never as a spent plan: ' + rl.userMessage);
  const plan = F.friendlyError(codexPlan.message, null, { engineAlive: true, code: codexPlan.reason });
  A.eq(plan.kind, 'quota_exhausted', where + ': a coded spent plan stays a spent plan');
  // 2. template_refusal and unreachable have their own words (they read "try again")
  const t = F.friendlyError(template.message, null, { engineAlive: true, code: template.reason });
  A.eq([t.kind, t.retryable, t.action], ['template_refusal', false, 'settings'], where + ': a refused chat template');
  A.ok(/^The chat template of the model gemma3 on localhost refused the conversation StarNet sent/.test(t.userMessage), where + ': it leads with the station\'s own sentence: ' + t.userMessage);
  A.ok(!/try again|went wrong/i.test(t.userMessage) && !/\[ollama http 500/.test(t.userMessage), where + ': no "try again", and the raw provider text stays in raw');
  A.eq(F.actionButton(t).label, '▸ PICK A MODEL', where + ': its door is the model dock (another model has another template)');
  const u = F.friendlyError(unreachable.message, null, { engineAlive: true, code: unreachable.reason });
  A.eq([u.kind, u.action], ['unreachable', 'settings'], where + ': nothing answered at the address');
  A.ok(/^StarNet is running, but nothing is listening at 127\.0\.0\.1:11434 on this computer/.test(u.userMessage), where + ': it names the address and what to start: ' + u.userMessage);
  A.ok(!/internet|VPN/i.test(u.userMessage), where + ': and never blames the internet for a server that is not started');
  // 3. the same words when an older station sent no code (the station's own sentence is recognised)
  A.eq(F.friendlyError(template.message, null, { engineAlive: true }).kind, 'template_refusal', where + ': an uncoded template refusal still reads as one');
  A.eq(F.friendlyError(unreachable.message, null, { engineAlive: true }).kind, 'unreachable', where + ': an uncoded unreachable still reads as one');
  // 4. a code that names nothing specific leaves the words to decide
  for (const generic of ['run_failure', 'provider_failure', 'unknown', 'format_error', 'no_terminal_outcome', '', null]) {
    A.eq(F.friendlyError('codex http 429 — Codex quota exceeded', null, { code: generic }).kind,
      F.friendlyError('codex http 429 — Codex quota exceeded').kind, where + ': code ' + JSON.stringify(generic) + ' changes nothing');
  }
  // 5. StarNet's own UI-level messages are read before the code (a sign-in, a busy agent)
  A.eq(F.friendlyError('Sign in with ChatGPT again — the refresh token was already used', null, { code: 'auth' }).kind, 'oauth', where + ': a dead ChatGPT sign-in keeps its reconnect door');
  A.eq(F.friendlyError('This agent is already running a task (started 3s ago from COMMS).', null, { code: 'run_failure' }).kind, 'agent_busy', where + ': a busy agent stays busy');
  // 6. the loop's own stop codes map onto their kinds even when the words changed
  A.eq(F.friendlyError('the agent repeated itself', null, { code: 'repeated_identical_failure' }).kind, 'loop_stuck', where + ': repeated_identical_failure');
  A.eq(F.friendlyError('spend ledger said no', null, { code: 'spend_history_unavailable' }).kind, 'spend_unknown', where + ': spend_history_unavailable');
  A.eq(F.friendlyError('no web — the DISH is gone', null, { code: 'capability_denied' }).kind, 'capdenied', where + ': capability_denied');
  // 7. a code may ride the error object itself
  A.eq(F.friendlyError(Object.assign(new Error(codex429.message), { failureCode: 'rate_limit' })).kind, 'rate_limit', where + ': an error object\'s own failureCode');
  // 8. a silent LOCAL server (local_timeout, local-runtime-profile review M2) has its own words: the station's sentence leads,
  //    no ↻ Try again, the model dock is the door — and it reads the same without the code (stationui's last-reason line)
  for (const code of ['local_timeout', undefined]) {
    const tag = where + ' (code ' + code + ')';
    const v = F.friendlyError(LOCAL_SILENT, null, { engineAlive: true, code });
    A.eq([v.kind, v.retryable, v.action], ['local_timeout', false, 'settings'], tag + ': a silent local server is local_timeout, not retryable');
    A.ok(v.userMessage.indexOf('The model server at 127.0.0.1:1234 on this computer sent no response headers for 5 min') === 0, tag + ': it leads with the station\'s sentence: ' + v.userMessage);
    A.ok(!/try again|took too long|fresh chat|\[provider stream/i.test(v.userMessage), tag + ': no "try again", no overflow advice, the raw words stay in raw');
    A.eq((F.actionButton(v) || {}).label, '▸ PICK A MODEL', tag + ': its door is the model dock');
    A.eq(historyLine(v), '⚠ ' + v.userMessage, tag + ': the persisted row keeps the sentence (it survives a switch-back)');
    const ipv6 = F.friendlyError(LOCAL_SILENT.replace('127.0.0.1:1234', '[::1]:1234'), null, { engineAlive: true, code });
    A.ok(ipv6.userMessage.indexOf('The model server at [::1]:1234 on this computer sent no response headers for 5 min') === 0
      && /if it needs longer\.$/.test(ipv6.userMessage), tag + ': IPv6 address brackets survive removal of the trailing transport detail: ' + ipv6.userMessage);
    // the words an older adapter said ("the context length it loaded the model with") read local_timeout too, never context_overflow
    A.eq(F.friendlyError(LOCAL_SILENT_OLD, null, { engineAlive: true, code }).kind, 'local_timeout', tag + ': the older wording is no context overflow');
    // native Ollama's loaded-model silence: its placement sentence leads
    const o = F.friendlyError(OLLAMA_SILENT, null, { engineAlive: true, code: 'local_timeout' });
    A.ok(/^Ollama on this computer had qwen3:8b loaded entirely on the CPU/.test(o.userMessage) && /StarNet ended this turn without sending the prompt again\.$/.test(o.userMessage), where + ': Ollama\'s placement sentence leads: ' + o.userMessage);
  }
  // a plain timeout stays a plain timeout
  A.eq(F.friendlyError('provider stream connect timed out after 30000ms with no bytes received', null, { engineAlive: true }).kind, 'timeout', where + ': a hosted timeout is untouched');
}

// THE ONE TABLE covers every reason the provider classifier can return (a kind, or null = the words decide)
for (const reason of Object.keys(ErrorClass.REASONS)) {
  A.ok(Object.prototype.hasOwnProperty.call(NodeF.CODE_TO_KIND, reason), 'CODE_TO_KIND decides errorClass reason ' + reason);
  const k = NodeF.CODE_TO_KIND[reason];
  A.ok(k === null || !!NodeF.KINDS[k], reason + ' maps to a real kind (or to the words): ' + k);
}

A.report('friendlyerror-codes.test');
