/* node test/station-recovery-unreadable.test.js — one unreadable entry can never abort a whole-station capture (#91).

   Reported on Windows 0.13.1: directory enumeration under .checkpoints/<agent>/git returned an entry (a zero-length
   reparse point) that lstat/readlink/realpath all answered ENOENT. walkFiles called lstat unguarded, so the throw
   aborted capture -> "Update paused - no verified recovery point was created" on every in-app update attempt.

   The #91 shape is reproduced EXACTLY with the real filesystem: readdir hands back a name the real lstat cannot
   resolve, so the ENOENT is Node's own, not a synthesized error. Locked/permission-denied entries (EBUSY/EPERM)
   are injected because Windows will not let a test create them without admin rights.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const R = require('../sidecar/station-recovery.js');
const Save = require('../frontend/app/save.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeUpdatePreparation } = require('../sidecar/update-preparation.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-unreadable-'));
const source = path.join(tmp, 'profile', 'workspaces');
function write(rel, value) {
  const file = path.join(source, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
const norm = p => path.resolve(p).toLowerCase();
const at = rel => norm(path.join(source, ...rel.split('/')));

// Every required category present, plus a shadow-Git checkpoint repo and a live browser profile.
write('agent.roster.json', { version: 1, agents: [{ agentId: 'auditor', name: 'AUDITOR' }] });
write('agent.roster.json.bak', { version: 1, agents: [{ agentId: 'auditor', name: 'AUDITOR-LKG' }] });   // savestore's last-known-good generation
write('auditor.save.json', { version: 1, agentId: 'auditor', updatedAt: 1, doc: { schema: 'starnet.save', version: Save.CURRENT, updatedAt: 1, agent: { id: 'auditor' } } });
write('transcript.jsonl', JSON.stringify({ role: 'user', content: 'keep me', ts: 1 }) + '\n');
write('auditor.notebook.json', { entries: [{ id: 'm1', body: 'remember' }] });
write('cron.jobs.json', { version: 1, jobs: [] });
write('loops.json', { version: 1, loops: [] });
write('auditor.todo.json', { items: [] });
write('projects.json', { version: 1, projects: [] });
write('auditor.deliverables.json', { version: 1, records: [] });
write('permissions.allow.json', { version: 1, allow: ['fs.write:workspace'] });
write('connectors/servicekeys.json', { version: 1, keys: [] });
write('.checkpoints/auditor/git/HEAD', 'ref: refs/heads/main\n');
write('.checkpoints/auditor/git/objects/ab/cdef', 'blob');
write('.checkpoints/auditor/git/locked-pack', 'pack');
write('.checkpoints/auditor/git/denied/inner', 'x');
write('.browser-profile/Default/Cookies', 'COOKIE');
write('.secrets/spotify.json', { accessToken: 'SPOTIFY_SECRET' });
fs.mkdirSync(path.join(source, 'codex'));   // an EMPTY provider dir: nothing to exclude, so no reauth receipt

const GHOST = '.checkpoints/auditor/git/tw40mZg';   // the #91 entry: enumerated, but lstat says ENOENT
const touched = [];
function fsWith(extra) {
  const x = extra || {};
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'readdirSync') return function (p, ...rest) {
        touched.push(norm(p));
        if (x.readdirFail && norm(p) === at(x.readdirFail.rel)) throw Object.assign(new Error(x.readdirFail.code + ': scandir'), { code: x.readdirFail.code });
        const names = target.readdirSync(p, ...rest);
        return norm(p) === at('.checkpoints/auditor/git') ? names.concat(path.basename(GHOST)) : names;
      };
      if (prop === 'lstatSync') return function (p, ...rest) {
        touched.push(norm(p));
        const lf = [].concat(x.lstatFail || []).find(l => norm(p) === norm(l.abs));
        if (lf) throw Object.assign(new Error(lf.code + ': lstat'), { code: lf.code });
        return target.lstatSync(p, ...rest);
      };
      if (prop === 'readFileSync') return function (p, ...rest) {
        if (typeof p === 'string' && x.readFail && norm(p) === at(x.readFail.rel)) throw Object.assign(new Error(x.readFail.code + ': open'), { code: x.readFail.code });
        return target.readFileSync(p, ...rest);
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
}

try {
  // Proof the fixture is the #91 shape: the REAL lstat on the enumerated name throws ENOENT.
  let realCode = null;
  try { fs.lstatSync(path.join(source, ...GHOST.split('/'))); } catch (e) { realCode = e.code; }
  A.eq(realCode, 'ENOENT', 'fixture: the enumerated #91 entry really answers lstat with ENOENT');

  // A. The vanished/unreadable entry is skipped with a truthful receipt; everything else is captured.
  touched.length = 0;
  let bundle = null, threw = null;
  try {
    bundle = R.capture({ workspaceRoot: source, fs: fsWith({ readdirFail: { rel: '.checkpoints/auditor/git/denied', code: 'EPERM' }, readFail: { rel: '.checkpoints/auditor/git/locked-pack', code: 'EBUSY' } }), now: 1000, appVersion: 'test' });
  } catch (e) { threw = e; }
  A.eq(threw && threw.message, null, 'an unreadable entry under .checkpoints does not abort the capture');
  if (bundle) {
    const skip = rel => (bundle.report.skipped || []).find(s => s.path === rel);
    A.eq(skip(GHOST) && skip(GHOST).reason, 'unreadable: ENOENT', 'the #91 entry is listed as skipped with its real code');
    A.eq(skip('.checkpoints/auditor/git/denied') && skip('.checkpoints/auditor/git/denied').reason, 'unreadable: EPERM', 'an unlistable directory is listed with its code');
    A.eq(skip('.checkpoints/auditor/git/locked-pack') && skip('.checkpoints/auditor/git/locked-pack').reason, 'unreadable: EBUSY', 'a locked file is listed with its code');
    const paths = bundle.files.map(f => f.path);
    A.ok(paths.includes('.checkpoints/auditor/git/HEAD') && paths.includes('.checkpoints/auditor/git/objects/ab/cdef'), 'readable checkpoint history is still captured');
    A.eq(paths.some(p => p === GHOST || p.indexOf('locked-pack') >= 0 || p.indexOf('/denied/') >= 0), false, 'no unreadable entry rides as a fake payload');
    A.eq(bundle.report.complete, true, 'an unreadable checkpoint object does not fake a missing semantic category');
    A.eq(R.validate(bundle).ok, true, 'the bundle with skipped entries still validates (every payload checksum-bound)');
    const file = path.join(tmp, 'snap', 'unreadable.starnet-backup.json');
    R.writeBundleAtomic({ bundle, file });
    A.eq(R.readBundle(file).manifestSha256, bundle.manifestSha256, 'the bundle commits and reads back');

    // B. Runtime/credential top-level directories are skipped WHOLE: never descended, one receipt each.
    A.ok(!touched.some(p => p.indexOf(at('.browser-profile') + path.sep) === 0), '.browser-profile is never walked (a live Chrome profile cannot abort the capture)');
    A.ok(!touched.some(p => p.indexOf(at('.secrets') + path.sep) === 0), '.secrets is never walked');
    A.ok(!!skip('.browser-profile'), 'the browser profile keeps an explicit skip receipt');
    A.ok(!!skip('.secrets'), 'the credential store keeps an explicit skip receipt');
    A.ok(bundle.report.reauthentication.some(x => x.kind === 'credential-store' && x.id === '.secrets'), 'skipping .secrets whole still earns its reauthentication receipt');
    A.eq(bundle.report.reauthentication.some(x => x.id === 'codex'), false, 'an EMPTY provider dir claims no credentials to re-establish');
    A.eq(JSON.stringify(bundle).indexOf('SPOTIFY_SECRET') < 0 && JSON.stringify(bundle).indexOf('COOKIE') < 0, true, 'skipped-whole directories leak nothing');
  }

  // C. Completeness stays truthful: an unreadable file that was a category's only member reads 'missing'.
  const lost = R.capture({ workspaceRoot: source, fs: fsWith({ readFail: { rel: 'loops.json', code: 'EBUSY' } }), now: 1001 });
  A.eq(lost.report.complete, false, 'an unreadable sole loop store makes the bundle incomplete, never silently complete');
  A.ok(lost.report.requirements.some(x => x.category === 'loops' && x.status === 'missing'), 'the lost category is named');
  A.ok(lost.report.skipped.some(s => s.path === 'loops.json' && s.reason === 'unreadable: EBUSY'), 'and the reason is on the receipt');

  // D. Fail-closed where it matters: an unreadable ROOT, and an error that is not an entry-level read failure.
  A.throws(() => R.capture({ workspaceRoot: source, fs: fsWith({ readdirFail: { rel: '', code: 'EACCES' } }), now: 1002 }), 'an unlistable capture ROOT still fails closed');
  A.throws(() => R.capture({ workspaceRoot: source, fs: fsWith({ readFail: { rel: 'loops.json', code: 'EIO' } }), now: 1003 }), 'a disk I/O error is not quietly skipped');

  // F. An lstat failure on a whole-skipped credential dir still names the sign-in the restored profile owes. A dropped
  //    receipt would restore a station that never says its .secrets / codex sign-in is gone.
  {
    const cred = R.capture({ workspaceRoot: source, fs: fsWith({ lstatFail: [{ abs: path.join(source, '.secrets'), code: 'EPERM' }, { abs: path.join(source, 'codex'), code: 'EACCES' }] }), now: 1004 });
    const skip = rel => (cred.report.skipped || []).find(s => s.path === rel);
    A.ok(cred.report.reauthentication.some(x => x.kind === 'credential-store' && x.id === '.secrets'), 'an lstat-failed .secrets keeps its credential-store reauthentication receipt');
    A.ok(cred.report.reauthentication.some(x => x.kind === 'provider' && x.id === 'codex'), 'an lstat-failed provider dir keeps its provider reauthentication receipt');
    A.eq(skip('.secrets') && skip('.secrets').reason, 'system-managed credential material is intentionally excluded', '.secrets is skipped by POLICY (it is excluded either way), not as a lost unreadable entry');
  }

  // G. An unreadable store falls back to its last-known-good .bak, exactly like a torn one — the recovery point never
  //    silently loses agent.roster.json while another file keeps its category reading 'present'.
  {
    const busy = R.capture({ workspaceRoot: source, fs: fsWith({ readFail: { rel: 'agent.roster.json', code: 'EBUSY' } }), now: 1005 });
    const roster = busy.files.find(f => f.path === 'agent.roster.json');
    A.ok(!!roster, 'a locked agent.roster.json still rides in the bundle');
    A.ok(roster && /AUDITOR-LKG/.test(Buffer.from(roster.data, 'base64').toString('utf8')), 'carrying its last-known-good .bak bytes');
    A.ok(busy.report.skipped.some(s => s.path === 'agent.roster.json' && s.reason === 'unreadable: EBUSY'), 'the unreadable main is still on the receipt with its code');
    A.ok(busy.report.skipped.some(s => s.path === 'agent.roster.json.bak' && /^promoted: /.test(s.reason)), 'and the promotion is recorded');
    A.eq(R.validate(busy).ok, true, 'the promoted bundle validates');
    const both = R.capture({ workspaceRoot: source, fs: fsWith({ readFail: { rel: 'loops.json', code: 'EBUSY' } }), now: 1006 });
    A.eq(both.files.some(f => f.path === 'loops.json'), false, 'with no .bak an unreadable store is dropped, never faked');
  }

  // H. A WORKSPACES root reached through a junction (or symlink) is the station itself, not a link to skip: capture()
  //    validated it with stat, the walk lstat'ed it and recorded ONE symlink skip and zero files.
  {
    const link = path.join(tmp, 'linked-workspaces');
    let linked = false;
    try { fs.symlinkSync(source, link, 'junction'); linked = true; } catch (e) { console.log('  (skipped junction root: ' + e.code + ')'); }
    if (linked) {
      const viaLink = R.capture({ workspaceRoot: link, now: 1007 });
      const direct = R.capture({ workspaceRoot: source, now: 1007 });
      A.eq(viaLink.files.map(f => f.path), direct.files.map(f => f.path), 'a junctioned root captures the same files as the real directory');
      A.ok(viaLink.files.length > 5 && viaLink.report.complete === true, 'and is complete, never an empty bundle');
      fs.unlinkSync(link);
    }
  }

  // E. End to end through the update barrier: prepare() succeeds and the receipt names what it could not read.
  (async () => {
    const prep = makeUpdatePreparation({
      fs, path, workspaceRoot: source, writeDurable: writeFileDurable, now: () => 5000, newId: () => 'unreadable',
      recovery: Object.assign({}, R, { capture: o => R.capture(Object.assign({}, o, { fs: fsWith() })) }),
      sleep: async () => {}
    });
    const made = await prep.prepare({ targetVersion: '9.9.9', browserStore: {} });
    A.eq(made.ok, true, 'the in-app update gets its verified recovery point despite the #91 entry (was: UPDATE paused, ENOENT lstat)');
    A.ok(made.receipt && Array.isArray(made.receipt.unreadable) && made.receipt.unreadable.some(s => s.path === GHOST && s.reason === 'unreadable: ENOENT'),
      'the durable receipt names the entry it could not read (never claims a byte-complete station)');
    const back = made.receipt && JSON.parse(fs.readFileSync(made.receipt.receiptFile, 'utf8'));
    A.ok(back && back.unreadable && back.unreadable.length === made.receipt.unreadable.length, 'the unreadable list survives in the on-disk receipt');
    prep.cancel();
  })().catch(e => { A.ok(false, 'update preparation threw: ' + ((e && e.stack) || e)); }).finally(() => {
    try { for (const name of fs.readdirSync(path.join(tmp, 'profile', 'update-snapshots'))) fs.chmodSync(path.join(tmp, 'profile', 'update-snapshots', name), 0o666); } catch (_) {}
    fs.rmSync(tmp, { recursive: true, force: true });
    A.report('station-recovery-unreadable.test');
  });
} catch (e) {
  fs.rmSync(tmp, { recursive: true, force: true });
  throw e;
}
