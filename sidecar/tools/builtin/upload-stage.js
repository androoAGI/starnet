/* sidecar/tools/builtin/upload-stage.js — THE STAGED UPLOAD COPIES ONE BROWSER HOLDS (run-paths-polish, 2026-10-30).

   browser.upload hands a page a sha256-proven STAGED COPY of the file (sidecar/egress-files.js stage mode), never the
   file the agent named, and Chrome reads that copy at FORM SUBMIT, a later and separate action (review round 6). This
   registry keeps each copy honest between the selection and that read. It belongs to the BROWSER SESSION, not to one
   run's tools (browser.js makeBrowserSession creates it): the station browser outlives a run, and the page the agent
   filled in stays open for the person.

   THE REGRESSION IT FIXES (live walk W-R7 (b) on 0.14.2: select a file, the reply ends, the person clicks Submit
   later). The copies were deleted at every reply end (the host's run-end release), so the person's Submit failed in
   Chrome with ERR_FILE_NOT_FOUND while the input still showed the file, and the receipt had said the input held it.

   THE LIFECYCLE. No rule is loosened: every step is a check the copy must still pass, or a drop.
     add       browser.upload registers its copies BEFORE the hand-off, so a concurrent action re-proves them too. The
               TTL (keepMs, 30 min) starts here. BOUNDED, STRICTLY (Codex A3-CAP-01): at most 32 copies and 1 GB at
               once. One selection over that is refused whole (browser.upload refuses it before or while staging, and
               add refuses it again, registering none of it), never let in past the bound; within it, the oldest
               copies go first (a page that never navigates, re-selected many times), the inputs holding them emptied,
               and it is said.
     settle    the hand-off names the DOCUMENT the files went into: the tab's CDP session and its main frame's loaderId
               (a new loaderId for every new document), tied to the driver that made it (a new browser is a new page).
               A driver that cannot name the page settles null.
     recheck   BEFORE EVERY later agent browser action that can submit or read (any run's tools on this browser):
               copies whose document is gone are dropped, then every live copy is RE-PROVED (sha256, one name, dev/ino,
               size: egress-files.js verifyStaged). A changed copy empties every file input holding it (by the File's
               own path), is dropped, and refuses the action. A multi-file input is emptied whole, so every other copy
               it held is dropped too and named in the refusal (review round 7 minor 3).
     dropGone  AFTER every agent browser action: a copy whose document is gone (navigated away, its tab or its browser
               closed) is dropped. A submit that navigated keeps its copy until the new document COMMITS, and Chrome
               has sent the request body by then, so the drop-on-submit-navigation behaviour holds.
     sweep     every sweepMs (15 s) while copies live, with no agent action needed: dropGone, plus a quick identity
               re-check of each copy (one name, dev/ino, size, real path; no re-hash). A copy swapped or changed while
               nobody acts is dropped and its inputs emptied before the person can submit it, and it is said.
     expire    the TTL ran out: the inputs still holding the copy are emptied (the page never shows a file it cannot
               send), the copy is dropped, and it is said. ONLY THAT SELECTION (Codex A3-LIFE-01): an input is emptied
               only while it still holds the very File objects whose paths were proven to be the copy, checked and
               emptied in one page-side step (browser-upload.js clearFilesHolding), so a newer selection made in that
               input meanwhile (by the person, or a later upload) is left as it is. A clear still running after its
               bounded wait gave up is stopped before it changes anything (its signal is aborted).
               SAID AS IT HAPPENED (polish A3 minor): a note tells the copy's agent which of three things became of the
               input: emptied ("select it again"), not emptied in time ("do not submit that form"), or NO INPUT STILL
               HELD IT (cleared, or a newer selection there): nothing was emptied and nothing is to be selected again,
               so the agent never replaces the newer selection the identity check kept. The same in every note.
     release   the host's REPLY / RUN END. A copy whose document is ALIVE, or whose liveness could not be read in time
               (a busy page: unknown is never "gone", and the TTL bounds it), is KEPT: it outlives the reply while its
               document lives, still re-proved before every later agent action and still dropped by dropGone, the
               sweep, the TTL and the browser's close. A copy whose document is proven gone is dropped. A copy with no
               document identity (its receipt said "until this reply ends") is dropped after emptying the inputs
               holding it. ONLY ITS OWN (polish review round 1, minor 2): a run's end releases the copies that run's
               own tools selected, never another run's in the same browser (a second run's first browser.test_* call
               used to bind the station's registry and, at its end, drop the driving run's copy mid-reply).
     handTo    another AGENT takes the station browser: the copies an earlier agent selected are dropped and their
               inputs emptied (a copy is its producing run's file; another agent never submits it), and what was said
               about them and not yet read is withheld from the new agent (the station log keeps it).
     dropAll   the browser closes (the run's own browser at run end, the station window closed, reset, a mode switch,
               attach or detach; a browser that stays open without us is emptied first): every copy goes.
   Every drop goes through the copy's own unstage (egress-files.js dropStaged: never recursive, never through a link,
   the folder re-proven inside the staging root before every unlink). "It is said": the station log, and the result of
   the next browser action of the agent whose copy it was (takeNotes(agentId)). WHO IS TOLD (review round 2, minor
   R-A): the registry is the browser's, shared by every agent that drives the station, and a note or a refusal quotes a
   copy's name. A note is said only to that copy's own agent (one about several agents' copies goes to the station log
   only); an action refused for another agent's changed copy is told that much, never its name, and that agent is told
   on its own next action. A copy with no agent (an injected rig) is anyone's.
   A document-alive read is bounded (aliveTimeoutMs, over the driver's own 2 s CDP bound) and memoized per document
   within one pass, so a hung page answers "unknown" once per pass instead of stalling every gated action once per
   copy (review round 7 minor 4). Emptying inputs is bounded the same way (clearTimeoutMs).

   HONEST LIMIT (egress-files.js THE THREAT MODEL): the full re-proof runs before AGENT actions. The person's own input
   to the station browser (its window, the BROWSER pane, STEP-IN, sign-in) is not gated, so a submit the person makes
   after the reply ended reads the copy as it is then: the sweep's quick identity check narrows that window to sweepMs
   for a swapped or resized copy, not for an in-place overwrite of the same size. Chrome reads the file for as long as
   the request body takes, and a page's own chunked uploader reads it whenever it likes. A swap in those windows is not
   caught here; the FOLLOW-UP (not built) verifies at the network boundary with CDP Fetch interception. A page restored
   from history after its copy was dropped (back/forward form-state restore) may show the file again; its submit then
   finds no file and sends none.

   makeUploadStage({ docAlive, clearInputs, clearByRef, navEpoch, keepMs, sweepMs, aliveTimeoutMs, clearTimeoutMs,
                     maxLive, maxLiveBytes, setTimeout, clearTimeout, log }) -> stage
     docAlive(doc)           -> true | false | null (cannot tell)
     clearInputs(doc, paths, { signal })
                             -> { cleared, paths? } (cleared: the inputs emptied, 0 when none still held it; paths:
                                every File path the emptied inputs held) | null (this
                                driver cannot clear by the File's identity); throws when an input could not be emptied.
                                signal: aborted once the bounded wait gave up, so nothing is changed after it
     clearByRef(ref)         the last resort for a driver with no identity clear (an injected test driver only)
   A copy: { dir, name, path, size, ino, dev, nlink, sha256, shown, ref, agentId, doc, epoch, verify(opts), unstage() } */
'use strict';
const { note: failNote } = require('../../failopen.js');

const UPLOAD_KEEP_MS = 30 * 60 * 1000;   // a staged copy outlives the reply for at most this long
const UPLOAD_SWEEP_MS = 15 * 1000;       // while copies live, gone documents and swapped copies are noticed within this long
const DOC_ALIVE_TIMEOUT_MS = 2500;       // the CDP driver bounds its own Page.getFrameTree at 2 s; this bounds any driver
const CLEAR_TIMEOUT_MS = 5000;           // emptying the inputs of a busy page never holds a pass for longer
const UPLOAD_MAX_LIVE = 32;              // staged copies one browser keeps at once (oldest out first)
const UPLOAD_MAX_LIVE_BYTES = 1024 * 1024 * 1024;   // ...and their bytes on disk at once
const NOTES_MAX = 6;
const STAGE_MARK = Symbol.for('starnet.uploadStage');
const SEVERAL = Symbol('several agents');   // a note about more than one agent's copies: the station log only

function isUploadStage(s) { return !!(s && typeof s === 'object' && s[STAGE_MARK] === true); }
// one spelling per file for comparing a File's path with a copy's (Windows paths compare without case)
function samePath(p) { const r = require('node:path').resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; }
// whose file a copy is (null: no agent, an injected rig's copy) and whose a set of copies is (one agent, null, or SEVERAL)
function agentOf(c) { return c && c.agentId ? String(c.agentId) : null; }
function ownerOf(cs) {
  let who = null;
  for (const c of cs) { const a = agentOf(c); if (a === null) continue; if (who === null) who = a; else if (who !== a) return SEVERAL; }
  return who;
}
// may agent `me` (null: unknown) be told about copies owned by `who`?
function isFor(who, me) { return who === null || (me !== null && who === me); }
function agentKey(agentId) { return agentId == null || agentId === '' ? null : String(agentId); }

function makeUploadStage(deps) {
  deps = deps || {};
  const docAlive = typeof deps.docAlive === 'function' ? deps.docAlive : async () => null;
  const clearInputs = typeof deps.clearInputs === 'function' ? deps.clearInputs : null;
  const clearByRef = typeof deps.clearByRef === 'function' ? deps.clearByRef : null;
  const navEpoch = typeof deps.navEpoch === 'function' ? deps.navEpoch : () => null;
  const keepMs = Number(deps.keepMs) > 0 ? Number(deps.keepMs) : UPLOAD_KEEP_MS;
  const sweepMs = Number(deps.sweepMs) > 0 ? Number(deps.sweepMs) : UPLOAD_SWEEP_MS;
  const aliveTimeoutMs = Number(deps.aliveTimeoutMs) > 0 ? Number(deps.aliveTimeoutMs) : DOC_ALIVE_TIMEOUT_MS;
  const clearTimeoutMs = Number(deps.clearTimeoutMs) > 0 ? Number(deps.clearTimeoutMs) : CLEAR_TIMEOUT_MS;
  const maxLive = Number(deps.maxLive) > 0 ? Number(deps.maxLive) : UPLOAD_MAX_LIVE;
  const maxLiveBytes = Number(deps.maxLiveBytes) > 0 ? Number(deps.maxLiveBytes) : UPLOAD_MAX_LIVE_BYTES;
  const setT = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
  const clearT = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
  const log = typeof deps.log === 'function' ? deps.log : (m => console.log('[browser.upload] ' + m));
  const live = new Set();
  const notes = [];
  let sweepTimer = null, sweeping = false;
  const unref = t => { if (t && typeof t.unref === 'function') t.unref(); return t; };
  const minutes = () => Math.max(1, Math.round(keepMs / 60000)) + ' min';
  const mb = n => Math.round(n / 1048576) + ' MB';
  // the one refusal for a selection over the bound (browser.upload says it before staging when it can)
  function boundRefusal(n, bytes) {
    return 'a browser upload takes at most ' + maxLive + ' files and ' + mb(maxLiveBytes) + ' at once (StarNet keeps no more staged copies than that per browser); this selection is '
      + (n > maxLive ? n + ' files' : 'over ' + mb(maxLiveBytes)) + ', so nothing was selected or uploaded. Select fewer or smaller files';
  }
  const named = cs => cs.map(c => '"' + c.shown + '"').join(', ');
  // said in the station log now, and on the next browser action of `who` (the agent whose copies it names; a note
  // given no owner is said to nobody)
  function note(text, who) { notes.push({ text, who }); if (notes.length > NOTES_MAX) notes.shift(); log(text); }
  // a value, or `fallback` once `ms` passed. The call gets a signal that is aborted then: one that would still
  // change something (empty an input) stops instead (Codex A3-LIFE-01); a read is left to finish on its own
  async function bounded(fn, ms, fallback) {
    let timer = null;
    const signal = { aborted: false };   // a plain flag (no AbortController: this module also runs in bare VM contexts)
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn(signal)),
        new Promise(resolve => { timer = unref(setT(() => { signal.aborted = true; resolve(fallback); }, ms)); })
      ]);
    } finally { if (timer) clearT(timer); }
  }

  function armSweep() {
    if (sweepTimer || sweeping || !live.size) return;
    sweepTimer = unref(setT(async () => {
      sweepTimer = null; sweeping = true;
      try { await sweep(); } catch (e) { failNote('browser.upload.sweep', e); }
      finally { sweeping = false; }
      armSweep();
    }, sweepMs));
  }
  function disarmIfEmpty() { if (!live.size && sweepTimer) { clearT(sweepTimer); sweepTimer = null; } }

  // -> true | false | null, bounded in time; memo: one read per document within one pass
  async function aliveOf(c, memo) {
    const d = c.doc;
    if (!d) {
      // no page identity (an injected driver): only the session's navigation epoch can say the page changed
      const now = navEpoch();
      return c.epoch == null || now == null || now === c.epoch ? null : false;
    }
    if (memo) for (const [k, p] of memo) if (k.drv === d.drv && k.sid === d.sid && k.loader === d.loader) return p;
    const read = (async () => {
      try {
        const v = await bounded(() => docAlive(d), aliveTimeoutMs, null);
        return v === true ? true : v === false ? false : null;
      } catch (e) { failNote('browser.upload.doc-alive', e); return null; }
    })();
    if (memo) memo.set(d, read);
    return read;
  }

  // one copy off the books and off the disk (idempotent: a copy is unstaged once)
  async function unstage(c) {
    if (!live.delete(c)) return false;
    if (c.ttl) { clearT(c.ttl); c.ttl = null; }
    disarmIfEmpty();
    try { await c.unstage(); } catch (e) { failNote('browser.upload.unstage', e); }
    return true;
  }
  // empty every file input holding c: by the File's own path, the ref only for a driver that cannot. -> { emptied: no
  // input holds c now, none: and none was emptied for it (no input still held that very selection), others: the OTHER
  // live copies an emptied input also held (a multi-file input is emptied whole) }
  async function emptyInputsHolding(c) {
    const out = { emptied: false, none: false, others: [] };
    try {
      const r = clearInputs ? await bounded(signal => clearInputs(c.doc, [c.path], { signal }), clearTimeoutMs, undefined) : null;
      if (r && typeof r === 'object') {
        out.emptied = true;
        out.none = r.cleared === 0 || r.cleared === false;
        const held = new Set((Array.isArray(r.paths) ? r.paths : []).map(samePath));
        for (const o of live) if (o !== c && held.has(samePath(o.path))) out.others.push(o);
      } else if (r === null && clearByRef && c.ref) {
        const byRef = await bounded(() => clearByRef(c.ref), clearTimeoutMs, undefined);
        out.emptied = byRef != null;   // null: no driver to ask; undefined: it did not answer in time
      }
    } catch (e) { failNote('browser.upload.clear', e); }
    return out;
  }
  // empty, then drop, c and every copy its emptied input also held -> { emptied, none, group }
  async function cancelOne(c) {
    const r = await emptyInputsHolding(c);
    const group = [c].concat(r.others);
    for (const o of group) await unstage(o);
    return { emptied: r.emptied, none: r.none, group };
  }
  // what a note says became of the input that held a dropped copy (r: cancelOne's; emptied: its words for an input this
  // drop emptied). No input still held it: nothing to select again (that would replace the newer selection kept there)
  const NONE_HELD = 'no file input still held it (it was cleared, or another file was selected there since), so nothing was emptied.';
  const inputSaid = (r, emptied) => r.none ? NONE_HELD : r.emptied ? emptied : 'its file input could not be emptied: do not submit that form until the file is selected again.';

  const stage = {
    [STAGE_MARK]: true,
    keepMs, maxLive, maxLiveBytes,
    get size() { return live.size; },
    copies() { return Array.from(live); },
    // register copies before their hand-off; the TTL starts now. BOUNDED: one selection over maxLive copies or
    // maxLiveBytes is refused whole (none registered: the caller drops them); within it, past maxLive copies or
    // maxLiveBytes at once (a page that never navigates, re-selected many times), the OLDEST go first, their inputs
    // emptied, and it is said
    async add(copies) {
      const fresh = copies.filter(c => !live.has(c));
      const freshBytes = fresh.reduce((n, c) => n + (Number(c.size) || 0), 0);
      if (fresh.length > maxLive || freshBytes > maxLiveBytes) {
        const err = new Error(boundRefusal(fresh.length, freshBytes));
        err.code = 'EUPLOADBOUND'; err.hostAuthored = true;
        throw err;
      }
      for (const c of copies) {
        if (live.has(c)) continue;
        live.add(c);
        c.ttl = unref(setT(() => { expire(c).catch(e => failNote('browser.upload.expire', e)); }, keepMs));
      }
      armSweep();
      let bytes = 0;
      for (const c of live) bytes += Number(c.size) || 0;
      for (const old of Array.from(live)) {
        if (live.size <= maxLive && bytes <= maxLiveBytes) break;
        if (copies.indexOf(old) >= 0 || !live.has(old)) continue;
        const r = await cancelOne(old);
        for (const g of r.group) bytes -= Number(g.size) || 0;
        note('The staged upload copy of ' + named(r.group) + ' was dropped: StarNet keeps at most ' + maxLive + ' staged uploads (' + Math.round(maxLiveBytes / 1048576) + ' MB) at once, oldest out first; '
          + inputSaid(r, 'the file input holding it was emptied: select it again before that form is submitted.'), ownerOf(r.group));
      }
    },
    // the document the hand-off went into (null: this driver cannot name it)
    settle(copies, doc) { for (const c of copies) c.doc = doc && typeof doc === 'object' ? doc : null; },
    // drop copies nothing was handed to (no input can hold them)
    async drop(copies) { for (const c of copies) await unstage(c); },
    // a failed or changed hand-off: empty the inputs holding them, then drop them. -> { emptied }
    async cancel(copies) {
      let emptied = true;
      for (const c of copies) {
        if (!live.has(c)) continue;
        if (!(await cancelOne(c)).emptied) emptied = false;
      }
      return { emptied };
    },
    recheck, dropGone, sweep, release, handTo, dropAll, boundRefusal,
    // what was said that concerns this agent's own copies (said once); every other note stays for its own agent
    takeNotes(agentId) {
      const me = agentKey(agentId), out = [];
      for (let i = 0; i < notes.length;) { if (isFor(notes[i].who, me)) out.push(notes.splice(i, 1)[0].text); else i++; }
      return out;
    }
  };

  // BEFORE an agent browser action: gone pages' copies go, every other copy is re-proved; a change refuses the action.
  // agentId: who acts. Another agent's changed copy is emptied, dropped and refuses the action all the same, but the
  // refusal never names it: its own agent is told, on its own next action
  async function recheck(toolName, agentId) {
    if (!live.size) return;
    const me = agentKey(agentId);
    await dropGone();
    const changed = [];
    for (const c of Array.from(live)) {
      let v;
      try { v = await c.verify(); } catch (e) { v = { ok: false, error: 'the staged upload could not be re-verified (' + ((e && e.code) || 'error') + ')' }; }
      // a copy dropped meanwhile (the sweep, the TTL) is gone, not changed
      if ((!v || !v.ok) && live.has(c)) changed.push({ c, why: (v && v.error) || 'the staged upload could not be re-verified' });
    }
    if (!changed.length) return;
    let unemptied = false, theirsUnemptied = false, theirsEmptied = false;
    const also = [];
    for (const x of changed) {
      if (!live.has(x.c)) continue;   // an earlier changed copy's input held it too: already emptied and dropped
      const r = await cancelOne(x.c);
      if (!isFor(agentOf(x.c), me)) {
        if (!r.emptied) theirsUnemptied = true; else if (!r.none) theirsEmptied = true;
        note('The staged upload copy of ' + named(r.group) + ' changed on disk (' + x.why + ') and was dropped, so it was not sent; '
          + inputSaid(r, 'its file input was emptied: select it again before that form is submitted.'), ownerOf(r.group));
        continue;
      }
      if (!r.emptied) unemptied = true;
      x.none = r.none;
      for (const o of r.group) if (o !== x.c && !changed.some(y => y.c === o) && isFor(agentOf(o), me)) also.push(o);
    }
    const own = changed.filter(x => isFor(agentOf(x.c), me));
    const theirs = 'a file another agent had selected in this browser changed on disk after it was selected, so it was dropped and not sent'
      + (theirsUnemptied ? '; its file input could not be emptied: do not submit that form.' : theirsEmptied ? ', and its file input was emptied.' : '; no file input still held it.');
    const whyOwn = own.map(x => '"' + x.c.shown + '": ' + x.why).join('; ');
    const err = new Error(!own.length ? toolName + ' was refused: ' + theirs + ' Retry the action.'
      : toolName + ' was refused: an uploaded file changed on disk after you selected it, so it was not sent'
      + (own.every(x => x.none) ? ' (' + whyOwn + '); ' + NONE_HELD : '; select it again (' + whyOwn + ').')
      + (also.length ? ' Its file input was emptied, so select ' + named(also) + ' again too.' : '')
      + (unemptied ? ' Its file input could not be emptied, and the staged copy is gone: do not submit that form until the file is selected again.' : '')
      + (own.length < changed.length ? ' Also, ' + theirs : ''));
    err.hostAuthored = true;   // the host wrote it (no page bytes): its tool line shows the reason (run-paths-polish P2)
    throw err;
  }
  // AFTER an action: a copy whose document is gone goes (no input of a gone page is left to empty)
  async function dropGone() {
    if (!live.size) return;
    const memo = new Map();
    for (const c of Array.from(live)) {
      if ((await aliveOf(c, memo)) === false) await unstage(c);
    }
  }
  // THE SWEEP, with no agent action: gone documents, and a quick identity re-check of every copy (no re-hash)
  async function sweep() {
    if (!live.size) return;
    await dropGone();
    for (const c of Array.from(live)) {
      let v;
      try { v = await c.verify({ quick: true }); } catch (e) { v = { ok: false, error: 'the staged upload could not be re-verified (' + ((e && e.code) || 'error') + ')' }; }
      if ((v && v.ok) || !live.has(c)) continue;
      const r = await cancelOne(c);
      note('The staged upload copy of ' + named(r.group) + ' changed on disk (' + ((v && v.error) || 'it could not be re-verified') + ') and was dropped, so it was not sent; '
        + inputSaid(r, 'its file input was emptied: select it again before that form is submitted.'), ownerOf(r.group));
    }
  }
  // THE TTL: the copy has been kept as long as it may be. Inputs still holding it are emptied first.
  async function expire(c) {
    if (!live.has(c)) return;
    c.ttl = null;
    if ((await aliveOf(c, null)) === false) { await unstage(c); return; }   // its page is gone: nothing shows it
    const r = await cancelOne(c);
    const kept = 'The staged upload copy of ' + named(r.group) + ' was kept ' + minutes() + ' (the limit) and dropped';
    note(r.none ? kept + '; ' + NONE_HELD
      : r.emptied ? kept + ', and the file input holding it was emptied: select it again before that form is submitted.'
        : kept + ', but its file input could not be emptied: do not submit that form until the file is selected again.', ownerOf(r.group));
  }
  // THE HOST'S REPLY / RUN END: a copy outlives the reply only while its document is alive (or unreadable in time).
  // only: the copies that run selected (a Set, or a predicate); another run's copies in this browser are never its to drop
  async function release(only) {
    if (!live.size) return;
    const mine = only == null ? () => true : typeof only === 'function' ? only : c => only.has(c);
    const memo = new Map();
    for (const c of Array.from(live)) {
      if (!live.has(c) || !mine(c)) continue;
      if (!c.doc) {
        // no page identity: it lives only until the reply ends (its receipt said so); an input still holding it is emptied
        const r = await cancelOne(c);
        log('the staged upload copy of ' + named(r.group) + ' was dropped at the end of the reply (this browser cannot name its page)'
          + (r.none ? '; no file input still held it' : r.emptied ? '; its file input was emptied' : '; its file input could not be emptied'));
        continue;
      }
      if ((await aliveOf(c, memo)) === false) await unstage(c);
    }
  }
  // ANOTHER AGENT takes the browser: an earlier agent's copies are never its to submit, and what was said about them is
  // never its to read (the station log keeps it): withheld even when no copy is left (a TTL that fired after that run)
  async function handTo(agentId) {
    const who = agentKey(agentId);
    if (!who) return;
    for (let i = notes.length - 1; i >= 0; i--) if (!isFor(notes[i].who, who)) notes.splice(i, 1);
    if (!live.size) return;
    let dropped = 0, unemptied = false, emptiedOne = false;
    for (const c of Array.from(live)) {
      if (!live.has(c) || !c.agentId || String(c.agentId) === who) continue;
      const r = await cancelOne(c);
      dropped += r.group.length;
      if (!r.emptied) unemptied = true; else if (!r.none) emptiedOne = true;
    }
    if (dropped) note('A file another agent had selected in this browser was dropped when you took the browser over, '
      + (unemptied ? 'but its file input could not be emptied: do not submit that form.' : emptiedOne ? 'and its file input was emptied.' : 'and no file input still held it.'), who);
  }
  // THE BROWSER CLOSES: every copy goes (opts.clear: empty the inputs first, for a browser that stays open without us)
  async function dropAll(opts) {
    for (const c of Array.from(live)) {
      if (!live.has(c)) continue;
      if (opts && opts.clear) await cancelOne(c);
      else await unstage(c);
    }
  }
  return stage;
}

module.exports = { makeUploadStage, isUploadStage, UPLOAD_KEEP_MS, UPLOAD_SWEEP_MS, DOC_ALIVE_TIMEOUT_MS, CLEAR_TIMEOUT_MS, UPLOAD_MAX_LIVE, UPLOAD_MAX_LIVE_BYTES };
