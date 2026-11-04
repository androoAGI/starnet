/* STARNET — save.js : local persistence for the agent + session.
   A VERSIONED envelope so saves survive future changes. localStorage for now;
   the same shape + migration ladder moves to the SQLite sidecar later. */
'use strict';

const Save = (() => {
  /* THIS WINDOW'S CRASH JOURNAL (wave-1 save-latch-kill; qa/bugs 27bae3d6). Every tab of one browser shares localStorage,
     and the whole save used to live under the one key 'starnet.save': a tab reloaded while another tab ran booted THAT tab's
     stale snapshot as its own work, and a crashed tab's unsent save was overwritten by the next persist of any other tab.
     Now each window writes its own key: 'starnet.save' (LEGACY_KEY — the first window of a browser, and every save before
     this change) or 'starnet.save.w.<window>' for a second live tab. CloudSave.openJournal() picks it at boot (a dead
     window's journal is continued; a live window's is never touched) and calls useKey(); everything here reads and writes
     key(). Before openJournal() runs, key() is the legacy key, exactly as before. */
  const LEGACY_KEY = 'starnet.save';
  const JOURNAL_KEY_RE = /^starnet\.save(?:\.w\.[A-Za-z0-9_-]{1,80})?$/;
  let KEY = LEGACY_KEY;
  function key() { return KEY; }
  function useKey(k) { if (JOURNAL_KEY_RE.test(String(k || ''))) KEY = String(k); return KEY; }
  const PRE_MIGRATE_BACKUP_KEY = 'starnet.save.pre-migrate.backup';
  /* THE PRE-MIGRATION COPY IS A COPY OF EVERY CONVERSATION. It is the raw save from before a migration, kept so a bad migration can be
     recovered by hand, which makes it the one place a chat the Commander deleted outlives the delete — and, written once and never
     touched again, outlives everything else. So it is bounded and it follows deletes: PRE_MIGRATE_BACKUP_AT_KEY stamps when it was made
     and expireBackup() removes it BACKUP_TTL_MS later; forgetFromBackup() cuts a forgotten conversation out of it (write() does that
     for every id in the save's forgetIds, in the persist that records the delete); clear() removes it with the save. It is cut, not
     dropped at the first confirmed load of the new format, so a way back inside those days still has every conversation that was not
     deleted (test/save-premigrate-backup.test.js). */
  const PRE_MIGRATE_BACKUP_AT_KEY = PRE_MIGRATE_BACKUP_KEY + '.at';
  const BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const LEGACY_SCHEMA = 'skynet.save';   // Skynet→StarNet rename: saves written before the rename carry this schema tag (the
  const SCHEMA = 'starnet.save';         // legacymigrate boot pass copies the OLD `skynet.save` localStorage KEY forward; load() still accepts the old TAG inside the value).
  // v6 belongs to the 0.9 line. v0.8.5 shipped save v5 and its Workstreams normalizer does not know the
  // candidate's persisted `titleStrong` provenance bit. Reusing v5 let a manual rollback accept the newer save,
  // silently strip that bit on persist, and make a re-upgraded session eligible for another automatic rename.
  // Advancing the envelope makes the already-shipped forward-version guard refuse that destructive downgrade.
  // v7 belongs to history-by-reference (frontend/app/historyref.js): a session's history may now hold a packed element
  // { "$ref": …, "res": … } naming a run of rows the station's transcript holds. A v6 page would draw that element as an empty
  // message and write it back over the real history on its next persist, so the stamp is what keeps it out: it refuses a
  // v7 save (loadStatus 'future', the cache bytes untouched) instead of reading it. The bump is taken here, before anything packs.
  const CURRENT = 7;

  // forward-only migrations: { fromVersion: (doc) => upgradedDoc }
  const migrations = {
    // v1 (one agent + one flat history) -> v2 (Workstreams): fold the whole conversation into a
    // single "General" stream (cost seeded from lifetime usage so nothing looks invented); agent +
    // lifetime usage stay at the envelope root. Delegates to the unit-tested pure migrator.
    1: doc => {
      const slice = (typeof Workstreams !== 'undefined')
        ? Workstreams.migrateV1(doc)
        : { workstreams: [], activeId: null, generalId: null };
      return { agent: doc.agent, usage: doc.usage, workstreams: slice.workstreams, activeId: slice.activeId, generalId: slice.generalId };
    },
    // v2 -> v3 (agent growth): seed the XP/level/confidence stats on the agent + a station-wide rollup.
    // Honest cold-start: fresh meters (confidence shows "calibrating" until real outcomes arrive). The
    // literal keeps save.js decoupled from xp.js load order; it mirrors Xp.fresh() exactly.
    2: doc => {
      const fresh = () => ({ xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [] });
      if (doc.agent && typeof doc.agent === 'object' && (!doc.agent.stats || typeof doc.agent.stats !== 'object')) doc.agent.stats = fresh();
      if (!doc.stationStats || typeof doc.stationStats !== 'object') doc.stationStats = fresh();
      return doc;
    },
    // v3 -> v4 (personalization): seed an empty, valid user-affinity profile slice. Cold-start-safe —
    // a user who never finished the awakening still gets a learnable, all-zero profile. The literal
    // mirrors Profile.fresh() to keep save.js decoupled from profile.js load order.
    3: doc => {
      if (!doc.profile || typeof doc.profile !== 'object') doc.profile = { v: 1, tags: {}, seed: null, enabled: true, total: 0 };
      return doc;
    },
    // v4 -> v5 (Commander Dossier): seed an empty, valid station-wide dossier slice. Cold-start-safe — an
    // older save (or one whose owner never finished the awakening) gets a learnable, all-empty dossier; it
    // then seeds from the agent's onboarding docs at DossierStore.init. The literal mirrors Dossier.fresh()
    // to keep save.js decoupled from dossier.js load order.
    4: doc => {
      if (!doc.dossier || typeof doc.dossier !== 'object') doc.dossier = { v: 1, dims: { identity: [], stack: [], goals: [], style: [], standing_orders: [], pain: [], ambition: [] }, seededFrom: {}, updatedAt: 0 };
      return doc;
    },
    // v5 -> v6 (0.9 session-title provenance): make the new persisted bit explicit. A v0.8.5 session has no
    // proof that its current automatic title was derived from substantive content, so false is the only honest
    // default. Everything else stays in place; unknown fields remain untouched.
    5: doc => {
      if (Array.isArray(doc.workstreams)) {
        for (const stream of doc.workstreams) {
          if (stream && typeof stream === 'object' && !Object.prototype.hasOwnProperty.call(stream, 'titleStrong')) {
            stream.titleStrong = false;
          }
        }
      }
      return doc;
    },
    // v6 -> v7 (history by reference): nothing moves. A v6 envelope whose sessions hold their whole history inline IS a valid v7
    // envelope — an inline row is one of the two shapes a v7 history is made of, the other being a packed run — so the doc is
    // handed on as it is and packing only happens later, as rows are sealed against a station read. What changes is the stamp:
    // migrate() sets version = CURRENT, and from then on this build's saves are refused by every page that predates the element.
    6: doc => doc
  };

  function migrate(doc) {
    let v = doc.version || 0;
    while (v < CURRENT && migrations[v]) { doc = migrations[v](doc); v++; doc.version = v; }
    doc.version = CURRENT;
    return doc;
  }

  function backupBeforeMigrate(raw, doc) {
    try {
      const v = Number(doc && doc.version || 0);
      if (v >= CURRENT) return;
      if (!localStorage.getItem(PRE_MIGRATE_BACKUP_KEY)) {
        localStorage.setItem(PRE_MIGRATE_BACKUP_KEY, raw);
        localStorage.setItem(PRE_MIGRATE_BACKUP_AT_KEY, String(Date.now()));   // if the cache refuses the stamp, expireBackup stamps the copy when it first sees it
      }
    } catch (_) {}
  }

  function dropBackup() {
    try { localStorage.removeItem(PRE_MIGRATE_BACKUP_KEY); } catch (_) {}
    try { localStorage.removeItem(PRE_MIGRATE_BACKUP_AT_KEY); } catch (_) {}
  }

  // 30 days after it was made the copy goes. A copy with no stamp (one an older build made) is stamped the first time it is seen and goes
  // 30 days after that: nothing is removed the moment it is found, whatever its age. A stamp from the future (a clock that was wrong) is
  // pulled back to now, so a bad clock cannot keep the copy for ever. Cheap: one read of the stamp, and of the copy only while it has none.
  function expireBackup(now) {
    try {
      const t = Number.isFinite(now) ? now : Date.now();
      const at = Number(localStorage.getItem(PRE_MIGRATE_BACKUP_AT_KEY));
      if (at > 0) {
        if (at > t) localStorage.setItem(PRE_MIGRATE_BACKUP_AT_KEY, String(t));
        else if (t - at >= BACKUP_TTL_MS) dropBackup();
        return;
      }
      if (localStorage.getItem(PRE_MIGRATE_BACKUP_KEY) !== null) localStorage.setItem(PRE_MIGRATE_BACKUP_AT_KEY, String(t));
    } catch (_) {}
  }

  // Cut the conversations `ids` out of the pre-migration copy: their records, the ~restored copies of them, the worker threads that were
  // theirs, and their rows in the undo checkpoint. Returns how many records it removed. A copy that cannot be read, or cannot be written
  // back, cannot be shown to be free of them, so it is removed whole: a forgotten chat is never kept to keep a rollback.
  function forgetFromBackup(ids) {
    try {
      const gone = new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && x));
      if (!gone.size) return 0;
      const raw = localStorage.getItem(PRE_MIGRATE_BACKUP_KEY);
      if (raw === null) return 0;
      let doc = null;
      try { doc = JSON.parse(raw); } catch (_) { doc = null; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { dropBackup(); return 0; }
      const goneRow = r => !!r && typeof r === 'object' && typeof r.id === 'string'
        && (gone.has(r.id) || gone.has(r.id.replace(/~restored\d*$/, '')) || (typeof r.parentStreamId === 'string' && gone.has(r.parentStreamId)));
      let removed = 0;
      if (Array.isArray(doc.workstreams)) {
        const keep = doc.workstreams.filter(w => !goneRow(w));
        removed += doc.workstreams.length - keep.length;
        doc.workstreams = keep;
      }
      const undo = doc.sessionUndo;
      if (undo && typeof undo === 'object' && Array.isArray(undo.rows)) {
        const keep = undo.rows.filter(r => !goneRow(r));
        if (keep.length !== undo.rows.length) { removed++; if (keep.length) undo.rows = keep; else delete doc.sessionUndo; }
      }
      if (removed) localStorage.setItem(PRE_MIGRATE_BACKUP_KEY, JSON.stringify(doc));
      return removed;
    } catch (_) { dropBackup(); return 0; }
  }

  // write() hands every persist's forgetIds here. An id is cut out of the copy once per page lifetime (the copy only shrinks), so a save that
  // forgets nothing new costs a loop over its ids and no read of the copy.
  const scrubbed = new Set();
  function scrubBackup(forgetIds) {
    try {
      if (!Array.isArray(forgetIds) || !forgetIds.length) return;
      const fresh = forgetIds.filter(id => typeof id === 'string' && id && !scrubbed.has(id));
      if (!fresh.length) return;
      forgetFromBackup(fresh);
      for (const id of fresh) scrubbed.add(id);
    } catch (_) {}
  }

  // FORWARD-VERSION GUARD (P0.3). loadStatus() is the honest verdict channel the boot path reads BEFORE
  // it decides resume-vs-onboard. A save whose version is GREATER than this build's CURRENT was written by
  // a NEWER StarNet: this code cannot read the fields that version added, so migrating it (which would
  // re-stamp version = CURRENT and drop those fields) is silent contamination. We refuse: leave the stored
  // doc byte-for-byte UNTOUCHED and report { status:'future', version } so the boot path can raise an
  // honest "update the app" gate instead of either mangling the save or (worse) treating it as no-save and
  // clobbering it on the first persist(). status 'ok' carries the migrated doc; 'none' = genuinely no save;
  // 'error' = unreadable/corrupt (treated as no-save by callers today, same as the old load()).
  function loadStatus() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { status: 'none', doc: null, version: 0 };
      let doc = JSON.parse(raw);
      if (!doc || (doc.schema !== SCHEMA && doc.schema !== LEGACY_SCHEMA) || !doc.agent) return { status: 'none', doc: null, version: 0 };
      const v = Number(doc.version || 0);
      if (v > CURRENT) return { status: 'future', doc: null, version: v };   // NEWER build wrote this — do not touch it
      expireBackup();
      backupBeforeMigrate(raw, doc);
      return { status: 'ok', doc: migrate(doc), version: CURRENT };
    } catch (e) { console.warn('[save] load failed:', e); return { status: 'error', doc: null, version: 0 }; }
  }

  // load() keeps its historic contract: the migrated doc, or null on anything else (no save / future / error).
  // A future save returns null here so no legacy call site can adopt or re-save it; the boot path uses
  // loadStatus()/isFuture() to distinguish "no save" (start onboarding) from "future save" (raise the gate).
  function load() { return loadStatus().doc; }

  // convenience for callers that only need the yes/no forward-version verdict without the full status shape.
  function isFuture() { return loadStatus().status === 'future'; }

  // #121: the save envelope, built ONCE per persist. persist() hands the same envelope to write() (the browser cache)
  // and to the station file, so a cache that cannot hold it (the browser's per-site storage cap) never keeps the
  // station file from receiving it. A state that already carries schema/version/updatedAt keeps them.
  function envelope(state) { return Object.assign({ schema: SCHEMA, version: CURRENT, updatedAt: Date.now() }, state); }

  // #121: the loadStatus() verdict for a save that did NOT come from the cache (the station file's copy, when the
  // cache cannot hold it). Pure and in memory: never reads or writes localStorage. Same rules as loadStatus():
  // not a save -> 'none'; written by a NEWER build -> 'future' (refused, untouched); otherwise migrated on a copy.
  function fromDoc(input) {
    try {
      if (!input || typeof input !== 'object' || (input.schema !== SCHEMA && input.schema !== LEGACY_SCHEMA) || !input.agent) return { status: 'none', doc: null, version: 0 };
      const v = Number(input.version || 0);
      if (v > CURRENT) return { status: 'future', doc: null, version: v };
      return { status: 'ok', doc: migrate(JSON.parse(JSON.stringify(input))), version: CURRENT };
    } catch (e) { console.warn('[save] in-memory load failed:', e); return { status: 'error', doc: null, version: 0 }; }
  }

  // returns the persisted doc (so callers can mirror the EXACT envelope to the durable sidecar), or null on
  // failure. The doc carries a fresh updatedAt stamp, which the sidecar uses to reject stale write-throughs.
  // writeError() names why the last write failed (null after a success), so the UI only says "full" when the
  // browser said quota (QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED / "exceeded the quota").
  let lastWriteError = null;
  /* SERIALIZE ONCE (idle CPU piece 3, 2026-10-20): the exact string this write produced — kept even when the cache refused
     it — so persist() can hand it to CloudSave instead of CloudSave re-serializing the same multi-MB save to clone it.
     takeWriteRaw() hands it over once and forgets it; it is the same bytes the cache was given. */
  let lastRaw = null;
  function write(state) {
    scrubBackup(state && state.forgetIds);
    const doc = envelope(state);
    lastRaw = null;
    try { lastRaw = JSON.stringify(doc); localStorage.setItem(KEY, lastRaw); lastWriteError = null; return doc; }
    catch (e) { lastWriteError = String((e && (e.name || e.code)) || 'error') + (e && e.message ? ': ' + e.message : ''); console.warn('[save] write failed:', e); return null; }
  }
  function takeWriteRaw() { const raw = lastRaw; lastRaw = null; return raw; }
  function writeError() { return lastWriteError; }
  function writeQuotaFull() { return /quota/i.test(String(lastWriteError || '')); }

  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} dropBackup(); }
  function has() { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } }

  return { load, loadStatus, isFuture, write, takeWriteRaw, writeError, writeQuotaFull, envelope, fromDoc, clear, has, key, useKey, forgetFromBackup, expireBackup, CURRENT, PRE_MIGRATE_BACKUP_KEY, PRE_MIGRATE_BACKUP_AT_KEY, BACKUP_TTL_MS, LEGACY_KEY, JOURNAL_KEY_RE };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Save;
