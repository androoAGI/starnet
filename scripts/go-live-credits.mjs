#!/usr/bin/env node
/*
 * go-live-credits.mjs — open StarNet Credits to members, in one reviewable step.
 *
 * WHY THIS EXISTS. Turning the paid tier on used to be a hand-run checklist spread across a sidecar
 * constant, two flags in one browser file, a list inside another script, and a topnav link that had
 * been DELETED BY HAND from thirteen pages. That checklist has already been half-done once: the docs
 * pages were fixed and the legal pages were missed on the same pass, because when a mechanism is
 * per-page-family you have to enumerate every family and nothing was enumerating them.
 *
 * Half-done is the worst outcome available here. Buy buttons live against a page that is not
 * published do not 404 — Cloudflare's catch-all answers 200 with the homepage — so the site looks
 * entirely healthy while every plan link lands on a page with no prices on it.
 *
 * So: one command, all of it or none of it, and it REFUSES unless the billing service is actually
 * answering at the URL the app itself will use. The most expensive version of this mistake is
 * advertising an account nobody can create.
 *
 * Usage:
 *   node scripts/go-live-credits.mjs --check   # probe the service, list every edit, write nothing
 *   node scripts/go-live-credits.mjs --apply   # make the edits (probe must pass)
 *   node scripts/go-live-credits.mjs --apply --force   # proceed on a DEGRADED (503) service
 *   node scripts/go-live-credits.mjs --check --no-probe   # skip the network call (the gate uses this)
 *
 * It does NOT cut a release, run the gate, or deploy the site — those stay deliberate acts. It
 * prints them, in order, when it finishes. Full context: starnet-cloud/LAUNCH.md
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
if (!APPLY && !process.argv.includes('--check')) {
  console.error('Pass --check (safe, writes nothing) or --apply.');
  process.exit(2);
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const write = (rel, s) => writeFileSync(join(ROOT, rel), s);

/* ---------- the edits, each one written so re-running is a no-op ---------------------------------
   Every entry answers three questions: is it already done, what exactly changes, and did the change
   actually land. `done` is checked against the file on disk, never against whether we just wrote it. */
// Every docs page, RECURSIVELY — docs/guides/ (the Field Manual) is one level deeper and carries the
// same topnav. A flat readdir here silently dropped that whole family once the guides landed.
function htmlUnder(rel) {
  const out = [];
  for (const f of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    if (f.isDirectory()) out.push(...htmlUnder(rel + '/' + f.name));
    else if (f.name.endsWith('.html')) out.push(rel + '/' + f.name);
  }
  return out.sort();
}
export const NAV_LINK_PAGES = [
  ...htmlUnder('website/docs'),
  // The legal pages are the family that got missed last time. They carry the same topnav and the
  // same deleted link; the _*.nocredits.html variants deliberately do NOT (they stop being used the
  // moment pricing is live, so a link there would only ever be dead).
  'website/legal/terms.html',
  'website/legal/privacy.html'
];
// scripts/website-shell.mjs now stamps the topnav (with the PRICING link, marked data-pricing-link so
// the flag can also govern it on pages that DO load site.js). Depth varies (../ vs ../../), so the
// predicates match the nav markup by shape, not by one literal string — but still the NAV markup
// specifically: legal/terms.html cites ../pricing.html in the body of clause 2, which must not count.
const NAV_ANCHOR_RE = /<a href="((?:\.\.\/)+)index\.html#download">DOWNLOAD<\/a>/;
const NAV_LINK_RE = /<a href="(?:\.\.\/)+pricing\.html"(?: class="on")?(?: data-pricing-link)?>PRICING<\/a>/i;
const navInsert = (up) => `<a href="${up}pricing.html" data-pricing-link>PRICING</a>\n    `;
// The pre-credits cache key. "Done" means the key has moved past it — any later polish pass that
// re-busts the cache must not read as "still needs the credits bust" and get rolled back to it.
const PRE_CREDITS_SITE_SCRIPT = /<script src="site\.js\?v=20260(?:7|80[0-9]|810)[^"]*"><\/script>/;
const CREDITS_SITE_SCRIPT = '<script src="site.js?v=20260811-credits-live"></script>';

const EDITS = [
  {
    file: 'sidecar/index.js',
    what: 'CLOUD_LIVE = true — the app offers LINK STATION against the deployed service',
    done: (s) => /const CLOUD_LIVE = true;/.test(s),
    apply: (s) => s.replace(/const CLOUD_LIVE = false;/, 'const CLOUD_LIVE = true;'),
    can: (s) => /const CLOUD_LIVE = false;/.test(s)
  },
  {
    file: 'website/site.js',
    what: 'PRICING_LIVE = true — unhides every data-pricing-link, and publishes pricing.html',
    done: (s) => /var PRICING_LIVE = true;/.test(s),
    apply: (s) => s.replace(/var PRICING_LIVE = false;/, 'var PRICING_LIVE = true;'),
    can: (s) => /var PRICING_LIVE = false;/.test(s)
  },
  {
    file: 'website/site.js',
    what: 'CREDITS.live = true — buy buttons point at the account service instead of reading [ SOON ]',
    // Scoped to the CREDITS block: `live:` is a common enough key that a bare replace could hit
    // something else in this file later.
    done: (s) => /var CREDITS = \{\s*live: true,/.test(s),
    apply: (s) => s.replace(/(var CREDITS = \{\s*)live: false,/, '$1live: true,'),
    can: (s) => /var CREDITS = \{\s*live: false,/.test(s)
  },
  ...['website/index.html', 'website/pricing.html'].map((file) => ({
    file,
    what: 'cache-bust site.js so returning visitors receive the live Credits flags',
    done: (s) => /<script src="site\.js\?v=[^"]+"><\/script>/.test(s) && !PRE_CREDITS_SITE_SCRIPT.test(s),
    apply: (s) => s.replace(/<script src="site\.js\?v=[^"]+"><\/script>/, CREDITS_SITE_SCRIPT),
    can: (s) => /<script src="site\.js\?v=[^"]+"><\/script>/.test(s)
  })),
  ...NAV_LINK_PAGES.map((file) => ({
    file,
    what: 'restore the PRICING topnav link (this family does not load site.js, so no flag reaches it)',
    // The EXACT nav markup, not merely the path. legal/terms.html already links ../pricing.html in
    // the body of clause 2 (a legal citation, deliberately left in place), and a bare path match read
    // that as "nav link already restored" — this script would have skipped the one page whose link
    // matters most and reported success. A `done` predicate that can be satisfied by unrelated text
    // is worse than no predicate: it fails silently and in the safe-looking direction.
    done: (s) => NAV_LINK_RE.test(s),
    apply: (s) => s.replace(NAV_ANCHOR_RE, (m, up) => navInsert(up) + m),
    can: (s) => NAV_ANCHOR_RE.test(s)
  }))
];

/* ---------- the guard: is there actually a service to point at? ---------------------------------
   The URL is READ OUT OF sidecar/index.js rather than passed in, so this checks the exact host the
   shipped binary will use. Typing a URL here would prove a service exists somewhere, which is not
   the question. */
function bakedCloudUrl() {
  const m = /const CLOUD_URL_DEFAULT = '([^']+)'/.exec(read('sidecar/index.js'));
  if (!m) { console.error('sidecar/index.js no longer declares CLOUD_URL_DEFAULT.'); process.exit(1); }
  return m[1].replace(/\/+$/, '');
}

async function probe(url) {
  const target = url + '/healthz';
  let res;
  try {
    res = await fetch(target, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: String((e && e.message) || e), target };
  }
  let body = null;
  try { body = await res.json(); } catch { /* a non-JSON body is itself the finding */ }
  // 503 is a REAL answer from a real deployment: the service is up and telling you it is degraded
  // (a stalled backup, an errored webhook, a dead expiry sweep). That is a decision, not a typo, so
  // it needs --force rather than a silent pass.
  return { ok: res.status === 200, degraded: res.status === 503, status: res.status, body, target };
}

/* ---------- run ------------------------------------------------------------------------------- */
const url = bakedCloudUrl();
console.log('StarNet Credits go-live');
console.log('  baked service URL (sidecar/index.js CLOUD_URL_DEFAULT): ' + url + '\n');

/* --no-probe exists for the test gate, which runs offline and is asking a different question: not
   "is the service up" but "does every edit this script promises still match the tree it edits".
   It is refused with --apply — going live is exactly when you want the network call. */
const NO_PROBE = process.argv.includes('--no-probe');
if (NO_PROBE && APPLY) {
  console.error('--no-probe cannot be combined with --apply: the probe is the point.');
  process.exit(2);
}
const health = NO_PROBE ? { ok: false, skipped: true } : await probe(url);
if (health.skipped) {
  console.log('  service: NOT PROBED (--no-probe)');
} else if (health.ok) {
  console.log('  service: HEALTHY (200)');
} else if (health.degraded) {
  console.log('  service: DEGRADED (503) — it is up and reporting a problem:');
  for (const [k, v] of Object.entries(health.body || {})) {
    if (v === false || v === null) console.log('      ' + k + ' = ' + v);
  }
} else {
  console.log('  service: NOT ANSWERING — ' + (health.reason || ('HTTP ' + health.status)));
  if (health.detail) console.log('      ' + health.detail);
  console.log('      probed ' + health.target);
}

// Classify every edit against the files as they are right now.
const pending = [], already = [], broken = [];
for (const e of EDITS) {
  const s = read(e.file);
  if (e.done(s)) already.push(e);
  else if (e.can(s)) pending.push(e);
  else broken.push(e);
}

console.log('\n  already live : ' + already.length);
console.log('  to change    : ' + pending.length);
for (const e of pending) console.log('      ' + e.file + ' — ' + e.what);
if (broken.length) {
  console.log('  UNRECOGNISED : ' + broken.length + ' (neither done nor matchable — the file moved under this script)');
  for (const e of broken) console.log('      ' + e.file + ' — ' + e.what);
}

// An edit this script cannot recognise is the half-done state it exists to prevent: it would apply
// the ones it understands and leave the rest, which is exactly the mismatch. Never partially apply.
if (broken.length) {
  console.error('\nRefusing: fix or re-teach the unrecognised edits above first. Nothing was written.');
  process.exit(1);
}
if (!pending.length) {
  console.log('\nAlready live — nothing to do.');
  process.exit(0);
}
if (!APPLY) {
  console.log('\n--check only; nothing written. Re-run with --apply when the service is up.');
  process.exit(0);
}
if (!health.ok && !(health.degraded && FORCE)) {
  console.error('\nRefusing to go live: ' + (health.degraded
    ? 'the service is DEGRADED. Fix it, or pass --force if you have read the flags above and accept them.'
    : 'nothing is answering at ' + health.target + '. Deploy starnet-cloud first (see starnet-cloud/LAUNCH.md).'));
  console.error('Nothing was written.');
  process.exit(1);
}

for (const e of pending) {
  const before = read(e.file);
  const after = e.apply(before);
  if (after === before) {   // a replace that matched nothing must never pass for success
    console.error('edit produced no change: ' + e.file + ' — ' + e.what);
    process.exit(1);
  }
  write(e.file, after);
}

// Verify by RE-READING every file, including the ones that were already done. This is the whole
// point of the exercise: the claim being made is about the state of the tree, not about the writes.
const stillPending = EDITS.filter(e => !e.done(read(e.file)));
if (stillPending.length) {
  console.error('\nApplied, but these did not take — the tree is now HALF-CHANGED, fix before deploying:');
  for (const e of stillPending) console.error('  ' + e.file + ' — ' + e.what);
  process.exit(1);
}

console.log('\n' + EDITS.length + ' edits applied and verified on disk.\n');
console.log('Still yours, in this order (nothing below is automated on purpose):');
console.log('  1. npm run test:fast          — and re-lock qa/product-perfect/claims.json if it blocks');
console.log('  2. bump the version in ALL FOUR files (package-lock.json holds it twice), cut the release');
console.log('  3. wait for the release to be installable — CLOUD_LIVE only reaches users in a build');
console.log('  4. node scripts/stage-website-deploy.mjs   — it now follows PRICING_LIVE by itself');
console.log('  5. deploy website-deploy (NEVER website) with the wrangler line that prints');
