/* sidecar/skills/market-format.js — the StarNet Skill Market catalog format, shared by the build script
   (scripts/build-skill-catalog.mjs, which writes the catalog into website/) and the app (skills/market.js, which
   reads it). One definition so the two can never disagree about slugs, versions, digests or the file manifest.

   The index is the existing `starnet-skill-registry/v1` document (so the SKILL EXCHANGE registry reader can also
   read it) with extra fields per entry: slug, shelf, category, tags, requires, librarySlug and `files`, the exact
   manifest the app downloads. `digest` is the open-agent-skill-package/v1 digest over those files; the app refuses
   an install whose downloaded bytes do not reproduce it. Every version lives in its own folder
   (/skills/<slug>/<version>/…) and is never rewritten once published.

   Market packages are TEXT ONLY (UTF-8, no NUL bytes): SKILL.md, an optional LICENSE/NOTICE at the root and
   optional references/ files in plain text formats (marketFileAllowed — the build and the app apply the same rule).

   The index also carries a `serial` (bumped by every build that changes it; a station never accepts a lower serial
   than one it has already seen) and `revoked`, the skills the market has pulled. The pulled list is published on
   its own too (starnet-skill-revocations/v1, a few hundred bytes) so stations with market skills installed can
   check it often. Both documents are signed (skills/market-signing.js). Pure: no network, no clock. */
'use strict';

const packageFormat = require('./package-format.js');
const catalog = require('./catalog.js');

const FORMAT = 'starnet-skill-registry/v1';
const REVOKED_FORMAT = 'starnet-skill-revocations/v1';
const MARKET_NAME = 'StarNet Skill Market';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHELVES = ['originals', 'community'];
const GEAR = ['cabinet', 'dish', 'workbench', 'notebook', 'studio', 'orchestrator', 'computer'];
const ROOT_FILES = /^(?:LICENSE|NOTICE|COPYING)(?:\.(?:md|txt))?$/;
const REFERENCE_FILE = /^references\/[^/].*\.(?:md|txt|json|ya?ml|csv)$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_ENTRIES = 500;

function str(v) { return v == null ? '' : String(v); }
function list(v) { return Array.isArray(v) ? v.map(x => str(x).trim()).filter(Boolean) : []; }
function q(v) { return JSON.stringify(str(v)); }

function versionParts(v) { return str(v).split('.').map(n => parseInt(n, 10) || 0); }
// compareVersions(a, b) -> -1 | 0 | 1 on dotted numeric versions ("1.10.0" > "1.9.3")
function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// marketFileAllowed(path) -> true only for what a market package may ship: SKILL.md, a root LICENSE/NOTICE/COPYING,
// and plain-text references/ files. Never scripts, binaries or anything else, even inside references/.
function marketFileAllowed(p) {
  p = str(p);
  return packageFormat.safePath(p) === p && (p === 'SKILL.md' || ROOT_FILES.test(p) || REFERENCE_FILE.test(p));
}

// serialOf(doc) -> the document's serial, or 0 when it has none
function serialOf(doc) { return doc && Number.isSafeInteger(doc.serial) && doc.serial > 0 ? doc.serial : 0; }

/* readRevoked(list) -> clean pulled-skill rows [{ slug, digest, reason, at }]. A row with a digest pulls exactly that
   published package; a row without one pulls every version of the slug. A malformed digest drops the row rather than
   widening it to the whole slug. */
function readRevoked(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : []).slice(0, 1000)) {
    const slug = str(r && r.slug);
    if (!SLUG_RE.test(slug)) continue;
    const digest = str(r.digest);
    if (digest && !DIGEST_RE.test(digest)) continue;
    out.push({ slug, digest, reason: str(r.reason).replace(/\s+/g, ' ').trim().slice(0, 200) || 'pulled from the market', at: str(r.at).slice(0, 40) });
  }
  return out;
}
// revokedMatch(revoked, slug, digest) -> the row that pulls this package, or null
function revokedMatch(revoked, slug, digest) {
  return (revoked || []).find(r => r.slug === slug && (!r.digest || r.digest === digest)) || null;
}

/* libraryToSkillMd — a bundled StarNet recipe (sidecar/skills/library/<slug>.md, parsed by catalog.parse) as a
   standard Agent Skills SKILL.md: spec name = the slug, the display title under metadata.title. The body is the
   recipe body byte for byte, so the market copy and the bundled copy say the same thing at the same version. */
function libraryToSkillMd(recipe, opts) {
  opts = opts || {};
  const lines = ['---', 'name: ' + recipe.slug, 'description: ' + q(str(recipe.description).replace(/\s+/g, ' ').trim()),
    'license: ' + q(recipe.license || 'MIT'), 'metadata:', '  title: ' + q(recipe.name), '  category: ' + q(recipe.category || 'General'),
    '  author: ' + q(opts.author || 'StarNet')];
  if (opts.version) lines.push('  version: ' + q(opts.version));
  lines.push('---', '');
  return lines.join('\n') + '\n' + str(recipe.body).trim() + '\n';
}

/* readSkillMd — parse and check an authored market SKILL.md. Throws a sentence naming the problem. */
function readSkillMd(text, slug) {
  const raw = str(text);
  if (raw.indexOf('\u0000') >= 0) throw new Error(slug + ': SKILL.md must be text');
  const fm = catalog.parseFrontmatter(raw);
  const meta = fm.meta || {};
  const md = meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata) ? meta.metadata : {};
  if (str(meta.name) !== slug) throw new Error(slug + ': SKILL.md name must be "' + slug + '" (got "' + str(meta.name) + '")');
  const description = str(meta.description).replace(/\s+/g, ' ').trim();
  if (!description) throw new Error(slug + ': SKILL.md needs a description');
  if (description.length > 1024) throw new Error(slug + ': description is longer than 1024 characters');
  if (!str(meta.license).trim()) throw new Error(slug + ': SKILL.md needs a license');
  if (!str(fm.body).trim()) throw new Error(slug + ': SKILL.md needs a procedure below the frontmatter');
  return {
    title: str(md.title).replace(/\s+/g, ' ').trim() || slug, description, license: str(meta.license).trim(),
    category: str(md.category).trim(), author: str(md.author || meta.author).trim(), body: str(fm.body).trim()
  };
}

/* buildEntry — one catalog entry + its canonical package from source files [{ path, content }]. Enforces the
   market's own rules on top of package-format's (text only; root files limited to LICENSE/NOTICE/COPYING). */
function buildEntry(src) {
  const slug = str(src.slug);
  if (!SLUG_RE.test(slug) || slug.length > 64) throw new Error('bad slug "' + slug + '": lowercase letters, digits and single hyphens, max 64');
  if (!VERSION_RE.test(str(src.version))) throw new Error(slug + ': version must look like 1.0.0');
  if (SHELVES.indexOf(src.shelf) < 0) throw new Error(slug + ': shelf must be one of ' + SHELVES.join(', '));
  const requires = list(src.requires);
  const unknown = requires.filter(g => GEAR.indexOf(g) < 0);
  if (unknown.length) throw new Error(slug + ': unknown gear ' + unknown.join(', '));
  const files = (src.files || []).map(f => {
    const p = str(f.path);
    if (str(f.content).indexOf('\u0000') >= 0) throw new Error(slug + ': ' + p + ' is not text; market packages are text only');
    if (!marketFileAllowed(p)) throw new Error(slug + ': ' + p + ' is not allowed (SKILL.md, LICENSE/NOTICE, and .md/.txt/.json/.yaml/.csv files under references/ only)');
    return { path: p, content: str(f.content) };
  });
  const main = files.find(f => f.path === 'SKILL.md');
  if (!main) throw new Error(slug + ': missing SKILL.md');
  const doc = readSkillMd(main.content, slug);
  if (src.shelf === 'community') {
    if (!files.some(f => ROOT_FILES.test(f.path) && /^(LICENSE|COPYING)/.test(f.path))) throw new Error(slug + ': a community skill must ship its LICENSE text');
    // its source is either an upstream repo it was adapted from, or the reviewed upload it came from (account.starnetos.com
    // Skills tab, pulled by scripts/pull-skill-submissions.mjs): the submission id + the author's owner key
    const sub = src.submission;
    const uploaded = !!(sub && /^sk_[A-Za-z0-9_-]{6,40}$/.test(str(sub.id)) && /^[0-9a-f]{24}$/.test(str(sub.owner)));
    if (!uploaded && (!src.upstream || !/^https:\/\//.test(str(src.upstream.url)) || !str(src.upstream.commit))) throw new Error(slug + ': a community skill must name its upstream url and commit, or the reviewed submission it was uploaded as');
  }
  const pkg = packageFormat.canonicalize(files, { maxFileBytes: 256000 });
  const entry = {
    slug, name: doc.title, description: doc.description.slice(0, 280), version: str(src.version),
    author: list(src.authors).join(', ') || doc.author || 'StarNet', license: str(src.license || doc.license),
    shelf: src.shelf, category: str(src.category || doc.category || 'General'), tags: list(src.tags).slice(0, 8), requires,
    librarySlug: src.librarySlug ? str(src.librarySlug) : '',
    sourceUrl: '/skills/' + slug + '/' + src.version + '/SKILL.md',
    digest: pkg.digest, bytes: pkg.bytes,
    files: pkg.files.map(f => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))
  };
  if (src.upstream) entry.upstream = { url: str(src.upstream.url), commit: str(src.upstream.commit), license: str(src.upstream.license || entry.license) };
  // shared by a StarNet user through the upload page (read and approved before it was published); additive, older apps ignore it
  if (src.shelf === 'community' && src.submission && !src.upstream) entry.uploaded = true;
  return { entry, pkg };
}

// catalogDocument(entries, { serial, revoked }) -> the index document, in a stable order (shelf, then display name)
function catalogDocument(entries, opts) {
  opts = opts || {};
  const sorted = entries.slice().sort((a, b) => (SHELVES.indexOf(a.shelf) - SHELVES.indexOf(b.shelf)) || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  return { format: FORMAT, name: MARKET_NAME, serial: opts.serial || 1, skills: sorted, revoked: readRevoked(opts.revoked) };
}
// revocationDocument({ serial, revoked }) -> the standalone pulled-skills list stations check between catalog reads
function revocationDocument(opts) {
  opts = opts || {};
  return { format: REVOKED_FORMAT, serial: opts.serial || 1, revoked: readRevoked(opts.revoked) };
}
/* readRevocations — the app-side reader for the pulled-skills list. */
function readRevocations(doc) {
  if (!doc || doc.format !== REVOKED_FORMAT || !Array.isArray(doc.revoked) || !serialOf(doc)) throw new Error('the skill market returned an unsupported pulled-skills list');
  return { serial: serialOf(doc), revoked: readRevoked(doc.revoked) };
}

/* readCatalog — the app-side reader: validates an index document and returns clean entries. Anything malformed is
   dropped (with the reason), never half-trusted: an entry that lists a file the market does not allow, or one the
   market has pulled, is never offered. */
function readCatalog(doc) {
  if (!doc || doc.format !== FORMAT || !Array.isArray(doc.skills) || !serialOf(doc)) throw new Error('the skill market returned an unsupported catalog');
  const revoked = readRevoked(doc.revoked);
  const entries = [], rejected = [];
  for (const row of doc.skills.slice(0, MAX_ENTRIES)) {
    const slug = str(row && row.slug);
    const files = Array.isArray(row && row.files) ? row.files : [];
    const why = !SLUG_RE.test(slug) ? 'bad slug'
      : !VERSION_RE.test(str(row.version)) ? 'bad version'
      : !/^[0-9a-f]{64}$/.test(str(row.digest)) ? 'bad digest'
      : !files.length || !files.some(f => f && f.path === 'SKILL.md') ? 'no SKILL.md in its manifest'
      : files.some(f => !f || !DIGEST_RE.test(str(f.sha256)) || !(packageFormat.safePath(f.path))) ? 'bad file manifest'
      : files.some(f => !marketFileAllowed(f.path)) ? 'lists a file the market does not allow'
      : revokedMatch(revoked, slug, str(row.digest)) ? 'pulled from the market'
      : '';
    if (why) { rejected.push({ slug, why }); continue; }
    entries.push({
      slug, name: str(row.name).slice(0, 80) || slug, description: str(row.description).slice(0, 280), version: str(row.version),
      author: str(row.author).slice(0, 160), license: str(row.license).slice(0, 80),
      shelf: SHELVES.indexOf(row.shelf) >= 0 ? row.shelf : 'community', category: str(row.category).slice(0, 40) || 'General',
      tags: list(row.tags).slice(0, 8), requires: list(row.requires).filter(g => GEAR.indexOf(g) >= 0),
      librarySlug: SLUG_RE.test(str(row.librarySlug)) ? str(row.librarySlug) : '',
      digest: str(row.digest), bytes: Number(row.bytes) || 0,
      files: files.map(f => ({ path: str(f.path), sha256: str(f.sha256), bytes: Number(f.bytes) || 0 })),
      upstream: row.upstream && /^https:\/\//.test(str(row.upstream.url)) ? { url: str(row.upstream.url).slice(0, 400), license: str(row.upstream.license).slice(0, 80) } : null
    });
  }
  return { name: str(doc.name) || MARKET_NAME, serial: serialOf(doc), entries, rejected, revoked };
}

// revokedUrl(indexUrl) -> the pulled-skills list published next to the index
function revokedUrl(indexUrl) { return new URL('starnet-skills-revoked.json', indexUrl).href; }

// fileUrl(indexUrl, entry, path) -> the absolute URL of one package file
//   Files live in skills/ BESIDE the site the index is published on: for https://host/.well-known/starnet-skills.json
//   that is https://host/skills/…, and a catalog hosted under a subpath (https://host/market/.well-known/…) resolves
//   to https://host/market/skills/… instead of the site root.
function fileUrl(indexUrl, entry, path) {
  const u = new URL(indexUrl);
  const at = u.pathname.lastIndexOf('/.well-known/');
  const base = new URL(at >= 0 ? u.pathname.slice(0, at + 1) : './', u);
  return new URL('skills/' + entry.slug + '/' + entry.version + '/' + path.split('/').map(encodeURIComponent).join('/'), base).href;
}

module.exports = {
  FORMAT, REVOKED_FORMAT, MARKET_NAME, SLUG_RE, VERSION_RE, SHELVES, GEAR, compareVersions, marketFileAllowed, serialOf,
  libraryToSkillMd, readSkillMd, buildEntry, catalogDocument, revocationDocument, readCatalog, readRevocations,
  readRevoked, revokedMatch, revokedUrl, fileUrl
};
