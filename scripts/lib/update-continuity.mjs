import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA = 'starnet.update-canary-receipt.v1';

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
