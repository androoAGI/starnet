#!/usr/bin/env node
/* W0 advertised-claims authority.
 *
 * This module is intentionally read-only. It locks the reviewed public surface to exact
 * tracked paths and bytes, verifies every claim locator/authority check, and exposes two
 * independent decisions:
 *   - planning: the finite audit is current and mechanically reproducible;
 *   - terminal: every claim is proven (including required live proof) or visibly labelled
 *     experimental, and every W2-W6 grep-verdict row is closed.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_LEDGER = path.join(REPO_ROOT, 'qa', 'product-perfect', 'claims.json');

export const REQUIRED_DOMAINS = Object.freeze([
  'core', 'work', 'capabilities', 'security', 'recovery',
  'autonomy', 'integrations', 'privacy', 'release'
]);

export const MARKETED_DOCS = Object.freeze([
  'INSTALL.md',
  'PRIVACY.md',
  'README.md',
  'RELEASE_NOTES.md',
  'TERMS.md',
  'docs/DOWNLOAD_PAGE.md',
  'docs/RELEASE_NOTES_v1.0.0_DRAFT.md'
]);

const VERDICTS = new Set(['SHIPPED', 'PARTIAL', 'MISSING', 'REFUTED', 'EXPERIMENTAL']);
const DISPOSITIONS = new Set(['PROVEN', 'FIX', 'COMPLETE', 'NARROW', 'EXPERIMENTAL']);
const LIVE_PROOF = new Set(['NOT_REQUIRED', 'PENDING', 'PROVEN']);
const CHECK_KINDS = new Set(['contains', 'absent']);
const REQUIRED_CLAIM_IDS = Object.freeze([
  'byok-chatgpt-connect',
  'channel-token-keychain',
  'comms-real-workflow',
  'concurrent-agent-runs',
  'crash-safe-forward-corrupt-recovery',
  'curated-mcp-auth-tiers',
  'first-boot-onboarding',
  'free-no-markup-budget-caps',
  'full-backup-export-restore',
  'hallway-authorized-handoff',
  'jailed-open-deliverables',
  'layout-is-workflow',
  'learning-improves-over-time',
  'local-first-no-account',
  'manual-mcp-connect',
  'morning-report',
  'night-patch-safe-branch',
  'night-shift-away-work',
  'no-analytics-telemetry',
  'no-phone-home',
  'object-capability-grant',
  'one-click-estop',
  'one-click-mutation-approval',
  'persisted-real-roster',
  'post-onboarding-base-url',
  'project-bless-revoke',
  'provider-catalog-custom',
  'room-capability-team',
  'routines-visible-unattended',
  'secrets-keychain-never-render',
  'self-update-verified',
  'slack-matrix-signal',
  'telegram-discord-messaging',
  'three-platform-release-pipeline',
  'truthful-tools-cost-work',
  'unified-work-deliverables-ledger',
  'work-after-app-close'
]);
const REQUIRED_EXCEPTION_IDS = Object.freeze([
  'api-version-truth',
  'consent-visibility',
  'degraded-workspace-200',
  'durable-estop-halt',
  'night-beat-leash-pre-spend'
]);
const REQUIRED_WAVE_VERDICT_IDS = Object.freeze([
  'W2-channel-pairing',
  'W2-channel-token-keychain',
  'W2-dns-safe-navigation',
  'W2-link-junction-containment',
  'W2-mcp-mutation-consent',
  'W2-scoped-url-capabilities',
  'W2-secret-free-child-env',
  'W2-zero-boot-egress',
  'W3-cold-boot-recap',
  'W3-settings-base-url',
  'W3-settings-full-export',
  'W3-unified-work-ledger',
  'W4-run-mode-capability-matrix',
  'W5-after-close-continuation',
  'W5-rejected-idea-suppression',
  'W5-unified-composer',
  'W6-real-integration-lifecycle'
]);

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function text(value) { return value == null ? '' : String(value); }
function sortedUnique(values) { return [...new Set(values.map(text).filter(Boolean))].sort(); }
function safeRelative(relative) {
  const normalized = text(relative).replace(/\\/g, '/');
  if (!normalized || /[\0\r\n]/.test(normalized) || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error('unsafe repository-relative path: ' + text(relative));
  }
  return normalized;
}

export function trackedPaths(repoRoot = REPO_ROOT) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot, encoding: 'buffer', windowsHide: true, maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0 || result.error) {
    const detail = result.error ? result.error.message : Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error('could not enumerate tracked source: ' + (detail || 'git ls-files failed'));
  }
  return sortedUnique(Buffer.from(result.stdout || '').toString('utf8').split('\0'));
}

export function discoverReleaseSurface(repoRoot = REPO_ROOT, inputPaths = null) {
  const tracked = inputPaths ? sortedUnique(inputPaths) : trackedPaths(repoRoot);
  const marketed = new Set(MARKETED_DOCS);
  const surface = tracked.filter(relative =>
    (relative.startsWith('frontend/') && /\.(?:css|html|js)$/i.test(relative)) || marketed.has(relative)
  );
  for (const relative of MARKETED_DOCS) {
    if (!tracked.includes(relative)) throw new Error('marketed release document is not tracked: ' + relative);
  }
  return sortedUnique(surface);
}

function git(repoRoot, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: options.encoding === 'buffer' ? null : (options.encoding || 'utf8'),
    input: options.input,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024
  });
  if (result.status !== 0 || result.error) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : text(result.stderr).trim();
    throw new Error(result.error ? result.error.message : (stderr || 'git command failed'));
  }
  return result.stdout;
}

const RESOLVED_COMMITS = new Map();

export function resolveCandidateCommit(repoRoot = REPO_ROOT, candidate = 'HEAD') {
  const requested = text(candidate || 'HEAD').trim();
  const cacheKey = path.resolve(repoRoot) + '\0' + requested;
  const exactRequested = /^[0-9a-f]{40}$/i.test(requested);
  if (exactRequested && RESOLVED_COMMITS.has(cacheKey)) return RESOLVED_COMMITS.get(cacheKey);
  const resolved = text(git(repoRoot, ['rev-parse', '--verify', requested + '^{commit}'])).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(resolved)) throw new Error('candidate did not resolve to an exact commit');
  if (exactRequested && requested.toLowerCase() !== resolved) {
    throw new Error('injected candidate mismatch: requested object is not the resolved commit');
  }
  if (exactRequested) RESOLVED_COMMITS.set(cacheKey, resolved);
  RESOLVED_COMMITS.set(path.resolve(repoRoot) + '\0' + resolved, resolved);
  return resolved;
}

const TRACKED_AT_COMMIT = new Map();
const BLOB_AT_COMMIT = new Map();
const BLOB_BY_OID = new Map();

export function trackedPathsAtCommit(repoRoot = REPO_ROOT, candidateCommit = 'HEAD') {
  const commit = resolveCandidateCommit(repoRoot, candidateCommit);
  const key = path.resolve(repoRoot) + '\0' + commit;
  if (!TRACKED_AT_COMMIT.has(key)) {
    const output = git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', commit], { encoding: 'buffer' });
    TRACKED_AT_COMMIT.set(key, sortedUnique(Buffer.from(output || '').toString('utf8').split('\0')));
  }
  return [...TRACKED_AT_COMMIT.get(key)];
}

function readAtCommit(repoRoot, candidateCommit, relative) {
  const commit = resolveCandidateCommit(repoRoot, candidateCommit);
  const safe = safeRelative(relative);
  const key = path.resolve(repoRoot) + '\0' + commit + '\0' + safe;
  if (!BLOB_AT_COMMIT.has(key)) preloadAtCommit(repoRoot, commit, [safe]);
  // Internal readers only hash/search/parse these bytes; they never mutate them.
  return BLOB_AT_COMMIT.get(key);
}

function preloadAtCommit(repoRoot, candidateCommit, relativePaths) {
  const commit = resolveCandidateCommit(repoRoot, candidateCommit);
  const root = path.resolve(repoRoot);
  const missing = sortedUnique(relativePaths).map(safeRelative).filter(relative => !BLOB_AT_COMMIT.has(root + '\0' + commit + '\0' + relative));
  if (!missing.length) return;
  const input = missing.map(relative => commit + ':' + relative).join('\n') + '\n';
  // Prefix audits include binary assets. Read their sizes first so growth of the
  // checked surface never overflows one aggregate stdout buffer or drops a path.
  const headers = text(git(repoRoot, ['cat-file', '--batch-check'], { input })).trimEnd().split('\n');
  if (headers.length !== missing.length) throw new Error('git cat-file size batch returned an unexpected record count');
  const rows = missing.map((relative, index) => {
    const header = headers[index], match = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(header);
    if (!match) throw new Error('git cat-file could not read ' + relative + ': ' + header);
    const size = Number(match[2]), bytes = size + Buffer.byteLength(header) + 2;
    if (!Number.isSafeInteger(bytes)) throw new Error('git cat-file blob size is unsupported for ' + relative);
    return { relative, oid: match[1], size, bytes, header };
  });
  const BATCH_BYTES = 16 * 1024 * 1024;
  const readBatch = batch => {
    const expectedBytes = batch.reduce((sum, row) => sum + row.bytes, 0);
    // A single large blob gets its exact declared capacity; normal batches stay
    // bounded. The object IDs are immutable and verified again in the payload.
    const output = Buffer.from(git(repoRoot, ['cat-file', '--batch'], {
      encoding: 'buffer', input: batch.map(row => row.oid).join('\n') + '\n',
      maxBuffer: Math.max(BATCH_BYTES, expectedBytes)
    }));
    let offset = 0;
    for (const row of batch) {
      const lineEnd = output.indexOf(0x0a, offset);
      if (lineEnd < 0) throw new Error('git cat-file batch ended before ' + row.relative);
      const header = output.subarray(offset, lineEnd).toString('utf8');
      if (header !== row.header) throw new Error('git cat-file payload disagrees with size record for ' + row.relative);
      const start = lineEnd + 1, end = start + row.size;
      if (end >= output.length || output[end] !== 0x0a) throw new Error('git cat-file returned truncated bytes for ' + row.relative);
      const bytes = Buffer.from(output.subarray(start, end));
      BLOB_BY_OID.set(row.oid, bytes);
      BLOB_AT_COMMIT.set(root + '\0' + commit + '\0' + row.relative, bytes);
      offset = end + 1;
    }
    if (offset !== output.length) throw new Error('git cat-file batch returned unexpected trailing bytes');
  };
  let batch = [], bytes = 0;
  for (const row of rows) {
    // Every path is still resolved by Git above. Identical immutable objects can
    // share bytes across candidate commits and temporary comparator repositories.
    const cached = BLOB_BY_OID.get(row.oid);
    if (cached) {
      if (cached.length !== row.size) throw new Error('git blob size changed for ' + row.relative);
      BLOB_AT_COMMIT.set(root + '\0' + commit + '\0' + row.relative, cached);
      continue;
    }
    if (batch.length && bytes + row.bytes > BATCH_BYTES) { readBatch(batch); batch = []; bytes = 0; }
    batch.push(row); bytes += row.bytes;
  }
  if (batch.length) readBatch(batch);
}

function isAncestor(repoRoot, sourceCommit, candidateCommit) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', sourceCommit, candidateCommit], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(text(result.stderr).trim() || 'git merge-base failed');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function authorityDigests(ledger) {
  const surface = ledger && ledger.releaseSurface;
  return {
    manifestDigest: sha256(canonicalJson(ledger)),
    surfaceDigest: sha256(canonicalJson(surface ? {
      algorithm: surface.algorithm,
      pathSetSha256: surface.pathSetSha256,
      files: surface.files
    } : null))
  };
}

export function buildReleaseSurface(repoRoot = REPO_ROOT, options = {}) {
  const requested = typeof options === 'string' ? options : options.candidateCommit;
  const sourceCommit = resolveCandidateCommit(repoRoot, requested || 'HEAD');
  const tracked = trackedPathsAtCommit(repoRoot, sourceCommit);
  const releasePaths = discoverReleaseSurface(repoRoot, tracked);
  preloadAtCommit(repoRoot, sourceCommit, releasePaths);
  const files = releasePaths.map(relative => {
    const bytes = readAtCommit(repoRoot, sourceCommit, relative);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    algorithm: 'sha256',
    sourceCommit,
    pathSetSha256: sha256(files.map(row => row.path).join('\n') + '\n'),
    files
  };
}

function defaultRead(repoRoot, relative) {
  return fs.readFileSync(path.join(repoRoot, ...safeRelative(relative).split('/')));
}

function validateRefs(refs, label, errors) {
  if (!Array.isArray(refs) || refs.some(ref => !text(ref).trim())) {
    errors.push(label + '.refsChecked must be non-blank strings');
    return;
  }
  if (!refs.some(ref => /^trunk@/i.test(ref))) errors.push(label + '.refsChecked must record the trunk audit');
  if (!refs.some(ref => /^branches@/i.test(ref))) errors.push(label + '.refsChecked must record the unmerged-branch audit');
  if (!refs.some(ref => /^worktrees@/i.test(ref))) errors.push(label + '.refsChecked must record the live/stale-worktree audit');
}

function validateCheck(check, label, errors) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    errors.push(label + ' must be an object');
    return;
  }
  if (!CHECK_KINDS.has(check.kind)) errors.push(label + '.kind must be contains or absent');
  const hasPath = !!text(check.path).trim();
  const hasPaths = Array.isArray(check.paths) && check.paths.length > 0 && check.paths.every(item => text(item).trim());
  if (!hasPath && !hasPaths) errors.push(label + '.path or .paths is required');
  if (hasPath && hasPaths) errors.push(label + ' must use path or paths, not both');
  try {
    if (hasPath) safeRelative(check.path);
    if (hasPaths) check.paths.forEach(item => safeRelative(item));
  } catch (error) { errors.push(label + ' ' + error.message); }
  if (check.kind === 'contains' && !text(check.needle).length) errors.push(label + '.needle is required');
  if (check.kind === 'absent' && (!Array.isArray(check.needles) || !check.needles.length || check.needles.some(item => !text(item).length))) {
    errors.push(label + '.needles must contain literal absence probes');
  }
}

function validateAuthorityRow(row, label, errors) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    errors.push(label + ' must be an object');
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text(row.id))) errors.push(label + '.id is invalid');
  if (!VERDICTS.has(row.verdict)) errors.push(label + '.verdict is invalid');
  if (!DISPOSITIONS.has(row.disposition)) errors.push(label + '.disposition is invalid');
  if (!/^W[0-7]$/.test(text(row.ownerWave || row.wave))) errors.push(label + '.ownerWave/wave must be W0-W7');
  if (!text(row.qualification).trim()) errors.push(label + '.qualification is required');
  if (!Array.isArray(row.authorityChecks) || !row.authorityChecks.length) errors.push(label + '.authorityChecks are required');
  else row.authorityChecks.forEach((check, index) => validateCheck(check, label + '.authorityChecks[' + index + ']', errors));
  validateRefs(row.refsChecked, label, errors);
}

export function validateClaimsLedger(ledger, _options = {}) {
  const errors = [];
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return { ok: false, errors: ['claims ledger must be an object'] };
  if (ledger.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (ledger.authority !== 'StarNet advertised claims') errors.push('authority must be StarNet advertised claims');
  if (!/^[0-9a-f]{40}$/i.test(text(ledger.auditBaseSha))) errors.push('auditBaseSha must be an exact commit');
  if (!Array.isArray(ledger.requiredDomains) || JSON.stringify(ledger.requiredDomains) !== JSON.stringify(REQUIRED_DOMAINS)) {
    errors.push('requiredDomains must preserve the locked complete domain set');
  }
  const surface = ledger.releaseSurface;
  if (!surface || typeof surface !== 'object' || Array.isArray(surface)) errors.push('releaseSurface is required');
  else {
    if (surface.algorithm !== 'sha256') errors.push('releaseSurface.algorithm must be sha256');
    if (!/^[0-9a-f]{40}$/i.test(text(surface.sourceCommit))) errors.push('releaseSurface.sourceCommit must be an exact accepted source snapshot commit');
    if (!/^[0-9a-f]{64}$/i.test(text(surface.pathSetSha256))) errors.push('releaseSurface.pathSetSha256 is required');
    if (!Array.isArray(surface.files) || surface.files.length < 1) errors.push('releaseSurface.files are required');
    else {
      const paths = surface.files.map(row => row && row.path);
      if (JSON.stringify(paths) !== JSON.stringify(sortedUnique(paths))) errors.push('releaseSurface.files must be unique and path-sorted');
      for (let index = 0; index < surface.files.length; index += 1) {
        const row = surface.files[index] || {};
        const label = 'releaseSurface.files[' + index + ']';
        try { safeRelative(row.path); } catch (error) { errors.push(label + '.path ' + error.message); }
        if (!Number.isInteger(row.bytes) || row.bytes < 0) errors.push(label + '.bytes must be a non-negative integer');
        if (!/^[0-9a-f]{64}$/i.test(text(row.sha256))) errors.push(label + '.sha256 is invalid');
      }
    }
  }

  if (!Array.isArray(ledger.claims) || ledger.claims.length < 28 || ledger.claims.length > 37) {
    errors.push('claims must contain 28-37 normalized material families');
  } else {
    if (ledger.expectedClaimCount !== ledger.claims.length) errors.push('expectedClaimCount must equal claims.length');
    const ids = new Set();
    const domains = new Set();
    ledger.claims.forEach((claim, index) => {
      const label = 'claims[' + index + ']';
      validateAuthorityRow(claim, label, errors);
      if (ids.has(claim.id)) errors.push(label + '.id is duplicated: ' + claim.id);
      ids.add(claim.id);
      if (!REQUIRED_DOMAINS.includes(claim.domain)) errors.push(label + '.domain is invalid');
      domains.add(claim.domain);
      if (!text(claim.claim).trim()) errors.push(label + '.claim is required');
      if (!Array.isArray(claim.surfaceLocators) || !claim.surfaceLocators.length) errors.push(label + '.surfaceLocators are required');
      else claim.surfaceLocators.forEach((locator, locatorIndex) => {
        const locatorLabel = label + '.surfaceLocators[' + locatorIndex + ']';
        if (!locator || typeof locator !== 'object' || !text(locator.path).trim() || !text(locator.needle).length) {
          errors.push(locatorLabel + ' requires path and literal needle');
        } else {
          try { safeRelative(locator.path); } catch (error) { errors.push(locatorLabel + '.path ' + error.message); }
        }
      });
      if (typeof claim.liveProofRequired !== 'boolean') errors.push(label + '.liveProofRequired must be boolean');
      if (!LIVE_PROOF.has(claim.liveProof)) errors.push(label + '.liveProof is invalid');
      if (!claim.liveProofRequired && claim.liveProof === 'PENDING') errors.push(label + '.liveProof cannot be PENDING when not required');
      if (claim.disposition === 'EXPERIMENTAL') {
        const exp = claim.experimentalLabel;
        if (!exp || typeof exp !== 'object' || typeof exp.visible !== 'boolean') errors.push(label + '.experimentalLabel visibility is required');
        else {
          validateCheck(exp.check, label + '.experimentalLabel.check', errors);
          if (exp.visible === true && exp.check && exp.check.kind !== 'contains') errors.push(label + '.experimentalLabel must use a present point-of-use check when visible');
          if (exp.visible === true && exp.check && (
            typeof exp.check.path !== 'string' ||
            !/^frontend\/.+\.(?:css|html|js)$/i.test(exp.check.path)
          )) errors.push(label + '.experimentalLabel visible check must target frontend HTML, JS, or CSS at point of use');
          if (exp.visible === false && exp.check && exp.check.kind !== 'absent') errors.push(label + '.experimentalLabel must use an absence check while not visible');
        }
      }
    });
    if (JSON.stringify(sortedUnique([...ids])) !== JSON.stringify([...REQUIRED_CLAIM_IDS].sort())) {
      errors.push('claims must contain the exact reviewed material-family inventory');
    }
    for (const domain of REQUIRED_DOMAINS) if (!domains.has(domain)) errors.push('required claim domain is missing: ' + domain);
  }

  if (!Array.isArray(ledger.waveVerdicts)) errors.push('waveVerdicts are required');
  else {
    const ids = ledger.waveVerdicts.map(row => row && row.id);
    if (ids.length !== new Set(ids).size) errors.push('waveVerdict IDs must be unique');
    ledger.waveVerdicts.forEach((row, index) => {
      const label = 'waveVerdicts[' + index + ']';
      validateAuthorityRow(row, label, errors);
      if (row && row.wave !== text(row.id).slice(0, 2)) errors.push(label + '.wave must match the ID prefix');
      if (!text(row.item).trim()) errors.push(label + '.item is required');
    });
    const actual = sortedUnique(ids);
    if (JSON.stringify(actual) !== JSON.stringify([...REQUIRED_WAVE_VERDICT_IDS].sort())) {
      errors.push('waveVerdicts must contain the exact reviewed W2-W6 matrix');
    }
  }

  if (!Array.isArray(ledger.doNotRebuild)) errors.push('doNotRebuild exceptions are required');
  else {
    const ids = ledger.doNotRebuild.map(row => row && row.id);
    if (ids.length !== new Set(ids).size) errors.push('doNotRebuild IDs must be unique');
    ledger.doNotRebuild.forEach((row, index) => {
      const label = 'doNotRebuild[' + index + ']';
      validateAuthorityRow(row, label, errors);
      if (row && row.action !== 'DO_NOT_REBUILD') errors.push(label + '.action must be DO_NOT_REBUILD');
      if (row && (row.verdict !== 'SHIPPED' || row.disposition !== 'PROVEN')) errors.push(label + ' must remain SHIPPED/PROVEN');
    });
    if (JSON.stringify(sortedUnique(ids)) !== JSON.stringify([...REQUIRED_EXCEPTION_IDS].sort())) {
      errors.push('doNotRebuild must contain the five locked exceptions');
    }
  }
  return { ok: errors.length === 0, errors };
}

function checkTargets(check, allTracked) {
  if (check.path) return [safeRelative(check.path)];
  if (Array.isArray(check.paths)) {
    const prefixes = check.paths.map(item => safeRelative(item));
    return (allTracked || []).filter(relative => prefixes.some(prefix => relative === prefix || relative.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')));
  }
  return [];
}

function verificationPaths(ledger, allTracked) {
  const paths = [];
  const addChecks = rows => {
    for (const row of rows || []) {
      for (const check of row.authorityChecks || []) paths.push(...checkTargets(check, allTracked));
    }
  };
  for (const row of (ledger.releaseSurface && ledger.releaseSurface.files) || []) paths.push(row.path);
  for (const claim of ledger.claims || []) {
    for (const locator of claim.surfaceLocators || []) paths.push(locator.path);
    if (claim.disposition === 'EXPERIMENTAL' && claim.experimentalLabel && claim.experimentalLabel.check) {
      paths.push(...checkTargets(claim.experimentalLabel.check, allTracked));
    }
  }
  addChecks(ledger.claims);
  addChecks(ledger.waveVerdicts);
  addChecks(ledger.doNotRebuild);
  return sortedUnique(paths);
}

// Git snapshot buffers are immutable. Cache only search booleans, never decoded artwork;
// injected readers stay uncached so a changed fixture cannot inherit an earlier verdict.
function observeCheck(bytes, check) {
  const needles = check.kind === 'contains' ? [check.needle] : check.needles.map(n => text(n).toLowerCase());
  // Non-ASCII case folding can depend on adjacent letters (e.g. final sigma).
  // Keep the original whole-string semantics for that uncommon check shape.
  if (needles.some(n => /[^\x00-\x7f]/.test(n))) {
    const value = bytes.toString('utf8');
    const contents = check.kind === 'absent' ? value.toLowerCase() : value;
    return needles.map(n => contents.includes(n));
  }
  const found = needles.map(() => false), decoder = new TextDecoder('utf-8');
  const overlap = Math.max(0, ...needles.map(n => n.length - 1));
  let tail = '';
  // Texture packs are in prefix scopes too. Decode bounded chunks, once per
  // check, rather than allocating a whole-asset lowercase string per needle.
  for (let offset = 0; offset < bytes.length || offset === 0; offset += 1024 * 1024) {
    const end = Math.min(bytes.length, offset + 1024 * 1024);
    let chunk = decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length });
    if (check.kind === 'absent') chunk = chunk.toLowerCase();
    const contents = tail + chunk;
    needles.forEach((needle, i) => { if (!found[i] && contents.includes(needle)) found[i] = true; });
    if (found.every(Boolean)) break;
    tail = overlap ? contents.slice(-overlap) : '';
  }
  return found;
}
function verifyCheck(check, bytes, label, errors, target, hits) {
  const key = JSON.stringify([check.kind, check.needle, check.needles]);
  let found = hits.get(key);
  if (!found) { found = observeCheck(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), check); hits.set(key, found); }
  if (check.kind === 'contains' && !found[0]) errors.push(label + ' locator missing in ' + target + ': ' + JSON.stringify(check.needle));
  if (check.kind === 'absent') for (const [i, needle] of check.needles.entries()) {
    if (found[i]) errors.push(label + ' absence escaped in ' + target + ': ' + JSON.stringify(needle));
  }
}

const CHECKS_BY_BLOB = new WeakMap();
export function verifyAuthorityChecks(requests, readFile, errors, allTracked, immutable = false) {
  const byTarget = new Map();
  for (const { check, label } of requests) {
    const targets = checkTargets(check, allTracked);
    if (!targets.length) errors.push(label + ' scope matched no tracked files');
    for (const target of targets) {
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push({ check, label });
    }
  }
  for (const [target, checks] of byTarget) {
    let bytes;
    try { bytes = readFile(target); }
    catch (error) {
      for (const { label } of checks) errors.push(label + ' unreadable ' + target + ': ' + error.message);
      continue;
    }
    const cacheable = immutable && Buffer.isBuffer(bytes);
    const hits = cacheable && CHECKS_BY_BLOB.get(bytes) || new Map();
    for (const { check, label } of checks) verifyCheck(check, bytes, label, errors, target, hits);
    if (cacheable) CHECKS_BY_BLOB.set(bytes, hits);
  }
}

function terminalEligible(row) {
  if (row.disposition === 'EXPERIMENTAL') {
    const label = row.experimentalLabel;
    return row.verdict === 'EXPERIMENTAL' && label && label.visible === true &&
      label.check && label.check.kind === 'contains' &&
      /^frontend\/.+\.(?:css|html|js)$/i.test(text(label.check.path));
  }
  return row.disposition === 'PROVEN' && row.verdict === 'SHIPPED';
}

export function inspectClaimsAuthority(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const planningReasons = [];
  const injectedCandidate = options.candidateCommit || options.currentCommit;
  if (options.candidateCommit && options.currentCommit && text(options.candidateCommit).toLowerCase() !== text(options.currentCommit).toLowerCase()) {
    planningReasons.push('injected candidate mismatch: candidateCommit and currentCommit disagree');
  }
  let candidateCommit = null;
  try { candidateCommit = resolveCandidateCommit(repoRoot, injectedCandidate || 'HEAD'); }
  catch (error) { planningReasons.push((injectedCandidate ? 'injected candidate mismatch: ' : 'candidate commit unreadable: ') + error.message); }

  let candidateLedgerBytes = null;
  let candidateLedger = null;
  if (candidateCommit) {
    try {
      candidateLedgerBytes = readAtCommit(repoRoot, candidateCommit, 'qa/product-perfect/claims.json');
      candidateLedger = JSON.parse(candidateLedgerBytes.toString('utf8'));
    } catch (error) { planningReasons.push('candidate claims ledger unreadable: ' + error.message); }
  }
  const candidateLedgerSha256 = candidateLedgerBytes ? sha256(candidateLedgerBytes) : null;
  const candidateLedgerDigest = candidateLedger ? sha256(canonicalJson(candidateLedger)) : null;
  const hasLedgerObject = Object.prototype.hasOwnProperty.call(options, 'ledger');
  const hasLedgerBytes = Object.prototype.hasOwnProperty.call(options, 'ledgerBytes');
  const hasLedgerPath = Object.prototype.hasOwnProperty.call(options, 'ledgerPath');
  const testOnlyOverride = options.testOnlyLedgerOverride === 'TEST_ONLY_UNCOMMITTED_LEDGER_FIXTURE';
  let ledger = candidateLedger;
  let ledgerSource = 'candidate-git-blob';

  if (hasLedgerObject || hasLedgerBytes || hasLedgerPath) {
    if (testOnlyOverride) {
      try {
        if ([hasLedgerObject, hasLedgerBytes, hasLedgerPath].filter(Boolean).length !== 1) {
          throw new Error('test-only ledger override requires exactly one fixture source');
        }
        if (hasLedgerObject) ledger = options.ledger;
        else if (hasLedgerBytes) ledger = JSON.parse(Buffer.from(options.ledgerBytes).toString('utf8'));
        else ledger = JSON.parse(fs.readFileSync(options.ledgerPath, 'utf8'));
        ledgerSource = 'test-only-uncommitted-fixture';
      } catch (error) { planningReasons.push('test-only ledger fixture unreadable: ' + error.message); }
    } else {
      if (hasLedgerPath) planningReasons.push('ambient ledgerPath overrides are forbidden; the candidate Git blob is authoritative');
      if (hasLedgerBytes) {
        try {
          const injectedBytes = Buffer.from(options.ledgerBytes);
          if (!candidateLedgerBytes || !injectedBytes.equals(candidateLedgerBytes)) {
            planningReasons.push('injected ledger bytes do not match the candidate Git blob');
          }
        } catch (error) { planningReasons.push('injected ledger bytes are unreadable: ' + error.message); }
      }
      if (hasLedgerObject) {
        try {
          const injectedDigest = sha256(canonicalJson(options.ledger));
          if (!candidateLedgerDigest || injectedDigest !== candidateLedgerDigest) {
            planningReasons.push('injected ledger object does not match the candidate Git blob');
          }
        } catch (error) { planningReasons.push('injected ledger object is unreadable: ' + error.message); }
      }
      ledger = candidateLedger;
    }
  }

  const schema = validateClaimsLedger(ledger, { repoRoot });
  planningReasons.push(...schema.errors);
  const sourceCommit = ledger && ledger.releaseSurface ? text(ledger.releaseSurface.sourceCommit).toLowerCase() : null;
  let resolvedSource = null;
  if (sourceCommit && /^[0-9a-f]{40}$/.test(sourceCommit)) {
    try { resolvedSource = resolveCandidateCommit(repoRoot, sourceCommit); }
    catch (error) { planningReasons.push('release surface source commit unreadable: ' + error.message); }
  }
  if (candidateCommit && resolvedSource) {
    try {
      const ancestor = options.isAncestor
        ? options.isAncestor(resolvedSource, candidateCommit)
        : isAncestor(repoRoot, resolvedSource, candidateCommit);
      if (!ancestor) planningReasons.push('release surface source commit is not an ancestor of the candidate');
    } catch (error) { planningReasons.push('release surface ancestry unreadable: ' + error.message); }
  }
  const readFile = options.readFile || (candidateCommit
    ? (relative => readAtCommit(repoRoot, candidateCommit, relative))
    : (relative => defaultRead(repoRoot, relative)));
  let allTracked = [];
  try {
    allTracked = options.trackedPaths
      ? sortedUnique(options.trackedPaths)
      : (candidateCommit ? trackedPathsAtCommit(repoRoot, candidateCommit) : trackedPaths(repoRoot));
  }
  catch (error) { planningReasons.push('tracked source unreadable: ' + error.message); }
  let surfacePaths = [];
  try { surfacePaths = options.surfacePaths ? sortedUnique(options.surfacePaths) : discoverReleaseSurface(repoRoot, allTracked); }
  catch (error) { planningReasons.push('release surface unreadable: ' + error.message); }
  if (!options.readFile && candidateCommit && schema.ok) {
    try { preloadAtCommit(repoRoot, candidateCommit, verificationPaths(ledger, allTracked)); }
    catch (error) { planningReasons.push('candidate source unreadable: ' + error.message); }
  }

  if (schema.ok && ledger.releaseSurface) {
    const lockedPaths = ledger.releaseSurface.files.map(row => row.path);
    if (JSON.stringify(surfacePaths) !== JSON.stringify(lockedPaths)) planningReasons.push('release surface path-set changed; re-audit required');
    const pathSetHash = sha256(lockedPaths.join('\n') + '\n');
    if (pathSetHash !== ledger.releaseSurface.pathSetSha256) planningReasons.push('release surface path-set hash mismatch');
    if (!options.skipSurfaceHashes) {
      for (const row of ledger.releaseSurface.files) {
        let bytes;
        try { bytes = Buffer.from(readFile(row.path)); }
        catch (error) { planningReasons.push('release surface unreadable ' + row.path + ': ' + error.message); continue; }
        if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) planningReasons.push('release surface bytes changed: ' + row.path);
      }
    }
    const locked = new Set(lockedPaths);
    const checks = [];
    const verifyCheck = (check, _readFile, label) => checks.push({ check, label });
    for (const claim of ledger.claims) {
      for (let index = 0; index < claim.surfaceLocators.length; index += 1) {
        const locator = claim.surfaceLocators[index];
        const label = claim.id + '.surfaceLocators[' + index + ']';
        if (!locked.has(locator.path)) planningReasons.push(label + ' is outside the locked release surface: ' + locator.path);
        verifyCheck({ kind: 'contains', path: locator.path, needle: locator.needle }, readFile, label, planningReasons, allTracked);
      }
      claim.authorityChecks.forEach((check, index) => verifyCheck(check, readFile, claim.id + '.authorityChecks[' + index + ']', planningReasons, allTracked));
      if (claim.disposition === 'EXPERIMENTAL') verifyCheck(claim.experimentalLabel.check, readFile, claim.id + '.experimentalLabel', planningReasons, allTracked);
    }
    for (const row of ledger.waveVerdicts) row.authorityChecks.forEach((check, index) => verifyCheck(check, readFile, row.id + '.authorityChecks[' + index + ']', planningReasons, allTracked));
    for (const row of ledger.doNotRebuild) row.authorityChecks.forEach((check, index) => verifyCheck(check, readFile, row.id + '.authorityChecks[' + index + ']', planningReasons, allTracked));
    verifyAuthorityChecks(checks, readFile, planningReasons, allTracked, !options.readFile && !!candidateCommit);
  }

  const uniquePlanningReasons = sortedUnique(planningReasons);
  const planning = { ok: uniquePlanningReasons.length === 0, status: uniquePlanningReasons.length ? 'BLOCKED' : 'PASS', reasons: uniquePlanningReasons };
  const terminalReasons = [];
  if (!planning.ok) terminalReasons.push('claims planning authority is blocked');
  else {
    for (const claim of ledger.claims) {
      if (!terminalEligible(claim)) terminalReasons.push('claim ' + claim.id + ' remains ' + claim.verdict + '/' + claim.disposition);
      if (claim.liveProofRequired && claim.liveProof !== 'PROVEN') terminalReasons.push('claim ' + claim.id + ' live proof is ' + claim.liveProof);
    }
    for (const row of ledger.waveVerdicts) {
      if (!terminalEligible(row)) terminalReasons.push('wave verdict ' + row.id + ' remains ' + row.verdict + '/' + row.disposition);
    }
  }
  const uniqueTerminalReasons = sortedUnique(terminalReasons);
  const digests = authorityDigests(ledger);
  return {
    planning,
    terminal: { ok: uniqueTerminalReasons.length === 0, status: uniqueTerminalReasons.length ? 'BLOCKED' : 'PASS', reasons: uniqueTerminalReasons },
    candidateCommit,
    sourceCommit: resolvedSource || sourceCommit,
    ledgerSource,
    candidateLedgerSha256,
    candidateLedgerDigest,
    manifestDigest: digests.manifestDigest,
    surfaceDigest: digests.surfaceDigest,
    summary: {
      claims: ledger && Array.isArray(ledger.claims) ? ledger.claims.length : 0,
      releaseSurfaceFiles: ledger && ledger.releaseSurface && Array.isArray(ledger.releaseSurface.files) ? ledger.releaseSurface.files.length : 0,
      waveVerdicts: ledger && Array.isArray(ledger.waveVerdicts) ? ledger.waveVerdicts.length : 0,
      doNotRebuild: ledger && Array.isArray(ledger.doNotRebuild) ? ledger.doNotRebuild.length : 0
    }
  };
}

function render(selected, mode, summary) {
  const lines = [];
  lines.push(selected.status + ' claims ' + mode + ' authority Â· ' + summary.claims + ' claims Â· ' + summary.releaseSurfaceFiles + ' locked surface files');
  const limit = 12;
  for (const reason of selected.reasons.slice(0, limit)) lines.push('  - ' + reason);
  if (selected.reasons.length > limit) lines.push('  - â€¦ +' + (selected.reasons.length - limit) + ' more');
  return lines.join('\n');
}

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
  catch (_) { return false; }
})();

if (INVOKED_DIRECTLY) {
  const args = process.argv.slice(2);
  if (args.includes('--refresh-surface')) {
    // Read-only by design: callers review/apply this stdout payload explicitly.
    const candidateIndex = args.indexOf('--candidate');
    if (candidateIndex >= 0 && !args[candidateIndex + 1]) throw new Error('--candidate requires an exact commit');
    const candidateCommit = candidateIndex >= 0 ? args[candidateIndex + 1] : null;
    console.log(JSON.stringify(buildReleaseSurface(REPO_ROOT, { candidateCommit }), null, 2));
    process.exit(0);
  }
  const mode = args.includes('--terminal') ? 'terminal' : 'planning';
  const result = inspectClaimsAuthority();
  const selected = result[mode];
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : render(selected, mode, result.summary));
  process.exit(selected.ok ? 0 : 2);
}
