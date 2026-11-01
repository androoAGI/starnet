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
  const LEGACY_SCHEMA = 'skynet.save';   // Skynet→StarNet rename: saves written before the rename carry this schema tag (the
  const SCHEMA = 'starnet.save';         // legacymigrate boot pass copies the OLD `skynet.save` localStorage KEY forward; load() still accepts the old TAG inside the value).
  // v6 belongs to the 0.9 line. v0.8.5 shipped save v5 and its Workstreams normalizer does not know the
  // candidate's persisted `titleStrong` provenance bit. Reusing v5 let a manual rollback accept the newer save,
  // silently strip that bit on persist, and make a re-upgraded session eligible for another automatic rename.
  // Advancing the envelope makes the already-shipped forward-version guard refuse that destructive downgrade.
  const CURRENT = 6;

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
    }
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
      if (!localStorage.getItem(PRE_MIGRATE_BACKUP_KEY)) localStorage.setItem(PRE_MIGRATE_BACKUP_KEY, raw);
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
    const doc = envelope(state);
    lastRaw = null;
    try { lastRaw = JSON.stringify(doc); localStorage.setItem(KEY, lastRaw); lastWriteError = null; return doc; }
    catch (e) { lastWriteError = String((e && (e.name || e.code)) || 'error') + (e && e.message ? ': ' + e.message : ''); console.warn('[save] write failed:', e); return null; }
  }
  function takeWriteRaw() { const raw = lastRaw; lastRaw = null; return raw; }
  function writeError() { return lastWriteError; }
  function writeQuotaFull() { return /quota/i.test(String(lastWriteError || '')); }

  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function has() { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } }

  return { load, loadStatus, isFuture, write, takeWriteRaw, writeError, writeQuotaFull, envelope, fromDoc, clear, has, key, useKey, CURRENT, PRE_MIGRATE_BACKUP_KEY, LEGACY_KEY, JOURNAL_KEY_RE };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Save;
