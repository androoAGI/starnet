/* node test/frontend-fetch-truth-ratchet.test.js — INV-3, the FETCH-TRUTH ratchet (truthful-ack lane, 2026-11-03).
   The register's most-repeated frontend defect class (fd0f7223, aa9cd1cd, e05cdba8, 1aa7faf6, and the 2026-08-25 KEYS-tab
   residue) is one shape: the page announces a state the station never confirmed. The Response is thrown away and only the
   parsed body is kept, so `!r.ok` is structurally unreadable — a non-JSON refusal (plain-text 403, proxy HTML, 5xx) collapses
   to {} or a throw and renders as success, a confirmed-empty list, or "could not reach the station" about a station that
   answered. sidecar/ has failopen-ratchet.test.js; this is the frontend twin. Five families, each pinned by its fixtures:

     AWAIT_DISCARD     `await (await X(...)).json()` — any callee except Harness.api.*, whose post/del resolve the typed
                       { ok, status, code, j } (the old detector matched only fetch/postJSON and missed the ROUTINES and LOOPS
                       windows' own `post` helper: 10 discards)
     THEN_DISCARD      `.then(r => r.json())` with nothing else in the closure
     SYNTH_ON_NOT_OK   `r.ok ? r.json() : {…}|[…]` — a body synthesized for a refusal: a refused read reads as a confirmed
                       empty or false answer
     BYPASS            a raw fetch of an /api/ URL, or a local fetch-wrapper helper, outside harness.js. JSON exchanges go
                       through Harness.api; a stream or blob keeps its Response in scope and stays an audited row
     STATUS_ONLY_STALE a 401/403 status compare outside harness.js: a stale session is the gate's code (X-StarNet-Code
                       token_stale), never a bare status. The rows left are guarded legacy readings for an older sidecar
                       that names no code, and friendlyerror's provider ladder

   EXACT BASELINES, BOTH WAYS: a count above its row fails, a count below its row fails until the row is lowered in the same
   commit, and a row for a file that is gone fails. Every file not listed must be clean. Lowering a count? Lower the row. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..', 'frontend');
const HARNESS = 'app/harness.js';   // the one client: its own raw fetches and the gate's status reading live here by design

const FAMILIES = {
  AWAIT_DISCARD: {
    res: [/await\s*\(\s*await\s+(?!Harness\.api\.)[A-Za-z_$][\w$.]*\s*\(/g],
    everywhere: true,
    fix: 'keep the Response in scope, or post through Harness.api.post and read r.ok (refusals: Harness.api.why(r))',
    // the ROUTINES / LOOPS / CONNECTORS windows, userprops' preview poll and the skill share all reached 0 (2026-11-03)
    baseline: {}
  },
  THEN_DISCARD: {
    res: [/\.then\(\s*\(?\s*r\s*\)?\s*=>\s*r\.json\(\)\s*\)/g],
    everywhere: true,
    fix: 'read r.ok inside the closure (or use Harness.api)',
    baseline: {}
  },
  SYNTH_ON_NOT_OK: {
    res: [/\b(\w+)\.ok\s*\?\s*\1\.json\(\)\s*:\s*[\{\[]/g],
    everywhere: true,
    fix: 'a refused read is unknown with its reason (Harness.api.why), never a synthesized {ok:false}/{}/[]',
    baseline: {
      // the provider status reads (codex / grok·kimi status, /api/providers): provider-readiness-truth replaces them with
      // its cached readiness row, so they stay as audited rows here and the count can only fall
      'app/stationui.js': 3
      // app.js (autopilot writeFile, project REMOVE) and marketplace.js (harness detect, scan, pick folder) reached 0
    }
  },
  BYPASS: {
    res: [/\bfetch\(\s*(?:['"`]\/api\/|H\.api\(|api\()/g, /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*fetch\(/g],
    everywhere: false,
    fix: 'a JSON exchange goes through Harness.api (get/post/del); a stream or blob keeps its Response in scope',
    // frozen at the truthful-ack lane (157 raw /api fetches and 10 local helpers outside harness.js at its base): streams
    // (NDJSON/SSE), audio and blobs cannot use a JSON client, and the rest migrate as their controls are touched
    baseline: {
      'app/app.js': 25, 'app/apps.js': 2, 'app/autonomystore.js': 1, 'app/autopilotstore.js': 2, 'app/autosessions.js': 4,
      'app/briefing.js': 3, 'app/build.js': 2, 'app/chat.js': 27, 'app/cloudsave.js': 1,
      'app/delegated.js': 1, 'app/deliverables.js': 1, 'app/diagnostics.js': 3, 'app/firstvalue.js': 2,
      'app/goalstore.js': 1, 'app/group-chat.js': 4, 'app/hudmode.js': 1, 'app/journeystore.js': 1, 'app/marketplace.js': 5,
      'app/onboarding.js': 1, 'app/outputbrowser.js': 1, 'app/overseer.js': 1, 'app/pluginhost.js': 2,
      'app/questledgerstore.js': 3, 'app/questrefreshstore.js': 3, 'app/remoteview.js': 3, 'app/returnstore.js': 3,
      'app/stationcommands.js': 4, 'app/stationui.js': 5, 'app/studystore.js': 2, 'app/tutorial.js': 1, 'app/updates.js': 2,
      'app/voice-live.js': 9, 'app/voice-stream.js': 3, 'app/voice.js': 7, 'app/widgets.js': 3,
      'app/windows/loops.js': 1,      // the NEEDS YOU watcher's GET /api/loops: r.ok in scope, an errored read never clears the badge
      'app/windows/messaging.js': 1,  // GET /api/channels/status with r.ok in scope
      'app/windows/routines.js': 1,   // RUN NOW's POST /api/cron/run: an NDJSON stream of run events, resp.ok in scope
      'app/windows/workflows.js': 3, 'app/workflowpanel.js': 2, 'app/workflowtakeoverstore.js': 1, 'app/workshopstore.js': 7
      // windows/connectors.js reached 0: its postJSON helper and the raw OAuth start / device-poll fetches are Harness.api.post
    }
  },
  STATUS_ONLY_STALE: {
    res: [/[!=]==?\s*40[13]\b|\b40[13]\s*[!=]==?/g],
    everywhere: false,
    fix: 'decide stale / reload from the gate\'s code (Harness.classifyApiFailure, gateRefusedPage), never a bare 401/403',
    baseline: {
      'app/cloudsave.js': 2,       // the save pull's legacy rule, only when CloudSaveCore is absent
      'app/cloudsavecore.js': 2,   // causeOf's legacy rule, only when the station sends no code (an older sidecar)
      'app/friendlyerror.js': 8,   // the provider status ladder (a provider's own 401/403) + kindFromRaw's code-less 403 rule
      'app/group-chat.js': 2,      // the bare 401||403 only when Harness is absent
      'app/xpstore.js': 2          // the bare 401||403 only when Harness is absent
      // app.js's lineage polls reached 0: they reload only on gateRefusedPage (the gate's token_stale)
    }
  }
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
const countOf = (src, fam) => fam.res.reduce((n, re) => n + (String(src).match(new RegExp(re.source, 'g')) || []).length, 0);

// ---- every detector against its fixtures (a ratchet whose regex is wrong locks the wrong thing) ----
const F = FAMILIES;
A.eq(countOf('const j = await (await fetch(u)).json();', F.AWAIT_DISCARD), 1, 'AWAIT_DISCARD: the fetch form');
A.eq(countOf('const j = await (await postJSON(u, b)).json().catch(() => ({}));', F.AWAIT_DISCARD), 1, 'AWAIT_DISCARD: the postJSON form');
A.eq(countOf("const r = await (await post('/api/cron/arm', { enabled: true })).json();", F.AWAIT_DISCARD), 1, 'AWAIT_DISCARD: a window\'s own bare helper (the generalized callee)');
A.eq(countOf("r = await (await Harness.apiFetch('/api/skill-market/share', init)).json();", F.AWAIT_DISCARD), 1, 'AWAIT_DISCARD: a dotted callee that is not Harness.api');
A.eq(countOf('const r = await (await Harness.api.post(u, b));', F.AWAIT_DISCARD), 0, 'AWAIT_DISCARD: Harness.api.* resolves the typed result, not a Response');
A.eq(countOf('const r = await fetch(u); const j = await r.json();', F.AWAIT_DISCARD), 0, 'AWAIT_DISCARD: a kept Response is not matched');
A.eq(countOf('fetch(u).then(r => r.json()).then(j => {})', F.THEN_DISCARD), 1, 'THEN_DISCARD: the then-discard form');
A.eq(countOf('fetch(u).then(r => r.json().then(j => ({ ok: r.ok, j })))', F.THEN_DISCARD), 0, 'THEN_DISCARD: a closure that reads r.ok is not matched');
A.eq(countOf('fetch(u).then(r => r.json().catch(() => null))', F.THEN_DISCARD), 0, 'THEN_DISCARD: custom in-closure handling is audited individually');
A.eq(countOf(".then(r => r.ok ? r.json() : { ok: false, found: [] })", F.SYNTH_ON_NOT_OK), 1, 'SYNTH_ON_NOT_OK: an object synthesized for a refusal');
A.eq(countOf('.then(res => res.ok ? res.json() : [])', F.SYNTH_ON_NOT_OK), 1, 'SYNTH_ON_NOT_OK: an array synthesized for a refusal');
A.eq(countOf('.then(r => r.ok ? r.json() : null)', F.SYNTH_ON_NOT_OK), 0, 'SYNTH_ON_NOT_OK: null is no answer, not a synthesized one');
A.eq(countOf("fetch('/api/loops', { headers: h })", F.BYPASS), 1, 'BYPASS: a raw /api fetch');
A.eq(countOf('fetch(`/api/x/${id}`)', F.BYPASS), 1, 'BYPASS: a raw /api fetch by template');
A.eq(countOf("const post = (path, payload, signal) => fetch(path, { method: 'POST' });", F.BYPASS), 1, 'BYPASS: a local fetch-wrapper helper');
A.eq(countOf("const viaSidecar = () =>\n      fetch('/api/projects/pickfolder', { method: 'POST' })", F.BYPASS), 2, 'BYPASS: a helper around a raw /api fetch counts both');
A.eq(countOf("Harness.api.post('/api/cron/arm', { enabled: true })", F.BYPASS), 0, 'BYPASS: Harness.api is the client, not a bypass');
A.eq(countOf("fetch('/assets/x.png')", F.BYPASS), 0, 'BYPASS: a non-API fetch is not matched');
A.eq(countOf('if (r.status === 403) reload();', F.STATUS_ONLY_STALE), 1, 'STATUS_ONLY_STALE: a bare 403 compare');
A.eq(countOf('if (r.status === 401 || r.status === 403) reload();', F.STATUS_ONLY_STALE), 2, 'STATUS_ONLY_STALE: both compares of a 401||403 reading');
A.eq(countOf('if (403 === res.status) reload();', F.STATUS_ONLY_STALE), 1, 'STATUS_ONLY_STALE: a reversed compare');
A.eq(countOf('if (s !== 401 && s !== 4030) x();', F.STATUS_ONLY_STALE), 1, 'STATUS_ONLY_STALE: a negated compare, and 4030 is not 403');
A.eq(countOf('if (Harness.classifyApiFailure(r.status, j, code).staleSession) reload();', F.STATUS_ONLY_STALE), 0, 'STATUS_ONLY_STALE: deciding through the gate\'s code is not matched');

const files = walk(ROOT, []);
A.ok(files.length > 20, 'scanner sees the frontend tree (' + files.length + ' js files)');
const sources = files.map(f => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));
A.ok(sources.some(s => s.rel === HARNESS), 'the one client is on disk: ' + HARNESS);

for (const [name, fam] of Object.entries(FAMILIES)) {
  const seen = {};
  let over = 0;
  for (const { rel, src } of sources) {
    if (!fam.everywhere && rel === HARNESS) continue;
    const n = countOf(src, fam);
    if (n) seen[rel] = n;
    const cap = fam.baseline[rel] || 0;
    if (n > cap) {
      over++;
      A.ok(false, name + ': ' + rel + ' has ' + n + ', its audited baseline allows ' + cap + ' — ' + fam.fix);
    }
  }
  A.eq(over, 0, name + ': no frontend file exceeds its audited baseline');
  // stale-row hygiene + no slack: every baseline row exists on disk and is exact
  for (const rel of Object.keys(fam.baseline)) {
    A.ok(sources.some(s => s.rel === rel), name + ': baseline row exists on disk: ' + rel + ' (file moved/deleted? prune the row)');
    A.eq(seen[rel] || 0, fam.baseline[rel], name + ': ' + rel + ' equals its baseline (ratchet DOWN in the same commit)');
  }
}

A.report('frontend fetch-truth ratchet');
