'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Profiles = require('../sidecar/execution-profiles.js');

A.eq(Profiles.IDS.join(','), 'safe-cell,remote-ssh,trusted-project,this-computer', 'the four selectable execution profiles are stable');
A.eq(Profiles.normalizeId(null, { backendId: 'docker', approvalMode: 'ask' }), 'station-gear', 'legacy Docker roster preserves its placed-gear capability envelope');
A.eq(Profiles.normalizeId(null, { backendId: 'local', approvalMode: 'ask' }), 'station-gear', 'legacy local ASK preserves its placed-gear capability envelope');
A.eq(Profiles.normalizeId(null, { backendId: 'local', approvalMode: 'full' }), 'station-gear', 'legacy Full Access preserves its stored profile id while central authority widens the run');
A.eq(Profiles.normalizeId('garbage', { backendId: 'local', approvalMode: 'ask' }), 'station-gear', 'unknown profile fails to the compatibility envelope');
const legacy = Profiles.resolve('station-gear', { backendId: 'docker', approvalMode: 'full' });
A.eq(legacy.requestedBackend, 'docker', 'legacy profile follows the backend already in use');
A.eq(legacy.capabilityObjects.length, 0, 'legacy profile does not add capabilities');

const safe = Profiles.resolve('safe-cell', { backendId: 'local', approvalMode: 'full' });
A.eq(safe.requestedBackend, 'docker', 'Safe Cell requests Docker');
A.eq(safe.effectiveBackend, 'local', 'effective backend is reported independently');
A.eq(safe.backendMatched, false, 'backend mismatch is explicit, never fake isolation');
A.eq(safe.approvalMode, 'full', 'approval posture is independent of the profile');
A.eq(safe.physicalDesktop, 'never', 'Safe Cell never claims physical desktop control');
A.ok(safe.capabilityObjects.includes('cabinet') && safe.capabilityObjects.includes('workbench'), 'Safe Cell advertises files + terminal');
A.eq(safe.connectors, false, 'Safe Cell does not silently project host connectors');

const remote = Profiles.resolve('remote-ssh', { backendId: 'ssh', approvalMode: 'ask' });
A.eq(remote.requestedBackend, 'ssh', 'Remote SSH requests the SSH environment');
A.eq(remote.backendMatched, true, 'Remote SSH reports a real routed backend match');
A.eq(remote.filesystemScope, 'agent-workspace', 'Remote SSH does not widen host filesystem authority');
A.eq(remote.physicalDesktop, 'never', 'Remote SSH never implies physical desktop control');
A.ok(remote.capabilityObjects.includes('cabinet') && remote.capabilityObjects.includes('workbench'), 'Remote SSH projects files and terminal tools');

const trusted = Profiles.resolve('trusted-project', { backendId: 'local', approvalMode: 'ask' });
A.eq(trusted.backendMatched, true, 'Trusted Project matches the local backend');
A.eq(trusted.filesystemScope, 'agent-workspace-and-approved-projects', 'Trusted Project names its bounded host scope');
A.ok(trusted.capabilityObjects.includes('cabinet') && trusted.capabilityObjects.includes('workbench') && trusted.connectors, 'Trusted Project actually requests files, workbench and connectors');
A.eq(trusted.physicalDesktopGranted, false, 'a trusted profile does not manufacture the desktop lease');

const host = Profiles.resolve('this-computer', { backendId: 'local', approvalMode: 'ask', physicalDesktopLease: false });
A.eq(host.filesystemScope, 'host-paths-except-hard-floor', 'This Computer widens host paths explicitly');
A.eq(host.approvalMode, 'ask', 'This Computer can still ask before risky calls');
A.eq(host.physicalDesktop, 'full-power-or-lease', 'This Computer reports the Full Power or paired-owner desktop routes');
A.eq(host.physicalDesktopGranted, false, 'profile choice alone does not grant that lease');

const src = readSidecarSource();
A.ok(/executionProfile\.capabilityObjects[\s\S]{0,180}stationWithObject/.test(src), 'run projection materializes profile capability objects');
A.ok(/executionProfile\.connectors[\s\S]{0,120}stationWithConnectors/.test(src), 'trusted profiles materialize connector projection');
A.ok(/executionProfile\.filesystemScope === 'host-paths-except-hard-floor'/.test(src), 'This Computer reaches the path-trust authority seam');
A.ok(/const unrestrictedHostNow = \(\) => stationBypassNow\(\) \|\| agentFullAccessNow\(\)/.test(src), 'one central predicate composes every Full Power scope');
A.ok(/const stationBypassNow = \(\) => !hostPowerWithheld && \(FULL_ACCESS \|\| masterBypassOn\(\)\)/.test(src), 'the station scopes (env + master bypass) are one withheld-aware predicate');
A.ok(/Object\.keys\(CAP_REGISTRY\)[\s\S]{0,120}stationWithObject/.test(src), 'Full Power materializes every available built-in capability family');
A.ok(/exact: '\/api\/execution-profiles'/.test(src), 'backend exposes the authoritative profile/runtime catalog');
A.ok(!/executionProfile\.physicalDesktopGranted[^\n]+remoteDesktopAuthorized\s*=/.test(src), 'profile data never mints the desktop lease');

A.report('execution-profiles.test');
