'use strict';
/* node test/context-budget.authority.test.js — ONE BUDGET AUTHORITY (context-budget-and-fold, step 3).

   THE DEFECT. The server folds a run once its prompt passes RUN_CONTEXT_DEFAULTS.compactAt of the window the run works in (runWindow:
   the model's own window stopped at its price tier). The page fitted a chat's history to 85% of the MODEL's window (historyfit.js) and
   the desk's window fallback (turn-window.js) did the same, so once a chat was long every send was already past the server's fold line:
   probed on the real sidecar at 32k, a paid fold on each of 14 sends in a row. Two numbers for one line.

   THE RULE LOCKED HERE, on the real bodies end to end (the sidecar's /api/models handler, the page catalog, chat.js windowModelOf,
   HistoryFit.fitModel, the station fallback, and the server's own makeContext(RUN_CONTEXT_DEFAULTS)):
     1. a row that publishes compactAt is fitted to floor(runWindow * compactAt) minus the MEASURED overhead, which already holds the
        system prompt and the tool schemas, so it is the only thing taken off the line (never subtracted twice): the fitted send is never
        past the server's fold line, and not needlessly under it;
     2. an unmeasured chat reserves the assumed overhead it always did, off the same line, and the station fallback agrees with the page;
     3. a row without compactAt (an older sidecar) takes the former 85% fit exactly, runWindow ignored: the frozen 3d581b9dd bodies;
     4. the published share IS RUN_CONTEXT_DEFAULTS.compactAt and no page or window file holds a second fold share (source scan);
     5. every rule has teeth: a compiled mutant of the page or station source with one line changed is caught by the same table. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Fit = require('../frontend/app/historyfit.js');
const Gauge = require('../frontend/app/ctxgauge.js');
const Store = require('../sidecar/transcriptstore.js');
const Dual = require('../sidecar/turn-dual.js');
const Window = require('../sidecar/turn-window.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { promptTierCeiling } = require('../sidecar/providers/prices.js');
const { makeBilling } = require('../sidecar/billing-class.js');
const { readSidecarSource } = require('./helpers/source.js');
const { decomment } = require('./helpers/decomment.js');
const frozen = require('./fixtures/historyfit-3d581b9dd.js');

const here = rel => path.join(__dirname, '..', rel);
const read = rel => fs.readFileSync(here(rel), 'utf8');
const sidecarSrc = readSidecarSource(), harnessSrc = read('frontend/app/harness.js'), chatSrc = read('frontend/app/chat.js');
function slice(src, start, end, label) {
  const a = src.indexOf(start), b = src.indexOf(end, a);
  if (!(a >= 0 && b > a)) throw new Error('production source not found: ' + label);
  return src.slice(a, b + end.length);
}
// a compiled mutant: the module's own source with ONE line changed, which must change exactly one place (a no-op mutation proves nothing)
function mutate(src, from, to, label) {
  if (src.split(from).length !== 2) throw new Error('mutation anchor is not unique: ' + label);
  return src.replace(from, to);
}
function compile(file, source) {
  const module = { exports: {} };
  new Function('module', 'exports', 'require', source)(module, module.exports,
    id => (id.startsWith('.') ? require(path.resolve(path.dirname(here(file)), id)) : require(id)));
  return module.exports;
}

/* ---- the real bodies: the sidecar's model rows, the page catalog, the page's window model ---- */
const profiles = { openrouter: {}, anthropic: {}, gemini: {}, ollama: { unmetered: true } };
const billing = makeBilling({ profileOf: id => profiles[id] || null });
let served = [];
const handler = vm.runInNewContext(slice(sidecarSrc, 'function publicModel(m)', '\n}\n', 'publicModel') +
  slice(sidecarSrc, 'async function handleProviderModels(', '\n}\n', 'handleProviderModels') + '\n({ handleProviderModels })', {
  URL, promptTierCeiling, RUN_CONTEXT_DEFAULTS, normalizeProvider: p => String(p || '').trim().toLowerCase(),
  getProviderProfile: id => profiles[id] || null, billing, listModelsForProvider: async () => served });
async function publish(provider, model) {
  served = [model]; let body = null;
  await handler.handleProviderModels({ url: '/api/models/' + provider }, { writeHead() {}, end(value) { body = JSON.parse(value); } });
  return body.models[0];
}
const catalog = Object.create(null);
const page = vm.runInNewContext(['  function normalizeModel(m)', '  function contextLimitOf(id)', '  function runWindowOf(id)', '  function compactAtOf(id)']
  .map(head => slice(harnessSrc, head, '\n  }\n', head.trim())).join('') + '\n({ normalizeModel, contextLimitOf, runWindowOf, compactAtOf })',
  { catalogModel: id => catalog[id] || null });
const chatFns = ['windowModelOf', 'modelFitHistory'].map(name => A.fnBody(chatSrc, 'function ' + name + '(')).join('\n');
A.ok(chatFns.length > 200 && chatFns.length < 6000, 'chat.js windowModelOf and modelFitHistory are sliced whole');

// ONE page send as chat.js builds it: the real windowModelOf over the page catalog, then the (real or compiled) HistoryFit.fitModel.
// `overhead` is what the provider measured beyond the dialogue (null = no reading yet); the stub reads it as the harness does:
// used = overhead + the page's own estimate of the messages that were sent.
function pageFit(HistoryFit, entry, overhead, history, opts) {
  opts = opts || {};
  catalog[entry.id] = page.normalizeModel(entry.row);
  const limit = page.contextLimitOf(entry.id);
  const Harness = { getModel: () => entry.id, contextLimitOf: page.contextLimitOf,
    contextState: (_agent, _stream, fitted) => (overhead === null
      ? { model: entry.id, limit, used: 0, measured: false, projected: false }
      : { model: entry.id, limit, runWindow: page.runWindowOf(entry.id) || limit, used: overhead + HistoryFit.contextEstimateMessages(fitted), measured: true, projected: false }) };
  if (opts.runWindowOf !== false) Harness.runWindowOf = page.runWindowOf;
  if (opts.compactAtOf !== false) Harness.compactAtOf = page.compactAtOf;
  const context = vm.createContext({ HistoryFit, Harness, CtxGauge: Gauge, stationModes: { window: 'legacy' } });
  vm.runInContext((opts.chat || chatFns) + '\nthis.windowModelOf = windowModelOf;', context);
  const model = context.windowModelOf({ id: 's', agentId: 'agent', history }, history);
  return Object.assign({ model }, HistoryFit.fitModel(history, model));
}
const est1 = message => Fit.contextEstimateMessages([message]);
const sum = messages => messages.reduce((total, message) => total + est1(message), 0);

/* ---- the table: rows the REAL handler publishes x chats of every shape x measured overheads ---- */
const ROWS = [
  ['openrouter', { id: 'vendor/small-32k', context_length: 32000 }, 'a 32k model'],
  ['anthropic', { id: 'claude-sonnet-x', context_length: 128000 }, 'a 128k model'],
  ['anthropic', { id: 'claude-haiku-5-5', context_length: 200000 }, 'Haiku 5.5 on a key (100K price tier)'],
  ['gemini', { id: 'gemini-2.5-pro', context_length: 1048576 }, 'Gemini Pro on a key (200k price tier)'],
  ['openrouter', { id: 'vendor/big-1m', context_length: 1048576 }, 'a 1M model on OpenRouter (every tier priced: whole window)'],
  ['ollama', { id: 'tiny-8k', context_length: 8192 }, 'an 8k local model']
];
const talk = (n, chars, glyph) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: (glyph || 'w').repeat(chars) + ' #' + i }));
const send = history => history.concat([{ role: 'user', content: 'and now?' }]);
const SHAPES = [
  ['one line', send([])], ['six short turns', send(talk(6, 200))], ['120 rows of 1k', send(talk(120, 1000))],
  ['120 rows of 4k', send(talk(120, 4000))], ['dense unicode', send(talk(120, 900, '日'))], ['40 big pastes', send(talk(40, 12000))],
  ['a giant newest message', talk(30, 800).concat([{ role: 'user', content: 'p'.repeat(200000) }])]
];
const OVERHEADS = [0, 2500, 13100, 30000];

const entries = [];
module.exports = (async () => {
  for (const [provider, model, name] of ROWS) {
    const row = await publish(provider, model);
    const server = makeContext(Object.assign({ contextLimit: row.context_length,
      windowCeiling: () => promptTierCeiling(provider, row.id, !billing.policyOf(provider).promptTier) }, RUN_CONTEXT_DEFAULTS));
    // the same row from an older sidecar: runWindow it already published, no compactAt
    const older = Object.assign({}, row); delete older.compactAt;
    entries.push({ name, provider, id: row.id, row, server, W: row.runWindow, share: row.compactAt, line: Math.floor(row.runWindow * row.compactAt),
      old: { id: row.id + '#older-sidecar', row: older } });
  }

  // ---- 0. what the sidecar publishes IS the server's fold line ----
  for (const e of entries) {
    A.eq(e.share, RUN_CONTEXT_DEFAULTS.compactAt, e.name + ': the row publishes the share makeContext folds with');
    A.ok(e.W > 0 && e.W <= e.row.context_length, e.name + ': runWindow is the model window, lowered at most by its tier: ' + e.W);
    A.ok(Math.abs(e.server.thresholdTokens() - e.W * e.share) < 1e-6, e.name + ': published runWindow x compactAt is where the real context manager folds: ' + e.server.thresholdTokens());
    A.ok(!e.server.shouldCompact({ prompt_tokens: e.line }) && e.server.shouldCompact({ prompt_tokens: e.line + 1 }), e.name + ': the fold line is floor(runWindow x compactAt), compared with >');
  }
  const unknown = await publish('openrouter', { id: 'vendor/unknown', context_length: 0 });
  A.ok(!('runWindow' in unknown) && !('compactAt' in unknown), 'a window the catalog does not know gets no fold line invented: ' + JSON.stringify(unknown));

  // ---- 1-2. the table on the real code, then on every mutant ----
  const tally = { legacyPast: 0 };
  function violations(HistoryFit, opts) {
    const bad = []; let cases = 0;
    for (const e of entries) for (const [shape, history] of SHAPES) for (const overhead of OVERHEADS.concat([null])) {
      const tag = e.name + ' / ' + shape + ' / ' + (overhead === null ? 'unmeasured' : 'overhead ' + overhead);
      const fit = pageFit(HistoryFit, e, overhead, history, opts), base = HistoryFit.windowRows(history, { window: 'legacy' });
      const kept = fit.messages, newest = base[base.length - 1];
      if (kept[kept.length - 1] !== newest) bad.push(tag + ': the newest turn is not the last one kept');
      const reserve = Math.min(16000, Math.floor(e.W / 2));
      const expected = overhead === null ? Math.max(1, e.line - reserve) : Math.max(1, e.line - overhead);
      if (fit.budget !== expected) bad.push(tag + ': budget ' + fit.budget + ', the line less the ' + (overhead === null ? 'assumed reserve' : 'measured overhead') + ' is ' + expected);
      if (kept.length > 1) {
        const assumed = overhead === null ? reserve : overhead;
        const prompt = assumed + Fit.contextEstimateMessages(kept);
        if (prompt > e.line) bad.push(tag + ': a fitted send of ' + prompt + ' tokens is past the fold line ' + e.line);
        if (e.server.shouldCompact({ prompt_tokens: prompt })) bad.push(tag + ': the real context manager would fold a fitted send of ' + prompt);
      }
      const next = base[base.length - kept.length - 1];
      if (next && sum(kept) + est1(next) <= expected) bad.push(tag + ': nothing was needlessly dropped: the next older turn still fits under ' + expected);
      cases++;
    }
    return { bad, cases };
  }
  const real = violations(Fit);
  A.eq(real.bad, [], 'the page fit never sends past the server fold line and never drops what fits under it (' + real.cases + ' cases)');
  A.eq(real.cases, entries.length * SHAPES.length * (OVERHEADS.length + 1), 'the table ran whole');

  // ---- 3. an older sidecar: the former 85% fit exactly (the frozen bodies), runWindow ignored, and that fit WAS past the line ----
  for (const e of entries) for (const [shape, history] of SHAPES) for (const overhead of OVERHEADS.concat([null])) {
    const tag = e.name + ' / ' + shape + ' / ' + (overhead === null ? 'unmeasured' : 'overhead ' + overhead);
    const old = pageFit(Fit, e.old, overhead, history);
    const Harness = { getModel: () => e.old.id, contextLimitOf: page.contextLimitOf,
      contextState: (_agent, _stream, fitted) => (overhead === null ? { model: e.old.id, limit: e.row.context_length, used: 0, measured: false, projected: false }
        : { model: e.old.id, limit: e.row.context_length, used: overhead + Fit.contextEstimateMessages(fitted), measured: true, projected: false }) };
    const former = frozen(Gauge, require('../frontend/app/turnmerge.js'), Harness, { window: 'legacy' });
    A.eq(old.messages, former.modelFitHistory(history, { id: 's', agentId: 'agent', history }), tag + ': no compactAt published = the frozen 3d581b9dd fit, bytes for bytes');
    A.ok(!('compactAt' in old.model) || !old.model.compactAt, tag + ': the window model carries no fold share for an older sidecar');
    const fresh = pageFit(Fit, e, overhead, history);
    if (old.messages.length > fresh.messages.length) {
      // the tight fit stopped because the next older turn does not fit under the line, and the former fit kept it: past the line
      // by the page's own per-turn accounting, always; and by the gauge's whole-chat estimate (what the server is told) in most
      const assumed = overhead === null ? Math.min(16000, Math.floor(e.W / 2)) : overhead;
      A.ok(assumed + sum(old.messages) > e.line, tag + ': what the former fit kept does not fit under the fold line ' + e.line);
      if (e.server.shouldCompact({ prompt_tokens: assumed + Fit.contextEstimateMessages(old.messages) })) tally.legacyPast++;
    }
  }
  A.ok(tally.legacyPast >= 20, 'the defect is real in the table: the former 85% fit sends a prompt the server folds in ' + tally.legacyPast + ' cases');

  // ---- 4. the pieces of the chain, each on its own ----
  const sample = entries.find(e => e.id === 'vendor/small-32k');
  const hist = send(talk(120, 1000));
  const withBoth = pageFit(Fit, sample, 13100, hist).model;
  A.eq([withBoth.limit, withBoth.runWindow, withBoth.compactAt], [32000, 32000, RUN_CONTEXT_DEFAULTS.compactAt], 'windowModelOf hands HistoryFit the model window, the run window and the fold share from the catalog row');
  const tier = pageFit(Fit, entries.find(e => e.id === 'claude-haiku-5-5'), 13100, hist).model;
  A.eq([tier.limit, tier.runWindow], [200000, 100000], 'a tiered model: the limit stays the model window (composer checks), the run window is the tier');
  const noRunWindow = pageFit(Fit, sample, 13100, hist, { runWindowOf: false }).model;
  A.eq(noRunWindow.runWindow, 32000, 'a harness without runWindowOf: the run window falls back to the model window');
  const noShare = pageFit(Fit, sample, 13100, hist, { compactAtOf: false });
  A.ok(!noShare.model.compactAt, 'a harness without compactAtOf publishes no share');
  A.eq(noShare.messages, pageFit(Fit, sample.old, 13100, hist).messages, 'and fits as an older sidecar does');
  A.eq(Fit.uncalibratedBudget(128000), 92800, 'uncalibratedBudget(limit) with no share is the former rule');
  A.eq(Fit.uncalibratedBudget(128000, RUN_CONTEXT_DEFAULTS.compactAt), Math.floor(128000 * RUN_CONTEXT_DEFAULTS.compactAt) - 16000, 'uncalibratedBudget(window, share) is the line less the assumed overhead');
  for (const junk of [0, -1, 1.2, NaN, 'x', null, undefined]) A.eq(Fit.uncalibratedBudget(128000, junk), 92800, 'a share that is not in (0, 1] is no published fold line: ' + String(junk));
  const plan = Fit.sendPlan(hist, { ids: { turnId: 'authority_turn_1' }, model: withBoth });
  A.eq(plan.post.windowTokens, Math.max(1, Math.floor(32000 * RUN_CONTEXT_DEFAULTS.compactAt) - 13100), 'sendPlan posts the same budget to the station: the fold line less the measured overhead');

  // ---- 5. the station fallback fits to the same line as the page ----
  const T = 'authority_turn_current';
  const dual = Dual.make({ now: () => 1000000, hash: x => x, env: key => (key === 'STARNET_TURNID_WINDOW' ? 'id' : undefined) });
  const store = Store.makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => 1000000 }, pick: (...args) => dual.pick(...args) });
  for (let i = 0; i < 80; i++) {
    const turnId = 'authority_turn_' + String(i).padStart(4, '0');
    store.appendStrict({ streamId: 's', agentId: 'a', role: 'user', content: 'ask ' + i + ' ' + 'q'.repeat(300), turnId, directive: true });
    store.appendStrict({ streamId: 's', agentId: 'a', role: 'assistant', content: 'answer ' + i + ' ' + 'r'.repeat(300), turnId });
  }
  const newest = { role: 'user', content: 'NEW_OWNER', turnId: T, turnAt: 1000000 };
  const posted = [{ role: 'system', content: 'SYSTEM' }, newest];
  const body = { streamId: 's', agentId: 'a', turnId: T, windowCaller: 'desk', clientClock: { clientNow: 1000000, at: 1000000 } };
  const ctx = { agentId: 'a', runId: 'run-authority', directive: { turnId: T } };
  const SMALL = 8192;
  const canonical = store.view('model-replay', 's', { form: 'pre', shape: 'prose', complete: true, excludeTurnId: T }).concat([newest]);
  function fallbackKept(TurnWindow, injected) {
    const deps = Object.assign({ transcriptStore: store, turnDual: dual, failNote() {}, limitOf: () => SMALL }, injected);
    const out = TurnWindow.make(deps).apply(posted, body, ctx);   // no windowTokens: the page said nothing, so the fallback budget decides
    return out.filter(m => m.role !== 'system').length;
  }
  const share = RUN_CONTEXT_DEFAULTS.compactAt;
  const pageUnmeasured = Fit.fitModel(canonical, { limit: SMALL, runWindow: SMALL, compactAt: share, selected: 'm', window: 'legacy' });
  A.ok(pageUnmeasured.messages.length > 3 && pageUnmeasured.messages.length < canonical.length - 20, 'the station scenario cuts into the history: ' + pageUnmeasured.messages.length + ' of ' + canonical.length);
  A.eq(fallbackKept(Window, { compactAt: share }), pageUnmeasured.messages.length, 'the station fallback with the injected share keeps exactly what the page keeps for an unmeasured chat');
  const former = Fit.fitModel(canonical, { limit: SMALL, selected: 'm', window: 'legacy' });
  A.eq(fallbackKept(Window, {}), former.messages.length, 'a caller that injects no share keeps the former station fallback');
  A.ok(former.messages.length > pageUnmeasured.messages.length, 'and that fallback kept more than the fold line allows: ' + former.messages.length + ' vs ' + pageUnmeasured.messages.length);

  // ---- 6. source: one fold share, wired from the one place ----
  const code = rel => decomment(read(rel));
  const count = (text, re) => (text.match(re) || []).length;
  const SHARE = /(?<![\w.])0?\.65(?!\d)/g, FORMER = /(?<![\w.])0?\.85(?!\d)/g;
  // chat.js is one very large file with numbers of its own: what must hold no fold share is the page's history-fit region (the
  // cap, the window model, the fit, the composer guard: capHistory up to getHistory)
  const fitRegion = decomment(slice(chatSrc, 'function capHistory(', 'function getHistory(', 'chat.js history-fit region'));
  A.ok(fitRegion.includes('function windowModelOf(') && fitRegion.includes('function contextIssueFor('), 'the chat.js region holds the window model and the composer guard');
  for (const [where, text] of [['historyfit.js', code('frontend/app/historyfit.js')], ['harness.js', code('frontend/app/harness.js')],
    ['chat.js history-fit region', fitRegion], ['turn-window.js', code('sidecar/turn-window.js')]])
    A.eq(count(text, SHARE), 0, where + ': no second fold share in the code');
  A.eq(count(code('frontend/app/historyfit.js'), FORMER), 1, 'historyfit.js: the former 85% is named once, as the fallback for a missing fact');
  A.ok(/const LEGACY_FIT_SHARE = 0\.85;/.test(code('frontend/app/historyfit.js')), 'and that one is LEGACY_FIT_SHARE');
  A.eq([count(code('frontend/app/harness.js'), FORMER), count(code('sidecar/turn-window.js'), FORMER)], [0, 0], 'harness.js and turn-window.js name no fit share');
  const issue = A.fnBody(chatSrc, 'function contextIssueFor(');
  A.eq([count(decomment(issue), FORMER), count(fitRegion, FORMER)], [1, 1], 'chat.js: the only 85% left in the fit region is contextIssueFor, the composer guard against a single giant paste (the model hard window, not a history fit)');
  const handlerSrc = decomment(slice(sidecarSrc, 'async function handleProviderModels(', '\n}\n', 'handleProviderModels'));
  A.ok(/row\.compactAt = RUN_CONTEXT_DEFAULTS\.compactAt;/.test(handlerSrc), '/api/models publishes RUN_CONTEXT_DEFAULTS.compactAt itself');
  A.eq(count(handlerSrc, SHARE), 0, 'and holds no literal share');
  const wiring = decomment(slice(sidecarSrc, 'const turnWindow = TurnWindow.make(', ');\n', 'TurnWindow.make'));
  A.ok(/compactAt: RUN_CONTEXT_DEFAULTS\.compactAt/.test(wiring), 'index.js injects RUN_CONTEXT_DEFAULTS.compactAt into the station window');
  const fitSrc = read('frontend/app/historyfit.js'), windowSrc = read('sidecar/turn-window.js');
  A.ok(/uncalibratedBudget\(limit, d\.compactAt\)/.test(windowSrc), 'turn-window.js passes the injected share to the fallback budget');
  A.ok(!/Fit\.uncalibratedBudget\(limit\)/.test(windowSrc), 'and no longer asks for the former one');

  // ---- 7. teeth: each rule's source line, changed, is caught by the same table ----
  const mutantFit = (from, to, label) => compile('frontend/app/historyfit.js', mutate(fitSrc, from, to, label));
  const pageMutants = [
    ['the page ignores the published share', mutantFit('const share = foldShare(m.compactAt),', 'const share = 0,', 'ignore share')],
    ['the page ignores the run window (a price tier)', mutantFit('return run > 0 && run < limit ? run : limit;', 'return limit;', 'ignore tier')],
    ['the measured overhead is taken off twice (with the reserve)', mutantFit('* (share || LEGACY_FIT_SHARE)) - overhead);', '* (share || LEGACY_FIT_SHARE)) - overhead - Math.min(16000, Math.floor(windowFor(limit) / 2)));', 'double subtract')],
    ['the unmeasured budget ignores the share', mutantFit('(foldShare(compactAt) || LEGACY_FIT_SHARE)', 'LEGACY_FIT_SHARE', 'uncalibrated share')],
    ['the fit rounds the line up', mutantFit('Math.floor(windowFor(limit) * (share || LEGACY_FIT_SHARE)) - overhead', 'Math.ceil(windowFor(limit) * (share || LEGACY_FIT_SHARE) + 1) - overhead', 'round up')]
  ];
  for (const [label, Mutant] of pageMutants) A.ok(violations(Mutant, {}).bad.length > 0, 'caught: ' + label);
  const chatMutants = [
    ['chat.js stops asking the catalog for the share', mutate(chatFns, "if (Harness.compactAtOf) model.compactAt = Harness.compactAtOf(model.selected);", '', 'chat share')],
    ['chat.js stops handing over the run window', mutate(chatFns, 'model.runWindow = (Harness.runWindowOf && Harness.runWindowOf(model.selected)) || model.limit;', '', 'chat run window')]
  ];
  for (const [label, chat] of chatMutants) A.ok(violations(Fit, { chat }).bad.length > 0, 'caught: ' + label);
  const stationMutants = [
    ['the station fallback ignores the injected share', compile('sidecar/turn-window.js', mutate(windowSrc, 'Fit.uncalibratedBudget(limit, d.compactAt)', 'Fit.uncalibratedBudget(limit)', 'station share'))]
  ];
  for (const [label, Mutant] of stationMutants) A.ok(fallbackKept(Mutant, { compactAt: share }) !== pageUnmeasured.messages.length, 'caught: ' + label);

  A.report('context-budget.authority');
})().catch(error => { console.log('FAIL: context-budget.authority threw - ' + (error && error.stack || error)); process.exit(1); });
