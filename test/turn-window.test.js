'use strict';
const A = require('./_assert.js');
const { readSidecarSource } = require('./helpers/source.js');
const vm = require('node:vm');
const Window = require('../sidecar/turn-window.js');
const Fit = require('../frontend/app/historyfit.js');
const Store = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const Dual = require('../sidecar/turn-dual.js');
const View = require('../sidecar/turn-view.js');
const T = 'window_current_0001', OLD = 'window_older_0001';
let mode = 'shadow';
const notes = [], records = [], identities = [];
const dual = Dual.make({ now: () => 1000000, hash: x => x, env: key => key === 'STARNET_TURNID_WINDOW' ? mode : undefined });
const recordOwner = dual.record; dual.record = (surface, event) => { records.push({ surface, event }); recordOwner(surface, event); };
const store = Store.makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => 1000000 }, pick: (...args) => dual.pick(...args) });
const first = store.appendStrict({ streamId: 's', agentId: 'a', role: 'user', content: 'OLD_OWNER', turnId: OLD, directive: true });
store.appendStrict({ streamId: 's', agentId: 'a', role: 'assistant', content: 'OLD_ANSWER', turnId: OLD });
store.appendStrict({ streamId: 's', agentId: 'a', role: 'user', content: 'HIDDEN_CAPTURE', kind: 'capture' });
const newest = { role: 'user', content: 'NEW_OWNER', turnId: T, turnAt: 1000000, attachments: [{ id: 'att-fixture', name: 'note.txt', mime: 'text/plain' }] };
const posted = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'PAGE_ONLY_OLD' }, newest];
const o = { streamId: 's', agentId: 'a', turnId: T, windowTokens: 10000, windowCaller: 'desk', clientClock: { clientNow: 1000000, at: 1000000 } };
const ctx = { agentId: 'a', runId: 'run-window-test', directive: { turnId: T } };
let limitCalls = 0;
const make = source => Window.make({ transcriptStore: source || store, turnDual: dual, failNote: tag => notes.push(tag),
  limitOf: () => { limitCalls++; return 128000; }, noteIdentity: (run, value) => identities.push({ run, value }) });
const window = make();
A.eq(Window.callerOf({ turnId: T, windowTokens: 10, windowCaller: 'phone' }), 'desk', 'caller is derived from valid client window metadata');
for (const body of [{ windowCaller: 'desk' }, { turnId: T }, { turnId: T, windowTokens: Infinity }, { turnId: 'bad', windowFrom: 'station' }]) A.eq(Window.callerOf(body), undefined, 'caller-controlled labels/invalid IDs cannot opt into prose');
A.eq(Window.callerOf({ turnId: T, windowFrom: 'station' }), 'desk', 'required station window opts in with a valid modern turn');
for (const field of ['internal', 'outputOnly', 'recovery', 'groupTools', 'lineHop', 'parentRunId']) {
  const before = records.length;
  A.eq(window.apply(posted, Object.assign({}, o, { [field]: true }), ctx), posted, field + ' keeps provider-valid caller history');
  A.eq(records.length, before, field + ' writes no window comparison');
}
A.eq(window.apply(posted, Object.assign({}, o, { resumeSeed: false }), ctx), posted, 'resumeSeed false is ineligible');
const beforeNull = records.length;
A.eq(window.apply(posted, o, { directive: null }), posted, 'null capture is ineligible');
A.eq(records.length, beforeNull, 'null capture writes no comparison');
A.eq(window.apply(posted, o, ctx), posted, 'shadow returns the exact posted array');
A.eq(limitCalls, 0, 'page calibrated budget needs no cached lookup');
mode = 'id';
const canonical = window.apply(posted, o, ctx);
A.eq(canonical.map(m => m.content), ['SYSTEM', 'OLD_OWNER', 'OLD_ANSWER', 'NEW_OWNER'], 'ID window uses canonical prose plus actual current input');
A.eq(canonical.at(-1), newest, 'current attachments remain intact before expansion');
A.ok(!canonical.some(m => /HIDDEN_CAPTURE|PAGE_ONLY_OLD/.test(m.content)), 'non-replay kinds and stale posted history are excluded');
A.eq(identities.at(-1).value.windowRowIds.count, 2, 'run identity records actual canonical row count');
A.eq(canonical[View.ROW_IDS].filter(Boolean).map(r => r.rowId), [1, 2], 'canonical row provenance stays aligned through fit/system concatenation');
const branch = [{ role: 'user', content: 'BRANCH_SOURCE', streamId: 'other', rowId: 40 }, newest];
A.eq(window.apply(branch, o, ctx), branch, 'foreign branch rows retain the posted page window even in ID mode');
A.ok(records.at(-1).event.counts.foreign > 0, 'foreign fallback is diagnosed rather than claimed canonical');
window.apply(posted, Object.assign({}, o, { windowTokens: undefined }), ctx);
A.eq(limitCalls, 1, 'missing calibrated budget asks only injected cached facts');
mode = 'shadow';
A.eq(window.apply([newest], Object.assign({}, o, { windowFrom: 'station' }), ctx).map(m => m.content), ['OLD_OWNER', 'OLD_ANSWER', 'NEW_OWNER'], 'degraded shadow send receives canonical history');
const bad = make(Object.assign({}, store, { view() { throw Error('unreadable disk'); } }));
A.eq(bad.vouched('s'), false, 'required preflight refuses unreadable canonical history');
A.eq(window.vouched('bad stream'), false, 'invalid stream cannot silently become global authority');
let refused;
try { bad.apply([newest], Object.assign({}, o, { windowFrom: 'station' }), ctx); } catch (error) { refused = error; }
A.eq(refused && refused.code, 'HISTORY_UNAVAILABLE', 'newest-only request never silently falls back');
A.eq(bad.apply(posted, Object.assign({}, o, { windowFrom: 'station' }), ctx), posted, 'full-window page retains explicit compatibility fallback');
mode = 'legacy';
const beforeLegacy = records.length;
A.eq(bad.apply([newest], Object.assign({}, o, { windowFrom: 'station' }), ctx), [newest], 'legacy leaves strict required H1.2 seed to its existing host owner');
A.eq(records.length, beforeLegacy, 'legacy apply writes no comparison');
const reads = [];
const re = make({ view: (...args) => { reads.push(args); return ['pairs']; } });
A.eq(re.reseed({ streamId: 's' }), ['pairs'], 'queued reseed delegates to Store');
re.reseed({ streamId: 's', coordinatedSession: true, parentRunId: 'parent' });
A.eq(reads.map(args => args[2]), [{ limit: 100, shape: 'pairs', form: 'pre' }, { limit: 80, shape: 'pairs', form: 'pre' }], 'queued and coordinated callers preserve their exact pairs limits');

// Carry is forced-ID-only and each candidate is proven absent by the Store's one batch owner.
const pending = { role: 'user', content: 'UNADMITTED_TYPED', turnId: 'window_pending_0001', turnAt: 999999, taint: 'page-claimed source', taintKnown: false };
mode = 'shadow'; window.apply([pending, newest], o, ctx);
A.eq(store.all().some(r => r.turnId === pending.turnId), false, 'default shadow never carries a page-only turn');
mode = 'id'; const carried = window.apply([pending, newest], o, ctx);
const durableCarry = store.all().filter(r => r.turnId === pending.turnId);
A.eq(durableCarry.length, 1, 'ID writes a proven-absent pending turn once');
A.eq([durableCarry[0].kind, durableCarry[0].directive, durableCarry[0].carriedBy, durableCarry[0].sourceRunId], ['turn', true, ctx.runId, undefined], 'carried row cannot masquerade as this run directive');
A.eq([durableCarry[0].taintKnown, Store.rowTaint(durableCarry[0])], [true, null], 'proved unadmitted typed input follows the host clean-input rule, ignoring page provenance claims');
A.eq(store.taintOf('s', [{ role: 'user', content: pending.content }]), null, 'carrying ordinary typed words does not invent a replay taint');
A.eq(store.view('owner-evidence', 's'), [], 'clean typed provenance does not mint a real run or owner-directive evidence');
A.ok(carried.some(r => r.content === pending.content), 'carried words reach the chosen window');
window.apply([pending, newest], o, ctx);
A.eq(store.all().filter(r => r.turnId === pending.turnId).length, 1, 'resend does not duplicate a carried directive');
const quoted = { role: 'user', content: '> a quoted log is still typed input', turnId: 'window_quoted_0001', turnAt: 999999, taint: 'forged' };
window.apply([quoted, newest], o, ctx);
A.eq(Store.rowTaint(store.all().find(r => r.turnId === quoted.turnId)), null, 'quoted typed input retains the existing host rule');
const attached = { role: 'user', content: 'READ_ATTACHMENT', turnId: 'window_attached_0001', turnAt: 999999,
  attachments: [{ id: 'attachment-ref', name: 'note.txt', path: '.attachments/attachment-ref.txt', mediaType: 'text/plain', kind: 'file' }, { id: 'elsewhere', name: 'elsewhere.txt', path: '../outside/elsewhere.txt' }], taint: 'forged', taintKnown: true };
window.apply([attached, newest], o, ctx);
const attachedRow = store.all().find(r => r.turnId === attached.turnId && r.directive === true);
// (attachment rows, S3) a carried turn is written like a new one: the directive holds the Commander's typed words, CLEAN whatever
// provenance the page claimed, and each file it carried is an attachment row beside it. Taint follows the bytes a run re-sends
// (attachments.resentOf), so the mere presence of a reference stamps nothing on the words.
A.eq([attachedRow.taintKnown, Store.rowTaint(attachedRow), attachedRow.sourceRunId, attachedRow.content, attachedRow.attachments.map(a => a.id)], [true, null, undefined, 'READ_ATTACHMENT', ['attachment-ref']], 'a carried directive with files is written clean, never borrows the current run, and keeps its saved references');
const carriedFiles = store.all().filter(r => r.turnId === attached.turnId && r.kind === 'attachment');
A.eq(carriedFiles.length, 1, 'one attachment row for the one saved reference (a path outside .attachments/ names no attachment)');
A.eq([carriedFiles[0].role, carriedFiles[0].content, carriedFiles[0].taint, carriedFiles[0].sourceRunId, carriedFiles[0].attachment], ['system', '[attached: note.txt]', 'user attachment', ctx.runId, { id: 'attachment-ref', name: 'note.txt', mime: 'text/plain', path: '.attachments/attachment-ref.txt' }],
  'the carried file is a system row stamped with the attachment source and this run, without size or sha256 (no read happened)');
A.ok(carriedFiles[0].rowId > attachedRow.rowId, 'and it follows its directive');
window.apply([attached, newest], o, ctx);
A.eq(store.all().filter(r => r.turnId === attached.turnId).length, 2, 'a resend duplicates neither the carried directive nor its attachment row');
A.ok(!store.view('display', 's').some(r => r.kind === 'attachment') && !JSON.stringify(store.view('model-replay', 's', { shape: 'pairs' })).includes('[attached:'), 'the attachment row is neither shown nor replayed');
// (attachment decay) the bare attachment stamp is the one stamp that does not taint a replay: the bytes it stood for are re-sent
// (and latched by the run that re-sends them, attachments.resentOf) or gone, so a carried attachment turn replays clean
A.eq(store.taintOf('s', [{ role: 'user', content: attached.content }]), null, 'a carried attachment turn replays clean: the directive is clean and the bare attachment stamp decays');
store.appendStrict({ streamId: 's', role: 'assistant', content: 'PRIOR_FETCHED_TEXT', taint: 'web source' });
window.apply([{ role: 'user', content: 'AFTER_FETCH_TYPED', turnId: 'window_after_fetch_0001', turnAt: 999999 }, newest], o, ctx);
A.eq(store.taintOf('s', [{ role: 'assistant', content: 'PRIOR_FETCHED_TEXT' }]), 'web source', 'carrying typed words never clears prior outside-content provenance');
const excess = Array.from({ length: 9 }, (_, n) => ({ role: 'user', content: 'CARRY_LIMIT_' + n, turnId: 'window_excess_00' + n, turnAt: 999999 }));
const excessPost = excess.concat(newest);
A.eq(window.apply(excessPost, o, ctx), excessPost, 'over-eight carry keeps full posted history');
A.eq(store.all().filter(r => r.content.startsWith('CARRY_LIMIT_')).length, 0, 'over-limit batch performs no partial mutation');
const bigPost = [{ role: 'user', content: 'x'.repeat(65537), turnId: 'window_large_0001', turnAt: 999999 }, newest];
A.eq(window.apply(bigPost, o, ctx), bigPost, 'over-64KiB carry retains the full posted window');
A.eq(store.all().some(r => r.turnId === 'window_large_0001'), false, 'over-byte-limit carry performs no mutation');
for (const change of [{ turnAt: undefined }, { foreign: true }, { stopped: true }, { streamId: 'other' }]) {
  const row = Object.assign({}, pending, { turnId: 'window_never_' + Object.keys(change)[0] }, change);
  window.apply([row, newest], o, ctx);
  A.eq(store.all().some(r => r.turnId === row.turnId), false, 'unproven/local/foreign candidate is not carried');
}
const retry = window.apply(posted, o, Object.assign({}, ctx, { reused: { directive: first } }));
A.eq(retry.map(m => m.content), ['SYSTEM', 'NEW_OWNER'], 'proved retry cuts at the original directive, not at recent text');

// Exercise the actual host's cached-only resolver with the real shared catalog TTL, no adapters/network.
const source = readSidecarSource();
const resolver = A.fnBody(source, 'function turnWindowLimitOf(');
const { makeCatalogCache } = require('../sidecar/providers/catalog-cache.js');
let now = 1, selected = { provider: 'openai', model: 'known' }, seenKeys = [], seenEndpoints = [];
const cache = makeCatalogCache({ clock: { now: () => now } });
cache.noteWindows('https://station.test/v1', [{ id: 'known', context_length: 100000 }]);
cache.noteWindows('https://caller.test/v1', [{ id: 'known', context_length: 200000 }]);
let profile = { unmetered: true }, creditsConfigured = false;
const getProviderProfile = () => profile;
const billing = require('../sidecar/billing-class.js').makeBilling({ profileOf: getProviderProfile, creditsConfigured: () => creditsConfigured, creditsUrl: 'https://credits.test' });
const sandbox = { runWireOfRun: () => selected, normalizeProvider: x => x, getProviderProfile, billing,
  chatModelId: (_p, m) => m, providerUsesCodex: () => false, CODEX_DEFAULT_MODEL: 'codex-default', CRON_DEFAULT_MODEL: 'known',
  providerRuntimeKey: (_p, key) => { seenKeys.push(key); return key || 'station-key'; },
  providerRuntimeBaseUrl: (_p, endpoint, key, caller, inRequest) => { seenEndpoints.push([endpoint, key, caller, inRequest]); return inRequest && caller && endpoint || 'https://station.test/v1'; },
  modelCatalogCache: cache, promptTierCeiling: require('../sidecar/providers/prices.js').promptTierCeiling };
vm.createContext(sandbox); vm.runInContext(resolver + ';this.read = turnWindowLimitOf;', sandbox);
A.eq(sandbox.read({ agentId: 'follows' }), 100000, 'station pair reads its own endpoint facts');
selected = { provider: 'openai', model: 'known', source: 'agent' };
A.eq(sandbox.read({ agentId: 'pinned' }), 100000, 'agent-resolved pair reads its own endpoint facts');
A.eq(sandbox.read({ provider: 'openai', key: 'caller-key', baseUrl: 'https://caller.test/v1', keyInRequest: true }), 200000, 'explicit same-provider request owns its endpoint facts');
A.eq(sandbox.read({ provider: 'wrong', key: 'foreign-key', baseUrl: 'https://caller.test/v1', keyInRequest: true }), 100000, 'passed-over provider cannot select another endpoint facts');
A.eq(seenEndpoints.at(-1), ['', 'station-key', '', false], 'provider mismatch carries no key, endpoint, or request ownership');
selected = { provider: 'openai', model: 'unknown' }; A.eq(sandbox.read({}), 0, 'unknown model stays unknown');
selected = { provider: 'openai', model: 'known' }; now += cache.ttlMs;
A.eq(sandbox.read({}), 0, 'expired cached fact stays unknown without refresh');
A.ok(!/selectProvider|catalogRunWindow|fetch\(|ensure.*Token/.test(resolver), 'resolver starts no adapter, catalog wait, network, or auth refresh');
A.eq(Fit.uncalibratedBudget(128000), 92800, 'station fallback uses the shared page budget rule');
// Also drive the actual host pair resolver, not just its already-resolved input seam.
now = 1;
sandbox.RunWire = require('../sidecar/run-wire.js');
sandbox.agentRoster = new Map([['agent', { provider: 'openai', model: 'known' }], ['pinned', { provider: 'openai', model: 'pinned-model' }]]);
sandbox.normalizeProviderId = provider => ['openai', 'openrouter'].includes(provider) ? provider : '';
sandbox.runWireEnv = () => ({ provider: 'openrouter', model: 'env-model' });
cache.noteWindows('https://station.test/v1', [{ id: 'known', context_length: 100000 }, { id: 'pinned-model', context_length: 110000 }]);
vm.runInContext(A.fnBody(source, 'function runWireFor(') + '\n' + A.fnBody(source, 'function runWireOfRun('), sandbox);
A.eq(sandbox.read({ agentId: 'follows' }), 100000, 'actual run wire resolves the station default before cached lookup');
A.eq(sandbox.read({ agentId: 'pinned' }), 110000, 'actual run wire resolves the agent model before cached lookup');
A.eq(sandbox.read({ agentId: 'pinned', provider: 'openai', model: 'known', key: 'caller-key', baseUrl: 'https://caller.test/v1', keyInRequest: true }), 200000, 'actual explicit pair and owned endpoint select their cached fact');
A.eq(sandbox.read({ agentId: 'follows', provider: 'wrong', model: 'known', key: 'foreign-key', baseUrl: 'https://caller.test/v1', keyInRequest: true }), 0, 'actual unknown explicit provider cannot borrow a valid cached limit');
A.eq(sandbox.read({ agentId: 'follows', provider: 'openrouter', key: 'foreign-key', baseUrl: 'https://caller.test/v1', keyInRequest: true }), 100000, 'provider-only passed-over level uses the station pair and endpoint');
A.eq(seenEndpoints.at(-1), ['', 'station-key', '', false], 'actual passed-over provider lends no endpoint or credential authority');
// The cached resolver obeys the shared billing policy for each payer without admission or catalog refresh.
cache.noteWindows('https://station.test/v1', [{ id: 'gemini-2.5-pro', context_length: 1000000 }]);
for (const payer of [
  { name: 'metered', profile: { unmetered: false }, credits: false, limit: 200000 },
  { name: 'managed', profile: { unmetered: false }, credits: true, limit: 200000 },
  { name: 'subscription', profile: { unmetered: true, authType: 'oauth' }, credits: false, limit: 1000000 },
  { name: 'local', profile: { unmetered: true, authType: 'none' }, credits: false, limit: 1000000 }
]) {
  profile = payer.profile; creditsConfigured = payer.credits;
  A.eq(billing.classOf('openai'), payer.name, payer.name + ': fixture exercises the real billing class');
  A.eq(sandbox.read({ provider: 'openai', model: 'gemini-2.5-pro' }), payer.limit, payer.name + ': cached context limit follows the shared prompt-tier policy');
}
profile = null;
A.eq(sandbox.read({ provider: 'openai', model: 'gemini-2.5-pro' }), 0, 'missing profile cannot borrow a cached context limit');
A.report('turn-window');
