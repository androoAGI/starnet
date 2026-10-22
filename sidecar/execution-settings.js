/* sidecar/execution-settings.js — normalized owner policy for execution backends.

   This file stores no credentials. SSH authentication stays with the operating system's
   OpenSSH agent/config; Agent OS persists only the destination and remote workspace. */
'use strict';

const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const REMOTE_ROOT_RE = /^\/[A-Za-z0-9._~\/-]{1,500}$/;

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
}

function normalizeTarget(value) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const host = String(value.host || '').trim();
  const user = String(value.user || '').trim();
  const remoteRoot = String(value.remoteRoot || '').trim().replace(/\/+$/, '');
  if (host && !HOST_RE.test(host)) throw new Error('SSH host must be a hostname or configured SSH alias');
  if (user && !USER_RE.test(user)) throw new Error('SSH user contains unsupported characters');
  if (remoteRoot && (!REMOTE_ROOT_RE.test(remoteRoot) || remoteRoot.split('/').indexOf('..') >= 0)) {
    throw new Error('remote workspace must be an absolute POSIX path without spaces or parent traversal');
  }
  const port = clampInt(value.port == null || value.port === '' ? 22 : value.port, 1, 65535, 22);
  return {
    host,
    user,
    port,
    remoteRoot: remoteRoot || '/workspace',
    configured: !!host
  };
}

function normalize(value, defaults) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  defaults = defaults || {};
  const idleDefault = clampInt(defaults.idleCleanupMinutes, 0, 1440, 60);
  const targets = {};
  const rawTargets = value.sshTargets && typeof value.sshTargets === 'object' ? value.sshTargets : {};
  for (const agentId of Object.keys(rawTargets)) {
    if (!AID_RE.test(agentId)) continue;
    try { targets[agentId] = normalizeTarget(rawTargets[agentId]); } catch (_) {}
  }
  return {
    version: 1,
    idleCleanupMinutes: clampInt(value.idleCleanupMinutes, 0, 1440, idleDefault),
    sshTargets: targets
  };
}

function setTarget(settings, agentId, value) {
  if (!AID_RE.test(String(agentId || ''))) throw new Error('bad agentId');
  const next = normalize(settings);
  const target = normalizeTarget(value);
  if (target.configured) next.sshTargets[agentId] = target;
  else delete next.sshTargets[agentId];
  return next;
}

function setIdleCleanupMinutes(settings, value) {
  const next = normalize(settings);
  next.idleCleanupMinutes = clampInt(value, 0, 1440, next.idleCleanupMinutes);
  return next;
}

function targetFor(settings, agentId) {
  const row = normalize(settings).sshTargets[String(agentId || '')];
  return row ? Object.assign({}, row) : normalizeTarget({});
}

module.exports = { normalize, normalizeTarget, setTarget, setIdleCleanupMinutes, targetFor };
