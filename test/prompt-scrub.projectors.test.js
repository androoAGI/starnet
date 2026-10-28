/* node test/prompt-scrub.projectors.test.js — every station projector of stored text scrubs it BEFORE it clips
   (context-key-redact, 2026-10-28).

   The reported leak: <commander_evidence> RECENT ACTIVITY lines quoted earlier directives with their raw vendor keys and
   with a value the station holds in its key vault, into every later run's prompt. The family is every projector that
   turns stored text into prompt text; each now calls prompt-scrub's scrubStored on the raw field first.
     P1 commander-context compose(): a key in EVERY field it reads (whole, cut by its own clip, or held) never reaches
        the output. A FIELD-COVERAGE GUARD reads compose's source and fails when it reads a field this fixture does not
        seed — so a new field cannot ship unscrubbed and untested.
     P2 compose() on clean input is byte-identical to the composer before this change (sha256 pinned from 41c298d9a),
        and a dossier already in the caller's system prompt (raw) is still not repeated.
     P3 contextpack.assemble with NO injected redact scrubs run titles (whole and cut at 120), goal text/next, landed
        titles, beliefs and the track record; station self-talk holding a key still matches its redacted transcript row;
        an injected redact still applies on top.
     P4 Interests.summary / topicsBlock scrub a stored evidence quote (a legacy raw q, a value held after the fold).
     P5 threads-store openThreads scrubs title + spec; list() stays raw (the store is not rewritten).
     P6 source locks on the host wiring (read through test/helpers/source.js).
     P7 Outcomes.fold scrubs a recipe run's title BEFORE its 80-char label clip (a legacy title cut mid-key rides
        TRACK RECORD as '"<label>" (recipe) — …', where no later rule could see the fragment).
     P8 session.peek scrubs another session's turns field by field (the page cuts each at 600 chars, mid-key).
     P9 the night focus and the quest-refresh directive (the review's blockers): the pure resolvers fed the way the
        host now feeds them (scrubbed fields, before any slice / suffix) quote no key, and a focus persisted raw is
        scrubbed at use; the goal note scrubs each field before its suffix.
     P10 the persona system prompt is scrubbed at runOnceCore's intake: compose() sees the scrubbed dossier copy in it
        and still does not repeat the dossier. */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const path = require('node:path');
const PS = require('../sidecar/prompt-scrub.js');
const CommanderContext = require('../sidecar/commander-context.js');
const contextpack = require('../sidecar/contextpack.js');
const Interests = require('../sidecar/interests.js');
const Outcomes = require('../sidecar/outcomes.js');
const nightfocus = require('../sidecar/nightfocus.js');
const QuestRefresh = require('../sidecar/questrefresh.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
const { makeThreadsStore } = require('../sidecar/threads-store.js');
const threadmine = require('../sidecar/threadmine.js');
const S = require('./helpers/source.js');
const FK = require('./helpers/fake-keys.js');
const { list, by } = FK.make('prompt-scrub-projectors');

const leaks = s => list.map(k => FK.leak(s, k) && (k.id + ':' + FK.leak(s, k))).filter(Boolean).join(', ');
// the station HOLDS the vault value (saved through KEYS after it was typed) — the host's credential source
PS.setHeldSource(() => [by.VAULT.value]);
// a key cut by a clip: `n` chars of padding put the clip boundary 20 chars into the key's secret part
const cutAt = (n, k) => 'x'.repeat(Math.max(0, n - k.prefix.length - 21)) + ' ' + k.value;
const K = by;

// ---- P1: a key in every field compose() reads ----
const SEED = {
  brief: {
    id: 'tb_' + K.SLACK.value, status: 'active ' + K.GITHUB.value,
    originalDirective: 'Wire the outreach push. OpenRouter: ' + K.OPENROUTER.value + '\nInstantly: ' + K.VAULT.value,
    questions: [
      { id: 'q-' + K.GOOGLE.value, text: cutAt(240, K.ANTHROPIC), answer: 'use ' + K.GITHUB.value, mode: 'conversation' },
      { id: 'q2', text: 'which key? ' + K.OPENAI.value, answer: cutAt(500, K.GOOGLE), mode: 'task' }
    ],
    context: { audience: 'founders', quotes: ['my key is ' + K.ANTHROPIC.value, 'vault ' + K.VAULT.value] },
    assumptions: [cutAt(300, K.OPENROUTER)]
  },
  recipeIntake: [{ dimension: K.VAULT.value, question: cutAt(160, K.OPENAI), options: ['use ' + K.SLACK.value, cutAt(72, K.ANTHROPIC)], recommended: cutAt(72, K.GITHUB), reason: cutAt(160, K.GOOGLE) }],
  dossier: 'Runs an agency. Stack key ' + K.OPENAI.value + ' and ' + K.VAULT.value,
  existingSystem: 'SYSTEM PROMPT',
  goal: { title: 'Ship it with ' + K.ANTHROPIC.value },
  topics: [
    { label: 'outreach ' + K.GITHUB.value, count: 2, evidence: [cutAt(140, K.OPENROUTER)] },
    { topic: 'vault ' + K.VAULT.value, count: 1, evidence: ['RIG-P8 instantly ' + K.VAULT.value + ' pull my campaigns'] }
  ],
  threads: [{ title: cutAt(160, K.SLACK), spec: cutAt(180, K.OPENAI) }],
  worksignal: cutAt(400, K.ANTHROPIC),
  verdicts: { kinds: { recipe: { weight: 0.5, positive: 3, negative: 1 } } },
  activity: [
    'RIG-P1 openrouter ' + K.OPENROUTER.value + ' check my credits please (today)',
    ('RIG-RUN1 wire up all my accounts.\nOpenRouter: ' + K.OPENROUTER.value).slice(0, 60),
    'RIG-P8 instantly ' + K.VAULT.value + ' pull my campaigns (today)',
    cutAt(180, K.GOOGLE)
  ],
  trackRecord: [cutAt(200, K.SLACK)],
  deferredDimensions: [K.VAULT.value],
  automationAsk: true,
  standingWork: { count: 3, dates: [1760000000000, 1760600000000, 1761200000000], quotes: [cutAt(160, K.GITHUB)], suggest: { display: cutAt(60, K.OPENAI), why: cutAt(80, K.ANTHROPIC) } },
  patterns: [{ question: cutAt(180, K.GOOGLE), answer: 'which key? => ' + K.OPENROUTER.value, count: 2 }]
};
{
  const out = CommanderContext.compose(SEED);
  A.eq(leaks(out), '', 'P1: compose() output holds no key and no 12-char window of one, in any field');
  A.ok((out.match(/\[redacted-(?:key|secret)\]/g) || []).length >= 20, 'P1: placeholders stand where the keys were');
  A.ok(/- RECENT ACTIVITY: RIG-P1 openrouter \[redacted-key\] check my credits please \(today\)/.test(out), 'P1: RECENT ACTIVITY still carries the evidence line, key replaced');
  A.ok(/- RECENT ACTIVITY: RIG-P8 instantly \[redacted-secret\] pull my campaigns/.test(out), 'P1: a HELD vault value in a RECENT ACTIVITY line becomes [redacted-secret]');
  A.ok(/ORIGINAL REQUEST: Wire the outreach push\. OpenRouter: \[redacted-key\]/.test(out), 'P1: ORIGINAL REQUEST keeps its words');
  A.ok(/- TOPIC: /.test(out) && /OPEN THREAD: /.test(out) && /observed_task_patterns/.test(out), 'P1: topic, thread and pattern evidence still flow');
  const wu = /WORKING UNDERSTANDING[^:]*: (\{.*\})/.exec(out);
  let parsed = null; try { parsed = JSON.parse(wu && wu[1]); } catch (_) {}
  A.ok(parsed && parsed.audience === 'founders', 'P1: WORKING UNDERSTANDING is still valid JSON after the scrub');

  // FIELD-COVERAGE GUARD: every <obj>.<field> compose() reads must be seeded above (with a key, where it is text)
  const ccFile = S.sidecarSourceFiles().find(f => f.rel === 'sidecar/commander-context.js');
  const src = S.functionSourceIn(ccFile ? ccFile.text : '', 'composeOnce');   // compose() pins one held read around composeOnce()
  A.ok(src.length > 1000, 'P1 guard: compose() source found');
  const holders = { input: [SEED], b: [SEED.brief], q: SEED.brief.questions, t: SEED.topics.concat(SEED.threads), sw: [SEED.standingWork], e: SEED.recipeIntake, p: SEED.patterns };
  const seen = new Set();
  for (const m of src.matchAll(/\b(input|b|q|t|sw|e|p)\.([A-Za-z_$][\w$]*)/g)) {
    const key = m[1] + '.' + m[2];
    if (seen.has(key) || m[2] === 'slice' || m[2] === 'map' || m[2] === 'length') continue;
    seen.add(key);
    A.ok(holders[m[1]].some(o => o && Object.prototype.hasOwnProperty.call(o, m[2])), 'P1 guard: compose() reads ' + key + ' — seed it (with a key, if it is text) in this test');
  }
  A.ok(seen.size >= 35, 'P1 guard: the field scan found compose()\'s fields (' + seen.size + ')');
}

// ---- P2: clean input is byte-identical to the composer before this change; the dossier dedupe still works ----
{
  const CLEAN = {
    brief: { id: 'tb_run-1', status: 'active', originalDirective: 'Draft the launch email for the outreach push', questions: [{ id: 'q1', text: 'Which tone?', answer: 'warm', mode: 'conversation' }, { id: 'q2', text: 'Length?', answer: '', mode: 'task' }], context: { audience: 'founders', quotes: ['keep it short'] }, assumptions: ['English only'] },
    recipeIntake: [{ dimension: 'tone', question: 'Which tone?', options: ['warm', 'formal'], recommended: 'warm', reason: 'past drafts' }],
    dossier: 'Runs a small outreach agency.', existingSystem: 'SYSTEM', goal: { title: 'Land 10 new clients' },
    topics: [{ label: 'outreach api setup', count: 3, evidence: ['RIG-P8 instantly pull my campaigns'] }, { topic: 'campaign-data', count: 1, evidence: [] }],
    threads: [{ title: 'Automate the follow-ups', spec: 'mentioned twice' }], worksignal: 'drafts emails mornings',
    verdicts: { kinds: { recipe: { weight: 0.5, positive: 3, negative: 1 } } },
    activity: ['Build the task-management-dashboard (today)', '"check my credits please" (yesterday)'], trackRecord: ['research: 4 of 5 finished'],
    deferredDimensions: ['format'], automationAsk: true,
    standingWork: { count: 3, dates: [1760000000000, 1760600000000, 1761200000000], quotes: ['pull my campaigns'], suggest: { display: 'weekdays 9am', why: 'you ask mornings' } },
    patterns: [{ question: 'Which list?', answer: 'the main list', count: 2 }]
  };
  const out = CommanderContext.compose(CLEAN);
  A.eq(crypto.createHash('sha256').update(out).digest('hex'), '620ff6a2931f6904855d1c596b2d2ad7aae533e49bbe2d087ce201692d30e557',
    'P2: clean input composes byte-identically to 41c298d9a (no prompt-cache change on a clean station)');
  const raw = 'Runs an agency. Stack key ' + K.OPENAI.value;
  A.ok(CommanderContext.compose({ dossier: raw, existingSystem: 'SYS\n' + raw + '\n' }).indexOf('<commander_context') < 0, 'P2: a raw dossier already in the system prompt is not repeated');
  const own = CommanderContext.compose({ dossier: raw, existingSystem: '' });
  A.ok(own.indexOf('<commander_context') >= 0 && leaks(own) === '', 'P2: otherwise the dossier block is added, scrubbed');
}

// ---- P3: contextpack.assemble with NO injected redact ----
{
  const now = 1761600000000, ts = now - 3600000;
  const runs = [
    { title: 'RIG-P1 openrouter ' + K.OPENROUTER.value + ' check my credits please', ts, streamId: 'a' },
    { title: ('RIG-P4 google maps ' + K.GOOGLE.value + ' geocode our office').slice(0, 30), ts: ts - 1, streamId: 'b' },
    { title: 'RIG-P8 instantly ' + K.VAULT.value + ' pull my campaigns', ts: ts - 2, streamId: 'c' },
    { title: ('RIG-RUN1 wire up all my accounts for the outreach push.\nOpenRouter: ' + K.OPENROUTER.value).slice(0, 120), ts: ts - 3, streamId: 'd' },
    { title: ('RIG-P9 instantly ' + K.VAULT.value).slice(0, 34), ts: ts - 4, streamId: 'e' },
    { title: 'Plan the week, the bot key is ' + K.OPENAI.value + ' ok', ts: ts - 5, streamId: 'f', internal: true }
  ];
  const chats = [
    { role: 'user', content: 'Plan the week, the bot key is [redacted-key] ok', ts: ts - 5, streamId: 'f' },   // the redacted-on-write row of that self-talk
    { role: 'user', content: 'what is on my plate today?', ts: ts - 6, streamId: 'g' }
  ];
  const pack = contextpack.assemble({
    runs, chats,
    goal: { text: 'Ship with ' + K.ANTHROPIC.value, next: 'rotate ' + K.GITHUB.value, done: 1, total: 3 },
    landed: [{ title: 'Report on ' + K.SLACK.value, verdict: 'kept', ts }],
    beliefs: { stack: ['uses ' + K.OPENAI.value], goals: ['grow'] },
    trackRecord: ['recipe ' + K.GOOGLE.value + ': 3 of 4 finished']
  }, { now });
  const all = pack.text + '\n' + pack.activityLines.join('\n');
  A.eq(leaks(all), '', 'P3: pack text + activity pool hold no key or window (titles whole and cut, goal, landed, beliefs, track)');
  A.ok(pack.activityLines.some(l => /^RIG-P1 openrouter \[redacted-key\] check my credits please/.test(l)), 'P3: the run-title evidence line survives with a placeholder');
  A.ok(pack.activityLines.some(l => /^RIG-P8 instantly \[redacted-secret\] pull my campaigns/.test(l)), 'P3: a held value in a run title becomes [redacted-secret]');
  A.ok(!pack.activityLines.some(l => /Plan the week/.test(l)), 'P3: station self-talk holding a key still matches its redacted transcript row (excluded)');
  A.ok(pack.activityLines.some(l => /what is on my plate/.test(l)), 'P3: the Commander\'s own chat still flows');
  const extra = contextpack.assemble({ runs: [{ title: 'deploy the PINEAPPLE build ' + K.OPENAI.value, ts, streamId: 'a' }], redact: s => String(s).replace(/PINEAPPLE/g, '[x]') }, { now });
  A.ok(extra.activityLines[0] === 'deploy the [x] build [redacted-key] (today)', 'P3: an injected redact applies on top of the default (never instead): ' + JSON.stringify(extra.activityLines[0]));
  const clean = contextpack.assemble({ runs: [{ title: 'Build the task-management-dashboard', ts, streamId: 'a' }] }, { now });
  A.eq(clean.activityLines, ['Build the task-management-dashboard (today)'], 'P3: a clean title is unchanged (the hyphenated slug survives)');
  // the transcript redacts MORE than the prompt resolver (every connector header/env string, e.g. 'production'): the
  // self-talk join compares through matchRedact, so station self-talk never resurfaces as the Commander's activity
  const fullRedact = s => String(s).split('production').join('[redacted-secret]');
  const selfTalk = { runs: [{ title: 'Plan the production rollout for the outreach push', ts, streamId: 'f', internal: true }],
    chats: [{ role: 'user', content: 'Plan the [redacted-secret] rollout for the outreach push', ts, streamId: 'f' }] };
  A.ok(!contextpack.assemble(Object.assign({ matchRedact: fullRedact }, selfTalk), { now }).activityLines.some(l => /rollout/.test(l)), 'P3: matchRedact joins a self-talk title to its (more) redacted transcript row');
  A.ok(contextpack.assemble(selfTalk, { now }).activityLines.some(l => /rollout/.test(l)), 'P3: (without it the row would read as the Commander\'s own activity)');
  // BASE PARITY (review r2): the transcript's redaction holds EVERY connector header/env value; the prompt list only
  // the credentials. A password under an innocuous header, typed before the connector existed, sits raw in a chat row
  // and a brief: the pack applies matchRedact to those two sections exactly as it applied the host redact at 41c298d9a.
  const PW = 'Tr0ub4dor&3!xq#Z';
  const transcriptRedact = s => String(s).split(PW).join('[redacted-secret]');   // the host's context.redact holds it
  const legacy = { runs: [], briefs: [{ originalDirective: 'Sync the CRM contacts, the relay value is ' + PW + ' every morning', ts }],
    chats: [{ role: 'user', content: 'dump the orders table, the relay value is ' + PW, ts, streamId: 'g' }], matchRedact: transcriptRedact };
  const lp = contextpack.assemble(legacy, { now });
  A.ok((lp.text + '\n' + lp.activityLines.join('\n')).indexOf(PW) < 0, 'P3: a value only the transcript redaction holds stays out of brief and chat lines (base parity)');
  A.ok(lp.activityLines.some(l => /^Sync the CRM contacts, the relay value is \[redacted-secret\] every morning/.test(l)) && lp.activityLines.some(l => /relay value is \[redacted-secret\]"/.test(l)), 'P3: both lines keep their words');
  const titled = contextpack.assemble({ runs: [{ title: 'Deploy production now', ts, streamId: 'h' }], goal: { text: 'Ship production' }, matchRedact: s => String(s).split('production').join('[redacted-secret]') }, { now });
  A.ok(titled.activityLines.indexOf('Deploy production now (today)') >= 0 && titled.activityLines.some(l => /^Ship production/.test(l)), 'P3: run titles and the goal never take the transcript redaction (\'production\' stays)');
}

// ---- P4: Interests.summary / topicsBlock ----
{
  const now = 1761600000000;
  const state = { v: 1, lastPassAt: 0, runsSincePass: 0, topics: {}, trustedTopics: {
    'outreach-api-setup': { label: 'outreach api setup', w: 2, n: 2, lastAt: now, ev: [{ q: 'RIG-P8 instantly ' + K.VAULT.value + ' pull my campaigns (today)', at: now }] },
    'maps': { label: 'maps', w: 1.5, n: 1, lastAt: now, ev: [{ q: ('geocode with ' + K.GOOGLE.value).slice(0, 25), at: now }] }
  } };
  const rows = Interests.summary(state, { trustedOnly: true, now, limit: 8 });
  A.eq(rows.length, 2, 'P4: both topics are read');
  A.eq(leaks(JSON.stringify(rows)), '', 'P4: summary evidence holds no held value and no cut vendor key');
  A.ok(rows.some(r => r.evidence[0] === 'RIG-P8 instantly [redacted-secret] pull my campaigns (today)'), 'P4: the quote keeps its words');
  A.eq(leaks(Interests.topicsBlock(state, { trustedOnly: true, now, limit: 8 })), '', 'P4: topicsBlock (scout/prospect/quest refresh) is clean too');
  A.ok(state.trustedTopics['outreach-api-setup'].ev[0].q.indexOf(K.VAULT.value) >= 0, 'P4: the stored quote itself is unchanged (read-side projection only)');
}

// ---- P5: threads-store openThreads ----
(async () => {
  const files = new Map();
  const memFs = {
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, d) { files.set(String(f), String(d)); }, renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); }, openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
  const store = makeThreadsStore({ fs: memFs, path, workspaces: '/ws', writeDurable: ({ fs }, file, data) => { fs.writeFileSync(file, data); } });
  await store.add({ id: 't1', title: 'rotate the key ' + K.OPENAI.value, spec: 'he said ' + K.VAULT.value.slice(0, 16) }, 1000);
  const open = store.openThreads(6);
  A.eq(leaks(JSON.stringify(open)), '', 'P5: openThreads title + spec are scrubbed');
  A.ok(open[0] && open[0].title === 'rotate the key [redacted-key]', 'P5: the thread title keeps its words');
  A.ok(store.list()[0].title.indexOf(K.OPENAI.value) >= 0, 'P5: list() (the store) stays raw');
  // the thread-mining pass's ALREADY ON THE BOARD list (review r2): threadmine.knownBlock clips each title at 120 + '…',
  // so a key straddling char 120 left a cut head no later rule could see. promptTitles() scrubs before that clip.
  const longTitle = ('Wire the maps geocoder into the outreach dashboard so every lead gets coordinates, key detail detail detail ').slice(0, 99) + ' ' + K.GOOGLE.value + ' and ship';   // the key straddles char 120
  await store.add({ id: 't2', title: longTitle, spec: 'x' }, 2000);
  await store.add({ id: 't3', title: 'Pull Instantly campaigns with ' + K.VAULT.value, spec: 'nightly' }, 3000);
  const titles = store.promptTitles();
  const board = threadmine.buildPrompt([{ role: 'user', content: 'u'.repeat(220) }, { role: 'assistant', content: 'a'.repeat(220) }], 0, titles).prompt;
  A.eq(leaks(JSON.stringify(titles) + '\n' + board), '', 'P5: promptTitles() + the mining prompt\'s ALREADY ON THE BOARD block hold no key or window (whole, cut at 120, held)');
  A.ok(titles.indexOf('rotate the key [redacted-key]') >= 0, 'P5: a mined-board title keeps its words');
  const knownRaw = store.knownFingerprints();
  A.ok(Object.keys(knownRaw).length >= 3, 'P5: dedupe still reads the raw store (fingerprints), unaffected by the prompt scrub');
  A.ok(/knownTitles = threadsStore\.promptTitles\(\)/.test(S.sidecarFunctionSource('runThreadMine')) && !/threadsStore\.read\(\)/.test(S.sidecarFunctionSource('runThreadMine')), 'P5: runThreadMine lists the board only through promptTitles()');

  // ---- P6: source locks on the host wiring ----
  const all = S.readSidecarSource();
  A.ok(all.indexOf('attachRequestScrub(PromptScrub.guardRequest)') >= 0, 'P6: boot attaches the provider-boundary scrub to the factory');
  const nsp = S.sidecarFunctionSource('nightshiftContextPack');
  A.ok(nsp.indexOf('contextpack.assemble(') >= 0 && !/contextpack\.assemble\(\{[^}]*[{,]\s*redact\s*[,}]/.test(nsp), 'P6: nightshiftContextPack relies on the pack\'s default resolver (no bare context redact as the scrubber)');
  A.eq((nsp.match(/matchRedact: redact/g) || []).length, 2, 'P6: both packs join self-talk through the transcript\'s own redaction');
  const core = S.sidecarTopLevelFunction('runOnceCore');
  A.ok(core.indexOf('runContextNote(PromptScrub.scrubStored(withQuests(perRunBlocks, questsBlock)))') >= 0, 'P6: the whole <run_context> body goes through scrubStored');
  A.ok(core.indexOf('PromptScrub.scrubStored(KeyTools.nameSavedKeys(') >= 0, 'P6: the run title is scrubbed AFTER nameSavedKeys names a saved key');
  for (const fn of ['runScoutCycle', 'runQuestRefreshCycle', 'runStudy']) {
    const body = S.sidecarFunctionSource(fn);
    A.ok(body.length > 0 && body.indexOf('commanderDossier.get()') < 0 && body.indexOf('promptDossier()') >= 0, 'P6: ' + fn + ' reads the dossier only through promptDossier()');
  }
  const scout = S.sidecarFunctionSource('runScoutCycle');
  A.ok(/grounding: \[interestsBlock, activityBlock, directionBlock, dossierBlock\]/.test(scout), 'P6: the scout recipe veto grounds in the SAME scrubbed dossier its directive showed');
  const qref = S.sidecarFunctionSource('runQuestRefreshCycle');
  A.ok(/const evidenceCtx = PromptScrub\.scrubDeep\(\{/.test(qref), 'P6: the quest-refresh evidence (progress JSON, quest titles, north star, step) is scrubbed field by field');
  A.ok(/const grounding = \[evidenceCtx\.goalNote, dossierBlock,/.test(qref) && qref.indexOf('JSON.stringify(evidenceCtx.progress)') >= 0, 'P6: the quest-refresh veto reads the SAME scrubbed evidence object');
  A.ok(/PromptScrub\.setHeldSource\(/.test(all) && /stationSecretValues\(\{ credentialUnder: \['headers', 'env'\] \}\)/.test(all), 'P6: the prompt held list is the CREDENTIAL list (connector header/env values only when they are credentials)');
  A.ok(/let system = PromptScrub\.scrubStored\(rawSystem\);/.test(core), 'P6: the persona system prompt is scrubbed at runOnceCore\'s intake (the page bakes the raw dossier into it)');
  A.ok(/cacheSystemPrefix \+ PromptScrub\.scrubStored\(stationEvidenceBlock \+/.test(core) && /withQuests\(taskSystem, PromptScrub\.scrubStored\(questsBlock\)\)/.test(core), 'P6: STABLE_PREFIX=0 gets the same belt over its per-run blocks');
  A.ok(core.indexOf("liveServiceKeys()), { whole: true })") >= 0, 'P6: the run title (uncut there) skips the cut-key pass');
  A.ok(/const auxProvider = PromptScrub\.guardRequest\(provider\);/.test(core) && !/runReflection\(\{[^}]*\bprovider,/.test(core) && (core.match(/provider: auxProvider/g) || []).length >= 7, 'P6: post-run aux passes resend the run\'s messages through a FRESH held snapshot');
  A.ok(/PromptScrub\.scrubStored\(m\.content\)/.test(S.sidecarFunctionSource('nightshiftChat')), 'P6: every night directive is scrubbed whole as a belt');
  A.ok(/PromptScrub\.scrubStored\(String\(src\.lastOutput\)\)\.slice\(0,/.test(S.sidecarFunctionSource('cronContextFor')), 'P6: an upstream routine\'s stored output is scrubbed before its cut');
  for (const fn of ['runNightshiftBeatV2', 'runNightshiftBeat']) {
    const body = S.sidecarFunctionSource(fn);
    if (body) A.ok(body.indexOf('nightfocus.focusLine(') < 0, 'P6: ' + fn + ' builds TONIGHT\'S FOCUS through nightFocusLine (never the raw persisted focus)');
  }
  A.ok((all.match(/const focusHeader = foc\.focus \? nightFocusLine\(foc\.focus\) : '';/g) || []).length === 2, 'P6: both night directives lead with the scrubbed focus line');

  // ---- P7: Outcomes.fold scrubs a recipe title before the 80-char label clip ----
  {
    const now = 1761600000000;
    const rows = [];
    for (const k of [K.GOOGLE, K.VAULT, K.GITHUB]) {
      const title = ('Daily lead pull for the outreach campaign, run with our vendor key ' + k.value + ' every morning').slice(0, 120);
      const legacyCut = ('Pull the leads via ' + k.value).slice(0, 19 + k.prefix.length + 30);   // a title stored cut mid-key
      for (let i = 0; i < 4; i++) rows.push({ runId: k.id + i, recipeId: 'r-' + k.id, title: i % 2 ? title : legacyCut, reason: 'done', ts: now - 3600000 * (i + 1), streamId: 'a', model: 'm' });
    }
    const rec = Outcomes.fold(rows, { now });
    const lines = Outcomes.lines(rec).join('\n');
    A.ok(/\(recipe\)/.test(lines), 'P7: the recipe track-record lines exist');
    A.eq(leaks(lines + JSON.stringify(rec)), '', 'P7: TRACK RECORD labels hold no key or 12-char window (scrubbed before the 80-char clip)');
  }

  // ---- P8: session.peek scrubs another session's turns field by field ----
  {
    const v = K.VAULT.value, g = K.GITHUB.value;
    const turns = [
      { speaker: 'commander', sys: false, text: ('x'.repeat(580) + ' ' + v).slice(0, 600) },          // a held value cut at the page's 600
      { speaker: 'commander', sys: false, text: ('y'.repeat(585) + ' ' + g).slice(0, 600) },          // a vendor key cut at 600
      { speaker: 'agent', sys: false, text: 'saved ' + K.OPENAI.value + ' for you' },
      { speaker: 'agent', sys: false, text: 'nothing secret here' }
    ];
    const tools = makeStationTools({ station: { request: async () => ({ ok: true, result: { id: 's1', title: 'Research ' + K.SLACK.value, agentId: 'agent', busy: false, runCount: 2, turns } }) } });
    const out = await tools.peekTool.run({ session: 'Research' });
    A.eq(leaks(out.content), '', 'P8: session.peek\'s tool result holds no key or window (each turn scrubbed before it rides the JSON)');
    A.ok(JSON.parse(out.content).turns[3].text === 'nothing secret here', 'P8: a clean turn is unchanged');
    const cleanTools = makeStationTools({ station: { request: async () => ({ ok: true, result: { id: 's1', title: 'Research', turns: [{ speaker: 'agent', text: 'hi' }] } }) } });
    A.eq((await cleanTools.peekTool.run({ session: 'Research' })).content, JSON.stringify({ id: 's1', title: 'Research', turns: [{ speaker: 'agent', text: 'hi' }] }), 'P8: a clean peek is byte-identical');
  }

  // ---- P9: the night focus (the host's own nightFocusInputs / nightFocusLine / promptGoal, run in a vm sandbox) ----
  {
    const vm = require('node:vm');
    const now = Date.now();
    const goalText = ('Ship outreach v2 using openai ' + K.OPENAI.value + ' ' + 'outreach plan detail '.repeat(12)).slice(0, 255) + ' ' + K.GOOGLE.value;
    const goal = { id: 'g1', text: goalText.slice(0, 280), next: 'rotate ' + K.SLACK.value + ' tonight', done: 0, total: 2, milestoneId: 'm1' };
    const sandbox = {
      PromptScrub: PS, nightfocus, QuestRefresh, Interests, contextpack, Date, String, Array, Object, Number, Math, JSON,
      threadsStore: { list: () => [{ id: 't1', title: 'rotate the deploy key ' + K.GITHUB.value, spec: ('he said ' + 'z'.repeat(150) + ' ' + K.ANTHROPIC.value).slice(0, 180), updatedAt: now - 1000 }] },
      commanderGoals: { get: () => goal },
      questStore: { list: () => [{ id: 'q1', status: 'open', title: 'Rotate ' + K.OPENROUTER.value, contract: { type: 'run' }, createdAt: now - 2000 }] },
      questRefreshState: { northStar: { text: 'Own the outbound stack with ' + K.VAULT.value, status: 'adopted', source: 'model', groundedIn: 'you said ' + K.OPENAI.value } },
      personalizationStore: { read: () => ({ enabled: true }) }, interestsState: Interests.fresh ? Interests.fresh() : null,
      projectsStore: { snapshot: () => ({ projects: [] }) }, runStore: { list: () => [] }, sessionRunForgotten: () => false,
      blessedRoots: () => [], Discovery: { findingsForRoot: () => [] }, discoveryState: null,
      nightFocusWorkflowsCache: { at: 0, list: [] },
      workflowTakeoverCandidates: () => [{ id: 'w1', name: 'pull campaigns with ' + K.SLACK.value, count: 4, lastAt: now - 5000, evidence: [{ quote: 'pull my campaigns with ' + K.ANTHROPIC.value }, { quote: ('again, key ' + K.GOOGLE.value).slice(0, 30) }] }]
    };
    vm.createContext(sandbox);
    const src = ['promptGoal', 'nightFocusWorkflows', 'nightFocusInputs', 'nightFocusLine'].map(n => S.sidecarFunctionSource(n)).join('\n');
    A.ok(src.indexOf('function nightFocusInputs') >= 0 && src.indexOf('function nightFocusLine') >= 0, 'P9: the host focus functions were extracted');
    vm.runInContext(src.replace(/^let nightFocusWorkflowsCache[^\n]*\n/m, '') + '\nthis.__inp = nightFocusInputs(); this.__pg = promptGoal();', sandbox);
    const inp = sandbox.__inp;
    A.ok(inp && inp.threads.length === 1 && inp.quests.length === 1 && inp.goal && inp.northStar && inp.workflows.length === 1, 'P9: every focus input kind is present');
    A.eq(leaks(JSON.stringify(inp)), '', 'P9: nightFocusInputs hands the resolver no key and no window (goal cut at 280 included)');
    for (const only of ['threads', 'quests', 'goal', 'northStar', 'workflows']) {
      const sub = { projects: [], threads: [], quests: [], goal: null, northStar: null, workflows: [], topics: [], now };
      sub[only] = inp[only];
      const f = nightfocus.resolveFocus(sub, { now });
      A.ok(f && /^TONIGHT'S FOCUS: /.test(nightfocus.focusLine(f)) && leaks(nightfocus.focusLine(f)) === '', 'P9: TONIGHT\'S FOCUS from the ' + only + ' input quotes no key: ' + (f ? nightfocus.focusLine(f).slice(0, 90) : 'none'));
    }
    // a focus PERSISTED raw earlier today (before the fix, or before a value was held) is scrubbed at use
    const raw = { kind: 'goal', ref: 'goal', label: goal.text.slice(0, 140), why: ['your active goal arc: "' + goal.text.slice(0, 140) + '" (0/2 done)', 'next step: ' + goal.next.slice(0, 100)] };
    sandbox.__raw = raw;
    const line = vm.runInContext('nightFocusLine(__raw)', sandbox);
    A.ok(/^TONIGHT'S FOCUS: /.test(line) && leaks(line) === '', 'P9: nightFocusLine scrubs a persisted raw focus: ' + line.slice(0, 100));
    // the goal note: each field scrubbed BEFORE its suffix (the store cut AIza at 280 now sits mid-note)
    const pg = sandbox.__pg;
    const note = 'Current goal: ' + pg.text + ' (' + pg.done + '/' + pg.total + ' milestones done). Next step: ' + pg.next + '.';
    A.eq(leaks(note), '', 'P9: the goal note built from promptGoal() holds no key or window');
    const unsafe = 'Current goal: ' + goal.text + ' (0/2 milestones done).';
    A.ok(leaks(PS.scrubStored(unsafe)) !== '', 'P9: (why field order matters: scrubbing the composed note leaves the store-cut fragment)');
    A.ok(/note\(\) \{\s*const g = promptGoal\(\);/.test(all), 'P9: commanderGoals.note() reads promptGoal()');
    // the quest-refresh directive over the scrubbed evidence object
    const ctx = PS.scrubDeep({
      goalNote: note, nextStep: goal.next, northStar: sandbox.questRefreshState.northStar,
      progress: QuestRefresh.progressContext({ goals: [{ id: 'g1', text: 'Grow outreach with github ' + K.GITHUB.value, successCondition: 'done when anthropic ' + K.ANTHROPIC.value + ' is rotated', status: 'active' }], outcomes: [{ goalId: 'g1', title: 'rotated ' + K.SLACK.value, evidence: 'see ' + K.OPENAI.value }] },
        [{ title: 'Rotate ' + K.OPENROUTER.value, disposition: 'later', declineNote: 'not with ' + K.VAULT.value }], { id: 'g1' }),
      openQuests: [{ title: 'Rotate ' + K.OPENROUTER.value }], completedQuests: [{ title: 'Moved ' + K.GOOGLE.value }], deniedTitles: ['Never ' + K.GITHUB.value]
    });
    const dir = QuestRefresh.buildDirective(ctx);
    A.ok(/GOAL PROGRESS AND COMMANDER FEEDBACK/.test(dir) && /QUESTS ALREADY OPEN/.test(dir), 'P9: the quest-refresh directive carries its evidence sections');
    A.eq(leaks(dir), '', 'P9: the quest-refresh directive (progress JSON, quest titles, denied titles, north star) holds no key');
  }

  // ---- P10: the persona system prompt is scrubbed at intake; compose() dedupes against that scrubbed copy ----
  {
    const dossier = 'Runs an outreach agency. Our OpenRouter key: ' + K.OPENROUTER.value + '. Vault: ' + K.VAULT.value;
    const pageSystem = 'You are Hero, the station lead.\n\nCOMMANDER DOSSIER\n' + dossier + '\n\nBe brief.';
    const system = PS.scrubStored(pageSystem);
    A.eq(leaks(system), '', 'P10: the scrubbed persona system holds no dossier key');
    A.ok(/You are Hero, the station lead\./.test(system) && /Be brief\.$/.test(system), 'P10: the persona keeps its words');
    const block = CommanderContext.compose({ dossier, existingSystem: system });
    A.ok(block.indexOf('<commander_context') < 0, 'P10: compose() recognises the scrubbed dossier already in the system prompt (not repeated)');
    A.ok(PS.scrubStored('You are Hero.\n\nBe brief.') === 'You are Hero.\n\nBe brief.', 'P10: a clean persona is the identical string (no prompt-cache change)');
  }

  // ---- P11: a TOOL RESULT that reads a store goes through the registry's result scrub (review r2) ----
  {
    const { makeRegistry, attachResultScrub } = require('../sidecar/tools/registry.js');
    const { makeLoopTools } = require('../sidecar/tools/builtin/loops.js');
    const seededLoop = { id: 'loop_rig', name: 'Standup poster', objective: 'Post the daily standup to Slack with bot token ' + K.SLACK.value + ' until it shows',
      agentId: 'agent', state: 'paused', enabled: false, iterationCount: 0, maxIterations: 5, lastError: 'auth failed for ' + K.VAULT.value, recent: [{ note: 'tried ' + K.GITHUB.value }] };
    const reg = makeRegistry();
    makeLoopTools({ listState: () => ({ loops: [seededLoop] }) }).register(reg);
    // the team.subagents shape: an orchestrator read that returns persisted records (lead-authored prompt, handoff context)
    reg.register({ name: 'team.subagents', capability: 'orchestrator', scope: 'read', requiresConsent: false, schema: { type: 'object', properties: {} },
      run: async () => ({ content: JSON.stringify([{ id: 'sa_rig', prompt: 'Call the billing API with key ' + K.OPENAI.value, context: 'The Commander said: the Anthropic key is ' + K.ANTHROPIC.value, result: 'ok' }]), summary: '1' }) });
    reg.register({ name: 'loop.boom', capability: 'orchestrator', scope: 'read', requiresConsent: false, schema: { type: 'object', properties: {} },
      run: async () => { throw new Error('stored objective ' + K.OPENROUTER.value + ' is invalid'); } });
    const raw = 'OPENAI_API_KEY=' + K.OPENAI.value + '\n';
    reg.register({ name: 'fs.read', capability: 'cabinet', scope: 'read', requiresConsent: false, schema: { type: 'object', properties: {} }, run: async () => ({ content: raw }) });
    reg.register({ name: 'mcp.notes.get', capability: 'mcp:notes', scope: 'read', requiresConsent: false, schema: { type: 'object', properties: {} }, run: async () => ({ content: raw }) });
    const call = name => reg.dispatch({ id: 'c1', name, args: {} }, {});
    const before = await call('loop.list');
    A.ok(before.content.indexOf(K.SLACK.value) >= 0, 'P11: (unattached, a store-reading tool result carries the stored key: the bug)');
    attachResultScrub(PS.scrubStored);
    try {
      const lr = await call('loop.list'), sa = await call('team.subagents'), boom = await call('loop.boom');
      A.eq(leaks(lr.content + '\n' + sa.content + '\n' + boom.content), '', 'P11: loop.list, team.subagents and a thrown store error reach the model with no key or window');
      A.ok(/"objective":"Post the daily standup to Slack with bot token \[redacted-key\] until it shows"/.test(lr.content) && /\[redacted-secret\]/.test(lr.content), 'P11: the loop row keeps its words and stays JSON');
      A.ok(JSON.parse(sa.content)[0].prompt === 'Call the billing API with key [redacted-key]', 'P11: the subagent record keeps its words');
      A.ok(boom.isError && /stored objective \[redacted-key\] is invalid/.test(boom.content), 'P11: an error result is scrubbed too');
      A.eq((await call('fs.read')).content, raw, 'P11: a workspace file read stays byte-exact (fs/shell/verify redact their own output; edits replay it)');
      A.eq((await call('mcp.notes.get')).content, raw, 'P11: a connector\'s own data is not a station store (unchanged)');
      attachResultScrub(() => { throw new Error('scrub broke'); });
      A.ok((await call('loop.list')).content.indexOf(K.SLACK.value) < 0, 'P11: a scrubber that throws withholds the result (fail closed)');
    } finally { attachResultScrub(null); }
    A.ok(/attachResultScrub\(PromptScrub\.scrubStored\)/.test(S.readSidecarSource()), 'P11: boot attaches the stored-text scrub to the registry');
  }

  // ---- P11b (review r3): a scrubbed JSON result STAYS JSON, and a clean station's env-var instructions keep their bytes.
  //      The field rule ate the '\' of an escaped quote ('Bearer [redacted-secret]" …'), so loop.js could not parse a
  //      team.configure receipt and a real Dossier save read as unverified. ----
  {
    const { makeRegistry, attachResultScrub } = require('../sidecar/tools/registry.js');
    const { makeLoopTools } = require('../sidecar/tools/builtin/loops.js');
    const events = require('../shared/events.js');
    const { makeEmitter } = require('../shared/emitter.js');
    const { makeCostEngine } = require('../sidecar/cost.js');
    const { runAgentLoop } = require('../sidecar/loop.js');
    const D = '$';
    const manual = 'Call the leads API with curl -H "Authorization: Bearer ' + D + 'INSTANTLY_API_KEY" and use -H "Authorization: Basic ' + D + 'B64CREDS" on the legacy one.\nThe staging password: "' + K.VAULT.value.slice(4, 20) + 'Zq" is rotated weekly.'
      + '\nThe old header was "Authorization: Token ' + K.VAULT.value.slice(20, 30) + '" (retired).';
    const reg = makeRegistry();
    reg.register({ name: 'team.configure', capability: 'orchestrator', scope: 'write', requiresConsent: false, schema: { type: 'object', properties: {} },
      run: async () => ({ content: JSON.stringify({ agentId: 'worker', field: 'manual', text: manual, durable: true, applies: 'next run' }) }) });
    const cleanLoop = { id: 'loop_c', name: 'Leads', objective: 'Every hour run curl -s -H "Authorization: Bearer ' + D + 'INSTANTLY_API_KEY" "https://api.instantly.ai/api/v2/emails"', agentId: 'agent', state: 'paused', enabled: false, iterationCount: 0, maxIterations: 5, recent: [] };
    makeLoopTools({ listState: () => ({ loops: [cleanLoop] }) }).register(reg);
    const unscrubbedList = (await reg.dispatch({ id: 'l0', name: 'loop.list', args: {} }, {})).content;
    attachResultScrub(PS.scrubStored);
    let receipt;
    try {
      receipt = await reg.dispatch({ id: 'c1', name: 'team.configure', args: {} }, {});
      A.eq((await reg.dispatch({ id: 'l1', name: 'loop.list', args: {} }, {})).content, unscrubbedList, 'P11b: a clean loop objective teaching Bearer $NAME reaches the model byte-identical');
    } finally { attachResultScrub(null); }
    let saved = null; try { saved = JSON.parse(receipt.content); } catch (_) { saved = null; }
    A.ok(saved && saved.durable === true && saved.agentId === 'worker' && saved.field === 'manual', 'P11b: the scrubbed team.configure receipt is still JSON loop.js can read: ' + receipt.content.slice(0, 160));
    A.ok(saved && saved.text.indexOf('Bearer ' + D + 'INSTANTLY_API_KEY') >= 0 && saved.text.indexOf('Basic ' + D + 'B64CREDS') >= 0 && saved.text.indexOf(K.VAULT.value.slice(4, 20)) < 0 && saved.text.indexOf(K.VAULT.value.slice(20, 30)) < 0, 'P11b: env-var references kept, the quoted password and the Token credential hidden');
    // the loop itself: the scrubbed receipt counts as the Dossier save, so "I've updated the agent's instructions." ends the run done
    const textTurn = (t) => [{ type: 'text', delta: t }, { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, { type: 'done', finishReason: 'stop' }];
    const cfgTurn = [{ type: 'tool_start', index: 0, id: 'cfg', name: 'team_configure' }, { type: 'tool_args', index: 0, chunk: '{}' },
      { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, { type: 'done', finishReason: 'tool_calls' }];
    let n = 0;
    const turns = [cfgTurn, textTurn("I've updated the agent's instructions.")];
    const provider = { async *stream() { const t = turns[Math.min(n, turns.length - 1)]; n++; for (const ev of t) yield ev; }, priceOf: () => ({ prompt: '0', completion: '0' }), contextLimit: () => 8000 };
    const bus = A.makeBus();
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'update the worker manual' }], provider, emit: makeEmitter(bus, () => {}),
      cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r-p11b',
      tools: [{ name: 'team_configure', schema: { type: 'object' } }, { name: 'notebook_write', schema: { type: 'object' } }],
      dispatch: async () => ({ ok: true, isError: false, content: receipt.content }), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' } });
    A.eq([res.reason, n], ['done', 2], 'P11b: loop.js counts the scrubbed receipt as a configuration write (no memory_receipt nudge)');
    void events;
  }

  // ---- P11c (review r3): a host tool whose result holds no stored text opts out by name (resultScrub: false). keys.save's
  //      crowded refusal named the candidates' first 4 chars ("sk-p…") and the masked-key rule turned every one into
  //      [redacted-key]. A connector registration cannot opt out; a store reader still scrubs. ----
  {
    const { makeRegistry, attachResultScrub } = require('../sidecar/tools/registry.js');
    const { makeKeyTools } = require('../sidecar/tools/builtin/keys.js');
    const three = [K.OPENAI, K.GITHUB, K.GOOGLE];
    const msg = 'Here are my keys: ' + three.map(k => k.value).join(' and ');
    const reg = makeRegistry();
    makeKeyTools({ ownerTexts: () => [msg], save: ({ name }) => ({ ok: true, record: { name, envVar: name.toUpperCase() + '_API_KEY', autonomous: false, unattendedSupported: true }, existed: false, sameValue: false, saved: true }) }).register(reg);
    const echo = 'stored note: the candidates start "' + three.map(k => k.value.slice(0, 4)).join('…", "') + '…"';
    reg.register({ name: 'station.note', capability: 'orchestrator', scope: 'read', requiresConsent: false, resultScrub: false, schema: { type: 'object', properties: {} }, run: async () => ({ content: echo }) }, { provenance: 'connector' });
    reg.register({ name: 'station.note2', capability: 'orchestrator', scope: 'read', requiresConsent: false, schema: { type: 'object', properties: {} }, run: async () => ({ content: echo }) });
    attachResultScrub(PS.scrubStored);
    try {
      const crowded = await reg.dispatch({ id: 'k1', name: 'keys.save', args: { service: 'Saleshandy' } }, {});
      A.ok(crowded.isError && three.every(k => crowded.content.indexOf('"' + k.value.slice(0, 4) + '…"') >= 0), 'P11c: keys.save\'s crowded refusal keeps every candidate\'s first 4 chars through the attached scrub: ' + crowded.content.slice(0, 200));
      A.eq(leaks(crowded.content), '', 'P11c: …and holds no key or window');
      const wrong = await reg.dispatch({ id: 'k2', name: 'keys.save', args: { service: 'Saleshandy', starts_with: K.VAULT.value } }, {});
      A.ok(wrong.isError && wrong.content.indexOf('"' + K.VAULT.value.slice(0, 8) + '…"') >= 0 && leaks(wrong.content) === '', 'P11c: a whole key passed as starts_with is echoed by its first 8 chars only: ' + wrong.content.slice(0, 160));
      A.ok((await reg.dispatch({ id: 'n1', name: 'station.note', args: {} }, {})).content.indexOf('[redacted-key]') >= 0, 'P11c: a CONNECTOR registration cannot opt out of the scrub');
      A.ok((await reg.dispatch({ id: 'n2', name: 'station.note2', args: {} }, {})).content.indexOf('[redacted-key]') >= 0, 'P11c: a store reader that does not opt out still scrubs (fail closed by default)');
    } finally { attachResultScrub(null); }
  }

  // ---- P12: an INTERNAL run's page-composed directive quotes stored beliefs/goals: scrubbed at runOnceCore's intake ----
  {
    const AutoJobs = require('../frontend/app/autojobs.js');
    const Goals = require('../frontend/app/goals.js');
    const beliefs = { goals: ['Ship outreach v2 this quarter'], stack: ['Every model call goes through OpenRouter with key ' + K.OPENROUTER.value] };
    const aj = [{ role: 'user', content: AutoJobs.buildProposalDirective({ beliefs, existingJobs: ['Morning digest'] }) }];
    const gd = [{ role: 'system', content: 'x' }, { role: 'user', content: [{ type: 'text', text: Goals.buildDirective('Ship outreach v2 with the openai key ' + K.OPENAI.value + ' wired in') }] }];
    A.ok(leaks(JSON.stringify(aj)) !== '' && leaks(JSON.stringify(gd)) !== '', 'P12: (the page\'s real directive builders quote the stored keys raw)');
    const ajOut = PS.scrubStoredMessages(aj), gdOut = PS.scrubStoredMessages(gd);
    A.eq(leaks(JSON.stringify(ajOut) + JSON.stringify(gdOut)), '', 'P12: scrubStoredMessages leaves no key or window in the autojobs and goal-decomposition directives (string and text-part content)');
    A.ok(/OpenRouter with key \[redacted-key\]/.test(ajOut[0].content) && gdOut[0] === gd[0] && aj[0].content.indexOf(K.OPENROUTER.value) >= 0, 'P12: words kept, clean messages kept by identity, the input never mutated');
    const tidy = [{ role: 'user', content: 'Recommend the next step' }];
    A.ok(PS.scrubStoredMessages(tidy) === tidy, 'P12: a clean conversation is the same array (no prompt-cache change)');
    const core = S.sidecarTopLevelFunction('runOnceCore');
    A.ok(/if \(o && o\.internal && Array\.isArray\(o\.messages\)\) \{ const m = PromptScrub\.scrubStoredMessages\(o\.messages\);/.test(core.slice(0, 1200)), 'P12: runOnceCore scrubs an internal run\'s messages before anything reads them');
  }

  // ---- P13: LIVE VOICE sends its instructions browser -> provider: they go through POST /api/prompt/scrub first ----
  {
    const { Readable } = require('node:stream');
    const fs = require('node:fs');
    const { readBody } = require('../sidecar/http-body.js');
    const { json } = require('../sidecar/respond.js');
    const { makeTranscriptRedactRoute } = require('../sidecar/transcript-redact.js');
    const route = makeTranscriptRedactRoute({ redact: (t) => PS.scrubStored(t), readBody, json });   // index.js wires exactly this
    let routeUp = true;
    const pageFetch = async (url, init) => {
      if (url !== '/api/prompt/scrub' || !routeUp) throw new TypeError('Failed to fetch');
      const req = Readable.from([Buffer.from(String(init.body), 'utf8')]);
      const res = { headersSent: false, status: 0, out: '', writeHead(c) { this.status = c; this.headersSent = true; }, end(s) { this.out = String(s == null ? '' : s); } };
      await route(req, res);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(res.out) };
    };
    const voice = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'voice-live.js'), 'utf8');
    const body = (head) => { const i = voice.indexOf(head); A.ok(i >= 0, 'P13: voice-live.js has ' + head); const j = voice.indexOf('\n  }\n', i); return voice.slice(i, j + 4); };
    const seqLine = (/\n  let contextPushSeq = 0;\n/.exec(voice) || [''])[0];
    const src = seqLine + body('function voiceInstructions() {') + body('function scrubbedInstructions(text) {') + body('function pushSessionContext() {');
    const sent = [];
    const agent = { name: 'Hero', systemPrompt: 'You are Hero.\n\nCOMMANDER DOSSIER\nRuns an outreach agency. Our OpenRouter key: ' + K.OPENROUTER.value };
    const ctx = { agent, crew: [], streams: [{ id: 's1', title: 'pull campaigns with ' + K.VAULT.value }], activeWs: null };
    const api = new Function('fetch', 'sendEvent', 'stationContext', 'sessionName', 'Personas', src + '; return { pushSessionContext, voiceInstructions };')(
      pageFetch, (e) => { sent.push(e); return true; }, () => ctx, (ws) => ws.title, undefined);
    A.ok(leaks(api.voiceInstructions()) !== '', 'P13: (the composed voice instructions quote the dossier key and a held session title raw)');
    await api.pushSessionContext();
    A.eq(sent.length, 1, 'P13: one session.update went to the provider channel');
    const sentText = sent[0] && sent[0].session && sent[0].session.instructions;
    A.eq(leaks(sentText), '', 'P13: the instructions that leave the browser hold no key or window');
    A.ok(/Our OpenRouter key: \[redacted-key\]/.test(sentText) && /Open sessions: pull campaigns with \[redacted-secret\]\./.test(sentText), 'P13: the persona and session words survive around the placeholders');
    routeUp = false;
    await api.pushSessionContext();
    A.eq(sent.length, 1, 'P13: when the station cannot scrub them, nothing is sent (the call keeps its generic instructions)');
    routeUp = true;
    const p1 = api.pushSessionContext(), p2 = api.pushSessionContext();
    await Promise.all([p1, p2]);
    A.eq(sent.length, 2, 'P13: a newer push supersedes one still in flight (one update, not two)');
    const idx = S.readSidecarSource();
    A.ok(/makeTranscriptRedactRoute\(\{ redact: \(t\) => PromptScrub\.scrubStored\(t\), readBody, json: respondJson \}\)/.test(idx) && /exact: '\/api\/prompt\/scrub', h: handlePromptScrub/.test(idx), 'P13: index.js serves /api/prompt/scrub with prompt-scrub\'s stored-text rule');
  }

  // ---- P14: the belt never mangles HOST INSTRUCTIONS (review r2): '"Authorization": "Bearer ${NAME}"' stays intact ----
  {
    const fs = require('node:fs');
    const serviceKeysMod = require('../sidecar/servicekeys.js');
    const list = [{ name: 'Instantly', envVar: 'INSTANTLY_API_KEY', key: K.VAULT.value }, { name: 'Acme', envVar: 'ACME_API_TOKEN', key: 'acme-' + K.VAULT.value.slice(0, 20) }];
    for (const platform of ['win32', 'posix']) {
      const block = serviceKeysMod.promptBlock(list, { shell: true, request: true, platform });
      A.ok(block.length > 200 && block.indexOf('${INSTANTLY_API_KEY}') >= 0, 'P14: the service-keys block teaches ${NAME} (' + platform + ')');
      A.ok(PS.scrubStored(block) === block, 'P14: scrubStored leaves the composed service-keys block byte-identical (' + platform + ')');
    }
    const skillsDir = path.join(__dirname, '..', 'skills-catalog', 'skills');
    const changed = [];
    for (const slug of fs.readdirSync(skillsDir)) {
      const f = path.join(skillsDir, slug, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const body = fs.readFileSync(f, 'utf8');
      if (PS.scrubStored(body) !== body) changed.push(slug);
    }
    A.eq(changed, [], 'P14: scrubStored leaves every shipped skill body byte-identical (rest-graphql-debug teaches "Authorization": "Bearer ${ACME_API_TOKEN}")');
  }

  PS.setHeldSource(null);
  A.report('prompt-scrub.projectors.test');
})().catch(e => { console.error(e); process.exit(1); });
