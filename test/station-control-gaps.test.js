/* node test/station-control-gaps.test.js — the click-only actions self-driving lane 3 handed to the agent (2026-10-05,
   "100% full freedom with the harness"). Same stub bridge + stub route table as station-control.test.js. Pins:
     • each new route action calls exactly its button's route, method and body;
     • the escalations (plugin/hook revoke+delete, runtime limits) are refused by station.control and done by station.power;
     • E-STOP: the halt fires AFTER the result (it aborts this run too), the result says "engaging" never "halted", an
       already-halted station is reported as such, and nothing here can resume;
     • a group chat is found by id or title, never guessed, and configured at its CURRENT revision;
     • deliverables cleanup is the button's preview → apply on the preview's fingerprint; Discord "forget" is refused
       (its route ignores it); quest confirm does not exist (an agent never approves its own claim);
     • the read sections map only what the agent needs (no channel detail strings). */
'use strict';
const A = require('./_assert.js');
const { makeStationControlTools, ACTIONS } = require('../sidecar/tools/builtin/station-control.js');

function stubs(routeImpl, pageImpl) {
  const routes = [], pages = [], timers = [];
  return {
    routes, pages, timers,
    route: async (method, url, body) => { routes.push({ method, url, body }); return routeImpl ? routeImpl(method, url, body) : { status: 200, json: { ok: true } }; },
    station: { request: async (verb, args) => { pages.push({ verb, args }); return pageImpl ? pageImpl(verb, args) : { ok: true, result: { ok: true, saved: true } }; } },
    later: (fn, ms) => timers.push({ fn, ms })
  };
}
const make = (s, extra) => makeStationControlTools(Object.assign({ station: s.station, route: s.route, surface: 'interactive', later: s.later }, extra || {}));
const refused = r => /^REFUSED: /.test(r.content);
const last = s => s.routes[s.routes.length - 1];

(async () => {
  // ---- every new action exists, with its tier ----
  const NEW = ['away.queue', 'away.remove', 'deliverables.cleanup', 'deliverables.restore', 'quest.dismiss', 'quest.later', 'project.forget',
    'channel.disconnect', 'browser.mode', 'group.configure', 'notifications.read', 'notifications.clear', 'estop.engage'];
  const POWER = ['plugin.revoke', 'plugin.delete', 'hook.revoke', 'hook.delete', 'limits.set'];
  for (const n of NEW) A.ok(ACTIONS[n] && !ACTIONS[n].power({}), n + ': an ordinary station.control action');
  for (const n of POWER) A.ok(ACTIONS[n] && ACTIONS[n].power({}), n + ': an escalation (station.power only)');
  for (const n of ['quest.confirm', 'quest.report', 'estop.resume', 'halt.resume', 'update.prepare']) A.ok(!ACTIONS[n], n + ' does NOT exist: the Commander\'s alone');

  // ---- each route action: its button's route, method and body ----
  const cases = [
    ['away.queue', { agent: 'REX', title: 'tidy the docs' }, 'POST', '/api/workshop/queue', { agentId: 'REX', title: 'tidy the docs', detail: undefined }],
    ['away.remove', { agent: 'REX', id: 'b1' }, 'POST', '/api/workshop/remove', { agentId: 'REX', backlogId: 'b1' }],
    ['deliverables.restore', { undoToken: 'u1' }, 'POST', '/api/deliverables/cleanup-undo', { undoToken: 'u1' }],
    ['quest.dismiss', { id: 'q1' }, 'POST', '/api/quests/dismiss', { id: 'q1' }],
    ['quest.later', { id: 'q1', disposition: 'Later' }, 'POST', '/api/quests/disposition', { id: 'q1', disposition: 'later', reason: undefined }],
    ['project.forget', { root: 'C:/work/app' }, 'POST', '/api/projects/forget', { root: 'C:/work/app' }],
    ['channel.disconnect', { channel: 'Telegram' }, 'POST', '/api/channels/telegram/disconnect', { purge: false }],
    ['channel.disconnect', { channel: 'slack', forget: true }, 'POST', '/api/channels/slack/disconnect', { purge: true }],
    ['browser.mode', { mode: 'Chrome' }, 'POST', '/api/browser/settings', { mode: 'chrome' }]
  ];
  for (const [action, args, method, url, body] of cases) {
    const s = stubs(); const t = make(s);
    const r = await t.controlTool.run({ action, args });
    A.ok(!refused(r) && /"done":"/.test(r.content), action + ': done');
    A.eq([last(s).method, last(s).url, last(s).body], [method, url, body], action + ': calls ' + method + ' ' + url + ' exactly as its button does');
  }
  for (const [action, args, url, body] of [
    ['plugin.revoke', { id: 'p1' }, '/api/plugins/revoke', { id: 'p1' }], ['plugin.delete', { id: 'p1' }, '/api/plugins/delete', { id: 'p1' }],
    ['hook.revoke', { event: 'pre_tool_call', command: 'guard.sh' }, '/api/hooks/revoke', { event: 'pre_tool_call', command: 'guard.sh' }],
    ['hook.delete', { event: 'pre_tool_call', command: 'guard.sh' }, '/api/hooks/delete', { event: 'pre_tool_call', command: 'guard.sh' }],
    ['limits.set', { maxIters: 0, cronTickMs: null, junk: 1 }, '/api/runtime/knobs', { maxIters: 0, cronTickMs: null }]]) {
    const s = stubs(); const t = make(s);
    let r = await t.controlTool.run({ action, args });
    A.ok(refused(r) && /station\.power/.test(r.content) && !s.routes.length, action + ': station.control refuses it and calls nothing');
    r = await t.powerTool.run({ action, args });
    A.ok(!refused(r), action + ': station.power does it');
    A.eq([last(s).url, last(s).body], [url, body], action + ': its button\'s route and body (only the known keys)');
    const away = stubs(); const ta = make(away, { surface: 'autonomous' });
    A.ok(refused(await ta.powerTool.run({ action, args })) && !away.routes.length, action + ': refused on a run nobody is watching');
  }
  A.ok(/UNLIMITED/.test(require('../sidecar/tools/builtin/station-control.js').cardFor({ action: 'limits.set', args: { maxIters: 0 } })), 'limits.set card names 0 as UNLIMITED');

  // ---- refusals that keep the report honest ----
  {
    const s = stubs(); const t = make(s);
    A.ok(refused(await t.controlTool.run({ action: 'channel.disconnect', args: { channel: 'discord', forget: true } })) && !s.routes.length, 'Discord forget is refused (its route ignores it)');
    A.ok(refused(await t.controlTool.run({ action: 'channel.disconnect', args: { channel: 'carrier-pigeon' } })) && !s.routes.length, 'an unknown channel is refused');
    A.ok(refused(await t.controlTool.run({ action: 'quest.later', args: { id: 'q', disposition: 'never' } })) && !s.routes.length, 'an unknown quest disposition is refused');
    const dup = stubs(() => ({ status: 200, json: { ok: false, reason: 'duplicate', message: 'already queued' } }));
    A.ok(refused(await make(dup).controlTool.run({ action: 'away.queue', args: { title: 'x' } })), 'a 200 {ok:false} from the queue is a refusal, never "done"');
  }

  // ---- deliverables cleanup: preview, then apply THAT preview ----
  {
    const s = stubs((m, url) => url === '/api/deliverables/cleanup-preview' ? { status: 200, json: { statuses: ['failed'], fingerprint: 'fp9', targets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } } : { status: 200, json: { ok: true, removed: 3, undoToken: 'u7' } });
    const r = await make(s).controlTool.run({ action: 'deliverables.cleanup', args: { statuses: ['failed'] } });
    A.eq(s.routes.map(x => x.url), ['/api/deliverables/cleanup-preview', '/api/deliverables/cleanup'], 'preview, then apply');
    A.eq(s.routes[1].body, { statuses: ['failed'], fingerprint: 'fp9' }, 'apply carries the preview\'s statuses and fingerprint');
    A.ok(/"undoToken":"u7"/.test(r.content), 'the undo token comes back to the agent');
    const d = stubs((m, url) => url === '/api/deliverables/cleanup-preview' ? { status: 200, json: { statuses: ['discarded', 'failed'], fingerprint: 'f', targets: [{ id: 'a' }] } } : { status: 200, json: { ok: true } });
    await make(d).controlTool.run({ action: 'deliverables.cleanup', args: {} });
    A.eq(d.routes[0].body, { statuses: ['discarded', 'failed'] }, 'the default is the button\'s default: discarded + failed');
    const empty = stubs(() => ({ status: 200, json: { ok: true, statuses: ['discarded', 'failed'], fingerprint: '', targets: [] } }));
    const re = await make(empty).controlTool.run({ action: 'deliverables.cleanup', args: {} });
    A.ok(!refused(re) && /"removed":0/.test(re.content) && /nothing to clear/.test(re.content) && empty.routes.length === 1, 'an empty library (fingerprint "") is "nothing to clear", and nothing is applied');
    const bad = stubs(() => ({ status: 200, json: {} }));
    A.ok(refused(await make(bad).controlTool.run({ action: 'deliverables.cleanup', args: {} })) && bad.routes.length === 1, 'no fingerprint = nothing applied');
  }

  // ---- group chats: by id or title, never guessed, at the current revision ----
  {
    const groups = [{ id: 'g1', title: 'Launch crew', members: ['agent', 'rex'] }, { id: 'g2', title: 'Ops' }, { id: 'g3', title: 'Ops' }];
    const s = stubs((m, url, body) => m === 'GET' && url === '/api/groups' ? { status: 200, json: { ok: true, result: { groups } } }
      : m === 'GET' ? { status: 200, json: { ok: true, result: { id: 'g1', revision: 41 } } } : { status: 200, json: { ok: true, result: { id: 'g1', revision: 42 } } });
    const t = make(s);
    let r = await t.controlTool.run({ action: 'group.configure', args: { group: 'launch CREW', members: ['agent', 'rex', 'nova'], junk: 1 } });
    A.ok(!refused(r), 'a group found by its title (any case) is configured');
    A.eq(s.routes.map(x => x.method + ' ' + x.url), ['GET /api/groups', 'GET /api/groups?id=g1', 'POST /api/groups'], 'list, read the group, configure');
    A.eq(last(s).body, { op: 'configure', id: 'g1', revision: 41, members: ['agent', 'rex', 'nova'] }, 'configured at its CURRENT revision, only the known keys');
    r = await t.controlTool.run({ action: 'group.configure', args: { group: 'ops', title: 'x' } });
    A.ok(refused(r) && /more than one group chat/.test(r.content), 'an ambiguous title is refused');
    r = await t.controlTool.run({ action: 'group.configure', args: { group: 'nope', title: 'x' } });
    A.ok(refused(r) && /Launch crew, Ops, Ops/.test(r.content), 'an unknown group is refused with the real list');
  }

  // ---- notifications: the page, and only a saved change is "done" ----
  {
    const s = stubs();
    const r = await make(s).controlTool.run({ action: 'notifications.clear', args: {} });
    A.ok(!refused(r) && s.pages.length === 1 && s.pages[0].verb === 'station.control' && s.pages[0].args.action === 'notifications.clear' && !s.routes.length, 'notifications.clear rides the page');
    const no = stubs(null, () => ({ ok: false, error: 'the notifications changed on screen but this browser did not keep it' }));
    A.ok(refused(await make(no).controlTool.run({ action: 'notifications.read', args: {} })), 'an unsaved change is a refusal');
  }

  // ---- E-STOP: engaged AFTER the result, reported as engaging ----
  {
    const s = stubs((m, url) => url === '/api/halt' && m === 'GET' ? { status: 200, json: { halted: false } } : { status: 200, json: { halted: true } });
    const r = await make(s).controlTool.run({ action: 'estop.engage', args: {} });
    A.ok(!refused(r) && /"engaging":true/.test(r.content) && !/"halted":true/.test(r.content), 'the result says ENGAGING — never that it is already halted');
    A.ok(/stops this run too/.test(r.content) && /RESUME AUTOMATION/.test(r.content), 'and that it stops this run, and how the Commander resumes');
    A.eq(s.routes.map(x => x.method + ' ' + x.url), ['GET /api/halt'], 'the halt has NOT fired while the result is being written');
    A.eq(s.timers.length, 1, 'one deferred halt'); A.ok(s.timers[0].ms >= 1000, 'deferred long enough for the result to land');
    s.timers[0].fn(); await new Promise(r2 => setImmediate(r2));
    A.eq(last(s).method + ' ' + last(s).url, 'POST /api/halt', 'then the E-STOP fires — the same route the tray\'s Pause Automation calls');
    const h = stubs(() => ({ status: 200, json: { halted: true } }));
    const r2 = await make(h).controlTool.run({ action: 'estop.engage', args: {} });
    A.ok(/alreadyHalted/.test(r2.content) && !h.timers.length && h.routes.length === 1, 'already halted: reported, nothing fired');
    A.ok(!Object.keys(ACTIONS).some(n => /resume/.test(n) && /halt|estop/.test(n)), 'there is no action that resumes a halt');
  }

  // ---- the read sections ----
  {
    const s = stubs((m, url) => url === '/api/channels/status' ? { status: 200, json: { telegram: { connected: true, configured: true, ownerLocked: true, detail: 'bot @x running', delivery: {} }, slack: { connected: false } } }
      : url.indexOf('/api/workshop/backlog') === 0 ? { status: 200, json: { agentId: 'rex', granted: true, items: [{ id: 'b1', title: 'docs', state: 'queued', attempts: 2 }] } }
      : { status: 200, json: { ok: true } });
    const t = make(s);
    let r = await t.settingsTool.run({ section: 'channels' });
    A.eq(JSON.parse(r.content)['channels/status'], { telegram: { connected: true, configured: true, ownerPaired: true }, slack: { connected: false, configured: false, ownerPaired: false } }, 'channels: connected / configured / owner-paired only');
    r = await t.settingsTool.run({ section: 'away', agent: 'rex' });
    A.eq(JSON.parse(r.content)['workshop/backlog'], { agentId: 'rex', awayWorkOn: true, queue: [{ id: 'b1', title: 'docs', state: 'queued' }] }, 'away: the agent\'s queue with ids to remove');
    for (const sec of ['library', 'quests', 'groups', 'limits']) A.ok(!refused(await t.settingsTool.run({ section: sec })), 'section ' + sec + ' reads');
    A.ok(/library .*away .*quests .*groups .*channels .*limits/.test(t.settingsTool.description), 'station.settings names the new sections');
    A.ok(['estop.engage', 'group.configure', 'notifications.read', 'away.queue', 'deliverables.cleanup'].every(n => t.controlTool.description.indexOf(n.split('.')[0]) >= 0), 'station.control names the new actions');
    A.ok(/plugin\.approve\|revoke\|delete/.test(t.powerTool.description) && /limits\.set/.test(t.powerTool.description), 'station.power names the new escalations');
  }

  A.report('station-control-gaps');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
