'use strict';
const A = require('./_assert.js');
const crypto = require('crypto');
const { makeProviderReadiness } = require(process.env.READINESS_MODULE_CONTROL || '../sidecar/provider-readiness.js');
const { makeCache } = require('../frontend/app/provider-readiness.js');
const CS = require('../sidecar/credential-store.js');
let at = 1000, disk;
const deps = { now: () => at, digest: s => crypto.createHash('sha256').update(s).digest('hex'),
  load: () => disk, save: value => { disk = JSON.parse(JSON.stringify(value)); return true; } };
const store = makeProviderReadiness(deps);
const input = { id: 'openai', key: 'fixture-private-key', url: 'https://fixture.invalid/v1?token=private-endpoint', present: true, required: true, materialReady: true, endpointConfigured: true };
const sync = i => store.sync(i.id, i.key, i.url);
const note = (i, verdict, ticket) => store.note(i.id, i.key, i.url, verdict, ticket);
sync(input);
let row = store.project(input);
A.ok(row.configured && row.unattendedReady && row.credential.status === 'unverified' && row.lastVerified === null, 'complete unverified pair preserves routing policy');
const ticket = sync(input);
note(input, { credentialVerified: true, reachable: true }, ticket);
row = store.project(input);
A.ok(row.configured && row.credential.status === 'verified' && row.lastVerified === 1000, 'only authenticated adapter success stamps verification');
const candidate = { ...input, key: 'failed-candidate' };
note(candidate, { status: 'rejected', reachable: true, httpStatus: 401 });
A.eq(store.project(input).credential.status, 'verified', 'failed candidate leaves active key evidence intact');
note(input, { status: 'unreachable', reachable: false }, ticket);
A.ok(store.project(input).configured && store.project(input).lastVerified === 1000 && store.project(input).endpoint.status === 'unreachable', 'network failure preserves authentication proof and reports endpoint failure');
note(input, { status: 'rejected', reachable: true, httpStatus: 401 }, ticket);
A.ok(!store.project(input).configured && !store.accepted(input.id, input.key, input.url), 'known rejected pair cannot run');
const restart = makeProviderReadiness(deps);
restart.sync(input.id, input.key, input.url);
A.eq(restart.project(input).credential.status, 'rejected', 'rejection survives restart for exact pair');
A.ok(!JSON.stringify(disk).includes(input.key) && !JSON.stringify(disk).includes(input.url), 'durable evidence contains no raw credential or endpoint');
at = 2000;
note(candidate, { credentialVerified: true, reachable: true });
sync(candidate);
A.eq(store.project(candidate).lastVerified, 2000, 'verified candidate becomes current only once installed');
sync(input);
A.eq(store.project(input).lastVerified, null, 'rotating back does not resurrect previous proof');
A.eq(note(input, { credentialVerified: true }, ticket), false, 'late response to prior generation cannot stamp rotate-back');
const changedUrl = { ...input, url: 'https://other.invalid/v1' };
sync(changedUrl);
A.eq(store.project(changedUrl).lastVerified, null, 'endpoint change invalidates verification');
const missing = store.project({ ...input, present: false, materialReady: false });
const expired = store.project({ ...input, expired: true });
const local = store.project({ ...input, id: 'custom', key: '', required: false, present: false });
A.ok(!missing.configured && missing.credential.status === 'missing', 'missing key is not ready');
A.ok(!expired.configured && expired.credential.status === 'expired', 'expired sign-in cannot run');
A.ok(local.configured && local.credential.status === 'not-required' && local.lastVerified === null, 'keyless local endpoint does not invent proof');
const cache = makeCache();
A.eq(cache.read('openai').configured, false, 'before first sidecar reply browser cannot infer readiness');
A.ok(cache.accept([{ ...row, id: 'openai' }], cache.ticket()), 'browser adopts sidecar verdict');
cache.offline();
A.ok(cache.read('openai').configured && cache.read('openai').cached && cache.read('openai').lastVerified === 1000, 'offline retains clearly cached last answer');
const old = cache.ticket();
cache.invalidate('openai');
A.ok(!cache.read('openai').configured && cache.read('openai').lastVerified === null, 'local edit drops prior proof while station catches up');
A.eq(cache.accept([{ ...row, id: 'openai' }], old), false, 'old fetch cannot overwrite invalidation');
// The station's existing pool and endpoint policy is the readiness policy too. Every tuple keeps its
// own verdict, so a bad primary cannot block an authorized alternate or falsely verify it.
{
  const e = makeProviderReadiness({ now: () => at, digest: deps.digest });
  const c = require('./helpers/credential-store-sandbox.js').sandboxStore({ providerVerification: e,
    providerHasCredential: (id, key, url) => !!key && !!url && c.accepted(id, key, url) }, { store: CS });
  const url = 'http://pool.fixture/v1';
  c.push('openai', { key: 'primary', keyPool: ['alternate'], baseUrl: url });
  const reject = key => e.note(e.keySlot('openai', key), key, url, { status: 'rejected', reachable: true, httpStatus: 401 });
  reject('primary');
  A.ok(c.presence('openai').unattendedReady && c.accepted('openai', 'primary', url), 'rejected primary permits its eligible unverified station alternate');
  A.eq(e.evidence(e.keySlot('openai', 'primary'), 'primary', url).status, 'rejected', 'aggregate readiness never erases primary rejection');
  A.eq(c.readinessAlternates('openai', 'primary', url), { eligible: 1, verified: 0, unverified: 1, rejected: 0 }, 'alternate is explicitly unverified');
  A.eq(c.accepted('openai', 'primary', url, []), false, 'explicit caller key with no caller pool cannot borrow station alternatives');
  A.eq(c.readinessAlternates('openai', 'primary', 'http://foreign.fixture/v1').eligible, 0, 'station pool never rides a foreign endpoint');
  A.eq(e.evidence(e.keySlot('openai', 'primary'), 'primary', 'http://foreign.fixture/v1').status, 'unverified', 'rejection is bound to the checked endpoint');
  reject('alternate');
  A.ok(!c.presence('openai').unattendedReady && !c.accepted('openai', 'primary', url), 'all rejected tuples make station unready');
  c.push('openai', { keyPool: [] });
  A.eq(c.presence('openai').unattendedReady, false, 'missing pool cannot bypass rejected primary');
  c.push('openai', { keyPool: ['alternate'] });
  A.eq(c.readinessAlternates('openai', 'primary', url).unverified, 1, 'removed then re-added tuple has no resurrected proof');
  c.push('openai', { key: '', keyPool: ['alternate'] });
  A.eq(c.presence('openai').unattendedReady, false, 'orphan pool after primary removal does not become a new credential');
}
// A failed write/readback is a live rejection with an explicit durability failure, never a durable success.
{
  const core = require('./helpers/source').sidecarTopLevelFunction('runOnceCore');
  const start = core.indexOf('    const ordered = credPool.order(pool);');
  const end = core.indexOf('    rotationFallbacks = ordered.map', start);
  if (start < 0 || end < start) throw new Error('production credential pool selection missing');
  const select = new Function('rejected', 'until', 'pool', `
    const credPool = { order: p => p.slice(), coolingUntil: () => until };
    const credStore = { credentialAccepted: () => !rejected };
    const providerId = 'openai', runKey = 'primary', baseUrl = '', reasoningEffort = '';
    const runKeyWatch = { sentByCaller: false }, runWatch = { watch: p => p };
    const selectProvider = p => p, providerCredentialError = () => 'credential rejected';
    let activePrimaryKey = runKey, provider, auxVisionProvider, studioModelProvider;
    ${core.slice(start, end)}
    return { activePrimaryKey, ordered };
  `);
  A.eq(select(true, Date.now() + 60000, ['alternate']), { activePrimaryKey: 'alternate', ordered: [] },
    'known rejected primary never opens even when every eligible alternate is cooling');
  A.eq(select(false, Date.now() + 60000, ['alternate']).activePrimaryKey, 'primary',
    'ordinary all-cooling policy is unchanged for a credential without rejection evidence');
  let refused = false; try { select(true, 0, []); } catch (e) { refused = /credential rejected/.test(e.message); }
  A.ok(refused, 'a queued run whose last eligible alternate disappeared refuses the rejected primary');
}
// A failed write/readback is a live rejection with an explicit durability failure, never a durable success.
for (const lands of [false, true]) {
  let saved, fail = false, writes = 0;
  const d = { ...deps, load: () => saved, save: value => {
    writes++;
    if (!fail || lands) saved = JSON.parse(JSON.stringify(value));
    return !fail;
  } };
  const s = makeProviderReadiness(d);
  s.sync(input.id, input.key, input.url);
  s.note(input.id, input.key, input.url, { credentialVerified: true, reachable: true });
  fail = true;
  A.eq(s.note(input.id, input.key, input.url, { status: 'rejected', reachable: true, httpStatus: 401 }), false, 'failed write/readback is not acknowledged');
  const unproven = s.project(input);
  A.ok(!unproven.configured && !unproven.persisted && unproven.persistenceError, 'live rejection is kept and durability failure disclosed');
  const before = writes;
  s.sync(input.id, input.key, input.url);
  A.ok(writes > before && !s.project(input).persisted, 'unchanged read retries a dirty write');
  const interrupted = makeProviderReadiness(d);
  interrupted.sync(input.id, input.key, input.url);
  A.eq(interrupted.project(input).credential.status, lands ? 'rejected' : 'verified', 'restart can recover only bytes that actually landed; failed-before-write limitation is explicit');
  fail = false;
  s.sync(input.id, input.key, input.url);
  A.ok(s.project(input).persisted && !s.project(input).configured, 'successful unchanged retry proves current rejection');
  const restarted = makeProviderReadiness(d);
  restarted.sync(input.id, input.key, input.url);
  A.eq(restarted.project(input).credential.status, 'rejected', 'after verified retry rejection survives restart');
}
{
  let saved, throws = false;
  const d = { ...deps, load: () => saved, save: value => {
    if (throws) throw new Error('fixture storage unavailable');
    saved = JSON.parse(JSON.stringify(value));
    return true;
  } };
  const s = makeProviderReadiness(d);
  s.sync(input.id, input.key, input.url);
  s.note(input.id, input.key, input.url, { credentialVerified: true });
  throws = true;
  let reply;
  try { reply = s.note(input.id, input.key, input.url, { status: 'rejected' }); } catch (_) { reply = 'threw'; }
  A.eq(reply, false, 'a throwing persistence sink reports unproven evidence without throwing away the verdict');
  A.ok(!s.project(input).persisted && !s.project(input).configured, 'a thrown save preserves the rejected live row and visible dirty state');
  throws = false;
  s.sync(input.id, input.key, input.url);
  const restarted = makeProviderReadiness(d);
  restarted.sync(input.id, input.key, input.url);
  A.eq(restarted.project(input).credential.status, 'rejected', 'unchanged retry after a thrown save durably preserves rejection');
}
async function browserRefresh() {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/harness.js'), 'utf8');
  const fn = require('./helpers/source').functionSourceIn(src, 'refreshProviderReadiness');
  const browser = makeCache();
  browser.accept([{ ...row, id: 'openai' }], browser.ticket());
  let deadline, cleared = 0, calls = 0;
  const refresh = new Function('readinessCache', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
    'let readinessFlight = null;\n' + fn + '\nreturn refreshProviderReadiness;')(browser,
    async (url, opts) => {
      calls++;
      A.eq(url, '/api/providers', 'browser reads the common sidecar verdict');
      if (calls === 1) return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('fixture deadline'))));
      return { ok: true, json: async () => ({ providers: [{ ...row, id: 'openai', configured: false, unattendedReady: false }] }) };
    }, AbortController, fn => { deadline = fn; return 1; }, () => { cleared++; });
  const pending = refresh();
  A.eq(refresh(), pending, 'concurrent status readers share one request');
  deadline();
  await pending;
  A.ok(browser.read('openai').cached && browser.read('openai').configured, 'bounded failed status read keeps the last answer explicitly cached');
  await refresh();
  A.ok(!browser.read('openai').cached && !browser.read('openai').configured && cleared === 2, 'next successful read replaces cached state and clears both timers');
  {
    const racing = makeCache();
    racing.accept([{ ...row, id: 'openai' }], racing.ticket());
    let finishWrite, finishOldGet, gets = 0;
    const pool = process.env.READINESS_POOL_CONTROL ? require('fs').readFileSync(process.env.READINESS_POOL_CONTROL, 'utf8') :
      require('./helpers/source').functionSourceIn(src, 'setKeyPool');
    const mutation = new Function('readinessCache', 'fetch', 'syncEngineKey', 'AbortController', 'setTimeout', 'clearTimeout', `
      let readinessFlight = null;
      const DESKTOP = false, LS = { keyPool: 'pool' }, normalizeProviderId = p => p, getProv = () => 'openai', writeScoped = () => {};
      ${fn}\n${pool}\nreturn { setKeyPool, refreshProviderReadiness };
    `)(racing, async () => {
      if (++gets === 1) return new Promise(resolve => { finishOldGet = resolve; });
      return { ok: true, json: async () => ({ providers: [{ ...row, id: 'openai', configured: false, unattendedReady: false, lastVerified: null }] }) };
    }, () => new Promise(resolve => { finishWrite = resolve; }), AbortController, setTimeout, clearTimeout);
    const saved = mutation.setKeyPool(['new-pool'], 'openai');
    const oldGet = mutation.refreshProviderReadiness();
    finishWrite({ ok: true });
    await Promise.resolve(); await Promise.resolve();
    finishOldGet({ ok: true, json: async () => ({ providers: [{ ...row, id: 'openai' }] }) });
    await Promise.all([saved, oldGet]);
    A.eq(gets, 2, 'a GET captured before station write completion must be replaced by a post-write read');
    A.ok(!racing.read('openai').configured && racing.read('openai').lastVerified === null && !racing.read('openai').cached,
      'delayed pre-write GET cannot restore the old tuple verification as fresh');
  }
  // A headless readiness read itself starts the bounded local status path; no Settings visit or real
  // CLI is involved. Compile the production functions and inject only the login driver's result.
  const host = require('./helpers/source').readSidecarSource();
  let answer, lookups = 0, clock = 100000;
  const cliRows = new Map(), cliPending = new Map();
  const cliApi = new Function('accountAuthSeen', 'accountAuthPending', 'claudeCliLogin', 'providerAccounts', 'providerVerification', 'getProviderProfile', 'Date',
    ['noteAccountAuth', 'refreshClaudeCliAccountAuth', 'providerReadiness'].map(n => require('./helpers/source').functionSourceIn(host, n)).join('\n') +
    '\nreturn { read: () => providerReadiness("claude-cli"), refresh: () => refreshClaudeCliAccountAuth("") };')(
      cliRows, cliPending, () => ({ status: () => { lookups++; return new Promise(resolve => { answer = resolve; }); } }),
      { list: () => [] }, store, () => ({ id: 'claude-cli' }), { now: () => clock });
  let cliRow = cliApi.read();
  A.ok(!cliRow.configured && cliRow.credential.status === 'unknown' && /checking/.test(cliRow.reason), 'fresh headless CLI state is explicitly pending');
  const checking = cliApi.refresh();
  await Promise.resolve();
  A.eq(lookups, 1, 'headless read starts exactly one local status lookup');
  answer({ installed: true, loggedIn: true }); await checking;
  cliRow = cliApi.read();
  A.ok(cliRow.configured && cliRow.credential.present && cliRow.credential.status === 'unverified' && cliRow.lastVerified === null,
    'local signed-in result enables headless work without inventing remote verification');
  clock += 61000;
  const failing = cliApi.refresh(); await Promise.resolve();
  answer({ installed: true, loggedIn: false, error: 'fixture timeout', code: '' }); await failing;
  cliRow = cliApi.read();
  A.ok(cliRow.configured && cliRow.credential.status === 'unavailable' && /cached/.test(cliRow.reason), 'status failure preserves the last signed-in fact and is not credential rejection');
  clock += 11000;
  const signedOut = cliApi.refresh(); await Promise.resolve();
  answer({ installed: true, loggedIn: false, error: 'signed out', code: 'provider_not_configured' }); await signedOut;
  A.ok(!cliApi.read().configured && cliApi.read().credential.status === 'missing', 'known local signed-out status is unready');
  clock += 61000;
  const absent = cliApi.refresh(); await Promise.resolve();
  answer({ installed: false, loggedIn: false }); await absent;
  A.ok(!cliApi.read().configured && /not installed/.test(cliApi.read().reason), 'known missing CLI is unready and named honestly');
  A.report('provider readiness evidence and browser cache');
}
browserRefresh().catch(e => { console.error(e); process.exitCode = 1; });
