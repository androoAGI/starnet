/* node test/frontend-fetch-truth-ratchet.test.js — the RESPONSE-DISCARDING PARSE ratchet.
   The register's most-repeated frontend defect class (fd0f7223, aa9cd1cd, e05cdba8, 1aa7faf6,
   and the 2026-08-25 KEYS-tab residue) is one shape: the fetch Response is thrown away and only
   the parsed body is kept, so `!r.ok` is structurally unreadable — a non-JSON refusal (plain-text
   403, proxy HTML, 5xx) collapses to {} and renders as success, a confirmed-empty list, or a
   grant readout the harness never recorded. sidecar/ has failopen-ratchet.test.js; this is the
   frontend twin. Every remaining match below was hand-audited fail-closed (its {} lands in an
   error/else branch). Counts may only go DOWN: keep the Response in scope and check `r.ok`
   (connectors.js readJSON/readFailLine is the house pattern for GET renders). Lowering a count?
   Lower the baseline row in the same commit. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..', 'frontend');

// Form 1: `await (await fetch(...)).json()` / `await (await postJSON(...)).json()` — the Response
// object is unreachable the moment the expression resolves.
const AWAIT_DISCARD = /await\s*\(\s*await\s+(?:fetch|postJSON)\s*\(/g;
// Form 2: `.then(r => r.json())` with nothing else in the closure — the next .then sees only the
// body. (`r.json().catch(...)` inside the closure is NOT matched: those sites keep custom handling
// and are audited individually.)
const THEN_DISCARD = /\.then\(\s*\(?\s*r\s*\)?\s*=>\s*r\.json\(\)\s*\)/g;

/* Audited baseline (forward-slash paths relative to frontend/). Every file not listed must be CLEAN. */
const BASELINE = {
  'app/windows/connectors.js': 4, // refresh/connect x2/oauth-client POSTs: {} falls into the error/else branch (fail-closed); oauth-client recovers via a loud sign-in failure
  'app/build.js': 2,              // cron preview + create: body carries ok/error from the cron API; the catch path reports "nothing was created"
};

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ---- the detectors against fixtures (a ratchet whose regex is wrong locks the wrong thing) ----
const count = (src, re) => (String(src).match(re) || []).length;
A.eq(count('const j = await (await fetch(u)).json();', AWAIT_DISCARD), 1, 'detects the await-discard fetch form');
A.eq(count('const j = await (await postJSON(u, b)).json().catch(() => ({}));', AWAIT_DISCARD), 1, 'detects the await-discard postJSON form');
A.eq(count('const r = await fetch(u); const j = await r.json();', AWAIT_DISCARD), 0, 'a kept Response is not matched');
A.eq(count('fetch(u).then(r => r.json()).then(j => {})', THEN_DISCARD), 1, 'detects the then-discard form');
A.eq(count('fetch(u).then(r => r.json().then(j => ({ ok: r.ok, j })))', THEN_DISCARD), 0, 'a closure that reads r.ok is not matched');
A.eq(count('fetch(u).then(r => r.json().catch(() => null))', THEN_DISCARD), 0, 'custom in-closure handling is audited individually, not matched');

const files = walk(ROOT, []);
A.ok(files.length > 20, 'scanner sees the frontend tree (' + files.length + ' js files)');

let over = 0;
const seen = {};
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const src = fs.readFileSync(f, 'utf8');
  const n = count(src, AWAIT_DISCARD) + count(src, THEN_DISCARD);
  seen[rel] = n;
  const cap = BASELINE[rel] || 0;
  if (n > cap) {
    over++;
    A.ok(false, rel + ' has ' + n + ' response-discarding parse(s), baseline allows ' + cap +
      ' — keep the Response in scope and check r.ok before trusting the body (see connectors.js readJSON)');
  }
}
A.eq(over, 0, 'no frontend file exceeds its audited response-discard baseline');

// stale-row hygiene + no slack: every baseline row must exist and be exact.
for (const rel of Object.keys(BASELINE)) {
  A.ok(rel in seen, 'baseline row exists on disk: ' + rel + ' (file moved/deleted? prune the row)');
  A.eq(seen[rel], BASELINE[rel], rel + ' baseline equals the on-disk count (ratchet DOWN in the same commit)');
}

A.report('frontend fetch-truth ratchet');
