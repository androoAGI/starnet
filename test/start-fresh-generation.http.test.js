/* node test/start-fresh-generation.http.test.js — START FRESH sets aside the whole generation, through the real sidecar.

   The gate's START FRESH used to move only the files a name regex matched, inside the running sidecar, so the "fresh"
   station went on holding the old jail, chats, bot configs, checkpoints, line state and more, and its marker dropped an
   ERASE's authority. Now POST /api/lineage/start-fresh leaves a request, the sidecar exits 75 through the graceful path, and
   the next boot sets the whole generation aside before anything opens it.

   One real sidecar (SidecarFixture: hermetic profile, providers on a dead loopback) on one generation shaped like a real
   0.14.x station with its ERASE still on record, pressed five times:
     STALE   a save that came back, then a build that changed, each refuse the request: nothing moves, the request is kept as
             .failed-<stamp>, and lineage.lastFresh says why.
     HELD    a generation that cannot be renamed stays intact. On Windows a child process really holds a folder in it (any open
             handle refuses the rename); elsewhere the quarantine shelf is blocked. lastFresh names the error.
     WHOLE   the holder gone, the press works. Everything that was live sits byte-identical in one
             workspace-quarantine/station-<stamp>; no file of the old generation is left live but the account link
             (CARRY_ON_FRESH); the mirror is the native ERASE marker, field for field; onboarding is allowed.
     CARRY   an account link that cannot be read stays with the set-aside generation, the clean one starts unlinked, and
             lastFresh says so. The reset is never refused over it.
     SEED    across all of it a copy from before the reset is refused, and the station founded next is the station.
   test/start-fresh-generation.test.js holds the exact listing, the rollback and every guard and carry row;
   test/start-fresh-browser.e2e.test.js holds the live station browser. */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { meaningfulEntries } = require('../sidecar/station-record.js');
const cases = require('./fixtures/station-record-cases.json');

const ENV = {
  STARNET_DEV: '0', SKYNET_DEV: '0', SKYNET_QUEST_REFRESH: '0', STARNET_QUEST_REFRESH: '0',
  STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0', STARNET_LOOP_ENABLED: '0', SKYNET_LOOP_ENABLED: '0',
  SKYNET_LIVE_PRICES: '0', STARNET_LIVE_PRICES: '0', STARNET_EDGE_TTS: '0', SKYNET_EDGE_TTS: '0',
  STARNET_CLOUD_URL: 'http://127.0.0.1:1', STARNET_CREDITS_URL: 'http://127.0.0.1:1', STARNET_DESKTOP_SHELL: '0',
  SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:1', STARNET_OPENROUTER_BASE: 'http://127.0.0.1:1',
  OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: '',
  STARNET_APP_VERSION: '0.15.0-gate', SKYNET_APP_VERSION: ''
};
const LINK = cases.carryOnFresh.files[0];
const LINK_BYTES = '{"url":"https://credits.example","accountId":"acct-7","linkedAt":7}';
// the file-name inventory of a real 0.14.x station, with synthetic bytes (.secrets/credits.json is the one that may ride along)
const LAYOUT = ['agent/report.md', 'agent/downloads/receipt.pdf', 'channels/telegram.json', '.checkpoints/a/b.json', 'transcript-history-v2/old-chat.jsonl', '.run-journal/old-run.json',
  '.spend-pending/p1.json', 'line-jobs.json', 'line-spend.json', 'verdict.packets.json', 'skill-evaluations.json', 'skill.nudge.json', '_away.briefing.json',
  'voice-cache/old-voice.bin', '.browser-profile/Default/Cookies', 'codex/tokens.json', '.secrets/provider-keys.json', 'ledger.jsonl', 'agent.roster.json'];

function write(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)); }
function tree(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.starnet-workspace-owner.json.generations') continue;   // the claims' ticket trail, never station state
      const r = rel ? rel + '/' + entry.name : entry.name, abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs, r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })(dir, '');
  return out;
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } };
function exited(child, ms) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error('the sidecar did not exit')), ms);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
function doc(name, createdAt, rev, updatedAt, client) {
  return { schema: 'starnet.save', version: 6, updatedAt, _saveRevision: rev, _saveDirty: true, _saveClient: client,
    agent: { id: 'agent', name, createdAt }, agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' };
}

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-fresh-http-', timeoutMs: 30000, env: ENV });
  const root = fixture.workspace;
  fixture.workspace = path.join(root, 'workspaces');   // its own parent: the set-aside generation and the request live beside it
  const ws = fixture.workspace, shelf = path.join(root, cases.quarantineDir), requestFile = ws + '.fresh-request.json';
  fs.mkdirSync(ws);
  let holder = null;
  const lineageOf = async () => (await fixture.json('GET', '/api/lineage')).body.lineage;
  const lastOf = line => (line && line.lastFresh) || {};
  const failedRequests = () => fs.readdirSync(root).filter(n => /\.fresh-request\.json\.failed-\d{17}$/.test(n)).length;
  const stages = () => fs.readdirSync(root).filter(n => /fresh-stage/.test(n));
  // the route, then the exit: 202 through the real route, then 75 through the graceful path
  async function press(what) {
    const child = fixture.child;
    const r = await fixture.json('POST', '/api/lineage/start-fresh', {});
    A.eq([r.status, r.body && r.body.ok], [202, true], what + ': POST /api/lineage/start-fresh answers 202 (' + r.text + ')');
    A.eq(await exited(child, 15000), 75, what + ': the sidecar exits with the guardian restart code');
    A.ok(fixture.output().includes('shutdown (start-fresh)'), what + ': through the graceful path, its children reaped');
    return r.body || {};
  }
  try {
    const legacy = path.join(fixture.profile, 'StarNet', 'workspaces');
    const eraseAt = Date.UTC(2026, 9, 1, 12, 0, 0);
    for (const rel of LAYOUT) write(path.join(ws, ...rel.split('/')), 'bytes of ' + rel);
    write(path.join(ws, ...LINK.split('/')), LINK_BYTES);
    write(path.join(ws, '.migrated'), '1');
    write(path.join(ws, cases.freshMarker), JSON.stringify({ version: 1, erased: true, at: String(eraseAt), acknowledgedRoots: [legacy], quarantine: null, moved: [] }, null, 2));
    await fixture.start();
    const gated = await lineageOf();
    A.eq([gated.onboardingAllowed, gated.station && gated.station.state], [false, 'active'], 'fixture: the gate is up on a real-shaped generation (' + JSON.stringify(gated.station) + ')');

    /* ---- STALE: a save came back while the request waited (a hand restore, an older build onboarding) ---- */
    const first = await press('STALE save');
    A.eq(first.restartRequired, true, 'the route takes a request');
    A.ok(fs.existsSync(path.join(ws, 'agent', 'report.md')), 'and moves nothing while a sidecar could hold the generation');
    A.ok(fs.existsSync(requestFile), 'the request waits beside the workspace');
    write(path.join(ws, 'agent.save.json'), { version: 1, agentId: 'agent', updatedAt: 5, savedAt: 5, requestUpdatedAt: 5, revision: 1, client: 'c', doc: doc('CAME-BACK', 5, 1, 5, 'c') });
    await fixture.restart();
    let line = await lineageOf();
    A.eq([lastOf(line).ok, lastOf(line).code], [false, 'FRESH_REQUEST_STATION_FILES_CHANGED'], 'STALE: a save that came back refuses the request (' + JSON.stringify(line.lastFresh) + ')');
    A.ok(/agent\.save\.json/.test(String(lastOf(line).error)), 'STALE: and lastFresh says which file');
    A.ok(Number(lastOf(line).at) >= Number(first.requestedAt), 'STALE: newer than the request, which is what stops the gate\'s poll');
    A.eq(((readJson(path.join(ws, 'agent.save.json')).doc || {}).agent || {}).name, 'CAME-BACK', 'STALE: the save is untouched');
    A.eq(fs.existsSync(shelf), false, 'STALE: nothing was set aside');
    A.eq(failedRequests(), 1, 'STALE: the request is kept as .failed-<stamp>');
    A.eq(fs.existsSync(requestFile), false, 'STALE: and cannot run again by itself');

    /* ---- STALE: another build boots: index.js wires the build version to both ends ---- */
    await press('STALE build');
    fixture.env.STARNET_APP_VERSION = '0.15.1-gate';
    await fixture.restart();
    line = await lineageOf();
    A.eq([lastOf(line).ok, lastOf(line).code], [false, 'FRESH_REQUEST_BUILD_CHANGED'], 'STALE: another build refuses a request it did not take (' + JSON.stringify(line.lastFresh) + ')');
    A.ok(/0\.15\.0-gate/.test(String(lastOf(line).error)) && /0\.15\.1-gate/.test(String(lastOf(line).error)), 'STALE: and says so');
    A.eq(failedRequests(), 2, 'STALE: kept as well');
    A.ok(fs.existsSync(path.join(ws, 'agent', 'report.md')), 'STALE: nothing moved');

    /* ---- HELD: a rename that fails changes nothing, and names the error ---- */
    const heldAt = await press('HELD');
    if (process.platform === 'win32') {
      holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { cwd: path.join(ws, 'agent'), stdio: 'ignore' });
      await new Promise(resolve => setTimeout(resolve, 300));
    } else write(shelf, 'a file where the shelf goes');
    const generation = readJson(path.join(ws, cases.recordFile)).generationId;
    await fixture.restart();
    line = await lineageOf();
    A.eq([lastOf(line).ok, lastOf(line).code], [false, 'FRESH_ACTIVATION_FAILED'], 'HELD: lineage.lastFresh says the set-aside failed (' + JSON.stringify(line.lastFresh) + ')');
    A.ok(/EPERM|EBUSY|EACCES|EEXIST|ENOTDIR/.test(String(lastOf(line).error)), 'HELD: it names the error (' + String(lastOf(line).error) + ')');
    A.ok(Number(lastOf(line).at) >= Number(heldAt.requestedAt), 'HELD: newer than the request');
    A.eq([line.onboardingAllowed, line.station && line.station.state, line.station && line.station.generationId], [false, 'active', generation], 'HELD: the original generation is intact and the gate is up');
    A.ok(fs.existsSync(path.join(ws, 'agent', 'report.md')), 'HELD: nothing moved');
    A.eq(stages(), [], 'HELD: no stage is left behind');
    A.eq(failedRequests(), 3, 'HELD: the request is kept as .failed-<stamp>');
    if (holder) { const gone = new Promise(resolve => holder.once('exit', resolve)); holder.kill(); await gone; holder = null; }
    else fs.unlinkSync(shelf);

    /* ---- WHOLE: the holder gone, the next press sets everything aside ---- */
    await press('WHOLE');
    const before = tree(ws);
    await fixture.restart();
    line = await lineageOf();
    A.eq([line.priorInstallEvidence, line.onboardingAllowed, line.station && line.station.state], [false, true, 'none'], 'WHOLE: the next boot allows onboarding (' + JSON.stringify(line.evidence) + ')');
    A.eq([lastOf(line).ok, lastOf(line).kind, lastOf(line).creditsLeftAside], [true, 'fresh', false], 'WHOLE: lineage.lastFresh reports the apply');
    const asides = fs.existsSync(shelf) ? fs.readdirSync(shelf) : [];
    A.eq(asides.length, 1, 'WHOLE: one set-aside generation');
    A.ok(/^station-/.test(String(asides[0])), 'WHOLE: named station-<stamp>, where derive reads a generation from');
    const aside = path.join(shelf, String(asides[0]));
    A.eq(fs.existsSync(aside) ? tree(aside) : null, before, 'WHOLE: EVERYTHING that was live sits byte-identical in it');
    for (const rel of LAYOUT) A.eq(fs.existsSync(path.join(ws, ...rel.split('/'))), false, 'WHOLE: the live generation no longer holds ' + rel);
    A.eq(fs.existsSync(path.join(ws, 'agent.save.json')), false, 'WHOLE: nor the save');
    A.eq(meaningfulEntries(fs, path, ws).map(e => e.name), [], 'WHOLE: and nothing any build reads as a station');
    A.eq(fs.readdirSync(path.join(ws, '.secrets')), [path.basename(LINK)], 'WHOLE: the account link is the only secret carried: workspace-held sign-ins stay with the old station');
    A.eq(fs.existsSync(path.join(ws, ...LINK.split('/'))) ? fs.readFileSync(path.join(ws, ...LINK.split('/')), 'utf8') : null, LINK_BYTES, 'WHOLE: carried byte for byte');
    A.eq(fs.existsSync(requestFile), false, 'WHOLE: the request is consumed');

    const record = readJson(path.join(ws, cases.recordFile));
    A.eq([record.state, record.by, record.eraseAuthority, record.setAside], ['none', 'start-fresh', true, aside], 'WHOLE: the record: none, the ERASE still has authority, the generation is findable');
    const mirror = readJson(path.join(ws, cases.freshMarker));
    A.eq(Object.keys(mirror), cases.nativeMarkers.keys, 'WHOLE: the mirror has the native marker\'s keys, in its order');
    A.eq(mirror, Object.assign({}, cases.nativeMarkers.erase, { at: String(record.reset && record.reset.at), acknowledgedRoots: [legacy], quarantine: aside }),
      'WHOLE: and is the native ERASE marker field for field: at as epoch-ms text, the erase kept for every older build');

    const report = await fixture.request('/api/lineage/report');
    const reportRaw = await report.text();
    A.eq(report.status, 200, 'WHOLE: the recovery report still downloads');
    A.ok(!reportRaw.includes(root) && !reportRaw.includes(fixture.profile), 'WHOLE: and names no absolute path for the set-aside generation');

    /* ---- CARRY: an account link that cannot be read never refuses the reset, and is never lost ---- */
    write(path.join(ws, ...LINK.split('/')), '{torn');
    await press('CARRY');
    await fixture.restart();
    line = await lineageOf();
    A.eq([line.onboardingAllowed, lastOf(line).ok, lastOf(line).creditsLeftAside], [true, true, true], 'CARRY: the reset runs, and lastFresh says the link stayed behind (' + JSON.stringify(line.lastFresh) + ')');
    const second = fs.existsSync(shelf) ? fs.readdirSync(shelf).filter(n => n !== asides[0]) : [];
    A.eq(second.length, 1, 'CARRY: a second generation on the shelf');
    const leftBehind = second.length ? path.join(shelf, second[0], ...LINK.split('/')) : '';
    A.eq(leftBehind && fs.existsSync(leftBehind) ? fs.readFileSync(leftBehind, 'utf8') : null, '{torn', 'CARRY: the link is never lost: it stays with the set-aside generation');
    A.eq(fs.existsSync(path.join(ws, ...LINK.split('/'))), false, 'CARRY: and the clean generation starts unlinked');
    A.eq(readJson(path.join(ws, cases.recordFile)).eraseAuthority, true, 'CARRY: a reset never weakens a prior one, however many there are');

    /* ---- SEED: the old station's copy stays out, and the next station is the station ---- */
    const bootedAt = Date.now();
    const old = (await fixture.json('POST', '/api/save', doc('FROM-THE-OLD-GENERATION', eraseAt + 1000, 23, eraseAt + 2000, 'old-window'))).body;
    A.ok(old.ok === false && old.reset === true, 'SEED: a copy founded before the reset is refused (' + JSON.stringify(old) + ')');
    const founded = (await fixture.json('POST', '/api/save', doc('FOUNDED-NEXT', bootedAt + 1, 0, bootedAt + 2, 'new-window'))).body;
    A.ok(founded.ok === true, 'SEED: a station founded now saves (' + JSON.stringify(founded) + ')');
    A.eq(((await lineageOf()).station || {}).state, 'active', 'SEED: and is founded in the record');
    A.eq(readJson(path.join(ws, cases.recordFile)).eraseAuthority, true, 'SEED: the erase authority stays through the founding');
  } finally {
    if (holder) { try { holder.kill(); } catch (_) {} }
    await fixture.dispose();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starnet-fresh-http-')) throw new Error('unsafe fixture root cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('start-fresh-generation.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
