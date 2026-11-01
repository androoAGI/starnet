/* node test/journey-read-cache.test.js — the quest + journey READ CACHE and the pending-only journey reconcile
   (2026-10-19, idle-CPU pass). Real fs in a temp dir (durable.signature() needs a real bigint stat), wrapped so every
   readFileSync of the two ledger files is counted and a sharing lock (EBUSY) can be injected. Never boots
   sidecar/index.js: the reconcile body below is reconcileCompletedJourneyQuests' loop, verbatim.
   Pins: reads are served from the cache while the file is provably unchanged; every write (in-process or external,
   same-size in-place included) invalidates; recovered/unreadable/absent reads stay loud and uncached; the reconcile
   filter folds EXACTLY the quests recordQuest would write (parity matrix) and produces identical ledger bytes; and
   the cached objects survive every audited reader deep-frozen (the READ-ONLY contract). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const realFs = require('fs');
const os = require('os');
const path = require('path');
const QS = require('../sidecar/quest-store.js');
const { makeJourneyStore } = require('../sidecar/journey-store.js');
const QuestRefresh = require('../sidecar/questrefresh.js');
const GoalAdvance = require('../sidecar/goal-advance.js');
const QuestSweeps = require('../sidecar/questsweeps.js');
const { questBlock } = require('../sidecar/questinject.js');
const { makeQuestTools } = require('../sidecar/tools/builtin/quests.js');
const failopen = require('../sidecar/failopen.js');

const root = realFs.mkdtempSync(path.join(os.tmpdir(), 'starnet-journey-cache-'));
const QFILE = '_station.quests.json', JFILE = '_station.journey.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { realFs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn('[journey-read-cache] temp cleanup failed:', e && e.message); } };
const plainWrite = ({ fs }, file, data) => fs.writeFileSync(file, data);
const stamp = f => { try { const s = realFs.statSync(f, { bigint: true }); return s.ino + ':' + s.size + ':' + s.mtimeNs; } catch (e) { return e.code; } };

// the real fs, with readFileSync counted per basename; names in `lock` read as EBUSY (an antivirus / sharing lock)
function countingFs() {
  const c = Object.create(realFs);
  c.reads = {}; c.lock = new Set();
  c.readFileSync = function (f, enc) {
    const b = path.basename(String(f));
    c.reads[b] = (c.reads[b] || 0) + 1;
    if (c.lock.has(b)) { const e = new Error('EBUSY: resource busy (injected)'); e.code = 'EBUSY'; throw e; }
    return realFs.readFileSync(f, enc);
  };
  c.zero = () => { c.reads = {}; };
  return c;
}
// the in-memory fake every existing store test uses: NO statSync, so no signature and no cache (the legacy path)
function memFs(seed) {
  const files = new Map(Object.entries(seed || {}));
  const m = {
    files, reads: 0,
    readFileSync(f) { m.reads++; if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); }, mkdirSync() {}, unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
  return m;
}
const MEM_J = path.join('/ws', JFILE), MEM_Q = path.join('/ws', QFILE);

const DOM = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];
function questRow(i, status, extra) {
  const attest = i % 3 === 0, done = status === 'done';
  return Object.assign({
    id: 'q:' + i, title: 'Step ' + i + ' of the launch', desc: 'Finish it and verify it live', reward: 'a real step toward the goal',
    kind: 'generated', createdBy: 'system:quest-refresh', agentId: i % 4 ? 'agent' : null,
    contract: attest ? { type: 'attest', key: '' } : { type: 'run', key: 'run-' + i },
    steps: [{ key: 's1', label: 'draft', done: true }, { key: 's2', label: 'ship', done: done }], status: status,
    attest: attest && done ? { source: 'commander', agentId: null, runId: null, evidence: 'I did it and here is the link', at: 5, confirmed: true } : null,
    domain: DOM[i % 8], goalId: 'g' + (i % 3), milestoneId: 'm' + (i % 7), completedBy: done && !attest ? 'agent' : null,
    disposition: (!done && i % 5 === 0) ? { type: 'later', reason: 'busy', at: 1, snoozeUntil: 9e15 } : null,
    createdAt: 1000 + i, completedAt: done ? 2000 + i : null
  }, extra || {});
}
// a goal-registered journey, folded (in memory, no fsync) from `foldRows`; returns the journey file bytes.
// opts.raw folds the rows as given (the parity matrix's ids over the ledger's own 40-char clip), else as the ledger stores them.
async function journeyBytes(foldRows, opts) {
  const m = memFs(), s = makeJourneyStore({ fs: m, path, workspaces: '/ws', writeDurable: plainWrite });
  for (let g = 0; g < 3; g++) await s.registerGoal({ id: 'g' + g, text: 'Goal ' + g, successCondition: 'ten customers renew' }, 10);
  if (opts && opts.resetAt) await s.reset(opts.resetAt, 2);
  for (const q of (opts && opts.raw ? foldRows : QS.normalize({ quests: foldRows }).quests)) if (q.status === 'done') await s.recordQuest(q, null, q.completedAt || 7777);
  return m.files.get(MEM_J);
}
async function seedStation(dir, rows, foldRows) {
  realFs.mkdirSync(dir, { recursive: true });
  realFs.writeFileSync(path.join(dir, QFILE), JSON.stringify({ v: 1, seq: rows.length, quests: rows, deniedTitles: ['old idea one', 'old idea two'] }));
  const jb = await journeyBytes(foldRows || rows);
  realFs.writeFileSync(path.join(dir, JFILE), jb);
  realFs.writeFileSync(path.join(dir, JFILE + '.bak'), jb);
}
const stores = (fs, dir, extra) => ({
  qs: QS.makeQuestStore(Object.assign({ fs, path, workspaces: dir }, extra && extra.q)),
  js: makeJourneyStore(Object.assign({ fs, path, workspaces: dir }, extra && extra.j))
});
const reconcile = async (js, qs, goal) => {   // index.js reconcileCompletedJourneyQuests, the loop body verbatim
  for (const q of js.pendingQuestFolds(qs.list())) await js.recordQuest(q, goal, q.completedAt || 7777);
};

(async () => {
  // ---- 0. the host's reconcile IS the loop this file exercises (read as source: never require index.js) ----
  {
    const body = A.fnBody(readSidecarSource(), 'function reconcileCompletedJourneyQuests(');
    A.ok(body.length > 100 && body.length < 2000, 'fixture: found reconcileCompletedJourneyQuests (' + body.length + ' chars)');
    A.ok(body.indexOf('for (const q of journeyStore.pendingQuestFolds(questStore.list())) {') >= 0
      && body.indexOf('await journeyStore.recordQuest(q, commanderGoals.get(), q.completedAt || Date.now());') >= 0,
      'the host reconcile replays only pendingQuestFolds, through recordQuest (the loop reproduced below)');
  }

  // ---- 1+2. the idle station: 290 done (all folded) + 10 open ----
  {
    const dir = path.join(root, 'idle');
    const rows = []; for (let i = 1; i <= 300; i++) rows.push(questRow(i, i <= 290 ? 'done' : 'open'));
    await seedStation(dir, rows);
    const cfs = countingFs(), { qs, js } = stores(cfs, dir);
    for (let i = 0; i < 10; i++) js.read();
    A.eq(cfs.reads[JFILE] || 0, 1, '10 journey reads parse the file ONCE while it is unchanged (was 10)');
    A.ok(js.read() === js.read(), 'an unchanged journey serves the same parsed record');
    qs.list(); qs.list(); qs.list(); qs.list(); qs.get('q:7');
    A.eq(cfs.reads[QFILE] || 0, 1, '4 list() + 1 get() parse the ledger ONCE (was 5)');
    A.eq(qs.list().length, 300, 'the cached ledger is the whole ledger');

    const goal = { id: 'g1', text: 'Goal 1', milestones: [], milestoneId: null };
    const before = [stamp(path.join(dir, JFILE)), stamp(path.join(dir, JFILE + '.bak'))];
    cfs.zero();
    A.eq(js.pendingQuestFolds(qs.list()).length, 0, 'every done quest is already folded: nothing pending');
    await reconcile(js, qs, goal);
    A.ok((cfs.reads[JFILE] || 0) <= 1 && (cfs.reads[QFILE] || 0) <= 1, 'the idle reconcile reads each ledger at most once (journey ' + (cfs.reads[JFILE] || 0) + ', quests ' + (cfs.reads[QFILE] || 0) + ')');
    A.eq([stamp(path.join(dir, JFILE)), stamp(path.join(dir, JFILE + '.bak'))], before, 'the idle reconcile writes nothing (journey + .bak untouched)');
    // the documented baseline this removes: the pre-fix loop ran recordQuest for EVERY done quest, and each one
    // re-read + re-normalized the journey under the lock only to find it already folded.
    cfs.zero();
    for (const q of qs.list()) { if (!q || q.status !== 'done') continue; await js.recordQuest(q, goal, q.completedAt || 7777); }
    A.ok((cfs.reads[JFILE] || 0) >= 290, 'the old loop shape re-reads the journey once per done quest (' + (cfs.reads[JFILE] || 0) + ' reads)');
    A.eq([stamp(path.join(dir, JFILE)), stamp(path.join(dir, JFILE + '.bak'))], before, 'and it also wrote nothing — the reads were pure waste');

    // ---- 3. invalidation: every write is seen ----
    const minted = await qs.mint({ title: 'Brand new step', contract: { type: 'run', key: 'run-new' }, agentId: 'agent', domain: 'research', goalId: 'g1' }, 9000);
    A.ok(minted.ok && qs.list().some(q => q.id === minted.id), 'mint (real durable write) → the next list() has the new quest');
    A.eq(await qs.completeByContract('run', 'run-new', 9100), [minted.id], 'the new quest completes by its contract');
    A.eq(qs.get(minted.id).status, 'done', 'the completion is visible through the cache');
    const pend = js.pendingQuestFolds(qs.list());
    A.eq(pend.map(q => q.id), [minted.id], 'only the newly done, not-yet-folded quest is pending');
    const folded = await js.recordQuest(pend[0], goal, 9100);
    A.ok(folded.ok && folded.outcome, 'recordQuest folds it');
    A.ok(js.read().outcomeKeys.indexOf('quest:' + minted.id) >= 0, 'recordQuest → the next read() shows the fold');
    A.ok(js.snapshot(goal).outcomes.some(o => o.questId === minted.id), 'and the next snapshot does');
    A.eq(js.pendingQuestFolds(qs.list()).length, 0, 'folded → nothing pending again');

    // an EXTERNAL same-size in-place rewrite (same ino, same size) is still seen: mtime/ctime move. The pause keeps
    // the rewrite out of the previous write's timestamp tick on coarse-clock kernels.
    await sleep(40);
    const jf = path.join(dir, JFILE), jraw = realFs.readFileSync(jf, 'utf8'), jswap = jraw.replace('"Goal 1"', '"Goal X"');
    A.ok(jswap !== jraw && jswap.length === jraw.length, 'fixture: a same-size edit of the journey');
    realFs.writeFileSync(jf, jswap);
    A.ok(js.read().goals.some(g => g.text === 'Goal X'), 'an external same-size rewrite of the journey → the next read reflects it');
    const qf = path.join(dir, QFILE), qraw = realFs.readFileSync(qf, 'utf8'), qswap = qraw.replace('"Brand new step"', '"Brand NEW step"');
    A.ok(qswap !== qraw && qswap.length === qraw.length, 'fixture: a same-size edit of the ledger');
    realFs.writeFileSync(qf, qswap);
    A.eq(qs.get(minted.id).title, 'Brand NEW step', 'an external same-size rewrite of the ledger → the next read reflects it');

    await js.reset(9500, 3);
    const r = js.read();
    A.eq([r.outcomes.length, r.outcomeKeys.length, r.startedAt, r.commanderEpoch], [0, 0, 9500, 3], 'journey.reset → the next read is the empty new epoch');
    A.eq(js.pendingQuestFolds(qs.list()).length, 0, 'every pre-reset completion is outside the new epoch: nothing pending');
  }

  // ---- 4. loudness preserved: only a clean 'ok' read is ever cached ----
  {
    const dir = path.join(root, 'torn');
    realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(path.join(dir, QFILE), '');   // torn main
    realFs.writeFileSync(path.join(dir, QFILE + '.bak'), JSON.stringify({ v: 1, seq: 1, quests: [questRow(1, 'done')], deniedTitles: [] }));
    realFs.writeFileSync(path.join(dir, JFILE), '{"torn');
    realFs.writeFileSync(path.join(dir, JFILE + '.bak'), await journeyBytes([questRow(1, 'done')]));
    let qRec = 0, jRec = 0;
    const { qs, js } = stores(realFs, dir, { q: { onRecover: () => qRec++ }, j: { onRecover: () => jRec++ } });
    for (let i = 0; i < 3; i++) { qs.list(); js.read(); }
    A.eq([qRec, jRec], [3, 3], 'a RECOVERED read is never cached: onRecover fires on every read of both ledgers');
    A.eq([qs.list().length, js.read().outcomes.length], [1, 1], 'the recovered .bak value is what is served');
  }
  {
    const dir = path.join(root, 'locked');
    const rows = [1, 2, 3, 4, 5].map(i => questRow(i, 'done')).concat([6, 7].map(i => questRow(i, 'open')));
    await seedStation(dir, rows);
    const cfs = countingFs(), { qs, js } = stores(cfs, dir);
    const notes = () => failopen.counts()['durable-store.unreadable'] || 0;
    cfs.lock.add(JFILE); cfs.lock.add(QFILE);
    let code = null; try { js.read(); } catch (e) { code = e.code; }
    A.eq(code, 'ESTORE_UNREADABLE', 'a locked journey with no proven cache still throws, exactly as before');
    const n0 = notes();
    A.eq(qs.list(), [], 'a locked ledger with no proven cache reads as before (empty)…');
    A.ok(notes() > n0, '…and the lock is still noted loudly');
    cfs.lock.clear();
    const warmJ = js.read(), warmQ = qs.list();
    cfs.lock.add(JFILE); cfs.lock.add(QFILE); cfs.zero();
    A.ok(js.read() === warmJ, 'locked but PROVABLY unchanged journey → the cached record (the one intended change: was a 500)');
    A.ok(qs.list() === warmQ && warmQ.length === 7, 'locked but provably unchanged ledger → the cached quests (was: silently EMPTY)');
    A.eq([cfs.reads[JFILE] || 0, cfs.reads[QFILE] || 0], [0, 0], 'no read was even attempted');
    await sleep(40);
    realFs.writeFileSync(path.join(dir, JFILE), realFs.readFileSync(path.join(dir, JFILE), 'utf8') + ' ');
    code = null; try { js.read(); } catch (e) { code = e.code; }
    A.eq(code, 'ESTORE_UNREADABLE', 'a CHANGED journey is never served from the stale cache, even while locked');
    cfs.lock.clear();
    const m = await qs.mint({ title: 'After the lock', contract: { type: 'attest' } }, 50);
    A.ok(m.ok && qs.list().length === 8, 'lock cleared + ledger written → fresh data');
    A.ok(js.read() !== warmJ && js.read().goals.length === 3, 'lock cleared → the changed journey is re-read');
  }
  {
    // an absent ledger has no signature, so it is never cached (a brand-new station reads empty every time, as before)
    const dir = path.join(root, 'absent'); realFs.mkdirSync(dir, { recursive: true });
    const cfs = countingFs(), { qs, js } = stores(cfs, dir);
    js.read(); js.read(); qs.list(); qs.list();
    A.eq([cfs.reads[JFILE], cfs.reads[QFILE]], [2, 2], 'an absent ledger is read (not cached) on every call');
    A.eq(js._durable.signature('station'), null, 'absent → no signature');
  }

  // ---- 5. the legacy path: a fake fs without statSync (every existing store test) is never cached ----
  {
    const m = memFs(), js = makeJourneyStore({ fs: m, path, workspaces: '/ws', writeDurable: plainWrite });
    const qs = QS.makeQuestStore({ fs: m, path, workspaces: '/ws', writeDurable: plainWrite });
    await js.registerGoal({ id: 'g0', text: 'Goal 0', successCondition: 'done' }, 1);
    await qs.mint({ title: 'One', contract: { type: 'attest' } }, 1);
    m.reads = 0;
    for (let i = 0; i < 5; i++) js.read();
    qs.list(); qs.list(); qs.get('q:1');
    A.eq(m.reads, 8, 'no statSync → every read hits the fs, exactly as before');
    A.eq([js._durable.signature('station'), qs._durable.signature('station')], [null, null], 'no statSync → no signature');
    const odd = Object.assign(memFs(), { statSync() { return { ino: 5, size: 2, mtimeMs: 1 }; } });
    A.eq(makeJourneyStore({ fs: odd, path, workspaces: '/ws' })._durable.signature('station'), null, 'a stat without bigint fields → no signature');
    const t0 = failopen.counts()['durable-store.signature'] || 0;
    const denied = Object.assign(memFs(), { statSync() { const e = new Error('EPERM (injected)'); e.code = 'EPERM'; throw e; } });
    A.eq(makeJourneyStore({ fs: denied, path, workspaces: '/ws' })._durable.signature('station'), null, 'a stat error → no signature…');
    A.eq((failopen.counts()['durable-store.signature'] || 0) - t0, 1, '…and it is noted, never silent');
  }

  // ---- 6. PARITY: pendingQuestFolds is exactly the set of quests recordQuest would write ----
  {
    const attestQ = (i, attest, extra) => questRow(i, 'done', Object.assign({ contract: { type: 'attest', key: '' }, attest: attest, completedAt: 6000, completedBy: null }, extra));
    const evidence = 'did the thing and showed it';
    const matrix = [
      ['done run quest', questRow(101, 'done', { completedAt: 6000 })],
      ['open quest', questRow(102, 'open')],
      ['dismissed quest', questRow(103, 'dismissed', { dismissedAt: 6000 })],
      ['attest confirmed (agent)', attestQ(104, { source: 'agent', agentId: 'agent', evidence, at: 5, confirmed: true })],
      ['attest declined (false)', attestQ(105, { source: 'agent', agentId: 'agent', evidence, at: 5, confirmed: false })],
      ['attest pending (null)', attestQ(106, { source: 'agent', agentId: 'agent', evidence, at: 5, confirmed: null })],
      ['attest with no attest record', attestQ(107, null)],
      ['attest Commander-source', attestQ(108, { source: 'commander', agentId: null, evidence, at: 5, confirmed: true })],
      ['mechanical with a stray unconfirmed attest', questRow(109, 'done', { completedAt: 6000, attest: { source: 'agent', agentId: 'agent', evidence, at: 5, confirmed: null } })],
      ['completedAt null', questRow(110, 'done', { completedAt: null })],
      ['completedAt before the epoch', questRow(111, 'done', { completedAt: 4000 })],
      ['completedAt AT the epoch', questRow(112, 'done', { completedAt: 5000 })],
      ['already folded', questRow(113, 'done', { completedAt: 6000 })],
      ['already folded, id over the clip', questRow(114, 'done', { id: 'q:' + 'L'.repeat(200), completedAt: 6000 })],
      ['id over the 120 clip', questRow(115, 'done', { id: 'q:' + 'M'.repeat(200), completedAt: 6000 })],
      ['whitespace id the clip collapses', questRow(116, 'done', { id: '  q:  116 ', completedAt: 6000 })],
      ['clip that lands on a space', questRow(117, 'done', { id: 'q:' + 'x'.repeat(111) + ' tail', completedAt: 6000 })],
      ['folded, clip that lands on a space', questRow(118, 'done', { id: 'q:' + 'y'.repeat(111) + ' tail', completedAt: 6000 })],
      ['no id', questRow(119, 'done', { id: '', completedAt: 6000 })],
      ['null entry', null]
    ];
    const prefold = matrix.filter(([label]) => /folded/.test(label)).map(([, q]) => q);
    const list = matrix.map(([, q]) => q);
    const bases = {
      'no journey yet': null,
      'journey with folds': await journeyBytes(prefold, { raw: true }),
      'journey after a reset epoch': await journeyBytes(prefold, { raw: true, resetAt: 5000 })
    };
    for (const [scenario, bytes] of Object.entries(bases)) {
      const dir = path.join(root, 'parity-' + scenario.replace(/\W+/g, '-'));
      realFs.mkdirSync(dir, { recursive: true });
      if (bytes != null) realFs.writeFileSync(path.join(dir, JFILE), bytes);
      const js = makeJourneyStore({ fs: realFs, path, workspaces: dir });
      js.read();   // warm: the filter runs against the cached record, as the poll does
      const pending = new Set(js.pendingQuestFolds(list));
      const said = [], wrote = [];
      for (const [label, q] of matrix) {
        if (pending.has(q)) said.push(label);
        const copy = memFs(bytes != null ? { [MEM_J]: bytes } : {});
        const r = await makeJourneyStore({ fs: copy, path, workspaces: '/ws', writeDurable: plainWrite }).recordQuest(q, null, 7000);
        const changed = (copy.files.get(MEM_J) || null) !== (bytes != null ? bytes : null);
        A.eq(!!(r && r.ok && r.outcome), changed, scenario + ' / ' + label + ': recordQuest reports a fold exactly when it writes');
        if (changed) wrote.push(label);
      }
      A.eq(said, wrote, scenario + ': pendingQuestFolds === the quests recordQuest actually writes');
      A.ok(wrote.length > 2 && wrote.length < matrix.length - 4, scenario + ': the matrix exercises both sides (' + wrote.length + '/' + matrix.length + ' write)');
    }
    // the reconcile's LEDGER BYTES are identical to the old loop's: same folds, same order, same seq ids and receipts
    const rows = []; for (let i = 1; i <= 40; i++) rows.push(questRow(i, i <= 32 ? 'done' : 'open'));
    const base = await journeyBytes(rows.filter((_, i) => i % 3 !== 0));   // a third of the done quests lost their fold
    const quests = QS.normalize({ quests: rows }).quests;
    const old = memFs({ [MEM_J]: base }), oldJ = makeJourneyStore({ fs: old, path, workspaces: '/ws', writeDurable: plainWrite });
    for (const q of quests) { if (!q || q.status !== 'done') continue; await oldJ.recordQuest(q, null, q.completedAt || 7777); }
    const dir = path.join(root, 'bytes'); realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(path.join(dir, JFILE), base);
    const newJ = makeJourneyStore({ fs: realFs, path, workspaces: dir });
    A.eq(newJ.pendingQuestFolds(quests).length, 11, 'fixture: 11 done quests need their fold recovered');
    await reconcile(newJ, { list: () => quests }, null);
    A.ok(old.files.get(MEM_J) !== base, 'fixture: the old loop recovered folds');
    A.ok(realFs.readFileSync(path.join(dir, JFILE), 'utf8') === old.files.get(MEM_J), 'the pending-only reconcile writes byte-identical journey state to the replay-everything loop');
  }

  // ---- 7. READ-ONLY CONTRACT: the cached records survive every audited reader deep-frozen ----
  {
    const dir = path.join(root, 'frozen');
    const rows = []; for (let i = 1; i <= 40; i++) rows.push(questRow(i, i <= 30 ? 'done' : 'open'));
    rows.push(questRow(41, 'open', { contract: { type: 'prop', key: 'compute' }, agentId: 'agent' }));
    rows.push(questRow(43, 'open', { contract: { type: 'fact', key: 'ships on fridays' }, agentId: 'agent' }));
    rows.push(questRow(44, 'open', { contract: { type: 'artifact', key: 'out/report.md' }, agentId: null, declineNote: { at: 3, note: 'show the file' } }));
    rows.push(questRow(46, 'open', { stalledAt: 9, stalledReason: 'error', goalId: 'g1', milestoneId: 'm1' }));
    rows.push(questRow(47, 'dismissed', { dismissedAt: 9 }));
    await seedStation(dir, rows);
    const { qs, js } = stores(realFs, dir);
    const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };
    deepFreeze(js.read()); deepFreeze(qs.read());
    A.ok(Object.isFrozen(js.read().outcomes[0]) && Object.isFrozen(qs.list()[0].steps), 'fixture: the cache now serves the deep-frozen records');
    const goal = { id: 'g1', text: 'Goal 1', milestoneId: 'm1', milestones: [{ id: 'm1', text: 'Pick a niche', status: 'open' }, { id: 'm2', text: 'Write issue one', status: 'open' }] };
    const open = () => qs.openForAgent('agent', 10);
    const readers = {
      'journey.snapshot': () => JSON.stringify(js.snapshot(goal)),
      'journey.adaptationBlock (counted)': () => js.adaptationBlock('agent'),
      'journey.adaptationBlock (tier-only)': () => js.adaptationBlock('agent', { counts: false }),
      'journey.milestoneDoneKeys': () => js.milestoneDoneKeys(),
      'journey.currentEpoch': () => js.currentEpoch(1),
      'journey.pendingQuestFolds': () => js.pendingQuestFolds(qs.list()),
      'QuestRefresh.progressContext': () => JSON.stringify(QuestRefresh.progressContext(js.read(), qs.list(), goal)),
      'QuestRefresh.buildDirective + parse': () => {
        const rec = qs.read();
        QuestRefresh.buildDirective({ goalNote: 'Goal 1', progress: QuestRefresh.progressContext(js.read(), rec.quests, goal), openQuests: rec.quests.filter(q => q.status === 'open').map(q => ({ title: q.title })), completedQuests: [], deniedTitles: rec.deniedTitles, propKeys: ['compute'] });
        QuestRefresh.parse('NORTH_STAR: x\nNONE', { openTitles: rec.quests.map(q => q.title), deniedTitles: rec.deniedTitles, propKeys: ['compute'], grounding: '' });
      },
      'GoalAdvance.slateFinished': () => GoalAdvance.slateFinished(goal, qs.list()),
      'GoalAdvance.overlay': () => GoalAdvance.overlay(goal, js.milestoneDoneKeys()),
      'QuestSweeps.livePropKeys': () => A.eq(QuestSweeps.livePropKeys(open(), 'agent', null, { hasCompute: true }), ['compute'], 'livePropKeys still reads the frozen ledger'),
      'QuestSweeps.artifactQuestKeys': () => QuestSweeps.artifactQuestKeys(open(), 'agent'),
      'QuestSweeps.learnedFactKeys': () => QuestSweeps.learnedFactKeys(open(), 'agent', { id: 'n1', content: 'The Commander ships on Fridays' }),
      'questinject.questBlock': () => questBlock(open()),
      'GET /api/quests body': () => JSON.stringify({ ok: true, quests: qs.list() })
    };
    for (const [name, fn] of Object.entries(readers)) A.notThrows(fn, name + ' never mutates the shared cached records');
    // the quest tool's read seams (openForAgent().find / .some) run on the frozen cache; its writes re-read under the lock
    let t = 100;
    const tool = makeQuestTools({ store: qs, clock: { now: () => ++t }, activeGoal: () => null }).questUpdateTool;
    const ticked = await tool.run({ op: 'progress', id: 'q:31', stepKey: 's2', note: 'shipped' }, { agentId: 'agent', runId: 'run1' });
    A.ok(/Ticked step/.test(ticked.content), 'quest.update progress works over the frozen cache: ' + ticked.content);
    A.eq(qs.get('q:31').steps[1].done, true, 'and its write invalidated the cache');
    // byte-identical responses: the cached store answers exactly what an uncached store reading the same bytes does
    const memJ = makeJourneyStore({ fs: memFs({ [MEM_J]: realFs.readFileSync(path.join(dir, JFILE), 'utf8') }), path, workspaces: '/ws' });
    const memQ = QS.makeQuestStore({ fs: memFs({ [MEM_Q]: realFs.readFileSync(path.join(dir, QFILE), 'utf8') }), path, workspaces: '/ws' });
    js.read();
    A.ok(JSON.stringify({ ok: true, journey: js.snapshot(goal) }) === JSON.stringify({ ok: true, journey: memJ.snapshot(goal) }), 'GET /api/journey body: cached === uncached, byte for byte');
    A.ok(JSON.stringify({ ok: true, quests: qs.list() }) === JSON.stringify({ ok: true, quests: memQ.list() }), 'GET /api/quests body: cached === uncached, byte for byte');
  }

  cleanup();
  A.report('journey-read-cache.test');
})().catch(e => { cleanup(); console.error(e); process.exitCode = 1; });
