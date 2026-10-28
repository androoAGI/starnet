/* node test/approval-posture-recorded.test.js — an agent's approval posture on screen is the one the station RECORDED.

   Found live by sweep/safecell (2026-10-20): with the sidecar's roster write failing (EPERM on agent.roster.json —
   the disk-full / locked-file class; the same result as a station that is unreachable for the click), taking Full
   Power BACK in SETTINGS › PERMISSIONS repainted the row "CHECK WITH ME — Before it writes a file, runs a command, or
   reaches outside, it stops and waits for your yes" while agent.roster.json still said approvalMode:"full" and the very
   next watched fs.write and an /api/autonomy/write both ran with no prompt. setAgentApproval fired pushRoster() and
   returned true without ever looking at the push's answer.

   app.js is a browser-flow IIFE (not node-loadable), so — like agent-config-target.test.js — the function is extracted
   from the source and EXECUTED against a stub station. Locked: a refused push reverts the posture to what the station
   still holds, repaints, and says so; an accepted push keeps it; a newer choice is never clobbered by an older push's
   failure; a posture the station already recorded itself (the permission card's FULL ACCESS) is never reverted. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const appjs = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const m = appjs.match(/function setAgentApproval\([^)]*\) \{[\s\S]*?\n  \}/);
A.ok(m, 'setAgentApproval found in app.js');
if (!m) A.report('approval-posture-recorded.test');

function station(pushOk) {
  const a = { id: 'agent', name: 'NOVA', approvalMode: 'full' };
  const spies = { persist: 0, setRoster: 0, notes: [] };
  let resolvePush;
  const pushed = new Promise(r => { resolvePush = r; });
  const env = {
    agents: new Map([['agent', a]]), agent: a,
    pushRoster: () => pushed, persist: () => { spies.persist++; }, liveAgents: () => [a],
    StationUI: { setRoster: () => { spies.setRoster++; }, notify: (t, k) => { spies.notes.push([t, k]); } },
    // save-latch-kill: the notice says what the station said when it refused (app.js rosterRefusalWords; roster-push-base.test.js)
    rosterRefusalWords: () => 'Try again once the station is reachable.'
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('agents', 'agent', 'pushRoster', 'persist', 'liveAgents', 'StationUI', 'rosterRefusalWords', m[0] + '\nreturn setAgentApproval;')(
    env.agents, env.agent, env.pushRoster, env.persist, env.liveAgents, env.StationUI, env.rosterRefusalWords);
  return { fn, a, spies, settle: async () => { resolvePush(pushOk); for (let i = 0; i < 5; i++) await Promise.resolve(); } };
}

(async () => {
  {
    const s = station(false);
    A.ok(s.fn('agent', 'ask'), 'the change is attempted (sync contract: truthy for a known agent)');
    A.eq(s.a.approvalMode, 'ask', 'optimistic while the push is in flight');
    await s.settle();
    A.eq(s.a.approvalMode, 'full', 'a REFUSED push puts back the posture the station still enforces');
    A.ok(s.spies.setRoster >= 1, 'and repaints every roster readout (dossier, PERMISSIONS crew rows)');
    A.ok(s.spies.notes.some(([t, k]) => k === 'bad' && /did not record/i.test(t) && /FULL POWER/.test(t)), 'and says so: ' + JSON.stringify(s.spies.notes));
  }
  {
    const s = station(true);
    s.fn('agent', 'ask');
    await s.settle();
    A.eq(s.a.approvalMode, 'ask', 'an accepted push keeps the new posture');
    A.eq(s.spies.notes.length, 0, 'and raises no alarm');
  }
  {
    const s = station(false);
    s.fn('agent', 'ask');
    s.a.approvalMode = 'full';   // a newer choice landed before the old push answered
    s.fn('agent', 'ask');
    s.a.approvalMode = 'ask';
    await s.settle();
    A.eq(s.a.approvalMode, 'full', 'both refused pushes leave the recorded posture');
  }
  {
    const s = station(false);
    s.a.approvalMode = 'ask';
    s.fn('agent', 'full', { recorded: true });   // the permission card's FULL ACCESS: the station persisted it first
    await s.settle();
    A.eq(s.a.approvalMode, 'full', 'a posture the station already recorded is never reverted by a failed mirror push');
    A.eq(s.spies.notes.length, 0, 'and no false alarm is raised for it');
  }
  {
    const s = station(true);
    A.eq(s.fn('nobody', 'ask'), false, 'an unknown agent is refused');
  }
  // the permission card passes { recorded: true } (the sidecar persisted Full Access before answering)
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  A.ok(/App\.setApproval\([^\n]+, 'full', \{ recorded: true \}\)/.test(chat), 'the permission card marks its FULL ACCESS as already recorded');
  A.report('approval-posture-recorded.test');
})();
