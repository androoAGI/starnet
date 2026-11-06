'use strict';
/* node test/dossier.forget-compose.test.js - THE PAGE'S HALF OF FORGETTING A DELETED SESSION IN THE DOSSIER (turn identity commits 14 and 16,
   qa/bugs/3e926b6a), with the REAL dossier engine and DossierStore in a vm and a stub fetch standing for the sidecar.

   A belief the station LEARNED from a run (weight 'observed', a study proposal the Commander kept) names that run. One the Commander stated,
   confirmed or authored names no session. Deleting a session purges the learned beliefs of its runs; what is pushed to the sidecar says which
   runs it was learned from and whether it names them all:

     before a delete   the block holds every belief; the push lists the learned beliefs' runs, complete only when none is unsourced
     purgeRuns         the learned beliefs of the deleted runs go (a Commander-confirmed belief that was first inferred from one STAYS); from then on the
                       block is composed from complete beliefs only: an UNSOURCED learned belief stays in the panel (beliefs(), summary()) and
                       leaves the block and the beliefs snapshot; the push is complete and names only live runs
     a confirmation    an unsourced learned belief the Commander confirms (source commander, weight stated) returns to the block
     a refused push    the sidecar answered admitted:false (a delete this page has not folded in): the page switches to complete beliefs, drops the
                       beliefs the answer names as forgotten and pushes once more; a second refusal does not loop
   RED at the previous commit: no provenance on the push, no purgeRuns, no complete-only block. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
const Dossier = require('../frontend/app/dossier.js');

const calls = [];
let answer = () => ({ ok: true, admitted: true, beliefsAdmitted: true });
const sandbox = { Dossier, console, setTimeout, Date, JSON, Promise,
  fetch: (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body }); return Promise.resolve({ json: () => Promise.resolve(answer(url, body)) }); } };
// the page's one JSON client, over the same stub fetch: { ok, status, j } as harness.js's readReply gives it
sandbox.Harness = { api: { post: async (url, body) => { const r = await sandbox.fetch(url, { method: 'POST', body: JSON.stringify(body) }); const j = await r.json(); return { ok: !!j && j.ok !== false, status: 200, j }; } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'dossierstore.js'), 'utf8') + '\nthis.DossierStore = DossierStore;', sandbox);
const Store = sandbox.DossierStore;
const settle = () => new Promise(r => setTimeout(r, 20));
const pushes = route => calls.filter(c => c.url === route);

(async () => {
  let saved = 0;
  Store.init({ persist: () => { saved++; }, onMutate: () => {}, dossier: undefined });
  await settle(); calls.length = 0;

  // setup: a Commander-stated belief, a belief learned from run_a (a session that will be deleted), one from run_b (kept), an unsourced learned one,
  // and one the Commander CONFIRMED after the station first learned it from run_a
  Store.upsert('style', { text: 'prefers terse answers', source: 'commander', weight: 'stated' });
  Store.upsert('goals', { text: 'ship the quokka tracker', source: 'study', weight: 'observed', observedAt: 5, sourceRunId: 'run_a' });
  Store.upsert('stack', { text: 'uses Rust for the sanctuary tool', source: 'study', weight: 'observed', observedAt: 6, sourceRunId: 'run_b' });
  Store.upsert('pain', { text: 'dislikes slow builds', source: 'study', weight: 'observed', observedAt: 7 });
  Store.upsert('people', { text: 'works with a quokka keeper', source: 'study', weight: 'observed', observedAt: 8, sourceRunId: 'run_a' });
  const people = Store.beliefs('people')[0];
  Store.upsert('people', { id: people.id, text: 'works with a quokka keeper', source: 'commander', weight: 'stated', evidenceRef: { kind: 'confirmed' } });
  await settle();

  const last = route => pushes(route)[pushes(route).length - 1].body;
  let block = last('/api/dossier');
  A.ok(/quokka tracker/.test(block.block) && /slow builds/.test(block.block) && /Rust/.test(block.block), 'before a delete the block holds every belief');
  A.eq(block.sourceRunIds.slice().sort(), ['run_a', 'run_b'], 'before a delete the push lists the runs the learned beliefs came from (the confirmed one is the Commander\'s)');
  A.eq(block.complete, false, '...and is not complete: one learned belief names no run');
  const snap0 = last('/api/autonomy/posture').beliefs;
  A.eq(snap0.beliefs.goals[0].sourceRunId, 'run_a', 'the beliefs snapshot carries a learned belief\'s run');
  A.ok(snap0.beliefs.style[0].sourceRunId === undefined && snap0.beliefs.people[0].sourceRunId === undefined, '...and none for the Commander\'s own or a confirmed one');
  A.eq(snap0.complete, false, '...and says it is not complete');

  // the Commander deletes the session that held run_a
  calls.length = 0;
  const removed = Store.purgeRuns(['run_a']);
  await settle();
  A.eq(removed, 1, 'purgeRuns drops the learned belief of the deleted run (' + removed + ')');
  A.eq(Store.beliefs('goals').length, 0, '...the quokka goal is gone');
  A.eq(Store.beliefs('people').length, 1, '...the belief the Commander confirmed stays, though it was first inferred from the deleted run');
  A.eq(Store.beliefs('pain').length, 1, '...and the unsourced learned belief stays in the panel');
  A.eq(Store.summary().counts.pain, 1, '...and in the summary');
  block = last('/api/dossier');
  A.ok(!/quokka tracker/.test(block.block) && !/slow builds/.test(block.block), 'the block no longer holds the deleted run\'s belief or the unsourced learned one');
  A.ok(/Rust/.test(block.block) && /terse/.test(block.block) && /quokka keeper/.test(block.block), '...it holds the kept run\'s belief, the Commander\'s own and the confirmed one');
  A.eq([block.sourceRunIds, block.complete], [['run_b'], true], 'the push is complete and names only a live run');
  const snap1 = last('/api/autonomy/posture').beliefs;
  A.ok(!snap1.beliefs.pain && !snap1.beliefs.goals && snap1.beliefs.stack && snap1.complete === true, 'the beliefs snapshot leaves the unsourced belief out and is complete');
  A.ok(saved > 0 && Store.serialize().completeOnly === true, 'the dossier remembers a delete happened (it rides the save)');
  A.eq(Dossier.hydrate(JSON.parse(JSON.stringify(Store.serialize()))).completeOnly, true, '...and it survives a reload');

  // the Commander confirms the unsourced belief: it is theirs now, and returns to the block
  const pain = Store.beliefs('pain')[0];
  Store.upsert('pain', { id: pain.id, text: 'dislikes slow builds', source: 'commander', weight: 'stated', evidenceRef: { kind: 'confirmed' } });
  await settle();
  A.ok(/slow builds/.test(last('/api/dossier').block), 'an unsourced belief the Commander confirms returns to the block');

  // a push the sidecar refuses: a delete this page has not folded in
  const fresh = Dossier.hydrate(undefined);
  Dossier.upsert(fresh, 'goals', { text: 'ship the kept tracker', source: 'study', weight: 'observed', sourceRunId: 'run_b' }, 1);
  Dossier.upsert(fresh, 'stack', { text: 'uses Go for a quoting tool', source: 'study', weight: 'observed', sourceRunId: 'run_q' }, 2);
  Dossier.upsert(fresh, 'pain', { text: 'an unsourced learned belief', source: 'study', weight: 'observed' }, 3);
  calls.length = 0;
  let n = 0;
  answer = (url, body) => {
    n++;
    if (url === '/api/dossier') return body.complete === false || body.sourceRunIds.indexOf('run_q') >= 0 ? { ok: true, admitted: false, reason: body.complete ? 'source-forgotten' : 'provenance-incomplete', forgotten: body.sourceRunIds.filter(x => x === 'run_q') } : { ok: true, admitted: true };
    return { ok: true, beliefsAdmitted: !(body.beliefs.complete === false || Object.values(body.beliefs.beliefs).some(l => l.some(b => b.sourceRunId === 'run_q'))), beliefsForgotten: ['run_q'] };
  };
  const Fresh = (() => {
    const ctx = { Dossier, console, setTimeout, Date, JSON, Promise, fetch: sandbox.fetch, Harness: sandbox.Harness };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'dossierstore.js'), 'utf8') + '\nthis.DossierStore = DossierStore;', ctx);
    return ctx.DossierStore;
  })();
  Fresh.init({ persist: () => {}, onMutate: () => {}, dossier: fresh });
  await settle(); await settle();
  const dossierPosts = pushes('/api/dossier');
  A.ok(dossierPosts.length >= 2 && dossierPosts.length <= 3, 'a refused push is followed by ONE more, and the exchange ends (no loop): ' + dossierPosts.length + ' posts');
  const finalPost = dossierPosts[dossierPosts.length - 1].body;
  A.eq([finalPost.complete, finalPost.sourceRunIds], [true, ['run_b']], 'the re-push is complete and drops the run the sidecar named as forgotten');
  A.ok(!/Go for a quoting tool/.test(finalPost.block) && !/unsourced learned/.test(finalPost.block) && /kept tracker/.test(finalPost.block), '...the quoting run\'s belief and the unsourced one are out of the block');
  A.eq(Fresh.beliefs('pain').length, 1, '...the unsourced belief is still in the panel');
  A.eq(Fresh.beliefs('stack').length, 0, '...the belief the sidecar named as forgotten is gone');
  A.report('dossier.forget-compose');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
