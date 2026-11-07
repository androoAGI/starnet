import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA = 'starnet.update-canary-receipt.v1';

// Legacy ordinary conversations gain these exact neutral defaults during hydration (frontend/app/workstreams.js make()):
// parentStreamId/projectHome since 0.12.4, and projectRootAt/worker/lastRunReason/pendingJoin since 0.13.5 (a 0.13.3 save
// has none of the four). Only the exact neutral value is dropped; keep non-default values and every other field, so
// lost relationships/content still fail.
const NEUTRAL_WORKSTREAM_DEFAULTS = Object.freeze([
  ['parentStreamId', null], ['projectHome', false],
  ['projectRootAt', null], ['worker', false], ['lastRunReason', ''], ['pendingJoin', null]
]);
export function normalizeLegacyWorkstreamDefaults(streams) {
  if (!Array.isArray(streams)) return streams;
  return streams.map(stream => {
    const result = structuredClone(stream);
    for (const [field, neutral] of NEUTRAL_WORKSTREAM_DEFAULTS) if (result[field] === neutral) delete result[field];
    return result;
  });
}

// Roster hydration since 0.12.5 (security audit 2026-09-23, 97a7b612e): a saved agent colour lands in style
// attributes, so an agent whose save has no valid hex colour is given a crew palette suit instead of carrying
// undefined. Must equal frontend/app/app.js SUITS (test/update-continuity.test.js pins the two together).
export const CREW_SUITS = Object.freeze(['#6fb3bf', '#7bc88a', '#d99a5a', '#a888c0', '#cf7d96', '#ffd34a']);
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

// A copy of the `before` projection in which an agent whose colour was missing or non-hex takes the palette suit
// the upgraded app assigned it (same save, same agent id). A valid colour is never touched, so a real colour
// change, or a missing colour replaced by anything outside the palette, still fails the comparison.
export function adoptAssignedSuitColors(before, after) {
  const out = structuredClone(before);
  for (const key of ['local', 'durable']) {
    const prior = out && out[key], next = after && after[key];
    if (!prior || !next || !Array.isArray(prior.agents) || !Array.isArray(next.agents)) continue;
    for (const agent of prior.agents) {
      if (!agent || HEX_COLOR.test(String(agent.color || ''))) continue;
      const match = next.agents.find(candidate => candidate && candidate.id === agent.id);
      if (match && CREW_SUITS.includes(String(match.color || '').toLowerCase())) agent.color = match.color;
    }
    // the save's top-level lead record gets the same hydration (0.13: the lead with no valid colour is given the
    // lead's gold, which is the palette's last suit) — the same rule, the same palette, nothing else is adopted
    const lead = prior.agent, nextLead = next.agent;
    if (lead && nextLead && lead.id === nextLead.id && !HEX_COLOR.test(String(lead.color || ''))
      && CREW_SUITS.includes(String(nextLead.color || '').toLowerCase())) lead.color = nextLead.color;
  }
  return out;
}

// The station save's schema 1 → 2 step (0.13, frontend/app/worldmodel.js STATION_VERSION): the version number moves
// to 2 and a save with no workflow links gains an EMPTY links list. A copy of `before` that takes exactly that step;
// a station that lost or gained props, or gained real links, still fails the comparison.
export function adoptStationSchemaV2(before, after) {
  const out = structuredClone(before);
  for (const key of ['local', 'durable']) {
    const prior = out && out[key] && out[key].station, next = after && after[key] && after[key].station;
    if (!prior || !next || typeof prior !== 'object' || typeof next !== 'object') continue;
    if (prior.version !== 1 || next.version !== 2) continue;
    prior.version = 2;
    if (prior.links === undefined && Array.isArray(next.links) && next.links.length === 0) prior.links = [];
  }
  return out;
}

// The save's schema 6 -> 7 step (0.15, frontend/app/save.js CURRENT): the version number moves to 7, and a kept history row
// that no turn identity binds yet is marked legacy (frontend/app/turnmerge.js). A copy of `before` that takes exactly that
// step, row by row: a row whose text or any other field changed, or a row lost or gained, still fails the comparison.
export function adoptSaveV7(before, after) {
  const out = structuredClone(before);
  for (const key of ['local', 'durable']) {
    const prior = out && out[key], next = after && after[key];
    if (!prior || !next || prior.version !== 6 || next.version !== 7) continue;
    prior.version = 7;
    for (const stream of Array.isArray(prior.workstreams) ? prior.workstreams : []) {
      const match = stream && Array.isArray(next.workstreams) && next.workstreams.find(candidate => candidate && candidate.id === stream.id);
      if (!match || !Array.isArray(stream.history) || !Array.isArray(match.history)) continue;
      stream.history.forEach((row, i) => {
        const seen = match.history[i];
        if (row && seen && seen.legacy === true && row.legacy === undefined) row.legacy = true;
      });
    }
  }
  return out;
}

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function populatedFixture(nonce, updatedAt = Date.now()) {
  return {
    schema: 'starnet.save', version: 6, updatedAt, prov: 'openrouter', reasoningEffort: 'none',
    agent: { id: 'agent', name: 'CANARY NOVA', purpose: 'prove update continuity', canaryNonce: nonce, provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reasoningEffort: 'none' },
    agents: [
      { id: 'agent', name: 'CANARY NOVA', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reasoningEffort: 'none' },
      { id: 'scout', name: 'CANARY SCOUT', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reasoningEffort: 'none' }
    ],
    station: { floor: 'grid', props: [{ id: 'canary-desk', kind: 'desk', x: 3, y: 4, agentId: 'scout' }] },
    workstreams: [{ id: 'canary-work', title: 'Update continuity', lane: 'active', history: [{ role: 'user', content: 'preserve-' + nonce }] }],
    activeId: 'canary-work', generalId: 'canary-work',
    usage: { tokens: 321, cost: 0.0123, calls: 2 }
  };
}

function projectSave(save) {
  if (!save || typeof save !== 'object') return null;
  return {
    schema: save.schema, version: save.version,
    agent: save.agent,
    agents: save.agents,
    station: save.station,
    workstreams: save.workstreams,
    activeId: save.activeId,
    generalId: save.generalId,
    usage: save.usage
  };
}

export function continuityProjection(snapshot) {
  const local = projectSave(snapshot && snapshot.local);
  const durable = projectSave(snapshot && snapshot.durable);
  return { sentinel: snapshot && snapshot.sentinel || null, local, durable };
}

export function buildReceipt(input) {
  const before = continuityProjection(input.before);
  const after = continuityProjection(input.after);
  return {
    schema: RECEIPT_SCHEMA,
    generatedAt: new Date().toISOString(),
    outcome: 'pass',
    path: input.path || 'latest-to-next',
    versions: { before: String(input.beforeVersion || ''), target: String(input.targetVersion || ''), after: String(input.afterVersion || '') },
    installer: { artifact: input.installerArtifact || '', artifactSha256: input.installerArtifactSha256 || '', processGone: input.installerGone === true },
    relaunch: { observed: input.relaunched === true, installedExeSha256: input.installedExeSha256 || '' },
    state: { beforeFingerprint: fingerprint(before), afterFingerprint: fingerprint(after), equal: stableJson(before) === stableJson(after), projection: after }
  };
}

export function validateReceipt(receipt) {
  const errors = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) errors.push('schema');
  if (!receipt || receipt.outcome !== 'pass') errors.push('outcome');
  const versions = receipt && receipt.versions || {};
  if (!versions.before || !versions.target || versions.target !== versions.after || versions.before === versions.after) errors.push('versions');
  if (!(receipt && receipt.installer && receipt.installer.processGone === true)) errors.push('installer-process');
  if (!/^[a-f0-9]{64}$/.test(String(receipt && receipt.installer && receipt.installer.artifactSha256 || ''))) errors.push('installer-hash');
  if (!(receipt && receipt.relaunch && receipt.relaunch.observed === true)) errors.push('relaunch');
  if (!/^[a-f0-9]{64}$/.test(String(receipt && receipt.relaunch && receipt.relaunch.installedExeSha256 || ''))) errors.push('installed-exe-hash');
  const state = receipt && receipt.state || {};
  if (state.equal !== true || state.beforeFingerprint !== state.afterFingerprint) errors.push('state-parity');
  return { ok: errors.length === 0, errors };
}
