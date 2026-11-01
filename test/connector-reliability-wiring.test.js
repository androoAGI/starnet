'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const rust = read('src-tauri/src/main.rs') + '\n' + read('src-tauri/src/credentials.rs');
const host = readSidecarSource();
const harness = read('frontend/app/harness.js');
const settings = read('frontend/app/stationui.js');
const connectors = read('frontend/app/windows/connectors.js');

A.ok(/\("custom",\s*"SKYNET_CUSTOM_OPENAI_KEY"\)/.test(rust), 'desktop restart injects the custom-provider key');
A.ok(/for provider in KEYCHAIN_PROVIDERS[\s\S]{0,500}SKYNET_KEY_POOL_/.test(rust), 'desktop restart injects every provider-scoped backup pool');
A.ok(/fn post_sidecar_json[\s\S]*MAX_RESPONSE_HEAD[\s\S]*parse_sidecar_status/.test(rust), 'desktop provider mutations share a bounded, complete HTTP acknowledgement seam');
A.ok(/fn harness_store_provider_key_pool[\s\S]*rollback_error\(e, failures\)/.test(rust), 'desktop pool replacement reports incomplete rollback on live-push failure');
A.eq((rust.match(/let _ = push_provider_(?:config|key_pool)/g) || []).length, 0, 'provider rollback acknowledgement failures are never swallowed');
A.ok(/async function validateAndSetKey[\s\S]{0,1000}providers\/validate[\s\S]{0,1000}setKey\(candidate/.test(harness), 'candidate key is probed before persistence');
A.ok(/previous key is unchanged/.test(harness), 'rejected key replacement reports the preserved old credential');
A.ok(/validateAndSetKeyPool/.test(settings) && /keeps your previous spare keys or reports an incomplete rollback/.test(settings) && !/REPLACE POOL|CLEAR POOL|prior pool/.test(settings), 'Settings describes the provider-pool rollback boundary truthfully');
A.ok(/KEY_POOL_' \+ id\.toUpperCase/.test(host), 'runtime pool environment lookup includes the provider id');
A.eq(/ENV\('KEY_POOL'\)/.test(host), false, 'global cross-provider key pool is no longer consumed');
A.ok(/connectorOauthAttempts/.test(host) && /oauth\/cancel/.test(connectors), 'OAuth cancellation reaches both UI and backend discovery');
// both words are common (station/workspace state files, every verified store): read the host without their owners
{
  const wiring = readSidecarSource({ except: ['sidecar/durable-store.js', 'sidecar/channels/secrets.js', 'sidecar/remote/devices.js', 'sidecar/remote/push.js', 'sidecar/station-recovery.js', 'sidecar/workspace-lineage.js', 'sidecar/workspace-reserved.js'] });
  A.ok(/state\.json/.test(wiring) && /saveJsonVerified/.test(wiring), 'connector config and OAuth state share a read-back-verified durable envelope');
}
A.ok(/clientSecret: clientSecret, tokenEndpointAuthMethod: tokenEndpointAuthMethod/.test(host)
  && /clientSecret: pending\.clientSecret/.test(host) && /clientSecret: cur\.clientSecret/.test(host),
  'DCR client secrets stay inside the protected callback/refresh persistence path');   // `cur` = the single-flight refresh's freshest stored entry (was `t` before the per-connector refresh coalescing)
A.ok(/migrateConnectorCatalogKeyHeaders/.test(host) && /headers\[catalogEntry\.keyHeader\] = token;[\s\S]{0,80}token = ''/.test(host),
  'catalog-specific API key headers migrate and save without also sending a stale Bearer credential');
// The locked credential-storage panel's next-step line (review findings security-storage-05 and sidecar-index-07).
// Today the sidecar sends canStartFresh true for every lock reason; the canStartFresh-false shapes are the defensive
// half (a lock the sidecar may later mark as having no START FRESH). A held file ('busy') and an unreachable OS store
// ('key-unavailable') leave an intact store that a restart or an unlock fixes, so the line never steers them to
// START FRESH as if their files were unreadable. A busy lock's sidecar message already says restart, then START FRESH,
// so the line adds nothing for it; any other lock with no START FRESH adds nothing to the sidecar's own message.
{
  const vm = require('node:vm');
  const body = A.fnBody(connectors, 'function storageNextStep(');
  A.ok(body && body.length < 2000, 'connectors.js has the storage next-step helper');
  const ctx = {};
  vm.createContext(ctx);
  if (body) vm.runInContext(body + '\nthis.next = storageNextStep;', ctx);
  const next = s => (ctx.next ? ctx.next(s) : '');
  const busy = next({ reason: 'busy', canStartFresh: true });
  A.eq(busy, '', 'a busy file leaves restart-then-START-FRESH to the sidecar message instead of saying it twice');
  // ...and the sidecar's busy message is the one place that says it (connector-vault.js lockMessage)
  A.ok(/Restart StarNet to try again\.[\s\S]{0,40}If it is still locked after a restart, START FRESH/.test(read('sidecar/connector-vault.js')), 'the busy lock message names the restart before START FRESH');
  const unreachable = next({ reason: 'key-unavailable', canStartFresh: true });
  A.ok(!/unreadable files aside/.test(unreachable), 'an unreachable OS store is never steered to START FRESH as unreadable: ' + unreachable);
  A.ok(/START FRESH only if you cannot unlock/.test(unreachable), 'it puts unlocking the credential store before START FRESH: ' + unreachable);
  A.eq(next({ reason: 'busy', canStartFresh: false }), ' Restart StarNet to try again.', 'a busy lock with no START FRESH says restart');
  A.ok(/START FRESH sets the unreadable files aside/.test(next({ reason: 'key-mismatch', canStartFresh: true })), 'a wrong-key store keeps the START FRESH line');
  A.eq(next({ reason: 'key-unavailable', canStartFresh: false }), ' Unlock the credential store and restart StarNet.', 'the unlock advice is for an unreachable OS store');
  A.eq(next({ reason: 'unreadable', canStartFresh: false }), '', 'any other lock with no START FRESH leaves the sidecar message to speak');
  A.ok(/storageNextStep\(storage\)/.test(A.fnBody(connectors, 'async function refresh(')), 'the panel uses it');
}
// sidecar-index-07: an older sign-in file that could not be removed beside a SEALED store arrives as migrationNotice.
// The panel shows it, under a plain heading: only `notice` (fallback or a failed seal) is headed 'not encrypted'.
{
  const vm = require('node:vm');
  const body = A.fnBody(connectors, 'function storageNoticeHtml(');
  A.ok(body && body.length < 2000, 'connectors.js has the storage notice helper');
  const ctx = { esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  vm.createContext(ctx);
  if (body) vm.runInContext(body + '\nthis.html = storageNoticeHtml;', ctx);
  const html = s => (ctx.html ? ctx.html(s) : '');
  const leftover = html({ encrypted: true, notice: null, migrationNotice: 'An older connector sign-in file could not be removed <x>.' });
  A.ok(leftover.includes('could not be removed &lt;x>'), 'the leftover-file warning reaches the panel, escaped: ' + leftover);
  A.ok(/<b>Credential storage<\/b>/.test(leftover) && !/not encrypted/.test(leftover), 'under a plain heading, never "not encrypted": ' + leftover);
  A.ok(/Credential storage · not encrypted<\/b>Saved WITHOUT encryption/.test(html({ encrypted: false, fallback: true, notice: 'Saved WITHOUT encryption' })), 'the unencrypted notice keeps its heading');
  A.eq(html({ encrypted: true, notice: null, migrationNotice: null }), '', 'nothing to say, nothing drawn');
  A.ok(/notices\.innerHTML \+= storageNoticeHtml\(storage\)/.test(A.fnBody(connectors, 'async function refresh(')), 'the panel draws it');
}
// security-storage-04: START FRESH finishing an interrupted attempt answers with `previous` (the folders that attempt
// filled). A resume with nothing left to move has no movedTo, and the marker that named those folders is gone, so the
// toast is the one place left that says where the old files are.
{
  const vm = require('node:vm');
  const body = A.fnBody(connectors, 'function startFreshKeptText(');
  A.ok(body && body.length < 2000, 'connectors.js has the START FRESH answer helper');
  const ctx = {};
  vm.createContext(ctx);
  if (body) vm.runInContext(body + '\nthis.kept = startFreshKeptText;', ctx);
  const kept = j => (ctx.kept ? ctx.kept(j) : '');
  A.eq(kept({ movedTo: 'C:/c/unreadable-2', previous: [] }), 'Connector storage started fresh. Old files kept in C:/c/unreadable-2', 'a plain START FRESH names its folder');
  A.eq(kept({ movedTo: 'C:/c/unreadable-2', previous: ['C:/c/unreadable-1', 'C:/c/unreadable-0'] }),
    'Connector storage started fresh. Old files kept in C:/c/unreadable-2 (earlier copies in C:/c/unreadable-1, C:/c/unreadable-0)', 'a resumed one names the earlier folders too');
  A.eq(kept({ movedTo: '', previous: ['C:/c/unreadable-1'] }), 'Connector storage started fresh. Old files kept in C:/c/unreadable-1', 'nothing left to move: the earlier folder holds them');
  A.eq(kept({ movedTo: '', previous: ['C:/c/unreadable-1', 'C:/c/unreadable-0'] }),
    'Connector storage started fresh. Old files kept in C:/c/unreadable-1 (earlier copies in C:/c/unreadable-0)', 'each folder named once');
  A.eq(kept(null), 'Connector storage started fresh. Old files kept in the connectors folder', 'an answer with no folders keeps the old wording');
  const sf = connectors.slice(connectors.indexOf("armedLabel: 'SURE? SIGN IN AGAIN'"), connectors.indexOf("armedLabel: 'SURE? SIGN IN AGAIN'") + 1200);
  A.ok(/notify\(startFreshKeptText\(r\.j\)\)/.test(sf), 'the START FRESH toast uses it');
}
// tests-04: the connector key policy tests (credentials.rs connector_key_policy*) and the harness's acceptance_guards are
// pure (injected closures and input checks: no keychain entry, no native process), so fast-gate runs them on every trunk
// push and PR. The native acceptance workflow is dispatch-only: its two stale branch push triggers are gone.
{
  const gate = read('.github/workflows/fast-gate.yml').replace(/\r\n/g, '\n');
  const job = (gate.match(/^  rust-policy:\n(?:(?: {4}.*)?\n)+/m) || [''])[0];
  const cmd = 'cargo test --locked --manifest-path test/native-connector-keychain/Cargo.toml ';
  A.ok(job.includes(cmd + 'connector_key_policy') && job.includes(cmd + 'acceptance_guards'), 'fast-gate has a rust-policy job that runs both pure test filters');
  A.ok(job && !/--ignored|--include-ignored|STARNET_DISPOSABLE_KEYCHAIN|starnet-connector-keychain-acceptance(\.exe)?\s/.test(job),
    '…never the ignored production-entry test, a native phase or the disposable-keychain opt-in');
  A.ok(/test result: ok\\\. \[1-9\]/.test(job), '…and it fails when a filter matched no test (a renamed test must not pass green)');
  const acc = read('.github/workflows/connector-keychain-acceptance.yml').replace(/\r\n/g, '\n');
  const on = (acc.match(/^on:\n((?: .*\n)+)/m) || ['', ''])[1];
  A.ok(/^  workflow_dispatch:/m.test(on) && !/^  push:/m.test(on) && !/agent\/google-oauth/.test(acc), 'the native acceptance workflow runs on manual dispatch only');
}
A.report('connector-reliability-wiring.test');
