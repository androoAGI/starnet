#!/usr/bin/env node
/* scripts/pull-skill-submissions.mjs — bring APPROVED Skill Market uploads into the catalog (2026-10-06).

   Authors upload on account.starnetos.com (ACCOUNT › SKILLS); the operator approves or sends each back in
   /admin/skills. Approving publishes nothing: the catalog is signed on this PC, so approved skills come here.

     node scripts/pull-skill-submissions.mjs              pull every approved upload into skills-catalog/skills/<slug>/,
                                                          credit it in NOTICE.md, then build + sign the catalog
     node scripts/pull-skill-submissions.mjs --dry-run    show what would be pulled; write nothing
     node scripts/pull-skill-submissions.mjs --mark-live  AFTER the website deploy: tell the cloud which uploads the
                                                          LIVE catalog now lists, so their authors see LIVE

   Then commit skills-catalog/, NOTICE.md and website/ (the build output), deploy the website (website-deploy, see
   docs/SKILL_MARKET_UPLOADS.md), run --mark-live, and `build-skill-catalog.mjs --pin-floor` as usual.

   Refused, never overwritten: a name a StarNet Original or an adapted community pick already uses, and a name another
   author's upload holds (the cloud's owner key must match the folder's). A package the skill guard rates dangerous
   is skipped and reported; nothing is written for it. An update to an author's own skill bumps its minor version
   (published versions are immutable).

   Config: SKILL_REVIEW_TOKEN (or the file ~/.starnet-keys/skill-review.token), STARNET_CLOUD_URL
   (default https://account.starnetos.com), STARNET_SKILL_MARKET_URL (default the live catalog on starnetos.com). */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const market = require(join(ROOT, 'sidecar/skills/market-format.js'));
const catalog = require(join(ROOT, 'sidecar/skills/catalog.js'));
const guard = require(join(ROOT, 'sidecar/skills/guard.js'));

const CLOUD = String(process.env.STARNET_CLOUD_URL || 'https://account.starnetos.com').replace(/\/+$/, '');
const LIVE_INDEX = process.env.STARNET_SKILL_MARKET_URL || 'https://starnetos.com/.well-known/starnet-skills.json';
const TOKEN_FILE = join(homedir(), '.starnet-keys', 'skill-review.token');
const CATEGORIES = ['Communication', 'Creative', 'Engineering', 'Marketing', 'Planning', 'Productivity', 'Research', 'Writing'];
const LICENSES = ['MIT', 'CC-BY-4.0'];
const NOTICE_HEAD = '### Shared by StarNet users';

const str = (v) => (v == null ? '' : String(v));
const sha = (s) => createHash('sha256').update(str(s), 'utf8').digest('hex');
// the cloud's package digest (src/skillsubs.js): sha256 over sorted "path\0sha256(content)" lines
export const packageDigest = (files) => sha(files.map((f) => f.path + '\u0000' + sha(f.content)).sort().join('\n'));

function bumpMinor(v) { const [a, b] = str(v).split('.').map((n) => parseInt(n, 10) || 0); return a + '.' + (b + 1) + '.0'; }
// a credit as it may appear in markdown: plain text only (the cloud already refuses markup; this is the second lock)
export function plainCredit(s) { return str(s).replace(/[<>[\]()|`{}\\*_#\r\n]/g, '').replace(/https?:\/*|www\./gi, '').replace(/\s+/g, ' ').trim().slice(0, 60); }

/**
 * planPull(submissions, ctx) -> { pulls: [{ sub, slug, version, meta, files, update }], skipped: [{ id, slug, why }] }
 *   ctx: { librarySlugs: Set, readMeta(slug) -> skill.json object | null }
 * Pure: decides, never writes. Every refusal says why, for the operator.
 */
export function planPull(submissions, ctx) {
  const pulls = [], skipped = [], seen = new Set();
  for (const s of submissions || []) {
    const slug = str(s && s.slug);
    const skip = (why) => skipped.push({ id: str(s && s.id), slug, why });
    if (!market.SLUG_RE.test(slug) || slug.length > 64) { skip('bad name'); continue; }
    if (seen.has(slug)) { skip('two approved uploads of the same name in one pull; pull again after this one is live'); continue; }
    if (!/^sk_[A-Za-z0-9_-]{6,40}$/.test(str(s.id)) || !/^[0-9a-f]{24}$/.test(str(s.owner))) { skip('the cloud sent no submission id / owner key'); continue; }
    if (!CATEGORIES.includes(s.category) || !LICENSES.includes(s.license)) { skip('unknown category or license'); continue; }
    const files = Array.isArray(s.files) ? s.files.map((f) => ({ path: str(f && f.path), content: str(f && f.content) })) : [];
    if (!files.some((f) => f.path === 'SKILL.md') || !files.some((f) => f.path === 'LICENSE')) { skip('the package has no SKILL.md or LICENSE'); continue; }
    const bad = files.find((f) => !market.marketFileAllowed(f.path) || f.path.indexOf('..') >= 0 || f.content.indexOf('\u0000') >= 0);
    if (bad) { skip(bad.path + ' is not a file the market allows'); continue; }
    if (packageDigest(files) !== str(s.digest)) { skip('the package does not match the digest the reviewer approved'); continue; }
    if (ctx.librarySlugs.has(slug)) { skip('a StarNet Original already uses this name'); continue; }
    const prior = ctx.readMeta(slug);
    if (prior && !(prior.submission && prior.submission.owner === s.owner)) {
      skip(prior.submission ? 'another author\'s upload already holds this name' : 'a skill StarNet publishes already uses this name');
      continue;
    }
    // the authoritative scan: the same guard and tier the catalog build applies (a dangerous package fails the build)
    const main = files.find((f) => f.path === 'SKILL.md');
    const scan = guard.scanSkillRecord({ name: slug, body: catalog.parseFrontmatter(main.content).body, files: files.filter((f) => f.path !== 'SKILL.md') }, { source: 'trusted' });
    if (guard.actionFor({ createdBy: 'trusted' }, scan.verdict) === 'block') {
      const cats = [...new Set(scan.findings.filter((f) => f.severity === 'high' || f.severity === 'critical').map((f) => f.category + ':' + f.patternId))];
      skip('the skill guard rates it dangerous (' + cats.join(', ') + '); not pulled');
      continue;
    }
    const version = prior ? bumpMinor(prior.version) : '1.0.0';
    const credit = plainCredit(s.credit) || 'StarNet user';
    const meta = {
      slug, version, shelf: 'community', category: s.category,
      tags: [s.category.toLowerCase(), 'shared'], requires: [], license: s.license, authors: [credit],
      submission: { id: s.id, owner: s.owner, digest: s.digest }
    };
    // the build's own rules (slug, files, frontmatter name == slug, license, procedure) before anything is written
    try { market.buildEntry(Object.assign({}, meta, { files })); } catch (e) { skip(str(e && e.message)); continue; }
    seen.add(slug);
    pulls.push({ sub: s, slug, version, meta, files, update: !!prior, credit });
  }
  return { pulls, skipped };
}

// NOTICE.md keeps a credits row per uploaded skill under its own heading inside "## Skill Market"
export function creditNotice(text, rows) {
  const lines = str(text).split('\n');
  let at = lines.indexOf(NOTICE_HEAD);
  if (at < 0) {
    const next = lines.findIndex((l, i) => i > lines.indexOf('## Skill Market (skills-catalog/)') && /^## /.test(l));
    if (lines.indexOf('## Skill Market (skills-catalog/)') < 0 || next < 0) throw new Error('NOTICE.md has no "## Skill Market (skills-catalog/)" section to credit uploads in');
    lines.splice(next, 0, NOTICE_HEAD, '',
      'Skills StarNet users shared through the Skill Market upload page (account.starnetos.com › ACCOUNT › SKILLS), each read and',
      'approved before it was published. Each package ships its author\'s LICENSE.', '',
      '| Skill | Author | License |', '| --- | --- | --- |', '');
    at = lines.indexOf(NOTICE_HEAD);
  }
  let end = at + 1;
  while (end < lines.length && !/^#{2,3} /.test(lines[end])) end++;
  const table = lines.slice(at, end);
  for (const r of rows) {
    const row = '| `' + r.slug + '` | ' + plainCredit(r.credit) + ' | ' + r.license + ' |';
    const i = table.findIndex((l) => l.startsWith('| `' + r.slug + '` |'));
    if (i >= 0) table[i] = row;
    else {
      let last = table.length - 1;
      while (last > 0 && !table[last].startsWith('|')) last--;
      table.splice(last + 1, 0, row);
    }
  }
  return lines.slice(0, at).concat(table, lines.slice(end)).join('\n');
}

function reviewToken() {
  const env = str(process.env.SKILL_REVIEW_TOKEN).trim();
  if (env) return env;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  throw new Error('no review token: set SKILL_REVIEW_TOKEN or put it in ' + TOKEN_FILE + ' (the same value as the cloud secret SKILL_REVIEW_TOKEN)');
}
async function getJson(url, opts) {
  const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, opts));
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch (_) { /* not json */ }
  if (!res.ok) throw new Error(url + ' answered ' + res.status + (body && body.reason ? ' (' + body.reason + ')' : ''));
  if (!body) throw new Error(url + ' did not answer JSON');
  return body;
}

const SKILLS_DIR = join(ROOT, 'skills-catalog', 'skills');
function readMeta(slug) {
  const p = join(SKILLS_DIR, slug, 'skill.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  (function walk(rel) {
    for (const n of readdirSync(join(dir, rel))) {
      const r = rel ? rel + '/' + n : n;
      if (statSync(join(dir, r)).isDirectory()) walk(r); else out.push({ path: r, bytes: readFileSync(join(dir, r)) });
    }
  })('');
  return out;
}
function restore(dir, snap) {
  rmSync(dir, { recursive: true, force: true });
  if (!snap) return;
  for (const f of snap) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.bytes); }
}

async function pull({ dryRun }) {
  const token = reviewToken();
  const body = await getJson(CLOUD + '/v1/skill-submissions/approved', { headers: { authorization: 'Bearer ' + token } });
  const library = catalog.loadDir(join(ROOT, 'sidecar/skills/library'), { readdirSync, readFileSync }, { join });
  const plan = planPull(body.submissions, { librarySlugs: new Set(library.map((r) => r.slug)), readMeta });
  for (const s of plan.skipped) console.log('  skipped ' + (s.slug || s.id) + ': ' + s.why);
  if (!plan.pulls.length) { console.log('pull-skill-submissions: nothing new to pull (' + (body.submissions || []).length + ' approved, ' + plan.skipped.length + ' skipped)'); return plan.skipped.length ? 1 : 0; }
  for (const p of plan.pulls) console.log('  ' + (dryRun ? 'would pull ' : 'pulling ') + p.slug + '@' + p.version + (p.update ? ' (update)' : '') + ' by ' + p.credit + ' · ' + p.files.length + ' files');
  if (dryRun) return 0;

  const noticePath = join(ROOT, 'NOTICE.md');
  const noticeBefore = readFileSync(noticePath, 'utf8');
  const snaps = new Map(plan.pulls.map((p) => [p.slug, snapshot(join(SKILLS_DIR, p.slug))]));
  try {
    for (const p of plan.pulls) {
      const dir = join(SKILLS_DIR, p.slug);
      rmSync(dir, { recursive: true, force: true });
      for (const f of p.files) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.content); }
      writeFileSync(join(dir, 'skill.json'), JSON.stringify(p.meta, null, 2) + '\n');
    }
    writeFileSync(noticePath, creditNotice(noticeBefore, plan.pulls.map((p) => ({ slug: p.slug, credit: p.credit, license: p.meta.license }))));
    const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-skill-catalog.mjs')], { cwd: ROOT, encoding: 'utf8', env: process.env });
    process.stdout.write(build.stdout || '');
    if (build.status !== 0) throw new Error('the catalog build refused: ' + str(build.stderr || build.stdout).trim());
  } catch (e) {
    // all or nothing: put every folder and NOTICE.md back the way they were
    for (const [slug, snap] of snaps) restore(join(SKILLS_DIR, slug), snap);
    writeFileSync(noticePath, noticeBefore);
    throw e;
  }
  console.log('pull-skill-submissions: pulled ' + plan.pulls.length + ' — commit skills-catalog/, NOTICE.md and website/, deploy the website, then run --mark-live');
  return 0;
}

async function markLive() {
  const token = reviewToken();
  const live = market.readCatalog(await getJson(LIVE_INDEX, {}));
  const bySlug = new Map(live.entries.map((e) => [e.slug, e]));
  const local = JSON.parse(readFileSync(join(ROOT, 'website', '.well-known', 'starnet-skills.json'), 'utf8'));
  const localBySlug = new Map(local.skills.map((e) => [e.slug, e]));
  const published = [];
  for (const slug of existsSync(SKILLS_DIR) ? readdirSync(SKILLS_DIR) : []) {
    const meta = readMeta(slug);
    if (!meta || !meta.submission) continue;
    const l = bySlug.get(slug), mine = localBySlug.get(slug);
    // live means: the deployed catalog lists this exact package (same version AND digest as the local build)
    if (l && mine && l.version === meta.version && l.digest === mine.digest) published.push({ id: meta.submission.id, version: meta.version });
    else console.log('  not live yet: ' + slug + '@' + meta.version);
  }
  if (!published.length) { console.log('pull-skill-submissions: no uploaded skill is live yet'); return 0; }
  const res = await getJson(CLOUD + '/v1/skill-submissions/published', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ published })
  });
  console.log('pull-skill-submissions: ' + (res.marked || []).length + ' newly marked live (' + published.length + ' uploaded skills listed live)');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  (args.includes('--mark-live') ? markLive() : pull({ dryRun: args.includes('--dry-run') }))
    .then((code) => process.exit(code || 0))
    .catch((e) => { console.error('pull-skill-submissions: ' + str(e && e.message || e)); process.exit(1); });
}
