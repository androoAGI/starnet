/* sidecar/channels/store.js — durable per-chat memory for the messaging ingress (C4).

   The run host (index.js /api/run) is STATELESS: the caller supplies the full `messages` array each call, and
   browser history lives only in localStorage. A messaging chat has no browser holding its transcript, so the
   adapter must own its own durable per-chat memory. This module is that store:

     makeChannelStore({ fs, pathMod, root, clock, limits? }) -> {
       loadHistory(agentId)            -> [{role,content,ts}]     // [] on missing/corrupt (fail-closed)
       appendTurn(agentId, role, text) -> messages[]             // appends + trims tail, persists atomically
       loadChatMap()                   -> { version, chats }
       getChatRecord(chatId)           -> record | undefined
       saveChatRecord(chatId, patch)   -> record                 // merge-and-persist one chat's mapping/config
       loadOutbox(channel?)            -> [{id,channel,chatId,text,runId,agentId,reason,ts,tries}]
       pushOutbox(entry)               -> item                   // queue an UNDELIVERED reply (bounded, full refuses loss)
       removeOutbox(id)                -> bool                   // delivered (or given up) — drop it
       bumpOutboxTry(id)               -> item | undefined       // count one failed redelivery attempt
       loadInbox(channel?)             -> [{id,channel,message,ts}] // admitted work not yet completed/queued
       pushInbox(entry)                -> item                   // idempotent durable intake receipt
       removeInbox(id)                 -> bool                   // completed (or durably queued)
       markInbox(id, {runId?,tools?,held?}) -> item | undefined  // how far its run got (the attempt a recovery reads)
       bootId                          -> string                 // this process's boot, stamped on every attempt
       liveInbox(id)                   -> promise | null         // the run processing this receipt in THIS process
       holdInbox(id, promise)          -> promise                // claim a receipt live until the promise settles
     }

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
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.store = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;            // same agentId grammar as the notebook/fs jail
  const DEFAULTS = { maxTurns: 40, maxChars: 24000 };  // bound the on-disk + replayed transcript
  // outbox bounds: a small, bounded queue of UNDELIVERED replies (durable send-retry, not a message archive).
  // Oldest drops first past maxOutbox; a single reply's stored text is capped so the file can't balloon.
  const OUTBOX_DEFAULTS = { maxOutbox: 50, maxOutboxChars: 16000 };
  const INBOX_DEFAULTS = { maxInbox: 200 };
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
  const LEGACY_HOP_TURN = /^PIPELINE HANDOFF — you are stage \d+ of a work line on this station\.\n\nThe original request was:\n/;
  function withoutLegacyHops(msgs) {
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m && m.role === 'user' && LEGACY_HOP_TURN.test(m.content)) {
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
    const outboxLimits = Object.assign({}, OUTBOX_DEFAULTS, d.outboxLimits || {});
    const inboxLimits = Object.assign({}, INBOX_DEFAULTS, d.inboxLimits || {});
    /* THE LIVE CLAIM BELONGS TO THE STORE, not to a hub. A reconnect (startTelegram) closes the old hub and builds a
       new one over this same store while the old hub's run is still going; each hub's own in-flight map could not
       see the other's, so the new hub's first 'up' replayed the running message — a second paid run and a second
       reply. In memory on purpose: a receipt with no live claim after a crash is exactly what recovery replays. */
    const liveClaims = new Map();   // inbox id -> the one processing promise in this process, whichever hub owns it
    let outboxSeq = 0;   // deterministic per-process id tail (clock.now() alone can collide within one ms)
    /* THIS STORE'S BOOT (e5ecd6b8 review, 2026-10-21). markInbox stamps it on every attempt, so a re-delivered receipt
       tells a run that died with an earlier process (a crash: recovery may not re-run its tool steps) from one this
       very process left pending (a reply the full outbox refused, a throw): the latter is no restart. One store per
       save dir per sidecar (index.js), so this is the process's boot. Built from the injected clock, the pid and a
       per-module counter: no rng, and two instances in one process (tests) never share one. Injectable for tests. */
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

    return {
      loadHistory(agentId) {
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

      getChatRecord(chatId) {
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

      // ---- durable outbox: replies that FAILED to send, kept for redelivery when the transport is back ----
      // Same save-safety as everything here (versioned, atomic, .bak-recovered, fail-closed on corrupt). One
      // file for ALL channels — each item carries its channel; hubs flush only their own.
      loadOutbox(channel) {
        const raw = readJson(outboxFile());
        const items = raw && Array.isArray(raw.items) ? raw.items : [];
        const good = items.filter(it => it && typeof it.id === 'string' && typeof it.chatId === 'string' && typeof it.text === 'string');
        return channel ? good.filter(it => it.channel === String(channel)) : good;
      },

      pushOutbox(entry) {
        const e = entry || {};
        let text = String(e.text == null ? '' : e.text);
        if (text.length > outboxLimits.maxOutboxChars) text = text.slice(0, outboxLimits.maxOutboxChars) + '\n… (reply truncated for redelivery)';
        const items = this.loadOutbox();
        let id;
        // The queue survives process restarts, but outboxSeq does not. A restart in the same clock tick (or
        // after a clock rollback) must not reuse a durable item's id: remove/bump operate by id and would
        // otherwise affect multiple replies. Walk the tiny bounded queue until this process owns a free id.
        do { id = String(clock.now()) + '-' + (++outboxSeq); }
        while (items.some(it => it.id === id));
        const item = {
          id: id,
          channel: String(e.channel || ''), chatId: String(e.chatId || ''), text: text,
          runId: String(e.runId || ''), agentId: String(e.agentId || ''), reason: String(e.reason || ''),
          ts: clock.now(), tries: 0
        };
        // Never evict somebody else's undelivered answer to make room. The hub leaves the corresponding durable
        // inbox receipt pending when this throws, so intake backpressures and retries after the outbox drains.
        if (items.length >= outboxLimits.maxOutbox) throw new Error('channel outbox is full; refusing to discard an undelivered reply');
        items.push(item);
        writeJsonAtomic(outboxFile(), { version: 1, items: items });
        return item;
      },

      removeOutbox(id) {
        const items = this.loadOutbox();
        const next = items.filter(it => it.id !== String(id));
        if (next.length === items.length) return false;
        writeJsonAtomic(outboxFile(), { version: 1, items: next });
        return true;
      },

      bumpOutboxTry(id) {
        const items = this.loadOutbox();
        const it = items.find(x => x.id === String(id));
        if (!it) return undefined;
        it.tries = Math.min(1000000, Math.max(0, Number(it.tries) || 0) + 1);
        writeJsonAtomic(outboxFile(), { version: 1, items: items });
        return it;
      },

      // Persist redelivery PROGRESS: after a partial flush (chunks 1..k delivered, k+1 failed) the item
      // keeps only the UNDELIVERED remainder, so the next pass never re-sends text the member already read.
      replaceOutboxText(id, text) {
        const items = this.loadOutbox();
        const it = items.find(x => x.id === String(id));
        if (!it) return undefined;
        it.text = String(text == null ? '' : text);
        writeJsonAtomic(outboxFile(), { version: 1, items: items });
        return it;
      },

      // ---- durable inbox: admitted messages survive a crash between offset confirmation and reply ----
      loadInbox(channel) {
        const raw = readJson(inboxFile());
        const items = raw && Array.isArray(raw.items) ? raw.items : [];
        const good = items.filter(it => it && typeof it.id === 'string' && typeof it.channel === 'string'
          && it.message && typeof it.message === 'object' && typeof it.message.chatId === 'string');
        return channel ? good.filter(it => it.channel === String(channel)) : good;
      },

      pushInbox(entry) {
        const e = entry || {};
        const id = String(e.id || '');
        if (!id || !e.message || typeof e.message !== 'object') throw new Error('bad channel inbox entry');
        const items = this.loadInbox();
        const existing = items.find(it => it.id === id);
        if (existing) return existing;   // Telegram redelivery/recovery is idempotent at the durable intake edge
        if (items.length >= inboxLimits.maxInbox) throw new Error('channel inbox is full; refusing to acknowledge more work');
        const item = { id: id, channel: String(e.channel || ''), message: JSON.parse(JSON.stringify(e.message)), ts: clock.now() };
        items.push(item);
        writeJsonAtomic(inboxFile(), { version: 1, items: items });
        return item;
      },

      removeInbox(id) {
        const items = this.loadInbox();
        const next = items.filter(it => it.id !== String(id));
        if (next.length === items.length) return false;
        writeJsonAtomic(inboxFile(), { version: 1, items: next });
        return true;
      },

      /* THE ATTEMPT MARKER (e5ecd6b8, 2026-10-21). A receipt only said "not finished", so a crash after the run had
         already appended a line to a file replayed the whole message from scratch: the line was appended twice and the
         chat was told it was done once. The hub stamps the receipt when its run starts (runId) and as each tool step
         begins (tools, a running count), so a recovery can tell "never started" from "already did things". Known fields
         only, clamped; the tool count never goes down. An unknown id is a no-op (the receipt already completed).
         Every mark also stamps `boot` (this process: see bootId), and `held` keeps a FINISHED run's reply that the full
         outbox refused ({text, runId, reason, agentId, ids}: ids = every receipt that one run answers), so the
         replay delivers that answer instead of running the message again. */
      markInbox(id, patch) {
        const items = this.loadInbox();
        const it = items.find(x => x.id === String(id));
        if (!it) return undefined;
        const p = patch || {};
        const prev = (it.attempt && typeof it.attempt === 'object') ? it.attempt : {};
        const next = { runId: String(prev.runId || '').slice(0, 200), tools: Math.max(0, Math.floor(Number(prev.tools) || 0)), boot: bootId };
        if (p.runId != null && String(p.runId)) next.runId = String(p.runId).slice(0, 200);
        if (p.tools != null) next.tools = Math.max(next.tools, Math.min(1000000, Math.max(0, Math.floor(Number(p.tools) || 0))));
        it.attempt = next;
        if (p.held && typeof p.held === 'object' && typeof p.held.text === 'string') {
          let text = p.held.text;
          if (text.length > outboxLimits.maxOutboxChars) text = text.slice(0, outboxLimits.maxOutboxChars) + '\n… (reply truncated for redelivery)';
          const ids = Array.isArray(p.held.ids) ? p.held.ids.filter(x => typeof x === 'string' && x).slice(0, 50).map(x => x.slice(0, 300)) : [];
          it.held = { text: text, runId: String(p.held.runId || '').slice(0, 200), reason: String(p.held.reason || '').slice(0, 40),
            agentId: String(p.held.agentId || '').slice(0, 80), ids: ids };
        }
        writeJsonAtomic(inboxFile(), { version: 1, items: items });
        return it;
      },

      bootId: bootId,

      liveInbox(id) { return liveClaims.get(String(id)) || null; },

      holdInbox(id, promise) {
        const key = String(id);
        liveClaims.set(key, promise);
        const release = () => { if (liveClaims.get(key) === promise) liveClaims.delete(key); };
        Promise.resolve(promise).then(release, release);
        return promise;
      },

      _internals: { trimTail, historyFile, chatMapFile, outboxFile, inboxFile, AID_RE, limits, outboxLimits, inboxLimits, liveClaims }
    };
  }

  return { makeChannelStore, trimTail, _internals: { AID_RE, DEFAULTS, OUTBOX_DEFAULTS, INBOX_DEFAULTS } };
});
