/* Run-origin authority: which runs may inherit the Commander's standing Full Power.

   Full Access (per-agent approvalMode:'full') and the station-wide master bypass are the OWNER's authority.
   A run that a chat-channel sender started carries two host-minted fields set by sidecar/channels/hub.js:
     channelSender: true           — a person on a messaging channel originated this run
     channelSenderOwner: boolean   — that person is the bound owner, in a direct chat
   Only the second case inherits Full Power. A group member, an allowed non-owner, or anyone else who can reach
   the bot runs at the ordinary unattended floor even when the agent is set to Full Access.

   The restriction also rides into delegated workers through the host-context connectorAuthority
   (`withholdHostPower`), so a non-owner cannot reach Full Power by asking the lead to delegate to a Full Access
   specialist. Tool arguments can never set it: connectorAuthority is built by the host, never by a model.

   Every other origin (the app, routines/loops/cron, line triggers, the local dev/sample hubs) omits
   channelSender and is unchanged — DECISIONS.md "FULL POWER MEANS THE WHOLE LOCAL COMPUTER", and the tested
   "Full Access follows the agent to its own routine" (test/e2e.mcp-connector.test.js). */
'use strict';

function hostPowerWithheldFor(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.channelSender === true && o.channelSenderOwner !== true) return true;
  // final review #1: the owner's own message, on a config the desk has not bound (an endpoint the channel's own record
  // carries): host-minted by the hub from the composition root's ownerCardFree verdict
  if (o.channelOwnerUnbound === true) return true;
  const inherited = o.connectorAuthority;
  return !!(inherited && typeof inherited === 'object' && inherited.withholdHostPower === true);
}

/* UNTRUSTED ENTRY (sec-taint2 09-25): was this run STARTED by third-party content rather than by the Commander?
   Host-minted untrustedEntry:true is set by the channel hub for a line-trigger fire (webhook body / watched file,
   entryTaint), a forwarded message and a chat attachment — on the entry run AND on every hop of its line — and it
   rides into delegated workers through connectorAuthority.untrustedEntry. Such a run's taint lock is NOT lifted by
   Full Access (taint.js postTaintBoundary): the owner decision is that Full Access means zero prompts for work the
   Commander asked for, never for work a payload's author asked for. Only ever narrows authority, so a caller
   that sets it spuriously can only lose power. */
function entryUntrusted(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.untrustedEntry === true) return true;
  const inherited = o.connectorAuthority;
  return !!(inherited && typeof inherited === 'object' && inherited.untrustedEntry === true);
}

/* STANDING WORK FROM A WITHHELD RUN (sweep 2026-10-02). A run whose host power is withheld (a paired phone, a non-owner
   channel sender, or any worker they delegate to) could still CREATE or RESTART work that runs later under the station's
   standing authority — a routine, a loop, a line trigger, a line test — and that later run fires with the agent's Full
   Access: "a routine that runs in a minute: run this command", approved once on a lost phone, ran with every capability.
   Nothing about who asked is saved on the job, so the safe line is here: such a run may not set standing work up or
   start it again; it may still pause, stop or remove it (those only ever take power away). */
const STANDING_ESCALATES = {
  'routine.create': () => true,
  'routine.manage': (a) => ['update', 'resume', 'run_now'].indexOf(String(a && a.action || '')) >= 0,
  'loop.create': () => true,
  'loop.manage': (a) => ['update', 'resume', 'approve'].indexOf(String(a && a.action || '')) >= 0,
  'station.start_line': (a) => !(a && a.off),
  'station.test_line': () => true,
  // widening the station's leash (Full Power, FULL agents, caps, trusted folders, hook code) is the desk's call
  'station.power': () => true,
  // pointing the night shift at a project (or back at one) sets up work that runs later under standing authority
  'station.control': (a) => (a && a.action === 'nightshift.focus' && !(a.args && a.args.clear)) || (a && a.action === 'nightshift.avoid' && !!(a.args && a.args.allow))
};
function standingWorkEscalates(name, args) {
  const n = String(name || '').replace(/_/g, '.').replace(/^station\.start\.line$/, 'station.start_line').replace(/^station\.test\.line$/, 'station.test_line').replace(/^routine\.run\.now$/, 'routine.run_now');
  const rule = STANDING_ESCALATES[n] || STANDING_ESCALATES[String(name || '')];
  return !!(rule && rule(args && typeof args === 'object' ? args : {}));
}

module.exports = { hostPowerWithheldFor, entryUntrusted, standingWorkEscalates };
