/* sidecar/tools/builtin/station-control.js — the lead changes the STATION for the Commander, from chat.

   WHY (Andrew 2026-10-02: "agents need to now be able to do anything themselves if the user asks … safely"): an audit of
   every UI control against the lead's tools found ~40 things only a click could do — an agent's model, approval, reach,
   personality, name, skin or deletion; renaming, pinning, archiving or deleting a session; forgetting a memory or pausing
   learning; spending caps, Full Power, the autonomy dial, the scheduler; removing a connector, a skill from the market,
   an app; the look of the station. These three tools close that, each change taking the SAME path its button takes:
     • a page-owned setting (the crew roster, the session rail, LOOK & SOUND) runs the page's own setter over the station
       bridge and is proven by reading the save back (frontend/app/stationcommands.js station.control);
     • a server-owned setting calls the SAME /api route its window calls, in-process (deps.route), so every validator,
       store write and live re-apply runs exactly as it does for a click.

   THE SAFETY SHAPE ("safely"):
     • station.settings READS (no consent). station.control CHANGES (the approval card in ASK, its own consent class,
       locked once the run read untrusted content). station.power ESCALATES — anything that widens what agents may do
       or spend without asking (Full Power, raising caps, the autonomy dial, the scheduler on, unattended key use, a
       standing grant, trusting a folder, approving plugin/hook code, an agent to FULL or onto this computer). It has a
       SEPARATE consent class, so an "always" given to a theme change can never pre-approve an escalation, and it is
       refused on any run nobody is watching (a routine, the night shift, a webhook) — an unattended run can never
       widen its own leash.
     • Never, from any tool: entering or reading a credential (keys and sign-ins stay the Commander's: connectors.list
       raises the CONNECT chip), answering a permission prompt, or lifting the E-STOP. The two routes that would lift a
       halt as a side effect are guarded here: the autonomy dial is written with resumeHalt:false, and the scheduler is
       never switched while the station is halted.
     • Every result is what the route or the save read-back says. A refusal is returned as REFUSED: … so the model
       cannot report a change that did not land.

   makeStationControlTools({ station, route, surface, ownerTrusted, providerReady }) — station: the bridge
   ({ request(verb,args) }); route(method, url, body) -> { status, json, text } (the sidecar's own route table, in-process);
   surface: the run's surface ('interactive' | 'autonomous' | …); providerReady(id) -> bool (a provider has a credential). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).stationControl = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the fail-open ledger (sidecar/failopen.js) under node — a deferred halt that fails is counted and visible, never silent
  const swallow = (typeof module !== 'undefined' && module.exports && typeof require === 'function') ? require('../../failopen.js').swallow : (tag => e => e);
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const q = s => '"' + clip(s, 60) + '"';
  const onOff = v => v === true || v === 'on' || v === 'true';
  const enc = encodeURIComponent;
  // fail closed: any reach that is not one of the three NARROW ones is an escalation (a new or misspelled one included)
  const REACH_NARROW = ['station-gear', 'safe-cell', 'remote-ssh'];

  /* THE CATALOG. Each action: what it takes (`takes`, shown to the model), its tier (`power(args)` true = station.power
     only), the card's sentence (`card(args)`, host-written — never the model's own words), and `run(args, env)`.
     `page:true` runs over the station bridge (verb station.control); everything else calls a route. */
  const A = {};
  const def = (name, spec) => { A[name] = Object.assign({ name, power: () => false }, spec); };

  // ---- the crew (page: the Dossier CONFIG card's own setters) ----
  def('agent.model', { page: true, takes: '{agent, model ("" = follow the station default), provider?, effort?}',
    card: a => (a.model ? 'set ' + q(a.agent) + ' to the model ' + q(a.model) + (a.provider ? ' on ' + clip(a.provider, 30) : '') + (a.effort ? ', reasoning ' + clip(a.effort, 20) : '') : 'set ' + q(a.agent) + ' to follow the station\'s default model') + '.' });
  def('agent.personality', { page: true, takes: '{agent, personality}', card: a => 'give ' + q(a.agent) + ' the ' + clip(a.personality, 30) + ' personality.' });
  def('agent.rename', { page: true, takes: '{agent, name}', card: a => 'rename ' + q(a.agent) + ' to ' + q(a.name) + '.' });
  def('agent.skin', { page: true, takes: '{agent, skin}', card: a => 'change ' + q(a.agent) + '\'s look to the ' + clip(a.skin, 30) + ' skin.' });
  def('agent.approval', { page: true, takes: '{agent, mode: ask|full}', power: a => a.mode != null && a.mode !== 'ask',
    card: a => a.mode === 'full' ? 'put ' + q(a.agent) + ' on FULL POWER: it acts without asking you first, every run from now on.' : 'make ' + q(a.agent) + ' ask you before it acts.' });
  def('agent.reach', { page: true, takes: '{agent, reach: station-gear|safe-cell|remote-ssh|trusted-project|this-computer}', power: a => a.reach != null && REACH_NARROW.indexOf(a.reach) < 0,
    card: a => 'set ' + q(a.agent) + '\'s reach to ' + clip(a.reach, 30) + (a.reach === 'this-computer' ? ': files and terminal anywhere on this computer.' : a.reach === 'trusted-project' ? ': files and terminal in your trusted projects.' : '.') });
  def('agent.away_work', { page: true, takes: '{agent, on}', power: a => onOff(a.on),
    card: a => onOff(a.on) ? 'let ' + q(a.agent) + ' build things in its own workspace while you are away.' : 'stop ' + q(a.agent) + ' building while you are away.' });
  def('agent.delete', { page: true, takes: '{agent}', card: a => 'DELETE ' + q(a.agent) + ' from the crew (its notebook and workspace are archived, not wiped).' });

  // ---- sessions (page: the rail's ⋯ menu) ----
  def('session.rename', { page: true, takes: '{session, title}', card: a => 'rename the session ' + q(a.session) + ' to ' + q(a.title) + '.' });
  def('session.pin', { page: true, takes: '{session, pinned?}', card: a => (a.pinned === false ? 'unpin ' : 'pin ') + 'the session ' + q(a.session) + '.' });
  def('session.archive', { page: true, takes: '{session, archived?}', card: a => (a.archived === false ? 'restore ' : 'archive ') + 'the session ' + q(a.session) + '.' });
  def('session.delete', { page: true, takes: '{session}', card: a => 'DELETE the session ' + q(a.session) + ' and its conversation.' });

  // ---- look & sound (page: Settings › LOOK & SOUND) ----
  def('look.set', { page: true, takes: '{look: {theme?, textScale?, crtGlass?, flicker?, sound?, roomLighting?, backdrop?, …}} (station.settings lists every key and value)',
    card: a => 'change the station\'s look: ' + clip(Object.keys(a.look || {}).map(k => k + ' ' + (typeof a.look[k] === 'object' ? JSON.stringify(a.look[k]) : a.look[k])).join(', ') || 'nothing named', 160) + '.' });

  // ---- spending (Settings › SPENDING LIMITS, AI & MODELS › backup models) ----
  // "5" / "$5" from a model is the number it means (the card and the saved value read it the same way); anything else
  // reaches the route's own strict parse exactly as sent
  const dollars = a => { const o = pick(a, ['perRun', 'perAgent', 'perDay', 'global']); for (const k of Object.keys(o)) if (typeof o[k] === 'string' && /^\s*\$?\d+(\.\d+)?\s*$/.test(o[k])) o[k] = Number(o[k].replace(/[\s$]/g, '')); return o; };
  def('budget.set', { takes: '{perRun?, perAgent?, perDay?, global?} in dollars (0 = no cap, null = back to default)', power: () => true, keys: ['perRun', 'perAgent', 'perDay', 'global'],
    card: a => { const d = dollars(a); return 'set your spending limits: ' + Object.keys(d).map(k => k + ' ' + (d[k] === 0 ? 'NO CAP' : d[k] == null ? 'default' : '$' + d[k])).join(', ') + '.'; },
    run: (a, env) => env.route('POST', '/api/budget/caps', dollars(a)) });
  def('budget.resume', { takes: '{scope: day|global}', power: () => true, card: a => 'grant one more cap\'s worth of headroom on the ' + clip(a.scope, 10) + ' spending pool.',
    run: (a, env) => env.route('POST', '/api/budget/resume', { scope: a.scope }) });
  def('fallback.set', { takes: '{models: ["model id", …] | null}', card: a => a.models ? 'set your backup models to ' + clip((a.models || []).join(', '), 160) + '.' : 'reset your backup models to the default.',
    run: (a, env) => env.route('POST', '/api/fallback/chain', { models: a.models == null ? null : a.models }) });

  // ---- permissions & autonomy ----
  def('fullpower.set', { takes: '{on}', power: a => onOff(a.on),
    card: a => onOff(a.on) ? 'turn on station-wide FULL POWER: every agent acts on this computer without asking.' : 'turn station-wide FULL POWER off.',
    run: async (a, env) => {
      const r = await env.route('POST', '/api/permissions/bypass', { on: onOff(a.on) });
      if (!onOff(a.on) && r && r.status < 400 && r.json && r.json.envFullAccess) return refusal('the Full Power switch is off, but Full Power STAYS ON: StarNet was started with SKYNET_FULL_ACCESS set, and only restarting it without that ends it');
      return r;
    } });
  def('permission.grant', { takes: '{key: "cabinet:write"}', power: () => true, card: a => 'grant a standing approval for ' + clip(a.key, 40) + ' (no more asking for it).',
    run: (a, env) => env.route('POST', '/api/permissions/grant', { key: a.key }) });
  def('permission.revoke', { takes: '{key}', card: a => 'revoke the standing approval ' + clip(a.key, 40) + '.',
    run: async (a, env) => {
      const held = await heldGrants(env);
      if (held && held.indexOf(String(a.key || '')) < 0) return refusal('there is no standing approval "' + clip(a.key, 60) + '" (held: ' + (clip(held.join(', '), 300) || 'none') + ')');
      return env.route('POST', '/api/permissions/revoke', { key: a.key });
    } });
  def('autonomy.set', { takes: '{initiative?: wait|propose|leash|free, reach?: observe|sandbox|reach, leashPerDay?: 1-12}', power: () => true,
    card: a => 'set the autonomy dial: ' + ['initiative', 'reach', 'leashPerDay'].filter(k => a[k] != null).map(k => k + ' ' + clip(a[k], 12)).join(', ') + ' (a level that builds lets the night shift build while you are away; this never lifts an E-STOP).',
    run: async (a, env) => {
      const cur = await env.route('GET', '/api/autonomy/posture');
      const s = (cur.json && cur.json.summary) || {};
      const posture = { initiative: a.initiative || s.initiative, reach: a.reach || s.reach, leashPerDay: a.leashPerDay != null ? Number(a.leashPerDay) : s.leashPerDay };
      // ⛔ resumeHalt:false — this route lifts the E-STOP when asked to; only the Commander lifts it
      return env.route('POST', '/api/autonomy/posture', { posture, resumeHalt: false });
    } });
  def('scheduler.set', { takes: '{on}', power: a => onOff(a.on), card: a => (onOff(a.on) ? 'turn routines ON: scheduled jobs start running unattended.' : 'turn routines OFF.'),
    run: async (a, env) => {
      // ⛔ /api/cron/arm also lifts the routines E-STOP in either direction: never touch it while the station is halted
      const h = await env.route('GET', '/api/halt');
      if (h.json && h.json.halted) return refusal('the station (or part of it) is halted (an E-STOP or a paused overseer). Only the Commander resumes it (RESUME AUTOMATION in the top bar); the scheduler was not changed');
      return env.route('POST', '/api/cron/arm', { enabled: onOff(a.on) });
    } });
  def('nightshift.focus', { takes: '{ref (an absolute trusted-project path, a thread id, or "goal"), kind?: project|thread|goal} — or {clear:true}',
    card: a => a.clear ? 'clear what autonomy focuses on.' : 'point autonomy at ' + q(a.ref) + '.',
    run: (a, env) => a.clear ? env.route('DELETE', '/api/nightshift/focus') : env.route('POST', '/api/nightshift/focus', { ref: a.ref, kind: a.kind }) });
  def('nightshift.avoid', { takes: '{ref, kind?} — or {ref, allow:true} to take it off the list',
    card: a => a.allow ? 'let autonomy work on ' + q(a.ref) + ' again.' : 'put ' + q(a.ref) + ' off-limits for autonomy.',
    run: async (a, env) => a.allow
      ? ((await listed(env, '/api/nightshift/focus', 'avoid', e => e.ref === a.ref)) || env.route('DELETE', '/api/nightshift/avoid?ref=' + enc(String(a.ref || ''))))
      : env.route('POST', '/api/nightshift/avoid', { ref: a.ref, kind: a.kind }) });

  // ---- memory & learning ----
  def('memory.forget', { takes: '{agent, id}', card: a => 'make ' + q(a.agent || 'agent') + ' forget memory ' + clip(a.id, 40) + ' (it will not be learned again).',
    run: (a, env) => env.route('POST', '/api/memory/forget', { agentId: a.agent || 'agent', id: a.id, reason: 'commander via chat' }) });
  def('memory.pin', { takes: '{agent, id, pinned?}', card: a => (a.pinned === false ? 'unpin' : 'pin') + ' memory ' + clip(a.id, 40) + ' for ' + q(a.agent || 'agent') + '.',
    run: (a, env) => env.route('POST', '/api/memory/pin', { agentId: a.agent || 'agent', id: a.id, pinned: a.pinned !== false }) });
  def('memory.edit', { takes: '{agent, id, content}', card: a => 'rewrite ' + q(a.agent || 'agent') + '\'s memory ' + clip(a.id, 40) + ' as: "' + clip(a.content, 200) + '".',
    run: (a, env) => env.route('POST', '/api/memory/edit', { agentId: a.agent || 'agent', id: a.id, content: a.content }) });
  def('memory.reset', { takes: '{agent}', card: a => 'WIPE everything ' + q(a.agent || 'agent') + ' has learned (its notebook, to-do list and declined list).',
    run: (a, env) => env.route('POST', '/api/memory/reset', { agentId: a.agent || 'agent' }) });
  def('memory.settings', { takes: '{reflectEnabled?, reflectCooldownMs?, failureReviewEnabled?, failureReviewCooldownMs?}', card: a => 'change memory settings: ' + clip(JSON.stringify(pick(a, ['reflectEnabled', 'reflectCooldownMs', 'failureReviewEnabled', 'failureReviewCooldownMs'])), 160) + '.',
    run: (a, env) => env.route('POST', '/api/memory/config', pick(a, ['reflectEnabled', 'reflectCooldownMs', 'failureReviewEnabled', 'failureReviewCooldownMs'])) });
  def('learning.set', { takes: '{on}', card: a => (onOff(a.on) ? 'resume' : 'pause') + ' learning about you.',
    run: (a, env) => env.route('POST', '/api/personalization', { enabled: onOff(a.on) }) });
  def('learning.wipe', { takes: '{}', card: () => 'WIPE what the station has learned about your interests (interests, scouting, recommendations), with the night shift\'s learning, declined study topics and workflow takeover notes.',
    run: (a, env) => env.route('DELETE', '/api/personalization') });

  // ---- connections, abilities, skills ----
  def('connector.remove', { takes: '{id}', card: a => 'disconnect and remove the connector ' + q(a.id) + '.',
    run: async (a, env) => (await listed(env, '/api/connectors', 'connectors', c => c.id === a.id)) || env.route('POST', '/api/connectors/remove', { id: a.id }) });
  def('connector.refresh', { takes: '{id}', card: a => 'reconnect the connector ' + q(a.id) + '.', run: (a, env) => env.route('POST', '/api/connectors/refresh', { id: a.id }) });
  def('ability.set', { takes: '{id (a toolset id from station.settings connections), on}', power: a => onOff(a.on), card: a => 'switch the ' + q(a.id) + ' abilities ' + (onOff(a.on) ? 'on' : 'off') + ' for the whole station.',
    run: (a, env) => env.route('POST', '/api/toolsets/' + enc(String(a.id || '')), { enabled: onOff(a.on) }) });
  def('skill.set', { takes: '{slug, on}', card: a => 'switch the skill ' + q(a.slug) + ' ' + (onOff(a.on) ? 'on' : 'off') + '.',
    run: async (a, env) => (await listed(env, '/api/skills', 'skills', s => (s.slug || s.id) === a.slug)) || env.route('POST', '/api/skills/toggle', { slug: a.slug, enabled: onOff(a.on) }) });
  def('skill.install', { takes: '{slug}', power: () => true, card: a => 'install ' + q(a.slug) + ' from the Skill Market (a verified package).', run: (a, env) => env.route('POST', '/api/skill-market/install', { slug: a.slug }) });
  def('skill.uninstall', { takes: '{slug}', card: a => 'uninstall the market skill ' + q(a.slug) + '.', run: (a, env) => env.route('POST', '/api/skill-market/uninstall', { slug: a.slug }) });
  def('key.set', { takes: '{id, on}', power: a => onOff(a.on), card: a => (onOff(a.on) ? 'enable' : 'disable') + ' the saved API key ' + q(a.id) + '.', run: (a, env) => env.route('POST', '/api/servicekeys/toggle', { id: a.id, enabled: onOff(a.on) }) });
  def('key.unattended', { takes: '{id, on}', power: a => onOff(a.on), card: a => onOff(a.on) ? 'let routines spend the API key ' + q(a.id) + ' while nobody is watching.' : 'stop routines using the API key ' + q(a.id) + ' unattended.',
    run: (a, env) => env.route('POST', '/api/servicekeys/autonomy', { id: a.id, autonomous: onOff(a.on) }) });
  def('key.remove', { takes: '{id}', card: a => 'delete the saved API key ' + q(a.id) + '.', run: (a, env) => env.route('POST', '/api/servicekeys/remove', { id: a.id }) });
  def('spotify.disconnect', { takes: '{}', card: () => 'disconnect Spotify.', run: (a, env) => env.route('POST', '/api/spotify/disconnect') });
  def('channels.notify', { takes: '{on}', card: a => (onOff(a.on) ? 'send' : 'stop sending') + ' completed-work updates to your chat channels.', run: (a, env) => env.route('POST', '/api/channels/notify', { on: onOff(a.on) }) });
  def('plugin.approve', { takes: '{id}', power: () => true, card: a => 'approve the plugin ' + q(a.id) + ' exactly as its code stands now, so it runs.',
    run: async (a, env) => {
      const l = await env.route('GET', '/api/plugins');
      const p = ((l.json && l.json.plugins) || []).find(x => x && x.id === a.id);
      if (!p) return refusal('there is no plugin "' + clip(a.id, 40) + '"');
      return env.route('POST', '/api/plugins/allow', { id: a.id, digest: p.digest });
    } });
  def('hook.approve', { takes: '{event, command}', power: () => true, card: a => 'approve the automatic command "' + clip(a.command, 120) + '" on ' + clip(a.event, 30) + ': it will run by itself every time.',
    run: (a, env) => env.route('POST', '/api/hooks/allow', { event: a.event, command: a.command }) });

  // ---- apps, projects, files, deliverables ----
  def('app.delete', { takes: '{id}', card: a => 'DELETE the app ' + q(a.id) + ' with its saved data and its refresh routine.', run: (a, env) => env.route('POST', '/api/apps/delete', { id: a.id }) });
  def('app.rename', { takes: '{id, name}', card: a => 'rename the app ' + q(a.id) + ' to ' + q(a.name) + '.', run: (a, env) => env.route('POST', '/api/apps/rename', { id: a.id, name: a.name }) });
  def('project.trust', { takes: '{path}', power: () => true, card: a => 'trust the folder ' + clip(a.path, 160) + ': agents may read and change files there.',
    run: (a, env) => env.route('POST', '/api/projects/bless', { path: a.path }) });
  def('project.untrust', { takes: '{root}', card: a => 'stop trusting the folder ' + clip(a.root, 160) + '.',
    run: async (a, env) => {
      // the grant is keyed by the exact stored root: match it the way a path is written (case, slashes, a trailing one)
      const held = await heldGrants(env);
      if (!held) return refusal('the standing approvals could not be read, so nothing was changed');
      const want = folderKey(a.root);
      const key = held.find(k => /^path:/.test(k) && folderKey(k.slice(5)) === want);
      if (!key) return refusal('the folder ' + clip(a.root, 120) + ' is not trusted (trusted: ' + (clip(held.filter(k => /^path:/.test(k)).map(k => k.slice(5)).join(', '), 300) || 'none') + ')');
      return env.route('POST', '/api/permissions/revoke', { key });
    } });
  def('checkpoint.restore', { takes: '{agent, snapshot}', card: a => 'rewind ' + q(a.agent || 'agent') + '\'s workspace to the checkpoint ' + clip(a.snapshot, 40) + ' (an undo point is saved first).',
    run: (a, env) => env.route('POST', '/api/checkpoint/restore', { agentId: a.agent || 'agent', snapshotId: a.snapshot }) });
  def('deliverable.decide', { takes: '{agent, runId, decision: keep|discard|later}', power: a => a.decision === 'keep', card: a => ({ keep: 'KEEP', discard: 'DISCARD', later: 'leave for later' }[a.decision] || 'decide on') + ' the away-work deliverable ' + clip(a.runId, 40) + ' from ' + q(a.agent || 'agent') + ({ keep: ' (it lands as a git branch in its project, or a copy in its folder)', discard: ' (its files are deleted)' }[a.decision] || '') + '.',
    // destPath is deliberately never forwarded: the route copies files to any path it is given
    run: (a, env) => ['keep', 'discard', 'later'].indexOf(a.decision) < 0 ? refusal('decision is keep, discard or later')
      : env.route('POST', '/api/workshop/decide', { agentId: a.agent || 'agent', runId: a.runId, decision: a.decision }) });

  /* ---- SELF-DRIVING lane 3 (2026-10-05, "100% full freedom with the harness"): the click-only actions an audit found left.
     Each calls the route its button calls. Left out on purpose: away-work SHIFT/IMPLEMENT (streaming routes that spend —
     an agent can do that work itself), update prepare (aborts every run), prop scale/delete (the canvas would show stale
     art), recipe launch (it refuses while any COMMS run is busy — routine.create / team.dispatch do the job), confirming a
     quest (an agent must never approve its own claim), lifting an E-STOP. ---- */

  // ---- away work (AUTOMATE › AWAY WORK) ----
  def('away.queue', { takes: '{agent, title, detail?}', card: a => 'add "' + clip(a.title || a.detail, 120) + '" to ' + q(a.agent || 'agent') + '\'s away-work queue (built only while you are away, and only if that agent has away work on).',
    run: (a, env) => env.route('POST', '/api/workshop/queue', { agentId: a.agent || 'agent', title: a.title, detail: a.detail }) });
  def('away.remove', { takes: '{agent, id (a queue item id from station.settings away)}', card: a => 'take ' + clip(a.id, 60) + ' off ' + q(a.agent || 'agent') + '\'s away-work queue.',
    run: (a, env) => env.route('POST', '/api/workshop/remove', { agentId: a.agent || 'agent', backlogId: a.id }) });

  // ---- finished work (MY WORK › DELIVERABLES) — records only, never files ----
  def('deliverables.cleanup', { takes: '{statuses?: ["discarded","failed","kept","implemented"] (default discarded + failed)}',
    card: a => 'clear the ' + ((Array.isArray(a.statuses) && a.statuses.length ? a.statuses : ['discarded', 'failed']).map(x => clip(x, 12)).join(' and ')) + ' records out of DELIVERABLES (records only — no file is deleted; deliverables.restore puts them back).',
    run: async (a, env) => {
      // the button's own two steps: preview (which fingerprints the library), then apply exactly that preview
      const statuses = Array.isArray(a.statuses) && a.statuses.length ? a.statuses : ['discarded', 'failed'];
      const pv = await env.route('POST', '/api/deliverables/cleanup-preview', { statuses });
      if (!pv || pv.status >= 400 || !pv.json || typeof pv.json.fingerprint !== 'string') return pv && pv.status >= 400 ? pv : refusal('the cleanup preview could not be read, so nothing was cleared');
      // nothing matches: say so (an empty library's fingerprint is "" — the live e2e caught that read as "unreadable")
      if (!(pv.json.targets || []).length) return { status: 200, json: { ok: true, removed: 0, note: 'no ' + (pv.json.statuses || statuses).join(' or ') + ' records — nothing to clear' } };
      return env.route('POST', '/api/deliverables/cleanup', { statuses: pv.json.statuses || statuses, fingerprint: pv.json.fingerprint });
    } });
  def('deliverables.restore', { takes: '{undoToken (deliverables.cleanup returns it)}', card: () => 'put back the DELIVERABLES records a cleanup cleared.',
    run: (a, env) => env.route('POST', '/api/deliverables/cleanup-undo', { undoToken: a.undoToken }) });

  // ---- quests (QUESTS) — never confirm: an agent must not approve its own claim ----
  def('quest.dismiss', { takes: '{id}', card: a => 'DISMISS the quest ' + q(a.id) + ' for good (it will not be suggested again).',
    run: (a, env) => env.route('POST', '/api/quests/dismiss', { id: a.id }) });
  def('quest.later', { takes: '{id, disposition: later|blocked|too_big|resume, reason?}',
    card: a => ({ later: 'snooze the quest ' + q(a.id) + ' for a day', blocked: 'mark the quest ' + q(a.id) + ' blocked', too_big: 'mark the quest ' + q(a.id) + ' too big', resume: 'bring the quest ' + q(a.id) + ' back' }[String(a.disposition || '').toLowerCase()] || 'change the quest ' + q(a.id)) + '.',
    run: (a, env) => {
      const d = String(a.disposition || '').trim().toLowerCase();
      return ['later', 'blocked', 'too_big', 'resume'].indexOf(d) < 0 ? refusal('disposition is later, blocked, too_big or resume')
        : env.route('POST', '/api/quests/disposition', { id: a.id, disposition: d, reason: a.reason });   // later = the route's own +24h
    } });

  // ---- projects, channels, the browser ----
  def('project.forget', { takes: '{root}', card: a => 'forget the project ' + clip(a.root, 160) + ' (its saved details only — no file is touched).',
    run: (a, env) => env.route('POST', '/api/projects/forget', { root: a.root }) });
  def('channel.disconnect', { takes: '{channel: telegram|discord|slack|matrix|signal, forget?}',
    card: a => 'disconnect ' + clip(a.channel, 20) + (onOff(a.forget) ? ' and FORGET its token (reconnecting needs it pasted again)' : ' (its token is kept: reconnecting is one click)') + '.',
    run: (a, env) => {
      const ch = String(a.channel || '').trim().toLowerCase();
      if (['telegram', 'discord', 'slack', 'matrix', 'signal'].indexOf(ch) < 0) return refusal('channel is telegram, discord, slack, matrix or signal');
      // the discord route ignores the body (it never forgets): say so rather than report a forget that did not happen
      if (ch === 'discord' && onOff(a.forget)) return refusal('Discord can only be disconnected from here, not forgotten — the Commander uses FORGET in CONNECT › CHANNELS');
      return env.route('POST', '/api/channels/' + ch + '/disconnect', { purge: onOff(a.forget) });
    } });
  def('browser.mode', { takes: '{mode: builtin|window|chrome}', card: a => 'run the station browser ' + ({ builtin: 'inside StarNet', window: 'as its own Chrome window', chrome: 'in your own Chrome' }[String(a.mode || '').toLowerCase()] || clip(a.mode, 20)) + '.',
    run: (a, env) => env.route('POST', '/api/browser/settings', { mode: String(a.mode || '').trim().toLowerCase() }) });

  // ---- group chats (COMMS) ----
  def('group.configure', { takes: '{group (its id or title), members? [crew ids], leadId?, title?, instructions?, maxTurns? 1-100}',
    card: a => 'change the group chat ' + q(a.group) + ': ' + clip(['members', 'leadId', 'title', 'instructions', 'maxTurns'].filter(k => a[k] != null).map(k => k + ' ' + (Array.isArray(a[k]) ? a[k].join(', ') : a[k])).join('; ') || 'nothing named', 200) + '.',
    run: async (a, env) => {
      const l = await env.route('GET', '/api/groups');
      const gs = l && l.status < 400 && l.json && l.json.result && Array.isArray(l.json.result.groups) ? l.json.result.groups : null;
      if (!gs) return refusal('the group chats could not be read, so nothing was changed');
      const want = String(a.group || '').trim().toLowerCase();
      const byId = gs.filter(g => String(g.id).toLowerCase() === want);
      const hits = byId.length ? byId : gs.filter(g => String(g.title || '').trim().toLowerCase() === want);
      if (hits.length !== 1) return refusal((hits.length ? 'more than one group chat is called ' : 'there is no group chat ') + q(a.group) + ' (group chats: ' + (clip(gs.map(g => g.title || g.id).join(', '), 300) || 'none') + ')');
      // configure is revision-checked (a stale one is refused): read the group's current revision first, as the window does
      const g = await env.route('GET', '/api/groups?id=' + enc(hits[0].id));
      const rev = g && g.json && g.json.result ? g.json.result.revision : undefined;
      return env.route('POST', '/api/groups', Object.assign({ op: 'configure', id: hits[0].id, revision: rev }, pick(a, ['members', 'leadId', 'title', 'instructions', 'maxTurns'])));
    } });

  // ---- notifications (page: NOTIFICATIONS' MARK ALL READ, ALERTS' CLEAR) — a NEEDS YOU entry is never touched ----
  def('notifications.read', { page: true, takes: '{}', card: () => 'mark every notification read (anything still waiting on you stays).' });
  def('notifications.clear', { page: true, takes: '{}', card: () => 'clear the notifications list (anything still waiting on you stays).' });

  // ---- E-STOP: pressing it is the SAFE direction; lifting it stays the Commander's (never here) ----
  def('estop.engage', { takes: '{}', card: () => 'press the E-STOP: EVERY run stops (this one too), and routines, goal loops and the night shift stand down until you press RESUME AUTOMATION.',
    run: async (a, env) => {
      const h = await env.route('GET', '/api/halt');
      if (h && h.json && h.json.halted) return { status: 200, json: { alreadyHalted: true, note: 'the station is already halted — only the Commander resumes it (RESUME AUTOMATION)' } };
      // the halt aborts every run, THIS one included, so it fires just after this result is handed back — the report
      // says "engaging", never "halted": the top bar's RESUME AUTOMATION is the proof the Commander sees
      env.later(() => { Promise.resolve(env.route('POST', '/api/halt')).catch(swallow('station-control.estop.engage')); }, 1500);
      return { status: 200, json: { engaging: true, note: 'the E-STOP engages in a moment and stops this run too; say so in one line now — RESUME AUTOMATION in the top bar is how the Commander resumes' } };
    } });

  // ---- escalations: revoking or deleting a plugin or hook can LOOSEN the station (one may be a pre-tool veto guard),
  //      and a runtime limit of 0 means UNLIMITED — so all of these are station.power ----
  def('plugin.revoke', { takes: '{id}', power: () => true, card: a => 'revoke the plugin ' + q(a.id) + ' (if it guards other tools, that guard stops too).',
    run: (a, env) => env.route('POST', '/api/plugins/revoke', { id: a.id }) });
  def('plugin.delete', { takes: '{id}', power: () => true, card: a => 'DELETE the plugin ' + q(a.id) + ' and its folder — no undo (if it guards other tools, that guard stops too).',
    run: (a, env) => env.route('POST', '/api/plugins/delete', { id: a.id }) });
  def('hook.revoke', { takes: '{event, command}', power: () => true, card: a => 'revoke the automatic command "' + clip(a.command, 120) + '" on ' + clip(a.event, 30) + ' (if it is a guard, it stops guarding).',
    run: (a, env) => env.route('POST', '/api/hooks/revoke', { event: a.event, command: a.command }) });
  def('hook.delete', { takes: '{event, command}', power: () => true, card: a => 'DELETE the automatic command "' + clip(a.command, 120) + '" on ' + clip(a.event, 30) + ' (if it is a guard, it stops guarding).',
    run: (a, env) => env.route('POST', '/api/hooks/delete', { event: a.event, command: a.command }) });
  def('limits.set', { takes: '{maxIters? 0-200, maxConcurrentAgents? 0-32, consentTimeoutMs? 5000-600000, cronTickMs? 5000-600000} (0 = UNLIMITED, null = default; most apply at the next start)', power: () => true, keys: ['maxIters', 'maxConcurrentAgents', 'consentTimeoutMs', 'cronTickMs'],
    card: a => 'change the station\'s runtime limits: ' + clip(['maxIters', 'maxConcurrentAgents', 'consentTimeoutMs', 'cronTickMs'].filter(k => k in a).map(k => k + ' ' + (a[k] === 0 ? 'UNLIMITED' : a[k] == null ? 'default' : a[k])).join(', ') || 'nothing named', 160) + ' (most take effect at the next start).',
    run: (a, env) => env.route('POST', '/api/runtime/knobs', pick(a, ['maxIters', 'maxConcurrentAgents', 'consentTimeoutMs', 'cronTickMs'])) });

  /* ONE reading of the args, used by the tier check, the card's runner AND the page (sweep 2026-10-03). They read the
     same values differently before: the tier check took {on:"off"} as off (ordinary) while the page's !!a.on took it
     as ON, and " this-computer" missed the escalation list while the page trimmed it — both turned an escalation into
     an ordinary approval. And the args' own "action" overrode the approved one on the way to the page. */
  function normArgs(a) {
    const o = Object.assign({}, a);
    delete o.action;
    if ('on' in o) o.on = onOff(o.on);
    for (const k of ['reach', 'mode', 'decision']) if (typeof o[k] === 'string') o[k] = o[k].trim().toLowerCase();
    return o;
  }
  /* ONE reading of the CALL (real-model run 2026-10-08: Claude Haiku 4.5, asked for "a daily spending limit of $5", sent
     station.control {setting: "budget.set", limit: "5", period: "daily"} — no `action`, no `args` — was refused as invalid
     arguments, and fell back to opening the window for the Commander). The action may arrive as action | setting | name
     (a KNOWN action name only), and its args flat beside it instead of under `args`. The approval card, the tier check and
     the run all read the call HERE, so the card always names the change that will run. */
  const CALL_KEYS = ['action', 'setting', 'name'];
  function readCall(input) {
    const i = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    let action = '', from = 'action';
    for (const k of CALL_KEYS) if (typeof i[k] === 'string' && A[i[k].trim()]) { action = i[k].trim(); from = k; break; }
    if (!action) action = String(i.action == null ? '' : i.action).trim();
    let given = i.args;
    // a model that serialises the nested object (args: "{\"perDay\": 5}") means that object
    if (typeof given === 'string' && /^\s*\{/.test(given)) { try { given = JSON.parse(given); } catch (_) { /* left as text: refused below as no args */ } }
    if (given && typeof given === 'object' && !Array.isArray(given)) return { action, args: given };
    const args = {};
    for (const k of Object.keys(i)) if (k !== from && k !== 'action' && k !== 'args') args[k] = i[k];
    return { action, args };
  }
  // the standing grants (null = unreadable); a listing check that returns a refusal when nothing matches, or null to go on
  async function heldGrants(env) { const r = await env.route('GET', '/api/permissions'); return r && r.status < 400 && r.json && Array.isArray(r.json.grants) ? r.json.grants : null; }
  async function listed(env, url, field, match) {
    const r = await env.route('GET', url);
    const rows = r && r.status < 400 && r.json && Array.isArray(r.json[field]) ? r.json[field] : null;
    if (!rows) return refusal('that list could not be read, so nothing was changed');
    return rows.some(x => x && match(x)) ? null : refusal('there is no such ' + field.replace(/s$/, '') + ' on this station (station.settings lists them)');
  }
  const folderKey = p => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  function pick(o, keys) { const out = {}; for (const k of keys) if (o && Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k]; return out; }
  function refusal(error) { return { status: 409, json: { error }, refused: true }; }

  /* the approval card's words for a station.control / station.power call (index.js consentSummary) — host-written from
     the catalog, never the model's own framing. A verb phrase: the COMMS card reads "<AGENT> wants to <this>" and a
     paired phone's lock screen shows the same words. */
  function cardFor(args) {
    const call = readCall(args);
    const spec = A[call.action];
    if (!spec) return 'make an unknown station change (it will be refused, and nothing will change)';
    const a = normArgs(call.args);
    try { return spec.card(a).replace(/\.$/, ''); } catch (_) { return 'make the station change ' + spec.name; }
  }

  /* READS for station.settings: one section at a time, so a 32k model is not handed every store at once */
  const SECTIONS = {
    crew: { page: true },   // crew, sessions, look + the options for each (the page's own state)
    // unsettled: interrupted runs whose spend is unknown — the Commander settles them in SPENDING LIMITS, never an agent
    spending: [['GET', '/api/budget/status', j => ({ caps: j.caps, envDefaults: j.envDefaults, spentToday: j.spentToday, lifetime: j.lifetime, unsettled: j.unsettled })], ['GET', '/api/fallback/chain']],
    permissions: [['GET', '/api/permissions'], ['GET', '/api/halt', j => ({ halted: j.halted })]],
    autonomy: [['GET', '/api/autonomy/posture', j => ({ summary: j.summary })], ['GET', '/api/cron', j => ({ routinesOn: j.enabled, halted: j.halted, jobs: (j.jobs || []).length })], ['GET', '/api/nightshift/focus'], ['GET', '/api/halt', j => ({ halted: j.halted })]],
    memory: [['GET', a => '/api/memory/records?agent=' + enc(a.agent || 'agent'), j => ({ agentId: j.agentId, records: (j.records || []).slice(0, 60).map(r => ({ id: r.id, kind: r.kind, title: r.title, body: clip(r.body, 160), pinned: !!r.pinned })) })],
      ['GET', '/api/memory/config'], ['GET', '/api/personalization', j => ({ learning: j.enabled })]],
    connections: [['GET', '/api/connectors', j => ({ connectors: (j.connectors || []).map(c => ({ id: c.id, label: c.label, enabled: c.enabled, state: c.state || c.status })) })],
      ['GET', '/api/servicekeys', j => ({ keys: (j.keys || []).map(k => ({ id: k.id, name: k.name, enabled: k.enabled, autonomous: k.autonomous })) })],
      ['GET', '/api/toolsets', j => ({ abilities: (j.toolsets || []).map(t => ({ id: t.id, label: t.label || t.name, enabled: t.enabled })) })], ['GET', '/api/spotify/status', j => ({ spotify: !!j.connected })]],
    skills: [['GET', '/api/skills', j => ({ skills: (j.skills || []).map(s => ({ slug: s.slug || s.id, name: s.name, enabled: s.enabled })) })],
      ['GET', '/api/skill-market', j => ({ market: (j.entries || []).map(e => ({ slug: e.slug, name: e.name, installed: /^(installed|update|bundled|tampered)$/.test(String(e.status || '')), status: e.status, version: e.version })) })]],
    apps: [['GET', '/api/apps', j => ({ apps: (j.apps || []).map(x => ({ id: x.id, name: x.name })), routinesOn: j.routinesOn })]],
    projects: [['GET', '/api/projects', j => ({ projects: (j.projects || []).map(p => ({ name: p.displayPath || p.root, root: p.root, trusted: !!p.blessed })) })]],
    checkpoints: [['GET', a => '/api/checkpoint?agent=' + enc(a.agent || 'agent'), j => ({ enabled: j.enabled, snapshots: (j.snapshots || []).slice(0, 30) })]],
    deliverables: [['GET', a => '/api/workshop/pending?agent=' + enc(a.agent || 'agent')]],
    away: [['GET', a => '/api/workshop/backlog?agent=' + enc(a.agent || 'agent'), j => ({ agentId: j.agentId, awayWorkOn: j.granted, queue: (j.items || []).slice(0, 40).map(i => ({ id: i.id, title: i.title, state: i.state })), nextShiftAt: j.nextShiftAt })]],
    library: [['GET', '/api/deliverables', j => ({ total: j.total, summary: j.summary, recent: (j.items || []).slice(0, 25).map(i => ({ id: i.id, title: clip(i.title, 100), status: i.status, kind: i.kind, agentId: i.agentId })) })]],
    quests: [['GET', '/api/quests', j => ({ quests: (j.quests || []).slice(0, 60).map(x => ({ id: x.id, title: clip(x.title, 100), status: x.status, kind: x.kind })) })]],
    groups: [['GET', '/api/groups', j => ({ groups: ((j.result && j.result.groups) || []).map(g => ({ id: g.id, title: g.title, members: g.members, leadId: g.leadId, paused: !!g.paused })) })]],
    channels: [['GET', '/api/channels/status', j => { const o = {}; for (const k of Object.keys(j || {})) if (j[k] && typeof j[k] === 'object') o[k] = { connected: !!j[k].connected, configured: !!j[k].configured, ownerPaired: !!j[k].ownerLocked }; return o; }]],
    limits: [['GET', '/api/runtime/knobs', j => { const o = {}; for (const k of Object.keys((j && j.fields) || {})) o[k] = { effective: j.fields[k].effective, saved: j.fields[k].saved, min: j.fields[k].min, max: j.fields[k].max }; return o; }],
      ['GET', '/api/browser/settings', j => ({ browserMode: j.mode, effective: j.effective })]],
    extensions: [['GET', '/api/plugins', j => ({ plugins: (j.plugins || []).map(p => ({ id: p.id, name: p.name, active: !!p.active, approved: !p.pending, pending: !!p.pending })) })], ['GET', '/api/hooks', j => ({ hooks: j.hooks, pending: j.pending })]],
    actions: { catalog: true }
  };
  const MAX_OUT = 14000;
  /* WHAT CHANGES EACH SECTION (real-model run 2026-10-08: after reading `spending` the model invented
     station.control {action: "update", key: "budget/caps/perDay"} — the read never said which action writes it). Each
     section's answer carries its own actions as `toChange` (inside the JSON, so a reader that parses it still can), each
     with its tool and args, from the catalog itself. */
  const CHANGED_BY = {
    crew: ['agent.', 'session.', 'look.set'], spending: ['budget.', 'fallback.set'], permissions: ['permission.', 'fullpower.set', 'agent.approval', 'agent.reach'],
    autonomy: ['autonomy.set', 'scheduler.set', 'nightshift.', 'estop.engage'], memory: ['memory.', 'learning.'],
    connections: ['connector.', 'key.', 'ability.set', 'spotify.disconnect'], skills: ['skill.'], apps: ['app.'], projects: ['project.'],
    checkpoints: ['checkpoint.'], deliverables: ['deliverable.decide'], away: ['away.', 'agent.away_work'], library: ['deliverables.'],
    quests: ['quest.'], groups: ['group.'], channels: ['channel.disconnect', 'channels.notify'], limits: ['limits.set', 'browser.mode'],
    extensions: ['plugin.', 'hook.']
  };
  // toChange LAST, so the clip at MAX_OUT cuts the hint before it ever cuts the settings themselves
  const withChanges = (obj, sec) => { const rows = changeLines(sec); return rows.length && obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.assign({}, obj, { toChange: rows }) : obj; };
  function changeLines(sec) {
    const pre = CHANGED_BY[sec] || [];
    const rows = Object.values(A).filter(x => pre.some(p => p.endsWith('.') ? x.name.startsWith(p) : x.name === p))
      .map(x => (x.power({}) ? 'station.power' : 'station.control') + ' {"action": "' + x.name + '", "args": ' + x.takes + '}'
        + (!x.power({}) && x.power({ mode: 'full', on: true, reach: 'this-computer' }) ? '  (station.power when it widens access)' : ''));
    if (sec === 'spending') rows.push('an interrupted run listed in unsettled is settled by the Commander alone');
    return rows;
  }

  function makeStationControlTools(deps) {
    deps = deps || {};
    const station = (deps.station && typeof deps.station.request === 'function') ? deps.station : null;
    const route = typeof deps.route === 'function' ? deps.route : null;
    const providerReady = typeof deps.providerReady === 'function' ? deps.providerReady : null;
    const watched = deps.surface === 'interactive' || deps.ownerTrusted === true;
    const refuse = (error, summary) => ({ content: 'REFUSED: ' + error + ' — do not report this change as done.', summary: summary || 'refused' });

    async function page(verb, args) {
      if (!station) return { status: 503, json: { error: 'this run has no station page attached — open StarNet to change this' } };
      let out; try { out = await station.request(verb, args || {}); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
      return out && out.ok ? { status: 200, json: out.result } : { status: 409, json: { error: String((out && out.error) || 'the station did not answer') } };
    }
    async function callRoute(method, url, body) {
      if (!route) return { status: 503, json: { error: 'station settings are not reachable from this run' } };
      try { return await route(method, url, body); } catch (e) { return { status: 500, json: { error: String((e && e.message) || e) } }; }
    }
    // a delay for the one action that must outlive its own result (estop.engage) — injectable for tests
    const later = typeof deps.later === 'function' ? deps.later : (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); };
    const env = { route: callRoute, page, later };
    const errorOf = r => String((r && r.json && (r.json.error || r.json.reason)) || (r && r.text) || ('the station answered ' + (r && r.status)));
    const shape = obj => { let s; try { s = JSON.stringify(obj); } catch (_) { s = '{}'; } return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '… (cut: ask for one section)' : s; };

    const settingsTool = {
      name: 'station.settings', capability: 'orchestrator', scope: 'read', requiresConsent: false, timeoutMs: 20000,
      description: 'READ the Commander\'s station settings before changing them with station.control / station.power. section: crew (each agent\'s model, approval, reach, personality, skin; every session; the look; the allowed values for each) | spending | permissions | autonomy | memory {agent} | connections | skills | apps | projects | checkpoints {agent} | deliverables {agent} (away-work results to decide) | library (finished work) | away {agent} (its queue) | quests | groups | channels | limits | extensions | actions (every change you can make and what it takes).',
      schema: { type: 'object', properties: { section: { type: 'string', enum: Object.keys(SECTIONS) }, agent: { type: 'string' } } },
      run: async (args) => {
        const sec = String((args && args.section) || 'crew'), spec = SECTIONS[sec];
        if (!spec) return refuse('there is no settings section "' + clip(sec, 30) + '"; use one of ' + Object.keys(SECTIONS).join(', '));
        if (spec.catalog) {
          // [station.power] = always an escalation; [station.power when …] = only the value that widens access or spending
          const rows = Object.values(A).map(x => x.name + ' ' + x.takes + (x.power({}) ? '  [station.power]' : x.power({ mode: 'full', on: true, reach: 'this-computer' }) ? '  [station.power when it widens access]' : ''));
          return { content: 'station.control {action, args} — or station.power for the [station.power] ones:\n' + rows.join('\n')
            + '\nNever possible (the Commander does these): entering or reading a key/password/sign-in (connectors.list gives them a CONNECT chip), answering a permission prompt, lifting an E-STOP.', summary: Object.keys(A).length + ' actions' };
        }
        if (spec.page) {
          const r = await page('station.settings', {});
          return r.status === 200 ? { content: shape(withChanges(r.json, 'crew')), summary: 'crew, sessions and look' } : refuse(errorOf(r));
        }
        const out = {};
        for (const [method, url, view] of spec) {
          const u = typeof url === 'function' ? url(args || {}) : url;
          const r = await callRoute(method, u, undefined);
          const key = u.replace(/^\/api\//, '').replace(/\?.*$/, '');
          if (r.status >= 400 || !r.json || r.json.ok === false) { out[key] = { unreadable: errorOf(r) }; continue; }
          try { out[key] = view ? view(r.json) : r.json; } catch (_) { out[key] = r.json; }
        }
        return { content: shape(withChanges(out, sec)), summary: sec };
      }
    };

    function makeChange(name, consentKey, isPower) {
      return {
        name, capability: 'orchestrator', consentKey, taintLocked: true, scope: 'write', requiresConsent: true, timeoutMs: 45000,
        // in ASK an escalation is a card per call (no cached "always" approves it, none is left behind), and a Full Access
        // run that read outside content asks before it widens the leash (permissions.js, taint.js)
        freshConsent: isPower,
        description: isPower
          ? 'ESCALATE a station setting for the Commander — only what widens access or spending: agent.approval full, agent.reach trusted-project/this-computer, agent.away_work on, fullpower.set on, budget.set, budget.resume, autonomy.set, scheduler.set on, permission.grant, key.unattended on, key.set on, ability.set on, skill.install, deliverable.decide keep, project.trust, plugin.approve|revoke|delete, hook.approve|revoke|delete, limits.set. Only when the Commander asked for it in this conversation; refused on runs nobody is watching. Same {action, args} as station.control.'
          : 'CHANGE a station setting for the Commander when they ask — the same change their button makes, proven saved. {action, args}: agent.model|personality|rename|skin|approval|reach|away_work|delete, session.rename|pin|archive|delete, look.set, fallback.set, permission.revoke, fullpower.set off, nightshift.focus|avoid, memory.forget|pin|edit|reset|settings, learning.set|wipe, connector.remove|refresh, ability.set, skill.set|install|uninstall, key.set|remove, spotify.disconnect, channels.notify, app.delete|rename, project.untrust|forget, checkpoint.restore, deliverable.decide, deliverables.cleanup|restore, away.queue|remove, quest.dismiss|later, channel.disconnect, browser.mode, group.configure, notifications.read|clear, estop.engage (the Commander alone resumes). station.settings section "actions" lists what each takes; read the current value first. Widening access or spending goes through station.power instead.',
        schema: { type: 'object', properties: { action: { type: 'string', enum: Object.keys(A) }, args: { type: ['object', 'string'] } } },
        run: async (input) => {
          const call = readCall(input);
          const spec = A[call.action];
          if (!spec) return refuse((call.action ? 'there is no station action "' + clip(call.action, 40) + '"' : 'no action was named')
            + ' — call it as {action, args}, e.g. {"action": "budget.set", "args": {"perDay": 5}}; station.settings section "actions" lists every action and what it takes');
          const a = normArgs(call.args);
          // a call that names none of the action's own fields would save an empty patch and read back as "done"
          if (spec.keys && !spec.keys.some(k => k in a)) return refuse(spec.name + ' takes ' + spec.takes + ' — none of those was given'
            + (Object.keys(a).length ? ' (got ' + clip(Object.keys(a).join(', '), 80) + ')' : '') + ', so nothing was changed');
          const escalates = !!spec.power(a);
          if (escalates && !isPower) return refuse(spec.name + ' with these values widens what agents may do or spend: call station.power with the same {action, args} (the Commander approves it separately)');
          if (isPower && !escalates) return refuse(spec.name + ' with these values does not widen access: use station.control');
          if (isPower && !watched) return refuse('this run is unattended (a routine, the night shift or a trigger): widening access or spending needs the Commander in a watched session — tell them what you would change');
          if (spec.name === 'agent.model' && a.model && a.provider && providerReady && !providerReady(String(a.provider))) {
            return refuse('the provider "' + clip(a.provider, 30) + '" is not connected on this station (no key or sign-in): the Commander connects it in Settings › AI & MODELS first');
          }
          const r = spec.page ? await page('station.control', Object.assign({}, a, { action: spec.name })) : await spec.run(a, env);
          if (!r || r.status >= 400 || r.refused || (r.json && r.json.ok === false)) return refuse(errorOf(r));
          return { content: shape({ done: spec.name, result: r.json }), summary: spec.name };
        }
      };
    }
    const controlTool = makeChange('station.control', 'station.control', false);
    const powerTool = makeChange('station.power', 'station.power', true);

    return {
      settingsTool, controlTool, powerTool,
      register(reg) { reg.register(settingsTool); reg.register(controlTool); reg.register(powerTool); return reg; }
    };
  }

  return { makeStationControlTools, cardFor, ACTIONS: A };
});
