/* node test/master-bypass.test.js — the runtime FULL BYPASS switch (2026-08-05).

   Proves the two host seams the switch rides:
   1. permissions.js — `bypass` as a FUNCTION is re-read on every consent call (flip ON bites the next
      call, flip OFF revokes the next call, no restart), the hardline floor still sits above it, a
      throwing predicate fails closed, and a boolean bypass behaves exactly as before.
   2. inputpolicy.js — makeRunAuthority({ masterBypass:true }) grants owner-DM-grade impact reach on an
      unattended surface (host process, media, external-unknown) while the physical-desktop lease stays
      host-minted (masterBypass alone never unlocks computer.use / desktop.open). */
'use strict';
const A = require('./_assert.js');
const { makeConsentBroker } = require('../sidecar/permissions.js');
const { makeRunAuthority, IMPACTS } = require('../sidecar/inputpolicy.js');

const WRITE = { name: 'fs.write', capability: 'files', scope: 'write', requiresConsent: true };
const writeCall = { name: 'fs.write', args: { path: 'report.md' } };
const hardline = (call) => (call && call.args && /(^|\/)\.env$/.test(call.args.path)) ? 'protected file' : null;

// ---- 1. function bypass is LIVE: flips take effect on the very next call ----
{
  let on = false;
  const consent = makeConsentBroker({ bypass: () => on, hardline: hardline, surface: 'autonomous' });
  const denied = consent(writeCall, WRITE);
  A.ok(!denied.allow, 'switch OFF: autonomous ungranted write default-denies');
  on = true;
  const allowed = consent(writeCall, WRITE);
  A.ok(allowed.allow && allowed.reason === 'full-access', 'switch ON: the very next call bypasses');
  on = false;
  const revoked = consent(writeCall, WRITE);
  A.ok(!revoked.allow, 'switch OFF again: the very next call denies — no restart needed');
}

// ---- 2. hardline floor still sits ABOVE the live bypass ----
{
  const consent = makeConsentBroker({ bypass: () => true, hardline: hardline, surface: 'autonomous' });
  const r = consent({ name: 'fs.write', args: { path: '.env' } }, WRITE);
  A.ok(!r.allow && r.hardline === true, 'FULL BYPASS never reaches past the hardline floor');
}

// ---- 2b. explicit host-wide Full Power outranks the .env/.git hardline (DECISIONS "FULL POWER MEANS THE WHOLE LOCAL
//          COMPUTER"; 0.15.2/0.15.3 refused it, owner decision 2026-11-19 restores it) ----
{
  const consent = makeConsentBroker({ bypass: () => true, unrestrictedHost: () => true, hardline: hardline, surface: 'autonomous' });
  const r = consent({ name: 'fs.write', args: { path: '.env' } }, WRITE);
  A.ok(r.allow && r.reason === 'full-power', 'host-wide Full Power writes a project .env with no prompt');
  const ok = consent(writeCall, WRITE);
  A.ok(ok.allow && ok.reason === 'full-power', 'and everything else, with no prompt');
  // a Full Access agent WITHOUT the whole-host reach (TRUSTED PROJECT, Remote SSH) stays under the hardline
  const fenced = makeConsentBroker({ bypass: () => true, unrestrictedHost: () => false, hardline: hardline, surface: 'autonomous' });
  const fr = fenced({ name: 'fs.write', args: { path: '.env' } }, WRITE);
  A.ok(!fr.allow && fr.hardline === true, 'a fenced Full Access agent never reaches past the hardline floor (.env)');
}

// ---- 3. a throwing bypass predicate fails CLOSED ----
{
  const consent = makeConsentBroker({ bypass: () => { throw new Error('store torn'); }, surface: 'autonomous' });
  const r = consent(writeCall, WRITE);
  A.ok(!r.allow, 'a throwing bypass predicate is a deny, never an allow');
}

// ---- 4. boolean bypass unchanged (the frozen env path) ----
{
  const consent = makeConsentBroker({ bypass: true, surface: 'autonomous' });
  A.ok(consent(writeCall, WRITE).allow, 'bypass:true still allows (boot-frozen env path unchanged)');
  const consent2 = makeConsentBroker({ bypass: false, surface: 'autonomous' });
  A.ok(!consent2(writeCall, WRITE).allow, 'bypass:false still denies');
}

// ---- 5. inputpolicy: masterBypass widens unattended impact gates like an owner DM ----
{
  const auth = makeRunAuthority({ surface: 'autonomous', masterBypass: true });
  const shell = auth.authorize({ name: 'shell.exec' }, { name: 'shell.exec', capability: 'workbench', scope: 'execute' });
  A.ok(shell.ok === true, 'masterBypass: unattended host process allowed without a per-routine grant');
  A.ok(shell.masterBypass === true, 'the allow is stamped masterBypass (honest telemetry)');
  A.ok(shell.ownerTrusted === undefined, 'masterBypass never claims owner identity');
  const media = auth.authorize({ name: 'spotify_play' }, { name: 'spotify_play', capability: 'jukebox', scope: 'execute' });
  A.ok(media.ok === true, 'masterBypass: unattended media control allowed');
  const unknown = auth.authorize({ name: 'x.custom' }, { name: 'x.custom', capability: 'mystery', scope: 'execute' });
  A.ok(unknown.ok === true, 'masterBypass: external-unknown allowed unattended');
  A.ok(auth.project({ name: 'shell.exec', capability: 'workbench' }) === true, 'masterBypass: workbench projected into the tool list unattended');
}

// ---- 6. inputpolicy: masterBypass is host-wide Full Power ----
{
  const auth = makeRunAuthority({ surface: 'autonomous', masterBypass: true });
  const phys = auth.authorize({ name: 'computer.use' }, { name: 'computer.use', capability: 'physical-input', scope: 'execute' });
  A.ok(phys.ok === true && phys.impact === IMPACTS.PHYSICAL_INPUT && phys.unrestrictedHost === true, 'Full Power authorizes physical input');
  A.ok(auth.project({ name: 'desktop.open', capability: 'visible-desktop' }) === true, 'Full Power projects real-screen desktop control');
  A.ok(auth.unrestrictedHost() === true && auth.mode === 'full-power', 'authority diagnostics state the effective host-wide mode');
}

// ---- 7. inputpolicy: switch OFF leaves the unattended denials byte-identical ----
{
  const auth = makeRunAuthority({ surface: 'autonomous', masterBypass: false });
  const shell = auth.authorize({ name: 'shell.exec' }, { name: 'shell.exec', capability: 'workbench', scope: 'execute' });
  A.ok(shell.ok === false && /per-routine terminal grant/.test(shell.reason), 'OFF: unattended shell denial unchanged');
  const media = auth.authorize({ name: 'spotify_play' }, { name: 'spotify_play', capability: 'jukebox', scope: 'execute' });
  A.ok(media.ok === false, 'OFF: unattended media denial unchanged');
}

// ---- 8. per-agent Full Access is the same zero-prompt authority, and is live within a run ----
{
  let full = true, prompts = 0;
  const auth = makeRunAuthority({
    surface: 'autonomous',
    fullAccess: () => full,
    confirm: async () => { prompts++; return 'deny'; }
  });
  const unknownTool = { name: 'x.custom', capability: 'mystery', scope: 'execute' };
  const after = auth.authorize({ name: 'x.custom' }, unknownTool);
  A.ok(after.ok === true && prompts === 0, 'Full Access emits no exact permission prompt');
  A.ok(after.fullAccess === true, 'the allow is stamped as per-agent Full Access, not owner identity or master bypass');
  A.ok(auth.project({ name: 'shell.exec', capability: 'workbench' }) === true, 'Full Access projects unattended workbench authority too');
  A.ok(auth.project({ name: 'computer.use', capability: 'physical-input' }) === true,
    'per-agent Full Access projects physical input without a separate niche permission');
  full = false;
  A.ok(auth.project({ name: 'shell.exec', capability: 'workbench' }) === false,
    'revoking Full Access bites the same authority object on the next call');
}

A.report('master-bypass.test');
