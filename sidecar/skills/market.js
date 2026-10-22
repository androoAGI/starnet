/* sidecar/skills/market.js — the Skill Market client: browse the Agent OS catalog, install a skill into the station
   library, keep it honest.

   The catalog (skills/market-format.js) is a public index on starnetos.com, fetched when the Commander opens the
   market. TRUST: the index and the pulled-skills list are both signed (skills/market-signing.js); a document whose
   signature does not verify with a key this app trusts, or whose serial is lower than the highest this station has
   accepted from that catalog (or, for the official catalog, than the floor this app build ships), is refused whole
   ("not trusted") — so neither a changed website nor a replayed old catalog can change what installs. The market can
   PULL a skill: its signed `revoked` list names it, and any installed copy is switched off (kept on disk, left out
   of the library, shown as PULLED with the reason) until a newer signed list stops naming it or the Commander
   removes it. The accepted pulled rows are persisted, so a stale cache, an uninstall or a restart never forgets a
   pull. checkRevocations() reads the small pulled list on its own; the sidecar calls it on a timer, only while at
   least one market skill is installed. Installing:
     1. downloads exactly the files the catalog entry lists (market-format.marketFileAllowed: text files only), over
        the same HTTPS-only, SSRF-checked fetcher the skill exchange uses;
     2. checks every file's sha256 AND that the files reproduce the entry's package digest — anything else is refused
        ("doesn't match the catalog"), so a changed file on the server or in transit never installs;
     3. scans the skill (description included) with the guard at the 'trusted' tier (Andrew 2026-09-29, D2: a
        digest-pinned catalog skill we reviewed installs in one click; a dangerous finding is still refused);
     4. swaps it into <WORKSPACES>/skill-market/<slug>/ (the old copy is only deleted once the new one is recorded)
        and records the digest of every file.
   Installed market skills join the station SKILL LIBRARY (D3) through recipes(); a market copy of a bundled original
   replaces the bundled copy for this station when it is at least as new (D5; bundled recipes carry `version:`).
   recipes() re-hashes the files on disk and leaves out any skill whose bytes no longer match what was installed.

   Dependencies are injected (fetchDocument, fs, path, loadJson/saveJson, guard, now) so this is testable without a
   network or a real save. */
'use strict';

const crypto = require('node:crypto');
const packageFormat = require('./package-format.js');
const marketFormat = require('./market-format.js');
const signing = require('./market-signing.js');
const catalog = require('./catalog.js');
const { note: failNote } = require('../failopen.js');   // a cleanup step that fails stays visible, never silent

const DEFAULT_CATALOG_URL = 'https://starnetos.com/.well-known/starnet-skills.json';
const CACHE_MS = 5 * 60 * 1000;
const REFERENCE_CAP = 60000;       // references ride inline in the recipe body, bounded
const INDEX_MAX_BYTES = 2000000;   // the catalog index (~1 KB per skill); SKILL.md files keep the fetcher's 256 KB cap

function str(v) { return v == null ? '' : String(v); }
function sha256(text) { return crypto.createHash('sha256').update(Buffer.from(str(text), 'utf8')).digest('hex'); }

function makeSkillMarket(deps) {
  deps = deps || {};
  const fetchDocument = deps.fetchDocument;
  const fs = deps.fs, path = deps.path;
  const root = deps.root;
  const guard = deps.guard || null;
  const now = typeof deps.now === 'function' ? deps.now : () => 0;
  const catalogUrl = typeof deps.catalogUrl === 'function' ? deps.catalogUrl : () => DEFAULT_CATALOG_URL;
  const loadJson = deps.loadJson, saveJson = deps.saveJson;
  const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};
  const trustedKeys = Array.isArray(deps.trustedKeys) && deps.trustedKeys.length ? deps.trustedKeys : signing.TRUSTED_KEYS;
  // the minimum serial this APP BUILD accepts from the official catalog (market-floor.json, pinned when the catalog is
  // deployed): a fresh station can't be fed a signed catalog older than the one live when its app was built
  const floorSerial = Number.isSafeInteger(deps.floorSerial) && deps.floorSerial > 0 ? deps.floorSerial : 0;
  const STATE = path.join(root, 'installed.json');
  let cached = null;       // { url, doc, fetchedAt }
  let recipeCache = null;  // [{...recipe}] or null
  let maskCache = null;    // { bundled, slugs:Set } — built-in recipes masked by a pull (maskedBundled)
  let tampered = new Set();

  function state() {
    let s = null;
    try { s = loadJson(STATE); } catch (_) { s = null; }
    return (s && s.installed && typeof s.installed === 'object') ? s : { v: 1, installed: {} };
  }
  function saveState(s) {
    fs.mkdirSync(root, { recursive: true });   // the first save can be a catalog read (its serial), before any install
    saveJson(STATE, s);
    const back = loadJson(STATE);
    if (JSON.stringify(back && back.installed) !== JSON.stringify(s.installed) || JSON.stringify(back && back.catalogs) !== JSON.stringify(s.catalogs)) throw new Error('the install record did not read back');
  }

  /* What this station has accepted from each catalog (keyed by the index URL): the newest serial and that
     document's pulled rows. Serials are per catalog, so pointing a station at a self-hosted catalog never collides
     with the official one. (A record from before per-catalog tracking kept one top-level serial for the default.) */
  function trustOf(s, indexUrl) {
    const all = s.catalogs && typeof s.catalogs === 'object' ? s.catalogs : {};
    const t = all[indexUrl] || {};
    const legacy = indexUrl === DEFAULT_CATALOG_URL ? marketFormat.serialOf(s) : 0;
    return { serial: Math.max(marketFormat.serialOf(t), legacy), revoked: marketFormat.readRevoked(t.revoked) };
  }
  function minSerial(s, indexUrl) { return Math.max(trustOf(s, indexUrl).serial, indexUrl === DEFAULT_CATALOG_URL ? floorSerial : 0); }

  /* fetchSigned(url, what, indexUrl) -> the parsed document at url, only if its detached signature verifies over the
     exact bytes received and its serial is not lower than this station (or this app build) has already accepted. */
  async function fetchSigned(url, what, indexUrl, fetchOpts) {
    if (typeof fetchDocument !== 'function') throw new Error('skill market fetching is unavailable');
    const got = await fetchDocument(url, fetchOpts);
    let sig;
    try { sig = await fetchDocument(signing.sigUrl(url)); } catch (e) {
      // a signature we could not DOWNLOAD is a network problem, not a refused catalog; either way nothing is trusted
      throw new Error('could not download the skill market ' + what + '\'s signature (' + ((e && e.message) || 'no answer') + ')');
    }
    try { signing.verify(Buffer.from(str(got && got.text), 'utf8'), sig && sig.text, trustedKeys); } catch (e) {
      throw new Error('the skill market ' + what + ' was not trusted: ' + e.message);
    }
    let doc; try { doc = JSON.parse(got.text); } catch (_) { throw new Error('the skill market returned invalid JSON'); }
    const serial = marketFormat.serialOf(doc);
    const least = minSerial(state(), indexUrl);
    if (serial && serial < least) throw new Error('the skill market ' + what + ' was not trusted: it is older than one this station already saw (' + serial + ' < ' + least + ')');
    return { url: got.url || url, doc };
  }

  /* applyRevocations(indexUrl, revoked, serial) -> the slugs this call newly switched off. Only a document at least as
     new as the last one accepted is applied (a slower, older fetch that finishes later is ignored), and its pulled
     rows are KEPT, so an uninstall, a stale cache or a restart never forgets a pull. A pull is sticky: only a
     document with a HIGHER serial than the one that pulled a skill can restore it. */
  function applyRevocations(indexUrl, revoked, serial) {
    const s = state();
    const known = trustOf(s, indexUrl);
    if (serial < known.serial) return [];
    let changed = false;
    if (serial !== known.serial || JSON.stringify(known.revoked) !== JSON.stringify(revoked)) {
      s.catalogs = Object.assign({}, s.catalogs, { [indexUrl]: { serial, revoked } });
      changed = true;
    }
    const newly = [];
    for (const slug of Object.keys(s.installed)) {
      const rec = s.installed[slug];
      const hit = marketFormat.revokedMatch(revoked, slug, rec.digest);
      if (hit) {
        if (!rec.pulled) newly.push(slug);
        if (!rec.pulled || rec.pulled.reason !== hit.reason || rec.pulled.serial !== serial) { rec.pulled = { reason: hit.reason, at: hit.at, serial }; changed = true; }
      } else if (rec.pulled && serial > rec.pulled.serial) {
        delete rec.pulled; changed = true;
      }
    }
    if (changed) { saveState(s); invalidate(); }
    return newly;
  }

  async function fetchCatalog(opts) {
    opts = opts || {};
    const url = str(catalogUrl()).trim();
    if (!url) throw new Error('the skill market is turned off on this station');
    // a cached catalog older than a pulled list accepted since is stale: never serve it
    const fresh = cached && cached.url === url && now() - cached.fetchedAt < CACHE_MS && cached.serial >= trustOf(state(), url).serial;
    if (!opts.force && fresh) return cached;
    const got = await fetchSigned(url, 'catalog', url, { maxBytes: INDEX_MAX_BYTES, label: 'the skill market catalog' });
    const read = marketFormat.readCatalog(got.doc);
    const pulled = applyRevocations(url, read.revoked, read.serial);
    cached = { url, name: read.name, serial: read.serial, entries: read.entries, rejected: read.rejected, revoked: read.revoked, pulled, fetchedAt: now() };
    return cached;
  }

  // checkRevocations() -> { serial, pulled: [slugs switched off now] } from the small signed pulled-skills list
  async function checkRevocations() {
    const url = str(catalogUrl()).trim();
    if (!url) return { serial: 0, pulled: [] };
    const got = await fetchSigned(marketFormat.revokedUrl(url), 'pulled-skills list', url);
    const read = marketFormat.readRevocations(got.doc);
    return { serial: read.serial, pulled: applyRevocations(url, read.revoked, read.serial) };
  }

  // the digest the bundled copy of an original WOULD have at `version` — equal to the entry's digest means the
  // station's bundled text is exactly what the market publishes, so there is nothing to update
  function bundledDigest(recipe, version) {
    try {
      return packageFormat.canonicalize([{ path: 'SKILL.md', content: marketFormat.libraryToSkillMd(recipe, { version }) }]).digest;
    } catch (_) { return ''; }
  }

  function recipeFrom(rec, files) {
    const doc = marketFormat.readSkillMd(files['SKILL.md'], rec.slug);
    let body = doc.body;
    let refBytes = 0;
    for (const p of Object.keys(files).sort()) {
      if (!/^references\//.test(p)) continue;
      const text = str(files[p]);
      if (refBytes + text.length > REFERENCE_CAP) { body += '\n\n(' + p + ' is too long to include.)'; continue; }
      refBytes += text.length;
      body += '\n\n## Reference: ' + p + '\n' + text.trim();
    }
    return {
      slug: rec.slug, name: rec.name || doc.title, description: doc.description, category: rec.category || doc.category || 'General',
      requires: (rec.requires || []).slice(), author: rec.author || doc.author, license: rec.license || doc.license,
      version: rec.version, default: false, body, market: true, shelf: rec.shelf || 'community'
    };
  }

  // installed market skills as library recipes, re-verified against the recorded file digests every time the cache
  // is rebuilt. A skill whose files changed on disk is left out and reported as tampered.
  function recipes() {
    if (recipeCache) return recipeCache;
    const s = state();
    const out = [];
    const bad = new Set();
    for (const slug of Object.keys(s.installed).sort()) {
      const rec = s.installed[slug];
      if (rec.pulled) continue;   // pulled by the market: switched off, never offered to an agent
      try {
        const files = {};
        for (const f of rec.files || []) {
          const text = fs.readFileSync(path.join(root, slug, ...f.path.split('/')), 'utf8');
          if (sha256(text) !== f.sha256) throw new Error('changed on disk');
          files[f.path] = text;
        }
        out.push(recipeFrom(rec, files));
      } catch (_) { bad.add(slug); }
    }
    tampered = bad;
    recipeCache = out;
    return out;
  }
  function invalidate() { recipeCache = null; maskCache = null; onChange(); }

  // every pulled row this station has accepted from any catalog, plus the cached catalog's
  function allPulledRows() {
    const s = state();
    const rows = [];
    for (const k of Object.keys(s.catalogs || {})) rows.push(...marketFormat.readRevoked(s.catalogs[k] && s.catalogs[k].revoked));
    return rows.concat(cached ? cached.revoked || [] : []);
  }
  /* built-in recipes whose OWN text the market has pulled (a pull of every version of the slug, or of the exact
     package the built-in text publishes as): they are masked from the library too, since the bundled copy is the
     same skill. A pull aimed only at some other version leaves the built-in copy alone. */
  function maskedBundled(bundled) {
    if (maskCache && maskCache.bundled === bundled) return maskCache.slugs;
    const rows = allPulledRows();
    const slugs = new Set();
    if (rows.length) {
      for (const r of bundled || []) {
        const mine = rows.filter(x => x.slug === r.slug);
        if (!mine.length) continue;
        if (mine.some(x => !x.digest) || (r.version && mine.some(x => x.digest === bundledDigest(r, r.version)))) slugs.add(r.slug);
      }
    }
    maskCache = { bundled, slugs };
    return slugs;
  }
  // true when an installed market copy is at least as new as the built-in recipe of the same slug
  function marketWins(marketVersion, builtIn) { return !builtIn || marketFormat.compareVersions(marketVersion, builtIn.version || '0.0.0') >= 0; }

  async function listing(opts) {
    opts = opts || {};
    const cat = await fetchCatalog({ force: !!opts.refresh });
    const s = state();
    const mine = recipes();
    const bundled = new Map((opts.bundled || []).map(r => [r.slug, r]));
    const masked = maskedBundled(opts.bundled || []);
    const placed = new Set((opts.placedTypes || []).map(String));
    const entries = cat.entries.map(e => {
      const rec = s.installed[e.slug];
      const builtIn = e.librarySlug ? bundled.get(e.librarySlug) : null;
      let status = 'available';
      if (rec) {
        status = rec.pulled ? 'pulled' : tampered.has(e.slug) ? 'tampered'
          : marketFormat.compareVersions(e.version, rec.version) > 0 ? 'update' : 'installed';
      } else if (builtIn) {
        // versions decide, not digests: the app's built-in copy at the same or a newer version is current
        status = marketFormat.compareVersions(e.version, builtIn.version || '0.0.0') > 0 ? 'update' : 'bundled';
      }
      const missingGear = e.requires.filter(g => !placed.has(g));
      return Object.assign({}, e, {
        status, installedVersion: rec ? rec.version : (builtIn ? builtIn.version || '' : ''),
        builtIn: !!builtIn, builtInVersion: builtIn ? builtIn.version || '' : '',
        // an installed market copy older than the built-in text: the built-in copy is the one agents get
        superseded: !!(rec && !rec.pulled && builtIn && !marketWins(rec.version, builtIn)),
        pulledReason: rec && rec.pulled ? rec.pulled.reason : '',
        // pulled, but the catalog lists a version that isn't: it can be updated to that one
        fixVersion: rec && rec.pulled && marketFormat.compareVersions(e.version, rec.version) > 0 ? e.version : '',
        // pulled, and the built-in copy of this original is still in use (the pull didn't cover its text)
        fallback: rec && rec.pulled && builtIn && !masked.has(e.slug) ? 'bundled' : '',
        missingGear, files: e.files.map(f => ({ path: f.path, bytes: f.bytes }))
      });
    });
    // installed skills the catalog no longer offers (a pulled skill is dropped from it) stay visible, so the
    // Commander can see why one was switched off and remove it
    const listed = new Set(entries.map(e => e.slug));
    for (const slug of Object.keys(s.installed).sort()) {
      if (listed.has(slug)) continue;
      const rec = s.installed[slug];
      const builtIn = rec.librarySlug ? bundled.get(rec.librarySlug) : null;
      entries.push({
        slug, name: rec.name || slug, description: '', version: rec.version, author: rec.author || '', license: rec.license || '',
        shelf: rec.shelf || 'community', category: rec.category || 'General', tags: [], requires: (rec.requires || []).slice(),
        librarySlug: rec.librarySlug || '', digest: rec.digest, bytes: 0, files: [], upstream: null, delisted: true,
        status: rec.pulled ? 'pulled' : tampered.has(slug) ? 'tampered' : 'installed', installedVersion: rec.version,
        builtIn: !!builtIn, builtInVersion: builtIn ? builtIn.version || '' : '',
        superseded: !!(!rec.pulled && builtIn && !marketWins(rec.version, builtIn)),
        pulledReason: rec.pulled ? rec.pulled.reason : '', fixVersion: '',
        fallback: rec.pulled && builtIn && !masked.has(slug) ? 'bundled' : '',
        missingGear: (rec.requires || []).filter(g => !placed.has(g))
      });
    }
    return { catalog: { name: cat.name, url: cat.url, serial: cat.serial, fetchedAt: cat.fetchedAt, rejected: cat.rejected.length }, entries, installedCount: mine.length };
  }

  async function install(input) {
    const slug = str(input && input.slug);
    const cat = await fetchCatalog({});
    let entry = cat.entries.find(e => e.slug === slug);
    if (!entry) { const fresh = await fetchCatalog({ force: true }); entry = fresh.entries.find(e => e.slug === slug); }
    const pulledRow = allPulledRows().find(r => r.slug === slug && (!entry || !r.digest || r.digest === entry.digest));
    if (pulledRow) throw new Error('"' + slug + '" was pulled from the skill market (' + pulledRow.reason + '), so it can\'t be installed');
    if (!entry) throw new Error('"' + slug + '" is not in the skill market');
    const files = [];
    for (const f of entry.files) {
      if (!marketFormat.marketFileAllowed(f.path)) throw new Error(f.path + ' is not a file the skill market allows, so ' + entry.name + ' was not installed');
      const got = await fetchDocument(marketFormat.fileUrl(cached.url, entry, f.path));
      const text = str(got && got.text);
      if (sha256(text) !== f.sha256) throw new Error(f.path + ' doesn\'t match the catalog, so ' + entry.name + ' was not installed');
      if (text.indexOf('\u0000') >= 0) throw new Error(f.path + ' is not text, so ' + entry.name + ' was not installed');
      files.push({ path: f.path, content: text });
    }
    const pkg = packageFormat.canonicalize(files);
    if (pkg.digest !== entry.digest) throw new Error(entry.name + ' doesn\'t match the catalog\'s pinned digest, so it was not installed');
    const byPath = {}; for (const f of files) byPath[f.path] = f.content;
    const doc = marketFormat.readSkillMd(byPath['SKILL.md'], slug);
    let verdict = 'safe';
    if (guard && typeof guard.scanSkillRecord === 'function') {
      // the description is scanned too: it reaches every agent through the skill index, not just the body
      const scan = guard.scanSkillRecord({ name: slug, body: doc.description + '\n\n' + doc.body, files: files.filter(f => f.path !== 'SKILL.md') }, { source: 'trusted' });
      verdict = scan.verdict;
      const action = typeof guard.actionFor === 'function' ? guard.actionFor({ createdBy: 'trusted' }, scan.verdict) : (scan.verdict === 'dangerous' ? 'block' : 'allow');
      if (action === 'block') throw new Error('the skill guard found dangerous instructions in ' + entry.name + ', so it was not installed');
    }
    // write to a staging folder, then swap it in: the old copy is moved aside first and only deleted once the new one
    // and its record are in place, so a failed rename (antivirus, an indexer holding a file) or a failed save puts
    // the working copy back instead of leaving nothing installed
    const dir = path.join(root, slug);
    const staging = path.join(root, '.staging-' + slug);
    const previous = path.join(root, '.previous-' + slug);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(previous, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(staging, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, 'utf8');
    }
    const hadCopy = fs.existsSync(dir);
    const putBack = () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { failNote('skill-market.swap.clear', e); }
      if (hadCopy) { try { fs.renameSync(previous, dir); } catch (e) { failNote('skill-market.swap.restore', e); } }
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { failNote('skill-market.swap.staging', e); }
    };
    if (hadCopy) fs.renameSync(dir, previous);   // throws before anything changed if the old copy is locked
    const s = state();
    const prior = s.installed[slug];
    try {
      fs.renameSync(staging, dir);
      s.installed[slug] = {
        slug, version: entry.version, digest: entry.digest, name: entry.name, category: entry.category, requires: entry.requires,
        license: entry.license, author: entry.author, shelf: entry.shelf, librarySlug: entry.librarySlug,
        files: files.map(f => ({ path: f.path, sha256: sha256(f.content) })), verdict, installedAt: now(), source: cached.url
      };
      saveState(s);
    } catch (e) {
      putBack();
      throw new Error('could not put ' + entry.name + ' in place (' + ((e && e.message) || 'write failed') + ')' + (prior ? '; the copy you had is unchanged' : ''));
    }
    try { fs.rmSync(previous, { recursive: true, force: true }); } catch (e) { failNote('skill-market.swap.previous', e); }   // a leftover .previous- folder is harmless; the next install clears it
    invalidate();
    return { ok: true, action: prior ? 'update' : 'install', slug, name: entry.name, version: entry.version, verdict };
  }

  function uninstall(input) {
    const slug = str(input && input.slug);
    const s = state();
    // own keys only: "__proto__" or "constructor" are truthy on any object and read as installed (sweep 10-02)
    if (!Object.prototype.hasOwnProperty.call(s.installed, slug) || !s.installed[slug]) throw new Error('"' + slug + '" is not installed from the market');
    delete s.installed[slug];
    saveState(s);
    fs.rmSync(path.join(root, slug), { recursive: true, force: true });
    invalidate();
    return { ok: true, slug };
  }

  /* mergeLibrary(bundled) -> the station library: bundled recipes, with an installed market copy replacing the bundled
     recipe of the same slug when it is at least as new (an app update that ships newer built-in text wins over an
     older market copy), built-in recipes whose own text the market pulled left out, then the market-only skills. */
  function mergeLibrary(bundled) {
    const market = recipes();
    const masked = maskedBundled(bundled);
    if (!market.length && !masked.size) return bundled;
    const bySlug = new Map(market.map(r => [r.slug, r]));
    const merged = [];
    for (const r of bundled || []) {
      const m = bySlug.get(r.slug);
      if (m && marketWins(m.version, r)) merged.push(m);
      else if (!masked.has(r.slug)) merged.push(r);
    }
    const have = new Set((bundled || []).map(r => r.slug));
    for (const r of market) if (!have.has(r.slug)) merged.push(r);
    merged.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return merged;
  }

  return { fetchCatalog, checkRevocations, listing, install, uninstall, recipes, mergeLibrary, installed: () => state().installed, _invalidate: invalidate };
}

module.exports = { makeSkillMarket, DEFAULT_CATALOG_URL };
