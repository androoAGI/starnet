#!/usr/bin/env node
/*
 * release-preflight.mjs — ONE read-only, idempotent checklist for a StarNet release cut.
 *
 *   npm run release:preflight -- --version 0.10.8
 *   npm run release:preflight -- --next patch|minor|major
 *
 * WHY THIS EXISTS. The cut ritual lived in three places at once — docs/RELEASE_RUNBOOK.md, memory
 * notes, and tribal knowledge — and every step-order mistake cost real money: v0.2.0 + v0.2.1 were
 * burned by gating AFTER the tag push (MISTAKES.md "Gate order"), a 15h soak was lost to a re-cut,
 * and 0.10.6 shipped a close-zombie partly because cutting was expensive enough that the fix waited.
 * This script turns every precondition the runbook lists into a row with an exact remediation, so
 * the operator reads ONE checklist instead of re-deriving the ritual at 2am.
 *
 * IT MUTATES NOTHING. Every probe is a read (git plumbing, file reads, read-only `gh release view`,
 * `claims.mjs` check mode, `sync-website-app.mjs --check`, `ready.mjs --json`). It never prints the
 * updater key, only whether the file exists.
 *
 * ROW STATUSES (the checklist vocabulary):
 *   PASS  — proven.
 *   FAIL  — a HARD red: the cut must not proceed. Exit code 1 if any row is FAIL.
 *   WARN  — owed or soft: proceed, but the row names what is still outstanding and when it is due.
 *   SKIP  — unverifiable here (offline / tool missing). Never silently green — says so.
 *
 * PHASES. `--phase pre-bump` (default) is the runbook's section 0 + 1 preconditions: pins still on
 * the CURRENT version, gate-at-HEAD is informational (the binding gate is the POST-bump one —
 * MISTAKES.md "Gate order"). `--phase post-bump` is what release-ritual.mjs runs right before the
 * tag: pins must already equal the target, RELEASE_NOTES must be real (no TODO scaffold), the
 * claims lock must be current, and a fresh green gate receipt for HEAD is a HARD requirement.
 *
 * GATE RECEIPTS. `npm run test:fast` writes no durable artifact of its own, so this lane defines one:
 * `.dogfood/gate-receipts/<full-sha>.<fast|http>.json` (gitignored, machine-local), written ONLY by
 * release-ritual.mjs after it verified a gate LOG whose last line is the runner's green summary
 * (`run-fast-tests: OK — N step(s) green`). The exit code is never consulted — a `| tail` or a
 * wrapper can hide a red gate; the summary line cannot be faked by accident.
 *
 * HOUSE PATTERN: PURE CORE + injected io. `runPreflight(ctx, io)` touches nothing ambient; the CLI
 * at the foot is the only place fs / child_process / os / Date live. test/release-preflight.test.js
 * drives the core with fixture io and never shells out.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TRUNK = 'feat/harness-backend';
export const APP_CRATE = 'skynet-desktop';
export const GUARDIAN_ROW_FILE = 'qa/STATUS.md';
export const GATE_RECEIPT_DIR = '.dogfood/gate-receipts';
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

/* ───────────────────────────── pure helpers ───────────────────────────── */

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?/.exec(String(v || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a); const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  for (const k of ['major', 'minor', 'patch']) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function bumpSemver(current, kind) {
  const p = parseSemver(current);
  if (!p) throw new Error('current version "' + current + '" is not SemVer');
  if (kind === 'major') return (p.major + 1) + '.0.0';
  if (kind === 'minor') return p.major + '.' + (p.minor + 1) + '.0';
  if (kind === 'patch') return p.major + '.' + p.minor + '.' + (p.patch + 1);
  throw new Error('--next must be patch|minor|major (got "' + kind + '")');
}

// Strip a UTF-8 BOM (PowerShell `>` writes one; node JSON.parse then fails SILENTLY upstream).
export function stripBom(s) { return String(s == null ? '' : s).replace(/^﻿/, ''); }

/** The five version pins docs/BRAIN.md names. Returns [{label, value|null, path}]. */
export function readVersionPins(io) {
  const pins = [];
  const j = (rel) => { const t = io.readText(rel); if (t == null) return null; try { return JSON.parse(stripBom(t)); } catch { return undefined; } };
  const pkg = j('package.json');
  pins.push({ label: 'package.json', path: 'package.json', value: pkg ? pkg.version : (pkg === undefined ? '(unparseable)' : null) });
  const lock = j('package-lock.json');
  pins.push({ label: 'package-lock.json root', path: 'package-lock.json',
    value: lock ? (lock.version === (lock.packages && lock.packages[''] && lock.packages[''].version) ? lock.version : (lock.version + ' / packages[""]=' + (lock.packages && lock.packages[''] && lock.packages[''].version))) : (lock === undefined ? '(unparseable)' : null) });
  const conf = j('src-tauri/tauri.conf.json');
  pins.push({ label: 'src-tauri/tauri.conf.json', path: 'src-tauri/tauri.conf.json', value: conf ? conf.version : (conf === undefined ? '(unparseable)' : null) });
  const toml = io.readText('src-tauri/Cargo.toml');
  const tm = toml == null ? null : /^\s*version\s*=\s*"([^"]+)"/m.exec(stripBom(toml));
  pins.push({ label: 'src-tauri/Cargo.toml', path: 'src-tauri/Cargo.toml', value: toml == null ? null : (tm ? tm[1] : '(no version line)') });
  const clock = io.readText('src-tauri/Cargo.lock');
  const cm = clock == null ? null : new RegExp('name = "' + APP_CRATE + '"\\r?\\nversion = "([^"]+)"').exec(stripBom(clock));
  pins.push({ label: 'src-tauri/Cargo.lock ' + APP_CRATE, path: 'src-tauri/Cargo.lock', value: clock == null ? null : (cm ? cm[1] : '(pin not found)') });
  return pins;
}

/** Parse a gate log's last meaningful line. Accepts the runner summary only — never an exit code. */
export const GATE_SUMMARY_RE = /^(run-fast-tests|run-test-list|test:fast|test:http)\s*:\s*OK\s+[—-]+\s+(\d+)\s+step\(s\)\s+green\s*$/;
export function parseGateLog(text) {
  const lines = stripBom(text).split(/\r?\n/).map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  const m = GATE_SUMMARY_RE.exec(last);
  if (!m) return { ok: false, lastLine: last, reason: 'last line is not the runner\'s green summary ("<label>: OK — N step(s) green")' };
  const gate = (m[1] === 'run-fast-tests' || m[1] === 'test:fast') ? 'fast' : 'http';
  return { ok: true, gate, steps: +m[2], lastLine: last };
}

/* ───────────────────────────── the checklist core ───────────────────────────── */

function row(id, label, status, detail, fix) { return { id, label, status, detail: detail || '', fix: fix || '' }; }

function gitLines(io, args) {
  const r = io.exec('git', args);
  if (!r || r.status !== 0) return null;
  return String(r.stdout || '').split(/\r?\n/).map(l => l.replace(/\r$/, '')).filter(l => l.length);
}

function resolveReleasesRepo(io) {
  const t = io.readText('src-tauri/tauri.conf.json');
  if (t == null) return null;
  try {
    const conf = JSON.parse(stripBom(t));
    const url = (conf.plugins && conf.plugins.updater && conf.plugins.updater.endpoints || []).find(e => typeof e === 'string');
    const m = url && /github\.com\/([^/]+)\/([^/]+)/.exec(url);
    return m ? m[1] + '/' + m[2] : null;
  } catch { return null; }
}

/**
 * ctx: { version?, next?, phase: 'pre-bump'|'post-bump', allowLane?: bool, keyFile: abs path }
 * io : { readText(relOrAbs) -> string|null, exists(relOrAbs) -> bool, listDir(relOrAbs) -> string[],
 *        stat(relOrAbs) -> {mtimeMs}|null, exec(cmd, args) -> {status, stdout, stderr, error?}, now() -> ms }
 * Every path handed to io is repo-relative unless it is already absolute (the key file).
 */
export function runPreflight(ctx, io) {
  const rows = [];
  const phase = ctx.phase === 'post-bump' ? 'post-bump' : 'pre-bump';

  // ── version resolution ──
  const pins = readVersionPins(io);
  const pinValues = pins.map(p => p.value);
  const current = pins[2].value && SEMVER_RE.test(String(pins[2].value)) ? pins[2].value : null; // tauri.conf.json is the floor release-bump enforces
  let target = ctx.version || null;
  if (!target && ctx.next) {
    if (!current) rows.push(row('target', 'target version', 'FAIL', 'cannot derive --next ' + ctx.next + ': tauri.conf.json version unreadable', 'pass --version X.Y.Z explicitly'));
    else target = bumpSemver(current, ctx.next);
  }
  if (!target) rows.push(row('target', 'target version', 'FAIL', 'no --version / --next given', 'npm run release:preflight -- --next patch   (or --version X.Y.Z)'));
  else if (!SEMVER_RE.test(target)) rows.push(row('target', 'target version', 'FAIL', '"' + target + '" is not SemVer X.Y.Z', 'pass --version X.Y.Z'));

  // ── branch ──
  const branch = (gitLines(io, ['rev-parse', '--abbrev-ref', 'HEAD']) || [''])[0];
  const head = (gitLines(io, ['rev-parse', 'HEAD']) || [''])[0];
  if (!head) rows.push(row('git', 'git repository', 'FAIL', 'git rev-parse HEAD failed — not a git checkout?', 'run from the integration tree (Desktop/gen)'));
  if (branch === TRUNK) rows.push(row('branch', 'on trunk ' + TRUNK, 'PASS', 'HEAD ' + head.slice(0, 9)));
  else if (ctx.allowLane) rows.push(row('branch', 'on trunk ' + TRUNK, 'WARN', 'on "' + branch + '" (--allow-lane): bump + re-lock may happen here, but the TAG goes on trunk AFTER the merge (v0.10.7 pattern: release commit on lane → merge → tag the merge)', 'after merging: run the ritual again from the integration tree to tag'));
  else rows.push(row('branch', 'on trunk ' + TRUNK, 'FAIL', 'on "' + branch + '"', 'cd to the integration tree (Desktop/gen) on ' + TRUNK + ', or pass --allow-lane to bump on a lane and tag after merge'));

  // ── working tree clean (Guardian qa/STATUS.md row refresh is a known, benign dirt) ──
  const porcelain = gitLines(io, ['status', '--porcelain', '--untracked-files=normal']);
  if (porcelain == null) rows.push(row('clean', 'working tree clean', 'FAIL', 'git status failed', 'fix the checkout'));
  else {
    const dirty = porcelain.map(l => ({ code: l.slice(0, 2), path: l.slice(3).trim() }));
    const guardian = dirty.filter(d => d.path === GUARDIAN_ROW_FILE);
    const untracked = dirty.filter(d => d.code === '??' && d.path !== GUARDIAN_ROW_FILE);
    const modified = dirty.filter(d => d.code !== '??' && d.path !== GUARDIAN_ROW_FILE);
    if (modified.length) rows.push(row('clean', 'working tree clean', 'FAIL', modified.length + ' modified tracked file(s): ' + modified.slice(0, 6).map(d => d.path).join(', ') + (modified.length > 6 ? ', …' : ''), 'commit (pathspecs only) or stash them — release-bump commits by pathspec but the tag must point at a tree you can rebuild'));
    else if (untracked.length) rows.push(row('clean', 'working tree clean', 'WARN', untracked.length + ' untracked file(s): ' + untracked.slice(0, 6).map(d => d.path).join(', ') + (untracked.length > 6 ? ', …' : ''), 'foreign untracked files have blocked the claims re-lock guard before — move them out or add them to .gitignore'));
    else rows.push(row('clean', 'working tree clean', 'PASS', guardian.length ? 'clean except ' + GUARDIAN_ROW_FILE : 'clean'));
    if (guardian.length) rows.push(row('guardian-row', 'Guardian ' + GUARDIAN_ROW_FILE + ' row refresh', 'WARN', 'qa/STATUS.md is modified — that is the Guardian\'s periodic status row, not lane work', 'commit it as its own `qa: record …` commit (git add qa/STATUS.md) or `git stash push qa/STATUS.md` before tagging; never fold it into the release commit'));
  }

  // ── five pins agree ──
  const distinct = [...new Set(pinValues.map(v => v == null ? '(missing)' : String(v)))];
  const pinText = pins.map(p => p.label + '=' + (p.value == null ? '(missing)' : p.value)).join(' · ');
  if (distinct.length !== 1 || !current) rows.push(row('pins', 'five version pins agree', 'FAIL', pinText, 'the five pins must read the same version: `npm run release:bump <ver>` moves all five together (BRAIN.md); hand-fix any straggler, then re-run'));
  else if (target && SEMVER_RE.test(target)) {
    const cmp = compareSemver(target, current);
    if (phase === 'pre-bump') {
      if (cmp > 0) rows.push(row('pins', 'five version pins agree', 'PASS', 'all five = ' + current + ' → bump to ' + target + ' pending'));
      else if (cmp === 0) rows.push(row('pins', 'five version pins agree', 'WARN', 'all five already = ' + target + ' — the bump has already happened; run with --phase post-bump (the ritual does this for you)'));
      else rows.push(row('pins', 'five version pins agree', 'FAIL', 'target ' + target + ' is NOT greater than in-tree ' + current, 'pick a higher version — the updater never offers a lower one (fix-forward only, runbook §3.2)'));
    } else if (cmp === 0) rows.push(row('pins', 'five version pins agree', 'PASS', 'all five = ' + target));
    else rows.push(row('pins', 'five version pins agree', 'FAIL', 'all five = ' + current + ' but target is ' + target + ' (post-bump phase)', 'run `npm run release:bump ' + target + ' -- --no-tag` first'));
  } else rows.push(row('pins', 'five version pins agree', 'PASS', 'all five = ' + current));

  // ── tag collisions: local, source remote, releases repo ──
  if (target && SEMVER_RE.test(target)) {
    const tag = 'v' + target;
    const local = gitLines(io, ['tag', '--list', tag]) || [];
    const tagAt = local.length ? (gitLines(io, ['rev-list', '-n', '1', tag]) || [''])[0] : '';
    if (!local.length) rows.push(row('tag-local', 'tag ' + tag + ' not yet local', 'PASS'));
    else if (phase === 'post-bump' && tagAt && tagAt === head) rows.push(row('tag-local', 'tag ' + tag + ' not yet local', 'WARN', 'already tagged at HEAD — the tag step is done; nothing pushed yet'));
    else rows.push(row('tag-local', 'tag ' + tag + ' not yet local', 'FAIL', 'local tag exists at ' + tagAt.slice(0, 9), 'this version is spent. Tags are never force-moved once CI may have built from them (runbook §2.3) — bump the patch instead: --next patch'));

    const remote = io.exec('git', ['ls-remote', '--tags', 'origin', 'refs/tags/' + tag]);
    if (!remote || remote.error || remote.status !== 0) rows.push(row('tag-remote', 'tag ' + tag + ' not on origin', 'SKIP', 'unverified: offline or origin unreachable (' + ((remote && (remote.error && remote.error.message || String(remote.stderr || '').trim().split(/\r?\n/)[0])) || 'no result') + ')', 'get online and re-run; a tag already on origin has ALREADY fired the train'));
    else if (String(remote.stdout || '').trim()) rows.push(row('tag-remote', 'tag ' + tag + ' not on origin', 'FAIL', 'origin already has ' + tag + ' — the train already ran for it', 'this version is spent: --next patch'));
    else rows.push(row('tag-remote', 'tag ' + tag + ' not on origin', 'PASS'));

    const repo = resolveReleasesRepo(io);
    if (!repo) rows.push(row('tag-release', 'no release ' + tag + ' on releases repo', 'SKIP', 'could not read the updater endpoint from tauri.conf.json', 'check plugins.updater.endpoints[0]'));
    else {
      const gh = io.exec('gh', ['release', 'view', tag, '-R', repo, '--json', 'tagName,isDraft,isPrerelease']);
      const errText = gh ? String(gh.stderr || gh.stdout || '').trim() : '';
      if (!gh || gh.error) rows.push(row('tag-release', 'no release ' + tag + ' on ' + repo, 'SKIP', 'unverified: gh not runnable (' + (gh && gh.error ? (gh.error.code || gh.error.message) : 'spawn failed') + ')', 'install/auth `gh` and re-run, or check https://github.com/' + repo + '/releases by hand'));
      else if (gh.status === 0) {
        let draft = false; try { draft = !!JSON.parse(stripBom(gh.stdout)).isDraft; } catch {}
        rows.push(row('tag-release', 'no release ' + tag + ' on ' + repo, 'FAIL', (draft ? 'a DRAFT ' : 'a PUBLISHED ') + tag + ' already exists there', draft ? 'a draft reserves the version: delete the draft (Releases → ' + tag + ' → Delete) ONLY if nothing depends on it, otherwise --next patch (runbook §2.3)' : 'published = the fleet may run it: --next patch'));
      } else if (/not found|could not find|HTTP 404|release not found/i.test(errText)) rows.push(row('tag-release', 'no release ' + tag + ' on ' + repo, 'PASS'));
      else rows.push(row('tag-release', 'no release ' + tag + ' on ' + repo, 'SKIP', 'unverified: ' + (errText.split(/\r?\n/)[0] || ('gh exit ' + gh.status)), 'run `gh auth login` (read access to ' + repo + ') and re-run'));
    }
  }

  // ── claims lock current for HEAD (reads the COMMIT, never the tree) ──
  {
    const c = io.exec('node', ['scripts/qa/product-perfect/claims.mjs']);
    const first = c ? stripBom(String(c.stdout || '')).split(/\r?\n/).filter(Boolean) : [];
    if (!c || c.error) rows.push(row('claims', 'claims lock current for HEAD', 'FAIL', 'claims.mjs could not run: ' + (c && c.error ? c.error.message : 'spawn failed'), 'node scripts/qa/product-perfect/claims.mjs'));
    else if (c.status === 0 && /^PASS\b/.test(first[0] || '')) rows.push(row('claims', 'claims lock current for HEAD', 'PASS', first[0]));
    else rows.push(row('claims', 'claims lock current for HEAD', 'FAIL', (first[0] || ('exit ' + c.status)) + (first[1] ? ' ' + first.slice(1, 4).join(' ') : ''), 'COMMIT first, then re-lock as its OWN commit: SHA=$(git rev-parse HEAD); node scripts/qa/product-perfect/claims.mjs --refresh-surface --candidate $SHA > surface.json; splice as .releaseSurface into qa/product-perfect/claims.json; git commit -m "qa(claims): re-lock the release surface for v' + (target || 'X.Y.Z') + '" -- qa/product-perfect/claims.json   (the audit reads the COMMIT — an uncommitted re-lock is invisible; release-ritual does this step for you)'));
  }

  // ── website mirror in sync ──
  {
    const w = io.exec('node', ['scripts/sync-website-app.mjs', '--check']);
    if (!w || w.error) rows.push(row('website', 'website/app mirror in sync', 'FAIL', 'sync-website-app.mjs --check could not run', 'node scripts/sync-website-app.mjs --check'));
    else if (w.status === 0) rows.push(row('website', 'website/app mirror in sync', 'PASS'));
    else rows.push(row('website', 'website/app mirror in sync', 'FAIL', stripBom(String(w.stdout || w.stderr || '')).split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | '), 'npm run sync:website; commit website/app (pathspec); THEN re-lock claims (website/app is in the release surface)'));
  }

  // ── gate receipts for HEAD ──
  {
    const found = { fast: null, http: null };
    if (head) {
      for (const gate of ['fast', 'http']) {
        const rel = GATE_RECEIPT_DIR + '/' + head + '.' + gate + '.json';
        const t = io.readText(rel);
        if (t != null) { try { const r = JSON.parse(stripBom(t)); if (r && r.commit === head && r.green === true) found[gate] = r; } catch {} }
      }
    }
    const hard = phase === 'post-bump';
    const where = GATE_RECEIPT_DIR + '/' + (head ? head.slice(0, 9) + '…' : '<sha>') + '.{fast,http}.json';
    if (found.fast) rows.push(row('gate-fast', 'test:fast green at HEAD', 'PASS', found.fast.steps + ' step(s) green · ' + (found.fast.at || '') + ' · log ' + (found.fast.log || '')));
    else rows.push(row('gate-fast', 'test:fast green at HEAD', hard ? 'FAIL' : 'WARN', 'gate NOT proven at HEAD (no receipt at ' + where + ')', hard
      ? 'run `npm run test:fast 2>&1 | tee gate-fast.log` then `node scripts/release-ritual.mjs … --gates-proven-by gate-fast.log` — the ritual verifies the log\'s LAST LINE is the green summary and writes the receipt'
      : 'informational pre-bump: the BINDING gate runs AFTER the bump, BEFORE the tag (MISTAKES.md "Gate order" — v0.2.0/v0.2.1 were burned by skipping it)'));
    if (found.http) rows.push(row('gate-http', 'test:http green at HEAD', 'PASS', found.http.steps + ' step(s) green · ' + (found.http.at || '')));
    else rows.push(row('gate-http', 'test:http green at HEAD', 'WARN', 'not proven at HEAD', 'required when sidecar/ship/route code changed since the last cut (starnet-backend-law): `npm run test:http 2>&1 | tee gate-http.log` → --gates-proven-by gate-http.log'));
  }

  // ── T0 / G1 / soak receipts (post-draft gates — pre-tag they are OWED, never silently green) ──
  {
    const tag = target ? 'v' + target : null;
    // T0 clean-install: .dogfood/t0-clean-install-*/t0-clean-install-status.json (scripts/t0-clean-install.mjs)
    let t0 = null;
    for (const d of (io.listDir('.dogfood') || []).filter(n => n.startsWith('t0-clean-install-'))) {
      const t = io.readText('.dogfood/' + d + '/t0-clean-install-status.json');
      if (t == null) continue;
      try { const j = JSON.parse(stripBom(t)); if (target && String(j.version || j.appVersion || j.expectedVersion || '') === target && /pass|green/i.test(String(j.verdict || j.status || ''))) t0 = d; } catch {}
    }
    rows.push(t0
      ? row('t0', 'T0 clean-install proof for ' + tag, 'PASS', '.dogfood/' + t0)
      : row('t0', 'T0 clean-install proof for ' + (tag || 'target'), 'WARN', 'owed — runs on a fresh hosted Windows VM against the STAGED DRAFT (after the tag push)', 'Actions → t0-clean-install-proof → Run workflow → tag=' + (tag || 'vX.Y.Z') + ' (runbook §1.7a). RELEASE BLOCKER: do not Publish without it'));
    // G1 packaged lifecycle: any packaged-lifecycle-receipt.json under .dogfood/** with the tag
    let g1 = null;
    const walk = (rel, depth) => {
      if (depth > 3 || g1) return;
      for (const n of (io.listDir(rel) || [])) {
        const p = rel + '/' + n;
        if (n === 'packaged-lifecycle-receipt.json') {
          const t = io.readText(p);
          if (t == null) continue;
          try {
            const j = JSON.parse(stripBom(t));
            const names = ['idle-close', 'close-to-tray', 'updater-smoke'];
            const complete = Array.isArray(j.cases) && names.every(name => j.cases.filter(c => c.name === name && c.result === 'PASS').length === 1) && j.cases.every(c => c.result === 'PASS');
            // The real G1 writer puts its tag in meta. A passing subset is useful
            // evidence, but cannot clear the complete packaged-lifecycle release gate.
            if (tag && (j.meta?.tag === tag || j.tag === tag || j.expectedVersion === target) && j.verdict === 'PASS' && complete) g1 = p;
          } catch {}
        } else if (!/\./.test(n)) walk(p, depth + 1);
      }
    };
    walk('.dogfood', 0);
    rows.push(g1
      ? row('g1', 'G1 packaged-lifecycle proof for ' + tag, 'PASS', g1)
      : row('g1', 'G1 packaged-lifecycle proof for ' + (tag || 'target'), 'WARN', 'owed — idle-close / close-to-tray / updater-smoke on a fresh hosted Windows VM against the staged draft (this is the branch 0.10.5/0.10.6 escaped through)', 'Actions → g1-packaged-lifecycle → Run workflow → tag=' + (tag || 'vX.Y.Z') + ' (runbook §1.7a). RELEASE BLOCKER: do not Publish without it'));
    // soak: qa/installed/last-smoke.json appVersion == target && GREEN
    const smoke = io.readText('qa/installed/last-smoke.json');
    let smokeRow = row('soak', 'installed-exe soak stamp for ' + (tag || 'target'), 'WARN', 'owed — qa/installed/last-smoke.json absent', 'RC soak per docs/RELEASE_READINESS.md §2 (build the RC installer, `npm run qa:smoke:installed`, soak ≥48h). For a HOTFIX cut, state explicitly in RELEASE_NOTES/NEXT.md that the soak was waived and why');
    if (smoke != null) {
      try {
        const j = JSON.parse(stripBom(smoke));
        const stampResult = j.result || j.verdict || j.status || '';
        const green = /green/i.test(String(stampResult));
        const ageH = j.stampIso ? (io.now() - Date.parse(j.stampIso)) / 36e5 : NaN;
        if (target && String(j.appVersion) === target && green && ageH <= 7 * 24) smokeRow = row('soak', 'installed-exe soak stamp for ' + tag, 'PASS', 'GREEN · appVersion ' + j.appVersion + ' · ' + ageH.toFixed(1) + 'h old');
        else smokeRow = row('soak', 'installed-exe soak stamp for ' + (tag || 'target'), 'WARN', 'stamp is for appVersion ' + j.appVersion + ' (' + (green ? 'GREEN' : String(stampResult)) + ', ' + (isFinite(ageH) ? ageH.toFixed(1) + 'h old' : 'no stamp time') + ') — not a soak of ' + (target || 'the target'), 'soak the RC build of ' + (target || 'the target') + ' (docs/RELEASE_READINESS.md §2) or record the waiver');
      } catch { smokeRow = row('soak', 'installed-exe soak stamp', 'WARN', 'qa/installed/last-smoke.json unparseable', 're-run `npm run qa:smoke:installed`'); }
    }
    rows.push(smokeRow);
  }

  // ── qa:ready verdict (runbook §0 — READY-GATE law: NOT READY = do not bump, do not tag) ──
  {
    const r = io.exec('node', ['scripts/qa/ready.mjs', '--json']);
    let v = null;
    if (r && !r.error) { try { v = JSON.parse(stripBom(String(r.stdout || ''))); } catch {} }
    if (!v) rows.push(row('ready', 'qa:ready verdict', 'FAIL', 'qa:ready could not produce a verdict (' + (r && r.error ? r.error.message : 'unparseable output') + ') — no-fake-green: that is NOT READY', 'npm run qa:ready'));
    else if (v.ready) rows.push(row('ready', 'qa:ready verdict', 'PASS', 'READY'));
    else rows.push(row('ready', 'qa:ready verdict', 'FAIL', 'NOT READY — ' + (v.reasons || []).slice(0, 4).join(' · ') + ((v.reasons || []).length > 4 ? ' · …' : ''), 'stop: do not bump, do not tag. `node scripts/qa/ledger.mjs --digest`, fix on trunk, re-run `npm run qa:ready` until READY (READY-GATE law, docs/RELEASE_READINESS.md)'));
  }

  // ── updater signing key present (never printed) ──
  {
    const kf = ctx.keyFile;
    if (io.exists(kf)) rows.push(row('updater-key', 'updater signing key present', 'PASS', 'file exists (contents never read or printed)'));
    else rows.push(row('updater-key', 'updater signing key present', 'FAIL', 'missing: ' + kf, 'restore ~/.tauri/starnet-updater.key from an OFFLINE backup (runbook §4). Without it no installed StarNet can ever update again. The train signs on CI with the TAURI_SIGNING_PRIVATE_KEY secret — local presence is your proof you still hold it'));
    rows.push(row('updater-key-backup', 'updater key backed up offline (≥2 copies)', 'SKIP', 'unverifiable by machine — human attestation', 'runbook §4.1: confirm two offline copies exist before you push the tag'));
  }

  // ── release notes ──
  {
    const notes = io.readText('RELEASE_NOTES.md');
    const header = notes == null ? null : (/^#\s*StarNet\s+v?(\S+)/m.exec(stripBom(notes)) || [])[1];
    const todo = notes != null && /TODO: summarize/.test(notes);
    if (notes == null) rows.push(row('notes', 'RELEASE_NOTES.md for ' + (target ? 'v' + target : 'target'), 'FAIL', 'RELEASE_NOTES.md missing', 'release-bump scaffolds it; write the real user-facing notes'));
    else if (target && header === target && !todo) rows.push(row('notes', 'RELEASE_NOTES.md for v' + target, 'PASS', 'header matches, no TODO scaffold'));
    else if (target && header === target && todo) rows.push(row('notes', 'RELEASE_NOTES.md for v' + target, phase === 'post-bump' ? 'FAIL' : 'WARN', 'still the TODO scaffold', 'write the real notes (they become the GitHub release body AND the in-app UPDATE CENTER text), then `git add RELEASE_NOTES.md && git commit --amend --no-edit` on the release commit (runbook §1.2)'));
    else rows.push(row('notes', 'RELEASE_NOTES.md for ' + (target ? 'v' + target : 'target'), phase === 'post-bump' ? 'FAIL' : 'WARN', 'header is v' + header + (phase === 'pre-bump' ? ' — release-bump rewrites it to a TODO scaffold for the new version' : ''), phase === 'pre-bump' ? 'after the bump: replace the TODO with real notes and amend them into the release commit (runbook §1.2)' : 'write notes for v' + target + ' and amend the release commit'));
  }

  // ── origin drift (informational) ──
  if (branch === TRUNK) {
    const ahead = gitLines(io, ['rev-list', '--count', 'origin/' + TRUNK + '..HEAD']);
    if (ahead && /^\d+$/.test(ahead[0])) rows.push(row('origin', 'trunk vs origin/' + TRUNK, +ahead[0] === 0 ? 'PASS' : 'WARN', +ahead[0] === 0 ? 'in sync' : ahead[0] + ' local commit(s) not on origin', 'push the branch WITH the tag: `git push origin HEAD vX.Y.Z` (the tag alone drives the train; the branch push is what lets the mirror find the commit)'));
  }

  const fails = rows.filter(r => r.status === 'FAIL');
  return { ok: fails.length === 0, phase, target, current, branch, head, rows, fails: fails.length };
}

/* ───────────────────────────── rendering ───────────────────────────── */

const ICON = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' };
export function renderChecklist(result) {
  const out = [];
  out.push('== release-preflight · phase ' + result.phase + ' · target ' + (result.target ? 'v' + result.target : '(none)') + ' · in-tree ' + (result.current || '?') + ' · ' + (result.branch || '?') + ' @ ' + (result.head ? result.head.slice(0, 9) : '?') + ' ==');
  for (const r of result.rows) {
    out.push('[' + ICON[r.status] + '] ' + r.label + (r.detail ? ' — ' + r.detail : ''));
    if (r.fix && r.status !== 'PASS') out.push('       fix: ' + r.fix);
  }
  const counts = ['PASS', 'FAIL', 'WARN', 'SKIP'].map(s => s + ' ' + result.rows.filter(r => r.status === s).length).join(' · ');
  out.push('');
  out.push(result.ok ? 'PREFLIGHT PASS (' + counts + ') — hard rows green; WARN rows are owed and listed above.' : 'PREFLIGHT FAIL (' + counts + ') — ' + result.fails + ' hard row(s) red. Do not bump, do not tag.');
  return out.join('\n');
}

/* ───────────────────────────── io shell + CLI ───────────────────────────── */

export function makeIo(root) {
  const abs = (p) => (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(p) ? p : resolve(root, p));
  return {
    root,
    readText(p) { try { return readFileSync(abs(p), 'utf8'); } catch { return null; } },
    exists(p) { try { return existsSync(abs(p)); } catch { return false; } },
    listDir(p) { try { return readdirSync(abs(p)); } catch { return null; } },
    stat(p) { try { const s = statSync(abs(p)); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } },
    exec(cmd, args) {
      try {
        const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' && cmd === 'gh' });
        return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
      } catch (e) { return { status: null, stdout: '', stderr: '', error: e }; }
    },
    now() { return Date.now(); }
  };
}

export function parseArgs(argv) {
  const out = { version: null, next: null, phase: 'pre-bump', allowLane: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
    if (a.startsWith('--version')) out.version = val();
    else if (a.startsWith('--next')) out.next = val();
    else if (a.startsWith('--phase')) out.phase = val();
    else if (a === '--allow-lane') out.allowLane = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

const INVOKED_DIRECTLY = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; } catch { return false; } })();

if (INVOKED_DIRECTLY) {
  const ROOT = process.env.STARNET_PREFLIGHT_ROOT ? resolve(process.env.STARNET_PREFLIGHT_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const a = parseArgs(process.argv.slice(2));
  const ctx = {
    version: a.version, next: a.next, phase: a.phase, allowLane: a.allowLane,
    keyFile: process.env.STARNET_UPDATER_KEY_FILE || join(homedir(), '.tauri', 'starnet-updater.key')
  };
  let result;
  try { result = runPreflight(ctx, makeIo(ROOT)); }
  catch (e) { process.stderr.write('release-preflight: ' + e.message + '\n'); process.exit(1); }
  process.stdout.write((a.json ? JSON.stringify(result, null, 2) : renderChecklist(result)) + '\n');
  process.exit(result.ok ? 0 : 1);
}
