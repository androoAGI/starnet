/* node test/start-fresh-browser.e2e.test.js — both lifecycle routes close a live station browser, for real.

   The two requests rename this whole generation at the next boot, and the station browser's durable profile lives inside it.
   On Windows any open handle under a directory refuses its rename, and both routes used to end with a bare process.exit(75):
   the station's Chrome outlived the sidecar, an orphan still holding its profile, so the very boot that should set the
   generation aside found it held, and an explicit recovery the Commander had chosen failed closed. POST
   /api/lineage/start-fresh and /api/lineage/recover now close the browser, sweep the profile and leave through the graceful
   path.

   Boots the REAL sidecar with a REAL headless Chrome on the real profile path, for each route: opens the station browser, makes
   the request, proves that nothing holds the profile the moment the sidecar is gone, and restarts at once, as the desktop
   guardian does, so the next boot's rename runs when an orphan would still be alive. Skipped where this machine has no Chrome.

   Chromium can still leave one: a utility process it starts as the browser closes, which outlives it holding no lock file, so
   that check passes and the rename was refused (EPERM, 2 of 12 runs on a loaded box). The next boot now ends a process left on
   the generation's own profile, by its own pid, and tries the rename again. On Windows each row plants such a process (its cwd
   in the profile, the profile on its command line), so that path runs every time, not only when Chromium leaves one. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { _internals: Browser } = require('../sidecar/tools/builtin/browser.js');
const Orphans = require('../sidecar/tools/builtin/browser-orphans.js');

const ENV = {
  STARNET_DEV: '0', SKYNET_DEV: '0', SKYNET_QUEST_REFRESH: '0', STARNET_QUEST_REFRESH: '0',
  STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0', STARNET_LOOP_ENABLED: '0', SKYNET_LOOP_ENABLED: '0',
  SKYNET_LIVE_PRICES: '0', STARNET_LIVE_PRICES: '0', STARNET_EDGE_TTS: '0', SKYNET_EDGE_TTS: '0',
  STARNET_CLOUD_URL: 'http://127.0.0.1:1', STARNET_CREDITS_URL: 'http://127.0.0.1:1', STARNET_DESKTOP_SHELL: '0',
  SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:1', STARNET_OPENROUTER_BASE: 'http://127.0.0.1:1',
  OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: '',
  STARNET_BROWSER_HEADLESS: '1'
};

function write(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)); }
function exited(child, ms) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error('the sidecar did not exit')), ms);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
const onProfile = async profile => Orphans.profileProcesses(await Orphans.makeProcessLister({})(), profile).length;
function station(name) {
  return { version: 1, agentId: 'agent', updatedAt: 5, savedAt: 5, doc: { schema: 'starnet.save', version: 5, updatedAt: 5, agent: { id: 'agent', name },
    station: { rooms: [{ id: 'command' }], props: [] }, workstreams: [{ id: 'general', history: [] }] } };
}

async function row(what, build, request, proveApplied) {
  const fixture = SidecarFixture.create({ prefix: 'starnet-fresh-browser-', timeoutMs: 30000, env: ENV });
  const root = fixture.workspace;
  fixture.workspace = path.join(root, 'workspaces');
  const ws = fixture.workspace, profile = path.join(ws, '.browser-profile');
  fs.mkdirSync(ws);
  let leftover = null;
  try {
    build({ fixture, ws });
    await fixture.start();
    const opened = await fixture.json('POST', '/api/browser/view/open', { url: fixture.baseUrl + '/api/health' });
    if (opened.status !== 200 || !(await onProfile(profile))) throw new Error(what + ': the station browser did not open here: ' + opened.text);
    const child = fixture.child;
    const asked = await request({ fixture });
    A.eq(asked.status, 202, what + ': the request is taken with the browser open (' + asked.text + ')');
    A.eq(await exited(child, 30000), 75, what + ': the sidecar exits with the guardian restart code');
    // a file check, no process listing: an orphaned Chromium dies on its own a few seconds later, and the guardian does not wait
    A.eq(Orphans.profileHeld(profile).held, false, what + ': the moment the sidecar is gone, nothing holds the station profile');
    // the leftover a closing Chromium can start, made certain: no lock file, and on Windows it holds the generation (its cwd)
    if (process.platform === 'win32') {
      leftover = spawn(process.execPath, ['-e', 'process.send("ready", () => process.disconnect()); setTimeout(() => {}, 120000)', '--', '--type=utility', '--user-data-dir=' + profile], { cwd: profile, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the profile holder did not start')), 30000);
        leftover.once('error', e => { clearTimeout(timer); reject(e); });
        leftover.once('exit', () => { clearTimeout(timer); reject(new Error('the profile holder exited before restart')); });
        leftover.once('message', message => { if (message === 'ready') { clearTimeout(timer); resolve(); } });
      });
    }
    await fixture.restart();   // at once, as the desktop guardian does
    await proveApplied({ fixture, ws, root });
    if (leftover) A.ok(await exited(leftover, 15000).then(() => true, () => false), what + ': the next boot ended the process left on the profile');
    A.eq(await onProfile(profile), 0, what + ': and no process is left on it');
  } finally {
    // nothing of ours may outlive a failed row; only a process on this scratch profile can match
    try {
      if (leftover && leftover.exitCode === null && leftover.signalCode === null) {
        const rows = await Orphans.makeProcessLister({})();
        if (Orphans.profileProcesses(rows, profile).some(p => p.pid === leftover.pid)) leftover.kill();
      }
    } finally {
      // A failed identity query cannot skip disposal of the sidecar we started.
      try { await Orphans.sweep({ profileDir: profile }); } catch (_) {}
      await fixture.dispose();
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('starnet-fresh-browser-')) throw new Error('unsafe fixture root cleanup');
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

(async () => {
  const chrome = Browser.resolveChrome ? Browser.resolveChrome(true) : null;
  if (!chrome) { console.log('start-fresh-browser: no Chrome on this box — skipped'); A.report('start-fresh-browser.e2e'); return; }

  await row('START FRESH', ({ ws }) => {
    write(path.join(ws, 'agent.roster.json'), '[]'); write(path.join(ws, 'ledger.jsonl'), 'old\n');
  }, ({ fixture }) => fixture.json('POST', '/api/lineage/start-fresh', {}), async ({ fixture, ws, root }) => {
    const line = (await fixture.json('GET', '/api/lineage')).body.lineage;
    A.eq([line.lastFresh && line.lastFresh.ok, line.onboardingAllowed], [true, true], 'START FRESH: the next boot\'s rename goes through (' + JSON.stringify(line.lastFresh) + ')');
    const shelf = path.join(root, 'workspace-quarantine');
    const asides = fs.existsSync(shelf) ? fs.readdirSync(shelf) : [];
    A.eq(asides.length, 1, 'START FRESH: one generation on the shelf');
    A.ok(asides.length === 1 && fs.existsSync(path.join(shelf, asides[0], '.browser-profile')), 'START FRESH: the durable profile left with the old station');
    A.eq(fs.existsSync(path.join(ws, 'ledger.jsonl')), false, 'START FRESH: and the live generation is clean');
  });

  let candidateId = null;
  await row('RECOVERY', ({ fixture, ws }) => {
    write(path.join(fixture.profile, 'StarNet', 'workspaces', 'agent.save.json'), station('NOVA'));
    write(path.join(ws, 'ledger.jsonl'), 'old\n');
  }, async ({ fixture }) => {
    const line = (await fixture.json('GET', '/api/lineage')).body.lineage;
    const candidate = (line.recovery.candidates || []).find(c => c.stationName === 'NOVA');
    A.ok(candidate && candidate.recoverable, 'RECOVERY: fixture: the old station is a candidate');
    candidateId = candidate && candidate.id;
    return fixture.json('POST', '/api/lineage/recover', { candidateId });
  }, async ({ fixture, ws, root }) => {
    const saved = (await fixture.json('GET', '/api/save?agent=agent')).body;
    const said = fixture.output().split('\n').filter(l => l.startsWith('[recovery]')).join(' | ');
    A.eq(saved.save && saved.save.agent && saved.save.agent.name, 'NOVA', 'RECOVERY: the next boot activated the chosen station (' + said + ')');
    const rollback = fs.readdirSync(root).find(n => n.startsWith('workspaces.recovery-rollback-'));
    A.ok(rollback && fs.existsSync(path.join(root, rollback, '.browser-profile')), 'RECOVERY: and the old generation, profile and all, went to rollback');
    A.ok(fs.existsSync(path.join(ws, 'agent.save.json')) && fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8').includes('NOVA'), 'RECOVERY: its save is the live one');
  });

  A.report('start-fresh-browser.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
