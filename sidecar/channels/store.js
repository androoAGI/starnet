/* sidecar/channels/store.js — durable per-chat memory for the messaging ingress (C4).

   The run host (index.js /api/run) is STATELESS: the caller supplies the full `messages` array each call, and
   browser history lives only in localStorage. A messaging chat has no browser holding its transcript, so the
   adapter must own its own durable per-chat memory. This module is that store:

     makeChannelStore({ fs, pathMod, root, clock, limits?, timers?, holding?, ledgerLimits? }) -> {
       ledger                          -> the DELIVERY LEDGER over channels/delivery.json (channels/delivery-ledger.js)
       makeEphemeralLedger()           -> the same ledger code with nothing on disk (a one-job hub, fire-store.js)
       migrateV1()                     -> bool                   // inbox.json + outbox.json into the ledger; never throws
       loadHistory(agentId)            -> [{role,content,ts}]     // [] on missing/corrupt (fail-closed)
       appendTurn(agentId, role, text) -> messages[]             // appends + trims tail, persists atomically
       loadChatMap()                   -> { version, chats }
       getChatRecord(chatId)           -> record | undefined
       saveChatRecord(chatId, patch)   -> record                 // merge-and-persist one chat's mapping/config
       bootId                          -> string                 // this process's boot, stamped on every attempt
     }
   The receipts, run attempts and replies a hub owes live in the delivery ledger (channels/delivery.json); the v1 files
   it replaced (inbox.json, outbox.json) are only read, once, by migrateV1 — at construction, never throwing.

   Files live under WORKSPACES/channels/ — SIBLINGS of the notebook store, OUTSIDE the agent's fs jail
   (WORKSPACES/<agentId>/), so the agent's own fs.* tools can neither read nor corrupt its conversation history
   or the chat→agent map (the same containment the notebook already has):
     • <root>/<agentId>.history.json  = { version:1, messages:[{role,content,ts}] }
     • <root>/chatmap.json            = { version:1, chats:{ "<chatId>": { agentId, model, persona, ... } } }

   Save-safe (sidecar/persist): versioned; atomic temp+rename; a missing/corrupt file loads as empty (its bad bytes kept
   aside as <file>.corrupt-<n>), and one that cannot be read right now throws ESTORE_UNREADABLE, never empty. History is
   trimmed (lossy) on write to a bounded tail so the file and the replayed prompt stay within budget. Pure +
   deterministic: all I/O is the injected `fs` (sync), time is the injected `clock` — no Date.now/rng. */
'use strict';
(function (root, factory) {
  const api = factory(typeof module !== 'undefined' && module.exports ? require('../../frontend/app/turnkinds.js') : root.TurnKinds);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.store = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TurnKinds) {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  // the DELIVERY LEDGER (channels/delivery-ledger.js): every receipt, run attempt and reply, in channels/delivery.json
  const Ledger = (typeof require === 'function') ? require('./delivery-ledger.js') : null;

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;            // same agentId grammar as the notebook/fs jail
  const DEFAULTS = { maxTurns: 40, maxChars: 24000 };  // bound the on-disk + replayed transcript
  let storeSeq = 0;   // per-module instance counter: part of each store's bootId (makeChannelStore)

  // A Set, not an object literal: `({user:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key. A hand-corrupted history claiming role:'constructor' or
  // role:'toString' therefore survived the "keep only well-formed turns" filter (while a plausible-looking
  // role:'tool' was correctly dropped) and went to the provider as an invalid role — a 400 that wedges the
  // channel agent, which is exactly what this filter exists to prevent.
  const ROLES = new Set(['user', 'assistant', 'system']);

  /* LEGACY HOP TURNS IN A PER-AGENT HISTORY (sec-taint2 09-25). Before hop history was keyed per chat lineage (hub.js
     hopHistoryKey, commit d37b81a57), a downstream work-line hop appended its handoff turn (the upstream stage's
     OUTPUT — possibly text that stage read from a hostile page) and its own reply under the BARE agentId, i.e. into
     the very file that agent's direct chat replays. Those turns survive on disk in existing stations. They are
     recognised by the exact head chain.js/pipeline.js handoffPrompt has always written, and are dropped from what is
     REPLAYED: the handoff user turn plus the hop's reply straight after it. Hop-keyed histories (hop_<32 hex>) are
     where handoffs legitimately live and are never filtered. Non-destructive: loadHistory only filters; the first
     appendTurn that would rewrite such a file first archives the untouched envelope beside it
     (<agentId>.history.legacy-hops.json, written once, never overwritten), and only then drops the turns. */
  const HOP_KEY_RE = /^hop_[0-9a-f]{32}$/;
  function withoutLegacyHops(msgs) {
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m && m.role === 'user' && TurnKinds.classify(m).kind === 'hop') {
        dropped++;
        if (msgs[i + 1] && msgs[i + 1].role === 'assistant') { dropped++; i++; }   // the hop's own reply to that handoff
        continue;
      }
      kept.push(m);
    }
    return { kept, dropped };
  }

  function trimTail(messages, maxTurns, maxChars) {
    let m = messages.slice(-maxTurns);
    let total = 0;
    for (const x of m) total += (x && typeof x.content === 'string') ? x.content.length : 0;
    while (m.length > 1 && total > maxChars) {
      total -= (m[0] && typeof m[0].content === 'string') ? m[0].content.length : 0;
      m = m.slice(1);
    }
    return m;
  }

  function makeChannelStore(deps) {
    const d = deps || {};
    const fs = d.fs;
    const pathMod = d.pathMod;
    const root = d.root;
    const clock = d.clock;
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function')
      throw new Error('makeChannelStore: an injected fs (readFileSync/writeFileSync/renameSync[/mkdirSync]) is required');
    if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeChannelStore: an injected pathMod is required');
    if (!root) throw new Error('makeChannelStore: a root dir is required');
    if (!clock || typeof clock.now !== 'function') throw new Error('makeChannelStore: an injected clock is required');
    const limits = Object.assign({}, DEFAULTS, d.limits || {});

    // P2: every write is sidecar/persist's atomic, durable replace: through the host's writer when it injects one (index.js:
    // writeFileDurable, so the update freeze holds for every channel write), else persist.writeAtomic itself (fsync before
    // the rename where the fs has one; a facade without fsync still gets temp + rename). onRecover (optional) is called
    // when a torn/corrupt main was recovered from its .bak last-known-good.
    const persist = require('../persist/index.js');
    const writeDurable = (typeof d.writeDurable === 'function') ? d.writeDurable : persist.writeAtomic;
    const onRecover = (typeof d.onRecover === 'function') ? d.onRecover : function () {};

    let rootReady = false;   // mkdir once, not before every write (a removed dir is re-made on the ENOENT retry in writeRaw)
    function ensureRoot() { if (rootReady) return; try { if (fs.mkdirSync) fs.mkdirSync(root, { recursive: true }); rootReady = true; } catch (_) {} }
    function historyFile(agentId) {
      if (!AID_RE.test(String(agentId))) throw new Error('bad channel agentId: ' + agentId);
      return pathMod.join(root, agentId + '.history.json');
    }
    const chatMapFile = () => pathMod.join(root, 'chatmap.json');
    const outboxFile = () => pathMod.join(root, 'outbox.json');
    const inboxFile = () => pathMod.join(root, 'inbox.json');
    /* THIS STORE'S BOOT (e5ecd6b8 review, 2026-10-21). The delivery ledger stamps it on every attempt mark, so a
       re-delivered receipt tells a run that died with an earlier process (a crash, an update) from one this very process
       left pending (its processing threw): the attempt rule is the same for both, and the chat is told which it was. One
       store per save dir per sidecar (index.js), so this is the process's boot. Built from the injected clock, the pid
       and a per-module counter: no rng, and two instances in one process (tests) never share one. Injectable for tests. */
    const bootId = (d.bootId != null && String(d.bootId)) ? String(d.bootId).slice(0, 200)
      : String(clock.now()) + '-' + String((typeof process !== 'undefined' && process && process.pid) || 0) + '-' + (++storeSeq);

    /* PARSED-FILE CACHE (perf review 10-19: ~10 fsyncs + 14 whole-file parses per inbound DM). This store is its files'
       only writer (one sidecar per WORKSPACES dir; channels/ sits outside every agent's fs jail), so what it last wrote
       or read is still the truth on the next call — unless something else replaced the file. Every read therefore
       still asks the DISK, with one statSync instead of open + read + close + parse: a hit needs the same size, mtime
       AND inode, so an external replace (station recovery, a hand edit, a torn or zero-length main) always misses and
       re-reads exactly as before. A written file is cached as the exact text written and parsed only if it is read
       again. Callers mutate what they get back (saveChatRecord, bumpOutboxTry), so a hit hands out a deep copy and the
       cache never holds a caller's object. An fs without statSync (the in-memory test facades) is never cached. */
    const canStat = typeof fs.statSync === 'function';
    const cache = new Map();   // file -> { key: 'size:mtimeMs:ino', value?, text? }
    const clone = typeof structuredClone === 'function' ? structuredClone : function (v) { return JSON.parse(JSON.stringify(v)); };
    function stampOf(file) { const st = fs.statSync(file); return st.size + ':' + st.mtimeMs + ':' + st.ino; }
    function cachedHit(file) {   // the cache entry when the file on disk is still the one it describes, else null
      if (!canStat) return null;
      const hit = cache.get(file);
      if (!hit) return null;
      let key = null;
      try { key = stampOf(file); } catch (_) { key = null; }
      if (key !== hit.key) { cache.delete(file); return null; }
      if (hit.value === undefined) { hit.value = JSON.parse(hit.text); hit.text = undefined; }
      return hit;
    }
    /* ONE FILE: sidecar/persist's read (readOne) behind the stat cache -> { kind: 'ok', value } | 'absent' (ENOENT/ENOTDIR)
       | 'empty' / 'corrupt' (present but bad: a torn write) | 'unreadable' (err). Only a good read is ever cached.
       UNREADABLE IS NOT ABSENT (quick win 34): a file Windows reports EBUSY/EPERM/EACCES — an antivirus scan or an indexer
       holding it — is not an absent file. Read as absent, the read-modify-write callers (saveChatRecord, appendTurn,
       pushOutbox…) wrote an empty or .bak-old document over the real one and every other chat's record was gone. */
    function readFile(file) {
      const hit = cachedHit(file);
      if (hit) return { kind: 'ok', value: clone(hit.value) };
      let key = null;
      if (canStat) {
        try { key = stampOf(file); }
        catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { kind: 'absent' }; }   // else the read decides
      }
      const r = persist.readOne(fs, file);
      if (r.kind !== 'ok' || !key) return r;
      cache.set(file, { key: key, value: r.value });
      return { kind: 'ok', value: clone(r.value) };
    }
    // the refusal every persist store gives for bytes it cannot read right now: typed, the errno as its cause
    function unreadable(file, err) {
      const e = new Error('channels: ' + file + ' cannot be read right now (' + ((err && err.code) || 'EUNKNOWN') + '); refusing to treat it as empty');
      e.code = 'ESTORE_UNREADABLE';
      e.cause = err;
      e.file = file;
      return e;
    }
    // ONE file: its value, or undefined when it is absent or bad. An unreadable file THROWS ESTORE_UNREADABLE: the caller's
    // own guard reports it, the write it would have fed is refused, and the next attempt reads the real file.
    function readRaw(file) {
      const r = readFile(file);
      if (r.kind === 'unreadable') throw unreadable(file, r.err);
      return r.kind === 'ok' ? r.value : undefined;
    }
    /* readJson — the main, else its <file>.bak last-known-good, under persist's ONE READ POLICY: a present-but-bad main is
       moved aside to the first free <file>.corrupt-<n> whether or not the .bak recovers it, and a bad .bak too when no good
       copy is left, so the next write never drops torn bytes (a move that fails leaves them for that write to keep first,
       or to refuse). An unreadable main, or an unreadable .bak behind a missing or bad main, throws ESTORE_UNREADABLE:
       never empty, never a stale .bak, nothing moved. undefined = absent, or nothing good left (fail-closed: empty). */
    function readJson(file) {
      const m = readFile(file);
      if (m.kind === 'ok') return m.value;
      if (m.kind === 'unreadable') throw unreadable(file, m.err);
      const b = readFile(file + '.bak');
      if (b.kind === 'unreadable') throw unreadable(file + '.bak', b.err);
      if (persist.isBad(m.kind)) setAside(file);
      if (b.kind === 'ok') { try { onRecover(file); } catch (e) { failNote('channels.store.onRecover', e); } return b.value; }
      if (persist.isBad(b.kind)) setAside(file + '.bak');
      return undefined;
    }
    function setAside(file) {
      cache.delete(file);   // that name is about to hold something else, or nothing
      const moved = persist.moveAside({ fs: fs }, file, persist.names.LABELS.CORRUPT);
      if (moved.ok) console.warn('[channels] bad store bytes ' + file + ' moved aside to ' + moved.to + ' (kept, never silently wiped).');
      else if (!moved.absent) failNote('channels.store.quarantine', moved.error);
    }
    // writeRaw — ONE plain atomic, durable replace of `file` (no .bak policy: writeJsonAtomic below is the last-known-good
    // replace), through writeDurable (above). A channels dir removed since the last write is re-made, once (inRoot).
    function writeRaw(file, value) {
      const text = JSON.stringify(value);
      cache.delete(file);
      inRoot(function () { writeDurable({ fs: fs, path: pathMod }, file, text); });
      remember(file, text);
    }
    /* writeJsonAtomic — THE LAST-KNOWN-GOOD REPLACE, persist's replaceJson: the good main becomes <file>.bak by HARD LINK
       (two metadata ops, never a second durable write: those bytes were made durable when they were written as the main;
       a durable copy without hard links), a present-but-bad main is kept as <file>.corrupt-<n> before it is replaced
       (ESTORE_CORRUPT, bytes untouched, when it cannot be kept), and a .bak that cannot be refreshed never blocks the
       write. Every caller is a SYNCHRONOUS read-modify-write (readJson -> mutate -> writeJsonAtomic, no await between),
       serialized per file by the event loop, so its value is built on what it just read (persist's `seen`). The stat
       cache is the prior: a main this store last wrote or read, unchanged on disk, is not read again, so a warm DM reads
       nothing and each mutation is one durable write. */
    function writeJsonAtomic(file, value) {
      const bak = file + '.bak';
      const hit = cachedHit(file);
      cache.delete(file);
      cache.delete(bak);
      const did = inRoot(function (retry) {
        return persist.replaceJson({ fs: fs, path: pathMod, writeDurable: writeDurable }, file, value,
          { prior: hit && !retry ? { status: 'ok' } : undefined, seen: true });   // a retry reads what is there now
      });
      remember(file, did.text);
      if (hit && did.backup === 'link') cache.set(bak, hit);   // one inode, one stamp: the old main's entry is the .bak's
    }
    function inRoot(put) {
      ensureRoot();
      try { return put(false); }
      catch (e) {
        if (!(e && e.code === 'ENOENT' && rootReady)) throw e;
        rootReady = false; ensureRoot(); return put(true);   // the channels dir was removed since the last write
      }
    }
    // a written file is cached as the exact text written (parsed only if it is read again)
    function remember(file, text) {
      if (!canStat) return;
      try { cache.set(file, { key: stampOf(file), text: text }); }
      catch (e) { failNote('channels.store.cacheStamp', e); }
    }

    /* THE DELIVERY LEDGER (channel-delivery-ledger S2) lives in this store's own files, written through this store's own IO:
       readJson (the .bak last-known-good, a busy file is an error) and writeJsonAtomic (fsync'd through writeDurable, so
       the update freeze applies to every ledger write too). One per store, so every hub over this store (and every
       makeBotScopedStore view of it) shares it. timers and holding() (the update barrier) are the host's. */
    const deliveryFile = () => pathMod.join(root, 'delivery.json');
    const timers = (d.timers && typeof d.timers.setTimeout === 'function') ? d.timers : null;
    const ledger = Ledger ? Ledger.makeDeliveryLedger({
      io: { read: () => readJson(deliveryFile()), write: (doc) => writeJsonAtomic(deliveryFile(), doc),
        readConfirmed: () => {
          const file = deliveryFile(), result = persist.readOne(fs, file);
          if (result.kind === 'unreadable') throw unreadable(file, result.err);
          if (result.kind !== 'ok') throw Object.assign(new Error('The delivery publication primary could not be confirmed'), { code: 'ECHANNEL_PUBLICATION_UNPROVEN' });
          return result.value;
        } },
      clock: clock, timers: timers, bootId: bootId, limits: d.ledgerLimits, holding: d.holding, onHealth: d.onLedgerHealth,
      beforeDrive: () => { if (!migration.done) migrateV1(); }   // an unfinished migration retries before any lane sends
    }) : null;
    let ephemeralSeq = 0;
    // a ledger that keeps nothing on disk, for a one-job hub whose job record is its durability (channels/fire-store.js)
    function makeEphemeralLedger() {
      if (!Ledger) return null;
      return Ledger.makeDeliveryLedger({ io: Ledger.memoryIo(), clock: clock, timers: timers, bootId: bootId + ':job-' + (++ephemeralSeq), limits: d.ledgerLimits });
    }

    /* ---- THE v1 MIGRATION: inbox.json and outbox.json into the ledger, exactly once, and NEVER a throw ----------------
       It runs before any hub attaches. A failure is reported (failNote, and the ledger's health line) and the unfinished
       migration retries on a timer, so a busy file can never abort the host at module load.
         1. read the v1 inbox and outbox, and delivery.json: if any read throws (EBUSY, EPERM), touch nothing
         2. each inbox item -> one receipt (same id, message, attempt); an item holding a FINISHED answer the full outbox
            refused -> one delivery that settles every receipt it answered (the answer is sent, nothing re-runs)
         3. each outbox item -> one queued delivery (same id, its '⌛ delayed reply' text and tries), cut at its first
            send, ahead of anything newer in its chat
         4. chatmap.json is not touched (its unreachable flags stay for an older build; nothing here reads them)
         5. ONE durable write of delivery.json, read back; only then are the v1 files emptied, the .bak first, then the
            main, as plain durable writes (a hard-link .bak would keep the old items for an older build to recover)
         6. idempotent: an item already taken is skipped, so a crash between those writes only finishes the emptying
       DOWNGRADE: an older build reads valid empty v1 envelopes (mains and .bak), so it neither replays nor resends; it
       never opens delivery.json, whose replies wait for the next upgrade. */
    const EMPTY_V1 = { version: 1, items: [] };
    const goodInbox = (it) => !!(it && typeof it.id === 'string' && typeof it.channel === 'string' && it.message && typeof it.message === 'object' && typeof it.message.chatId === 'string');
    const goodOutbox = (it) => !!(it && typeof it.id === 'string' && typeof it.chatId === 'string' && typeof it.text === 'string');
    function readV1(file, good) {   // the v1 reader: well-formed items only; a busy file THROWS (readRaw)
      const raw = readJson(file);
      return (raw && Array.isArray(raw.items) ? raw.items : []).filter(good);
    }
    const migration = { done: false, timer: null, delay: 0, error: null, runs: 0 };
    function scheduleMigration() {
      if (migration.timer || migration.done) return;
      migration.delay = migration.delay ? Math.min(migration.delay * 2, 30000) : 1000;
      const set = timers ? timers.setTimeout : setTimeout;
      migration.timer = set(() => { migration.timer = null; migrateV1(); }, migration.delay);
      if (migration.timer && typeof migration.timer.unref === 'function') migration.timer.unref();
    }
    function migrateV1() {
      if (!ledger || migration.done) return true;
      migration.runs++;
      try {
        const inbox = readV1(inboxFile(), goodInbox);
        const outbox = readV1(outboxFile(), goodOutbox);
        if (!ledger.load()) throw Object.assign(new Error('delivery.json cannot be read'), { code: ledger.health().code || 'EUNREAD' });
        if (inbox.length || outbox.length) {
          const r = ledger.importV1({ inbox: inbox, outbox: outbox });
          if (!r.persisted && !ledger.flush()) throw (r.error || new Error('delivery.json could not be written'));
          cache.delete(deliveryFile());   // read it BACK from disk, not from what this store remembers writing
          const back = readRaw(deliveryFile());
          if (back === undefined) throw new Error('delivery.json read back empty');
          for (const it of inbox) if (!ledger.tookV1(back, 'inbox', it)) throw new Error('delivery.json read back without inbox item ' + it.id);
          for (const it of outbox) if (!ledger.tookV1(back, 'outbox', it)) throw new Error('delivery.json read back without outbox item ' + it.id);
          writeRaw(inboxFile() + '.bak', EMPTY_V1);
          writeRaw(inboxFile(), EMPTY_V1);
          writeRaw(outboxFile() + '.bak', EMPTY_V1);
          writeRaw(outboxFile(), EMPTY_V1);
        }
        migration.done = true; migration.error = null;
        if (migration.timer) { (timers ? timers.clearTimeout : clearTimeout)(migration.timer); migration.timer = null; }
        ledger.setIssue('migration', '');
        return true;
      } catch (e) {
        migration.error = e;
        failNote('channels.store.migrate', e);
        try { ledger.setIssue('migration', 'replies queued before this version are waiting: the delivery ledger migration failed (' + String((e && e.code) || 'error') + '); retrying'); }
        catch (e2) { failNote('channels.store.migrate.issue', e2); }
        scheduleMigration();
        return false;
      }
    }
    migrateV1();   // before any hub attaches; it never throws (a busy file retries on its own timer)

    return {
      loadHistory(agentId, options) {
        // Canonical import reads legacy evidence without quarantine/recovery writes. A malformed
        // envelope or row is not an empty history that may be marked imported successfully.
        if (options && options.readOnly === true) {
          let file = historyFile(agentId), result = persist.readOne(fs, file);
          if (result.kind === 'absent') { file += '.bak'; result = persist.readOne(fs, file); }
          if (result.kind === 'absent') return [];
          if (result.kind === 'unreadable') throw unreadable(file, result.err);
          const raw = result.kind === 'ok' && result.value;
          if (!raw || raw.version !== 1 || !Array.isArray(raw.messages) || raw.messages.some(row => !row ||
              !ROLES.has(row.role) || typeof row.content !== 'string' || !Number.isSafeInteger(row.ts) || row.ts < 0)) {
            const error = new Error('Legacy chat history is malformed; canonical import is held');
            error.code = 'ELEGACY_HISTORY_INVALID'; throw error;
          }
          return raw.messages.map(row => Object.assign({}, row));
        }
        const raw = readJson(historyFile(agentId));
        const msgs = raw && Array.isArray(raw.messages) ? raw.messages : [];
        // defend against a hand-corrupted file: keep only well-formed {role,content} turns
        const wellFormed = msgs.filter(m => m && ROLES.has(m.role) && typeof m.content === 'string');
        // a per-agent history never replays a legacy work-line hop exchange (see LEGACY HOP TURNS above)
        return HOP_KEY_RE.test(String(agentId)) ? wellFormed : withoutLegacyHops(wellFormed).kept;
      },

      /* clearHistory — drop this agent's messaging transcript and start fresh. A browser chat can hit /new
         because its history lives in localStorage; a messaging chat has no browser, so THIS file is the only
         copy and the only way to start over. Writes an empty envelope through the same atomic path (keeping
         the .bak the writer makes) rather than unlinking, so a reader mid-flight never sees a missing file.
         Returns the number of turns discarded, so the caller can report what actually happened. */
      clearHistory(agentId) {
        const file = historyFile(agentId);
        const raw = readJson(file);
        const had = (raw && Array.isArray(raw.messages)) ? raw.messages.length : 0;
        if (!had) return 0;                                    // nothing stored -> no write, no .bak churn
        writeJsonAtomic(file, { version: 1, messages: [] });
        return had;
      },

      appendTurn(agentId, role, text) {
        if (!ROLES.has(role)) throw new Error('bad role: ' + role);
        const file = historyFile(agentId);
        const raw = readJson(file);
        let prev = raw && Array.isArray(raw.messages) ? raw.messages.filter(m => m && ROLES.has(m.role) && typeof m.content === 'string') : [];
        if (!HOP_KEY_RE.test(String(agentId))) {
          const clean = withoutLegacyHops(prev);
          if (clean.dropped) {
            // ONE-TIME, NON-DESTRUCTIVE: keep the untouched envelope before this rewrite drops the legacy hop turns.
            // If the archive cannot be written, keep the turns on disk (loadHistory still never replays them).
            const archive = pathMod.join(root, agentId + '.history.legacy-hops.json');
            let archived = readRaw(archive) !== undefined;
            if (!archived) {
              try { writeRaw(archive, raw); archived = true; }
              catch (e) { failNote('channels.store.legacyHopArchive', e); }
            }
            if (archived) prev = clean.kept;
          }
        }
        prev.push({ role: role, content: String(text == null ? '' : text), ts: clock.now() });
        const next = trimTail(prev, limits.maxTurns, limits.maxChars);
        writeJsonAtomic(file, { version: 1, messages: next });
        return next;
      },

      loadChatMap() {
        const raw = readJson(chatMapFile());
        return { version: 1, chats: (raw && raw.chats && typeof raw.chats === 'object') ? raw.chats : {} };
      },

      getChatRecord(chatId, options) {
        if (options && options.readOnly === true) {
          // Import ownership cannot be acknowledged from the stat cache or an older recovered map.
          // Read the actual primary without repairing it; a backup behind a missing primary is
          // ambiguous evidence, not a new chat whose partial canonical import may be marked done.
          const file = chatMapFile(), result = persist.readOne(fs, file);
          if (result.kind === 'unreadable') throw unreadable(file, result.err);
          if (result.kind === 'absent') {
            const backup = persist.readOne(fs, file + '.bak');
            if (backup.kind === 'absent') return undefined;
            if (backup.kind === 'unreadable') throw unreadable(file + '.bak', backup.err);
            throw Object.assign(new Error('Chat history marker primary is missing; recovery is held'), { code: 'ECHANNEL_MARKER_UNPROVEN' });
          }
          const raw = result.kind === 'ok' && result.value;
          const record = raw && raw.chats && Object.prototype.hasOwnProperty.call(raw.chats, String(chatId)) ? raw.chats[String(chatId)] : undefined;
          if (!raw || raw.version !== 1 || !raw.chats || typeof raw.chats !== 'object' || Array.isArray(raw.chats) ||
              (record !== undefined && (!record || typeof record !== 'object' || Array.isArray(record)))) {
            throw Object.assign(new Error('Chat history marker is malformed; import is held'), { code: 'ECHANNEL_MARKER_UNPROVEN' });
          }
          return record === undefined ? undefined : clone(record);
        }
        const map = this.loadChatMap();
        return map.chats[String(chatId)];
      },

      saveChatRecord(chatId, patch) {
        const id = String(chatId);
        const map = this.loadChatMap();
        const merged = Object.assign({}, map.chats[id], patch || {}, { lastSeen: clock.now() });
        map.chats[id] = merged;
        writeJsonAtomic(chatMapFile(), { version: 1, chats: map.chats });
        return merged;
      },

      bootId: bootId,

      // the delivery ledger over this store's files, a memory-only one for a one-job hub, and the v1 migration
      ledger: ledger,
      makeEphemeralLedger: makeEphemeralLedger,
      migrateV1: migrateV1,

      _internals: { trimTail, historyFile, chatMapFile, outboxFile, inboxFile, deliveryFile, AID_RE, limits, migration, EMPTY_V1 }
    };
  }

  return { makeChannelStore, trimTail, _internals: { AID_RE, DEFAULTS } };
});
