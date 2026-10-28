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
     P6 source locks on the host wiring (read through test/helpers/source.js). */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const path = require('node:path');
const PS = require('../sidecar/prompt-scrub.js');
const CommanderContext = require('../sidecar/commander-context.js');
const contextpack = require('../sidecar/contextpack.js');
const Interests = require('../sidecar/interests.js');
const { makeThreadsStore } = require('../sidecar/threads-store.js');
const S = require('./helpers/source.js');
const FK = require('./helpers/fake-keys.js');
const { list, by } = FK.make('prompt-scrub-projectors');

const leaks = s => list.map(k => FK.leak(s, k) && (k.id + ':' + FK.leak(s, k))).filter(Boolean).join(', ');
// the station HOLDS the vault value (saved through KEYS after it was typed)
PS.setHeldSource(() => [by.VAULT.value]);   // the host's credential source (index.js setHeldSource)
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
  const src = S.functionSourceIn(ccFile ? ccFile.text : '', 'compose');
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

  // ---- P6: source locks on the host wiring ----
  const all = S.readSidecarSource();
  A.ok(all.indexOf('attachRequestScrub(PromptScrub.guardRequest)') >= 0, 'P6: boot attaches the provider-boundary scrub to the factory');
  const nsp = S.sidecarFunctionSource('nightshiftContextPack');
  A.ok(nsp.indexOf('contextpack.assemble(') >= 0 && !/contextpack\.assemble\(\{[^}]*\bredact\b/.test(nsp), 'P6: nightshiftContextPack relies on the pack\'s default resolver (no bare context redact)');
  const core = S.sidecarTopLevelFunction('runOnceCore');
  A.ok(core.indexOf('runContextNote(PromptScrub.scrubStored(withQuests(perRunBlocks, questsBlock)))') >= 0, 'P6: the whole <run_context> body goes through scrubStored');
  A.ok(core.indexOf('PromptScrub.scrubStored(KeyTools.nameSavedKeys(') >= 0, 'P6: the run title is scrubbed AFTER nameSavedKeys names a saved key');
  for (const fn of ['runScoutCycle', 'runQuestRefreshCycle', 'runStudy']) {
    const body = S.sidecarFunctionSource(fn);
    A.ok(body.length > 0 && body.indexOf('commanderDossier.get()') < 0 && body.indexOf('promptDossier()') >= 0, 'P6: ' + fn + ' reads the dossier only through promptDossier()');
  }
  const scout = S.sidecarFunctionSource('runScoutCycle');
  A.ok(/grounding: \[interestsBlock, activityBlock, directionBlock, dossierBlock\]/.test(scout), 'P6: the scout recipe veto grounds in the SAME scrubbed dossier its directive showed');
  A.ok(/const grounding = \[goalNote, dossierBlock,/.test(S.sidecarFunctionSource('runQuestRefreshCycle')), 'P6: the quest-refresh veto reads the same scrubbed goal note + dossier');

  A.report('prompt-scrub.projectors.test');
})().catch(e => { console.error(e); process.exit(1); });
