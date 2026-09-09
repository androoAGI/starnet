/* node test/station-commands.test.js — the PAGE half of the station bridge, run for real.

   stationcommands.js is a browser IIFE, but it is self-contained: it touches only Workstreams / App / Chat /
   U / fetch. So it is loaded here in a vm with the REAL workstreams.js underneath it and the page bridges
   stubbed. That means station.deliver is exercised against genuine session records — the fold, the append,
   the idempotency and the refusals are proven against the same code the app runs, not a paraphrase of it.

   What this exists to stop: delegation used to be agent-addressed only, so a run the Commander asked to
   happen in "research" was filed wherever the lead happened to be. These two verbs are how a session target
   becomes real — station.sessions is what a name is resolved against, station.deliver is what the Commander
   actually sees. Both must refuse loudly rather than half-succeed. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'frontend', 'app', 'stationcommands.js');
const src = fs.readFileSync(SRC, 'utf8');

// Boot a fresh page: real Workstreams, stub bridges. Returns the module surface plus what the page recorded.
function boot(opts) {
  opts = opts || {};
  delete require.cache[require.resolve('../frontend/app/workstreams.js')];
  delete require.cache[require.resolve('../frontend/app/channels.js')];
  const Workstreams = require('../frontend/app/workstreams.js');
  const Channels = require('../frontend/app/channels.js');
  Workstreams.reset();
  Channels.reset();
  const page = { rail: 0, persisted: 0, loaded: [], acks: [], save: null };
  const sandbox = {
    Workstreams, Channels,
    App: {
      refreshRail: () => page.rail++,
      persist: () => { page.persisted++; page.save = JSON.parse(JSON.stringify(Workstreams.serialize())); },
      agents: opts.agents || (() => [])
    },
    CloudSave: {
      flush: async () => opts.saveFails ? false : true,
      pull: async () => opts.readBackFails ? null : page.save
    },
    Chat: { load: ws => page.loaded.push(ws.id), canFocusSession: opts.canFocusSession || (() => true) },
    U: { bus: { on: () => {} } },
    VoiceLive: opts.voiceLive,
    fetch: async (url, init) => {
      if (String(url).indexOf('/api/runs') === 0) return { ok: true, json: async () => ({ runs: opts.runs || [] }) };
      page.acks.push(JSON.parse(init.body)); return { ok: true };
    },
    document: { addEventListener: () => {} },
    console, setTimeout, clearTimeout, Date, JSON
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // a top-level `const` is NOT a property of the context object (the same reason the module probes App/Chat by
  // bare identifier rather than window.App), so take the module as the script's completion value.
  const S = vm.runInContext(src + '\n;StationCommands;', sandbox, { filename: 'stationcommands.js' });
  // VoiceLive is probed by bare identifier too — expose a setter so a test can stand in a live call
  const setVoiceLive = (v) => { sandbox.VoiceLive = v; };
  return { S, W: Workstreams, C: Channels, page, setVoiceLive };
}
// run a verb through the module's real dispatch path (the same one U.bus drives) and read the ack it posted
async function call(env, verb, args) {
  await env.S.run('cmd-' + env.page.acks.length, verb, args);
  return env.page.acks[env.page.acks.length - 1];
}

(async () => {

// ---- station.sessions: the list a session NAME is resolved against ----
{
  const env = boot();
  const r1 = env.W.create('research');
  env.W.create('Billing rewrite');
  const out = await call(env, 'station.sessions', {});
  A.eq(out.ok, true, 'the page can list its sessions');
  const titles = out.result.sessions.map(s => s.title);
  A.ok(titles.indexOf('research') >= 0, 'a named session is listed by its real title');
  A.ok(titles.indexOf('General') >= 0, 'the untitled home stream is listed under the name the UI shows it by');
  A.eq(out.result.activeId, r1 && out.result.sessions.find(s => s.active).id, 'the active session is flagged');
  A.ok(out.result.sessions.every(s => s.id && s.agentId), 'every row carries the id and agent a dispatch needs');
}

// ---- station.deliver: the worker's answer lands in the session the Commander named ----
{
  const env = boot();
  const ws = env.W.create('research');
  env.W.switch(env.W.generalId());          // the Commander is looking at General, not research
  const before = env.page.rail;
  const out = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', prompt: 'summarise X', text: 'X in three points…' });
  A.eq(out.ok, true, 'the fold succeeded');
  A.eq(out.result.session, 'research', 'and reports which session it went into');
  const h = env.W.get(ws.id).history;
  A.eq(h.length, 2, 'two turns: the framing marker and the real answer');
  A.eq(h[0].sys, true, 'the delegated instruction is a sys marker, not a user turn the Commander never typed');
  A.ok(/delegated to researcher/.test(h[0].content), 'the marker names who it went to');
  A.eq(h[1].role, 'assistant', "the worker's answer is real dialogue");
  A.eq(h[1].content, 'X in three points…', 'delivered verbatim');
  A.eq(h[1].agentId, 'researcher', 'attributed to the WORKER, so renderHistory names the right speaker');
  A.ok(env.W.get(ws.id).runIds.indexOf('run-1') >= 0, 'the run is filed onto that session');
  A.eq(env.W.get(ws.id).lane, 'active', 'a real run advances the lane (hybrid-honest)');
  A.ok(env.W.unread(ws.id), 'the rail flags it unread — the Commander has genuinely not seen this yet');
  A.ok(env.page.rail > before && env.page.persisted > 0, 'the rail re-renders and the save is written');
  A.eq(env.page.loaded.length, 0, 'a session that is NOT open is not force-rendered');
}

// ---- task board verbs: canonical kind:'task' Workstreams, durable read-back, and semantic idempotency ----
{
  const env = boot({ agents: () => [{ id: 'builder', name: 'BUILDER' }] });
  const first = await call(env, 'station.new_task', { title: 'Fix release check', agentId: 'builder' });
  A.eq(first.ok, true, 'a board card is durably created');
  A.eq(first.result.durable, true, 'the ack says durability was read back, not merely attempted');
  A.eq(first.result.created, true, 'the first request minted one card');
  const card = env.W.get(first.result.id);
  A.eq(card.kind, 'task', 'the authoritative workstream is explicitly a task');
  A.eq(card.agentId, 'builder', 'assignment is stored on that same card');
  const again = await call(env, 'station.new_task', { title: 'FIX RELEASE CHECK', agentId: 'builder' });
  A.eq(again.ok, true, 'a repeated create is a successful idempotent read-back');
  A.eq(again.result.duplicate, true, 'and reports that it reused the card');
  A.eq(env.W.list({ includeArchived: true }).filter(w => w.kind === 'task').length, 1, 'the mutation happened exactly once');
  const listed = await call(env, 'station.tasks', {});
  A.eq(listed.result.tasks.length, 1, 'task.list projects the canonical board store');

  const moved = await call(env, 'station.manage_task', { task: 'Fix release check', action: 'move', lane: 'active' });
  A.eq(moved.ok, true, 'a task can move lanes');
  A.eq(env.W.get(card.id).lane, 'active', 'the real board state changed');
  const same = await call(env, 'station.manage_task', { task: card.id, action: 'move', lane: 'active' });
  A.eq(same.result.changed, false, 'repeating a state-setting mutation is a no-op');
  const restartSave = JSON.parse(JSON.stringify(env.page.save));
  env.W.reset();
  env.W.init(restartSave);
  A.eq(env.W.get(card.id).lane, 'active', 'a fresh Workstreams boot restores the durable card and lane');
  A.eq((await call(env, 'station.tasks', {})).result.tasks[0].id, card.id, 'the post-restart model read and UI store identify the same card');
  const removed = await call(env, 'station.manage_task', { task: card.id, action: 'remove' });
  A.eq(removed.ok, true, 'remove persists');
  A.ok(env.page.save.deletedIds.indexOf(card.id) >= 0, 'its durable tombstone prevents restart resurrection');
}

{
  const env = boot({ saveFails: true });
  const out = await call(env, 'station.new_task', { title: 'Cannot claim this' });
  A.eq(out.ok, false, 'a refused durable write is never reported as success');
  A.ok(/do not report/.test(out.error), 'the refusal tells the model not to claim completion');
}

// two browser pages can hold different local ids for the SAME named session. Delivery resolves by the stable
// exact title when this page does not know the id chosen by the other page.
{
  const env = boot();
  const local = env.W.create('business research session');
  env.W.switch(env.W.generalId());
  const out = await call(env, 'station.deliver', {
    streamId: 'ws_other_page', sessionTitle: 'business research session',
    agentId: 'researcher', runId: 'split-1', prompt: 'find three ideas', text: 'three sourced ideas'
  });
  A.eq(out.ok, true, 'split-brain delivery succeeds by stable title');
  A.eq(out.result.resolvedBy, 'title', 'the ack says the id mismatch was healed by title');
  A.eq(env.W.get(local.id).history[1].content, 'three sourced ideas', 'the page the Commander is viewing receives the answer');
  A.ok(env.W.get(local.id).runIds.indexOf('split-1') >= 0, 'the local session records the durable run id');
}

// a real delegated run makes its TARGET session visibly busy without stealing focus; final delivery settles it.
{
  const env = boot();
  const ws = env.W.create('research');
  env.W.switch(env.W.generalId());
  const started = await call(env, 'station.dispatch_start', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-1'
  });
  A.eq(started.ok, true, 'dispatch start is acknowledged');
  A.ok(env.C.isBusy(ws.id), 'the target session is visibly busy');
  A.eq(env.C.runIdOf(ws.id), 'live-1', 'its status is backed by the real worker run id');
  A.eq(env.W.activeId(), env.W.generalId(), 'marking the target busy does not steal the Commander from General');
  const settled = await call(env, 'station.dispatch_end', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-1'
  });
  A.eq(settled.ok, true, 'dispatch end is acknowledged');
  A.ok(!env.C.isBusy(ws.id), 'an errored or stopped worker also settles the target session');
  await call(env, 'station.dispatch_start', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-2'
  });
  await call(env, 'station.deliver', {
    streamId: ws.id, sessionTitle: 'research', agentId: 'researcher', runId: 'live-2', text: 'done'
  });
  A.ok(!env.C.isBusy(ws.id), 'final delivery settles the target session');
}

// missed delivery heals from the durable /api/runs envelope on boot/open, even when another page minted the id.
{
  const env = boot({ runs: [{
    runId: 'heal-1', agentId: 'researcher', reason: 'done', streamId: 'ws_other_page',
    sessionTitle: 'business research session', deliveryPrompt: 'research it',
    deliveryText: 'durable finished brief', ts: 1234
  }] });
  const local = env.W.create('business research session');
  env.W.switch(env.W.generalId());
  const healed = await env.S.reconcile(local.id);
  A.eq(healed, 1, 'one missed delegated run was healed');
  A.eq(env.W.get(local.id).history[1].content, 'durable finished brief', 'the durable answer appears in the visible session');
  A.eq(await env.S.reconcile(local.id), 0, 'reconciliation is idempotent by runId');
  A.eq(env.W.get(local.id).history.length, 2, 'the healed answer appears exactly once');
}

// delivering into the session the Commander is WATCHING re-renders it immediately
{
  const env = boot();
  const ws = env.W.create('research');       // create() activates it
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'done' });
  A.eq(env.page.loaded[0], ws.id, 'the open session is reloaded so the answer appears at once');
  A.ok(!env.W.unread(ws.id), 'and it is not marked unread — it is on screen');
}

/* ⛔ APPEND, NEVER REPLACE. A targeted session usually already holds the Commander's own conversation. The
   cron auto-session path may replace a history because it OWNS its stream; this one does not, and replacing
   here would silently delete the thread the Commander asked to add work to. */
{
  const env = boot();
  const ws = env.W.create('research');
  ws.history.push({ role: 'user', content: 'my own question' }, { role: 'assistant', content: 'my own answer' });
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'delegated result' });
  const h = env.W.get(ws.id).history;
  A.eq(h.length, 3, 'the existing conversation survives');
  A.eq(h[0].content, 'my own question', 'the Commander\'s first turn is untouched');
  A.eq(h[2].content, 'delegated result', 'the delegated answer is appended after it');
}

// the same run never posts twice (a retry, a duplicate command, a re-delivered background worker)
{
  const env = boot();
  const ws = env.W.create('research');
  await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'once' });
  const second = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'researcher', runId: 'run-1', text: 'once' });
  A.eq(second.ok, true, 'a repeat delivery is not an error');
  A.eq(second.result.folded, false, 'but it reports that nothing was folded');
  A.eq(env.W.get(ws.id).history.length, 1, 'and the answer appears exactly once');
}

// ---- refusals: every one is ok:false with a reason, never a quiet success ----
{
  const env = boot();
  const ws = env.W.create('research');
  const gone = await call(env, 'station.deliver', { streamId: 'ws_nope', agentId: 'r', runId: 'x', text: 'hi' });
  A.eq(gone.ok, false, 'delivering to a session that does not exist fails');
  A.ok(/no session with id ws_nope/.test(gone.error), 'and says so precisely');
  const empty = await call(env, 'station.deliver', { streamId: ws.id, agentId: 'r', runId: 'x', text: '   ' });
  A.eq(empty.ok, false, 'an empty answer is refused rather than posting a blank turn');
  A.eq(env.W.get(ws.id).history.length, 0, 'and nothing was written');
  const unknown = await call(env, 'station.nonsense', {});
  A.eq(unknown.ok, false, 'an unknown verb fails instead of resolving true');
  A.ok(/unknown station verb/.test(unknown.error), 'naming the verb it could not run');
}

// station.status refuses honestly when the view is not up yet (rather than inventing an empty station)
{
  const env = boot();
  const out = await call(env, 'station.status', {});
  A.eq(out.ok, false, 'no VoiceLive snapshot yet -> an honest refusal');
  A.ok(/not ready/.test(out.error), 'and it says the view is not ready');
}

// station.crew reports the real roster, and refuses when there is none
{
  const empty = boot({ agents: () => [] });
  A.eq((await call(empty, 'station.crew', {})).ok, false, 'an empty roster is a refusal, not a fake crew');
  const crewed = boot({ agents: () => [{ id: 'researcher', name: 'RESEARCHER', model: 'm1' }] });
  const out = await call(crewed, 'station.crew', {});
  A.eq(out.ok, true, 'a real roster answers');
  A.eq(out.result.crew[0].id, 'researcher', 'with the ids a dispatch has to address');
}

/* ---- station.new_session: the agent can OPEN a session by name — the half "make a session called
   research and have them work in it" was missing (dispatch could target one, nothing could create one) ---- */
{
  const env = boot({ agents: () => [{ id: 'researcher', name: 'RESEARCHER' }] });
  const out = await call(env, 'station.new_session', { title: 'research', agentId: 'researcher' });
  A.eq(out.ok, true, 'a named session is created');
  A.eq(out.result.title, 'research', 'with the title the Commander said');
  A.eq(out.result.agentId, 'researcher', 'bound to the named crew member');
  A.eq(out.result.focused, false, 'not focused unless asked');
  A.ok(env.W.list().some(w => w.title === 'research'), 'and it exists in the real session store');
  A.eq(env.W.activeId(), env.W.generalId(), 'a background create never steals what the Commander is looking at');
  A.ok(env.page.rail > 0 && env.page.persisted > 0, 'the rail re-rendered and the save was written');

  // focus:true is the explicit "open it" ask — active session moves, thread renders
  const f = await call(env, 'station.new_session', { title: 'billing', focus: true });
  A.eq(f.ok, true, 'a focused create succeeds');
  A.eq(env.W.activeId(), f.result.id, 'and the Commander is now looking at it');
  A.eq(env.page.loaded[env.page.loaded.length - 1], f.result.id, 'the thread rendered');
}

// a duplicate title is REFUSED — a twin would make every later name-addressed action ambiguous
{
  const env = boot();
  env.W.create('research');
  const dup = await call(env, 'station.new_session', { title: 'RESEARCH' });
  A.eq(dup.ok, false, 'a case-different duplicate is still a duplicate');
  A.ok(/already exists/.test(dup.error), 'and the refusal says so');
  const gen = await call(env, 'station.new_session', { title: 'General' });
  A.eq(gen.ok, false, 'the untitled home stream\'s display name is reserved too');
  const ghost = await call(env, 'station.new_session', { title: 'ops', agentId: 'nobody' });
  A.eq(ghost.ok, false, 'an unknown agentId is refused, not silently dropped');
  A.ok(/no crew member/.test(ghost.error), 'naming what was wrong');
  A.ok(!env.W.list().some(w => w.title === 'ops'), 'and no session was created');
}

/* ---- station.switch_session: focus by the name the Commander says — same resolution law as dispatch
   (exact id → exact title → unique substring; anything else refuses with the real names) ---- */
{
  const env = boot();
  const r = env.W.create('research');
  env.W.create('Billing rewrite');
  env.W.switch(env.W.generalId());
  const out = await call(env, 'station.switch_session', { session: 'research' });
  A.eq(out.ok, true, 'an exact title switches');
  A.eq(env.W.activeId(), r.id, 'the Commander is now looking at it');
  A.eq(env.page.loaded[env.page.loaded.length - 1], r.id, 'and the thread rendered');
  const part = await call(env, 'station.switch_session', { session: 'billing' });
  A.eq(part.ok, true, 'a unique substring resolves');
  const gen = await call(env, 'station.switch_session', { session: 'general' });
  A.eq(gen.ok, true, 'the home stream is addressable by the name the UI shows');
  A.eq(env.W.activeId(), env.W.generalId(), 'and focuses General');
}

// the refusals — never a guess, and always the list the model needs to correct itself
{
  const env = boot();
  env.W.create('research plan');
  env.W.create('research notes');
  env.W.switch(env.W.generalId());   // the Commander is looking at General; a refusal must leave them there
  const ambig = await call(env, 'station.switch_session', { session: 'research' });
  A.eq(ambig.ok, false, 'an ambiguous name refuses');
  A.ok(/more than one session matches/.test(ambig.error) && /research plan/.test(ambig.error), 'explaining the ambiguity with the real names');
  A.eq(env.W.activeId(), env.W.generalId(), 'and the focus did NOT move');
  const none = await call(env, 'station.switch_session', { session: 'marketing' });
  A.eq(none.ok, false, 'an unknown name refuses');
  A.ok(/no session called "marketing"/.test(none.error) && /research plan/.test(none.error), 'and lists what does exist');
}

/* ---- station.read_session: the agent's EYES into other sessions. Exists because a lead asked "what did
   the researcher do?" had no way to look, GUESSED, and denied real finished work to the Commander. ---- */
{
  const env = boot();
  const ws = env.W.create('research');
  ws.history.push(
    { role: 'user', content: 'my question' },
    { role: 'system', sys: true, content: '— delegated to researcher: summarise X —' },
    { role: 'assistant', agentId: 'researcher', content: 'Phobos and Deimos, both captured asteroids.' },
    { role: 'assistant', content: 'a hidden one', hidden: true }
  );
  const out = await call(env, 'station.read_session', { session: 'research' });
  A.eq(out.ok, true, 'a named session can be read');
  A.eq(out.result.title, 'research', 'with its real title');
  A.eq(out.result.turns.length, 3, 'visible turns only — hidden/internal rows never leak');
  A.eq(out.result.turns[0].speaker, 'commander', 'the Commander\'s turns are labeled');
  A.eq(out.result.turns[1].speaker, 'station', 'sys markers are labeled as the station, not as speech');
  A.eq(out.result.turns[2].speaker, 'researcher', 'delegated work is attributed to the worker who did it');
  A.ok(/Phobos/.test(out.result.turns[2].text), 'and carries the real content');
  A.eq(out.result.busy, false, 'busy state rides along so "still working" is answerable');

  // an empty session says so — an empty turns array alone reads like "nothing happened", which is a claim
  const blank = env.W.create('empty one');
  const b = await call(env, 'station.read_session', { session: 'empty one' });
  A.eq(b.result.turns.length, 0, 'no visible turns');
  A.ok(/no visible conversation yet/.test(b.result.note), 'stated, not implied');

  // same resolution law as every other name-addressed verb
  const nope = await call(env, 'station.read_session', { session: 'marketing' });
  A.eq(nope.ok, false, 'an unknown name refuses');
  A.ok(/no session called "marketing"/.test(nope.error) && /research/.test(nope.error), 'with the real names');
  // the limit clamps
  const lim = await call(env, 'station.read_session', { session: 'research', limit: 2 });
  A.eq(lim.result.turns.length, 2, 'limit returns the most recent N');
  A.eq(lim.result.turns[1].speaker, 'researcher', 'and they are the LAST turns, not the first');
}

/* ---- the voice-call rebind hook: a switch DURING a live call re-targets the call (it came through the
   call); with no live call the verb must not touch VoiceLive at all ---- */
{
  const env = boot();
  env.W.create('research');
  const rebinds = [];
  // stationcommands probes the VoiceLive global by bare identifier — inject it into the vm context
  env.setVoiceLive({ isActive: () => true, boundSessionId: () => 'call-origin', rebind: id => rebinds.push(id) });
  const out = await call(env, 'station.switch_session', { session: 'research', origin: {streamId:'call-origin',runId:'run'} });
  A.eq(out.ok, true, 'the switch succeeded');
  A.eq(rebinds.length, 1, 'a live call is rebound by a voice-driven switch');
  A.eq(rebinds[0], out.result.id, 'to the session the switch landed on');
  env.setVoiceLive({ isActive: () => false, rebind: id => rebinds.push(id) });
  await call(env, 'station.switch_session', { session: 'General' });
  A.eq(rebinds.length, 1, 'no live call -> no rebind attempted');
}

// A stale/background request is refused before any selection or creation side effect.
{
  const env = boot({canFocusSession: () => false});
  const target = env.W.create('target', {activate:false});
  const original = env.W.activeId(), count = env.W.list().length;
  const switched = await call(env, 'station.switch_session', {session:target.id});
  A.eq(switched.ok, false, 'unattributed focus is refused');
  A.eq(env.W.activeId(), original, 'the selected session stays put');
  A.eq(env.page.loaded.length, 0, 'the visible composer is not rebound');
  const made = await call(env, 'station.new_session', {title:'stale create', focus:true});
  A.eq(made.ok, false, 'stale focused creation is refused');
  A.eq(env.W.list().length, count, 'refusal leaves no partially-created session');
  const background = await call(env, 'station.new_session', {title:'background', focus:false});
  A.eq(background.ok, true, 'background creation remains available');
  A.eq(env.W.activeId(), original, 'background creation does not navigate');
}

// every verb the sidecar can ask for is implemented here (a missing one would fail as "unknown verb" live)
{
  const env = boot();
  const verbs = env.S.verbs();
  for (const v of ['station.status', 'station.crew', 'station.sessions', 'station.deliver', 'station.new_session', 'station.switch_session']) {
    A.ok(verbs.indexOf(v) >= 0, 'the page implements ' + v);
  }
  for (const file of ['orchestration.js', 'station.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', file), 'utf8');
    for (const m of src.match(/(?:station|ask)\('(station\.[^']+)'/g) || []) {
      const verb = /'([^']+)'/.exec(m)[1];
      A.ok(verbs.indexOf(verb) >= 0, file + ' asks for ' + verb + ', and the page can answer it');
    }
  }
}

A.report('station-commands.test');

})().catch(error => { console.error(error); process.exit(1); });
