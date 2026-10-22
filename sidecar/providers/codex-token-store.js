/* sidecar/providers/codex-token-store.js - helper for finding persisted Codex OAuth tokens across
   workspace-root migrations. Pure path/load/save orchestration; ambient fs/env are injected by index.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.codexTokenStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function validCodexTokens(raw) {
    return !!(raw && typeof raw === 'object'
      && typeof raw.access_token === 'string'
      && raw.access_token.trim());
  }

  function pathKey(pathMod, file) {
    try { return pathMod.resolve(String(file || '')).toLowerCase(); }
    catch (_) { return String(file || '').toLowerCase(); }
  }

  /* THE KNOWN Agent OS WORKSPACE ROOTS on this machine — the app's own homes across versions and renames.
     A migration only ever crosses BETWEEN these; see isRecognizedWorkspaceRoot. */
  function knownWorkspaceRoots(opts) {
    opts = opts || {};
    const pathMod = opts.pathMod || require('node:path');
    const env = opts.env || {};
    const roots = [];
    const seen = new Set();
    function addRoot(root) {
      if (!root) return;
      const key = pathKey(pathMod, root);
      if (!key || seen.has(key)) return;
      seen.add(key);
      roots.push(String(root));
    }
    if (typeof opts.defaultWorkspaces === 'function') {
      try { addRoot(opts.defaultWorkspaces()); } catch (_) {}
    }
    for (const root of (Array.isArray(opts.legacyWorkspaces) ? opts.legacyWorkspaces : [])) addRoot(root);
    for (const appBase of [env.LOCALAPPDATA, env.APPDATA, env.XDG_DATA_HOME]) {
      if (!appBase) continue;
      addRoot(pathMod.join(appBase, 'Agent OS', 'workspaces'));
      addRoot(pathMod.join(appBase, 'Skynet', 'workspaces'));
      addRoot(pathMod.join(appBase, 'ai.skynet.harness', 'workspaces'));
    }
    if (opts.sidecarDir) {
      addRoot(pathMod.join(opts.sidecarDir, 'workspaces'));
      addRoot(pathMod.join(pathMod.dirname(opts.sidecarDir), 'workspaces'));
    }
    return roots;
  }

  /* ⛔ A CREDENTIAL MUST NOT CROSS AN ISOLATION BOUNDARY. This migration exists so the Commander keeps their
     ChatGPT sign-in when the app's OWN workspace root moves between versions ("Agent OS" <- "Skynet" <-
     "ai.skynet.harness"). It is NOT a licence to copy a live OAuth refresh token into whatever directory
     SKYNET_WORKSPACES happens to point at — and every test boot, dev seed and QA journey points it at a fresh
     temp dir. Two things went wrong at once there: the Commander's real credential was written into
     os.tmpdir(), and a "clean-room" boot silently INHERITED their real ChatGPT sign-in, so a fresh-install
     test was never actually fresh. So: migrate only INTO a root that is one of the app's own known homes.
     The desktop app passes its real workspace root explicitly, so the shipped path is unchanged. */
  function isRecognizedWorkspaceRoot(root, opts) {
    const pathMod = (opts && opts.pathMod) || require('node:path');
    const key = pathKey(pathMod, root);
    if (!key) return false;
    return knownWorkspaceRoots(opts).some(r => pathKey(pathMod, r) === key);
  }

  function candidateCodexTokenFiles(opts) {
    opts = opts || {};
    const pathMod = opts.pathMod || require('node:path');
    const files = [];
    const seen = new Set();

    function addFile(file) {
      if (!file) return;
      const key = pathKey(pathMod, file);
      if (!key || seen.has(key)) return;
      seen.add(key);
      files.push(file);
    }
    function addRoot(root) {
      if (!root) return;
      addFile(pathMod.join(String(root), 'codex', 'tokens.json'));
    }

    addRoot(opts.currentWorkspaces);
    // A workspace root that is not one of the app's own homes is a deliberate isolation boundary (a test, a dev
    // seed, a second station): its OWN codex/tokens.json is still read, but nothing is pulled ACROSS into it.
    if (!isRecognizedWorkspaceRoot(opts.currentWorkspaces, opts)) return files;
    for (const root of knownWorkspaceRoots(opts)) addRoot(root);
    return files;
  }

  // The persisted shape of an explicit ChatGPT logout: no credential fields, just the marker.
  const SIGNED_OUT = Object.freeze({ signedOut: true });
  function isSignedOutTombstone(raw) {
    return !!(raw && typeof raw === 'object' && raw.signedOut === true && !raw.access_token && !raw.refresh_token && !raw.id_token);
  }

  function loadCodexTokensWithMigration(opts) {
    opts = opts || {};
    const currentFile = opts.currentFile;
    const load = opts.load;
    const save = opts.save;
    if (typeof load !== 'function') throw new Error('loadCodexTokensWithMigration requires opts.load');

    const current = load(currentFile, 'codex');
    if (validCodexTokens(current)) return current;
    // An explicit logout leaves a signed-out tombstone here. Never migrate a legacy copy over it: that is exactly
    // the "logged out, restarted, signed back in by itself" resurrection the tombstone exists to stop.
    if (isSignedOutTombstone(current)) return null;

    const pathMod = opts.pathMod || require('node:path');
    const currentKey = pathKey(pathMod, currentFile);
    for (const file of (Array.isArray(opts.candidateFiles) ? opts.candidateFiles : [])) {
      if (!file || pathKey(pathMod, file) === currentKey) continue;
      const raw = load(file, 'codex-legacy');
      if (!validCodexTokens(raw)) continue;
      if (typeof save === 'function') save(currentFile, raw);
      if (typeof opts.onMigrate === 'function') opts.onMigrate(file, currentFile);
      return raw;
    }
    return null;
  }

  // Persist Codex OAuth tokens with READ-BACK PROOF, then RETRY ONCE. Motivation: after codexAuth.refreshTokens()
  // the provider may ROTATE the refresh_token and invalidate the old one; if the write to disk silently fails, a
  // sidecar restart reloads the OLD (now-dead) refresh_token -> forced re-sign-in. So a swallowed write error is a
  // real credential-durability hazard. This helper writes, reads the file BACK, and confirms the refresh_token on
  // disk matches what we intended to store. On mismatch/throw it retries once; if it still can't prove the token
  // reached disk, it returns { ok:false } so the caller can surface an HONEST persist-failure signal AND keep the
  // rotated tokens in memory (this session stays live; the truth-telemetry law forbids pretending it's durable).
  //
  // Pure/injectable: caller passes save(obj) (durable write) + load() (resilient read-back). No ambient I/O here.
  //   opts.save(obj)  -> void (may throw)   persist the token object
  //   opts.load()     -> obj|undefined      read the token object back from disk (resilient loader)
  //   opts.tokens                            the token object we are trying to persist (must carry refresh_token)
  // Returns { ok, attempts, verified, error } — ok true ONLY when the read-back proves the intended refresh_token
  // (and access_token) are on disk. When the token being saved has no refresh_token, access_token alone is proof.
  function persistCodexTokensVerified(opts) {
    opts = opts || {};
    const tokens = opts.tokens || {};
    const save = opts.save, load = opts.load;
    if (typeof save !== 'function' || typeof load !== 'function') {
      return { ok: false, attempts: 0, verified: false, error: 'persistCodexTokensVerified requires save+load' };
    }
    const wantRefresh = String(tokens.refresh_token || '');
    const wantAccess = String(tokens.access_token || '');
    // proof = the durable copy carries the SAME access_token AND (when we have one) the SAME refresh_token. Matching
    // the rotated refresh_token is the whole point: an old refresh_token lingering on disk is the exact bug.
    function onDisk() {
      let raw; try { raw = load(); } catch (_) { return false; }
      if (!raw || typeof raw !== 'object') return false;
      if (wantAccess && String(raw.access_token || '') !== wantAccess) return false;
      if (wantRefresh && String(raw.refresh_token || '') !== wantRefresh) return false;
      return true;
    }
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { save(tokens); } catch (e) { lastErr = (e && e.message) || String(e); }
      if (onDisk()) return { ok: true, attempts: attempt, verified: true, error: '' };
      if (!lastErr) lastErr = 'read-back did not find the intended refresh_token on disk';
    }
    return { ok: false, attempts: 2, verified: false, error: lastErr };
  }

  return { validCodexTokens, knownWorkspaceRoots, isRecognizedWorkspaceRoot, candidateCodexTokenFiles, loadCodexTokensWithMigration, persistCodexTokensVerified, SIGNED_OUT, isSignedOutTombstone };
});
