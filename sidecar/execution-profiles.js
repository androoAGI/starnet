/* sidecar/execution-profiles.js — honest, persisted execution envelopes.

   An execution profile answers WHERE and WITH WHAT SCOPE an agent works. It is deliberately
   separate from approvalMode (whether the Commander is asked before a risky call) and from the
   host-minted physical-desktop lease. Keeping those axes independent prevents the old "Full
   Access" label from claiming capabilities or machine control that the run did not actually have.

   Older rosters have no executionProfile. Derivation mirrors their real runtime instead of
   rewriting the store on load: Docker boots derive Safe Cell; local Full Access derives This
   Computer; ordinary local agents derive Trusted Project. The next normal roster save persists the
   derived id. */
'use strict';

const IDS = Object.freeze(['safe-cell', 'remote-ssh', 'trusted-project', 'this-computer']);
const VALID_IDS = Object.freeze(['station-gear'].concat(IDS));

const PROFILES = Object.freeze({
  'station-gear': Object.freeze({
    id: 'station-gear', label: 'STATION GEAR', backend: 'current',
    filesystemScope: 'station-grants',
    filesystemLabel: 'Placed gear + approved project folders',
    capabilityObjects: Object.freeze([]),
    connectors: false,
    physicalDesktop: 'lease-required',
    description: 'Compatibility profile for existing stations. Capability objects on the floor remain the only tool grants.'
  }),
  'safe-cell': Object.freeze({
    id: 'safe-cell', label: 'SAFE CELL', backend: 'docker',
    filesystemScope: 'agent-workspace',
    filesystemLabel: 'Agent workspace only',
    capabilityObjects: Object.freeze(['computer', 'cabinet', 'workbench']),
    connectors: false,
    physicalDesktop: 'never',
    description: 'Runs terminal and file work inside the isolated agent workspace. Connected services stay off unless a station prop grants them.'
  }),
  'remote-ssh': Object.freeze({
    id: 'remote-ssh', label: 'REMOTE SSH', backend: 'ssh',
    filesystemScope: 'agent-workspace',
    filesystemLabel: 'Agent workspace synchronized to the configured remote host',
    capabilityObjects: Object.freeze(['computer', 'cabinet', 'workbench']),
    connectors: true,
    physicalDesktop: 'never',
    description: 'Runs terminal work on the owner-configured SSH host. The local agent workspace is pushed before each command and pulled back afterward.'
  }),
  'trusted-project': Object.freeze({
    id: 'trusted-project', label: 'TRUSTED PROJECT', backend: 'local',
    filesystemScope: 'agent-workspace-and-approved-projects',
    filesystemLabel: 'Workspace + approved project folders',
    capabilityObjects: Object.freeze(['computer', 'cabinet', 'workbench']),
    connectors: true,
    physicalDesktop: 'lease-required',
    description: 'Runs locally with terminal, files, and connected services. Host files stay limited to project folders you approve.'
  }),
  'this-computer': Object.freeze({
    id: 'this-computer', label: 'THIS COMPUTER', backend: 'local',
    filesystemScope: 'host-paths-except-hard-floor',
    filesystemLabel: 'Host paths (Full Power also includes protected paths)',
    capabilityObjects: Object.freeze(['computer', 'cabinet', 'workbench']),
    connectors: true,
    physicalDesktop: 'full-power-or-lease',
    description: 'Runs locally with terminal, files, and connected services. Full Power removes Agent OS host-path, command, screen, and input restrictions.'
  })
});

function validId(value) { return VALID_IDS.indexOf(String(value || '')) >= 0; }

function normalizeId(value, legacy) {
  if (validId(value)) return String(value);
  legacy = legacy || {};
  return 'station-gear';
}

function resolve(value, runtime) {
  runtime = runtime || {};
  const approvalMode = runtime.approvalMode === 'full' ? 'full' : 'ask';
  const id = normalizeId(value, { approvalMode, backendId: runtime.backendId });
  const base = PROFILES[id];
  const effectiveBackend = String(runtime.backendId || 'local').toLowerCase();
  const requestedBackend = base.backend === 'current' ? effectiveBackend : base.backend;
  return Object.assign({}, base, {
    capabilityObjects: base.capabilityObjects.slice(),
    requestedBackend,
    effectiveBackend,
    backendMatched: requestedBackend === effectiveBackend,
    approvalMode,
    approvalLabel: approvalMode === 'full' ? 'FULL POWER' : 'ASK BEFORE RISKY ACTIONS',
    physicalDesktopGranted: runtime.physicalDesktopLease === true
  });
}

function catalog(runtime) {
  return IDS.map(id => resolve(id, runtime));
}

module.exports = { IDS, VALID_IDS, PROFILES, validId, normalizeId, resolve, catalog };
