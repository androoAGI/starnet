/* STARNET — backup.js : export/import the whole local agent as one portable JSON file.

   Browser localStorage is the FRAGILE store. A cache wipe, a different browser, or a different
   machine loses the agent the user built up — identity, XP/level/confidence, personalization
   (dossier docs + persona), workstreams (chat history) and the station layout all live in
   localStorage under the `starnet.*` keys. This module is the safety net: one click bundles the
   nonsecret starnet.* records plus a read-only snapshot of the agent's backend memory (notebook) into a
   downloadable file, and import restores the local half on any browser. Back-compat: a backup
   exported BEFORE the Skynet→StarNet rename holds `skynet.*` keys + a `skynet.backup` schema; both
   import fine and are mapped forward to `starnet.*` on restore.

   Restore applies the browser-side state and asks the sidecar to merge the notebook. A refused
   notebook write reports a partial restore. Exports use U.saveFile: a confirmed desktop receipt
   names its proven path; a browser download reports only the request. */
'use strict';

const Backup = (() => {
  const SCHEMA = 'starnet.backup';
  const LEGACY_SCHEMA = 'skynet.backup';   // backups exported before the Skynet→StarNet rename
  const VERSION = 1;

  // every key we own lives under this prefix (starnet.save, starnet.specialties.v1, starnet.refit.seen,
  // theme/CRT prefs, ...). Capturing by prefix is future-proof: new keys ride along automatically
  // instead of needing this list kept in sync. LEGACY_PREFIX is the pre-rename name — still accepted on
  // IMPORT (an old backup file) and mapped forward, never written by a fresh export.
  const PREFIX = 'starnet.';
  const LEGACY_PREFIX = 'skynet.';
  const SAVE_KEY = 'starnet.save';
  /* THIS WINDOW'S SAVE (save-latch-kill: per-window crash journals, save.js key()). A backup carries the station under
     SAVE_KEY as always, read from THIS window's journal; another window's journal ('starnet.save.w.<window>', or the legacy
     key while another window writes it) is never bundled as this one's station, and an import lands in this window's own
     journal, never over another live window's. */
  const JOURNAL_RE = /^starnet\.save(?:\.w\.[A-Za-z0-9_-]{1,80})?$/;
  // a journal's merge description (cloudsave.js writeSide): this window's own unsent-save bookkeeping, never a backup's
  const JOURNAL_SIDE_RE = /^starnet\.save(?:\.w\.[A-Za-z0-9_-]{1,80})?\.merge$/;
  function saveKeyNow() { try { if (typeof Save !== 'undefined' && Save && typeof Save.key === 'function') return Save.key(); } catch (_) {} return SAVE_KEY; }
  const SECRET_POLICY = 'credentials-excluded';
  // BYOK is default-deny: only these known, nonsecret selections are portable. This keeps a future credential
  // field from silently entering a plaintext backup just because its storage key was added after this code.
  const SAFE_BYOK_KEYS = new Set([
    'starnet.byok.model',
    'starnet.byok.prov',
    'starnet.byok.reasoningEffort'
  ]);
  const SECRET_NAMESPACE_RE = /^starnet\.(?:channels?|oauth|auth|credentials?|secrets?)(?:[._:-]|$)/i;
  const SECRET_SEGMENT_RE = /(?:^|[._:-])(?:api[-_]?key|apikey|key|keys|token|tokens|secret|secrets|credential|credentials|password|passwd|pwd|authorization|bearer)(?:$|[._:-])/i;
  // map any captured key forward to its StarNet name (old backups hold skynet.* keys; new ones already starnet.*).
  function toCurrentKey(k) { return (k.indexOf(LEGACY_PREFIX) === 0) ? (PREFIX + k.slice(LEGACY_PREFIX.length)) : k; }

  function isCredentialKey(rawKey) {
    const key = toCurrentKey(String(rawKey || ''));
    if (key.indexOf('starnet.byok.') === 0) return !SAFE_BYOK_KEYS.has(key);
    return SECRET_NAMESPACE_RE.test(key) || SECRET_SEGMENT_RE.test(key);
  }

  // #121: once the browser cache cannot hold the save (its per-site storage cap), the newest station lives only in this
  // window's memory and the station file; the cached copy is older, or removed once the station file confirms. The
  // export then carries that in-memory save, so the file holds the station the user sees and RESTORE BACKUP accepts it.
  // Null when the cache holds the newest save (the export reads the cache exactly as before).
  function memorySaveRaw() {
    try {
      if (typeof CloudSave === 'undefined' || !CloudSave.memorySave) return null;
      const doc = CloudSave.memorySave();
      if (!doc || typeof doc !== 'object' || !doc.agent) return null;
      delete doc._saveClient;   // this window's write id, not part of the station
      return JSON.stringify(doc);
    } catch (_) { return null; }
  }

  function collectStore(saveRaw) {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0 && !JOURNAL_RE.test(k) && !JOURNAL_SIDE_RE.test(k) && !isCredentialKey(k)) out[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    const mem = saveRaw === undefined ? memorySaveRaw() : saveRaw;
    let own = typeof mem === 'string' ? mem : null;
    if (own == null) { try { own = localStorage.getItem(saveKeyNow()); } catch (_) { own = null; } }
    if (typeof own === 'string') out[SAVE_KEY] = own;
    return out;
  }

  function agentName(saveRaw) {
    try {
      const mem = saveRaw === undefined ? memorySaveRaw() : saveRaw;
      const doc = JSON.parse((typeof mem === 'string' ? mem : localStorage.getItem(saveKeyNow())) || 'null');
      return (doc && doc.agent && doc.agent.name) || 'agent';
    } catch (_) { return 'agent'; }
  }

  function slug(s) {
    return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  }

  function stamp(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // pull the agent's backend memory so the file is COMPLETE (portable to a fresh machine). Best-effort:
  // if the sidecar is unreachable we still export the local state.
  async function snapshotNotebook() {
    try {
      if (typeof Harness === 'undefined' || !Harness.notebook) return null;
      const notes = await Harness.notebook('agent');
      return Array.isArray(notes) ? notes : null;
    } catch (_) { return null; }
  }

  /* A PACKED SAVE IS NOT A PORTABLE ONE (save v7, history by reference). A saved conversation may NAME a run of rows the station's
     transcript holds instead of repeating them (historyref.js), which only means something beside that transcript. This file leaves
     the station — for another browser, another machine — so the save in it carries its rows BY VALUE: every conversation that names
     rows is read back from the station (POST /api/transcript/rows, the reader the page hydrates with) and written out whole, the
     page-only fields back on its rows; a turn the Commander undid or forgot is not brought back. A conversation the station cannot
     return in full (it does not answer, it cannot find a row and cannot prove it undone) stops the export — a file that kept the
     reference would lose those turns on the machine that opens it — and exportAll says so. A save that names nothing is the very text
     it was (nothing is parsed, nothing is asked). The one-step undo of a CLEARED conversation (sessionUndo) goes the same way; one the
     station cannot return is left out, since a cleared conversation is not one anybody exports on purpose. */
  const ROWS_ASK_MS = 20000;
  const historyRefModule = () => typeof HistoryRef !== 'undefined' ? HistoryRef : (typeof require === 'function' ? require('./historyref.js') : null);
  async function readRows(agentId, streamId, rowIds) {
    if (typeof Harness === 'undefined' || !Harness.api || typeof Harness.api.post !== 'function') throw new Error('the station is not connected');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ROWS_ASK_MS) : null;
    try {
      const r = await Harness.api.post('/api/transcript/rows', { agent: agentId || 'agent', streams: [{ streamId, rowIds }] }, controller ? { signal: controller.signal } : undefined);
      const one = r && r.ok && r.j && Array.isArray(r.j.streams) ? r.j.streams[0] : null;
      if (!one || one.streamId !== streamId || !Array.isArray(one.turns)) throw new Error('the station did not return the rows');
      return one;
    } finally { if (timer) clearTimeout(timer); }
  }
  // -> { raw, inflated, short }: the save text with every packed history read back (raw itself when none is packed), and the ids of the
  // conversations the station could not return in full (then raw is left as it was)
  async function portableSave(raw) {
    const out = { raw, inflated: 0, short: [] };
    let changed = false;
    if (typeof raw !== 'string' || raw.indexOf('"$ref"') < 0) return out;
    let doc;
    try { doc = JSON.parse(raw); } catch (_) { return out; }   // not a save this can judge: carried as it is, as before
    if (!doc || typeof doc !== 'object') return out;
    const HR = historyRefModule();
    const packed = h => Array.isArray(h) && h.some(el => el && typeof el === 'object' && typeof el.$ref === 'string');
    const inflate = async (id, agentId, history) => {
      if (!HR || typeof id !== 'string' || !id) return null;
      let r;
      try { r = await HR.expand(history, { streamId: id, fetchRows: (streamId, rowIds) => readRows(agentId, streamId, rowIds) }); } catch (_) { return null; }
      return r && r.complete && !r.error && !r.malformed ? r.rows : null;
    };
    for (const w of Array.isArray(doc.workstreams) ? doc.workstreams : []) {
      if (!w || !packed(w.history)) continue;
      const rows = await inflate(w.id, w.agentId, w.history);
      if (rows) { w.history = rows; out.inflated++; changed = true; } else out.short.push(String(w.id));
    }
    const undo = doc.sessionUndo;
    if (undo && Array.isArray(undo.rows) && undo.rows.some(row => row && packed(row.history))) {
      let whole = true;
      for (const row of undo.rows) {
        if (!row || !packed(row.history)) continue;
        const rows = await inflate(row.id, 'agent', row.history);
        if (rows) { row.history = rows; out.inflated++; } else { whole = false; break; }
      }
      if (!whole) doc.sessionUndo = null;
      changed = true;
    }
    if (!out.short.length && changed) out.raw = JSON.stringify(doc);
    return out;
  }
  const packedExportError = short => Object.assign(new Error('Export stopped: ' + short.length + ' saved conversation' + (short.length === 1 ? '' : 's')
    + ' could not be read back from the station in full, and a file that names rows only the station holds would lose them anywhere else. Nothing was written. Try again when the station answers.'),
    { code: 'EXPORT_PACKED_UNREADABLE', sessions: short.slice() });

  async function build() {
    const saveRaw = memorySaveRaw();   // read once: the file name and the store describe the same save
    const store = collectStore(saveRaw);
    if (typeof store[SAVE_KEY] === 'string') {
      const made = await portableSave(store[SAVE_KEY]);
      if (made.short.length) throw packedExportError(made.short);
      store[SAVE_KEY] = made.raw;
    }
    return {
      schema: SCHEMA, version: VERSION, app: 'starnet',
      exportedAt: Date.now(),
      agentName: agentName(saveRaw),
      secretsIncluded: false,
      secretPolicy: SECRET_POLICY,
      store,
      notebook: await snapshotNotebook()
    };
  }

  function utilities() { return typeof U !== 'undefined' ? U : require('../js/util.js'); }

  async function exportAll() {
    let bundle;
    try { bundle = await build(); }
    catch (e) { if (e && e.code === 'EXPORT_PACKED_UNREADABLE') return { ok: false, line: e.message, sessions: e.sessions, records: 0, keys: 0 }; throw e; }
    const file = 'starnet-' + slug(bundle.agentName) + '-' + stamp(new Date()) + '.json';
    const receipt = await utilities().saveFile({ name: file, ext: 'json', text: JSON.stringify(bundle, null, 2) });
    const records = Object.keys(bundle.store).length;
    return Object.assign({}, receipt, { records, keys: records, secretsIncluded: false, notes: bundle.notebook ? bundle.notebook.length : 0 });
  }

  /* #134 EXPORT STATION (Settings › STATION BACKUP) — the line says where the file went only as far as the app KNOWS.
     A page that hands a blob to `<a download>` is never told where it landed (the macOS app's WebView drops it into
     Downloads silently; a browser may rename or ask), so "✓ exported" was a delivery nobody could see.
       desktop: POST /api/config/export/save — the sidecar (same machine) writes the file, reads it back, and
                returns its real path; the line names that path and nothing is handed to the WebView.
       browser: POST /api/config/export, hand the envelope to the browser as starnet-station-<day>.json, and say
                exactly that: the file name, and that it went to the browser's downloads.
     A desktop save the sidecar could not make (folder permission denied, an older sidecar) falls back to the browser
     hand-off and says why. U.saveFile owns the path validation, fallback and receipt line;
     the host still builds/redacts the station envelope. `post` is Harness.api.post ({ ok, status, j }). */
  const SECRETS_NOTE = 'secrets excluded, re-enter keys after importing';
  function stationFileName(now) {
    return 'starnet-station-' + new Date(now == null ? Date.now() : Number(now)).toISOString().slice(0, 10) + '.json';
  }
  async function exportStation(opts) {
    const o = opts || {};
    const post = o.post;
    const body = { sections: o.sections || {} };
    const receipt = await utilities().saveFile({ name: stationFileName(o.now), ext: 'json', desktop: o.desktop, download: o.download,
      save: () => post('/api/config/export/save', body),
      text: async () => {
        let r;
        try { r = await post('/api/config/export', body); }
        catch (_) { throw new Error('the station did not answer'); }
        if (!r || !r.ok || !r.j || typeof r.j !== 'object' || r.j.starnetExport !== 1) {
          throw new Error(r && r.j && r.j.error ? String(r.j.error) : 'the station did not confirm an export envelope');
        }
        return JSON.stringify(r.j, null, 2);
      }
    });
    return receipt.ok ? Object.assign({}, receipt, { line: receipt.line + ' — ' + SECRETS_NOTE }) : receipt;
  }

  /* RECOVERY BUNDLE (#119, Settings › APP & BACKUP): the whole station, not the configuration EXPORT STATION writes. The
     sidecar owns the barrier, the capture, the write and the read-back; this only proves the newest save first, hands over
     this window's own state, and says what the station's receipt says. complete and "an exact copy" are two different
     answers, so they are two different lines. A save this window could not confirm does not stop the bundle (it may be
     the moment a person most needs one): the line says so, and this window's copy rides in the bundle anyway. */
  const RECOVERY_TIMEOUT_MS = 15 * 60 * 1000;
  function bytesWords(n) {
    const b = Number(n) || 0;
    return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  }
  const CATEGORY_WORDS = { rooms_props: 'rooms and props', connector_references: 'connector references' };
  function describeRecovery(r) {
    const lines = [];
    const i = r.integrity || {}, c = i.counts || {};
    const gate = r.gate || {};
    const wanting = (r.requirements || []).filter(x => x && x.status !== 'present');
    if (gate.noAgents) lines.push('THIS BUNDLE HOLDS NO READABLE AGENT. It would replace a station with nothing, so a restore refuses it unless you pass --allow-no-agents.');
    if (!wanting.length) lines.push('All required categories are present.');
    else {
      lines.push('Some categories have nothing in this bundle:');
      // "never used" is only the likely reason when nothing was lost on the way in: a locked save is not a category you never used
      const why = i.verbatim ? 'Expected if you never used it.' : 'Expected if you never used it, unless a file listed below belongs to it.';
      for (const w of wanting) {
        const name = CATEGORY_WORDS[w.category] || w.category;
        lines.push(w.status === 'omitted' ? '  ' + name + ': left out, see below.' : '  ' + name + ': nothing captured. ' + why);
      }
    }
    if (i.verbatim) lines.push('Nothing was skipped, nothing was repaired from a .bak, no torn file was kept.');
    else {
      lines.push('Not an exact copy of what is on disk:');
      const row = (n, words) => { if (n) lines.push('  ' + n + ' ' + words); };
      row(c.omitted, 'left out because it could not be read');
      row(c.unportable, 'left out because the name cannot be stored safely');
      row(c.unreadable, 'could not be read');
      row(c.tooLarge, 'too large for one bundle');
      row(c.symlinks, 'symbolic link(s) with data outside the station not followed');
      row(c.credentialFiles, 'credential file(s) left out by name, which cannot come back from this bundle');
      row(c.linksNotFollowed, 'link(s) inside the station not followed: run its install step again after a restore');
      row(c.promotedFromBak, 'replaced from the last good .bak');
      row(c.unusableBak, 'with an unusable .bak');
      row(c.tornKept, 'torn store(s) kept as they were');
      const gaps = Array.isArray(r.gaps) ? r.gaps : [];
      for (const g of gaps.slice(0, 12)) {
        lines.push('  ' + String(g.path) + ': ' + String(g.reason));
        if (g.howToGet) lines.push('    ' + String(g.howToGet));
      }
      const more = (Number(r.gapsTotal) || gaps.length) - Math.min(gaps.length, 12);
      if (more > 0) lines.push('  and ' + more + ' more, all listed by the inspect command below.');
      if (gate.gaps) lines.push('  A restore refuses this bundle unless you pass --allow-incomplete.');
    }
    if (Array.isArray(gate.tornSaves) && gate.tornSaves.length) lines.push('Agent save(s) that do not parse: ' + gate.tornSaves.join(', '));
    if (c.excludedByDesign) lines.push(c.excludedByDesign + ' item(s) left out on purpose: known credential fields, approvals, locks, runtime state and older .bak generations.');
    lines.push('This file is NOT encrypted. Conversations, agents\' files, plugin data, app data and hook commands are in it as readable text, including anything pasted into them. Keep it as private as your computer, and do not send it to anyone.');
    const reauth = Array.isArray(r.reauthentication) ? r.reauthentication : [];
    if (reauth.length) {
      lines.push('After a restore, reconnect or approve again ' + reauth.length + ':');
      for (const x of reauth.slice(0, 12)) lines.push('  ' + String(x.kind) + ' ' + String(x.id));
      if (reauth.length > 12) lines.push('  and ' + (reauth.length - 12) + ' more.');
    }
    return lines;
  }
  // a capture blocks the station for as long as it reads: the connection chip must not offer a restart for that silence
  let capturing = false;
  function isCapturing() { return capturing; }
  async function createRecoveryBundle(opts) {
    const o = opts || {};
    capturing = true;
    try { return await writeRecoveryBundle(o); }
    finally { capturing = false; }
  }
  async function writeRecoveryBundle(o) {
    let confirmed = false;
    try { const d = typeof o.drain === 'function' ? await o.drain() : null; confirmed = !!(d && d.ok); } catch (_) { confirmed = false; }
    let r;
    try { r = await o.post('/api/recovery/backup', { browserStore: collectStore() }, { timeoutMs: RECOVERY_TIMEOUT_MS }); }
    catch (e) { return { ok: false, line: 'No bundle confirmed: ' + ((e && e.message) || 'the station did not answer') }; }
    const j = r && r.j;
    if (!r || !r.ok || !j || j.ok !== true || !j.file) {
      const why = String((j && j.error) || ('http ' + (r ? r.status : '?')));
      return { ok: false, line: j && j.leftFile
        ? 'The bundle could not be verified, and this unverified file could not be removed: ' + String(j.leftFile) + '. Delete it: it holds your station as readable text. Reason: ' + why
        : 'No bundle was written: ' + why };
    }
    const lines = [];
    if (!confirmed) lines.push('This window\'s newest changes were not confirmed in the station file. Its own copy is in the bundle.');
    return {
      ok: true, file: String(j.file), complete: j.complete === true, recovery: j.recovery || null,
      line: '✓ saved to ' + j.file + ' (' + bytesWords(j.bytes) + ', read back and verified). It is on this computer\'s disk: copy it somewhere else.',
      detail: lines.concat(describeRecovery(j)).join('\n')
    };
  }
  // what COPY copies: the check alone. Copying the whole list would paste a restore that runs as soon as the line lands.
  function recoveryCheckCommand(info) { const c = info && info.commands; return c && c.rehearse ? String(c.rehearse) : ''; }
  // the station's own finished commands (GET /api/recovery/info, or this bundle's receipt): printed exactly, never edited here
  function recoverySteps(info) {
    const c = info && info.commands;
    if (!c || !c.restore) return '';
    const where = 'Run these in ' + String(info.shell || 'a terminal') + (info.bundleKnown ? '.' : ', with the path to your bundle in place of <path to the bundle>.');
    return [where, '', 'Check a bundle without touching any station:', String(c.rehearse), '',
      'Restore it: quit StarNet completely (tray too), then run this. Restore only a bundle you made yourself: StarNet cannot prove who made a file. The folder it replaces is kept beside it as a .rollback- folder.', String(c.restore)].join('\n');
  }

  // validate a parsed bundle WITHOUT mutating anything — callers decide whether to apply.
  function validate(doc) {
    if (!doc || typeof doc !== 'object') return 'not a JSON object';
    if (doc.schema !== SCHEMA && doc.schema !== LEGACY_SCHEMA) return 'not a StarNet backup file';
    // FORWARD-VERSION GUARD (P0.3): a backup file whose envelope version is NEWER than this build understands
    // was exported by a later StarNet. Its store may carry key shapes/save schemas this code can't restore
    // faithfully, so refuse rather than importing a half-understood bundle. The import UI surfaces this string.
    if (Number(doc.version || 0) > VERSION) return 'backup was made by a newer StarNet (v' + Number(doc.version) + ') — update the app to import it';
    if (!doc.store || typeof doc.store !== 'object') return 'backup has no data';
    if (typeof doc.store[SAVE_KEY] !== 'string' && typeof doc.store['skynet.save'] !== 'string') return 'backup has no agent';
    return null;   // ok
  }

  // restore the local (browser) half: write every captured skynet.* key back verbatim. Returns a
  // summary; never throws. The notebook is preserved in the file but not pushed to the sidecar in v1.
  function applyBundle(doc) {
    const err = validate(doc);
    if (err) return { ok: false, error: err };
    let n = 0;
    try {
      const store = doc.store;
      for (const k in store) {
        if (!Object.prototype.hasOwnProperty.call(store, k) || typeof store[k] !== 'string') continue;
        if (k.indexOf(PREFIX) !== 0 && k.indexOf(LEGACY_PREFIX) !== 0) continue;   // ours (or a legacy ours) only
        if (isCredentialKey(k)) continue;                                        // portable files never grant credential authority
        const to = toCurrentKey(k);
        if (to !== SAVE_KEY && JOURNAL_RE.test(to)) continue;                       // another window's journal: never written over
        if (JOURNAL_SIDE_RE.test(to)) continue;                                     // a journal's merge description: never imported
        localStorage.setItem(to === SAVE_KEY ? saveKeyNow() : to, store[k]); n++;   // map skynet.* -> starnet.*; the station into THIS window's journal
      }
    } catch (e) { return { ok: false, error: (e && e.message) || 'write failed' }; }
    return { ok: true, records: n, keys: n, agentName: doc.agentName || agentName(), memories: Array.isArray(doc.notebook) ? doc.notebook.length : 0 };
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error || new Error('read failed'));
        fr.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  // push the bundle's memory snapshot back to the sidecar so a restored/moved agent isn't amnesiac. The route
  // merges additively (existing notes win), so this is safe to call even over an agent that already has memory.
  // A refusal is a partial restore, never a fabricated zero-memory success.
  // memory-truth: the sidecar skips a note the Commander FORGOT (its text is on the declined list) and reports how many
  // in `forgotten` — kept on the side so the status line can say so instead of a silent shortfall.
  async function restoreNotebook(notes) {
    if (typeof Harness === 'undefined' || !Harness.api) throw new Error('the station is not connected');
    const r = await Harness.api.post('/api/notebook/restore', { agent: 'agent', notes });
    if (!r.ok || !r.j || r.j.ok !== true || !Number.isInteger(r.j.added) || r.j.added < 0) {
      throw new Error(Harness.api.why(r) || 'the station did not confirm restored memories');
    }
    return { added: r.j.added, forgotten: Number(r.j.forgotten) || 0 };
  }

  async function importFile(file) {
    let doc;
    try { doc = JSON.parse(await readFileText(file)); }
    catch (_) { return { ok: false, error: 'file is not valid JSON' }; }
    const res = applyBundle(doc);
    if (res.ok) {
      // A portable backup is an explicit restore, unlike an ordinary page load.
      // Restore its autonomy through the durable writer before claiming success.
      const posture = doc.store && (doc.store['starnet.autonomy.v1'] || doc.store['skynet.autonomy.v1']);
      if (posture && typeof AutonomyStore !== 'undefined' && AutonomyStore.importState) {
        try {
          const result = await AutonomyStore.importState(JSON.parse(posture));
          if (!result.ok) return { ok: false, error: 'Backup partly restored; autonomy was not confirmed. ' + (result.error || 'Try again when the station is connected.') };
        } catch (_) { return { ok: false, error: 'Backup partly restored; its autonomy setting could not be restored.' }; }
      }
    }
    if (res.ok) {
      // re-stamp the imported save to NOW and write it through to the durable sidecar mirror. The bundle carries
      // the export-time updatedAt; without this, a boot-reconcile on a machine whose sidecar holds a NEWER save
      // would silently revert the just-imported agent. Stamping now() makes the import win the anti-clobber guard.
      try {
        const raw = localStorage.getItem(saveKeyNow());
        if (raw) {
          const d = JSON.parse(raw); d.updatedAt = Date.now();
          localStorage.setItem(saveKeyNow(), JSON.stringify(d));
          // { restore: true }: the Commander chose this backup, so a reset generation's empty station file takes it (a stale
          // browser copy from before the reset never does: savestore explicitRestore, review 10-23 #2)
          if (typeof CloudSave !== 'undefined' && CloudSave.push) CloudSave.push(d, { restore: true });
        }
      } catch (_) {}
    }
    if (res.ok && Array.isArray(doc.notebook) && doc.notebook.length) {
      try {
        const restored = await restoreNotebook(doc.notebook);
        res.memoriesRestored = restored.added;
        if (restored.forgotten) res.memoriesForgotten = restored.forgotten;
      } catch (error) {
        return Object.assign({}, res, { ok: false, error: 'Backup partly restored; memories were not confirmed. ' + String(error && error.message || error) });
      }
    }
    return res;
  }

  return { exportAll, exportStation, stationFileName, createRecoveryBundle, isCapturing, describeRecovery, recoverySteps, recoveryCheckCommand, importFile, applyBundle, validate, collectStore, build, isCredentialKey, SCHEMA, VERSION, SECRET_POLICY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
