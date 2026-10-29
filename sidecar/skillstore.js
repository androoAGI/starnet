/* sidecar/skillstore.js - the agent's owned, reusable SKILL library.

   Runtime skills are per-agent procedure documents. list() is metadata-only,
   view() loads the body on demand, and manage() owns the lifecycle so the
   agent can create, patch, archive, restore, pin, and attach support files
   without reaching into its own storage through fs tools.

     makeSkillStore({ io, clock, redact?, maxPerAgent?, bodyMax? }) -> {
       write({ agentId, name, summary, body }) -> legacy create/edit wrapper,
       manage({ agentId, action, ... }) -> lifecycle operation,
       list(agentId, opts?) -> metadata only,
       view(agentId, idOrName, opts?) -> full body/support files,
       markUsed(agentId, idOrNames) -> usage telemetry,
       curate(agentId, opts?) -> stale/archive lifecycle pass,
       all(), count()
     } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  // skills/file-bytes.js — THE canonical-bytes boundary: a support file is decoded once and encoded once, through it.
  const FileBytes = require('./skills/file-bytes.js');

  // Open Agent Skills recommend keeping SKILL.md lean, but real production procedures commonly exceed
  // 20k characters. Truncating one while retaining its upstream digest made provenance lie: "up to date"
  // could describe a locally chopped document. Match the package byte ceiling so accepted source bytes
  // round-trip intact; progressive disclosure still keeps bodies out of the always-on prompt index.
  const NAME_MAX = 80, SUMMARY_MAX = 280, CATEGORY_MAX = 80, BODY_MAX = 256000;
  const DEFAULT_MAX_PER_AGENT = 100, SUPPORT_FILE_MAX = 256000;
  // A package is bounded by three numbers, not one. Per-file content was always clamped
  // (SUPPORT_FILE_MAX), but nothing bounded HOW MANY files or the package total — so a review
  // pass that keeps demoting session detail into references/ could grow one skill without limit.
  const DEFAULT_MAX_FILES = 64, DEFAULT_MAX_PACKAGE_BYTES = 1024 * 1024;
  // Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
  const STATES = new Set(['active', 'stale', 'archived']);
  const ALLOWED_SUPPORT_DIRS = ['references', 'templates', 'scripts', 'assets'];

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function bool(v) { return !!v; }
  function slug(name) {
    return str(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
  }
  const keyOf = (agentId, name) => str(agentId) + '\x00' + str(name).trim().toLowerCase();

  function clone(o) { return JSON.parse(JSON.stringify(o == null ? null : o)); }
  function arr(v) {
    if (Array.isArray(v)) return v.map(x => str(x).trim()).filter(Boolean);
    if (v == null || v === '') return [];
    return [str(v).trim()].filter(Boolean);
  }
  function stateOf(v) {
    const s = str(v || 'active').toLowerCase();
    return STATES.has(s) ? s : 'active';
  }
  // Two different questions. STAGE_ACTORS: the autonomous writers whose NEW writes become proposals instead of the
  // active skill. reviewWritten(entry): whose STORED versions persist() stamps 'ask' (provenance) on EVERY save,
  // telemetry included. A curator version saved before curator writes became proposals (0.13.2/0.13.3, stamped
  // 'allow', its narrow siblings archived into it) must not turn 'ask' the first time a run merely uses it:
  // withholding the umbrella would leave the agent with neither. A curator version is review-written once it was
  // promoted (its approval is digest-keyed: the approve route precommits it for the candidate's bytes).
  const STAGE_ACTORS = new Set(['background-review', 'skill-review', 'curator']);
  function reviewWritten(entry) {
    const by = str(entry && entry.writtenBy);
    return STAGE_ACTORS.has(by) && (by !== 'curator' || !!str(entry && entry.promotionReceiptId));
  }
  function trustSource(createdBy) {
    const source = str(createdBy).trim().toLowerCase();
    if (source === 'user') return 'user';
    if (source === 'community' || source === 'skill-exchange') return 'community';
    if (source === 'builtin' || source === 'trusted') return source;
    return 'agent-created';
  }
  function cleanName(v) {
    const name = str(v).trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
    if (!name) return { ok: false, error: 'a skill needs a name' };
    if (/[\x00-\x1F<>:"|?*\\/]/.test(name)) return { ok: false, error: 'skill name contains unsafe characters' };
    return { ok: true, name };
  }
  function cleanCategory(v) {
    const c = str(v || 'General').trim().replace(/\s+/g, ' ').slice(0, CATEGORY_MAX);
    return c || 'General';
  }
  /* normFiles(files, whole?) — the stored shape of a support-file set. A record LOADED from the log is cut to the
     limit's encoded length, as it always was; `whole` cuts nothing (a set being written, or read off disk for a view,
     is checked against the limits by its caller and refused there, never silently cut). */
  function normFiles(files, whole) {
    const out = {};
    if (!files) return out;
    const cut = (s, n) => whole ? s : s.slice(0, n);
    const ENCODED_MAX = Math.ceil(SUPPORT_FILE_MAX * 4 / 3) + 4;
    if (Array.isArray(files)) {
      for (const f of files) if (f && f.path) out[str(f.path)] = {
        path: str(f.path), content: cut(str(f.content), ENCODED_MAX),
        encoding: f.encoding === 'base64' ? 'base64' : 'utf8', updatedAt: num(f.updatedAt)
      };
      return out;
    }
    if (typeof files === 'object') {
      for (const p of Object.keys(files)) {
        const f = files[p];
        if (f && typeof f === 'object') out[str(f.path || p)] = {
          path: str(f.path || p), content: cut(str(f.content), ENCODED_MAX),
          encoding: f.encoding === 'base64' ? 'base64' : 'utf8', updatedAt: num(f.updatedAt)
        };
        else out[str(p)] = { path: str(p), content: cut(str(f), SUPPORT_FILE_MAX), encoding: 'utf8', updatedAt: 0 };
      }
    }
    return out;
  }
  function normPackageFiles(files) {
    if (!Array.isArray(files)) return [];
    // An EMPTY file is a file: dropping it (filter on content) changed the manifest under its digest, so a package with
    // a zero-byte template could not be written, snapshotted or rolled back ('digest does not match its files').
    return files.map(f => ({
      path: str(f && f.path), encoding: 'base64', content: str(f && f.content),
      bytes: num(f && f.bytes), sha256: str(f && f.sha256)
    })).filter(f => f.path);
  }
  /* A support-file set as WRITTEN: every entry through the canonical-bytes boundary (FileBytes.toEntry: exact UTF-8 text
     is stored as text, anything else base64), whatever encoding it arrived in. normFiles() alone is the LOAD shape: a
     record already in the log keeps the form it was stored in (its revision digest, which pending proposals and their
     evaluation receipts are keyed to, reads that form), and every reader decodes it through FileBytes.
     NOTHING IS CUT: a file over `max` bytes is refused ({ ok: false, error }) unless it is exactly the bytes `carried`
     (the set the record already holds) has at that path, which an edit or a patch carries over unchanged. It used to be
     sliced to the limit's encoded length, so an over-limit file was stored (and re-written to the mirror) cut short. */
  function writtenFiles(files, max, carried) {
    const out = normFiles(files, true);
    const held = carried && typeof carried === 'object' ? carried : {};
    for (const p of Object.keys(out)) {
      out[p] = FileBytes.canonical(out[p], { updatedAt: num(out[p].updatedAt) });
      const n = FileBytes.byteLength(out[p]);
      if (max > 0 && n > max && !(held[p] && FileBytes.sameBytes(held[p], out[p]))) {
        return { ok: false, error: 'the support file ' + p + ' is ' + n + ' bytes, over the ' + max + '-byte limit - split it into smaller files' };
      }
    }
    return { ok: true, files: out };
  }
  function supportPath(raw) {
    let p = str(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '');
    p = p.replace(/\/+/g, '/');
    if (!p) return { ok: false, error: 'support file path required' };
    if (/^[A-Za-z]:/.test(p) || p.indexOf('..') >= 0 || /[\x00-\x1F]/.test(p)) return { ok: false, error: 'unsafe support file path' };
    const root = p.split('/')[0];
    if (ALLOWED_SUPPORT_DIRS.indexOf(root) < 0 || p === root) {
      return { ok: false, error: 'support files must live under ' + ALLOWED_SUPPORT_DIRS.join(', ') };
    }
    if (p.length > 180) return { ok: false, error: 'support file path is too long' };
    return { ok: true, path: p };
  }

  function normalizeEntry(r) {
    r = r || {};
    const n = cleanName(r.name);
    if (!n.ok) return null;
    const updatedAt = num(r.updatedAt) || num(r.createdAt);
    return {
      id: str(r.id || slug(n.name)),
      agentId: str(r.agentId) || 'agent',
      name: n.name,
      scope: ['agent', 'project', 'station'].includes(r.scope) ? r.scope : 'agent',
      projectRoot: str(r.projectRoot),
      promotionReceiptId: str(r.promotionReceiptId),
      canonicalRevision: bool(r.canonicalRevision),
      summary: str(r.summary).slice(0, SUMMARY_MAX),
      description: str(r.description || r.summary).slice(0, SUMMARY_MAX),
      body: str(r.body).slice(0, BODY_MAX),
      setup: str(r.setup).slice(0, BODY_MAX),
      category: cleanCategory(r.category),
      requires: arr(r.requires),
      platforms: arr(r.platforms),
      state: stateOf(r.state),
      pinned: bool(r.pinned),
      createdBy: str(r.createdBy || 'agent'),
      writtenBy: str(r.writtenBy || r.createdBy || 'agent'),   // who wrote THIS version (consistency loop: review writes ask)
      sourceRunId: r.sourceRunId ? str(r.sourceRunId) : null,
      sourceUrl: r.sourceUrl ? str(r.sourceUrl) : '',
      sourceDigest: r.sourceDigest ? str(r.sourceDigest) : '',
      sourceFetchedAt: num(r.sourceFetchedAt),
      sourceVersion: r.sourceVersion ? str(r.sourceVersion) : '',
      sourceAuthor: r.sourceAuthor ? str(r.sourceAuthor) : '',
      sourceLicense: r.sourceLicense ? str(r.sourceLicense) : '',
      createdAt: num(r.createdAt) || updatedAt,
      updatedAt: updatedAt,
      lastUsedAt: r.lastUsedAt == null ? null : num(r.lastUsedAt),
      viewCount: num(r.viewCount),
      useCount: num(r.useCount),
      patchCount: num(r.patchCount),
      packagePath: r.packagePath ? str(r.packagePath) : '',
      scan: r.scan || null,
      guardAction: r.guardAction || '',
      contentDigest: r.contentDigest ? str(r.contentDigest) : '',
      packageDigest: r.packageDigest ? str(r.packageDigest) : '',
      packageBytes: num(r.packageBytes),
      packageFiles: normPackageFiles(r.packageFiles),
      packageDiverged: bool(r.packageDiverged),
      absorbedInto: r.absorbedInto ? str(r.absorbedInto) : '',
      files: normFiles(r.files)
    };
  }

  function projectFile(f, includeContent) {
    const bytes = FileBytes.byteLength(f);   // decoded, never estimated from the base64 length (padding over-counted)
    const out = { path: f.path, encoding: f.encoding || 'utf8', updatedAt: num(f.updatedAt), bytes };
    if (includeContent) out.content = str(f.content);
    return out;
  }
  function projectSkill(s, includeBody) {
    const files = Object.keys(s.files || {}).sort().map(p => projectFile(s.files[p], !!includeBody));
    const out = {
      id: s.id, agentId: s.agentId, name: s.name, summary: s.summary, description: s.description || s.summary || '',
      category: s.category, setup: s.setup || '',
      scope: s.scope || 'agent', projectRoot: s.projectRoot || '',
      promotionReceiptId: s.promotionReceiptId || '', canonicalRevision: !!s.canonicalRevision,
      requires: (s.requires || []).slice(), platforms: (s.platforms || []).slice(), state: s.state, pinned: !!s.pinned,
      createdBy: s.createdBy, writtenBy: s.writtenBy || s.createdBy, sourceRunId: s.sourceRunId || null,
      sourceUrl: s.sourceUrl || '', sourceDigest: s.sourceDigest || '', sourceFetchedAt: s.sourceFetchedAt || 0,
      sourceVersion: s.sourceVersion || '', sourceAuthor: s.sourceAuthor || '', sourceLicense: s.sourceLicense || '',
      createdAt: s.createdAt || 0, updatedAt: s.updatedAt || 0, lastUsedAt: s.lastUsedAt || null,
      viewCount: s.viewCount || 0, useCount: s.useCount || 0, patchCount: s.patchCount || 0,
      packagePath: s.packagePath || '', scan: s.scan || null, guardAction: s.guardAction || '',
      contentDigest: s.contentDigest || '', absorbedInto: s.absorbedInto || '',
      packageDigest: s.packageDigest || '', packageBytes: s.packageBytes || 0,
      packageFileCount: (s.packageFiles || []).length, packageDiverged: !!s.packageDiverged,
      files
    };
    if (includeBody) { out.body = s.body || ''; out.packageFiles = normPackageFiles(s.packageFiles); }
    return out;
  }

  function makeSkillStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const redact = typeof opts.redact === 'function' ? opts.redact : (s) => s;
    const maxPerAgent = opts.maxPerAgent || DEFAULT_MAX_PER_AGENT;
    const bodyMax = opts.bodyMax || BODY_MAX;
    const supportFileMax = opts.supportFileMax || SUPPORT_FILE_MAX;
    const packageStore = opts.packageStore || opts.packages || null;
    const guard = opts.guard || null;
    // skills/gate.js digestOf, injected. The stamp is what lets the metadata-only list() answer
    // "is this exact content still the content the Commander approved?" without loading bodies.
    const digest = typeof opts.digest === 'function' ? opts.digest : null;
    const maxFiles = opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_MAX_FILES;
    const maxPackageBytes = opts.maxPackageBytes > 0 ? opts.maxPackageBytes : DEFAULT_MAX_PACKAGE_BYTES;

    const latest = new Map();
    const candidateRows = new Map();
    // Receipts must come from the host evaluator's durable authority, not model-submitted JSON.
    const validatePromotionReceipt = typeof opts.validatePromotionReceipt === 'function' ? opts.validatePromotionReceipt : null;
    // stale is the aging clock, not content: using a stale skill flips it active, which must not orphan its pending
    // revision (the same rule as skillevaluation.js digestSkill, the digest the run host injects)
    const digestCandidate = typeof opts.digestCandidate === 'function' ? opts.digestCandidate : (s) => {
      const f = require('./skills/gate.js').digestOf;
      if (!s) return f({ body: 'null' });
      return f({ body: JSON.stringify([s.name, s.summary, s.description, s.body, s.setup, s.category,
        s.requires, s.platforms, s.scope || 'agent', s.projectRoot || '', s.state === 'stale' ? 'active' : s.state, s.pinned, s.absorbedInto, s.packageFiles]), files: s.files || [] });
    };
    function revisionDigest(entry) { return str(digestCandidate(entry ? projectSkill(entry, true) : null)); }
    function restoreCandidate(r) {
      if (!r || r.recordType !== 'skill-candidate' || !r.candidateId || !r.skill) return;
      const skill = normalizeEntry(r.skill);
      if (!skill || skill.agentId !== str(r.agentId) || skill.name !== r.name) return;
      candidateRows.set(keyOf(skill.agentId, skill.name), Object.assign({}, r, { skill }));
    }
    // A USAGE ROW (markUsed) carries only the counters, keyed by `skillName` — never `name`, so an older StarNet
    // that does not know the row reads it as a nameless record and skips it instead of replacing the skill.
    // A use always leaves the skill ACTIVE (markUsed never touches an archived one, and the run's view() has already
    // flipped a stale one in RAM), so the row restores that unconditionally; a later curate/archive record, which comes
    // after it in file order, still wins.
    function applyUsage(r) {
      const e = latest.get(keyOf(str(r.agentId), str(r.skillName)));
      if (!e) return;
      e.useCount = Math.max(num(e.useCount), num(r.useCount));
      e.viewCount = Math.max(num(e.viewCount), num(r.viewCount));
      if (r.lastUsedAt != null) e.lastUsedAt = Math.max(num(e.lastUsedAt), num(r.lastUsedAt));
      if (e.state === 'stale') e.state = 'active';
    }
    // The library may only be WRITTEN (persist, a staged proposal, a rejection, markUsed, curate, compact) after a
    // COMPLETE load: a failed or partial read
    // leaves skills that exist on disk missing from RAM, and a write over one of them (or a compaction of the
    // partial view) is exactly how skills get replaced or deleted.
    let loaded = false, loadError = null;
    try {
      const raw = io.readAll();
      if (Array.isArray(raw)) for (const r of raw) {
        if (r && r.recordType === 'skill-usage') { applyUsage(r); continue; }
        if (r && r.recordType === 'skill-candidate') { restoreCandidate(r); continue; }
        if (r && r.recordType === 'skill-promotion') {
          const active = normalizeEntry(r.entry);
          if (active) latest.set(keyOf(active.agentId, active.name), active);
          restoreCandidate(r.candidate); continue;
        }
        const n = normalizeEntry(r);
        if (n) latest.set(keyOf(n.agentId, n.name), n);
      }
      loaded = true;
    } catch (e) { loadError = e; failNote('skillstore.load', e); }   // the library reads empty, and refuses writes (canWrite)
    /* SETTLED ON LOAD (canonical bytes + scan census, 2026-10-28), in RAM only: nothing is written at boot.
       A RECORD SAVED BEFORE THE GUARD EXISTED (no verdict, no stamp) is judged now (bug 56c6f962). Its body was withheld
       at delivery, where verify() scans it, but the prompt index decides from metadata and printed its summary: text no
       scan had covered rode every run. With its verdict in RAM the index and the delivery seam agree from the first run
       (a flagged record is named and withheld, never summarized); markUsed still persists it on first use.
       DIGEST RE-STAMP. skills/gate.js digestOf reads a file's BYTES (FileBytes.contentKey), not the string it is
          stored as, so a package file stored base64 digests like the same bytes stored as text. A record stamped with
          the old (string) digest of exactly what it holds is re-stamped to the new digest of the same bytes, and the old
          digests an approval may carry (the record as stored, and the trimmed-body view the old mirror read back) are
          listed by digestRestamps(), for the host to carry its approvals over (skills/gate.js restampApprovals).
       A draft store (stageMutation) is built from records already settled, so it skips this. */
    const restamps = [];
    const settleCounts = { digested: 0, skipped: 0 };
    if (loaded && !opts._settled) settleLoaded();
    /* NOTHING TO MOVE (boot cost): with the gate's own digest pair, a record whose body has no whitespace at its ends
       and whose every file is stored as well-formed text digests the same both ways (each file's key IS its stored
       string: well-formed text round-trips through UTF-8 exactly) and its trimmed-body view is itself, so it can never
       be re-stamped. Its three digests are not computed. Anything else (a base64 entry, a lone surrogate, an injected
       digest) is digested as before. */
    function cannotMove(e, gateMod, legacyDigest) {
      if (digest !== gateMod.digestOf || legacyDigest !== gateMod.legacyDigestOf) return false;
      if (str(e.body) !== str(e.body).trim()) return false;
      const files = e.files || {};
      for (const k of Object.keys(files)) {
        const f = files[k];
        if (!f || f.encoding === 'base64') return false;
        const c = str(f.content);
        if (typeof c.isWellFormed === 'function' ? !c.isWellFormed() : /[\uD800-\uDFFF]/.test(c)) return false;
      }
      return true;
    }
    function settleLoaded() {
      const gateMod = require('./skills/gate.js');
      const legacyDigest = typeof opts.legacyDigest === 'function' ? opts.legacyDigest : gateMod.legacyDigestOf;
      for (const e of latest.values()) {
        if (guard && !e.scan && !str(e.guardAction)) {   // a pre-guard record (see above)
          scanInto(e, projectSkill(e, true));
          // a scan that failed (scanInto notes the error) is no verdict: the record asks, in RAM, until a scan says otherwise
          if (!e.scan) e.guardAction = 'ask';
        }
        if (!digest || typeof legacyDigest !== 'function') continue;
        if (cannotMove(e, gateMod, legacyDigest)) { settleCounts.skipped++; continue; }
        settleCounts.digested++;
        let fresh = '', old = '', oldTrim = '';
        try {
          const projected = projectSkill(e, true);
          fresh = str(digest(projected)); old = str(legacyDigest(projected));
          oldTrim = str(legacyDigest(Object.assign({}, projected, { body: str(projected.body).trim() })));
        } catch (err) { failNote('skillstore.restamp', err); continue; }
        const stamp = str(e.contentDigest);
        if (stamp && stamp === old && old !== fresh) e.contentDigest = fresh;
        if (str(e.contentDigest) && str(e.contentDigest) !== fresh) continue;   // stamped with something else: nothing of ours to carry
        const from = [old, oldTrim].filter((d, i, a) => d && d !== fresh && a.indexOf(d) === i);
        if (from.length) restamps.push({ agentId: e.agentId, id: e.id, from, to: fresh, stamp });
      }
    }
    function canWrite() { return loaded && !(io && typeof io.loadComplete === 'function' && io.loadComplete() === false); }
    function cannotWrite() {
      return new Error('the skill library did not load completely (' + ((loadError && loadError.message) || 'a partial read') + '), so nothing is written over it until it loads');
    }
    // Compaction instead of rotation: once the io says the file has grown (or a legacy rotated archive is still on
    // disk), rewrite it to one line per skill. Runs only after a write was published to RAM, so the rewrite holds it.
    function maybeCompact() {
      try { if (io && typeof io.needsCompaction === 'function' && io.needsCompaction()) compact(); }
      catch (e) { failNote('skillstore.compact', e); }
    }

    function now() { return num(clock.now()); }
    function red(s, max) {
      let v = str(s).slice(0, max);
      try { v = str(redact(v)).slice(0, max); } catch (e) { failNote('skillstore.redact', e); }
      return v;
    }
    // RAM-only bump: update the in-memory `latest` copy WITHOUT appending a JSONL line. view() is called on
    // every skill.view / skill load, many times per run — appending each one is what grows skills.jsonl without
    // bound. The bumped counters (viewCount/useCount/lastUsedAt/state) instead ride along the NEXT durable write:
    // markUsed's usage row at the end of the run that loaded it, a real mutation (write/edit/patch/curate persist the
    // skill and makeEntry carries the counters forward), or a compaction. Returns the projected skill.
    function bumpView(entry) {
      latest.set(keyOf(entry.agentId, entry.name), clone(entry));
      return entry;
    }
    // The guard's verdict for these bytes under the CURRENT rules, stamped onto `entry` (scan + guardAction).
    function scanInto(entry, projected) {
      try {
        if (guard && typeof guard.scanSkillRecord === 'function') {
          // 'user' (the Commander's own typing) is its own trust tier — see the TRUST table in
          // skills/guard.js for why it asks rather than blocks now that verdicts are enforced.
          const scanInput = clone(projected);
          if (Array.isArray(entry.packageFiles) && entry.packageFiles.length && !entry.packageDiverged) {
            scanInput.files = entry.packageFiles.filter(f => f.path !== 'SKILL.md').map(f => {
              const bytes = FileBytes.bytesOf(f), text = FileBytes.textOf(bytes);
              return { path: f.path, content: text != null ? text : '[binary asset: ' + bytes.length + ' bytes]' };
            });
          }
          const origin = typeof guard.originTier === 'function' ? guard.originTier(entry) : trustSource(entry.createdBy);
          const scan = guard.scanSkillRecord(scanInput, { source: origin });
          entry.scan = scan;
          if (typeof guard.actionFor === 'function') {
            // the stricter of where the skill came from and who wrote this version (skills/guard.js actionFor)
            entry.guardAction = guard.actionFor(entry, scan.verdict);
          } else if (typeof guard.shouldAllow === 'function') {
            const policy = guard.shouldAllow(scan, { allowAsk: true });
            entry.guardAction = policy.action || '';
          }
          /* PROVENANCE ASK (consistency loop, slice 3, 2026-08-22): a version written by the BACKGROUND REVIEW
             (the quiet aux loop that patches/creates skills after a run or a verdict) is withheld from every
             prompt until the Commander approves THESE bytes — the same digest-keyed gate a scanner `ask` uses
             and the same keep/discard the memory turn-in card has always had. Memory proposals were reviewed;
             skill writes landed straight into the next run's system prompt. A `block` stays a block. */
          if (reviewWritten(entry) && entry.guardAction !== 'block') entry.guardAction = 'ask';
        }
      } catch (e) { failNote('skillstore.guard.scan', e); }
      return entry;
    }
    /* THE PACKAGE MIRROR (skill-packages/<agent>/<id>/SKILL.md) is what view() hydrates over a non-canonical skill's
       stored body, so it may only ever hold bytes the store accepted. persist() writes it AFTER the durable append (a
       refused edit never reaches it), and markUsed re-writes it for a skill this process has not yet mirrored from its
       current record: the first use after a boot, or the first use after a failed write (a Windows EBUSY on SKILL.md).
       That is the repair a use used to get from persist() on every run, at one package write per skill per boot. */
    const mirrored = new Set();
    function mirrorDir(entry) {
      if (!packageStore) return '';
      const dirOf = entry.state === 'archived' && typeof packageStore.archiveDir === 'function' ? packageStore.archiveDir : packageStore.packageDir;
      return typeof dirOf === 'function' ? str(dirOf(entry)) : '';
    }
    // `previous` is the version this write replaces, so the mirror can drop a file the skill no longer holds (remove_file)
    function writeMirror(entry, tag, previous) {
      if (!packageStore || typeof packageStore.writePackage !== 'function') return;
      const key = keyOf(entry.agentId, entry.name);
      mirrored.delete(key);
      try { packageStore.writePackage(projectSkill(entry, true), { previous: previous ? projectSkill(previous, true) : null }); mirrored.add(key); }
      catch (e) { failNote(tag, e); }
    }
    function persist(entry, promotion) {
      if (!canWrite()) throw cannotWrite();
      const projected = projectSkill(entry, true);
      scanInto(entry, projected);
      // Stamp the digest of the content that was JUST scanned, so the verdict and the digest can
      // never disagree about which bytes they describe.
      try { if (digest) entry.contentDigest = str(digest(projected)); } catch (_) {}
      // The record names its mirror before the append; the mirror itself is written after it (see writeMirror).
      if (!promotion) { const dir = mirrorDir(entry); if (dir) entry.packagePath = dir; }
      try { io.append(clone(promotion ? { recordType: 'skill-promotion', entry, candidate: promotion } : entry)); }
      catch (e) { failNote('skillstore.append', e); throw e; }
      // Publish to RAM only after the durable event was accepted. Otherwise manage() reports
      // success for a skill that vanishes on the next sidecar restart.
      const previous = latest.get(keyOf(entry.agentId, entry.name)) || null;
      latest.set(keyOf(entry.agentId, entry.name), clone(entry));
      // The durable entry is authoritative: a promotion's mirror is written only once publication committed, so a
      // failed append cannot make a new candidate overwrite the previously approved package.
      if (promotion) candidateRows.set(keyOf(entry.agentId, entry.name), clone(promotion));
      writeMirror(entry, promotion ? 'skillstore.package.promotion' : 'skillstore.package.write', previous);
      maybeCompact();
      return entry;
    }
    function mine(agentId, opts2) {
      opts2 = opts2 || {};
      const out = [];
      const pfx = str(agentId) + '\x00';
      for (const [k, v] of latest) {
        if (k.indexOf(pfx) !== 0) continue;
        if (!opts2.includeArchived && v.state === 'archived') continue;
        if (Array.isArray(opts2.states) && opts2.states.indexOf(v.state) < 0) continue;
        out.push(v);
      }
      out.sort((a, b) => (!!b.pinned - !!a.pinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)) || a.name.localeCompare(b.name));
      return out;
    }
    function countFor(agentId) { return mine(agentId).length; }
    function find(agentId, idOrName, opts2) {
      opts2 = opts2 || {};
      const q = str(idOrName).trim();
      if (!q) return null;
      const byName = latest.get(keyOf(agentId, q));
      if (byName && (opts2.includeArchived || byName.state !== 'archived')) return byName;
      const ql = q.toLowerCase();
      for (const s of mine(agentId, { includeArchived: !!opts2.includeArchived })) {
        if (s.id === q || s.name.toLowerCase() === ql) return s;
      }
      return null;
    }

    function makeEntry(e, existing, how) {
      e = e || {};
      const n = cleanName(e.name != null ? e.name : (existing && existing.name));
      if (!n.ok) return n;
      const t = now();
      /* A PACKAGE IS STORED AS ITS BYTES (canonical bytes, 2026-10-28). An install, an import, an update or a rollback
         hands over text decoded from a package whose exact bytes are sealed beside it (packageFiles, packageDigest): the
         store keeps that text verbatim. The log redactor used to run over it, so the record (and the stamp an approval
         binds) no longer described the package the Commander inspected and the mirror holds; a credential in a skill is
         scrubbed where its text leaves for a model or the station (the tool registry's result scrub, the run prompt's
         skill blocks, the review, curator and evaluation prompts, an export, a market share). Anything else written here
         (a model or a panel edit) is still redacted on the way in; `how.verbatim` is a caller that already holds the
         stored text (a patch: only its replacement text is new, and it redacts that alone). */
      const sealedWrite = (how && how.verbatim) || (e.packageFiles != null && e.packageDiverged === false && normPackageFiles(e.packageFiles).length > 0);
      const text = (v, max) => sealedWrite ? str(v).slice(0, max) : red(v, max);
      const body = e.body != null ? text(e.body, bodyMax) : (existing ? existing.body : '');
      let files = existing ? clone(existing.files || {}) : {};
      if (e.files != null) {
        const w = writtenFiles(e.files, supportFileMax, existing && existing.files);
        if (!w.ok) return w;
        files = w.files;
      }
      return { ok: true, entry: {
        id: existing ? existing.id : slug(n.name),
        agentId: str(e.agentId || (existing && existing.agentId) || 'agent'),
        name: n.name,
        scope: existing ? existing.scope || 'agent' : 'agent',
        projectRoot: existing ? existing.projectRoot || '' : '',
        promotionReceiptId: '', canonicalRevision: false,
        summary: e.summary != null ? text(e.summary, SUMMARY_MAX) : (existing ? existing.summary : ''),
        description: e.description != null ? text(e.description, SUMMARY_MAX) : (existing ? (existing.description || existing.summary) : text(e.summary, SUMMARY_MAX)),
        body,
        setup: e.setup != null ? text(e.setup, bodyMax) : (existing ? existing.setup || '' : ''),
        category: cleanCategory(e.category != null ? e.category : (existing && existing.category)),
        requires: e.requires != null ? arr(e.requires) : (existing ? (existing.requires || []).slice() : []),
        platforms: e.platforms != null ? arr(e.platforms) : (existing ? (existing.platforms || []).slice() : []),
        state: stateOf(e.state || (existing && existing.state) || 'active'),
        pinned: e.pinned != null ? !!e.pinned : !!(existing && existing.pinned),
        // createdBy is the skill's ORIGIN and is never rewritten by an edit: the trust tier is read from it, and
        // an edit that relabeled it was how a withheld community skill got un-withheld (skills/guard.js actionFor)
        createdBy: str((existing && existing.createdBy) || e.createdBy || 'agent'),
        writtenBy: str(e.createdBy || 'agent'),   // the actor of THIS write, never inherited (a review edit of a user skill is a review write)
        sourceRunId: e.sourceRunId ? str(e.sourceRunId) : ((existing && existing.sourceRunId) || null),
        sourceUrl: e.sourceUrl != null ? str(e.sourceUrl) : ((existing && existing.sourceUrl) || ''),
        sourceDigest: e.sourceDigest != null ? str(e.sourceDigest) : ((existing && existing.sourceDigest) || ''),
        sourceFetchedAt: e.sourceFetchedAt != null ? num(e.sourceFetchedAt) : ((existing && existing.sourceFetchedAt) || 0),
        sourceVersion: e.sourceVersion != null ? str(e.sourceVersion) : ((existing && existing.sourceVersion) || ''),
        sourceAuthor: e.sourceAuthor != null ? str(e.sourceAuthor) : ((existing && existing.sourceAuthor) || ''),
        sourceLicense: e.sourceLicense != null ? str(e.sourceLicense) : ((existing && existing.sourceLicense) || ''),
        createdAt: existing ? existing.createdAt : t,
        updatedAt: t,
        lastUsedAt: existing ? existing.lastUsedAt : null,
        viewCount: existing ? existing.viewCount || 0 : 0,
        useCount: existing ? existing.useCount || 0 : 0,
        patchCount: existing ? existing.patchCount || 0 : 0,
        packagePath: existing ? existing.packagePath || '' : '',
        scan: existing ? existing.scan || null : null,
        guardAction: existing ? existing.guardAction || '' : '',
        contentDigest: existing ? existing.contentDigest || '' : '',
        packageDigest: e.packageDigest != null ? str(e.packageDigest) : ((existing && existing.packageDigest) || ''),
        packageBytes: e.packageBytes != null ? num(e.packageBytes) : ((existing && existing.packageBytes) || 0),
        packageFiles: e.packageFiles != null ? normPackageFiles(e.packageFiles) : normPackageFiles(existing && existing.packageFiles),
        packageDiverged: e.packageDiverged != null ? !!e.packageDiverged : !!(existing && existing.packageDiverged),
        absorbedInto: existing ? existing.absorbedInto || '' : '',
        files
      } };
    }

    /* PINNED IS A LOCK, NOT A LABEL. It used to be neither: the only thing protecting a pinned
       skill was a bullet in the curator's PROMPT ("Never modify pinned skills"), so any model
       that ignored it — or any ordinary agent run that never saw that prompt — could rewrite or
       archive the Commander's pinned procedure. A rule enforced only in a prompt is a suggestion.
       The one exemption is an explicit, forced call from the human surface: the Commander may
       overwrite their own pin deliberately (the panel sends force), never a model. */
    const CONTENT_ACTIONS = ['edit', 'patch', 'archive', 'delete', 'write_file', 'remove_file'];
    function pinnedGuard(existing, e, action) {
      if (!existing || !existing.pinned) return null;
      if (CONTENT_ACTIONS.indexOf(action) < 0) return null;
      const byHuman = str(e && e.createdBy) === 'user';
      if (byHuman && (e && e.force === true)) return null;
      return { ok: false, error: '"' + existing.name + '" is pinned - unpin it first (pinned skills are protected from ' + action + ')' };
    }

    function write(e) {
      e = e || {};
      if (shouldStage(e, true)) return stageMutation(e, true);
      const agentId = str(e.agentId) || 'agent';
      const n = cleanName(e.name);
      if (!n.ok) return { ok: false, error: n.error };
      const existing = find(agentId, n.name, { includeArchived: true });
      // write() is the compatibility wrapper, and on an existing name it is an EDIT — so it is a
      // content action and the pin applies. Without this, skill.write was a hole straight through
      // the guard below.
      const pinBlock = pinnedGuard(existing, e, 'edit');
      if (pinBlock) return pinBlock;
      if (!existing && countFor(agentId) >= maxPerAgent) return { ok: false, error: 'skill library is full (max ' + maxPerAgent + ') - edit or archive one first' };
      const made = makeEntry(Object.assign({}, e, { agentId, name: n.name, state: 'active' }), existing);
      if (!made.ok) return { ok: false, error: made.error };
      const entry = persist(made.entry);
      return { ok: true, skill: projectSkill(entry, true), edited: !!existing };
    }

    function patchBody(body, findText, replaceText) {
      const source = str(body);
      const needle = str(findText);
      if (!needle) return { ok: false, error: 'patch needs find text' };
      let idx = source.indexOf(needle);
      if (idx < 0) {
        const lower = source.toLowerCase();
        idx = lower.indexOf(needle.toLowerCase());
      }
      if (idx < 0) return { ok: false, error: 'patch text not found' };
      return { ok: true, body: source.slice(0, idx) + str(replaceText) + source.slice(idx + needle.length), at: idx, len: str(replaceText).length };
    }

    function manage(e) {
      e = e || {};
      if (shouldStage(e, false)) return stageMutation(e, false);
      const agentId = str(e.agentId) || 'agent';
      const action = str(e.action || 'create').toLowerCase();
      const target = e.target != null ? e.target : (e.id != null ? e.id : e.name);
      let existing = null, made, entry, p, t;

      if (action === 'create') {
        const n = cleanName(e.name);
        if (!n.ok) return { ok: false, error: n.error };
        if (!str(e.body).trim()) return { ok: false, error: 'a new skill needs a body' };
        if (find(agentId, n.name, { includeArchived: true })) return { ok: false, error: 'a skill named "' + n.name + '" already exists - patch or edit it instead' };
        if (countFor(agentId) >= maxPerAgent) return { ok: false, error: 'skill library is full (max ' + maxPerAgent + ') - edit or archive one first' };
        made = makeEntry(Object.assign({}, e, { agentId, name: n.name, state: 'active' }), null);
        if (!made.ok) return { ok: false, error: made.error };
        entry = persist(made.entry);
        return { ok: true, action: 'create', skill: projectSkill(entry, true), edited: false };
      }

      existing = find(agentId, target, { includeArchived: true });
      if (!existing) return { ok: false, error: 'no such skill: ' + str(target || '') };

      const pinBlock = pinnedGuard(existing, e, action);
      if (pinBlock) return pinBlock;

      if (action === 'edit') {
        made = makeEntry(Object.assign({}, e, { agentId, name: existing.name }), existing);
        if (!made.ok) return { ok: false, error: made.error };
        made.entry.patchCount = (made.entry.patchCount || 0) + 1;
        if (e.packageDigest == null) made.entry.packageDiverged = !!made.entry.packageDigest;
        entry = persist(made.entry);
        return { ok: true, action: 'edit', skill: projectSkill(entry, true), edited: true };
      }

      if (action === 'patch') {
        p = patchBody(existing.body, e.find, e.replace);
        if (!p.ok) return p;
        /* A patch is an authored edit: the package diverges, and the PATCHED LINES are redacted like any other write.
           Only they: the first patch of an installed skill (stored verbatim) re-ran the redactor over the whole body,
           summary and description, silently rewriting lines nobody patched. Every other stored field is carried as is. */
        const lo = p.at > 0 ? p.body.lastIndexOf('\n', p.at - 1) + 1 : 0;
        let hi = p.body.indexOf('\n', p.at + p.len); if (hi < 0) hi = p.body.length;
        const patched = p.body.slice(0, lo) + red(p.body.slice(lo, hi), bodyMax) + p.body.slice(hi);
        made = makeEntry(Object.assign({}, existing, { agentId, name: existing.name, body: patched, createdBy: e.createdBy || 'agent', sourceRunId: e.sourceRunId, packageDiverged: !!existing.packageDigest }), existing, { verbatim: true });
        if (!made.ok) return { ok: false, error: made.error };
        made.entry.patchCount = (made.entry.patchCount || 0) + 1;
        made.entry.packageDiverged = !!made.entry.packageDigest;
        entry = persist(made.entry);
        return { ok: true, action: 'patch', skill: projectSkill(entry, true), edited: true };
      }

      if (action === 'archive' || action === 'delete') {
        /* A CONSOLIDATION MUST NAME ITS HEIR. The curator's whole job is to fold narrow siblings
           into one umbrella, and its prompt already forbids archiving before the content is
           preserved — but nothing checked. An archive with no surviving target is indistinguishable
           from losing the skill, and "delete" is aliased to archive precisely so nothing is ever
           lost: keep that promise auditable. Only the curator is held to this; a Commander or an
           ordinary run may archive a skill for any reason. The heir must be LIVE (an archived heir
           is a chain into the dark) and must not be the skill itself. */
        const byCurator = str(e.createdBy) === 'curator';
        let heir = null;
        if (byCurator) {
          const want = str(e.absorbedInto || e.absorbed_into || e.mergedInto).trim();
          if (!want) return { ok: false, error: 'a curator archive must set absorbedInto to the skill that now carries this content' };
          heir = find(agentId, want, { includeArchived: false });
          if (!heir) return { ok: false, error: 'absorbedInto "' + want + '" is not a live skill - merge the content first, then archive' };
          if (heir.id === existing.id) return { ok: false, error: 'absorbedInto cannot be the skill being archived' };
        } else if (str(e.absorbedInto || '').trim()) {
          heir = find(agentId, str(e.absorbedInto).trim(), { includeArchived: false });
        }
        // Archive and restore change no content, so they keep the writer of these bytes: relabeling a withheld
        // review-written version as the Commander's would approve bytes nobody read. (A staged archive is still
        // stamped with its proposer in stageMutation.)
        entry = clone(existing); entry.state = 'archived'; entry.updatedAt = now();
        if (heir) entry.absorbedInto = heir.name;
        entry = persist(entry);
        return { ok: true, action: 'archive', absorbedInto: entry.absorbedInto || '', skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'restore') {
        entry = clone(existing); entry.state = 'active'; entry.updatedAt = now();
        entry = persist(entry);
        return { ok: true, action: 'restore', skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'pin' || action === 'unpin') {
        const pinNext = action === 'pin' ? true : (e.pinned != null ? !!e.pinned : false);
        /* ONLY THE COMMANDER TAKES A PIN OFF (bug 97743dff). The pin is the lock pinnedGuard holds against every model
           write; while a run could unpin (pin/unpin are never staged), the lock lasted one tool call and the next patch
           went through. Pinning stays open to any writer: it only adds the lock. */
        if (existing.pinned && !pinNext && str(e.createdBy) !== 'user') {
          return { ok: false, error: '"' + existing.name + '" is pinned by the Commander - only the Commander can unpin it, in ABILITIES > SKILLS' };
        }
        entry = clone(existing); entry.pinned = pinNext; entry.updatedAt = now();
        entry = persist(entry);
        return { ok: true, action, skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'write_file') {
        p = supportPath(e.path || e.file || e.filePath);
        if (!p.ok) return p;
        t = now();
        entry = clone(existing);
        // A support file ships with the body it sits beside: never lower a review stamp on that body.
        if (!reviewWritten(existing)) entry.writtenBy = str(e.createdBy || 'agent');
        entry.files = normFiles(entry.files);
        /* THE FILE IS STORED AS ITS BYTES (gh#145). write_file ran the log redactor over support-file content, whose
           credential-assignment rule rewrote ordinary code ('if not password:' + 'raise ...' became '[redacted-secret]
           ...'), and cut a long file to the limit without a word. The bytes are decoded once (FileBytes) and stored in
           the one canonical form; a file over the limit is refused, never cut; a credential is scrubbed where text
           leaves for a model (the registry's result scrub on skill.view, the run prompt's skill blocks). */
        const fileBytes = FileBytes.bytesOf({ encoding: e.encoding === 'base64' ? 'base64' : 'utf8', content: e.content });
        if (fileBytes.length > supportFileMax) return { ok: false, error: 'the support file ' + p.path + ' is ' + fileBytes.length + ' bytes, over the ' + supportFileMax + '-byte limit - split it into smaller files' };
        // These two bound the PACKAGE. Overwriting an existing path is always allowed (it cannot grow the count, and its
        // old bytes leave with it). Counted in BYTES: a base64 file no longer counts its encoding's extra third.
        const isNew = !entry.files[p.path];
        if (isNew && Object.keys(entry.files).length >= maxFiles) {
          return { ok: false, error: 'this skill already has ' + maxFiles + ' support files - replace or remove one instead' };
        }
        let bytes = Buffer.byteLength(str(entry.body), 'utf8') + Buffer.byteLength(str(entry.setup), 'utf8');
        for (const k of Object.keys(entry.files)) if (k !== p.path) bytes += FileBytes.byteLength(entry.files[k]);
        if (bytes + fileBytes.length > maxPackageBytes) {
          return { ok: false, error: 'the skill package would exceed ' + maxPackageBytes + ' bytes - trim it or split the content into a second skill' };
        }
        entry.files[p.path] = FileBytes.toEntry(p.path, fileBytes, { updatedAt: t });
        entry.packageDiverged = !!entry.packageDigest;
        entry.patchCount = (entry.patchCount || 0) + 1;
        entry.updatedAt = t;
        entry = persist(entry);
        return { ok: true, action: 'write_file', path: p.path, skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'remove_file') {
        p = supportPath(e.path || e.file || e.filePath);
        if (!p.ok) return p;
        entry = clone(existing);
        // A support file ships with the body it sits beside: never lower a review stamp on that body.
        if (!reviewWritten(existing)) entry.writtenBy = str(e.createdBy || 'agent');
        entry.files = normFiles(entry.files);
        delete entry.files[p.path];
        entry.packageDiverged = !!entry.packageDigest;
        entry.patchCount = (entry.patchCount || 0) + 1;
        entry.updatedAt = now();
        entry = persist(entry);
        return { ok: true, action: 'remove_file', path: p.path, skill: projectSkill(entry, true), edited: true };
      }

      return { ok: false, error: 'unknown skill action: ' + action };
    }

    // A review edits an isolated draft using the same validation as foreground writes.
    // It never publishes into latest or the package mirror. Multiple calls in one review
    // build on its pending draft; every revision invalidates previous evaluation receipts.
    function shouldStage(e, legacyWrite) {
      if (opts.stageReviews === false) return false;   // private isolated draft constructor
      if (STAGE_ACTORS.has(str(e.createdBy))) return true;
      if (!legacyWrite && ['pin', 'unpin'].includes(str(e.action))) return false;
      return trustSource(e.createdBy || 'agent') === 'agent-created';
    }
    function stageMutation(e, legacyWrite) {
      // The model's write path is a write too: after a failed load it would build on an empty view (isNew for a skill
      // on disk) and its row would replace the real pending proposal on the next boot.
      if (!canWrite()) return { ok: false, error: cannotWrite().message };
      const aid = str(e.agentId) || 'agent';
      const seeds = Array.from(latest.values()).map(clone);
      // A writer builds on a pending draft only when it can SEE that draft: the review/curator passes read it
      // through pendingView, and a foreground run sees it only when its own run wrote it. Otherwise the run's
      // patch text comes from the active body (so it "isn't found" in the draft) and a full edit would silently
      // discard the proposal it never saw. Two empty run ids are not the same run (a review draft can carry none).
      const unseen = new Map(), runId = str(e.sourceRunId);
      for (const row of candidateRows.values()) if (row.agentId === aid && row.status === 'pending'
        && row.baseDigest === revisionDigest(latest.get(keyOf(row.agentId, row.name)) || null)) {
        const own = !!runId && str(row.skill.sourceRunId) === runId;
        if (!STAGE_ACTORS.has(str(e.createdBy)) && !own) { unseen.set(keyOf(row.agentId, row.name), row); continue; }
        const i = seeds.findIndex(s => keyOf(s.agentId, s.name) === keyOf(row.agentId, row.name));
        if (i >= 0) seeds[i] = clone(row.skill); else seeds.push(clone(row.skill));
      }
      const awaiting = name => ({ ok: false, error: '"' + name + '" already has a proposal awaiting evaluation in ABILITIES > SKILLS - the Commander must approve or reject it before this skill can be changed again' });
      const draft = makeSkillStore(Object.assign({}, opts, { stageReviews: false, packageStore: null, packages: null, _settled: true,
        io: { readAll: () => seeds, append() {} } }));
      const r = legacyWrite ? draft.write(e) : draft.manage(e);
      if (!r.ok) {
        // A skill that exists only as an unseen proposal (a new skill, listed to its owner as WITHHELD) is not in
        // the draft at all: name the waiting proposal, not 'no such skill'.
        const target = str(legacyWrite ? e.name : (e.target != null ? e.target : (e.id != null ? e.id : e.name))).trim();
        const hidden = target && Array.from(unseen.values()).find(row => row.skill.id === target || row.name.toLowerCase() === target.toLowerCase());
        return hidden ? awaiting(hidden.name) : r;
      }
      // Only the skill this write targets can collide; an unrelated pending proposal never blocks it.
      if (unseen.has(keyOf(aid, r.skill && r.skill.name))) return awaiting(r.skill.name);
      const entry = normalizeEntry(r.skill);
      entry.writtenBy = str(e.createdBy || 'agent');
      entry.packagePath = ''; entry.canonicalRevision = false;
      if (entry.guardAction !== 'block') entry.guardAction = 'ask';
      const key = keyOf(aid, entry.name), active = latest.get(key) || null, prior = candidateRows.get(key);
      const revision = prior ? (Number(prior.revision) || 0) + 1 : 1;
      const row = { recordType: 'skill-candidate', candidateId: entry.id + '-candidate-' + revision,
        agentId: aid, name: entry.name, status: 'pending', revision,
        baseDigest: revisionDigest(active), candidateDigest: revisionDigest(entry),
        createdAt: prior && prior.status === 'pending' ? prior.createdAt : now(), updatedAt: now(),
        action: r.action || (r.edited ? 'edit' : 'create'), skill: entry };
      // An archive into a heir is bound to the heir version this draft saw (the curator's pending merge when there
      // was one, else the live heir): see heirBlocker.
      if (entry.state === 'archived' && entry.absorbedInto) {
        const heirSeen = seeds.find(s => keyOf(s.agentId, s.name) === keyOf(aid, entry.absorbedInto) && s.state !== 'archived');
        if (heirSeen) row.heirDigest = heirDigestOf(heirSeen);
      }
      try { io.append(clone(row)); } catch (err) { failNote('skillstore.candidate.append', err); throw err; }
      candidateRows.set(key, clone(row));
      // isNew: no active version (archived counts as one), so skill.write/manage can say "proposed skill" not "revision"
      return Object.assign({}, r, { pending: true, isNew: !active, candidate: projectCandidate(row, true),
        skill: Object.assign(projectSkill(entry, true), { pendingCandidate: true, candidateId: row.candidateId }) });
    }
    function projectCandidate(row, includeBody) {
      const out = clone(row); out.skill = projectSkill(row.skill, !!includeBody);
      return out;
    }
    // A pending proposal whose base is no longer the active skill can only be rejected: say so (baseCurrent:false)
    // instead of listing it as something the Commander can still evaluate. baseCurrent compares the STORED record,
    // as approveCandidate does. The evaluate/approve routes must read their baseline the same way (hydrate:false,
    // skills-eval-03): until they do, a hydrated body or support file can differ, so baseCurrent:true alone does not
    // promise that Evaluate will be accepted.
    function listedCandidate(row, includeBody) {
      const out = projectCandidate(row, includeBody);
      if (row.status === 'pending') out.baseCurrent = row.baseDigest === revisionDigest(latest.get(keyOf(row.agentId, row.name)) || null);
      return out;
    }
    function candidates(agentId, options) {
      const o = options || {};
      return Array.from(candidateRows.values()).filter(r => r.agentId === str(agentId)
        && (o.includeResolved || r.status === 'pending')).map(r => listedCandidate(r, !!o.includeBody));
    }
    function candidate(agentId, id) {
      const row = Array.from(candidateRows.values()).find(r => r.agentId === str(agentId) && r.candidateId === str(id));
      return row ? listedCandidate(row, true) : null;
    }
    function pendingView(agentId, target) {
      const row = Array.from(candidateRows.values()).find(r => r.agentId === str(agentId) && r.status === 'pending'
        && r.baseDigest === revisionDigest(latest.get(keyOf(r.agentId, r.name)) || null)
        && (r.skill.id === str(target) || r.name.toLowerCase() === str(target).toLowerCase() || r.candidateId === str(target)));
      return row ? Object.assign(projectSkill(row.skill, true), { pendingCandidate: true, candidateId: row.candidateId }) : null;
    }
    // A heir's CONTENT: lifecycle and pin are not content (a stale or pinned umbrella still carries the merged steps).
    function heirDigestOf(entry) { return entry ? revisionDigest(Object.assign(clone(entry), { state: 'active', pinned: false })) : ''; }
    /* AN ARCHIVE IS BOUND TO ITS HEIR (CONSOLIDATION MUST NAME ITS HEIR). A curator consolidation is two proposals,
       widen the umbrella and archive the narrow sibling into it, and the Commander can click them in any order.
       The archive row records the heir version it was built on (heirDigest), and it is approvable only while that
       exact content is the live heir. Otherwise the archived steps would be in no active skill: the merge was
       rejected, is outdated, or the heir changed since. Returns the refusal text, or null. */
    function heirBlocker(row) {
      const entry = row.skill;
      if (!entry || entry.state !== 'archived' || !entry.absorbedInto) return null;
      const heirName = str(entry.absorbedInto), q = '"' + heirName + '"';
      const heir = find(row.agentId, heirName, { includeArchived: false });
      const other = candidateRows.get(keyOf(row.agentId, heirName));
      const heirRow = other && other.candidateId !== row.candidateId ? other : null;
      const approveFirst = 'approve the proposal for ' + q + ' first - this archive moves its content there';
      const notLive = q + ' is not an active skill, so this archive would point at content nobody can load';
      if (!row.heirDigest) {   // proposed before archives recorded their heir version
        if (heirRow && heirRow.status === 'pending') return approveFirst;
        return heir ? null : notLive;
      }
      if (heir && heirDigestOf(heir) === row.heirDigest) return null;
      const merge = heirRow && heirDigestOf(heirRow.skill) === row.heirDigest ? heirRow : null;
      if (merge && merge.status === 'pending'
        && merge.baseDigest === revisionDigest(latest.get(keyOf(row.agentId, heirName)) || null)) return approveFirst;
      if (merge && (merge.status === 'pending' || merge.status === 'rejected'))
        return 'the merge into ' + q + ' was not approved, so archiving this skill would lose its steps; reject this archive';
      if (!heir) return notLive;
      return q + ' changed after this archive was proposed, so it may not hold these steps; reject this archive';
    }
    function candidateDecision(e) {
      const row = Array.from(candidateRows.values()).find(r => r.agentId === str(e.agentId) && r.candidateId === str(e.candidateId));
      if (!row || row.status !== 'pending') return { error: 'no pending candidate with that id' };
      if (!e.candidateDigest || str(e.candidateDigest) !== row.candidateDigest || revisionDigest(row.skill) !== row.candidateDigest)
        return { error: 'candidate changed; read and evaluate its current revision first' };
      return { row, active: latest.get(keyOf(row.agentId, row.name)) || null };
    }
    // Everything that stops a pending proposal from being promoted apart from its evaluation receipt (null when
    // nothing does). approveCandidate runs it, and the approve route must run it (promotionBlocker) BEFORE it
    // precommits a digest approval for the candidate's bytes: an archive carries the live sibling's bytes, so a
    // refused archive would otherwise leave a withheld sibling's bytes approved.
    function blockerFor(row, active) {
      if (revisionDigest(active) !== row.baseDigest) return 'the active skill changed after this proposal; reject it or wait for the agent to propose a new revision';
      if (row.skill.guardAction === 'block') return 'candidate is blocked by the skill guard';
      // Pinned content cannot be changed by proposing a revision before it was pinned.
      if (active && active.pinned) return 'the active skill is pinned; unpin it before promotion';
      return heirBlocker(row);
    }
    function promotionBlocker(agentId, candidateId) {
      const row = Array.from(candidateRows.values()).find(r => r.agentId === str(agentId) && r.candidateId === str(candidateId));
      if (!row || row.status !== 'pending') return 'no pending candidate with that id';
      return blockerFor(row, latest.get(keyOf(row.agentId, row.name)) || null);
    }
    function approveCandidate(e) {
      e = e || {};
      if (e.approvedBy !== 'user') return { ok: false, error: 'only the Commander may promote a candidate' };
      const found = candidateDecision(e);
      if (found.error) return { ok: false, error: found.error };
      const { row, active } = found;
      const blocked = blockerFor(row, active);
      if (blocked) return { ok: false, error: blocked };
      if (!validatePromotionReceipt) return { ok: false, error: 'candidate needs a host-verified behavior evaluation before promotion' };
      let checked;
      // acknowledgedNoImprovement is the Commander's explicit "accept a complete tie"; the verifier decides if it qualifies.
      try { checked = validatePromotionReceipt(e.evaluation, { candidateDigest: row.candidateDigest, baselineDigest: row.baseDigest,
        candidate: projectSkill(row.skill, true), baseline: active ? projectSkill(active, true) : null, agentId: row.agentId,
        acknowledgedNoImprovement: e.acknowledgedNoImprovement === true }); }
      catch (_) { checked = null; }
      if (!checked || checked.ok !== true || (checked.status && checked.status !== 'pass'))
        return { ok: false, error: (checked && checked.error) || 'evaluation is missing, stale, insufficient, or regressed' };
      const entry = clone(row.skill);
      // (A pinned active skill was already refused by blockerFor above.)
      // Usage belongs to the ACTIVE record: it kept counting while the candidate waited (no digest covers it), so
      // the proposal-time snapshot must not reset it, or a skill used every day since it was proposed would look
      // idle to curate() right after approval. Stale/active is the same freshness clock; archive/restore is content.
      if (active) {
        entry.viewCount = active.viewCount || 0; entry.useCount = active.useCount || 0;
        entry.lastUsedAt = active.lastUsedAt == null ? null : active.lastUsedAt;
        if (entry.state !== 'archived' && active.state !== 'archived') entry.state = active.state;
      }
      entry.canonicalRevision = true; entry.updatedAt = now();
      entry.promotionReceiptId = str(checked.receiptId || (e.evaluation && (e.evaluation.receiptId || e.evaluation.id)));
      // The decision record says whether the promotion was measured or only owner-acknowledged as no improvement.
      const resolved = Object.assign({}, clone(row), { status: 'promoted', resolvedAt: now(), evaluation: clone(e.evaluation),
        acknowledgedNoImprovement: checked.acknowledged === true });
      // Active content and resolution are one append; restart cannot observe half a promotion.
      persist(entry, resolved);
      return { ok: true, skill: projectSkill(entry, true), candidate: projectCandidate(resolved, false) };
    }
    function rejectCandidate(e) {
      e = e || {};
      if (!canWrite()) return { ok: false, error: cannotWrite().message };
      const found = candidateDecision(e);
      if (found.error) return { ok: false, error: found.error };
      const row = Object.assign({}, clone(found.row), { status: 'rejected', resolvedAt: now() });
      io.append(clone(row)); candidateRows.set(keyOf(row.agentId, row.name), row);
      return { ok: true, candidate: projectCandidate(row, false) };
    }
    /* VETO = UNDO A SILENT SAVE (COMMS). The reflection auto-saves a learned skill through write(), which makes it
       a proposal, so the veto rejects that proposal. A plain archive was a new staged write that could not see the
       reflection's draft: refused for a revision, 'no such skill' for a new skill, and the proposal stayed
       approvable. Only an active skill is archived, as the Commander, so the archive is not staged again (a pending
       retirement proposal is rejected first, then the skill is archived). Matched by skill id or name; 'no such
       skill' when neither exists, which the route treats as already undone. */
    function veto(e) {
      e = e || {};
      const aid = str(e.agentId) || 'agent';
      const target = str(e.target != null ? e.target : e.id).trim();
      const row = target ? Array.from(candidateRows.values()).find(r => r.agentId === aid && r.status === 'pending'
        && (r.skill.id === target || r.name.toLowerCase() === target.toLowerCase())) : null;
      if (row) {
        const r = rejectCandidate({ agentId: aid, candidateId: row.candidateId, candidateDigest: row.candidateDigest });
        if (!r.ok) return r;
        if (row.skill.state !== 'archived') return Object.assign({ action: 'reject' }, r);
      }
      return manage({ agentId: aid, target, action: 'archive', createdBy: 'user' });
    }
    function projectKey(root) {
      const s = str(root).trim().replace(/\\/g, '/').replace(/\/+$/, '');
      return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
    }
    function isAccessible(s, agentId, projectRoot) {
      if (s.scope === 'station') return true;
      if (s.scope === 'project') return !!projectKey(projectRoot) && projectKey(projectRoot) === projectKey(s.projectRoot);
      return s.agentId === str(agentId);
    }
    function listAccessible(agentId, options) {
      const o = options || {};
      const rows = Array.from(latest.values()).filter(s => isAccessible(s, agentId, o.projectRoot)
        && (o.includeArchived || s.state !== 'archived')).map(s => projectSkill(s, false));
      // A pending-only name is discoverable only by its owner. Its unapproved summary,
      // prerequisites and support files never enter a foreground index or tool response.
      if (o.includePending !== false) for (const row of candidateRows.values()) {
        if (row.agentId !== str(agentId) || row.status !== 'pending' || latest.has(keyOf(row.agentId, row.name))) continue;
        rows.push({ id: row.skill.id, agentId: row.agentId, name: row.name, state: 'active', scope: 'agent',
          pendingCandidate: true, candidateId: row.candidateId, guardAction: 'ask', summary: '', files: [] });
      }
      // Own skills first; inside each group mine()'s order (pinned, then most recently updated, then name), so a
      // budget-capped index or a paged skill.list drops the stale skills, not the alphabetically late ones.
      return rows.sort((a, b) => (Number(b.agentId === str(agentId)) - Number(a.agentId === str(agentId)))
        || (!!b.pinned - !!a.pinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)) || a.name.localeCompare(b.name));
    }
    function viewAccessible(agentId, target, options) {
      const o = options || {};
      let matches = listAccessible(agentId, o).filter(s => (!o.ownerAgentId || s.agentId === str(o.ownerAgentId))
        && (s.id === str(target) || s.name.toLowerCase() === str(target).toLowerCase()));
      if (!o.ownerAgentId && matches.some(s => s.agentId === str(agentId))) {
        const own = matches.filter(s => s.agentId === str(agentId));
        /* An agent's own pending-only PROPOSAL is not an active skill, so it never hides an active skill of the same
           name the agent can read (customer report f702f2f6: a worker whose background review had drafted a same-name
           proposal was told the Commander-approved station skill awaited approval). Its own ACTIVE skill still wins. */
        const ownActive = own.filter(s => !s.pendingCandidate);
        const others = matches.filter(s => s.agentId !== str(agentId) && !s.pendingCandidate);
        matches = ownActive.length ? ownActive : (others.length ? others : own);
      }
      if (matches.length !== 1) return null;   // never choose an arbitrary owner's same-name skill
      return matches[0].pendingCandidate ? matches[0] : view(matches[0].agentId, matches[0].id, o);
    }
    function share(e) {
      e = e || {};
      if (e.actor !== 'user') return { ok: false, error: 'only the Commander may change skill sharing' };
      const existing = find(e.agentId, e.target, { includeArchived: true });
      if (!existing) return { ok: false, error: 'no such owned skill' };
      if (!['agent', 'project', 'station'].includes(e.scope)) return { ok: false, error: 'choose agent, project, or station scope' };
      const root = str(e.projectRoot).trim();
      if (e.scope === 'project' && (!/^(?:[A-Za-z]:[\\/]|\/)/.test(root) || root.split(/[\\/]/).includes('..') || /[\x00-\x1f]/.test(root)))
        return { ok: false, error: 'project sharing requires an absolute project root' };
      const entry = Object.assign(clone(existing), { scope: e.scope, projectRoot: e.scope === 'project' ? root : '', updatedAt: now() });
      persist(entry);
      return { ok: true, skill: projectSkill(entry, true) };
    }
    /* A RE-APPROVED TAMPER IS ADOPTED (gate census, 2026-10-28). When the package on disk changed after review, the
       Commander's Approve releases THOSE bytes at the delivery seam (it re-digests the disk), but the record still held
       the old ones: the prompt index and skill.list (metadata only, stamp-keyed) went on listing the skill as withheld,
       and the first use after a restart re-wrote the mirror from the record, so the approved bytes were gone. Adopting
       them makes the record what was approved: its stamp is the approval's digest, so every surface agrees. Only the
       Commander, only while the disk still holds exactly the approved bytes (`digest`), verbatim (they were read and
       scanned as they are), never for a sealed install or a promoted revision (their view is the record, not the disk),
       and never past the limits a write is held to: a file over the per-file limit, too many files or a package over
       its total is refused whole (it used to be stored cut to the limit, and the mirror re-written cut).
       `check: true` runs every one of those checks and writes nothing: the allow route asks it BEFORE it saves the
       approval, so bytes the store would refuse are never approved (review r2: the route answered approved:true while
       the record kept the old bytes, and the skill went withheld again after a restart). */
    function adoptView(e) {
      e = e || {};
      if (e.actor !== 'user') return { ok: false, error: 'only the Commander may adopt a package\'s bytes' };
      if (!canWrite()) return { ok: false, error: cannotWrite().message };
      const s = find(str(e.agentId) || 'agent', e.target, { includeArchived: true });
      if (!s) return { ok: false, error: 'no such skill' };
      if (s.canonicalRevision || !packageStore || typeof packageStore.hydrate !== 'function') return { ok: false, error: 'this skill is not read from its package on disk' };
      if (s.packageDigest && (s.packageFiles || []).length && !s.packageDiverged) return { ok: false, error: 'a sealed install is read from its package record, never adopted from disk' };
      const v = view(s.agentId, s.id, { includeArchived: true, bump: false });
      if (!v || !digest || str(digest(v)) !== str(e.digest)) return { ok: false, error: 'the package on disk changed again since it was approved' };
      if (str(digest(v)) === str(s.contentDigest)) return { ok: true, adopted: false, skill: v };   // nothing on disk differs
      const w = writtenFiles(v.files || [], supportFileMax, s.files);
      if (!w.ok) return w;
      const count = Object.keys(w.files).length;
      if (count > maxFiles) return { ok: false, error: 'the package on disk holds ' + count + ' support files, over the ' + maxFiles + '-file limit' };
      if (str(v.body).length > bodyMax || str(v.setup).length > bodyMax) return { ok: false, error: 'the SKILL.md on disk is over the ' + bodyMax + '-character limit' };
      let total = Buffer.byteLength(str(v.body), 'utf8') + Buffer.byteLength(str(v.setup), 'utf8');
      for (const k of Object.keys(w.files)) total += FileBytes.byteLength(w.files[k]);
      if (total > maxPackageBytes) return { ok: false, error: 'the package on disk is ' + total + ' bytes, over the ' + maxPackageBytes + '-byte limit' };
      if (e.check === true) return { ok: true, adopted: false, wouldAdopt: true };
      const entry = clone(s);
      entry.body = str(v.body); entry.setup = str(v.setup); entry.files = w.files;
      entry.writtenBy = 'user'; entry.patchCount = (entry.patchCount || 0) + 1; entry.updatedAt = now();
      entry.packageDiverged = !!entry.packageDigest;
      persist(entry);
      return { ok: true, adopted: true, skill: projectSkill(entry, true) };
    }

    function list(agentId, opts2) {
      return mine(agentId, opts2).map(s => projectSkill(s, false));
    }
    function view(agentId, idOrName, opts2) {
      opts2 = opts2 || {};
      const s = find(agentId, idOrName, { includeArchived: !!opts2.includeArchived });
      if (!s) return null;
      let out = s;
      if (!s.canonicalRevision && packageStore && typeof packageStore.hydrate === 'function' && opts2.hydrate !== false) {
        try {
          const h = packageStore.hydrate(projectSkill(s, true));
          if (h) out = Object.assign(clone(s), {
            body: h.body != null ? h.body : s.body,
            files: normFiles(h.files || s.files, true),   // the bytes read, never cut: a view shows a disk file whole
            packagePath: h.packagePath || s.packagePath || ''
          });
        } catch (_) {}
      }
      if (opts2.bump !== false) {
        // A view counts views and freshness only. useCount means "runs that loaded this skill": the run host
        // calls markUsed ONCE per run for the skills that run actually loaded (2026-09-28; it used to call it for
        // every skill merely LISTED in the prompt index, so every indexed skill looked used on every run).
        const bumped = {
          viewCount: (s.viewCount || 0) + 1,
          lastUsedAt: now(),
          state: s.state === 'stale' ? 'active' : s.state
        };
        // RAM-only: the bump rides the next real mutation / compaction flush instead of appending a JSONL line
        // per view (unbounded growth was the whole problem). See bumpView.
        //
        // The bump carries ONLY the counters, and it carries them onto the STORED record — never onto the
        // hydrated copy. `out.body` may be the whole RENDERED SKILL.md (setup + body + support-file
        // pointers); writing that into `latest` makes the next persist — markUsed() runs on EVERY run —
        // re-render '## Setup' in front of a body that already has one, and persist() does not clamp, so
        // it grows without bound and re-stamps contentDigest (invalidating any Commander approval) every
        // single cycle.
        bumpView(Object.assign(clone(s), bumped));
        out = Object.assign(clone(out), bumped);
      }
      return projectSkill(out, true);
    }
    /* A USE IS TELEMETRY, NOT A NEW VERSION. markUsed runs at the end of every run for every skill the run loaded.
       It used to persist() the WHOLE record each time (body, support files, base64 package, a guard re-scan and a
       package rewrite), which grew skills.jsonl by megabytes a day; the log's size rotation then deleted the only
       durable copy of every skill not used recently. Now each use appends a ~200-byte usage row (applied on load,
       folded into the record by the next compaction) and updates RAM. A failed append keeps the RAM bump, which
       the next compaction flushes. The package mirror is re-written only when this process has not written it from
       the current record (writeMirror): once per skill per boot, and after a failed write.
       THE GUARD STILL SEES EVERY USE. The re-scan on use was how a new guard rule reached a skill nobody edits, so a
       use still scans the bytes under the current rules (CPU, no disk); only when the scan (verdict, findings, summary)
       or action would change, or a legacy record lacks a digest, is the whole record persisted (rare: once per rule
       change). */
    function markUsed(agentId, idOrNames) {
      if (!canWrite()) return { ok: false, count: 0, error: cannotWrite().message };
      const ids = Array.isArray(idOrNames) ? idOrNames : [idOrNames];
      let count = 0;
      for (const id of ids) {
        const s = find(agentId, id, { includeArchived: false });
        if (!s) continue;
        const entry = clone(s);
        entry.useCount = (entry.useCount || 0) + 1;
        entry.lastUsedAt = now();
        if (entry.state === 'stale') entry.state = 'active';
        if (guard && typeof guard.scanSkillRecord === 'function') {
          // the WHOLE scan, not only the verdict: a rule that adds a finding under the same verdict changes the
          // categories the gate shows the Commander (the scan is deterministic for the same bytes and rules)
          const probe = scanInto(clone(entry), projectSkill(entry, true));
          const scanOf = (x) => JSON.stringify((x && x.scan) || null);
          if (str(probe.guardAction) !== str(entry.guardAction) || scanOf(probe) !== scanOf(entry) || (digest && !entry.contentDigest)) {
            persist(entry); count++;
            continue;
          }
        }
        const row = { recordType: 'skill-usage', agentId: entry.agentId, skillName: entry.name, useCount: entry.useCount, viewCount: num(entry.viewCount), lastUsedAt: entry.lastUsedAt };
        try { io.append(row); } catch (e) { failNote('skillstore.usage.append', e); }
        const key = keyOf(entry.agentId, entry.name);
        // heal a mirror this process has not written from the current record (see writeMirror); the path rides the
        // next compaction like the counters do
        if (!mirrored.has(key)) { const dir = mirrorDir(entry); if (dir) entry.packagePath = dir; writeMirror(entry, 'skillstore.package.write'); }
        latest.set(key, entry);
        count++;
      }
      if (count) maybeCompact();
      return { ok: true, count };
    }
    /* compact — rewrite the append-only JSONL keeping ONLY the newest entry per (agentId, name). `latest`
       already holds exactly that (the boot load + every persist/bumpView collapse duplicates into it), so the
       compacted file is simply `latest`'s values, one line each. This does two jobs at once:
         1. bounds the file — months of edits/views collapse to one line per distinct skill;
         2. FLUSHES the RAM-only view/use bumps to disk (they became part of `latest` but were never appended).
       Requires an io that can atomically REPLACE the whole file (io.rewrite). Without it, compaction is a no-op
       (the bounded-read boot loader still keeps memory sane) — reported via `ok:false, reason`. Never throws:
       a compaction failure must never crash a run (the RAM mirror still answers). Returns counts for tests. */
    function compact() {
      const entries = Array.from(latest.values()).concat(Array.from(candidateRows.values())).map(e => clone(e));
      if (!io || typeof io.rewrite !== 'function') return { ok: false, reason: 'io has no rewrite', kept: entries.length };
      if (!canWrite()) return { ok: false, reason: cannotWrite().message, kept: entries.length };
      try { io.rewrite(entries); return { ok: true, kept: entries.length }; }
      catch (e) { return { ok: false, reason: (e && e.message) || 'rewrite failed', kept: entries.length }; }
    }
    function curate(agentId, opts2) {
      if (!canWrite()) return { ok: false, stale: 0, archived: 0, proposedArchives: 0, error: cannotWrite().message };
      opts2 = opts2 || {};
      const staleMs = opts2.staleMs > 0 ? opts2.staleMs : 30 * 24 * 60 * 60 * 1000;
      const archiveMs = opts2.archiveMs > 0 ? opts2.archiveMs : 90 * 24 * 60 * 60 * 1000;
      const t = opts2.now != null ? num(opts2.now) : now();
      let stale = 0, archived = 0, proposedArchives = 0;
      for (const s of mine(agentId, { includeArchived: true })) {
        if (s.pinned || s.state === 'archived') continue;
        const pending = candidateRows.get(keyOf(s.agentId, s.name));
        // Aging must not invalidate a pending replacement or repeatedly override a rejected RETIREMENT. A rejected
        // content edit says nothing about the skill's age, so it must not freeze aging. (manage reports delete as
        // action 'archive', so this covers both.)
        if (pending && pending.baseDigest === revisionDigest(s)
          && (pending.status === 'pending' || (pending.status === 'rejected' && pending.action === 'archive'))) continue;
        const base = s.lastUsedAt || s.updatedAt || s.createdAt || t;
        const age = Math.max(0, t - base);
        const entry = clone(s);
        // Only a MODEL-authored skill (the agent, a review, the curator) retires itself. A skill the Commander wrote
        // or chose to install can go stale, never auto-archive: it is theirs to retire (Hermes parity: its curator
        // only ages curator-managed skills). This matters since 2026-09-28, when lastUsedAt stopped being refreshed
        // for every skill merely listed in the index, so the aging clock now measures real loads.
        const autoArchive = (guard && typeof guard.originTier === 'function' ? guard.originTier(s) : trustSource(s.createdBy)) === 'agent-created';
        if (age >= archiveMs && autoArchive && opts.stageReviews !== false) {
          const proposed = manage({ agentId: s.agentId, target: s.id, action: 'archive', createdBy: 'background-review' });
          if (proposed.ok && proposed.pending) proposedArchives++;
          continue;
        }
        if (age >= archiveMs && autoArchive) { entry.state = 'archived'; archived++; }
        else if (age >= staleMs) { entry.state = 'stale'; stale++; }
        else continue;
        entry.updatedAt = t;
        persist(entry);
      }
      return { ok: true, stale, archived, proposedArchives };
    }

    return {
      write, manage, list, view, markUsed, curate, compact,
      // broken is not empty: a library that failed to load says so instead of listing nothing
      loadState() { return canWrite() ? { ok: true, error: null } : { ok: false, error: cannotWrite().message }; },
      candidates, candidate, pendingView, promotionBlocker, approveCandidate, rejectCandidate, veto, share, adoptView, listAccessible, viewAccessible,
      all() { return Array.from(latest.values()).map(s => projectSkill(s, true)); },
      // the old digests an approval of each record may carry -> the digest of the same bytes now (see settleLoaded)
      digestRestamps() { return restamps.map(r => Object.assign({}, r, { from: r.from.slice() })); },
      count() { return latest.size; },
      _internals: { slug, keyOf, supportPath, cleanName, normalizeEntry, bumpView, trustSource, settleCounts: () => Object.assign({}, settleCounts) }
    };
  }

  return { makeSkillStore };
});
