/* node test/skill-market-catalog.test.js — the published Skill Market catalog is honest (2026-09-29).

   The catalog in website/ is what starnetos.com serves and what every station downloads. This pins:
     - it is exactly what the sources build (scripts/build-skill-catalog.mjs --check)
     - every bundled original's published digest equals its bundled text, so a fresh station reads BUILT IN, not
       UPDATE, for all of them
     - every file on disk matches the sha256 its entry pins, and the index fits the app's 256 KB fetch cap
     - every community skill ships its LICENSE and names its upstream commit; NOTICE.md credits every skill
     - the index and the pulled list are SIGNED: each .sig verifies over the committed bytes with a key the app ships,
       both carry the same serial and the same pulled rows, git never rewrites their bytes (.gitattributes), and no
       private key is anywhere in the repo */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const market = require('../sidecar/skills/market-format.js');
const packageFormat = require('../sidecar/skills/package-format.js');
const catalog = require('../sidecar/skills/catalog.js');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'website', '.well-known', 'starnet-skills.json');

const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-skill-catalog.mjs'), '--check'], { encoding: 'utf8' });
A.eq(check.status, 0, 'the committed catalog is exactly what the sources build: ' + (check.stderr || check.stdout).trim().slice(0, 400));

const raw = fs.readFileSync(INDEX, 'utf8');
A.ok(Buffer.byteLength(raw) < 256000, 'the index fits the app\'s 256 KB fetch cap (' + Buffer.byteLength(raw) + ' bytes)');
const read = market.readCatalog(JSON.parse(raw));
A.eq(read.rejected, [], 'the app accepts every entry');
const entries = read.entries;
A.ok(entries.length >= 70, 'the launch catalog has at least 70 skills (' + entries.length + ')');
A.eq(entries[0].shelf, 'originals', 'StarNet Originals come first');

const library = new Map(catalog.loadDir(path.join(ROOT, 'sidecar', 'skills', 'library'), fs, path).map(r => [r.slug, r]));
let bundled = 0, filesOk = true, badFile = '';
for (const e of entries) {
  if (e.librarySlug) {
    bundled++;
    const recipe = library.get(e.librarySlug);
    const d = recipe ? packageFormat.canonicalize([{ path: 'SKILL.md', content: market.libraryToSkillMd(recipe, { version: e.version }) }]).digest : '';
    if (d !== e.digest) A.ok(false, e.slug + ': the bundled copy no longer matches its published version; bump the `version:` line in sidecar/skills/library/' + e.librarySlug + '.md and rebuild');
    if (recipe && recipe.version !== e.version) A.ok(false, e.slug + ': the bundled recipe says version ' + (recipe.version || '(none)') + ' but the catalog publishes ' + e.version);
  }
  for (const f of e.files) {
    const p = path.join(ROOT, 'website', 'skills', e.slug, e.version, ...f.path.split('/'));
    const ok = fs.existsSync(p) && crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') === f.sha256;
    if (!ok && filesOk) { filesOk = false; badFile = e.slug + '/' + f.path; }
  }
}
A.ok(bundled >= 46, 'all our bundled originals are published (' + bundled + ')');
A.ok(filesOk, 'every published file matches the sha256 its entry pins' + (badFile ? ' (first mismatch: ' + badFile + ')' : ''));

const community = entries.filter(e => e.shelf === 'community');
A.ok(community.length >= 12, 'the community shelf is stocked (' + community.length + ')');
A.ok(community.every(e => e.files.some(f => /^(LICENSE|COPYING)/.test(f.path))), 'every community skill ships its license text');
// an adapted pick names its upstream; a skill a StarNet user shared is marked uploaded and carries its submission
const rawBySlug = new Map(JSON.parse(raw).skills.map(s => [s.slug, s]));
const sourceless = community.filter(e => !(e.upstream && /^https:\/\//.test(e.upstream.url))).map(e => e.slug)
  .filter(slug => !(rawBySlug.get(slug).uploaded === true && JSON.parse(fs.readFileSync(path.join(ROOT, 'skills-catalog', 'skills', slug, 'skill.json'), 'utf8')).submission));
A.eq(sourceless, [], 'every community skill names its upstream, or is a reviewed upload with its submission on record');
const notice = fs.readFileSync(path.join(ROOT, 'NOTICE.md'), 'utf8');
const uncredited = entries.filter(e => notice.indexOf('`' + e.slug + '`') < 0).map(e => e.slug);
A.eq(uncredited, [], 'NOTICE.md credits every skill in the catalog');

// ---- downloads: every skill ships a .zip (a standard Agent Skills folder) pinned by sha256 in the signed index ----
(async () => {
  const { readZipStore } = await import('../scripts/lib/zip-store.mjs');
  let zipsOk = true, why = '';
  for (const e of JSON.parse(raw).skills) {
    const d = e.download;
    const file = d && path.join(ROOT, 'website', 'skills', e.slug, e.version, d.path);
    if (!d || d.path !== e.slug + '-' + e.version + '.zip' || !fs.existsSync(file)) { zipsOk = false; why = why || e.slug + ': no download'; continue; }
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== d.sha256 || bytes.length !== d.bytes) { zipsOk = false; why = why || e.slug + ': zip hash/size'; continue; }
    const inside = readZipStore(bytes).map(x => ({ p: x.name, h: crypto.createHash('sha256').update(x.data).digest('hex') })).sort((a, b) => a.p.localeCompare(b.p));
    const want = e.files.map(f => ({ p: e.slug + '/' + f.path, h: f.sha256 })).sort((a, b) => a.p.localeCompare(b.p));
    if (JSON.stringify(inside) !== JSON.stringify(want)) { zipsOk = false; why = why || e.slug + ': zip contents'; }
  }
  A.ok(zipsOk, 'every skill has a download .zip whose bytes match the signed index and whose files are exactly the package' + (why ? ' (first problem: ' + why + ')' : ''));
  A.report('skill-market-catalog.test');
})().catch(e => { console.log('FAIL: skill-market-catalog.test threw - ' + (e && e.stack || e)); process.exit(1); });

// ---- signatures ----
const signing = require('../sidecar/skills/market-signing.js');
const REVOKED = path.join(ROOT, 'website', '.well-known', 'starnet-skills-revoked.json');
const signer = (file) => { try { return signing.verify(fs.readFileSync(file), fs.readFileSync(file + '.sig', 'utf8')); } catch (e) { return 'FAILED: ' + e.message; } };
A.ok(signing.TRUSTED_KEYS.some(k => k.id === signer(INDEX)), 'the index signature verifies with a key the app ships (' + signer(INDEX) + ')');
A.ok(signing.TRUSTED_KEYS.some(k => k.id === signer(REVOKED)), 'the pulled-list signature verifies with a key the app ships (' + signer(REVOKED) + ')');
const index = JSON.parse(raw);
const revokedDoc = market.readRevocations(JSON.parse(fs.readFileSync(REVOKED, 'utf8')));
A.ok(read.serial >= 1 && revokedDoc.serial === read.serial, 'the index and the pulled list carry the same serial (' + read.serial + ')');
A.eq(revokedDoc.revoked, market.readRevoked(index.revoked), 'and the same pulled rows');
A.eq(new Set(signing.TRUSTED_KEYS.map(k => k.publicKey)).size, signing.TRUSTED_KEYS.length, 'the app trusts distinct keys (a working key and a separate backup)');
const attr = spawnSync('git', ['check-attr', 'text', 'website/.well-known/starnet-skills.json', 'website/.well-known/starnet-skills.json.sig', 'website/skills/grill-me/1.0.0/SKILL.md'], { cwd: ROOT, encoding: 'utf8' });
A.eq((attr.stdout.match(/: text: unset/g) || []).length, 3, 'git never rewrites the signed and sha256-pinned files (.gitattributes -text)');
// a real PEM block starts with this header on a line of its own (other files only mention it inside redaction patterns)
const keyLeak = spawnSync('git', ['grep', '-l', '-I', '-E', '-e', '^-----BEGIN [A-Z ]*PRIVATE KEY-----$', '--', 'website', 'skills-catalog', 'sidecar/skills', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
A.ok(keyLeak.status === 0 || keyLeak.status === 1, 'the private-key scan ran (git grep exit ' + keyLeak.status + ')');
A.eq(keyLeak.stdout.trim(), '', 'no private key is committed anywhere the market touches');
// (the report runs at the end of the async download check above, after every synchronous assertion here)
