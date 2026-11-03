/* node test/station-recovery-safety.test.js — #119 review: what a bundle may carry, and what a restore may do.

   Runs the real CLI and real capture/restore against temporary folders only. Covers the restore gate (a category nobody
   used is not a gap; a lost file and an empty bundle are), credentials and authority staying out, empty directories,
   exact copies of agents' files, unsafe names and crafted bundles, the command printed for this shell, a failed move-back,
   and output that refuses to overwrite. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const A = require('./_assert.js');
const Recovery = require('../sidecar/station-recovery.js');
const { sweepBackupTemps } = require('../sidecar/update-preparation.js');
const { failureOf, flag } = require('../bin/station-recovery.js');
const Backup = require('../frontend/app/backup.js');

const CLI = path.join(__dirname, '..', 'bin', 'station-recovery.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-safety-'));
let seq = 0;
// fails on the wrong reason too: "it threw" passes for a typo in the test
function throwsWith(fn, re, msg) {
  let got = null;
  try { fn(); } catch (e) { got = e; }
  A.ok(got && re.test(String(got.message)), msg + (got ? ': ' + got.message : ': did not throw'));
}
function fresh(name) { return path.join(root, (++seq) + '-' + name, 'workspaces'); }
function run(args) { return cp.spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' }); }
function out(r) { return JSON.parse(r.stdout); }
function write(ws, rel, value) {
  const f = path.join(ws, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
}
function seed(ws) {
  write(ws, 'agent.save.json', { doc: { agent: { id: 'agent' }, station: { rooms: ['r'], props: ['p'] } } });
  write(ws, 'transcript.jsonl', '{}\n');
  write(ws, 'agent.notebook.json', { entries: [{ id: 'm' }] });
  write(ws, 'cron.jobs.json', { jobs: [{ id: 'r' }] });
  write(ws, 'loops.json', { loops: [{ id: 'l' }] });
  write(ws, 'agent.todo.json', { items: [{ id: 't' }] });
  write(ws, 'projects.json', { projects: [{ id: 'p' }] });
  write(ws, 'agent.deliverables.json', { records: [{ id: 'd' }] });
  write(ws, 'agent/report.md', 'deliverable');
  write(ws, 'permissions.allow.json', { allow: ['fs.write:workspace'] });
  return ws;
}
function bundleFile(name, bundle) {
  const f = path.join(root, 'bundles', (++seq) + '-' + name + '.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(bundle));
  return f;
}
const cap = (ws, extra) => Recovery.capture(Object.assign({ workspaceRoot: ws, now: 1000, omitUnavailableCredentialStores: true }, extra || {}));
const fileRow = (rel, text) => { const d = Buffer.from(text); return { path: rel, bytes: d.length, sha256: Recovery._internals.sha256(d), encoding: 'base64', data: d.toString('base64'), categories: [], redactedFields: [] }; };
// a bundle somebody edited: every checksum recomputed, as anyone with a text editor and node could
function craft(base, mutate) {
  const b = JSON.parse(JSON.stringify(base));
  mutate(b);
  const doc = { files: b.files.map(x => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 })), browser: b.browser.map(x => ({ key: x.key, bytes: x.bytes, sha256: x.sha256 })), recoveryPoint: b.recoveryPoint };
  if (Array.isArray(b.directories) && b.directories.length) doc.directories = b.directories;
  b.manifestSha256 = Recovery._internals.sha256(Buffer.from(JSON.stringify(doc), 'utf8'));
  return b;
}

(async () => {
  /* ---- the gate: never used is not incomplete ---- */
  const bootedOnce = fresh('booted-once');
  write(bootedOnce, 'agent.save.json', { doc: { agent: { id: 'agent' } } });
  const onceOut = path.join(root, 'once.starnet-recovery.json');
  const onceRun = run(['backup', '--workspace', bootedOnce, '--output', onceOut]);
  A.eq(onceRun.status, 0, 'a station booted once backs up, though most categories have nothing yet: ' + onceRun.stderr);
  A.eq(out(onceRun).verdict.restoreNeeds, [], 'and needs no flag to restore');
  A.ok(/Expected if you never used them\./.test(out(onceRun).verdict.categories), 'and says why the categories are empty');
  const onceTarget = fresh('once-restored');
  A.eq(run(['restore', '--bundle', onceOut, '--target', onceTarget]).status, 0, 'and restores with no flag');

  const empty = fresh('empty'); fs.mkdirSync(empty, { recursive: true });
  const emptyOut = path.join(root, 'empty.starnet-recovery.json');
  const emptyRun = run(['backup', '--workspace', empty, '--output', emptyOut]);
  A.eq(emptyRun.status, 2, 'a folder with no agent writes nothing');
  A.eq(fs.existsSync(emptyOut), false, 'no file');
  A.ok(/--allow-no-agents/.test(out(emptyRun).next), 'and the stronger flag is named');
  A.eq(run(['backup', '--workspace', empty, '--output', emptyOut, '--allow-no-agents']).status, 0, 'the flag writes it');

  // a zero-file bundle must not replace a station on --allow-incomplete
  const liveWs = seed(fresh('keep'));
  const weak = run(['restore', '--bundle', emptyOut, '--target', liveWs, '--replace-existing', '--allow-incomplete']);
  A.ok(weak.status !== 0 && /--allow-no-agents/.test(weak.stderr), 'a bundle with no agents needs its own flag: ' + weak.stderr);
  A.ok(fs.existsSync(path.join(liveWs, 'agent.save.json')), 'and the station stays');
  A.eq(fs.readdirSync(path.dirname(liveWs)).filter(n => /rollback/.test(n)), [], 'nothing moved');
  const strongTarget = seed(fresh('replaced'));
  const strong = run(['restore', '--bundle', emptyOut, '--target', strongTarget, '--replace-existing', '--allow-no-agents']);
  A.eq(strong.status, 0, 'the stronger flag is an explicit choice: ' + strong.stderr);
  A.ok(/HOLDS NO READABLE AGENT/.test(strong.stderr), 'and the verdict is said before the old station moves');

  // a bundle whose report lies (empty requirements, no rows) is counted from its files
  const oneFile = craft(cap(seed(fresh('one-file'))), b => {
    b.files = b.files.filter(x => x.path === 'agent/report.md');
    b.report.requirements = []; b.report.complete = false; b.report.skipped = [];
    b.report.integrity.verbatim = true;
  });
  const oneRun = run(['inspect', '--bundle', bundleFile('one', oneFile)]);
  A.ok(/HOLDS NO READABLE AGENT/.test(out(oneRun).verdict.station), 'inspect does not trust a report\'s empty requirement list');
  A.eq(out(oneRun).verdict.restoreNeeds, ['--allow-no-agents'], 'and names what restoring it needs');

  // a torn save and a file over the cap both need the flag, however complete the categories look
  const tornWs = seed(fresh('torn'));
  fs.writeFileSync(path.join(tornWs, 'agent.save.json'), '{"torn');
  const tornBundle = cap(tornWs);
  const tornGate = Recovery.restoreGate(tornBundle);
  A.eq(tornGate.noAgents, true, 'a torn only save is no readable agent');
  A.eq(tornGate.flags.includes('--allow-incomplete') && tornGate.flags.includes('--allow-no-agents'), true, 'and asks for both flags');
  A.ok(tornGate.tornSaves.includes('agent.save.json'), 'and is named');
  const wide = seed(fresh('wide'));
  write(wide, 'second.save.json', '{"torn');
  A.eq(Recovery.restoreGate(cap(wide)).flags, ['--allow-incomplete'], 'one torn save of two asks only for --allow-incomplete');
  const capWs = seed(fresh('cap'));
  write(capWs, 'agent/big.bin', 'x'.repeat(4000));
  const capped = cap(capWs, { maxBytes: 3000, budgetReason: Recovery.EXPLICIT_BUDGET_REASON });
  A.ok(capped.report.skipped.some(x => /^too large for /.test(x.reason)), 'a file over the cap is listed');
  A.eq(Recovery.restoreGate(capped).flags, ['--allow-incomplete'], 'and a restore needs the flag');
  throwsWith(() => Recovery.restore({ bundle: capped, targetRoot: fresh('cap-refused') }), /refusing incomplete recovery bundle/, 'a restore refuses it without the flag');

  // browser keys prove nothing about the files a restore lands
  const browserOnly = fresh('browser-only');
  write(browserOnly, 'agent/report.md', 'x');
  const fromBrowser = cap(browserOnly, { browserStore: { 'starnet.save': '{}', 'starnet.station.v1': '{}' } });
  A.eq(fromBrowser.report.requirements.find(x => x.category === 'agents').status, 'missing', 'a browser key is not evidence of an agent file');
  A.eq(Recovery.restoreGate(fromBrowser).noAgents, true, 'and does not pass the gate');

  /* ---- the words for a locked save ---- */
  const lockedWords = Backup.describeRecovery({ requirements: [{ category: 'agents', status: 'missing' }], gate: { noAgents: true, flags: ['--allow-no-agents', '--allow-incomplete'], tornSaves: [] }, integrity: { verbatim: false, tornChecked: true, counts: { unreadable: 1 } }, gaps: [{ path: 'agent.save.json', reason: 'unreadable: EBUSY' }], gapsTotal: 1 }).join('\n');
  A.ok(/HOLDS NO READABLE AGENT/.test(lockedWords), 'a locked save says there is no readable agent');
  A.ok(/unless a file listed below belongs to it/.test(lockedWords) && !/Expected if you never used it\.\n/.test(lockedWords + '\n'), 'and never just "expected"');
  const neverWords = Backup.describeRecovery({ requirements: [{ category: 'loops', status: 'missing' }], gate: { flags: [] }, integrity: { verbatim: true, tornChecked: true, counts: {} }, gaps: [], gapsTotal: 0 }).join('\n');
  A.ok(/Expected if you never used it\./.test(neverWords), 'a category with nothing lost reads as never used');
  A.ok(/NOT encrypted/.test(neverWords) && /do not send it/.test(neverWords), 'the page says the file is readable and not to spread it');

  /* ---- credentials do not ride ---- */
  const CANARIES = { DB_PW: 'canary-db-pw', MYSQL_PWD: 'canary-mysql', HUBSPOT_PAT: 'canary-hubspot', SENTRY_DSN: 'canary-sentry', botToken: 'canary-bot', authToken: 'canary-auth', privateKey: 'canary-private', signingSecret: 'canary-signing' };
  const secretWs = seed(fresh('secrets'));
  write(secretWs, 'connectors/state.json', { version: 2, configs: [{
    id: 'c1', transport: 'stdio', label: 'keep-label', oauth: true, hasToken: true,
    command: 'npx',
    args: ['-y', 'server@1.2.3', '--api-key', 'canary-args-next', '--token=canary-args-eq', 'plain', 'ghp1234567890abcdefGHIJ1234'],
    url: 'https://u:canary-userinfo@mcp.example/hook/abcdefghij1234567890KLMN/x?sig=canary-query#canary-fragment',
    env: Object.assign({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:canary-dburl@h/db' }, CANARIES),
    headers: { 'X-Admin-Pin': 'canary-pin', 'X-Api-Sig': 'canary-sig', 'X-Safe': 'yes' },
    botToken: 'canary-field-bot', authToken: 'canary-field-auth', privateKey: 'canary-field-private', signingSecret: 'canary-field-signing'
  }], oauth: { byId: {}, clients: {} } });
  write(secretWs, 'hooks.json', { hooks: [{ event: 'run.done', command: 'notify.cmd', env: { SLACK_TOKEN: 'canary-hook', LEVEL: 'info' } }] });
  write(secretWs, 'agent/.env', 'API_KEY=canary-dotenv\n');
  write(secretWs, 'agent/.env.production', 'API_KEY=canary-dotenv-prod\n');
  write(secretWs, 'agent/.env.example', 'API_KEY=fill-me-in\n');
  write(secretWs, 'agent/.npmrc', '//registry/:_authToken=canary-npmrc\n');
  write(secretWs, 'agent/server.pem', '-----BEGIN RSA PRIVATE KEY-----\ncanary-pem\n-----END RSA PRIVATE KEY-----\n');
  write(secretWs, 'agent/cacert.pem', '-----BEGIN CERTIFICATE-----\nkeep-cert\n-----END CERTIFICATE-----\n');
  write(secretWs, 'agent/deck.key', 'PK\u0003\u0004 a keynote deck, with spaces');
  write(secretWs, 'agent/api.key', 'abcdef0123456789abcdef0123456789\n');
  write(secretWs, 'agent/repo/.git/config', '[remote "origin"]\n\turl = https://bob:canary-pat@github.com/o/r.git\n[http]\n\textraheader = AUTHORIZATION: basic canary-header\n[core]\n\tbare = false\n');
  const secretBundle = cap(secretWs);
  const secretText = JSON.stringify(secretBundle.files.map(x => Object.assign({}, x, { data: Buffer.from(x.data, 'base64').toString('utf8') })));
  for (const v of Object.values(CANARIES)) A.eq(secretText.indexOf(v), -1, 'env canary is gone: ' + v);
  for (const v of ['canary-pin', 'canary-sig', 'canary-args-next', 'canary-args-eq', 'ghp1234567890abcdefGHIJ1234', 'canary-userinfo', 'canary-query', 'canary-fragment', 'abcdefghij1234567890KLMN', 'canary-dburl', 'canary-field-bot', 'canary-field-auth', 'canary-field-private', 'canary-field-signing', 'canary-hook', 'canary-dotenv', 'canary-npmrc', 'canary-pem', 'canary-pat', 'canary-header']) {
    A.eq(secretText.indexOf(v), -1, 'canary is gone: ' + v);
  }
  const stored = JSON.parse(Buffer.from(secretBundle.files.find(x => x.path === 'connectors/state.json').data, 'base64').toString('utf8')).configs[0];
  A.eq(stored.env.NODE_ENV, 'production', 'an env value that is no credential stays');
  A.eq(stored.headers['X-Safe'], 'yes', 'as does a harmless header');
  A.eq(stored.label, 'keep-label', 'and the connector\'s name');
  A.eq(stored.oauth === true && stored.hasToken === true, true, 'and a flag beside a credential is no credential');
  A.eq(stored.args.length, 7, 'an args array keeps its shape');
  A.eq(stored.args[3], '<redacted>', 'with the value after a credential flag replaced');
  A.eq(stored.args[4], '--token=<redacted>', 'and the value of --flag=value');
  A.ok(secretBundle.files.some(x => x.path === 'agent/cacert.pem') && secretBundle.files.some(x => x.path === 'agent/deck.key'), 'a public certificate and a Keynote deck ride');
  A.eq(secretBundle.files.some(x => x.path === 'agent/server.pem' || x.path === 'agent/api.key'), false, 'a private key and a bare token do not');
  A.ok(Recovery.integrityGaps(secretBundle.report).some(x => x.path === 'agent/server.pem'), 'and each is a named loss');
  A.eq(secretBundle.report.integrity.verbatim, false, 'so the bundle does not read as exact');
  A.ok(secretBundle.report.integrity.counts.credentialFiles >= 4, 'and counts them');
  A.eq(Recovery.restoreGate(secretBundle).flags, [], 'without asking for a flag every station with an .env would need');
  A.ok(!/by hand/.test(JSON.stringify(secretBundle.report.reauthentication)), 'and without advice a disk loss makes impossible');
  // a flag beside a credential word that switches something off, or a next flag, is not a value to hide
  const argsClean = JSON.parse(Recovery._internals.sanitizeManagedJson('connectors/state.json', Buffer.from(JSON.stringify({ version: 2, configs: [{ id: 'a', args: ['--no-auth', '--port', '80', '--token', '--verbose', '--api-key', 'canary'] }] }))).data).configs[0].args;
  A.eq(argsClean, ['--no-auth', '--port', '80', '--token', '--verbose', '--api-key', '<redacted>'], 'only a real value is redacted');
  const hooksOut = JSON.parse(Buffer.from(secretBundle.files.find(x => x.path === 'hooks.json').data, 'base64').toString('utf8'));
  A.eq(hooksOut.hooks[0].command, 'notify.cmd', 'a hook keeps its command, which is inert until approved');
  A.eq(hooksOut.hooks[0].env.LEVEL, 'info', 'and what is no credential');
  A.ok(secretBundle.files.some(x => x.path === 'agent/.env.example'), 'a .env.example is no credential file');
  A.ok(secretBundle.report.reauthentication.some(x => x.kind === 'credential-file' && x.id === 'agent/.env'), 'a left-out .env is listed for the person');
  A.ok(secretBundle.report.reauthentication.some(x => x.kind === 'git-remote'), 'and a git sign-in');
  const gitCfg = Buffer.from(secretBundle.files.find(x => x.path === 'agent/repo/.git/config').data, 'base64').toString('utf8');
  A.ok(/url = https:\/\/github\.com\/o\/r\.git/.test(gitCfg) && /bare = false/.test(gitCfg), 'the git config still works');
  // sanitizing what was sanitized changes nothing: rehearsal compares bytes
  const onceClean = Recovery._internals.sanitizeManagedJson('connectors/state.json', Buffer.from(JSON.stringify({ version: 2, configs: [{ id: 'a', url: 'https://m.example/x?y=1', env: { A: 'b' } }], oauth: {} })));
  const twiceClean = Recovery._internals.sanitizeManagedJson('connectors/state.json', onceClean.data);
  A.eq(twiceClean.data.toString(), onceClean.data.toString(), 'sanitizing twice gives the same bytes');
  const plainUrl = Recovery._internals.sanitizeManagedJson('connectors/state.json', Buffer.from(JSON.stringify({ version: 2, configs: [{ id: 'a', url: 'https://m.example' }] })));
  A.eq(JSON.parse(plainUrl.data).configs[0].url, 'https://m.example', 'a URL with nothing to remove stays as written');
  // a torn hooks.json must not stop an update the way a torn vault does, and its bytes must not ride
  const tornHooks = seed(fresh('torn-hooks'));
  write(tornHooks, 'hooks.json', '{"env":{"T":"canary-torn-hook"');
  const tornHookBundle = Recovery.capture({ workspaceRoot: tornHooks, now: 1 });
  A.eq(Buffer.from(tornHookBundle.files.find(x => x.path === 'hooks.json').data, 'base64').toString(), '{}\n', 'a torn hooks.json does not ride');
  A.ok(tornHookBundle.report.reauthentication.some(x => x.kind === 'hook'), 'and is listed, with no update blocked');
  A.ok(tornHookBundle.report.skipped.some(x => x.path === 'hooks.json' && /^torn: /.test(x.reason)), 'with a torn row');
  A.eq(tornHookBundle.report.integrity.verbatim, false, 'so it never reads as exact');
  A.eq(tornHookBundle.report.integrity.counts.tornKept, 1, 'and it is counted');
  A.ok(Recovery.restoreGate(tornHookBundle).flags.includes('--allow-incomplete'), 'and is a gap at restore');

  /* ---- authority does not travel ---- */
  const authWs = seed(fresh('authority'));
  write(authWs, 'permissions.bypass.json', { on: true });
  write(authWs, 'hooks-allowed.json', { allow: ['x'] });
  write(authWs, 'plugins-allowed.json', { allow: ['y'] });
  write(authWs, 'skills-allowed.json', { allow: ['z'] });
  write(authWs, 'plugins/p/manifest.json', {});
  write(authWs, '_commander.autonomy.json', { v: 1, posture: { initiative: 'high', reach: 'act', leashPerDay: 99 } });
  write(authWs, 'cron.armed.json', { version: 1, armed: true });
  const authBundle = cap(authWs);
  const inBundle = name => JSON.parse(Buffer.from(authBundle.files.find(x => x.path === name).data, 'base64').toString());
  A.eq(inBundle('cron.armed.json').armed, false, 'routines ride switched off');
  {
    // NOTHING ACTS ON ITS OWN AFTER A RESTORE: every boot-time actor in the bundle, on a new capture and on an old bundle
    const quietWs = fresh('quiet'); seed(quietWs);
    const stores = {
      'loops.json': { version: 1, loops: [
        { id: 'live', name: 'Live', objective: 'x', enabled: true, state: 'idle' },
        { id: 'unsaid', name: 'Unsaid', objective: 'x', state: 'running' },
        { id: 'asleep', name: 'Asleep', objective: 'x', enabled: true, state: 'dormant' },
        { id: 'held', enabled: false, state: 'paused', stopReason: 'mine' },
        { id: 'over', enabled: true, state: 'done' }] },
      'triggers.json': { version: 1, triggers: [
        { id: 'tf', lineId: 'l', kind: 'folder', name: 'Inbox', enabled: true, config: { path: 'C:/in' } },
        { id: 'tw', lineId: 'l', kind: 'webhook', name: 'Hook', config: {} },
        { id: 'toff', lineId: 'l', kind: 'folder', name: 'Off', enabled: false, config: {} }] },
      'cron.jobs.json': { version: 1, jobs: [
        { id: 'sends', name: 'Sends', enabled: true, state: 'idle', finalization: { runId: 'r1', state: 'pending' } },
        { id: 'backlog', enabled: true, state: 'idle', deliveryBacklog: [{ runId: 'r2', state: 'pending' }] },
        { id: 'settled', enabled: true, state: 'idle', finalization: { runId: 'r3', state: 'delivered' } }] },
      'overseer.json': { version: 1, value: { threads: [], reviews: [{ id: 'rep1', status: 'pending', workerRunIds: ['w1'] }, { id: 'rep2', status: 'done' }] } },
      'connectors/state.json': { version: 2, configs: [{ id: 'on', name: 'On', url: 'https://mcp.example/a', enabled: true }, { id: 'unsaid', name: 'U', url: 'https://mcp.example/b', headers: { Authorization: 'canary' } }, { id: 'off', name: 'Off', enabled: false }], oauth: { byId: {}, clients: {} } },
      'channels/secrets.json': { signal: { enabled: true, endpoint: 'http://127.0.0.1:1/', account: '+1' }, telegram: { enabled: true, token: 'canary' }, slack: { enabled: false }, telegramBots: { b1: { username: 'x' }, b2: { enabled: false } }, notifyAutonomous: true }
    };
    for (const name of Object.keys(stores)) write(quietWs, name, stores[name]);
    const quietBundle = cap(quietWs);
    const rideOf = (bundle, name) => JSON.parse(Buffer.from(bundle.files.find(x => x.path === name).data, 'base64').toString());
    const check = (read, rows, label) => {
      const has = (kind, id) => rows.some(x => x.kind === kind && x.id === id);
      const loop = Object.fromEntries(read('loops.json').loops.map(x => [x.id, x]));
      for (const id of ['live', 'unsaid', 'asleep']) {
        A.eq(loop[id].enabled, false, label + 'loop off: ' + id);
        A.eq(loop[id].state, 'paused', label + 'loop paused: ' + id);
        A.ok(has('loop', id), label + 'loop listed: ' + id);
      }
      A.eq(loop.held.stopReason, 'mine', label + 'a loop a person paused keeps their reason');
      A.eq(loop.over.state, 'done', label + 'a finished loop stays finished');
      for (const id of ['held', 'over']) A.ok(!has('loop', id), label + 'and is not listed: ' + id);
      for (const row of read('triggers.json').triggers) A.eq(row.enabled, false, label + 'trigger off: ' + row.id);
      A.ok(has('trigger', 'tf') && has('trigger', 'tw') && !has('trigger', 'toff'), label + 'triggers that were on are listed');
      const job = Object.fromEntries(read('cron.jobs.json').jobs.map(x => [x.id, x]));
      for (const id of ['sends', 'backlog']) {
        A.ok(job[id].enabled === false && job[id].state === 'paused', label + 'a routine with an unsent result is paused: ' + id);
        A.ok(has('routine', id), label + 'and listed: ' + id);
      }
      A.eq(job.sends.finalization.state, 'pending', label + 'its result is kept for the resume');
      A.ok(job.settled.enabled === true && !has('routine', 'settled'), label + 'one with nothing to send is left to cron.armed.json');
      const reports = read('overseer.json').value.reviews;
      A.eq(reports[0].status, 'interrupted', label + 'a queued report does not run');
      A.eq(reports[0].workerRunIds, ['w1'], label + 'and still covers its worker, so the tick does not queue it again');
      A.eq(reports[1].status, 'done', label + 'a finished report is untouched');
      A.ok(has('overseer-report', 'rep1') && !has('overseer-report', 'rep2'), label + 'only the queued report is listed');
      const conn = Object.fromEntries(read('connectors/state.json').configs.map(x => [x.id, x]));
      for (const id of ['on', 'unsaid', 'off']) A.eq(conn[id].enabled, false, label + 'connector off: ' + id);
      A.ok(has('connector', 'on') && !has('connector', 'off'), label + 'connectors that were on are listed');
      const tokenRow = rows.find(x => x.kind === 'connector' && x.id === 'unsaid');
      A.ok(tokenRow && /excluded/.test(tokenRow.reason) && /off after a restore/.test(tokenRow.reason), label + 'a connector that lost a token and was switched off is one row saying both');
      const chan = read('channels/secrets.json');
      A.eq(chan.signal.enabled, false, label + 'Signal, which needs no token, does not start');
      A.eq(chan.telegram.enabled, false, label + 'a bot whose token is still in the OS store does not start');
      A.eq(chan.telegramBots.b1.enabled, false, label + 'nor an extra bot that never said');
      A.eq(chan.notifyAutonomous, true, label + 'settings that act on nothing are kept');
      A.ok(has('channel', 'signal') && has('channel', 'telegram') && has('channel', 'telegram:b1'), label + 'bots that were on are listed');
      A.ok(!has('channel', 'slack') && !has('channel', 'telegram:b2'), label + 'bots that were off are not');
    };
    check(name => rideOf(quietBundle, name), quietBundle.report.reauthentication, 'capture: ');

    // an old bundle: raw files, no report rows. Every row has to come from the restore itself
    const oldQuiet = { files: Object.keys(stores).map(n => fileRow(n, JSON.stringify(stores[n]))) };
    const oldPlan = Recovery._internals.restorePlan(oldQuiet);
    const landed = {};
    Recovery._internals.restorePlan(oldQuiet, row => { landed[row.rel] = row.data; });
    check(name => JSON.parse(landed[name].toString()), oldPlan.reauth, 'old bundle: ');

    // idempotent: rehearse compares the plan's bytes with a recapture
    for (const name of Object.keys(stores)) {
      const once = landed[name];
      const again = {};
      Recovery._internals.restorePlan({ files: [{ path: name, data: once.toString('base64') }] }, row => { again[row.rel] = row.data; });
      A.eq(again[name].toString(), once.toString(), 'a second pass changes nothing: ' + name);
    }
    const secondPass = Recovery._internals.restorePlan({ files: Object.keys(landed).map(n => ({ path: n, data: landed[n].toString('base64') })) });
    for (const kind of ['loop', 'trigger', 'routine', 'overseer-report', 'channel']) A.ok(!secondPass.reauth.some(x => x.kind === kind), 'and writes no new row: ' + kind);

    // rehearse: plan and landed share the same rules, so a bundle from today's capture must also keep its own rows
    const liveLoop = Object.assign(fileRow('loops.json', JSON.stringify(stores['loops.json'])), { categories: ['loops'] });
    const swapLoop = b => { b.files = b.files.filter(x => x.path !== 'loops.json').concat(liveLoop); };
    const clean = Recovery.rehearse({ bundle: cap(quietWs), scratchRoot: fresh('rehearse-clean'), now: 2000 });
    A.eq(clean.ok, true, 'rehearse: a bundle from today\'s capture passes');
    A.eq(clean.rewrittenByPlan, [], 'and the plan keeps every row');
    const rewritten = craft(cap(quietWs), swapLoop);
    A.eq(rewritten.planKeepsRows, true, 'the marker rides');
    const caught = Recovery.rehearse({ bundle: rewritten, scratchRoot: fresh('rehearse-caught'), now: 2000 });
    A.eq(caught.ok, false, 'rehearse: a plan that changes a row of today\'s capture fails');
    A.eq(caught.rewrittenByPlan, ['loops.json'], 'and names the row');
    const older = craft(cap(quietWs), b => { swapLoop(b); delete b.planKeepsRows; });
    const olderRun = Recovery.rehearse({ bundle: older, scratchRoot: fresh('rehearse-older'), now: 2000 });
    A.eq(olderRun.ok, true, 'an older bundle\'s raw store is still meant to come back cleaned');
    // a build from before the lifecycle rule captured the source workspace's reset marker under the same marker (today's capture
    // never does: station-record.js LIFECYCLE_FILES). The plan drops that row on purpose, so it is no rewrite; every other row
    // is still held to its own bytes
    const withMarker = b => { b.files.push(fileRow('.fresh-start.json', '{"version":1,"erased":false,"at":"1","acknowledgedRoots":[],"quarantine":null,"moved":[]}')); };
    const marked = craft(cap(quietWs), withMarker);
    A.eq(marked.planKeepsRows, true, 'fixture: the reset marker rides under planKeepsRows, as such a build wrote it');
    const markedRun = Recovery.rehearse({ bundle: marked, scratchRoot: fresh('rehearse-marker'), now: 2000 });
    A.eq([markedRun.ok, markedRun.rewrittenByPlan], [true, []], 'rehearse: the reset marker is no rewritten row (' + JSON.stringify(markedRun.rewrittenByPlan) + ')');
    A.ok(markedRun.droppedOnRestore.some(x => x.path === '.fresh-start.json'), 'it is dropped and named, as a restore drops it');
    const markedCli = run(['rehearse', '--bundle', bundleFile('marked', marked)]);
    A.eq(markedCli.status, 0, 'and the check an in-app backup prints passes it: ' + markedCli.stderr);
    const markedTampered = Recovery.rehearse({ bundle: craft(cap(quietWs), b => { withMarker(b); swapLoop(b); }), scratchRoot: fresh('rehearse-marker-tampered'), now: 2000 });
    A.eq([markedTampered.ok, markedTampered.rewrittenByPlan], [false, ['loops.json']], 'a changed row beside it still fails, and is the one row named');

    // a store with nothing to switch off keeps its exact bytes; a torn one keeps its old behaviour
    const pretty = '{"loops":[{"id":"x","enabled":false,"state":"paused"}],  "version":1}';
    const kept = {};
    Recovery._internals.restorePlan({ files: [fileRow('loops.json', pretty), fileRow('triggers.json', '{"torn'), fileRow('OVERSEER.json', '[]')] }, row => { kept[row.rel] = row.data.toString(); });
    A.eq(kept['loops.json'], pretty, 'nothing to change: the bytes stay');
    A.eq(kept['triggers.json'], '{"torn', 'a torn store passes through: it loads as empty and starts nothing');
    A.eq(kept['OVERSEER.json'], '[]', 'a store of another shape passes through, whatever case its name is in');
    const shouty = {};
    Recovery._internals.restorePlan({ files: [fileRow('LOOPS.JSON', JSON.stringify(stores['loops.json']))] }, row => { shouty[row.rel] = JSON.parse(row.data.toString()); });
    A.eq(shouty['LOOPS.JSON'].loops[0].enabled, false, 'a name in another case lands on the same file here, so it gets the same rule');
    // the torn main still takes its last-known-good, and that copy lands quiet too
    const tornWs = fresh('quiet-torn'); seed(tornWs);
    fs.writeFileSync(path.join(tornWs, 'loops.json'), '{"torn');
    write(tornWs, 'loops.json.bak', stores['loops.json']);
    const tornCap = cap(tornWs);
    A.ok(tornCap.report.skipped.some(x => /^promoted: /.test(x.reason)), 'a torn loops.json is still promoted from its .bak');
    A.eq(rideOf(tornCap, 'loops.json').loops[0].enabled, false, 'and the promoted copy is switched off as well');
  }
  A.ok(authBundle.report.reauthentication.some(x => x.kind === 'approval' && x.id === 'cron.armed.json'), 'and are listed to turn on');
  A.eq(inBundle('permissions.allow.json').allow, [], 'no "always allow" rides');
  A.ok(authBundle.report.reauthentication.some(x => x.kind === 'approval' && x.id === 'fs.write:workspace'), 'and each is listed');
  for (const name of ['permissions.bypass.json', 'hooks-allowed.json', 'plugins-allowed.json', 'skills-allowed.json', '_commander.autonomy.json']) {
    A.eq(authBundle.files.some(x => x.path === name), false, 'never captured: ' + name);
    A.ok(authBundle.report.reauthentication.some(x => x.kind === 'approval' && x.id === name), 'and listed to redo: ' + name);
  }
  A.ok(authBundle.files.some(x => x.path === 'plugins/p/manifest.json'), 'a plugin stays, inert until approved');
  A.eq(Recovery.restoreGate(authBundle).flags, [], 'an approval left out on purpose is not a gap');
  // a bundle from before this rule still holds them: a restore drops them and says so
  const oldAuth = craft(authBundle, b => { b.files.push(fileRow('permissions.bypass.json', '{"on":true}'), fileRow('Hooks-Allowed.json', '{"allow":["x"]}')); });
  const oldTarget = fresh('old-authority');
  const oldReceipt = Recovery.restore({ bundle: oldAuth, targetRoot: oldTarget });
  A.eq(fs.existsSync(path.join(oldTarget, 'permissions.bypass.json')), false, 'an old bundle\'s FULL BYPASS does not land');
  A.eq(fs.readdirSync(oldTarget).some(n => /hooks-allowed/i.test(n)), false, 'nor an approval in another case');
  A.ok(oldReceipt.droppedOnRestore.some(x => x.path === 'permissions.bypass.json'), 'the receipt says what was dropped');
  A.ok(oldReceipt.reauthentication.some(x => x.kind === 'approval' && x.id === 'permissions.bypass.json'), 'and it joins what to redo');

  /* ---- a truly old bundle: the only copy someone has ---- */
  const oldWs = seed(fresh('old-format'));
  const released = craft(cap(oldWs), b => {
    delete b.directories; delete b.report.integrity; delete b.planKeepsRows;
    b.report.requirements = []; b.report.complete = false;
    b.browser.push({ key: 'starnet.autonomy.v1', bytes: 2, sha256: Recovery._internals.sha256(Buffer.from('{}')), value: '{}', categories: [] });
    b.files = b.files.filter(x => x.path !== 'permissions.allow.json');
    b.files.push(
      fileRow('.migration-pending', 'x'), fileRow('agent/What?.md', 'mac'), fileRow('agent/a:b', 'linux'),
      fileRow('agent/name.', 'dot'), fileRow('agent/aux.c', 'c'), fileRow('agent.save.json:ads', 'stream'),
      fileRow('permissions.bypass.json', '{"on":true}'), fileRow('cron.armed.json', '{"version":1,"armed":true}'),
      fileRow('_commander.autonomy.json', '{"v":1,"posture":{"leashPerDay":99}}'),
      fileRow('permissions.allow.json', '{"allow":["shell.exec:*","path:C:/x"],"meta":{"shell.exec:*":{"at":1}}}'),
      // a released capture carried the source workspace's legacy reset marker (station-record.js LIFECYCLE_FILES)
      fileRow('.fresh-start.json', '{"version":1,"at":1}'));
  });
  A.ok(Recovery.validate(released).ok, 'an old bundle with awkward names is still a valid file: ' + Recovery.validate(released).errors.join('; '));
  const releasedFile = bundleFile('released', released);
  const releasedSeen = out(run(['inspect', '--bundle', releasedFile]));
  A.ok(/a restore will not write/.test(releasedSeen.verdict.files) && !/Nothing was skipped/.test(releasedSeen.verdict.files), 'the printed verdict says what will be dropped: ' + releasedSeen.verdict.files);
  A.ok(releasedSeen.verdict.droppedOnRestore.some(x => x.path === 'agent/What?.md'), 'and names it');
  A.eq(releasedSeen.verdict.restoreNeeds, ['--allow-incomplete'], 'a lost name asks for the flag');
  const rehearsedOld = run(['rehearse', '--bundle', releasedFile]);
  A.eq(rehearsedOld.status, 0, 'a rehearsal takes it: ' + rehearsedOld.stderr);
  A.eq(out(rehearsedOld).contentMatches, true, 'and compares what should land');
  const releasedTarget = fresh('released-target');
  const refusedOld = run(['restore', '--bundle', releasedFile, '--target', releasedTarget]);
  A.ok(refusedOld.status !== 0 && /--allow-incomplete/.test(refusedOld.stderr), 'a restore asks first');
  const landedOld = run(['restore', '--bundle', releasedFile, '--target', releasedTarget, '--allow-incomplete']);
  A.eq(landedOld.status, 0, 'and has an override, because this may be the only copy: ' + landedOld.stderr);
  const oldReceiptRun = out(landedOld).receipt;
  for (const p of ['.migration-pending', 'agent/What?.md', 'agent/a:b', 'agent/name.', 'agent/aux.c', 'agent.save.json:ads', 'permissions.bypass.json', '_commander.autonomy.json', '.fresh-start.json']) {
    A.ok(oldReceiptRun.droppedOnRestore.some(x => x.path === p), 'dropped and named: ' + p);
  }
  A.eq(fs.existsSync(path.join(releasedTarget, '.fresh-start.json')), false, 'the source workspace\'s reset marker never lands: the restored station records its own');
  A.eq(fs.readFileSync(path.join(releasedTarget, 'agent', 'report.md'), 'utf8'), 'deliverable', 'the rest lands');
  A.eq(JSON.parse(fs.readFileSync(path.join(releasedTarget, 'cron.armed.json'), 'utf8')).armed, false, 'an old bundle\'s routines land switched off');
  A.eq(JSON.parse(fs.readFileSync(path.join(releasedTarget, 'permissions.allow.json'), 'utf8')).allow, [], 'with no "always allow"');
  A.eq(fs.existsSync(path.join(releasedTarget, '_commander.autonomy.json')), false, 'and the default posture');
  for (const id of ['cron.armed.json', 'shell.exec:*', '_commander.autonomy.json', 'permissions.bypass.json']) A.ok(oldReceiptRun.reauthentication.some(x => x.kind === 'approval' && x.id === id), 'listed to redo: ' + id);
  const oldBrowserFile = JSON.parse(fs.readFileSync(out(landedOld).browserImport.file, 'utf8'));
  A.eq('starnet.autonomy.v1' in oldBrowserFile.store, false, 'and the import file cannot bring the posture back');
  const badDirOld = craft(released, b => { b.directories = ['agent/What?', 'agent/fine']; });
  const badDirTarget = fresh('bad-dir');
  const badDirReceipt = Recovery.restore({ bundle: badDirOld, targetRoot: badDirTarget, allowIncomplete: true });
  A.eq(badDirReceipt.directories, 1, 'an empty folder with an unstorable name is dropped too');
  A.ok(fs.existsSync(path.join(badDirTarget, 'agent', 'fine')), 'and the good one lands');

  /* ---- links ---- */
  const linkWs = seed(fresh('links'));
  const outside = path.join(root, 'outside-data');
  write(outside, 'thesis.md', 'data');
  const emptyOutside = path.join(root, 'outside-empty'); fs.mkdirSync(emptyOutside, { recursive: true });
  write(linkWs, 'agent/app/node_modules/.pnpm/pkg/index.js', 'x');
  const makeLink = (to, at) => { try { fs.symlinkSync(to, path.join(linkWs, ...at.split('/')), 'junction'); return true; } catch (e) { console.log('  (skipped link case: ' + e.code + ')'); return false; } };
  if (makeLink(path.join(linkWs, 'agent', 'app', 'node_modules', '.pnpm', 'pkg'), 'agent/app/node_modules/pkg') && makeLink(emptyOutside, 'agent/empty-link')) {
    const linked = cap(linkWs);
    A.eq(linked.report.integrity.counts.linksNotFollowed, 2, 'a link inside the station, or at nothing, is named');
    A.eq(linked.report.integrity.verbatim, false, 'and clears "exact"');
    A.eq(Recovery.restoreGate(linked).flags, [], 'and asks for no flag: a pnpm station must not teach anyone to pass it');
    A.ok(Recovery.integrityGaps(linked.report).some(x => x.path === 'agent/app/node_modules/pkg'), 'and is listed');
    makeLink(outside, 'agent/project');
    const dataLink = cap(linkWs);
    A.eq(dataLink.report.integrity.counts.symlinks, 1, 'a link out of the station at real data is a loss');
    A.eq(Recovery.restoreGate(dataLink).flags, ['--allow-incomplete'], 'and asks for the flag');
    for (const at of ['agent/app/node_modules/pkg', 'agent/empty-link', 'agent/project']) fs.unlinkSync(path.join(linkWs, ...at.split('/')));
  }
  const oldLinkRow = craft(cap(seed(fresh('old-link'))), b => { b.report.skipped.push({ path: 'agent/l', reason: 'symbolic links are not portable or safe to follow' }); b.report.integrity.verbatim = false; });
  A.eq(Recovery.restoreGate(oldLinkRow).flags, ['--allow-incomplete'], 'an old bundle\'s link row cannot say where it pointed, so it stays a gap');

  /* ---- empty directories ---- */
  const gitWs = seed(fresh('git'));
  write(gitWs, 'agent/repo/.git/HEAD', 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(gitWs, 'agent', 'repo', '.git', 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(gitWs, 'agent', 'repo', '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(gitWs, '.checkpoints', 'agent', 'git', 'refs', 'tags'), { recursive: true });
  const gitBundle = cap(gitWs);
  for (const d of ['agent/repo/.git/refs/heads', 'agent/repo/.git/objects', '.checkpoints/agent/git/refs/tags']) A.ok(gitBundle.directories.includes(d), 'captured: ' + d);
  const gitTarget = fresh('git-restored');
  const gitRec = Recovery.restore({ bundle: gitBundle, targetRoot: gitTarget });
  A.ok(fs.statSync(path.join(gitTarget, 'agent', 'repo', '.git', 'refs', 'heads')).isDirectory(), 'an empty folder a git repo needs comes back');
  A.ok(fs.statSync(path.join(gitTarget, '.checkpoints', 'agent', 'git', 'refs', 'tags')).isDirectory(), 'in a shadow repo too');
  A.eq(gitRec.directories, 3, 'the receipt counts them');
  A.eq(Recovery.rehearse({ bundle: gitBundle, scratchRoot: fs.mkdtempSync(path.join(root, 'r-')), now: 1 }).contentMatches, true, 'a rehearsal compares them');
  const lostDir = craft(gitBundle, b => { b.directories = b.directories.slice(1); });
  A.ok(Recovery.validate(lostDir).ok, 'a bundle with fewer folders is still a valid file');
  const noDirs = JSON.parse(JSON.stringify(cap(seed(fresh('no-dirs'))))); delete noDirs.directories;
  A.ok(Recovery.validate(noDirs).ok, 'a bundle from before this field keeps its manifest');
  A.ok(Recovery.restore({ bundle: noDirs, targetRoot: fresh('no-dirs-restored') }).restored.length > 0, 'and restores');

  /* ---- an exact copy of an agent's files ---- */
  const exactWs = seed(fresh('exact'));
  write(exactWs, 'agent/thesis.bak', 'chapter 1');
  write(exactWs, 'agent/draft.tmp.md', 'draft');
  write(exactWs, 'agent/data.tmp', 'data');
  write(exactWs, 'agent/old.corrupt-1-2', 'old');
  write(exactWs, 'agent/note.json', '{ /* comment */ }');
  write(exactWs, 'agent/note.json.bak', '{"bak":true}');
  write(exactWs, 'cron.jobs.json.bak', '{"jobs":[]}');
  write(exactWs, 'agent.notebook.json.tmp', 'x');
  const exact = cap(exactWs);
  for (const p of ['agent/thesis.bak', 'agent/draft.tmp.md', 'agent/data.tmp', 'agent/old.corrupt-1-2', 'agent/note.json.bak']) A.ok(exact.files.some(x => x.path === p), 'an agent\'s own file rides: ' + p);
  A.eq(Buffer.from(exact.files.find(x => x.path === 'agent/note.json').data, 'base64').toString(), '{ /* comment */ }', 'and is never swapped for its .bak');
  for (const p of ['cron.jobs.json.bak', 'agent.notebook.json.tmp']) A.eq(exact.files.some(x => x.path === p), false, 'a station store\'s bookkeeping stays out: ' + p);
  A.eq(exact.report.integrity.verbatim, true, 'and the bundle is exact');

  /* ---- .browsers is no deliverable ---- */
  const dotWs = seed(fresh('browsers'));
  write(dotWs, '.browsers/150/chrome.exe', 'x'.repeat(5000));
  A.eq(cap(dotWs).files.some(x => x.path.startsWith('.browsers/')), false, 'downloaded browsers are never captured');
  const oldBrowsers = craft(cap(seed(fresh('old-browsers'))), b => { b.files.push(fileRow('.browsers/1/a.exe', 'x')); });
  const oldBrowsersTarget = fresh('old-browsers-restored');
  Recovery.restore({ bundle: oldBrowsers, targetRoot: oldBrowsersTarget });
  A.eq(fs.existsSync(path.join(oldBrowsersTarget, '.browsers')), false, 'and an old bundle\'s do not land');

  /* ---- the largest gaps first ---- */
  const gaps = Recovery.integrityGaps({ skipped: [
    { path: 'a.bin', reason: 'too large for one recovery bundle', bytes: 10 },
    { path: 'b.bin', reason: 'too large for one recovery bundle', bytes: 900 },
    { path: 'z.json', reason: 'torn: does not parse' },
    { path: 'c.bin', reason: 'too large for one recovery bundle', bytes: 50 },
    { path: 'locks', reason: 'ephemeral lock/process/temp state' }
  ] });
  A.eq(gaps.map(x => x.path), ['z.json', 'b.bin', 'c.bin', 'a.bin'], 'a torn store first, then the largest left out');

  /* ---- a crafted bundle ---- */
  const base = cap(seed(fresh('crafted')));
  const refuses = (label, rel) => {
    const b = craft(base, x => { x.files.push(fileRow(rel, '{}')); });
    A.ok(!Recovery.validate(b).ok, 'validate refuses ' + label + ': ' + rel);
    throwsWith(() => Recovery.restore({ bundle: b, targetRoot: fresh('crafted-target') }), /refusing invalid recovery bundle/, 'restore refuses ' + label);
  };
  refuses('an owner generation that would lock the user out', '.starnet-workspace-owner.json.generations/999.json');
  refuses('an owner file', '.starnet-workspace-owner.json');
  refuses('a browser profile', '.browser-profile/Cookies');
  refuses('a cron lock', 'cron.lock');
  refuses('a process ledger', 'proc-ledger.json');
  refuses('a parent segment hidden by a trailing space', '.. /x');
  refuses('a drive path', 'C:/Windows/x');
  refuses('a parent segment', '../outside');
  refuses('an absolute path', '/etc/x');
  refuses('a provider credential folder', '.secrets/x.json');
  const badDir = craft(base, x => { x.directories = ['../outside']; });
  A.ok(!Recovery.validate(badDir).ok, 'an unsafe directory row is refused');
  // a raw credential store inside a validly hashed bundle comes back cleaned
  const rawStore = craft(base, x => { x.files.push(fileRow('connectors/state.json', JSON.stringify({ version: 2, configs: [{ id: 'n', token: 'canary-raw-store' }], oauth: { byId: { n: { accessToken: 'canary-raw-oauth' } } } }))); });
  const rawTarget = fresh('raw-store');
  const rawReceipt = Recovery.restore({ bundle: rawStore, targetRoot: rawTarget });
  const rawLanded = fs.readFileSync(path.join(rawTarget, 'connectors', 'state.json'), 'utf8');
  A.eq(/canary-raw/.test(rawLanded), false, 'a raw credential store is sanitized on the way in');
  A.ok(/"id": "n"/.test(rawLanded), 'and keeps its connector list');
  A.ok(rawReceipt.reauthentication.some(x => x.kind === 'connector' && x.id === 'n'), 'and lists the connector');
  const unparsed = craft(base, x => { x.files.push(fileRow('channels/secrets.json', '{"telegram":{"token":"canary-torn"')); });
  const unparsedTarget = fresh('unparsed');
  const unparsedReceipt = Recovery.restore({ bundle: unparsed, targetRoot: unparsedTarget });
  A.eq(fs.existsSync(path.join(unparsedTarget, 'channels', 'secrets.json')), false, 'a store that cannot be sanitized does not land');
  A.ok(unparsedReceipt.droppedOnRestore.some(x => x.path === 'channels/secrets.json'), 'and the receipt says so');
  // the words: inspect must never read as proof of who made the file
  const liar = craft(cap(seed(fresh('liar'))), b => { b.report.skipped = []; });
  const liarSeen = out(run(['inspect', '--bundle', bundleFile('liar', liar)]));
  A.ok(/not signed/.test(liarSeen.verdict.authenticity) && /only a bundle you made yourself/.test(liarSeen.verdict.authenticity), 'inspect says a bundle is not authenticated and whose to restore');
  A.ok(/not encrypted/.test(liarSeen.verdict.readable), 'and that it is readable');

  /* ---- an unportable name on the way out ---- */
  const posix = process.platform !== 'win32';
  if (posix) {
    const nameWs = seed(fresh('names'));
    write(nameWs, 'agent/a:b.txt', 'x');
    const named = cap(nameWs);
    A.eq(named.files.some(x => x.path === 'agent/a:b.txt'), false, 'a name Windows cannot store stays out');
    A.eq(named.report.integrity.counts.unportable, 1, 'and is counted as a gap');
    A.ok(Recovery.validate(named).ok, 'so the bundle is still valid');
  } else {
    A.eq(Recovery._internals.classifyPolicy('agent/a:b.txt', null).reason, 'unportable name: character Windows cannot store', 'a name Windows cannot store stays out');
    A.ok(Recovery._internals.classifyPolicy('agent/report.md', null).action === 'include', 'an ordinary name does not');
  }

  /* ---- a case-sensitive station ---- */
  const caseBundle = craft(cap(seed(fresh('case'))), b => { b.files.push(fileRow('agent/Foo.txt', 'a'), fileRow('agent/foo.txt', 'b')); });
  A.ok(Recovery.validate(caseBundle).ok, 'names differing only by case are a valid bundle');
  A.ok(!Recovery.validate(craft(cap(seed(fresh('dup'))), b => { b.files.push(fileRow('agent/x.txt', 'a'), fileRow('agent/x.txt', 'a')); })).ok, 'an exact duplicate is not');
  const caseTarget = fresh('case-target');
  fs.mkdirSync(path.dirname(caseTarget), { recursive: true });
  const probe = path.join(path.dirname(caseTarget), 'CaseProbe');
  fs.writeFileSync(probe, 'x');
  const insensitive = fs.existsSync(path.join(path.dirname(caseTarget), 'caseprobe'));
  if (insensitive) {
    let msg = '';
    try { Recovery.restore({ bundle: caseBundle, targetRoot: caseTarget }); } catch (e) { msg = e.message; }
    A.ok(/differ only by case/.test(msg), 'a disk that cannot hold both says so instead of losing one: ' + msg);
    A.eq(fs.existsSync(caseTarget), false, 'and nothing lands');
    A.eq(fs.readdirSync(path.dirname(caseTarget)).filter(n => /restore-stage/.test(n)), [], 'and no stage stays');
  } else {
    Recovery.restore({ bundle: caseBundle, targetRoot: caseTarget });
    A.eq(fs.readFileSync(path.join(caseTarget, 'agent', 'foo.txt'), 'utf8'), 'b', 'a disk that can hold both does');
  }

  /* ---- the command printed is the command that runs ---- */
  const hostile = path.join(root, "o'brien $HOME $& $' %TEMP% `x", 'my.starnet-recovery.json');
  fs.mkdirSync(path.dirname(hostile), { recursive: true });
  const printed = seed(fresh('printed'));
  A.eq(run(['backup', '--workspace', printed, '--output', hostile]).status, 0, 'a bundle lands at an awkward path');
  const line = Recovery.shellCommand(process.platform, [process.execPath, CLI, 'inspect', '--bundle', hostile]);
  const shell = process.platform === 'win32'
    ? cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], { cwd: root, encoding: 'utf8' })
    : cp.spawnSync('/bin/sh', ['-c', line], { cwd: root, encoding: 'utf8' });
  A.eq(shell.status, 0, 'the real string runs in ' + Recovery.shellName(process.platform) + ': ' + line + ' ' + shell.stderr);
  A.eq(JSON.parse(shell.stdout).file, hostile, 'and reaches the very file');
  if (process.platform === 'win32') A.ok(line.startsWith('& '), 'PowerShell runs a quoted path with the call operator');
  A.eq(Backup.recoveryCheckCommand({ commands: { rehearse: 'R', restore: 'X' } }), 'R', 'COPY takes the check alone, so a paste can never start a restore');
  A.eq(Backup.recoveryCheckCommand({ commands: { restore: null } }), '', 'and a copy with no CLI has nothing to copy');
  const steps = Backup.recoverySteps({ shell: 'PowerShell', bundleKnown: true, commands: { rehearse: "& 'n' 'c' $& rehearse", restore: "& 'n' 'c' $' restore" } });
  A.ok(steps.indexOf("& 'n' 'c' $& rehearse") >= 0 && steps.indexOf("& 'n' 'c' $' restore") >= 0, 'the page prints the server\'s string untouched');
  A.ok(/Run these in PowerShell/.test(steps), 'and names the shell');
  A.ok(/made yourself/.test(steps), 'and whose bundle to restore');
  A.eq(Backup.recoverySteps({ commands: { restore: null } }), '', 'a copy with no CLI prints no command');

  /* ---- a failed move-back says where the station is ---- */
  const failWs = seed(fresh('displaced'));
  const failBundle = cap(failWs);
  const realRename = fs.renameSync;
  let renames = 0, thrown = null;
  const failingFs = Object.assign({}, fs, { renameSync(from, to) {
    renames++;
    if (renames === 1) return realRename(from, to);     // the station moves aside
    throw Object.assign(new Error('held by a scanner'), { code: 'EPERM' });
  } });
  try { Recovery.restore({ bundle: failBundle, targetRoot: failWs, replaceExisting: true, rollbackId: 'held', fs: failingFs, retryDelays: [] }); } catch (e) { thrown = e; }
  const rollbackPath = failWs + '.rollback-held';
  A.ok(thrown && thrown.stationDisplaced && thrown.stationDisplaced.rollback === rollbackPath, 'the error names where the station is');
  A.ok(fs.existsSync(path.join(rollbackPath, 'agent.save.json')), 'and it is there');
  const words = failureOf('restore', thrown);
  A.ok(words.recover.indexOf(rollbackPath) >= 0 && /DO NOT OPEN STARNET/.test(words.recover), 'the person is told where and not to launch');
  A.ok(/antivirus/.test(words.hint), 'and what usually holds a folder');
  A.ok(words.rollbackError, 'and that the move back failed');
  realRename(rollbackPath, failWs);
  // the same failure through the real CLI, where what holds the station also holds the browser file: the browser cleanup
  // fails too, and must not replace the error that says where the station went
  const heldWs = seed(fresh('held'));
  const heldBundle = bundleFile('held', cap(heldWs));
  fs.writeFileSync(path.join(path.dirname(heldWs), 'starnet-browser-restore.json'), '{"earlier":true}');
  const preload = path.join(path.dirname(heldWs), 'hold.js');
  fs.writeFileSync(preload, `
    const fs = require('fs'), T = process.env.HOLD_TARGET, rename = fs.renameSync, unlink = fs.unlinkSync;
    const held = () => Object.assign(new Error('held by a scanner'), { code: 'EIO' });
    fs.renameSync = (a, b) => { if (b === T || /restore-rollback-/.test(a)) throw held(); return rename(a, b); };
    fs.unlinkSync = p => { if (/starnet-browser-restore\\.json$/.test(p)) throw held(); return unlink(p); };
  `);
  const heldRun = cp.spawnSync(process.execPath, ['-r', preload, CLI, 'restore', '--bundle', heldBundle, '--target', heldWs, '--replace-existing'], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { HOLD_TARGET: heldWs }) });
  A.ok(heldRun.status !== 0, 'the CLI reports the failure');
  const heldErr = JSON.parse(heldRun.stderr.slice(heldRun.stderr.indexOf('{\n  "ok"')));
  A.ok(heldErr.stationDisplaced && fs.existsSync(path.join(heldErr.stationDisplaced.rollback, 'agent.save.json')), 'it still names where the station is: ' + heldRun.stderr.slice(-400));
  A.ok(/DO NOT OPEN STARNET/.test(heldErr.recover) && heldErr.recover.indexOf(heldErr.stationDisplaced.rollback) >= 0, 'and how to recover');
  A.ok(/opened anyway/.test(heldErr.recover), 'even if it was opened');
  // a brief hold is waited out, with no error at all
  let held = 2;
  const retryFs = Object.assign({}, fs, { renameSync(from, to) { if (held-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return realRename(from, to); } });
  Recovery._internals.renameRetry(retryFs, path.join(failWs, 'loops.json'), path.join(failWs, 'loops2.json'), [1, 1]);
  A.ok(fs.existsSync(path.join(failWs, 'loops2.json')), 'a brief hold is waited out');
  let denied = 0;
  const hard = Object.assign({}, fs, { renameSync() { denied++; throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  A.throws(() => Recovery._internals.renameRetry(hard, 'a', 'b', [1, 1]), 'another error is not retried');
  A.eq(denied, 1, 'only once');

  /* ---- writes are flushed, and the replace flag is rechecked ---- */
  const flushed = [];
  const flushFs = Object.assign({}, fs, { fsyncSync(fd) { flushed.push(fd); return fs.fsyncSync(fd); } });
  const flushBundle = cap(seed(fresh('flush')));
  Recovery.restore({ bundle: flushBundle, targetRoot: fresh('flush-target'), fs: flushFs });
  A.eq(flushed.length, flushBundle.files.length, 'every restored file is flushed');
  const lateTarget = fresh('late');
  A.throws(() => Recovery.restore({ bundle: flushBundle, targetRoot: lateTarget, beforeActivate() { seed(lateTarget); } }), 'a folder that appears during staging is not replaced');
  A.ok(fs.existsSync(path.join(lateTarget, 'agent.save.json')), 'and stays');

  /* ---- output never overwrites, and never lands in the station ---- */
  const outWs = seed(fresh('output'));
  const existing = path.join(root, 'existing.starnet-recovery.json');
  fs.writeFileSync(existing, 'mine');
  const over = run(['backup', '--workspace', outWs, '--output', existing]);
  A.ok(over.status !== 0 && /already exists/.test(over.stderr), 'an existing output is refused');
  A.eq(fs.readFileSync(existing, 'utf8'), 'mine', 'and is untouched');
  const inner = path.join(outWs, 'b.starnet-recovery.json');
  const innerRun = run(['backup', '--workspace', outWs, '--output', inner]);
  A.ok(innerRun.status !== 0 && /inside the station/.test(innerRun.stderr), 'an output inside the station is refused');
  A.eq(fs.existsSync(inner), false, 'and writes nothing');

  /* ---- a switch is a switch ---- */
  A.eq(flag({ 'replace-existing': 'false' }, 'replace-existing'), false, '=false is no');
  A.eq(flag({ 'replace-existing': true }, 'replace-existing'), true, 'a bare flag is yes');
  A.throws(() => flag({ 'replace-existing': 'nope' }, 'replace-existing'), 'anything else is an error');
  const switchWs = seed(fresh('switch'));
  const switchBundle = bundleFile('switch', cap(seed(fresh('switch-source'))));
  const no = run(['restore', '--bundle', switchBundle, '--target', switchWs, '--replace-existing=false']);
  A.ok(no.status !== 0 && /not clean/.test(no.stderr), '--replace-existing=false does not replace');
  A.eq(fs.readdirSync(path.dirname(switchWs)).filter(n => /rollback/.test(n)), [], 'nothing moved');

  /* ---- what a stopped process left ---- */
  const leftovers = fresh('leftovers');
  const leftParent = path.dirname(leftovers);
  fs.mkdirSync(leftParent, { recursive: true });
  fs.mkdirSync(leftovers + '.restore-stage-999999-abc');
  fs.writeFileSync(path.join(leftovers + '.restore-stage-999999-abc', 'x'), 'y');
  fs.writeFileSync(path.join(leftParent, 'starnet-browser-restore.json.restore-stage-999999-1'), 'z');
  fs.mkdirSync(leftovers + '.restore-stage-' + process.pid + '-live');
  A.eq(run(['restore', '--bundle', switchBundle, '--target', leftovers]).status, 0, 'a restore over leftovers works');
  A.eq(fs.existsSync(leftovers + '.restore-stage-999999-abc'), false, 'a dead process\'s stage is removed');
  A.eq(fs.existsSync(path.join(leftParent, 'starnet-browser-restore.json.restore-stage-999999-1')), false, 'and its browser stage');
  A.ok(fs.existsSync(leftovers + '.restore-stage-' + process.pid + '-live'), 'a live process\'s is not');

  const dl = path.join(root, 'Downloads'); fs.mkdirSync(dl);
  const named = n => path.join(dl, n);
  fs.writeFileSync(named('starnet-recovery-20261101-120000.starnet-recovery.json.tmp-999999-abcdef0123456789'), 'plaintext');
  fs.writeFileSync(named('starnet-recovery-20261101-120000-2.starnet-recovery.json.tmp-' + process.pid + '-abcdef0123456789'), 'live');
  fs.writeFileSync(named('starnet-recovery-20261101-120000.starnet-recovery.json'), 'finished');
  fs.writeFileSync(named('thesis.tmp-999999-abc'), 'someone else\'s');
  const swept = sweepBackupTemps({ fs, path, dir: dl, pidAlive: pid => pid === process.pid });
  A.eq(swept.removed.length, 1, 'a dead writer\'s unfinished bundle is removed at boot');
  A.eq(fs.readdirSync(dl).length, 3, 'and nothing else: a live writer, a finished bundle and another program\'s file stay');
  A.eq(sweepBackupTemps({ fs, path, dir: path.join(root, 'nope') }).errors, [], 'a folder that is not there is no error');

  /* ---- the chip does not offer a restart during a capture ---- */
  let release;
  const pending = Backup.createRecoveryBundle({ post: () => new Promise(res => { release = res; }) });
  await new Promise(res => setTimeout(res, 5));
  A.eq(Backup.isCapturing(), true, 'a capture in flight is known');
  release({ ok: false, status: 409, j: { ok: false, error: 'x', leftFile: 'D:\\left.json' } });
  const left = await pending;
  A.eq(Backup.isCapturing(), false, 'and ends');
  A.ok(!left.ok && left.line.indexOf('D:\\left.json') >= 0 && /holds your station/.test(left.line), 'a file left behind by a failed check is named, never "no bundle was written"');

  fs.rmSync(root, { recursive: true, force: true });
  A.report('station-recovery-safety.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
