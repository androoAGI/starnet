/* node test/harness-internal.test.js — source-lock for the internal reason-only BUS SUPPRESSION (Slice 8 MAJOR B).

   The pitch/suggest engines reason via Harness.chat({internal:true}). harness.js must NOT re-emit those calls'
   agent.run.start / agent.run.end on U.bus — otherwise the agent thinking to itself counts as a delivered task in
   XP / tasksDone / FloorStats products / the quest log, and ticks the suggestion cooldown (a truthful-telemetry /
   honest-loot violation). It MUST still re-emit agent.cost so real spend stays honest.

   harness.js is browser-flow (fetch + stream reader), not node-loadable, so — like newhero-reset.test.js and the
   beat-coordination source guard — we lock the invariant by reading the source. The two CALL sites are asserted in
   pitchstore.test.js / suggeststore.test.js (call.internal === true); this locks the harness half. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const sidecar = readSidecarSource();

// chat() accepts the `internal` flag the callers pass.
A.ok(/function chat\(\{[^}]*\binternal\b[^}]*\}\)/.test(src), 'Harness.chat accepts an `internal` flag');

// the suppression guard is keyed on `internal` and covers BOTH run-lifecycle events — but NOT agent.cost.
const m = /const\s+suppressBus\s*=\s*internal\s*&&\s*\(([^)]*)\)/.exec(src);
A.ok(m, 'a suppressBus guard is keyed on `internal`');
A.ok(/agent\.run\.start/.test(m[1]) && /agent\.run\.end/.test(m[1]), 'suppressBus covers BOTH agent.run.start and agent.run.end');
A.ok(!/agent\.cost/.test(m[1]), 'suppressBus does NOT cover agent.cost — real spend stays honest for internal calls');

// the U.bus re-emit is actually gated on the guard.
A.ok(/if\s*\(\s*!suppressBus\b[\s\S]{0,80}U\.bus\.emit\(/.test(src), 'the U.bus re-emit is gated on !suppressBus');

// Harness self-knowledge: the backend prompt note must be driven by the actual wire tool list, not by
// blanket claims such as "you can always use web/files". The authoritative capability block appears later,
// but the two should not fight each other.
A.ok(/const\s+hasWebTools\s*=/.test(sidecar), 'sidecar derives hasWebTools from the wire tool list');
A.ok(/const\s+hasWriteTools\s*=/.test(sidecar), 'sidecar derives hasWriteTools from the wire tool list');
A.ok(/hasWebTools\s*\?\s*'Ground every current factual claim/.test(sidecar), 'web/source guidance is conditional on web tools');
A.ok(/hasWriteTools\s*\?\s*'Save substantive deliverables/.test(sidecar), 'file-saving guidance is conditional on write tools');
A.ok(!/never say you cannot reach the web or files/.test(sidecar), 'old blanket web/files claim is gone');

// The browser must prefer the same-origin sidecar catalog so local/dev runs get the exact context_length
// the backend already warmed, with direct OpenRouter only as a fallback.
A.ok(src.includes("fetchModelCatalog('/api/models/' + encodeURIComponent(p) + q, 'models')"), 'Harness.listModels prefers the sidecar provider catalog');
A.ok(src.includes("fetchModelCatalog(OR + '/models', 'data')"), 'Harness.listModels keeps the direct OpenRouter catalog as fallback');
A.ok(src.includes("params.indexOf('tools') >= 0"), 'Harness.listModels derives tool support from supported_parameters when needed');
A.ok(src.includes("providerSlot(base, provider)"), 'Harness stores key/base-url settings in provider-scoped localStorage slots');
A.ok(src.includes("invoke('harness_store_provider_key'"), 'desktop Harness pushes provider-scoped key updates to Tauri');
A.ok(src.includes('getKey(provider)') || /const\s+getKey\s*=\s*provider\s*=>/.test(src), 'Harness.getKey accepts a provider argument');
/* ---------- BOOTFIX regression guard: the seeded DEV / resume floor must NEVER wait on the model catalog ----------
   listModels() proxies a LIVE external OpenRouter /models fetch; awaiting it inline on the auto-resume path
   strands boot on #screen-connect forever when that upstream is slow/blocked (the seeded SKYNET_DEV shoot
   regression). The catalog is cosmetic for resume, so the auto-resume branch must fire it in the BACKGROUND
   (fire-and-forget) and enter the station immediately — and every catalog fetch must be timeout-bounded so
   listModels() always settles. If a future refactor re-introduces an inline `await Harness.listModels()` on
   the enter-the-game path, these assertions fail. */

// (a) the auto-resume branch decides eligibility, then enters WITHOUT awaiting the catalog — listModels() is
//     kicked in the background (not `await`ed) right before resumeInto(). This is the exact shape of the fix.
A.ok(/const\s+canResume\s*=[\s\S]{0,400}if\s*\(\s*canResume\s*\)\s*\{[\s\S]{0,260}Harness\.listModels\(\)[\s\S]{0,200}resumeInto\(saved\)/.test(app),
  'auto-resume enters the station and warms the catalog in the background (no inline await before the floor)');
// the background warm must NOT be awaited (that would re-introduce the hang). Assert the resume branch has no
// `await Harness.listModels()` — the awaited call only survives on the RESUME-connect recovery path below it.
{
  const mBranch = /if\s*\(\s*canResume\s*\)\s*\{([\s\S]*?)resumeInto\(saved\);\s*return;\s*\}/.exec(app);
  A.ok(mBranch, 'the canResume branch is present and returns via resumeInto(saved)');
  A.ok(mBranch && !/await\s+Harness\.listModels\(\)/.test(mBranch[1]), 'the auto-resume branch does NOT await Harness.listModels() (the floor never waits on the catalog)');
}
// (b) every catalog fetch is bounded by an AbortController timeout so listModels() always settles even against a
//     hung upstream — a timeout reads as an empty catalog, exactly like an offline sidecar.
A.ok(/AbortController\(\)[\s\S]{0,160}setTimeout\([\s\S]{0,80}\.abort\(\)/.test(src), 'fetchModelCatalog arms an AbortController timeout');
A.ok(/fetch\(url,\s*\{\s*cache:\s*'no-store',\s*signal:/.test(src), 'the catalog fetch passes the abort signal');

// Work discipline: task runs should push the model into a stable build loop instead of repeated
// failed path guesses, shell-quoted source rewrites, or syntax-only verification.
A.ok(/const\s+workDisciplineNote\s*=/.test(sidecar), 'sidecar builds a dedicated work-discipline prompt block');
A.ok(/anchor shell_exec\.cwd to that exact folder/.test(sidecar), 'work discipline anchors shell cwd before project commands');
A.ok(/change strategy instead of retrying the same bad path/.test(sidecar), 'work discipline discourages repeated bad path attempts');
A.ok(/Inspect before editing with fs_search\/fs_list\/fs_read/.test(sidecar), 'work discipline requires inspection before editing');
// FILES BEFORE THE SHELL (2026-10-25, gpt-5.6-luna on v0.14.0 read a named project with dir / Select-String / type): reading
// is routed to the file tools, and that rule comes BEFORE the shell cwd rule (it used to open the block)
A.ok(/Read, list and search files with fs_read \/ fs_list \/ fs_search, full paths the Commander names included/.test(sidecar), 'work discipline routes file reads to the file tools, full paths included');
A.ok(/not shell_exec \(dir, type, cat, Get-Content, Select-String\): the shell is for running tests, builds, git and scripts/.test(sidecar), 'work discipline keeps the shell for running things');
A.ok(sidecar.indexOf('Read, list and search files with fs_read') >= 0 && sidecar.indexOf('Read, list and search files with fs_read') < sidecar.indexOf('anchor shell_exec.cwd to that exact folder'), 'the file-tools rule comes before the shell cwd rule');
A.ok(/anchor shell_exec\.cwd to that exact folder as given \(never a guessed Bash-style \/c path\)/.test(sidecar), 'the cwd rule still forbids guessed Bash-style /c paths');
A.ok(/c\.name === 'shell\.exec' && fromWire\.has\('fs_read'\)\) dctx = Object\.assign\(\{\}, dctx, \{ fileToolsOnWire: true \}\)/.test(sidecar), 'the host tells shell.exec when this run carries the file tools');
A.ok(/prefer fs_patch for multi-line edits/.test(sidecar), 'work discipline prefers structured patch edits for source changes');
A.ok(/Avoid temporary patch scripts/.test(sidecar), 'work discipline steers away from throwaway patch scripts');
A.ok(/run the narrowest real verification/.test(sidecar), 'work discipline requires targeted verification');
A.ok(/shell_exec background:true/.test(sidecar) && /shell_bg_status/.test(sidecar), 'work discipline checks background dev servers');
A.ok(/browser_navigate plus browser_console\/browser_snapshot\/browser_vision[\s\S]*browser_test_navigate\(serverId\)[\s\S]*browser_test_snapshot\/browser_test_state\/browser_test_input/.test(sidecar), 'work discipline separates public browsing from owned local synthetic UI verification');
A.ok(/Final reports must name changed files, verification commands\/results/.test(sidecar), 'work discipline requires concrete final evidence');

// Task doctrine (2026-07-08 ref-parity): the general operating loop — proven outcomes, the quietest-path
// tool ladder (dedicated tool > headless shell/browser > visible screen), read-back verification, honest
// escalation. This is the block that stops "open the app on the user's screen and type into it".
A.ok(/const\s+taskDoctrineNote\s*=/.test(sidecar), 'sidecar builds a dedicated task-doctrine prompt block');
A.ok(/QUIETEST path that achieves the goal/.test(sidecar), 'task doctrine ranks tools quietest-first');
A.ok(/ONLY when the Commander explicitly asked to see it on their screen or every quieter path failed/.test(sidecar), 'task doctrine demotes the visible screen to last resort');
A.ok(/immediately continue down this ladder with the next safe, already-authorized route/.test(sidecar), 'task doctrine automatically continues after a dedicated integration is unavailable');
A.ok(/Do not ask merely because the fallback is louder/.test(sidecar), 'task doctrine does not hand safe fallback selection back to the Commander');
A.ok(/Ask only when that next route itself needs Commander authentication, exact consent, or a genuinely material choice/.test(sidecar), 'task doctrine preserves only irreducible human boundaries');
A.ok(!/ask before using a louder path/.test(sidecar), 'the old cross-domain hand-back instruction is gone');
A.ok(/VERIFY it took effect with a read-back tool/.test(sidecar), 'task doctrine requires outcome verification for world-changing actions');
A.ok(/never a description, a plan, or a promise of future action/.test(sidecar), 'task doctrine defines the deliverable as a proven outcome');
A.ok(/\+ taskDoctrineNote/.test(sidecar), 'the task doctrine is actually wired into the composed [HARNESS] prompt');

/* ---------- EGRESS/TOKEN SAFETY (audit 0.6): X-StarNet-Token is SAME-ORIGIN ONLY ----------
   The fetch monkey-patch attaches the PRIVATE local X-StarNet-Token to every request isApiUrl() accepts.
   A naive substring match on '/api/' would attach it to third-party URLs that merely contain '/api/' — most
   critically the OpenRouter fallback catalog (OR + '/models' = https://openrouter.ai/api/v1/models), leaking the
   local credential cross-origin AND forcing a CORS preflight OpenRouter rejects (so the fallback fails exactly
   when it's needed). isApiUrl() must therefore gate on SAME ORIGIN, not on the substring '/api/'. harness.js is
   browser-flow (not node-loadable), so we extract the two function bodies from source and exercise them against a
   stubbed location — the same source-lock discipline the rest of this file uses. */
{
  const mApiPath = /function apiPath\(s\) \{[\s\S]*?\n  \}/.exec(src);
  const mIsApi = /function isApiUrl\(u\) \{[\s\S]*?\n  \}/.exec(src);
  A.ok(mApiPath, 'harness.js defines a same-origin apiPath() helper');
  A.ok(mIsApi, 'harness.js defines isApiUrl()');
  // isApiUrl must NOT be the old blanket-substring form (that was the leak).
  A.ok(!/return\s+u\.indexOf\('\/api\/'\)\s*===\s*0\s*\|\|\s*\/\\\/api\\\//.test(src), 'isApiUrl no longer substring-matches /api/ anywhere (the token-leak form is gone)');
  const factory = new Function('location', 'URL', 'window', mApiPath[0] + '\n' + mIsApi[0] + '\nreturn isApiUrl;');
  const isApiUrl = factory({ origin: 'http://localhost:8787', href: 'http://localhost:8787/' }, URL, {});
  // same-origin /api/ (relative + absolute) => token attaches
  A.ok(isApiUrl('/api/models/openrouter') === true, 'same-origin relative /api/ is an API URL (token attaches)');
  A.ok(isApiUrl('http://localhost:8787/api/version') === true, 'same-origin absolute /api/ is an API URL (token attaches)');
  A.ok(isApiUrl({ url: '/api/stt' }) === true, 'Request-like same-origin object is an API URL');
  // THE LEAK: third-party URL containing /api/ => token must NOT attach
  A.ok(isApiUrl('https://openrouter.ai/api/v1/models') === false, 'the OpenRouter fallback catalog is NOT an API URL (token must NOT leak cross-origin)');
  A.ok(isApiUrl('https://openrouter.ai/api/v1/chat/completions') === false, 'OpenRouter chat/completions is NOT an API URL');
  A.ok(isApiUrl({ url: 'https://openrouter.ai/api/v1/models' }) === false, 'Request-like cross-origin object is NOT an API URL');
  A.ok(isApiUrl('http://evil.example/api/steal') === false, 'a cross-origin host with /api/ is NOT an API URL');
  A.ok(isApiUrl('/frontend/app/harness.js') === false, 'a same-origin non-/api path is not an API URL');
  // the tauri app origin hitting its OWN sidecar /api must still count (desktop build)
  const isApiUrlTauri = factory(
    { origin: 'https://tauri.localhost', href: 'https://tauri.localhost/' }, URL,
    { __STARNET_API__: 'http://127.0.0.1:8964' }
  );
  A.ok(isApiUrlTauri('/api/run') === true, 'tauri app origin: its own /api/ is an API URL');
  A.ok(isApiUrlTauri('http://127.0.0.1:8964/api/routing') === true,
    'tauri app origin: the exact configured loopback sidecar /api URL receives the launch token');
  A.ok(isApiUrlTauri('http://127.0.0.1:8965/api/routing') === false,
    'tauri app origin: another loopback port is not the configured sidecar and receives no token');
  A.ok(isApiUrlTauri('http://localhost:8964/api/routing') === false,
    'tauri app origin: another loopback spelling is refused unless it is the exact configured origin');
  A.ok(isApiUrlTauri('https://openrouter.ai/api/v1/models') === false, 'tauri app origin: OpenRouter is still NOT an API URL');
  const hostileConfig = factory(
    { origin: 'https://tauri.localhost', href: 'https://tauri.localhost/' }, URL,
    { __STARNET_API__: 'https://evil.example' }
  );
  A.ok(hostileConfig('https://evil.example/api/steal') === false,
    'a configured non-loopback origin cannot opt itself into receiving the launch token');
}

/* ---------- EL-11 FIX 3: a pre-stream /api/run failure must CARRY ITS BODY into the thrown error ----------
   The old `throw new Error('sidecar HTTP ' + res.status)` discarded the response body, so pre-stream errors
   (e.g. runRouteFailure's {"error":"sidecar failure: Not signed in to ChatGPT …"}) never reached the
   friendly-error oauth regexes and the RECONNECT CHATGPT door was lost on this whole path. */
{
  A.ok(!/throw new Error\('sidecar HTTP ' \+ res\.status\);/.test(src), 'the body-discarding bare throw is gone');
  A.ok(/sidecarErrorDetail\(await res\.text\(\)\)/.test(src), 'chat() reads the error body (bounded) and folds it via sidecarErrorDetail');
  A.ok(/throw new Error\('sidecar HTTP ' \+ res\.status \+ \(detail \? ' — ' \+ detail : ''\)\)/.test(src), 'the thrown message carries the body detail');
  const mDet = /function sidecarErrorDetail\(text\) \{[\s\S]*?\n  \}/.exec(src);
  A.ok(mDet, 'harness.js defines the pure sidecarErrorDetail helper');
  const detail = new Function(mDet[0] + '\nreturn sidecarErrorDetail;')();
  A.eq(detail('forbidden token'), 'forbidden token', 'a plain-text body (the token gate) passes through');
  A.eq(detail(''), '', 'an empty body folds to empty (a bare "sidecar HTTP <status>")');
  A.eq(detail(null), '', 'a null body never throws');
  A.ok(detail('x'.repeat(5000)).length <= 600, 'the folded detail is bounded');
  const codex = detail(JSON.stringify({ error: 'sidecar failure: Not signed in to ChatGPT — connect a ChatGPT subscription first.' }));
  A.ok(/Not signed in to ChatGPT/.test(codex), 'a runRouteFailure JSON envelope unwraps to its message');
  const coded = detail(JSON.stringify({ error: 'connect a ChatGPT subscription first.', code: 'codex_not_connected' }));
  A.ok(/codex_not_connected/.test(coded), 'an error code rides along when the text does not already carry it');
  // END-TO-END through the ladder (the EL-10 family): the message chat() now throws must open the ChatGPT sign-in
  // door. "Not signed in" is never-signed-in, so it reads SIGN IN TO CHATGPT (org P03), not RECONNECT.
  const { friendlyError, actionButton } = require('../frontend/app/friendlyerror.js');
  const v = friendlyError(new Error('sidecar HTTP 500 — ' + codex));
  A.eq(v.kind, 'oauth', 'a pre-stream codex-not-connected failure classifies as oauth once the body survives');
  const btn = actionButton(v);
  A.ok(btn && /SIGN IN TO CHATGPT/.test(btn.label), 'the SIGN IN TO CHATGPT chip is offered on the pre-stream path');
}

/* S5 source-lock — an ERRORED skillbase read must never become a confident zero.
   agentSkills() collapses every failure to [] for its list callers, which is fine for "no skills yet" copy but
   a lie for a COUNTER: "you have none" and "I could not ask" are different claims. agentSkillsRead() keeps the
   outcome, and the PRACTICE meter reads through it. Source-locked here because harness.js is browser-flow. */
{
  const read = /async function agentSkillsRead\(agentId, opts\)\s*\{[\s\S]*?\n  \}/.exec(src);
  A.ok(read, 'harness exposes agentSkillsRead()');
  A.ok(/return \{ ok: false, skills: \[\] \}/.test(read[0]), 'a failed read reports ok:false rather than an empty list');
  A.ok(/if \(!r\.ok\) return \{ ok: false, skills: \[\] \}/.test(read[0]), 'a non-2xx response is a failed read');
  A.ok(/catch \(e\) \{ return \{ ok: false, skills: \[\] \}; \}/.test(read[0]), 'a thrown fetch is a failed read');
  A.ok(/Array\.isArray\(j\.skills\)/.test(read[0]), 'a malformed body is a failed read, not an empty skillbase');
  A.ok(/\n\s*agentSkills, agentSkillsRead, agentSkillManage/.test(src), 'agentSkillsRead sits on the public Harness surface');
  // the legacy wrapper still returns a plain array, so every existing caller is untouched.
  A.ok(/async function agentSkills\(agentId, opts\) \{\s*return \(await agentSkillsRead\(agentId, opts\)\)\.skills;/.test(src), 'agentSkills() still returns a bare array, delegating to the read');
  // and the counter surface reads through the outcome-preserving one.
  const ui = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
  A.ok(/Harness\.agentSkillsRead\(agentId/.test(ui), 'the PRACTICE meter reads through agentSkillsRead');
  A.ok(/if \(!r \|\| !r\.ok\) return fail\('could not read the skillbase'\)/.test(ui), 'a failed read renders UNREAD, never a 0');
  A.ok(/if \(!now \|\| now\.id !== agentId\) return;/.test(ui), 'a late read never paints a different agent’s dossier');
}

A.report('harness-internal.test');
