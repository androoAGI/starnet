/* node test/upload-stage.test.js — the staged upload copies' REGISTRY and the page-alive read it rests on
   (run-paths-polish, 2026-10-30; sidecar/tools/builtin/upload-stage.js, browser.js makeCdpDriver.uploadDocAlive).

   P1 keeps a staged copy while the page it went into lives (live walk W-R7 (b): it was deleted at every reply end, so
   the person's later Submit failed). That makes "is the page still there?" load-bearing: a wrong "gone" deletes a file
   the person is about to submit, and a read that hangs stalls every gated action. Review round 7 minor 4: the read
   sent Page.getFrameTree to the page's renderer with the 15 s default, once per copy, before and after every action;
   on a busy page each copy cost up to 2 x 15 s. Proves:
     1. the registry: an alive read is bounded and MEMOIZED per document in a pass (three copies of one page, one
        read), "unknown" is never "gone" (the reply end and the sweep keep it; the TTL and the browser's close drop it),
        a copy the sweep dropped meanwhile is not a "changed" copy (no false refusal), and an input emptied whole drops
        and names every copy it held (m3);
     WHO IS TOLD (review round 2, minor R-A; scratchpad verify-sec/r2/cross-agent-e2e.js, rev2/rev2-notes.js): the
        station registry is shared by every agent that drives the station, and a note quotes a copy's name. Agent A's TTL
        note, queued after A's run ended, was said on agent B's next action. A note is said only to its own agent, is
        withheld from an agent that takes the browser over, and one about several agents' copies is only logged; an
        action refused for another agent's changed copy never names it (that copy is dropped all the same);
     THE BOUND IS STRICT (Codex A3-CAP-01): "at most 32 copies and 1 GB at once" was false for one selection (the batch
        was exempt from the eviction); a selection over it is refused whole now, none of it registered;
     A RUN'S END RELEASES ITS OWN COPIES (polish review round 1, minor 2): release(own) never drops another run's copy;
     ONLY THAT SELECTION (Codex A3-LIFE-01, a3-lifecycle-clear-race.cjs): an old copy's TTL emptied a NEWER selection
        made in the same input while its clear was pending, or after that clear timed out; the clear now empties an
        input only while it holds the very Files that were proven (one page-side step), and stops once its wait gave up;
     SAID AS IT HAPPENED (polish A3 minor): an input that no longer held the copy (cleared, or the newer selection the
        identity check kept) was said to be "emptied: select it again"; every note and refusal now says nothing was
        emptied there, and never asks for the old file over the newer selection;
     COORDINATOR CALL (2026-10-30, Andrew may override): a copy staged in an earlier reply MAY be sent by a later run of
        the SAME agent while its document lives (the egress decision was made and proven at staging, and it is
        re-proved before every action); handTo another agent drops every copy and withholds the notes not for it;
     2. the CDP driver: the main document Chrome last REPORTED for a tab (Page.frameNavigated) answers without asking
        the renderer, so a busy page whose document did not change reads alive at once, a navigation reads gone at once,
        an iframe's navigation is not the page's, and with no event the renderer is asked BOUNDED: a page that does not
        answer reads null (unknown), never false; a closed target reads false. */
'use strict';
const A = require('./_assert.js');
const { makeUploadStage, isUploadStage } = require('../sidecar/tools/builtin/upload-stage.js');
const { _internals: T } = require('../sidecar/tools/builtin/browser.js');

const tick = ms => new Promise(r => setTimeout(r, ms));
function copy(name, doc, o) {
  o = o || {};
  const c = { name, shown: name, path: '/stage/' + name, ref: 'b1', agentId: o.agentId || 'agent', doc, epoch: null, dropped: 0, verifies: 0, bad: null };
  c.verify = async () => { c.verifies++; if (o.onVerify) await o.onVerify(c); return c.bad ? { ok: false, error: c.bad } : { ok: true }; };
  c.unstage = async () => { c.dropped++; };
  return c;
}

(async () => {
  // the registry's own timers are unref'd (a pending check never holds the station open): hold the loop for the test
  const hold = setInterval(() => {}, 1000);
  try {
  // ---- 1. the registry ----
  {
    let reads = 0, mode = 'alive';
    const stage = makeUploadStage({
      aliveTimeoutMs: 60, sweepMs: 3600000, keepMs: 3600000, log: () => {},
      docAlive: async () => { reads++; if (mode === 'hang') return new Promise(() => {}); return mode === 'alive' ? true : mode === 'gone' ? false : null; },
      clearInputs: async () => ({ cleared: 1, paths: [] })
    });
    A.ok(isUploadStage(stage) && !isUploadStage({}), 'a registry is recognisable (a run\'s view never forges one)');
    const page = { sid: 's1', loader: 'L1' };
    const cs = [copy('a.txt', page), copy('b.txt', page), copy('c.txt', page)];
    await stage.add(cs); stage.settle(cs, page);
    await stage.dropGone();
    A.eq(reads, 1, 'm4: three copies of ONE page cost ONE alive read per pass (memoized per document)');
    mode = 'hang';
    const t0 = Date.now();
    await stage.dropGone();
    const took = Date.now() - t0;
    A.ok(took < 1000 && stage.size === 3, 'm4: a page that never answers is bounded (' + took + ' ms for three copies) and its copies are kept (unknown is never gone)');
    await stage.release();
    A.eq(stage.size, 3, 'P1: the reply end keeps copies whose page cannot be read in time (the TTL bounds them)');
    mode = 'unknown';
    await stage.sweep();
    A.eq(stage.size, 3, 'P1: so does the sweep');
    mode = 'gone';
    await stage.release();
    A.ok(stage.size === 0 && cs.every(c => c.dropped === 1), 'P1: the reply end drops copies whose page is proven gone (each unstaged once)');

    // a copy the sweep (or the TTL) dropped while recheck was proving it is gone, not changed: no false refusal
    mode = 'alive';
    const racy = copy('r.txt', page, { onVerify: async c => { await stage.drop([c]); c.bad = 'the staged upload could not be re-verified (ENOENT)'; } });
    await stage.add([racy]); stage.settle([racy], page);
    let refused = null;
    try { await stage.recheck('browser.click', 'agent'); } catch (e) { refused = e; }
    A.ok(!refused && stage.size === 0, 'a copy dropped while it was being re-proved is not "changed": the action is not refused (' + (refused && refused.message) + ')');

    // m3 at the registry: an emptied multi-file input drops and names every copy it held
    const m = makeUploadStage({ log: () => {}, docAlive: async () => true, clearInputs: async () => ({ cleared: 1, paths: ['/stage/one.txt', '/stage/two.txt'] }) });
    const one = copy('one.txt', page), two = copy('two.txt', page), other = copy('other.txt', { sid: 's2', loader: 'L9' });
    await m.add([one, two, other]); m.settle([one, two], page); m.settle([other], other.doc);
    one.bad = 'the staged upload\'s bytes changed';
    let e3 = null;
    try { await m.recheck('browser.press', 'agent'); } catch (e) { e3 = e; }
    A.ok(e3 && /select it again \("one\.txt": the staged upload's bytes changed\)\./.test(e3.message) && /Its file input was emptied, so select "two\.txt" again too\./.test(e3.message) && !/other\.txt/.test(e3.message),
      'm3: the refusal names the changed file and the other file its emptied input held, and no unrelated one: ' + (e3 && e3.message));
    A.ok(one.dropped === 1 && two.dropped === 1 && other.dropped === 0 && m.size === 1, 'm3: both copies that input held are dropped; the other page\'s copy stays');
    A.eq(e3 && e3.hostAuthored, true, 'P2: the refusal is the host\'s own, so its tool line shows the reason');
    await m.dropAll();
    A.eq(m.size, 0, 'the browser closing drops every copy');

    // emptying a busy page's inputs is bounded too, and is said as not emptied
    const slow = makeUploadStage({ log: () => {}, clearTimeoutMs: 50, docAlive: async () => true, clearInputs: () => new Promise(() => {}) });
    const s1 = copy('s.txt', page);
    await slow.add([s1]); slow.settle([s1], page);
    s1.bad = 'the staged upload was replaced';
    let e4 = null; const t1 = Date.now();
    try { await slow.recheck('browser.click', 'agent'); } catch (e) { e4 = e; }
    A.ok(e4 && /could not be emptied/.test(e4.message) && Date.now() - t1 < 1000 && s1.dropped === 1, 'a page whose inputs cannot be emptied in time is bounded, the copy dropped, and the refusal says the input could not be emptied');

    // BOUNDED: a page that never navigates, re-selected over and over, keeps at most maxLive copies: the oldest go first
    const emptiedFor = [];
    const capped = makeUploadStage({ log: () => {}, maxLive: 2, docAlive: async () => true, clearInputs: async (_d, paths) => { emptiedFor.push(paths[0]); return { cleared: 1, paths }; } });
    const k1 = copy('k1.txt', page), k2 = copy('k2.txt', page), k3 = copy('k3.txt', page);
    for (const k of [k1, k2, k3]) { await capped.add([k]); capped.settle([k], page); }
    A.eq(capped.takeNotes('someone-else'), [], 'R-A: a note about one agent\'s copy is never said to another agent');
    const said = capped.takeNotes('agent');
    A.ok(capped.size === 2 && k1.dropped === 1 && k2.dropped === 0 && k3.dropped === 0 && emptiedFor[0] === k1.path,
      'P1 bound: past the limit the OLDEST copy goes first, and the input holding it is emptied');
    A.ok(said.length === 1 && /"k1\.txt" was dropped: StarNet keeps at most 2 staged uploads/.test(said[0]) && /the file input holding it was emptied/.test(said[0]), 'P1 bound: and it is said: ' + said.join(' '));
    // STRICT (Codex A3-CAP-01): one selection over the bound was let in whole (the batch was exempt from the eviction), so
    // "at most N at once" was false. It is refused whole now: none of it registered, no older copy evicted for it
    const batch = [copy('k4.txt', page), copy('k5.txt', page), copy('k6.txt', page)];
    let eBatch = null;
    try { await capped.add(batch); } catch (e) { eBatch = e; }
    A.ok(eBatch && eBatch.code === 'EUPLOADBOUND' && eBatch.hostAuthored === true && /^a browser upload takes at most 2 files and 1024 MB at once .*; this selection is 3 files, so nothing was selected or uploaded/.test(eBatch.message),
      'A3-CAP-01: one selection of more files than the bound is refused whole (was: registered past it): ' + (eBatch ? eBatch.message : 'size ' + capped.size));
    A.ok(capped.size === 2 && batch.every(c => c.dropped === 0) && k2.dropped === 0 && k3.dropped === 0, 'A3-CAP-01: ...none of it is registered, and no older copy was evicted for it');
    const mb = n => n * 1048576;
    const byBytes = makeUploadStage({ log: () => {}, maxLiveBytes: mb(3), docAlive: async () => true, clearInputs: async (_d, paths) => ({ cleared: 1, paths }) });
    const sized = (name, n) => Object.assign(copy(name, page), { size: mb(n) });
    const h1 = sized('h1.bin', 2);
    await byBytes.add([h1]); byBytes.settle([h1], page);
    let eBytes = null;
    try { await byBytes.add([sized('h2.bin', 2), sized('h3.bin', 2)]); } catch (e) { eBytes = e; }
    A.ok(eBytes && /at most 32 files and 3 MB at once .*; this selection is over 3 MB/.test(eBytes.message) && byBytes.size === 1 && h1.dropped === 0,
      'A3-CAP-01: one selection over the BYTE bound is refused whole too: ' + (eBytes ? eBytes.message : 'size ' + byBytes.size));
    const h4 = sized('h4.bin', 2);
    await byBytes.add([h4]);
    A.ok(byBytes.size === 1 && h1.dropped === 1 && h4.dropped === 0, 'A3-CAP-01: (control) a selection within the bound evicts the oldest copy to stay under it');
    await capped.dropAll(); await byBytes.dropAll();
  }

  // ---- polish review round 1, minor 2: a run's end releases ITS OWN copies, never another run's ----
  {
    const rel = makeUploadStage({ log: () => {}, docAlive: async () => true, clearInputs: async (_d, paths) => ({ cleared: 1, paths }) });
    const mine = copy('mine.txt', null), theirs = copy('theirs.txt', null);   // no page identity: "until this reply ends"
    await rel.add([mine, theirs]); rel.settle([mine, theirs], null);
    await rel.release(new Set([mine]));
    A.ok(mine.dropped === 1 && theirs.dropped === 0 && rel.size === 1, 'minor 2: release(own) drops this run\'s no-page copy and leaves another run\'s (was: dropped every copy in the shared registry)');
    await rel.release();
    A.ok(theirs.dropped === 1 && rel.size === 0, 'minor 2: (control) a release with no owner set still releases every copy');
  }

  // ---- Codex A3-LIFE-01: an old copy's expiry empties only THAT selection, never a newer one in the same input ----
  // The real clear primitive (browser-upload.js clearFilesHolding) against a CDP that hands out real object identities,
  // the page-side functions it sends run against an input model, and virtual timers. Reproduced on 4f83f56c6 (Codex
  // a3-lifecycle-clear-race.cjs): a newer selection made while the old clear was pending, or after it timed out, was
  // emptied, and its later Submit had no file.
  {
    const vm = require('node:vm');
    const { clearFilesHolding } = require('../sidecar/tools/builtin/browser-upload.js');
    const lifeCase = async (mode) => {
      const OLD = 'C:\\stage\\a\\old.txt', NEW = 'C:\\stage\\b\\new.txt';
      const fileOld = { path: OLD }, fileNew = { path: NEW };
      const input = { files: [fileOld] };
      const objects = new Map([['inputs', [input]], ['input', input]]);
      let seq = 0;
      const idOf = o => { for (const [k, v] of objects) if (v === o) return k; const k = 'obj' + (++seq); objects.set(k, o); return k; };
      const timers = [], drops = [], mutations = [];
      let pause = null;
      const cdp = { async send(method, p) {
        p = p || {};
        if (method === 'DOM.enable' || method === 'Runtime.releaseObjectGroup' || method === 'Runtime.releaseObject') return {};
        if (method === 'Runtime.evaluate') return { result: { objectId: 'inputs' } };
        if (method === 'Runtime.getProperties') { const arr = objects.get(p.objectId) || []; return { result: arr.map((v, i) => ({ name: String(i), value: { objectId: idOf(v) } })) }; }
        if (method === 'DOM.getFileInfo') {
          const f = objects.get(p.objectId);
          if (pause) { const hold = pause; pause = null; await hold(); }   // the person (or a later upload) acts while this read is pending
          return { path: f.path };
        }
        if (method === 'Runtime.callFunctionOn') {
          const self = objects.get(p.objectId);
          // the page-side function exactly as sent, run against the input model (files read live; value = '' empties it)
          const el = { get files() { return self.files; }, set value(v) { if (v === '') { self.files = []; mutations.push('emptied'); } } };
          const args = (p.arguments || []).map(x => objects.get(x.objectId));
          const out = vm.runInNewContext('(' + p.functionDeclaration + ')').apply(el, args);
          return Array.isArray(out) ? { result: { objectId: idOf(out) } } : { result: { value: out } };
        }
        throw new Error('unexpected CDP ' + method);
      } };
      const st = makeUploadStage({ log: () => {}, keepMs: 60000, clearTimeoutMs: 5000, docAlive: async () => true,
        clearInputs: (_doc, paths, opts) => clearFilesHolding({ cdp, paths, caseless: true, signal: opts && opts.signal }),
        setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.done = true; } });
      const page = { sid: 'p', loader: 'L1' };
      const mk = (name, at) => { const c = copy(name, page); c.path = at; c.unstage = async () => { c.dropped++; drops.push(name); }; return c; };
      const a = mk('old.txt', OLD), b = mk('new.txt', NEW);
      await st.add([a]); st.settle([a], page);
      let reached, release;
      const arrived = new Promise(r => { reached = r; });
      if (mode !== 'control') pause = () => { reached(); return new Promise(r => { release = r; }); };
      const ttl = timers.find(t => t.ms === 60000 && !t.done); ttl.done = true; ttl.fn();
      if (mode !== 'control') {
        await arrived;
        if (mode === 'after-timeout' || mode === 'timeout-unchanged') {
          const t = timers.find(x => x.ms === 5000 && !x.done); t.done = true; t.fn();
          for (let i = 0; i < 50 && !drops.includes('old.txt'); i++) await tick(1);
        }
        if (mode !== 'timeout-unchanged') { input.files = [fileNew]; await st.add([b]); st.settle([b], page); }
        release();
      }
      for (let i = 0; i < 30; i++) await tick(1);
      const out = { inputFiles: input.files.map(f => f.path), registered: st.copies().map(c => c.name), drops: drops.slice(), mutations: mutations.slice(), notes: st.takeNotes('agent') };
      await st.dropAll();
      return out;
    };
    const control = await lifeCase('control');
    A.ok(control.inputFiles.length === 0 && control.drops.join() === 'old.txt' && control.registered.length === 0,
      'A3-LIFE-01: (control) an expired copy still selected is emptied from its input and dropped: ' + JSON.stringify(control));
    const during = await lifeCase('during-clear');
    A.ok(during.inputFiles.join() === 'C:\\stage\\b\\new.txt' && during.registered.join() === 'new.txt' && during.drops.join() === 'old.txt' && during.mutations.length === 0,
      'A3-LIFE-01: a NEWER selection made while the old copy\'s clear was pending stays selected (was: emptied): ' + JSON.stringify(during));
    const late = await lifeCase('after-timeout');
    A.ok(late.inputFiles.join() === 'C:\\stage\\b\\new.txt' && late.registered.join() === 'new.txt' && late.drops.join() === 'old.txt' && late.mutations.length === 0,
      'A3-LIFE-01: ...and so does one made after that clear timed out (was: emptied by the clear that kept running): ' + JSON.stringify(late));
    const stopped = await lifeCase('timeout-unchanged');
    A.ok(stopped.mutations.length === 0 && stopped.drops.join() === 'old.txt' && stopped.notes.some(n => /could not be emptied: do not submit that form/.test(n)),
      'A3-LIFE-01: a clear past its bounded wait changes nothing afterwards, so what was said ("could not be emptied") stays true: ' + JSON.stringify(stopped));
    // SAID AS IT HAPPENED (polish A3 minor; a3-lifecycle-clear-race.confirm.cjs): the input the identity check left
    // holding the newer selection was said to be "emptied: select it again", and an agent following that would select
    // the old file over the person's newer one. What each note says now is what became of that input
    A.ok(control.notes.length === 1 && /"old\.txt" was kept 1 min \(the limit\) and dropped, and the file input holding it was emptied: select it again/.test(control.notes[0]),
      'A3 minor: (control) an input the TTL emptied is said to be emptied, and to select the file again: ' + JSON.stringify(control.notes));
    A.ok(during.notes.length === 1 && /"old\.txt" was kept 1 min \(the limit\) and dropped; no file input still held it \(it was cleared, or another file was selected there since\), so nothing was emptied\.$/.test(during.notes[0]) && !/select it again|holding it was emptied/.test(during.notes[0]),
      'A3 minor: the input left holding the newer selection is said to hold the old copy no more, with no "select it again" (was: "was emptied: select it again"): ' + JSON.stringify(during.notes));
    A.ok(late.notes.length === 1 && /"old\.txt" was kept 1 min \(the limit\) and dropped, but its file input could not be emptied: do not submit that form/.test(late.notes[0]) && !/holding it was emptied|nothing was emptied/.test(late.notes[0]),
      'A3 minor: a clear that gave up says only that (it could not tell, and changed nothing), never that it emptied anything: ' + JSON.stringify(late.notes));
  }

  // ---- SAID AS IT HAPPENED, in every note (polish A3 minor): a clear that found no input still holding the copy ----
  {
    const page = { sid: 's1', loader: 'L1' };
    const none = async () => ({ cleared: 0, paths: [] });   // clearFilesHolding: no input holds that very selection now
    const sw = makeUploadStage({ log: () => {}, docAlive: async () => true, clearInputs: none });
    const n1 = copy('n1.txt', page);
    await sw.add([n1]); sw.settle([n1], page);
    n1.bad = 'the staged upload was replaced';
    await sw.sweep();
    const sweptSaid = sw.takeNotes('agent');
    A.ok(n1.dropped === 1 && sweptSaid.length === 1 && /"n1\.txt" changed on disk .* so it was not sent; no file input still held it .*so nothing was emptied\.$/.test(sweptSaid[0]) && !/select it again/.test(sweptSaid[0]),
      'A3 minor: the sweep says no input still held the copy (was: "its file input was emptied: select it again"): ' + sweptSaid.join(' '));
    const ev = makeUploadStage({ log: () => {}, maxLive: 1, docAlive: async () => true, clearInputs: none });
    const e1 = copy('e1.txt', page), e2 = copy('e2.txt', page);
    for (const e of [e1, e2]) { await ev.add([e]); ev.settle([e], page); }
    const evSaid = ev.takeNotes('agent');
    A.ok(e1.dropped === 1 && evSaid.length === 1 && /"e1\.txt" was dropped: StarNet keeps at most 1 staged uploads .*oldest out first; no file input still held it/.test(evSaid[0]) && !/select it again/.test(evSaid[0]),
      'A3 minor: ...so does the eviction: ' + evSaid.join(' '));
    const rc = makeUploadStage({ log: () => {}, docAlive: async () => true, clearInputs: none });
    const r1 = copy('r1.txt', page), r2 = copy('r2.txt', page, { agentId: 'other' });
    await rc.add([r1, r2]); rc.settle([r1, r2], page);
    r1.bad = 'the staged upload\'s bytes changed'; r2.bad = 'the staged upload was replaced';
    let er = null;
    try { await rc.recheck('browser.click', 'agent'); } catch (e) { er = e; }
    A.ok(er && /^browser\.click was refused: an uploaded file changed on disk after you selected it, so it was not sent \("r1\.txt": the staged upload's bytes changed\); no file input still held it .*so nothing was emptied\. Also, a file another agent had selected in this browser changed on disk after it was selected, so it was dropped and not sent; no file input still held it\.$/.test(er.message),
      'A3 minor: ...and the refusal: no "select it again" for an input that holds the copy no more, nor "emptied" for another agent\'s: ' + (er && er.message));
    const toOther = rc.takeNotes('other');
    A.ok(toOther.length === 1 && /"r2\.txt" changed on disk .*; no file input still held it/.test(toOther[0]) && !/select it again/.test(toOther[0]), 'A3 minor: ...and the other agent\'s note: ' + toOther.join(' '));
    const ht = makeUploadStage({ log: () => {}, docAlive: async () => true, clearInputs: none });
    const h1 = copy('h1.txt', page, { agentId: 'alice' });
    await ht.add([h1]); ht.settle([h1], page);
    await ht.handTo('bob');
    A.eq(ht.takeNotes('bob'), ['A file another agent had selected in this browser was dropped when you took the browser over, and no file input still held it.'], 'A3 minor: ...and the take-over note');
    A.ok(h1.dropped === 1 && ht.size === 0, 'A3 minor: (control) what is dropped is unchanged: every such copy still goes');
  }

  // ---- WHO IS TOLD: a note or a refusal names a copy only to the agent whose file it is ----
  {
    const page = { sid: 's1', loader: 'L1' };
    const timers = [];
    const w = makeUploadStage({
      log: () => {}, keepMs: 60000, sweepMs: 3600000,
      setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.done = true; },
      docAlive: async () => true, clearInputs: async (_d, paths) => ({ cleared: 1, paths })
    });
    const expireAll = async () => { for (const t of timers.slice()) if (!t.done && t.ms === 60000) { t.done = true; t.fn(); } await tick(20); };
    // alice's copy outlives her run; its TTL runs out while nobody acts
    const a1 = copy('alice-medical.pdf', page, { agentId: 'alice' });
    await w.add([a1]); w.settle([a1], page);
    await expireAll();
    A.ok(a1.dropped === 1 && w.size === 0, 'R-A: (control) the TTL dropped alice\'s copy');
    A.eq(w.takeNotes('bob'), [], 'R-A: alice\'s TTL note is never said on bob\'s action (it named her file to him)');
    const toAlice = w.takeNotes('alice');
    A.ok(toAlice.length === 1 && /"alice-medical\.pdf" was kept 1 min \(the limit\) and dropped, and the file input holding it was emptied/.test(toAlice[0]),
      'R-A: ...it is said on alice\'s own next action: ' + toAlice.join(' '));
    A.eq(w.takeNotes('alice'), [], 'R-A: ...once');
    // queued, then bob takes the browser over with no copy of hers left: withheld from him (the station log has it)
    const a2 = copy('alice-2.pdf', page, { agentId: 'alice' });
    await w.add([a2]); w.settle([a2], page);
    await expireAll();
    await w.handTo('bob');
    A.eq(w.takeNotes('bob'), [], 'R-A: bob taking the browser after alice\'s copy expired is told nothing of it');
    A.eq(w.takeNotes('alice'), [], 'R-A: ...and a note about an earlier agent\'s copy is not kept once another agent took the browser');
    // another agent's copy changed before bob's action: emptied, dropped and refused all the same, but never named to him
    const a3 = copy('alice-3.pdf', page, { agentId: 'alice' }), b1 = copy('bob-own.txt', page, { agentId: 'bob' });
    await w.add([a3, b1]); w.settle([a3, b1], page);
    a3.bad = 'the staged upload\'s bytes changed';
    let eb = null;
    try { await w.recheck('browser.click', 'bob'); } catch (e) { eb = e; }
    A.ok(eb && /^browser\.click was refused: a file another agent had selected in this browser changed on disk after it was selected, so it was dropped and not sent, and its file input was emptied\. Retry the action\.$/.test(eb.message) && eb.hostAuthored === true,
      'R-A: an action refused for another agent\'s changed copy never names it: ' + (eb && eb.message));
    A.ok(a3.dropped === 1 && b1.dropped === 0 && w.size === 1, 'R-A: ...that copy is dropped all the same, and bob\'s own copy stays');
    A.eq(w.takeNotes('bob'), [], 'R-A: ...bob is told nothing more');
    const toAlice3 = w.takeNotes('alice');
    A.ok(toAlice3.length === 1 && /"alice-3\.pdf" changed on disk \(the staged upload's bytes changed\) and was dropped, so it was not sent; its file input was emptied/.test(toAlice3[0]),
      'R-A: ...and alice is told, on her own next action: ' + toAlice3.join(' '));
    // both changed: bob's own file is named to him, alice's only said to exist
    const a4 = copy('alice-4.pdf', page, { agentId: 'alice' });
    await w.add([a4]); w.settle([a4], page);
    a4.bad = 'the staged upload\'s bytes changed'; b1.bad = 'the staged upload was replaced';
    let eb2 = null;
    try { await w.recheck('browser.press', 'bob'); } catch (e) { eb2 = e; }
    A.ok(eb2 && /select it again \("bob-own\.txt": the staged upload was replaced\)\./.test(eb2.message) && /Also, a file another agent had selected in this browser changed on disk/.test(eb2.message) && !/alice/.test(eb2.message),
      'R-A: bob\'s own changed file is named to him, another agent\'s is not: ' + (eb2 && eb2.message));
    A.ok(a4.dropped === 1 && b1.dropped === 1 && w.size === 0 && w.takeNotes('alice').length === 1, 'R-A: ...both dropped, and alice is told of hers');
    // a note about several agents' copies (one input emptied whole) is said to neither of them: the station log only
    const mixLog = [];
    const mx = makeUploadStage({ log: m => mixLog.push(m), docAlive: async () => true, clearInputs: async () => ({ cleared: 1, paths: ['/stage/ma.txt', '/stage/mb.txt'] }) });
    const ma = copy('ma.txt', page, { agentId: 'alice' }), mb = copy('mb.txt', page, { agentId: 'bob' });
    await mx.add([ma, mb]); mx.settle([ma, mb], page);
    ma.bad = 'the staged upload\'s bytes changed';
    await mx.sweep();
    A.ok(ma.dropped === 1 && mb.dropped === 1 && mx.takeNotes('alice').length === 0 && mx.takeNotes('bob').length === 0 && mixLog.some(m => /"ma\.txt", "mb\.txt" changed on disk/.test(m)),
      'R-A: a note naming two agents\' copies is said to neither, only logged: ' + mixLog.join(' | '));
    await w.dropAll(); await mx.dropAll();
  }

  // ---- 2. the CDP driver's alive read: the browser's own events first, the renderer bounded ----
  {
    let currentUrl = 'about:blank', frameMode = 'answer', frameLoader = 'L1';
    const sent = [];
    class FakeWS {
      constructor() { this.handlers = {}; FakeWS.last = this; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
      fire(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
      event(method, params, sessionId) { this.fire('message', { data: JSON.stringify(Object.assign({ method, params }, sessionId ? { sessionId } : {})) }); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        if (m.method === 'Page.navigate') currentUrl = m.params.url;
        let reply;
        if (m.method === 'Page.getFrameTree') {
          if (frameMode === 'hang') return;   // a busy renderer answers nothing
          reply = frameMode === 'gone' ? { id: m.id, error: { message: 'No target with given id found' } } : { id: m.id, result: { frameTree: { frame: { id: 'F0', loaderId: frameLoader } } } };
        } else {
          let value = currentUrl;
          const ex = String(m.params && m.params.expression || '');
          if (m.method === 'Runtime.evaluate' && /return \{ready:/.test(ex)) value = { ready: true, error: null };
          else if (m.method === 'Runtime.evaluate' && /getHighEntropyValues/.test(ex)) value = { ua: 'HeadlessChrome/140.0.0.0', platform: 'Win32', hints: { brands: [], fullVersionList: [], platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', bitness: '64', mobile: false } };
          reply = { id: m.id, result: m.method === 'Runtime.evaluate' ? { result: { value } } : (m.method === 'Browser.getVersion' ? { product: 'HeadlessChrome/140.0.7339.12' } : {}) };
        }
        setTimeout(() => this.fire('message', { data: JSON.stringify(reply) }), 0);
      }
      close() {}
    }
    const fakeProc = pid => { let close; return { pid, on(ev, fn) { if (ev === 'close') close = fn; }, kill() { if (close) queueMicrotask(() => close(0)); } }; };
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 300, cdpPort: 9348, inputSleep: async () => {},
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://fake' }] }),
      WebSocketImpl: FakeWS, spawn: () => fakeProc(43)
    });
    await d.navigate('http://127.0.0.1:5173/');
    const frameReads = () => sent.filter(m => m.method === 'Page.getFrameTree').length;
    const doc = { sid: null, loader: 'L1' };
    // no event yet: the renderer is asked, bounded
    A.eq(await d.uploadDocAlive(doc), true, 'm4: with no navigation event the page is asked: its document is still the one the files went into');
    A.eq(await d.uploadDocAlive({ sid: null, loader: 'L0' }), false, 'm4: ...and a different document is gone');
    frameMode = 'hang';
    let t0 = Date.now();
    const unknown = await d.uploadDocAlive(doc);
    const took = Date.now() - t0;
    A.ok(unknown === null && took < 2500, 'm4: a page that answers nothing reads UNKNOWN (null), never gone, within its bound (' + took + ' ms; was: a throw after 15 s)');
    frameMode = 'gone';
    A.eq(await d.uploadDocAlive(doc), false, 'm4: a closed target reads gone');
    // Chrome reports the tab's main document committing: the event answers, the renderer is not asked
    frameMode = 'hang';
    FakeWS.last.event('Page.frameNavigated', { frame: { id: 'F0', loaderId: 'L1', url: 'http://127.0.0.1:5173/' } });
    let before = frameReads();
    t0 = Date.now();
    A.eq(await d.uploadDocAlive(doc), true, 'm4: a busy page whose reported document is the uploading one reads alive');
    A.ok(frameReads() === before && Date.now() - t0 < 100, 'm4: ...at once, with no command to its renderer');
    FakeWS.last.event('Page.frameNavigated', { frame: { id: 'IF', parentId: 'F0', loaderId: 'L-iframe' } });
    A.eq(await d.uploadDocAlive(doc), true, 'm4: an iframe navigating is not the page\'s document going');
    FakeWS.last.event('Page.frameNavigated', { frame: { id: 'F0', loaderId: 'L2', url: 'http://127.0.0.1:5173/posted' } });
    before = frameReads();
    A.eq(await d.uploadDocAlive(doc), false, 'm4: once Chrome reports a new main document (a submit that navigated), the uploading page is gone');
    A.eq(frameReads(), before, 'm4: ...known without asking the page');
    A.eq(await d.uploadDocAlive(null), null, 'no document identity: null (the registry falls back to the navigation epoch)');
    await d.close();
    A.eq(await d.uploadDocAlive(doc), false, 'a closed browser shows no page');
  }
  } finally { clearInterval(hold); }
  A.report('upload-stage');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
