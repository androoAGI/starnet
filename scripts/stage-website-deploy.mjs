#!/usr/bin/env node
/*
 * stage-website-deploy.mjs — build the exact directory that gets uploaded to starnetos.com
 *
 * WHY THIS EXISTS. starnetos.com is Cloudflare Pages by DIRECT UPLOAD: it has no git integration,
 * so merging a website lane to trunk publishes nothing and the live site only moves when someone
 * runs `wrangler pages deploy`. That command takes a DIRECTORY, and the obvious directory —
 * website/ — is not the thing we want published: pricing.html is written and reviewed but
 * deliberately held back (Andrew, 2026-08-02). Deploying website/ directly would publish it by
 * accident, and nobody would notice, because Cloudflare's catch-all answers 200 for every path.
 *
 * So the held-back set lives HERE, in code, instead of in whoever-remembers. Staging into a clean
 * directory also means a file deleted from website/ actually disappears from the upload rather
 * than lingering from a previous deploy.
 *
 * TO PUBLISH PRICING: flip PRICING_LIVE in website/site.js. That is the whole change — this script
 * READS that flag and holds nothing back once it is true.
 *
 * It used to be two edits kept in step by a comment ("delete it from HELD_BACK, in the same commit
 * that flips PRICING_LIVE"), and the failure that comment describes is real: a live page with hidden
 * links, or visible links to an unpublished page, are both worse than either state alone. But two
 * things a human keeps in step are two things a human can forget, and this one is only ever touched
 * on launch day by someone doing nine other things. So the flag is now the single source of truth and
 * disagreement is structurally impossible rather than merely discouraged.
 *
 * Usage:
 *   node scripts/stage-website-deploy.mjs          # stage, then print the deploy command
 *   node scripts/stage-website-deploy.mjs --check  # list what would be held back; write nothing
 */
import { readdirSync, mkdirSync, copyFileSync, rmSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldStage } from './stage-frontend-dist.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'website');
const OUT = join(ROOT, 'website-deploy');
const CHECK = process.argv.includes('--check');

/* Is the paid tier announced? website/site.js is the one place that decides, because it is the file
   that decides whether a visitor can SEE a link to pricing. Read it rather than keeping a second
   copy of the answer here.
   Parsed, not imported: site.js is browser code that runs against a live DOM the moment it loads.
   A missing or unreadable flag is a HARD failure — defaulting either way picks a side of exactly the
   mismatch this file exists to prevent. */
function pricingIsLive() {
  const siteJs = join(SRC, 'site.js');
  let src;
  try { src = readFileSync(siteJs, 'utf8'); }
  catch { console.error('cannot read website/site.js — it decides what gets published here'); process.exit(1); }
  const m = /\bPRICING_LIVE\s*=\s*(true|false)\b/.exec(src);
  if (!m) {
    console.error('website/site.js no longer declares PRICING_LIVE — this script reads that flag to');
    console.error('decide whether pricing.html publishes. Restore it, or rewrite this guard on purpose.');
    process.exit(1);
  }
  return m[1] === 'true';
}
const PRICING_LIVE = pricingIsLive();

// Paths (relative to website/, POSIX separators) that exist in the repo but must NOT be published.
// The no-credits legal variants are sources for SUBSTITUTIONS, never pages of their own, so they stay
// held back in BOTH states — publishing them once pricing is live would just be two dead URLs.
const HELD_BACK = new Set([
  ...(PRICING_LIVE ? [] : ['pricing.html']),
  'legal/_terms.nocredits.html',
  'legal/_privacy.nocredits.html'
]);

// Build-time sprite tooling is source, not a public web asset. Prefix rules cover future assembly helpers without
// requiring every new script to be added to this list, while HELD_BACK above remains strict for product pages.
const HELD_BACK_PREFIXES = ['app/assets/sprites/_assembly/'];

/* Holding pricing back is not only about the pricing page: terms.html clause 2 and privacy.html
   both describe the paid StarNet Credits program, and the terms cite the pricing page as forming
   part of them. Publishing that while the page itself is hidden would announce a paid tier nobody
   can read the price of, via a citation that resolves to the homepage.
   So the staged copies swap in variants carrying the wording ALREADY PUBLISHED on starnetos.com —
   no legal language invented for the hold. The repo keeps the full Credits versions, and the day
   pricing goes live the substitution simply stops applying and the real files publish untouched. */
const SUBSTITUTIONS = PRICING_LIVE ? {} : {
  'legal/terms.html': 'legal/_terms.nocredits.html',
  'legal/privacy.html': 'legal/_privacy.nocredits.html'
};

// Anything the staged legal pages must not contain while the paid tier is unannounced.
const CREDITS_WORDS = /credit|stripe|gateway|billing|subscription/i;

const PROJECT = 'starnet-site';

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(relative(SRC, full).split(sep).join('/'));
  }
  return acc;
}

const all = walk(SRC);
// The generated source mirror stays verbatim. Its deploy artifact uses the same
// runtime-art rule as the desktop, including the required calibration texture.
const isHeldBack = f => HELD_BACK.has(f) || HELD_BACK_PREFIXES.some(prefix => f.startsWith(prefix)) ||
  (f.startsWith('app/') && !shouldStage(f.slice(4)));
const held = all.filter(isHeldBack);
const shipping = all.filter(f => !isHeldBack(f));

// A name in HELD_BACK that matches nothing is a silent no-op — the file was renamed or removed and
// the guard stopped guarding. Fail rather than deploy something the list believes it is blocking.
const missing = [...HELD_BACK].filter(f => !all.includes(f));
if (missing.length) {
  console.error('HELD_BACK names a file that no longer exists in website/: ' + missing.join(', '));
  console.error('Either restore it or drop it from the list — a stale guard is not a guard.');
  process.exit(1);
}

/* State the mode on every run, in both directions. The dangerous version of this script is the one
   that quietly does the right thing — you cannot tell a correct hold from a broken one by reading a
   file count, and "did pricing publish?" is the question you are actually asking. */
console.log(PRICING_LIVE
  ? 'PRICING_LIVE=true in website/site.js — pricing.html and the full Credits legal pages WILL publish.'
  : 'PRICING_LIVE=false in website/site.js — holding pricing back and substituting the no-credits legal pages.');

if (CHECK) {
  console.log('would publish ' + (shipping.length + 2) + ' files; holding back ' + held.length + ':');
  for (const f of held) console.log('  - ' + f);
  for (const [target, source] of Object.entries(SUBSTITUTIONS)) console.log('  ~ ' + target + ' <- ' + source);
  process.exit(0);
}

// A substitution whose source vanished would silently publish the full-credits original.
for (const [target, source] of Object.entries(SUBSTITUTIONS)) {
  if (!all.includes(source)) {
    console.error('SUBSTITUTIONS points at a missing file: ' + source + ' (for ' + target + ')');
    process.exit(1);
  }
  if (!all.includes(target)) {
    console.error('SUBSTITUTIONS names a target that no longer exists: ' + target);
    process.exit(1);
  }
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
for (const rel of shipping) {
  const dest = join(OUT, rel.split('/').join(sep));
  const from = SUBSTITUTIONS[rel] || rel;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(SRC, from.split('/').join(sep)), dest);
  if (SUBSTITUTIONS[rel]) console.log('substituted: ' + rel + ' <- ' + from);
}

/* frontend/index.html loads the class catalog from /shared/specialties.js so the browser and sidecar
   consume one authority. website/app is a generated frontend mirror, but shared/ lives outside that mirror;
   stage the exact authoritative bytes explicitly or the static preview silently boots with an empty catalog. */
const sharedCatalogSource = join(ROOT, 'shared', 'specialties.js');
const sharedCatalogDest = join(OUT, 'shared', 'specialties.js');
mkdirSync(dirname(sharedCatalogDest), { recursive: true });
copyFileSync(sharedCatalogSource, sharedCatalogDest);

/* Cloudflare Pages' dashboard ZIP importer can collapse identically named index.html
   entries from different folders, while Pages clean-URL rewriting sends a secondary .html
   entry through the catch-all. Keep app/index.html for directory deploys, but give the
   marketing-page iframe a unique .htm entry that survives both dashboard behaviors. */
const embedSource = join(OUT, 'app', 'index.html');
const embedEntry = join(OUT, 'app', 'embed.htm');
copyFileSync(embedSource, embedEntry);

/* Prove the swap actually removed what it exists to remove, on the bytes that will be uploaded —
   not on the source we believed we copied. */
for (const rel of Object.keys(SUBSTITUTIONS)) {
  const staged = readFileSync(join(OUT, rel.split('/').join(sep)), 'utf8');
  const hit = staged.match(CREDITS_WORDS);
  if (hit) {
    console.error('staged ' + rel + ' still mentions "' + hit[0] + '" — refusing to deploy.');
    process.exit(1);
  }
}

/* The sitemap is the one file that can leak a held-back page even though the page itself never
   ships: Cloudflare's catch-all answers 200 for /pricing.html with the homepage body, so a
   crawler following the sitemap indexes a duplicate homepage under that URL instead of getting a
   404. Prune it from the staged copy rather than from the repo copy, so the entry is already in
   place the day pricing.html is allowed out. */
const sitemapPath = join(OUT, 'sitemap.xml');
if (existsSync(sitemapPath) && held.length) {
  const before = readFileSync(sitemapPath, 'utf8');
  const after = before
    .split(/\r?\n/)
    .filter(line => !held.some(f => line.includes('/' + f + '<')))
    .join('\n');
  const dropped = before.split(/\r?\n/).length - after.split(/\r?\n/).length;
  if (dropped) {
    writeFileSync(sitemapPath, after);
    console.log('pruned ' + dropped + ' held-back url(s) from the staged sitemap');
  }
}

console.log('staged ' + (shipping.length + 2) + ' files -> website-deploy/');
for (const f of held) console.log('held back: ' + f);
console.log('\nnext:\n  npx wrangler pages deploy website-deploy --project-name ' + PROJECT);
