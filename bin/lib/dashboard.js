/* bin/lib/dashboard.js — the live `starnet` dashboard: the terminal I/O and the station wiring around the pure model
   (station-model.js) and screen (tui.js).

   What it reads (all over the attached station's loopback API, token in the header):
     GET /api/observe          the live feed — every run's events and asks (reconnects with its cursor)
     GET /api/state/snapshot   every 3 s — which runs and asks are live (the truth after any gap)
     GET /api/runtime/agent    the roster · GET /api/budget/status spend · GET /api/routing/lines/stats + /api/line-jobs flows
     GET /api/transcript       this terminal's earlier conversation with each agent
     GET /api/projects         is the folder `starnet` was started in a trusted project (bin/lib/folder.js)
   What it does (only when the person at the keyboard says so):
     POST /api/run             a message, on the agent's own terminal conversation (cli-<agentId>), as its roster defines it,
                               working in that trusted project when there is one
     POST /api/projects/bless  y on the TRUST THIS FOLDER? card: the same grant as the app's PROJECTS rail
     POST /api/consent(/answer) an answer to an ask, marked via:'terminal' so the desk card lets go
     POST /api/cancel          /stop · POST /api/routing/sample  /flow run

   A run this terminal starts lives as long as its response stream (the station's rule for every client): quitting
   stops it, and the quit key says so first. */
'use strict';

const os = require('node:os');
const http = require('node:http');
const readline = require('node:readline');
const core = require('./cli-core.js');
const { makeStation, costText, ONCE_ONLY_TOOLS } = require('./station-model.js');
const tui = require('./tui.js');
const sixel = require('./sixel.js');
const camfeed = require('./camfeed.js');
const folderLib = require('./folder.js');
const mouse = require('./mouse.js');
const theme = require('./theme.js');
const connect = require('./connect.js');

function runDashboard(station, opts) {
  const o = opts || {};
  const out = o.stdout || process.stdout;
  const inp = o.stdin || process.stdin;
  const env = o.env || process.env;
  const client = station.client;
  const model = makeStation();
  const level = tui.colorLevel(env, !!out.isTTY);
  // the color theme: the app's presets or the terminal's red (STARNET_THEME, else the last /theme pick)
  const themeFile = o.themeFile || theme.configFile(env);
  const themeTargets = { palette: tui.PALETTE, bg: tui.BG, logoRamp: sixel.RAMP, camfeed };
  let themeName = theme.apply(theme.load(env, themeFile), themeTargets);
  const ui = {
    focus: '', input: '', overlay: null, picker: null, streams: {}, history: [], histAt: null, histDraft: '', pasting: false, flash: null, scroll: 0, keyFlash: null, quitArmed: 0, quitNote: '',
    // which station this is, in words: the desktop app's own, a private one this terminal booted, or one at an address
    stationLabel: station.mode === 'spawned' ? 'private station · port ' + client.base.replace(/^.*:/, '')
      : station.workspace ? 'desktop station · port ' + client.base.replace(/^.*:/, '')
        : 'station · ' + client.base.replace(/^http:\/\//, ''),
    still: !!(env.STARNET_STILL === '1'),
    // the REAL logo: an image where the terminal draws Sixel, else the same logo as braille dots. STARNET_LOGO=dots skips
    // the image, =ascii draws the drawn-letter version, =plain keeps to the one-line mark
    logo: ['plain', 'ascii', 'dots'].indexOf(env.STARNET_LOGO) >= 0 ? env.STARNET_LOGO : 'full',
    logoImage: null,
    // the folder this terminal works in: project = the trusted project every message works in; trust = the card asking
    // to trust the folder it was started in
    project: null, trust: null,
    lastSent: {},   // agentId -> { text, shown }: what /retry sends again
    // the page in the COMMS frame ('' = the conversation; stat · crew · work) and what it read off the station; the agent
    // whose menu card is open
    page: '', pageScroll: 0, pageData: {}, agentMenu: ''
  };
  const mine = new Map();       // requests this terminal holds open: id -> { req, agentId, kind }
  let feedReq = null, cursor = '', feedRetry = null, stopped = false;
  const timers = [];
  let prevRows = [];
  let resolveExit;
  const exited = new Promise(r => { resolveExit = r; });
  const now = () => Date.now();
  const flash = (text, style, ms) => { ui.flash = { text, style: style || 'am', until: now() + (ms || 4000) }; paint(); };

  // ---- HTTP ----------------------------------------------------------------------------------------------
  const get = (p, t) => client.request('GET', p, null, { timeoutMs: t || 8000 });
  async function loadRoster() { const r = await get('/api/runtime/agent'); if (r.ok && r.status === 200 && r.json) { model.setRoster(r.json); if (!ui.focus || !model.state.agents.has(ui.focus)) ui.focus = pickFocus(); } return r; }
  async function loadSnapshot() {
    const r = await get('/api/state/snapshot');
    if (r.ok && r.status === 200 && r.json) { model.applySnapshot(r.json, now()); await require('./station-commands.js').fillAskSummaries(client, model).catch(() => {}); }
    return r;
  }
  async function loadBudget() { const r = await get('/api/budget/status'); if (r.ok && r.status === 200 && r.json) model.applyBudget(r.json); }
  async function loadLines() {
    const [s, j] = await Promise.all([get('/api/routing/lines/stats'), get('/api/line-jobs?limit=40')]);
    if (s.ok && s.status === 200 && j.ok && j.status === 200) model.applyLines(s.json || {}, (j.json && j.json.jobs) || []);
  }
  /* CONVERSATIONS. Each agent talks on one terminal conversation at a time (a stream: cli-<agent> or cli-<agent>-<time>). The
     station keeps no list of them, but every run row names its stream, so the terminal's own conversations are read off
     GET /api/runs: newest first, with when, how many messages and the run title. At launch each agent reopens its newest. */
  const convs = new Map();   // agentId -> [{ streamId, last, first, msgs, title }]
  const streamOf = id => ui.streams[id] || core.cliStreamId(id);
  async function loadConversations() {
    const r = await get('/api/runs?agent=*&limit=500', 15000);
    if (!(r.ok && r.status === 200 && r.json && Array.isArray(r.json.runs))) return false;
    const by = new Map();
    for (const x of r.json.runs) {
      const sid = String((x && x.streamId) || ''), aid = String((x && x.agentId) || '');
      if (!aid || !(sid === core.cliStreamId(aid) || sid.indexOf(core.cliStreamId(aid) + '-') === 0) || x.internal) continue;
      const t = Number(x.startedAt || x.ts) || 0;
      const key = aid + '\n' + sid;
      const c = by.get(key) || { agentId: aid, streamId: sid, last: 0, first: Infinity, msgs: 0, title: '' };
      c.msgs++;
      if (t >= c.last) c.last = t;
      if (t < c.first) { c.first = t; c.title = String(x.title || x.sessionTitle || c.title || ''); }
      by.set(key, c);
    }
    convs.clear();
    for (const c of by.values()) { if (!convs.has(c.agentId)) convs.set(c.agentId, []); convs.get(c.agentId).push(c); }
    for (const list of convs.values()) list.sort((a, b) => b.last - a.last);
    return true;
  }
  async function loadStream(id, sid) {
    const r = await get('/api/transcript?agent=' + encodeURIComponent(id) + '&stream=' + encodeURIComponent(sid) + '&limit=60');
    if (r.ok && r.status === 200 && r.json && Array.isArray(r.json.turns)) model.seedHistory(id, r.json.turns);
  }
  async function loadHistory() {
    await loadConversations().catch(() => false);
    for (const [id, list] of convs) if (list.length && !ui.streams[id]) ui.streams[id] = list[0].streamId;   // each agent's newest
    await Promise.all(model.state.order.slice(0, 16).map(id => loadStream(id, streamOf(id))));
  }
  /* THE CAMERA FEED's art is the app's own, read off the station: the skin table (/app/data-shim.js), the skin each agent
     wears (GET /api/save), and the sprites and furniture the feed draws (/assets/...), fetched when an agent's feed first
     needs them. An agent with no skin wears the default, as in the app. */
  const feed = camfeed.makeCamFeed();
  let skinTable = null;
  const inFlight = new Set();
  async function loadSkins() {
    if (!ui.images) return;
    if (!skinTable) {
      const r = await get('/app/data-shim.js');
      if (!(r.ok && r.status === 200)) return;
      skinTable = camfeed.parseSkins(r.text);
    }
    const s = await get('/api/save', 30000);
    const doc = s.ok && s.status === 200 && s.json ? (s.json.save || s.json.doc || s.json) : null;
    const wearing = {};
    for (const a of (doc && Array.isArray(doc.agents) ? doc.agents : [])) if (a && a.id) wearing[a.id] = String(a.skin || '');
    for (const id of model.state.order) feed.setSkin(id, camfeed.setFor(id, wearing[id], skinTable));
  }
  // the station's level for the stat bar: its growth record in the save, read through the app's own xp.js (Xp.compute). A
  // save without one (or a read that fails) leaves the level out of the bar — never a made-up LV 1
  // The same save says each agent's own settings the roster does not carry: its reasoning effort (sent with every message
  // from here), its approval mode and its personality (/yolo, /personality show them)
  let Xp = null;
  async function loadStats() {
    const s = await get('/api/save?agent=agent', 30000);
    const doc = s.ok && s.status === 200 && s.json ? s.json.save : null;
    for (const sa of (doc && Array.isArray(doc.agents) ? doc.agents : [])) {
      const a = sa && sa.id ? model.state.agents.get(String(sa.id)) : null;
      if (!a) continue;
      // the roster is what the station holds a run to: its settings win; the save fills in for a station that does not say them
      if (!a.rosterSettings) {
        if (typeof sa.reasoningEffort === 'string' && sa.reasoningEffort) a.reasoningEffort = sa.reasoningEffort;
        if (typeof sa.approvalMode === 'string') a.approvalMode = sa.approvalMode;
      }
      if (typeof sa.personaId === 'string' && !a.personaId) a.personaId = sa.personaId;
    }
    try { Xp = Xp || require(require('node:path').join(__dirname, '..', '..', 'frontend', 'app', 'xp.js')); } catch (_) { return; }
    ui.stats = doc && doc.stationStats ? Xp.compute(doc.stationStats) : null;
  }
  function loadFeedAssets(id) {
    for (const p of feed.needs(id)) {
      if (inFlight.has(p)) continue;
      inFlight.add(p);
      client.request('GET', p, null, { raw: true, timeoutMs: 8000 }).then(r => {
        feed.add(p, r.ok && r.status === 200 ? r.buf : null);
        inFlight.delete(p);
        if (!feed.needs(id).length) paint();
      }, () => { inFlight.delete(p); });
    }
  }
  function newConversation() {
    const a = model.state.agents.get(ui.focus);
    if (!a) return flash('no agent to start a conversation with');
    ui.streams[a.id] = core.cliStreamId(a.id) + '-' + Date.now().toString(36);
    model.resetLog(a.id, '— a new conversation with ' + a.name + ' —');
    ui.scroll = 0; ui.overlay = null;
    flash('new conversation with ' + a.name + ' · /resume goes back to an earlier one', 'ok');
  }
  async function openResumePicker() {
    const a = model.state.agents.get(ui.focus);
    if (!a) return flash('no agent shown');
    const p = { kind: 'resume', title: 'CONVERSATIONS · ' + a.name, note: 'from this terminal', filter: '', sel: 0, items: [], loading: true,
      foot: '↑ ↓ pick · enter opens it · esc close · type to filter', onPick: it => switchConversation(a.id, it.streamId, it.when) };
    ui.picker = p; ui.overlay = null; paint();
    await loadConversations().catch(() => false);
    const cur = streamOf(a.id);
    const list = (convs.get(a.id) || []).slice();
    // the station lists a run once it ENDS: a conversation whose first reply is still running is this one, said as such
    const sentHere = model.logOf(a.id).some(e => e.k === 'you');
    if (!list.some(c => c.streamId === cur)) list.unshift({ streamId: cur, last: now(), msgs: 0, title: sentHere ? '(this conversation — its first reply is still running)' : '(this conversation — nothing sent yet)' });
    p.items = list.map(c => {
      const when = c.msgs ? require('./station-model.js').ago(now() - c.last) : 'now';
      return { streamId: c.streamId, when, current: c.streamId === cur, search: (when + ' ' + c.title).toLowerCase(),
        cols: [[padTo(when, 10), 'dim'], [padTo(c.msgs ? c.msgs + ' msg' + (c.msgs === 1 ? '' : 's') : '', 9), 'dim'], [c.title || '(untitled)', 'fg']] };
    });
    p.sel = Math.max(0, p.items.findIndex(i => i.current));
    p.loading = false;
    paint();
  }
  async function switchConversation(agentId, sid, when) {
    const a = model.state.agents.get(agentId);
    if (!a) return;
    if (sid === streamOf(agentId)) return paint();
    ui.streams[agentId] = sid;
    model.resetLog(agentId, '');
    ui.scroll = 0;
    await loadStream(agentId, sid);
    flash('back in the conversation from ' + when + ' with ' + a.name, 'ok');
    // its session goal (if one waits here) goes on now that its conversation is shown again — the app's own return rule
    if (goals.has(sid) && streamOf(agentId) === sid) setTimeout(() => kickGoal(sid), 0);
  }
  function pickFocus() {
    const rows = model.rows(now());
    const f = rows.find(r => r.status.key === 'needs') || rows.find(r => r.status.key === 'working') || rows[0];
    return f ? f.id : '';
  }

  // ---- the live feed ---------------------------------------------------------------------------------------
  function connectFeed() {
    if (stopped) return;
    const headers = { Accept: 'text/event-stream', Origin: client.base, 'x-starnet-token': client.token() };
    if (cursor) headers['Last-Event-ID'] = cursor;
    let req;
    try {
      req = http.request({ host: client.host, port: client.port, method: 'GET', path: '/api/observe', headers }, res => {
        if (res.statusCode === 404) { model.state.feed = 'old'; res.resume(); paint(); return; }   // an older station: status from the snapshot only
        if (res.statusCode !== 200) { res.resume(); return retryFeed(); }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', chunk => {
          const r = core.splitSse(buf + chunk);
          buf = r.rest;
          for (const ev of r.events) {
            if (ev.id) cursor = ev.id;
            let j = null; try { j = JSON.parse(ev.data); } catch (_) { continue; }
            if (j && j.stream === 'ready') { model.state.feed = 'live'; if (j.reset) loadSnapshot().then(paint, () => {}); continue; }
            if (j && j.name) { model.apply(j.name, j.payload, now()); afterEvent(j.name, j.payload || {}); }
          }
          schedulePaint();
        });
        const lost = () => { if (feedReq === req) { feedReq = null; if (!stopped) retryFeed(); } };
        res.on('end', lost); res.on('close', lost); res.on('error', lost);
      });
    } catch (_) { return retryFeed(); }
    req.on('error', () => { if (feedReq === req) { feedReq = null; retryFeed(); } });
    req.end();
    feedReq = req;
  }
  function retryFeed() {
    if (stopped || feedRetry) return;
    if (model.state.feed !== 'old') model.state.feed = 'down';
    paint();
    feedRetry = setTimeout(() => { feedRetry = null; connectFeed(); }, 2000);
  }

  // ---- doing things ---------------------------------------------------------------------------------------
  // shown: what COMMS says you sent, when it is not the text itself (a skill goes as its whole recipe, shown as /skill task)
  // sendOpts.onFail(why): the station never started it (no model, refused, connection lost) — a goal's step pauses on it.
  // sendOpts.retry: a message of yours sent on a conversation it was typed in (a queued one): /retry sends it again
  function send(agentId, text, shown, streamOverride, sendOpts) {
    const so = sendOpts || {};
    const fail = why => { if (typeof so.onFail === 'function') { try { so.onFail(why); } catch (_) {} } };
    const a = model.state.agents.get(agentId);
    if (!a) { fail('no agent named ' + agentId); return flash('no agent named ' + agentId); }
    if (!a.model) { fail(a.name + ' has no model set'); return flash(a.name + ' has no model set — pick one in the app first'); }
    const streamId = streamOverride || streamOf(agentId);
    if (!streamOverride || so.retry) ui.lastSent[agentId] = { text, shown };
    model.noteSent(agentId, shown || text, streamId, now());
    ui.scroll = 0;
    // tools only for a task, decided the way the page decides it (the agent's last reply lets a bare "yes" to its offer count)
    const prior = [...model.logOf(agentId)].reverse().find(e => e.k === 'agent');
    const body = { model: a.model, provider: a.provider || undefined, agentId, streamId, rosterSystem: true, client: 'terminal', isTask: core.isTaskText(text, prior && prior.text), messages: [{ role: 'user', content: text }] };
    if (ui.project) body.projectRoot = ui.project.root;   // the trusted project this terminal was started in
    // the agent's own effort dial (its save; /reasoning sets it): without it every run here ran at the provider's default
    if (a.reasoningEffort) body.reasoningEffort = a.reasoningEffort;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const id = 'run' + Math.random().toString(36).slice(2);
    let req;
    try {
      req = http.request({ host: client.host, port: client.port, method: 'POST', path: '/api/run', headers: { Origin: client.base, 'Content-Type': 'application/json', 'Content-Length': payload.length, 'x-starnet-token': client.token(), Accept: 'application/x-ndjson' } }, res => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', d => chunks.push(d));
          res.on('end', () => {
            mine.delete(id);
            const why = Buffer.concat(chunks).toString('utf8').slice(0, 200) || 'HTTP ' + res.statusCode;
            model.sendFailed(agentId, streamId, why, now());
            let said = why; try { const j = JSON.parse(why); if (j && (j.error || j.reason)) said = String(j.error || j.reason); } catch (_) {}
            fail('HTTP ' + res.statusCode + (said && said !== 'HTTP ' + res.statusCode ? ': ' + said : ''));
            paint();
          });
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', chunk => {
          const r = core.splitNdjson(buf + chunk);
          buf = r.rest;
          // with the live feed up, the feed already carries this run; without it (an older station) its own stream does
          if (model.state.feed === 'live') return;
          for (const line of r.lines) { let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; } if (ev && ev.name) { const p = Object.assign({}, ev.payload, ev.name === 'agent.run.start' ? { streamId } : {}); model.apply(ev.name, p, now()); afterEvent(ev.name, p); } }
          schedulePaint();
        });
        const done = () => { mine.delete(id); paint(); };
        res.on('end', done); res.on('close', done); res.on('error', done);
      });
    } catch (e) { model.sendFailed(agentId, streamId, (e && e.message) || String(e), now()); fail((e && e.message) || String(e)); return paint(); }
    req.on('error', e => { mine.delete(id); if (!stopped) { model.sendFailed(agentId, streamId, (e && e.message) || 'connection failed', now()); fail((e && e.message) || 'connection failed'); paint(); } });
    req.end(payload);
    mine.set(id, { req, agentId, kind: 'run', streamId });
    paint();
  }
  async function answer(key) {
    const q = model.front();
    if (!q) return;
    if (key === 'v') {
      q.view = !q.view;
      if (q.view && q.details == null) {
        paint();
        const r = await get('/api/consent/args?runId=' + encodeURIComponent(q.runId) + '&promptId=' + encodeURIComponent(q.promptId));
        q.details = (r.ok && r.status === 200 && r.json) ? (r.json.noDetails ? 'this ask carries no further detail' : String(r.json.args || '')) : (r.json && r.json.error) || 'the full request could not be read';
      }
      return paint();
    }
    // y once · a always (this kind of action from now on, as the app's card offers it) · n deny
    const decision = key === 'y' ? 'once' : key === 'a' ? 'always' : 'deny';
    ui.keyFlash = { k: key, until: now() + 700 };
    const r = await client.request('POST', '/api/consent', { runId: q.runId, promptId: q.promptId, decision, via: 'terminal' });
    if (r.ok && r.json && r.json.ok) model.apply('permission.response', { promptId: q.promptId, decision: r.json.decision || decision, via: 'terminal' }, now());
    else if (r.ok && r.json && r.json.gone) { model.apply('permission.response', { promptId: q.promptId, decision: 'deny', stopped: true }, now()); flash('that ask is no longer waiting — it was answered elsewhere or its run ended'); }
    else flash('the station did not take that answer' + (r.error ? ' (' + r.error + ')' : r.status ? ' (HTTP ' + r.status + ')' : ''));
    paint();
  }
  // ---- the folder: work in the trusted project `starnet` was started in, or ask to trust it -------------------------
  function setProject(root) { ui.project = root ? { root, label: folderLib.shortPath(root, 60) } : null; }
  async function locateFolder() {
    // a folder here only means that folder to a station on this machine
    if (!folderLib.isLocalHost(client.host)) return;
    const projects = await folderLib.trustedProjects(client).catch(() => []);
    const f = folderLib.locate({ cwd: o.cwd || process.cwd(), projects, stationDirs: o.stationDirs || [] });
    if (f.trusted) return setProject(f.trusted);
    // a shell opens in your home folder (and the like): no card there, unless you named the folder with --cwd
    if (f.skip && !o.cwd) return;
    ui.trust = { root: f.root, folder: f.folder };
  }
  async function answerTrust(key) {
    const t = ui.trust;
    if (!t) return;
    ui.trust = null;
    ui.keyFlash = { k: key, until: now() + 700 };
    if (key !== 'y') return flash('not trusted · the crew works in its own workspace', 'dim', 5000);
    paint();
    const r = await client.request('POST', '/api/projects/bless', { path: t.root }, { timeoutMs: 10000 });
    if (r.ok && r.status === 200 && r.json && r.json.ok && r.json.root) {
      setProject(String(r.json.root));
      flash('trusted · the crew works in ' + folderLib.shortPath(r.json.root, 60) + ' (it is under PROJECTS in the app too)', 'ok', 6000);
    } else flash('the folder was not trusted: ' + ((r.json && r.json.reason) || r.error || 'HTTP ' + r.status), 'bad', 9000);
  }
  async function answerQuestion(text) {
    const q = model.front();
    if (!q || !q.question) return;
    const r = await client.request('POST', '/api/consent/answer', { runId: q.runId, promptId: q.promptId, answer: text, receipt: true, via: 'terminal' });
    if (r.ok && r.json && r.json.ok) model.apply('permission.response', { promptId: q.promptId, decision: 'once', via: 'terminal' }, now());
    else flash('that question is no longer waiting');
    paint();
  }
  async function stopAgent(agentId) {
    const a = model.state.agents.get(agentId);
    if (!a || !a.runs.size) return flash((a ? a.name : 'that agent') + ' has nothing running');
    const ids = [...a.runs];
    const rs = await Promise.all(ids.map(runId => client.request('POST', '/api/cancel', { runId })));
    const n = rs.filter(r => r.ok && r.json && r.json.ok).length;
    flash(n ? 'stopping ' + n + ' run(s) of ' + a.name : 'the station did not confirm the stop', n ? 'ok' : 'am');
  }
  // ---- /model: every model of every CONNECTED provider, the one the agent runs on marked ------------------------------
  let modelsCache = null;
  async function loadModels() {
    if (modelsCache && now() - modelsCache.at < 5 * 60000) return modelsCache.items;
    const pr = await get('/api/providers', 10000);
    if (!(pr.ok && pr.status === 200 && pr.json)) throw new Error(pr.error || 'HTTP ' + pr.status);
    const provs = (pr.json.providers || []).filter(p => p && p.id && p.configured);
    const lists = await Promise.all(provs.map(async p => {
      const r = await get('/api/models/' + encodeURIComponent(p.id), 20000);
      return { p, models: (r.ok && r.status === 200 && r.json && Array.isArray(r.json.models)) ? r.json.models : [] };
    }));
    const items = [];
    for (const { p, models } of lists) for (const m of models) if (m && m.id) items.push({ provider: p.id, id: String(m.id), name: String(m.displayName || m.name || ''), tools: m.supportsTools !== false, ctx: Number(m.context_length) || 0,
      // the window a run works in when the model bills a dearer rate past a prompt size (the station's runWindow)
      runWindow: Number(m.runWindow) > 0 ? Number(m.runWindow) : 0 });
    modelsCache = { at: now(), items };
    return items;
  }
  const padTo = (s, n) => { const t = tui.trunc(String(s), n); return t + ' '.repeat(Math.max(0, n - tui.width(t))); };
  async function openModelPicker(filter) {
    const a = model.state.agents.get(ui.focus);
    if (!a) return flash('no agent to set a model for');
    const p = {
      kind: 'model', title: 'MODEL · ' + a.name, note: 'now ' + (a.provider ? a.provider + ' · ' : '') + (a.model || 'not set'),
      filter: String(filter || ''), sel: 0, items: [], loading: true,
      foot: '↑ ↓ pick · enter switches ' + a.name + ' · esc close · type to filter',
      onPick: it => setModel(a.id, it.provider, it.model)
    };
    ui.picker = p; ui.overlay = null; paint();
    try {
      const items = await loadModels();
      p.items = items.map(m => ({
        provider: m.provider, model: m.id, current: m.provider === a.provider && m.id === a.model,
        search: (m.provider + ' ' + m.id + ' ' + m.name).toLowerCase(),
        cols: [[padTo(m.provider, 12), 'dim'], [m.id, 'fg'], [m.name && m.name.toLowerCase() !== m.id.toLowerCase() ? '   ' + m.name : '', 'dim'], [m.tools ? '' : '   no tools', 'am']]
      }));
      const ci = tui.pickerView(p).findIndex(i => i.current);
      p.sel = ci >= 0 ? ci : 0;
    } catch (e) { p.error = 'the station did not list its models: ' + ((e && e.message) || e); }
    p.loading = false;
    // /model <name> that matches exactly one model switches at once
    if (p.filter && ui.picker === p) { const v = tui.pickerView(p); if (v.length === 1) { ui.picker = null; return setModel(a.id, v[0].provider, v[0].model); } }
    paint();
  }
  async function setModel(agentId, provider, modelId) {
    const a = model.state.agents.get(agentId);
    if (!a) return;
    flash('switching ' + a.name + ' to ' + provider + ' · ' + modelId + '…', 'am', 15000);
    const r = await client.request('POST', '/api/agent/model', { agentId, model: modelId, provider }, { timeoutMs: 15000 });
    const u = unconfirmed(r, a);
    if (u) {
      if (u.gone) flash(u.line, 'bad', 9000);
      else {
        a.model = String(u.st.model || ''); a.provider = String(u.st.provider || '');   // what the station holds, as it says it
        flash(u.lead + ' The station has ' + a.name + (a.model ? ' on ' + a.provider + ' · ' + a.model : ' with no model') + ' right now.', 'am', 12000);
      }
    } else if (r.ok && r.status === 200 && r.json && r.json.ok) {
      a.model = String(r.json.model); a.provider = String(r.json.provider);
      flash(a.name + ' now runs on ' + a.provider + ' · ' + a.model + ' (from its next message)', 'ok', 6000);
    } else flash('the model did not change: ' + ((r.json && r.json.error) || r.error || (r.status === 404 ? 'this station is older than /model' : 'HTTP ' + r.status)), 'bad', 9000);
    loadRoster().then(paint, () => {});
  }
  /* ---- /connect: the app's SETTINGS › AI & MODELS list (bin/lib/connect.js), in its groups, each row saying what the
     station proves about it; a pick runs that provider's own way in — a sign-in (the awakening's, in the same view), a
     link, or a key typed hidden and saved where the app keeps keys. A provider connected here is one /model lists. */
  let stIO = null;
  const connectIO = () => stIO || (stIO = require('./station-io.js').makeStationIO(client));
  async function connectFacts() {
    const ok = r => !!(r && r.ok && r.status === 200 && r.json);
    const [pr, cr, cl, ol] = await Promise.all([get('/api/providers', 10000), get('/api/credits?history=0', 20000),
      get('/api/auth/claude-cli/status', 15000), get('/api/models/ollama', 6000)]);
    let credits = { state: 'absent' };
    if (ok(cr) && cr.json.configured) credits = { state: cr.json.linkStatus === 'unavailable' ? 'saved' : 'linked', balanceUsd: typeof cr.json.balanceUsd === 'number' ? cr.json.balanceUsd : null };
    else { const lk = await get('/api/credits/linkable', 10000); if (ok(lk) && lk.json.available) credits = { state: 'linkable' }; }
    return {
      read: ok(pr), error: pr.error || 'HTTP ' + pr.status,
      configured: new Set(ok(pr) ? (pr.json.providers || []).filter(p => p && p.configured).map(p => p.id) : []),
      credits, claude: ok(cl) && typeof cl.json.installed === 'boolean' ? cl.json : null,
      ollama: ok(ol) && Array.isArray(ol.json.models) && ol.json.models.length > 0
    };
  }
  async function openConnectPicker(arg) {
    const want = String(arg || '').trim();
    if (want) {
      const hit = connect.find(want);
      if (!hit) return sayHere('/connect', ['No provider called ' + want + ' — /connect lists every one.'], false, 'CONNECT');
      return connectFlow(hit);
    }
    const p = {
      kind: 'connect', title: 'CONNECT · AI & MODELS', note: 'the AI your agents think with', filter: '', sel: 0, items: [], loading: true, groupW: 1,
      foot: '↑ ↓ pick · enter connects it · esc close · type to filter',
      onPick: it => connectFlow(it.p)
    };
    ui.picker = p; ui.overlay = null; paint();
    const f = await connectFacts();
    if (!f.read) p.error = 'the station did not list its providers: ' + f.error;
    // STARNET MANAGED is drawn only where the app draws it: a station a StarNet account can link (or already has)
    p.items = connect.ordered().filter(x => x.id !== 'starnet' || f.credits.state !== 'absent').map(x => {
      const g = connect.groupOf(x.id), st = connect.status(x, f);
      return { p: x, group: g.label, groupShort: g.short, search: (x.id + ' ' + x.name + ' ' + g.label + ' ' + connect.need(x)).toLowerCase(),
        cols: [[padTo(x.name, 18), 'fg'], [padTo(connect.need(x), 36), 'dim'], st] };
    });
    p.loading = false;
    paint();
  }
  let connecting = null;   // the /connect on screen: { cancelled }
  async function connectFlow(p) {
    if (ui.wake) return flash('finish what is on screen first', 'am');
    const run = { cancelled: false };
    connecting = run;
    ui.picker = null;
    ui.wake = { connect: true, crew: true, log: [], ask: null, stage: { title: 'CONNECT', detail: p.name }, speaker: 'STARNET', feedKey: null, note: '', typing: false, ff: false };
    paint();
    let out = { ok: false, msg: '' };
    try {
      for (;;) {
        out = connect.flowOf(p.id) === 'key' || connect.flowOf(p.id) === 'custom' ? await connectKey(p, run) : await connectSignIn(p);
        if (out.ok || run.cancelled || !out.retry) break;
        // a sign-in that did not land: its reason stays on screen until you choose
        const a = await wakeIO.ask({ options: [{ label: 'Try again', value: 'again' }, { label: 'Close', value: 'close', skip: true }] });
        if (run.cancelled || a.value !== 'again') break;
      }
    } catch (e) { out = { ok: false, msg: 'the connection stopped: ' + ((e && e.message) || e) }; }
    const said = ui.wake ? [...ui.wake.log].reverse().find(e => e.who === 'STARNET') : null;
    connecting = null; ui.wake = null; ui.input = ''; modelsCache = null;
    const a = model.state.agents.get(ui.focus);
    if (out.ok) sayHere('/connect', [out.msg + ' /model picks one of its models' + (a ? ' for ' + a.name : '') + '.'], true, 'CONNECT');
    else if (run.cancelled) flash('nothing was connected', 'dim', 4000);
    else sayHere('/connect', [p.name + ' is not connected' + (out.msg ? ': ' + out.msg : said ? ': ' + said.text : '.')], false, 'CONNECT');
  }
  async function connectSignIn(p) {
    const aw = require('./awaken.js').makeAwakening({ st: connectIO(), io: wakeIO, mods: {}, env });
    const ok = await aw.signIn(connect.brainOf(p.id));
    return ok ? { ok: true, msg: p.name + ' is connected.' } : { ok: false, retry: true };
  }
  async function connectKey(p, run) {
    const say = t => wakeIO.say([{ text: t, cps: 70 }], { who: 'STARNET' });
    const back = { label: 'Go back', value: 'back', skip: true };
    let baseUrl = '';
    if (p.id === 'custom') {
      await say('the endpoint’s address — its /v1 base URL, for example http://localhost:1234/v1');
      for (;;) {
        const a = await wakeIO.ask({ options: [back], custom: true, freeText: true, customLabel: 'the URL' });
        if (run.cancelled || a.value === 'back') return { ok: false };
        const n = connect.normEndpoint(a.value);
        if (n) { baseUrl = n; break; }
        await say('that doesn’t look like a URL — for example http://localhost:1234/v1');
      }
    }
    await say((p.id === 'custom' ? 'its API key, if it needs one' : 'paste your ' + p.name + ' key') + ' — it stays hidden here, StarNet checks it with ' + (p.id === 'custom' ? 'the endpoint' : p.name) + ' first, then keeps it where the app keeps keys');
    for (;;) {
      const a = await wakeIO.ask({ options: p.id === 'custom' ? [back, { label: 'No key — save the endpoint', value: 'nokey' }] : [back], custom: true, secret: true, customLabel: 'the key' });
      if (run.cancelled || a.value === 'back') return { ok: false };
      const key = a.value === 'nokey' ? '' : String(a.value || '').replace(/\s+/g, '');
      wakeIO.note(key ? 'checking the key with ' + (p.id === 'custom' ? 'the endpoint' : p.name) + '…' : 'saving the endpoint…', 'dim');
      const r = await connect.saveKey(connectIO(), p.id, key, baseUrl);
      wakeIO.note('', 'dim');
      if (run.cancelled) return { ok: false };
      if (r.ok) {
        const where = r.store === 'keychain' ? ' in your OS keychain' : r.store === 'browser' ? ' in StarNet' : ' on this station';
        return { ok: true, msg: p.name + (key ? ' key saved' + where + (r.verified ? ' — ' + (p.id === 'custom' ? 'the endpoint' : p.name) + ' accepted it.' : '.') : ' endpoint saved' + where + '.') };
      }
      await say('not saved: ' + r.error + '. paste it again, or go back');
    }
  }
  function pickerKey(str, k) {
    const p = ui.picker, list = tui.pickerView(p);
    if (k.name === 'escape') { ui.picker = null; return paint(); }
    if (k.name === 'up') { p.sel = Math.max(0, (p.sel | 0) - 1); return paint(); }
    if (k.name === 'down') { p.sel = Math.max(0, Math.min(list.length - 1, (p.sel | 0) + 1)); return paint(); }
    if (k.name === 'pageup') { p.sel = Math.max(0, (p.sel | 0) - 10); return paint(); }
    if (k.name === 'pagedown') { p.sel = Math.max(0, Math.min(list.length - 1, (p.sel | 0) + 10)); return paint(); }
    if (k.name === 'return' || k.name === 'enter') { const it = list[p.sel | 0]; if (it && p.onPick && !p.loading) { ui.picker = null; p.onPick(it); } return paint(); }
    if (k.name === 'backspace') { p.filter = p.filter.slice(0, -1); p.sel = 0; return paint(); }
    if (k.sequence && /^\x1b\[[?\d;]*[ct]$/.test(k.sequence)) return;
    if (typeof str !== 'string' || !str || k.ctrl || k.meta || str.charCodeAt(0) === 27) return;
    const ch = str.replace(/[\x00-\x1f\x7f]/g, '');
    if (ch && p.filter.length < 80) { p.filter += ch; p.sel = 0; }
    paint();
  }

  async function runFlow(word, text) {
    const line = model.findLine(word);
    if (!line) return flash('no workflow named ' + word + ' · /flow lists them');
    const name = line.name || line.lineId;
    flash('sending one job down ' + name + ' · it runs until the line delivers', 'ok', 5000);
    const id = 'flow' + Math.random().toString(36).slice(2);
    mine.set(id, { req: null, agentId: '', kind: 'flow' });
    const r = await client.request('POST', '/api/routing/sample', { text, line: line.lineId }, { timeoutMs: 60 * 60 * 1000 });
    mine.delete(id);
    if (r.ok && r.status === 200 && r.json && r.json.ok) flash(name + ' delivered' + (r.json.totalUsd ? ' · $' + Number(r.json.totalUsd).toFixed(3) : ''), 'ok', 8000);
    else flash(name + ': ' + ((r.json && (r.json.error || r.json.reason)) || r.error || 'HTTP ' + r.status), 'bad', 8000);
    loadLines().then(paint, () => {});
  }

  // ---- THE "/" MENU: every command, from the station's own catalog for the agent shown + the terminal's own ----------------
  // what this terminal runs itself (the rest of the app's commands are the station's, or still the app's: marked so)
  const TERMINAL_COMMANDS = [
    { name: 'flow', aliases: ['flows'], desc: 'list workflows · /flow run <name> <text> sends one job down one', argsHint: '[run <name> <text>]' },
    { name: 'stat', desc: 'the STAT page: the station\'s level, spend, crew and work' },
    { name: 'crew', desc: 'the CREW page: every agent on one line' },
    { name: 'work', desc: 'the WORK page: workflows, routines, the away shift' },
    { name: 'comms', desc: 'back to the conversation' },
    { name: 'connect', aliases: ['providers'], desc: 'add a provider — the app’s AI & MODELS list: sign in, link, or paste a key', argsHint: '[provider]' },
    { name: 'theme', aliases: ['themes'], desc: 'the terminal colors: ' + theme.NAMES.join(' · '), argsHint: '[' + theme.NAMES.join('|') + ']' },
    { name: 'quit', aliases: ['exit'], desc: 'quit starnet' }
  ].map(c => Object.assign({ source: 'terminal', aliases: [], argsHint: '', here: true }, c));
  const HANDLED_HERE = ['help', 'quit', 'exit', 'stat', 'crew', 'work', 'comms', 'connect', 'providers', 'theme', 'themes', 'model', 'new', 'clear', 'resume', 'stop', 'flow', 'retry', 'status', 'whoami', 'version', 'skills', 'history', 'cron',
    'agents', 'insights', 'memory', 'bundles', 'blueprint', 'reload-mcp', 'reload-skills', 'steer', 'copy', 'compress', 'reasoning', 'fast', 'debug', 'queue', 'background', 'loop', 'save', 'goal', 'subgoal', 'yolo', 'personality'];
  async function loadCatalog() {
    const id = ui.focus || 'agent';
    const r = await get('/api/slash/catalog?agent=' + encodeURIComponent(id) + '&client=terminal', 15000);
    const cmds = (r.ok && r.status === 200 && r.json && Array.isArray(r.json.commands)) ? r.json.commands : null;
    if (!cmds) return;
    const seen = new Set(TERMINAL_COMMANDS.map(c => c.name));
    const list = cmds.filter(c => c && c.name && !seen.has(c.name) && c.available !== false && c.enabled !== false).map(c => ({
      name: String(c.name), aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [], desc: String(c.desc || ''), argsHint: String(c.argsHint || ''), source: String(c.source || 'builtin'),
      // the station runs its own commands, skills, recipes and yours; an app command the terminal does not run yet says so
      here: c.source !== 'builtin' || c.dispatch === 'server' || HANDLED_HERE.indexOf(String(c.name)) >= 0
    }));
    ui.slashCatalog = list.concat(TERMINAL_COMMANDS);
    ui.slashFor = id;
  }
  // tab (or a click on its line) puts the command in the prompt, ready for what it takes
  function completeSlash(name) {
    ui.input = '/' + name + ' ';
    slashReset();
    paint();
  }
  // a row picked with ↑ ↓ belongs to the line it was picked on: a line put in whole (history, esc, a completion, a
  // blueprint) starts unpicked at the top row, so enter never runs a row picked on a line given up (review 10-24)
  function slashReset() { ui.slashSel = 0; ui.slashPicked = false; ui.slashPickedOn = null; }

  // ---- THE PAGES: STAT · CREW · COMMS · WORK · SKILLS (the tab rule, f1-f5, /stat /crew /work) ---------------------------
  // what a page shows that the live feed does not carry is read when it opens, and again while it stays open
  let CronHuman = null;
  const appModule = name => require(require('node:path').join(__dirname, '..', '..', 'frontend', 'app', name));
  async function loadUsage() {
    const a = model.state.agents.get(ui.focus);
    const r = await client.request('POST', '/api/slash/dispatch', { input: '/usage', agentId: a ? a.id : 'agent', client: 'terminal' }, { timeoutMs: 20000 });
    const d = r.ok && r.status === 200 && r.json && r.json.ok && r.json.directive;
    ui.pageData.usage = d && d.type === 'say'
      ? { title: String(d.title || ''), lines: (Array.isArray(d.lines) && d.lines.length ? d.lines : String(d.text || '').split('\n')).map(String).filter(l => l.trim()) }
      : { error: 'the station did not say its spend (' + ((r.json && r.json.error) || r.error || 'HTTP ' + r.status) + ')' };
  }
  async function loadRoutines() {
    const r = await get('/api/cron', 10000);
    if (!(r.ok && r.status === 200 && r.json)) { ui.pageData.cron = { error: 'the routines could not be read (' + (r.error || 'HTTP ' + r.status) + ') — their state is unknown' }; return; }
    try { CronHuman = CronHuman || appModule('cronhuman.js'); } catch (_) { CronHuman = null; }
    const nameOf = id => { const a = model.state.agents.get(String(id || '')); return a ? a.name : ''; };
    const jobs = (Array.isArray(r.json.jobs) ? r.json.jobs : []).filter(j => j && j.id).map(j => {
      const shown = String(j.scheduleDisplay || j.schedule || '');
      const next = Date.parse(j.nextRunAt) || Number(j.nextRunAt) || 0;
      return { name: String(j.name || j.id), when: (CronHuman ? CronHuman.describeDisplay(shown) : shown) || 'no schedule', agent: nameOf(j.agentId),
        enabled: j.enabled !== false, inFlight: !!j.inFlight, next: next > now() ? 'in ' + require('./station-model.js').fmtShort(next - now()) : '' };
    });
    ui.pageData.cron = { enabled: !!r.json.enabled, halted: !!r.json.halted, jobs };
  }
  async function loadAway() {
    const a = model.state.agents.get(ui.focus);
    if (!a) { ui.pageData.away = { error: 'no agent shown' }; return; }
    const r = await client.request('POST', '/api/slash/dispatch', { input: '/away list', agentId: a.id, client: 'terminal' }, { timeoutMs: 20000 });
    const d = r.ok && r.status === 200 && r.json && r.json.ok && r.json.directive;
    ui.pageData.away = d && d.type === 'say'
      ? { agent: a.name, title: String(d.title || ''), lines: (Array.isArray(d.lines) ? d.lines : String(d.text || '').split('\n')).map(String).filter(l => l.trim()) }
      : { agent: a.name, error: 'the away shift could not be read (' + ((r.json && r.json.error) || r.error || 'HTTP ' + r.status) + ')' };
  }
  function loadPage() {
    if (ui.page === 'stat') return loadUsage().catch(() => {});
    if (ui.page === 'work') return Promise.all([loadRoutines(), loadAway()]).catch(() => {});
    return Promise.resolve();
  }
  function openPage(p) {
    if (ui.wake) return;
    ui.agentMenu = ''; ui.overlay = null; ui.pageScroll = 0; ui.picker = null;
    if (p === 'skills') { ui.page = ''; return openSkillsPicker(''); }
    ui.page = p === 'comms' ? '' : p;
    if (ui.page === 'stat') ui.pageData.usage = { loading: true };
    if (ui.page === 'work') { ui.pageData.cron = ui.pageData.cron || { loading: true }; ui.pageData.away = { loading: true }; }
    paint();
    loadPage().then(paint, () => {});
  }
  // a chat opened from anywhere: the agent's conversation in COMMS
  function openChat(id) {
    if (!model.state.agents.has(id)) return;
    if (ui.focus !== id) { ui.focus = id; ui.scroll = 0; }
    ui.page = ''; ui.agentMenu = ''; ui.overlay = null; ui.picker = null;
    paint();
  }
  // THE AGENT MENU: o open chat · m model · n new chat · h history · s stop (a card at the foot of COMMS)
  function openMenu(id) {
    if (ui.wake || !model.state.agents.has(id)) return;
    ui.agentMenu = id; ui.overlay = null;
    paint();
  }
  function menuKey(k) {
    const id = ui.agentMenu;
    ui.agentMenu = '';
    if (k === 'escape' || !model.state.agents.has(id)) return paint();
    if (k === 'o') return openChat(id);
    // the rest act on the agent shown in COMMS, as their slash commands do: show it first
    openChat(id);
    if (k === 'm') return openModelPicker('');
    if (k === 'n') return newConversation();
    if (k === 'h') return openResumePicker();
    if (k === 's') return stopAgent(id);
  }
  // a letter the open ask or the folder card answers (the keyboard's y a n v, a click on its [Y] [A] [N] [V])
  function answerKey(ch) {
    const q = model.front();
    if (q && !q.question && /^[ynv]$/.test(ch)) { answer(ch); return true; }
    if (q && !q.question && ch === 'a' && ONCE_ONLY_TOOLS.indexOf(q.tool) < 0) { answer('a'); return true; }
    if (!q && ui.trust && !ui.wake && /^[yn]$/.test(ch)) { answerTrust(ch); return true; }
    return false;
  }

  // ---- THE MOUSE (bin/lib/mouse.js): a click acts on what the screen drew under it, as its key would --------------------
  let lastHits = [], lastAreas = {}, lastScreen = [];
  const inArea = (a, x, y) => !!a && x >= a.x0 && x < a.x1 && y >= a.y0 && y < a.y1;
  function openExternal(url) {
    const { spawn } = require('node:child_process');
    // never through a shell: a link is the program's argument, whatever characters it carries
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => flash('could not open a browser for ' + url, 'bad', 8000)); c.unref(); } catch (_) { flash('could not open a browser for ' + url, 'bad', 8000); }
  }
  const openUrl = o.openUrl || openExternal;
  // a file an agent wrote, on the station's own page for it (signed, so the browser needs no key). Its folder is the run's:
  // the trusted project the live feed said it works in; from an older station, the one its record names once it ends (while
  // it runs, only a run this terminal started is known for sure)
  async function openFile(act) {
    const a = model.state.agents.get(act.agentId);
    if (!folderLib.isLocalHost(client.host)) return flash('a file opens only from a station on this computer');
    let tickets;
    try { tickets = require(require('node:path').join(__dirname, '..', '..', 'sidecar', 'apitickets.js')); } catch (_) { return flash('this starnet cannot sign a file link (the station’s ticket module is missing)', 'bad', 8000); }
    let project = typeof act.root === 'string' ? act.root : null;
    if (project === null) {
      const r = act.runId ? await get('/api/runs?agent=*&runId=' + encodeURIComponent(act.runId), 8000) : null;
      const rec = r && r.ok && r.status === 200 && r.json && Array.isArray(r.json.runs) ? r.json.runs.find(x => x && x.runId === act.runId) : null;
      const run = model.state.runs.get(String(act.runId));
      if (rec) project = String(rec.projectRoot || '');
      else if (run && a && (run.streamId === streamOf(a.id) || run.streamId.indexOf(core.cliStreamId(a.id)) === 0)) project = ui.project ? ui.project.root : '';
    }
    if (project === null) return flash('that run is still going — its file opens once the station has recorded where it worked', 'am', 7000);
    openUrl(mouse.fileUrl(client.base, tickets, client.token(), { agent: act.agentId, path: act.path, project, now: now() }));
    flash('opening ' + act.path + ' (' + (project ? folderLib.shortPath(project, 40) : (a ? a.name : act.agentId) + '’s workspace') + ') in your browser', 'ok', 6000);
  }
  function onMouse(ev) {
    if (stopped) return;
    if (ev.kind === 'wheel') {
      const d = ev.dir === 'up' ? 1 : -1;
      if (ui.picker) { const n = tui.pickerView(ui.picker).length; ui.picker.sel = Math.max(0, Math.min(n - 1, (ui.picker.sel | 0) - d)); return paint(); }
      if (!inArea(lastAreas.comms, ev.x, ev.y)) return;
      if (ui.overlay) ui.overlay.scroll = Math.max(0, (ui.overlay.scroll | 0) - 3 * d);
      else if (ui.page) ui.pageScroll = Math.max(0, (ui.pageScroll | 0) - 3 * d);
      else ui.scroll = Math.max(0, ui.scroll + 3 * d);
      return paint();
    }
    if (ev.kind !== 'down') return;
    const h = mouse.hitAt(lastHits, ev.x, ev.y);
    const act = h && h.act;
    ui.quitArmed = 0;
    // ctrl+click: a link drawn there, or the file a tool line names
    if (ev.ctrl && ev.button === 'left') {
      if (act && act.t === 'file') { openFile(act).catch(() => {}); return; }
      const url = mouse.urlAt(lastScreen[ev.y], ev.x, ch => tui.width(ch));
      if (url) { openUrl(url); flash('opening ' + url + ' in your browser', 'ok', 5000); }
      return;
    }
    if (ev.button === 'right') { if (act && act.t === 'agent') openMenu(act.id); return; }
    if (ev.button !== 'left') return;
    if (!act) {
      // a click anywhere off a list laid over COMMS closes it, as any key does
      if (ui.overlay) { ui.overlay = null; paint(); }
      return;
    }
    if (ui.overlay && act.t !== 'tab') { ui.overlay = null; paint(); return; }
    switch (act.t) {
      case 'tab': return act.here && act.page === 'comms' && ui.focus && !ui.overlay && !ui.picker ? openMenu(ui.focus) : openPage(act.page);
      case 'page': return openPage(act.page);
      case 'agent':
        // the agent already in COMMS (on COMMS): its menu; any other, its chat
        if (!ui.page && act.id === ui.focus && !ui.picker && !ui.wake) return openMenu(act.id);
        return ui.wake ? undefined : openChat(act.id);
      case 'needs': { const q = model.front(); if (q) openChat(q.agentId); return; }
      case 'model': return openModelPicker('');
      case 'menu': return menuKey(act.key);
      case 'key': if (!answerKey(act.key)) paint(); return;
      case 'answer': { const q = model.front(); if (q && q.question && q.question.options[act.i] != null) answerQuestion(q.question.options[act.i]); return; }
      case 'wake': if (ui.wake && ui.wake.ask && ui.wake.ask.options[act.i]) wakeAnswer(Object.assign({}, ui.wake.ask.options[act.i])); return;
      case 'enter': onKey('\r', { name: 'return', sequence: '\r' }); return;
      case 'pick': {
        const p = ui.picker, list = p ? tui.pickerView(p) : [];
        const it = list[act.i];
        if (it && p.onPick && !p.loading) { ui.picker = null; p.onPick(it); }
        return paint();
      }
      case 'flow': ui.page = ''; ui.input = '/flow run ' + (/\s/.test(act.name) ? act.name.split(/\s+/)[0] : act.name) + ' '; flash('type the job for ' + act.name + ' and press enter', 'ok', 6000); return;
      case 'slash': return completeSlash(act.name);
      case 'file': return;   // a plain click on a file line: nothing (ctrl+click opens it)
    }
  }
  const mouseReader = mouse.makeReader(onMouse, () => onKey('\x1b', { name: 'escape', sequence: '\x1b' }));

  // ---- input ------------------------------------------------------------------------------------------------
  function historyStep(d) {
    const h = ui.history;
    if (!h.length) return;
    if (ui.histAt == null) { if (d > 0) return; ui.histDraft = ui.input; ui.histAt = h.length; }
    const i = Math.max(0, Math.min(h.length, ui.histAt + d));
    ui.input = i === h.length ? ui.histDraft : h[i];
    ui.histAt = i === h.length ? null : i;
    ui.histEdited = false;
    slashReset();
  }
  function submit(raw) {
    const text = String(raw || '').trim();
    ui.overlay = null;
    if (text) ui.page = '';   // what you send is answered in COMMS: the page gives way to it
    ui.histAt = null; ui.histDraft = ''; ui.histEdited = false;
    slashReset();
    if (!text) return;
    if (ui.history[ui.history.length - 1] !== text) { ui.history.push(text); if (ui.history.length > 200) ui.history.shift(); }
    const q = model.front();
    if (q && q.question && text[0] !== '@' && text[0] !== '/') return answerQuestion(text);
    if (text[0] === '/') return command(text);
    let target = ui.focus, body = text;
    const m = /^@(\S+)\s*([\s\S]*)$/.exec(text);
    if (m) {
      const a = model.findAgent(m[1]);
      if (!a) return flash('no agent named ' + m[1] + ' · ' + model.state.order.map(id => '@' + model.state.agents.get(id).name.toLowerCase()).join(' '));
      ui.focus = a.id; target = a.id; body = m[2].trim();
      if (!body) return paint();
    }
    if (!target) return flash('no agent to talk to');
    goalPreempt(target);   // you typed to a conversation whose goal is working: you took over, the loop pauses
    // its conversation still running: the message waits its turn (the app's queue), never a second run racing the first
    if (busy(target)) { queueText(target, body); return flash('queued for ' + model.state.agents.get(target).name + ' — it goes the moment the running turn ends · /queue lists it', 'ok', 6000); }
    send(target, body);
  }
  function command(text) {
    const parts = text.split(/\s+/), cmd = parts[0].toLowerCase();
    if (cmd === '/help' || cmd === '/?') { ui.overlay = { title: 'COMMANDS', items: tui.HELP, foot: 'any key closes this' }; return paint(); }
    if (cmd === '/quit' || cmd === '/exit') return quit(true);
    if (cmd === '/stat' || cmd === '/crew' || cmd === '/work' || cmd === '/comms') return openPage(cmd.slice(1));
    if (cmd === '/theme' || cmd === '/themes') return themeCommand(parts[1] || '');
    if (cmd === '/connect' || cmd === '/providers') return openConnectPicker(parts.slice(1).join(' '));
    // the app's own commands, done here (above: what each does and which station route it uses)
    const rest = text.slice(parts[0].length).trim();
    if (cmd === '/agents' || cmd === '/tasks') return openPage('crew');
    if (cmd === '/insights') return insightsCommand();
    if (cmd === '/memory') return memoryCommand(rest);
    if (cmd === '/bundles') return bundlesCommand();
    if (cmd === '/blueprint' || cmd === '/bp') return blueprintCommand(rest);
    if (cmd === '/reload-mcp' || cmd === '/reload_mcp') return reloadMcpCommand(rest);
    if (cmd === '/reload-skills' || cmd === '/reload_skills') return reloadSkillsCommand();
    if (cmd === '/steer') return steerCommand(rest);
    if (cmd === '/copy') return copyCommand();
    if (cmd === '/compress') return compressCommand();
    if (cmd === '/reasoning') return reasoningCommand(rest);
    if (cmd === '/fast') return fastCommand();
    if (cmd === '/debug') return debugCommand();
    if (cmd === '/queue' || cmd === '/q') return queueCommand(rest);
    if (cmd === '/background' || cmd === '/bg' || cmd === '/btw') return backgroundCommand(rest);
    if (cmd === '/loop') return loopCommand(rest);
    if (cmd === '/yolo') return yoloCommand(rest);
    if (cmd === '/personality') return personalityCommand(rest);
    if (cmd === '/goal') return goalCommand(rest);
    if (cmd === '/subgoal') return subgoalCommand(rest);
    if (APP_ONLY[cmd]) return sayHere(cmd, [APP_ONLY[cmd]]);
    if (cmd === '/model' || cmd === '/models') return openModelPicker(parts.slice(1).join(' '));
    if (cmd === '/new' || cmd === '/clear') return newConversation();
    if (cmd === '/resume' || cmd === '/conversations') return openResumePicker();
    if (cmd === '/stop') {
      const a = parts[1] ? model.findAgent(parts[1]) : model.state.agents.get(ui.focus);
      if (!a) return flash('no agent named ' + parts[1]);
      if (loops.has(a.id)) loopStop(a.id, '/stop ends it');   // as in the app: /stop also ends a /loop
      // …and pauses the goal on the conversation shown: a stopped step is never followed by the next one
      const g = GoalLoop && goals.get(streamOf(a.id));
      if (g && GoalLoop.isActive(g.s)) {
        const stepRunning = busyOn(a.id, streamOf(a.id)) || g.expectCont;
        GoalLoop.pause(g.s, 'you stopped it');
        sayGoal(a.id, '⏸ session goal paused — ' + (stepRunning ? '/stop ended its step and' : '/stop:') + ' no next step starts. /goal resume to continue.');
      }
      return stopAgent(a.id);
    }
    if (cmd === '/flow' || cmd === '/flows') {
      if (parts[1] === 'run') {
        if (parts.length < 4) return flash('/flow run <name> <the job text>');
        return runFlow(parts[2], parts.slice(3).join(' '));
      }
      const fl = model.flows(now());
      ui.overlay = { title: 'WORKFLOWS', items: fl.length ? fl.map(f => [f.name, f.state + ' · ' + f.text + (f.shipped ? ' · ' + f.shipped + ' shipped' : '')]) : [['none yet', 'build a line in the app (INBOX → steps → OUTBOX)']], foot: 'send one job: /flow run <name> <text>' };
      return paint();
    }
    if (cmd === '/retry') { const last = ui.lastSent[ui.focus]; return last ? send(ui.focus, last.text, last.shown) : flash('nothing sent to ' + ((model.state.agents.get(ui.focus) || {}).name || 'this agent') + ' from here yet'); }
    if (cmd === '/status' || cmd === '/whoami') return showStatus();
    if (cmd === '/version') return showVersion();
    if (cmd === '/skills') return openSkillsPicker(parts.slice(1).join(' '));
    if (cmd === '/history') return openResumePicker();
    if (cmd === '/cron') return cronCommand(parts.slice(1).join(' '));
    // everything else is the station's: its own commands, the Commander's, each skill and recipe
    return stationCommand(text, cmd);
  }
  /* A slash command the station runs (POST /api/slash/dispatch, the same registry the app's "/" and the messaging channels
     use): a server command or one of the Commander's comes back as what the station said, shown in COMMS under the command;
     a skill or recipe comes back as the message that asks for it, sent to the agent (COMMS shows it as you typed it). A
     command only the app's own screen can do says so. */
  async function stationCommand(text, cmd) {
    const a = model.state.agents.get(ui.focus);
    const agentId = a ? a.id : 'agent';
    flash(cmd + ' …', 'dim', 60000);
    const r = await client.request('POST', '/api/slash/dispatch', { input: text, agentId, client: 'terminal' }, { timeoutMs: 60000 });
    ui.flash = null;
    const j = (r && r.json) || {};
    if (r.status === 404 && /unknown slash command/.test(String(j.error || ''))) return flash('unknown command ' + cmd + ' · /help lists them');
    if (!(r.ok && r.status === 200 && j.ok && j.directive)) return flash(cmd + ': ' + (j.error || r.error || 'HTTP ' + r.status), 'bad', 8000);
    const d = j.directive;
    if (d.type === 'say') {
      const lines = Array.isArray(d.lines) && d.lines.some(l => String(l || '').trim()) ? d.lines : String(d.text || '').split('\n');
      model.noteSaid(agentId, cmd, d.title, lines.filter(l => String(l).trim()), d.ok !== false, now());
      ui.scroll = 0; ui.overlay = null;
      return paint();
    }
    if (d.type === 'insert') {
      const body = String(d.text || ''), args = text.slice(text.split(/\s+/)[0].length).trim();
      // a skill needs the task; a recipe, any blank it still has ({topic})
      if (d.source === 'skill' ? !args : /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(body)) return flash(cmd + ' needs what to do: ' + cmd + ' <task>', 'am', 6000);
      if (!a) return flash('no agent to talk to');
      return send(a.id, body, text);
    }
    flash(cmd + ' only works in the StarNet desktop app', 'am', 6000);
  }
  // /cron: the routines scheduler, as the app's /cron does it — on / off arms it, alone it says its real state (a read
  // that failed says the state is unknown, never "off, 0 jobs")
  async function cronCommand(args) {
    const raw = String(args || '').trim().toLowerCase();
    const agentId = ui.focus || 'agent';
    const say = (t, ok) => { model.noteSaid(agentId, '/cron', '', [t], ok !== false, now()); ui.scroll = 0; paint(); };
    const on = /^(on|enable|enabled|arm)$/.test(raw), off = /^(off|disable|disabled|disarm)$/.test(raw);
    if (on || off) {
      const r = await client.request('POST', '/api/cron/arm', { enabled: on }, { timeoutMs: 10000 });
      return say(r.ok && r.status === 200 && r.json ? 'Routines scheduler ' + (r.json.enabled ? 'enabled' : 'disabled') + '.' : 'Could not update the routines scheduler (' + (r.error || 'HTTP ' + r.status) + ').', r.ok && r.status === 200);
    }
    if (raw) return say('/cron takes on or off — /routine lists, adds, pauses and deletes routines.', false);
    const r = await get('/api/cron');
    if (!(r.ok && r.status === 200 && r.json)) return say('Could not read the routines scheduler (' + (r.error || 'HTTP ' + r.status) + ') — its real state is unknown.', false);
    const j = r.json, jobs = Array.isArray(j.jobs) ? j.jobs : [];
    const bits = jobs.slice(0, 5).map((job, i) => (i + 1) + '. ' + (job.name || job.id || 'routine') + (job.enabled === false ? ' [paused]' : ''));
    say('Routines: scheduler ' + (j.halted ? 'stopped (E-STOP)' : j.enabled ? 'on' : 'off') + ', ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') +
      (bits.length ? ' - ' + bits.join(' | ') : '.') + (j.halted ? ' Use /cron on to resume.' : ' Use /cron on or /cron off to arm/disarm.'));
  }
  /* THE APP'S COMMANDS, HERE (Andrew 10-24: "they should also be able to use any command they would use in starnet"). Each
     one does what the app's own does (frontend/app/chat.js), on the station routes it uses, and says it in COMMS under the
     command. A read that failed says so — never "none". */
  const sayHere = (cmd, lines, ok, title) => { model.noteSaid(ui.focus || 'agent', cmd, title || '', lines, ok !== false, now()); ui.scroll = 0; ui.overlay = null; paint(); };
  const usd2 = n => '$' + (Number(n) || 0).toFixed(2);
  /* /theme: the app's color presets (amber, green, blue, purple, white) or the terminal's own neon red. The pick recolors
     the whole screen at once — the accent, the logo, the camera feed — and is kept for the next starnet (cli.json). */
  function themeCommand(arg) {
    const want = String(arg || '').toLowerCase().trim();
    const list = () => theme.NAMES.map(n => (n === themeName ? '▸ ' : '  ') + n + ' — ' + theme.BLURB[n]);
    if (!want) return sayHere('/theme', ['Theme: ' + themeName + (env.STARNET_THEME ? ' (STARNET_THEME)' : '') + '. /theme <name> picks one:'].concat(list()), true, 'THEME');
    if (!theme.known(want)) return sayHere('/theme', ['No theme named ' + want + '. Pick one of: ' + theme.NAMES.join(', ') + '.'], false, 'THEME');
    themeName = theme.apply(want, themeTargets);
    let kept = '';
    try { theme.save(themeName, env, themeFile); kept = ' — kept for the next starnet'; } catch (e) { kept = ' — for this session only (it could not be saved: ' + e.message + ')'; }
    if (env.STARNET_THEME && env.STARNET_THEME.toLowerCase().trim() !== themeName) kept += '; STARNET_THEME=' + env.STARNET_THEME + ' still wins at the next start';
    redrawAll();
    sayHere('/theme', ['Theme: ' + themeName + ', ' + theme.BLURB[themeName] + kept + '.'], true, 'THEME');
  }
  async function insightsCommand() {
    const id = ui.focus || 'agent';
    const r = await get('/api/insights?agent=' + encodeURIComponent(id), 15000);
    const j = r.ok && r.status === 200 && r.json;
    if (!(j && j.totalRuns != null)) return sayHere('/insights', ['The run history could not be read (' + (r.error || 'HTTP ' + r.status) + ').'], false);
    // a subscription or unpriced model has no proven $: its fold label, never a bare "$0.00" (the app's /insights)
    const models = Array.isArray(j.byModel) ? j.byModel.slice(0, 3).map(m => (m.model || '?') + ' (' + (m.spendLabel && !(m.usd > 0) ? m.spendLabel : usd2(m.usd) + (m.spendLabel ? ', ' + m.spendLabel : '')) + ')') : [];
    const runsOf = n => n + ' run' + (n === 1 ? '' : 's');
    sayHere('/insights', ['Insights (run history for ' + ((model.state.agents.get(id) || {}).name || id) + '): ' + runsOf(j.totalRuns || 0) + ', '
      + (j.usageMissingRuns ? 'at least ' : '') + usd2(j.totalUsd)
      + (j.unpricedRuns ? ' (+ ' + runsOf(j.unpricedRuns) + ' with no published price)' : '')
      + (j.usageMissingRuns ? ' (' + runsOf(j.usageMissingRuns) + ' stopped mid-answer before usage arrived)' : '')
      + (j.spendUnknownRuns ? ' (+ ' + runsOf(j.spendUnknownRuns) + ' with spend unknown)' : '') + ', ' + (j.totalTokens || 0) + ' tokens'
      + (j.avgUsdPerRun ? ', ' + usd2(j.avgUsdPerRun) + '/run' : '') + (j.successPct == null ? '' : ', ' + j.successPct + '% completed') + (models.length ? '. Top models: ' + models.join(', ') : '') + '.']);
  }
  async function memoryCommand(args) {
    const id = ui.focus || 'agent', q = String(args || '').trim().toLowerCase();
    const r = await get('/api/memory/records?agent=' + encodeURIComponent(id), 15000);
    const recs = r.ok && r.status === 200 && r.json ? (Array.isArray(r.json) ? r.json : Array.isArray(r.json.records) ? r.json.records : null) : null;
    if (!recs) return sayHere('/memory', ['Memory could not be read (' + (r.error || 'HTTP ' + r.status) + ') — this is not a claim that it is empty.'], false);
    const shown = q ? recs.filter(x => String((x && (x.content || x.text || x.kind)) || '').toLowerCase().indexOf(q) >= 0) : recs;
    sayHere('/memory', ['Memory: ' + recs.length + ' record' + (recs.length === 1 ? '' : 's') + (q ? ', ' + shown.length + ' matching "' + q + '"' : '') + (shown.length ? ':' : '.')]
      .concat(shown.slice(0, 6).map(x => '· ' + String((x && (x.content || x.text)) || '').replace(/\s+/g, ' ').slice(0, 160)))
      .concat(shown.length > 6 ? ['… and ' + (shown.length - 6) + ' more (/memory <words> narrows it)'] : []));
  }
  function bundlesCommand() {
    const cat = ui.slashCatalog || [];
    const of = s => cat.filter(c => c.source === s).map(c => c.name);
    const recipes = of('recipe'), skills = of('skill'), yours = of('user');
    if (!ui.slashCatalog) return sayHere('/bundles', ['The station\'s command catalog has not been read yet — /reload-skills reads it.'], false);
    sayHere('/bundles', ['Bundles: ' + recipes.length + ' recipe blueprint' + (recipes.length === 1 ? '' : 's') + (recipes.length ? ' (' + recipes.slice(0, 6).join(', ') + (recipes.length > 6 ? ', …' : '') + ')' : '')
      + '; ' + skills.length + ' skill' + (skills.length === 1 ? '' : 's') + (skills.length ? ' (' + skills.slice(0, 6).join(', ') + (skills.length > 6 ? ', …' : '') + ')' : '')
      + (yours.length ? '; ' + yours.length + ' of your own (' + yours.slice(0, 6).join(', ') + ')' : '') + '.']);
  }
  // /blueprint <recipe>: the recipe's text loaded into the prompt to edit before sending (the app loads it into its composer)
  async function blueprintCommand(args) {
    const raw = String(args || '').trim().toLowerCase().replace(/^\//, '');
    const recipes = (ui.slashCatalog || []).filter(c => c.source === 'recipe');
    if (!raw) return sayHere('/blueprint', ['Blueprints: ' + (recipes.length ? recipes.slice(0, 12).map(c => '/' + c.name).join(', ') + (recipes.length > 12 ? ', …' : '') : 'none') + '. /blueprint <name> loads one into the prompt.']);
    const c = recipes.find(x => x.name.toLowerCase() === raw) || recipes.find(x => x.name.toLowerCase().indexOf(raw) >= 0 || String(x.desc).toLowerCase().indexOf(raw) >= 0);
    if (!c) return sayHere('/blueprint', ['No blueprint matched "' + raw + '".'], false);
    const r = await client.request('POST', '/api/slash/dispatch', { input: '/' + c.name, agentId: ui.focus || 'agent', client: 'terminal' }, { timeoutMs: 20000 });
    const d = r.ok && r.status === 200 && r.json && r.json.ok && r.json.directive;
    if (!(d && d.type === 'insert' && d.text)) return sayHere('/blueprint', ['The station did not hand back /' + c.name + '\'s text (' + ((r.json && r.json.error) || r.error || 'HTTP ' + r.status) + ').'], false);
    ui.input = String(d.text).slice(0, 4000);
    slashReset();
    flash('loaded blueprint /' + c.name + ' into the prompt — fill in its blanks, then press enter', 'ok', 8000);
  }
  async function reloadMcpCommand(args) {
    const target = String(args || '').trim().toLowerCase();
    const r = await get('/api/connectors', 15000);
    if (!(r.ok && r.status === 200 && r.json)) return sayHere('/reload-mcp', ['Could not read your MCP connectors (' + (r.error || 'HTTP ' + r.status) + ') — this is not a claim that you have none.'], false);
    let conns = Array.isArray(r.json.connectors) ? r.json.connectors : [];
    if (target) conns = conns.filter(c => String(c.id || '').toLowerCase() === target);
    if (!conns.length) return sayHere('/reload-mcp', [target ? 'No MCP connector matched "' + target + '".' : 'No MCP connectors are configured.']);
    flash('refreshing ' + conns.length + ' connector(s)…', 'dim', 60000);
    const out = [];
    for (const c of conns) {
      const rr = await client.request('POST', '/api/connectors/refresh', { id: c.id }, { timeoutMs: 60000 });
      const st = rr.json && (rr.json.status || rr.json);
      out.push(String(c.id) + ': ' + ((st && st.state) || (rr.ok && rr.status === 200 ? 'refreshed' : 'error')) + (st && st.toolCount != null ? ' · ' + st.toolCount + ' tools' : ''));
    }
    ui.flash = null;
    sayHere('/reload-mcp', ['MCP refresh:'].concat(out.map(l => '· ' + l)));
  }
  async function reloadSkillsCommand() {
    await loadCatalog().catch(() => {});
    const cat = ui.slashCatalog || [];
    if (!cat.length) return sayHere('/reload-skills', ['The station\'s command catalog could not be read.'], false);
    sayHere('/reload-skills', ['Reloaded the command catalog: ' + cat.length + ' commands — ' + cat.filter(c => c.source === 'skill').length + ' skills, ' + cat.filter(c => c.source === 'recipe').length + ' recipes, ' + cat.filter(c => c.source === 'user').length + ' of your own.']);
  }
  // the live run on the conversation shown (its stream), when there is one
  function liveRunOf(id) {
    const a = model.state.agents.get(id);
    if (!a || !a.runs.size) return '';
    const mineNow = [...a.runs].filter(r => { const run = model.state.runs.get(r); return run && run.streamId === streamOf(id); });
    return mineNow[0] || '';
  }
  async function steerCommand(args) {
    const text = String(args || '').trim();
    if (!text) return sayHere('/steer', ['Usage: /steer <guidance> — folded into the running turn before its next step.'], false);
    const runId = liveRunOf(ui.focus);
    if (!runId) return sayHere('/steer', ['Nothing is running to steer in this conversation. Start a task first, or /queue <text> to stage it for the next run.'], false);
    const r = await client.request('POST', '/api/run/steer', { runId, text }, { timeoutMs: 10000 });
    if (r.ok && r.status === 200 && r.json && r.json.ok) return sayHere('/steer', ['Steering the live run — it folds your note in on its next step: ' + text]);
    if (r.status === 404 || r.status === 409) { queueText(ui.focus, 'Steering note for the current task: ' + text); return sayHere('/steer', ['That run already ended — your note is queued to go with the next message.']); }
    sayHere('/steer', ['The station did not take the steer (' + ((r.json && r.json.error) || r.error || 'HTTP ' + r.status) + ').'], false);
  }
  // /copy: the agent's last reply onto the clipboard — the terminal's own (OSC 52) and the system's (clip / pbcopy / wl-copy)
  function copyCommand() {
    const last = [...model.logOf(ui.focus)].reverse().find(e => e.k === 'agent' && String(e.text || '').trim());
    if (!last) return sayHere('/copy', ['No reply from ' + ((model.state.agents.get(ui.focus) || {}).name || 'this agent') + ' in this conversation yet.'], false);
    const text = String(last.text);
    try { out.write('\x1b]52;c;' + Buffer.from(text, 'utf8').toString('base64') + '\x07'); } catch (_) { /* the terminal ignores OSC 52: the system copy below still runs */ }
    const { spawn } = require('node:child_process');
    const [cmd, args] = process.platform === 'win32' ? ['clip', []] : process.platform === 'darwin' ? ['pbcopy', []] : [process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip', process.env.WAYLAND_DISPLAY ? [] : ['-selection', 'clipboard']];
    try {
      const c = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      c.on('error', () => {});
      // clip.exe reads its input as the console's code page; UTF-16LE with a BOM keeps every character
      c.stdin.end(process.platform === 'win32' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : text);
    } catch (_) { /* no system clipboard tool: OSC 52 above is the copy */ }
    flash('copied ' + text.length + ' characters of the last reply', 'ok', 4000);
  }
  async function compressCommand() {
    const a = model.state.agents.get(ui.focus);
    const used = a && a.lastTokensIn;
    let limit = 0, run = 0;
    if (used && a.model) { try { const m = (await loadModels()).find(x => x.id === a.model && (!a.provider || x.provider === a.provider)); limit = (m && m.ctx) || 0; run = (m && m.runWindow) || 0; } catch (_) { limit = 0; } }
    // measured against the window a run folds in (the app's /compress, context-cost-1023), never a 1M one it bills more past
    const tier = run > 0 && limit > 0 && run < limit, win = tier ? run : limit;
    // the reading is the agent's latest model call on this station (any conversation, the app's included): said as such
    sayHere('/compress', [used && win
      ? 'Chat memory: ' + used + ' / ' + win + ' tokens on ' + a.name + '\'s latest model call (' + Math.round(used / win * 100) + '% — a token is roughly ¾ of a word). '
        + (tier ? 'The model can hold ' + limit + ', but it bills a higher rate for a prompt over ' + run + ' tokens, so a run works in ' + run + '. ' : '')
        + 'When it nears full, older turns are folded into a summary automatically during the next run; there is nothing you need to do.'
      : used ? 'Chat memory: ' + a.name + '\'s latest model call sent ' + used + ' tokens. When a conversation grows past what the model can hold, older turns are folded into a summary automatically during the next run.'
        : 'Chat memory is managed automatically: when a conversation grows past what the model can hold, older turns are folded into a summary during the next run. There is nothing you need to do.']);
  }
  // /reasoning, /fast: the agent's effort dial, saved on the station (POST /api/agent/model: the app's own page when one is
  // open, else the roster), and sent with every message from here
  const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  async function setEffort(cmd, want) {
    const a = model.state.agents.get(ui.focus);
    if (!a) return sayHere(cmd, ['No agent shown.'], false);
    if (!a.model) return sayHere(cmd, [a.name + ' has no model set — /model picks one first.'], false);
    const cur = a.reasoningEffort || 'the provider\'s default';
    if (want === a.reasoningEffort) return sayHere(cmd, ['Reasoning effort is already ' + want + '.']);
    const r = await client.request('POST', '/api/agent/model', { agentId: a.id, model: a.model, provider: a.provider, effort: want }, { timeoutMs: 15000 });
    const u = unconfirmed(r, a);
    if (u) {
      if (u.gone) return sayHere(cmd, [u.line], false);
      a.reasoningEffort = u.st.reasoningEffort || null;
      return sayHere(cmd, [u.lead + ' The station has ' + a.name + '\'s reasoning effort at ' + (a.reasoningEffort || 'the provider\'s default') + ' right now' + (a.reasoningEffort === want ? '.' : '; if the app applies it, it becomes ' + want + '.')], false);
    }
    if (!(r.ok && r.status === 200 && r.json && r.json.ok)) return sayHere(cmd, ['Could not set reasoning effort to ' + want + ' (' + ((r.json && r.json.error) || r.error || 'HTTP ' + r.status) + ') — it is still ' + cur + '.'], false);
    a.reasoningEffort = want;
    sayHere(cmd, ['Reasoning effort: ' + cur + ' → ' + want + ' for ' + a.name + '. Takes effect on your next message.' + (cmd === '/fast' ? ' /reasoning ' + (REASONING_LEVELS.indexOf(cur) >= 0 ? cur : 'medium') + ' puts it back.' : '')]);
  }
  function reasoningCommand(args) {
    const raw = String(args || '').trim().toLowerCase();
    const a = model.state.agents.get(ui.focus);
    if (!raw || raw === 'status') return sayHere('/reasoning', ['Reasoning effort: ' + ((a && a.reasoningEffort) || 'the provider\'s default') + '. Set it with /reasoning ' + REASONING_LEVELS.join('|') + ' — lower answers faster and cheaper, higher thinks longer first.']);
    if (REASONING_LEVELS.indexOf(raw) < 0) return sayHere('/reasoning', ['"' + raw + '" is not a reasoning level. Pick one of: ' + REASONING_LEVELS.join(', ') + '.'], false);
    return setEffort('/reasoning', raw);
  }
  function fastCommand() {
    const a = model.state.agents.get(ui.focus);
    if (a && (a.reasoningEffort === 'minimal' || a.reasoningEffort === 'none')) return sayHere('/fast', ['Already as fast as it gets — reasoning effort is ' + a.reasoningEffort + '. /reasoning medium lets it think longer.']);
    return setEffort('/fast', 'minimal');
  }
  function debugCommand() {
    const a = model.state.agents.get(ui.focus) || {};
    ui.overlay = {
      title: 'DEBUG', foot: 'any key closes this',
      items: [['agent', (a.name || '—') + ' (' + (ui.focus || '—') + ')'], ['conversation', streamOf(ui.focus || 'agent')], ['live runs', a.runs && a.runs.size ? [...a.runs].join(', ') : 'none'],
        ['model', (a.provider ? a.provider + ' · ' : '') + (a.model || 'not set') + (a.reasoningEffort ? ' · effort ' + a.reasoningEffort : '')], ['feed', String(model.state.feed || '—') + (cursor ? ' · cursor ' + cursor : '')],
        ['open asks', String(model.state.prompts.length)], ['commands', String((ui.slashCatalog || []).length) + ' in the / menu'], ['folder', ui.project ? ui.project.root : 'its own workspace'],
        ['station', ui.stationLabel], ['terminal', (out.columns || '?') + '×' + (out.rows || '?') + (ui.images ? ' · images' : '') + (mouseOn ? ' · mouse' : '')]]
    };
    paint();
  }
  /* /queue: text held for the conversation shown, sent the moment its turn ends — the app's own queue. A message typed while
     that conversation is still running is queued the same way (two runs racing on one conversation garble its history). */
  /* Each queued message keeps the conversation it was typed in (the app keys its queue by workstream): after /new or
     /resume it still goes to that conversation once ITS turn ends, never into the one shown now. */
  const queued = new Map();   // agentId -> [{ text, sid }]
  // the conversation shown is busy: a run on its stream, or a send from here still opening
  const busy = id => busyOn(id, streamOf(id));
  function queueText(id, text) { const q = queued.get(id) || []; q.push({ text: String(text), sid: streamOf(id) }); queued.set(id, q); }
  function queueCommand(args) {
    const id = ui.focus, text = String(args || '').trim();
    const name = (model.state.agents.get(id) || {}).name || 'this agent';
    if (text) {
      if (!busy(id)) return send(id, text);
      queueText(id, text);
      return sayHere('/queue', ['Queued for ' + name + ' — it goes the moment the running turn ends (' + queued.get(id).length + ' waiting).']);
    }
    const q = queued.get(id) || [];
    const cur = streamOf(id);
    sayHere('/queue', q.length ? ['Queue: ' + q.length + ' waiting for ' + name + ':'].concat(q.map((t, i) => (i + 1) + '. ' + t.text.slice(0, 160) + (t.sid === cur ? '' : ' (for an earlier conversation — it goes there)'))) : ['Nothing queued for ' + name + '. /queue <text> stages a message for when its turn ends.']);
  }
  /* Each conversation's messages go in the order typed, and each waits only for ITS conversation's turn (the app keys its
     queue per workstream): a message for the conversation shown never waits behind one for an earlier conversation whose
     turn still runs (review 10-24). One sent to an earlier conversation is shown as such: the pane shows this agent's
     work whichever conversation it is in, and a line of yours is never passed off as part of the one shown. */
  function flushQueued() {
    if (model.front()) return;   // an ask waiting on you: nothing goes until it is answered
    for (const [id, q] of queued) {
      const seen = new Set();
      for (let i = 0; i < q.length; i++) {
        const t = q[i];
        if (seen.has(t.sid)) continue;   // a later message of a conversation already looked at: after the one before it
        seen.add(t.sid);
        if (busyOn(id, t.sid)) continue;   // its conversation's turn still running: not yet
        q.splice(i--, 1);
        const here = t.sid === streamOf(id);
        send(id, t.text, here ? null : '(to an earlier conversation) ' + t.text, t.sid, { retry: here });
      }
      if (!q.length) queued.delete(id);
    }
  }
  // /background <prompt>: the agent works on it in a new conversation of its own; this one stays where it is
  function backgroundCommand(args) {
    const text = String(args || '').trim();
    const a = model.state.agents.get(ui.focus);
    if (!text) return sayHere('/background', ['Usage: /background <prompt> — it runs in a new conversation of its own while this one stays here.'], false);
    if (!a) return sayHere('/background', ['No agent shown.'], false);
    const sid = core.cliStreamId(a.id) + '-' + Date.now().toString(36);
    send(a.id, text, '/background ' + text, sid);
    sayHere('/background', ['Running in a new conversation of its own — /resume opens it. It stops if you quit starnet.']);
  }
  /* /loop <interval> <prompt> | status | off: the same prompt on a clock, in this conversation (the app's rules: a minute at
     the least — every tick is a real model turn — 20 runs at most, gone when starnet quits; /routine is the lasting form) */
  /* A loop belongs to the conversation it was set in (its stream, as the app keys its loops by workstream): it fires only
     while that conversation is the one shown, and into it. Off it (/new, /resume, another agent shown) a tick is skipped,
     and 20 such ticks in a row end the loop — the app's own rule. */
  const LOOP_MIN_MS = 60 * 1000, LOOP_MAX_ITERS = 20, LOOP_MAX_SKIPS = 20;
  const loops = new Map();   // agentId -> { ms, label, prompt, sid, fired, skipped, skipStreak, timer }
  function loopLabel(ms) { return ms % 3600000 === 0 ? (ms / 3600000) + 'h' : ms % 60000 === 0 ? (ms / 60000) + 'm' : Math.round(ms / 1000) + 's'; }
  function loopStop(id, why) {
    const rec = loops.get(id);
    if (!rec) return false;
    clearTimeout(rec.timer);
    loops.delete(id);
    // said in the loop's own agent's pane, whichever agent is shown
    model.noteSaid(id, '/loop', '', ['Loop stopped — ' + why + ' (ran ' + rec.fired + ' time' + (rec.fired === 1 ? '' : 's') + ').'], true, now());
    if (ui.focus === id) ui.scroll = 0;
    paint();
    return true;
  }
  function loopArm(id, rec) { clearTimeout(rec.timer); rec.timer = setTimeout(() => loopTick(id, rec), rec.ms); }   // stop() clears it
  function loopTick(id, rec) {
    if (stopped || loops.get(id) !== rec) return;
    const shown = ui.focus === id && streamOf(id) === rec.sid;
    if (rec.fired >= LOOP_MAX_ITERS) return void loopStop(id, 'it hit its ' + LOOP_MAX_ITERS + '-run budget');
    if (!shown || busyOn(id, rec.sid) || model.front()) {   // its conversation not shown, or a run or an ask has the floor: next tick
      rec.skipped++;
      if (!shown && ++rec.skipStreak >= LOOP_MAX_SKIPS) return void loopStop(id, 'it went ' + LOOP_MAX_SKIPS + ' ticks without its conversation being shown');
      return void loopArm(id, rec);
    }
    rec.fired++; rec.skipStreak = 0;
    loopArm(id, rec);
    send(id, rec.prompt, '/loop · ' + rec.prompt, rec.sid);
  }
  function loopCommand(args) {
    const id = ui.focus, raw = String(args || '').trim(), low = raw.toLowerCase();
    if (!model.state.agents.has(id)) return sayHere('/loop', ['No agent shown.'], false);
    const cur = loops.get(id);
    if (low === 'off' || low === 'stop' || low === 'clear') { if (!loopStop(id, 'you stopped it')) sayHere('/loop', ['No loop is running in this conversation.']); return; }
    if (!raw || low === 'status') {
      if (!cur) return sayHere('/loop', ['No loop in this conversation. /loop <interval> <prompt> — e.g. /loop 5m check whether the build went green.']);
      return sayHere('/loop', ['Loop: every ' + cur.label + ', ' + cur.fired + '/' + LOOP_MAX_ITERS + ' runs done' + (cur.skipped ? ', ' + cur.skipped + ' tick' + (cur.skipped === 1 ? '' : 's') + ' skipped (a run or an ask had the floor)' : '') + ' — "' + cur.prompt.slice(0, 60) + '".' + (cur.sid === streamOf(id) ? '' : ' It belongs to an earlier conversation and fires only while that one is shown (/resume opens it).') + ' It stops if you quit starnet; /routine makes it permanent.']);
    }
    const sp = raw.search(/\s/);
    const m = sp > 0 ? /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/.exec(raw.slice(0, sp).toLowerCase()) : null;
    const ms = m && Number(m[1]) > 0 ? Number(m[1]) * ((m[2] || 'm')[0] === 's' ? 1000 : (m[2] || 'm')[0] === 'h' ? 3600000 : 60000) : null;
    const prompt = sp > 0 ? raw.slice(sp + 1).trim() : '';
    if (ms == null || !prompt) return sayHere('/loop', ['Usage: /loop <interval> <prompt> — e.g. /loop 5m check whether the deploy went green. Also: /loop status, /loop off.'], false);
    if (ms < LOOP_MIN_MS) return sayHere('/loop', ['Minimum loop interval is 1 minute — every run costs a real model turn.'], false);
    // one loop per agent: a new one replaces the one running — said, never a loop ended silently (review 10-24: one set in
    // an earlier conversation went with no line)
    if (cur) loopStop(id, 'the new /loop replaces it' + (cur.sid === streamOf(id) ? '' : ' (it was set in an earlier conversation: "' + cur.prompt.slice(0, 60) + '")'));
    const rec = { ms, label: loopLabel(ms), prompt, sid: streamOf(id), fired: 0, skipped: 0, skipStreak: 0, timer: null };
    loops.set(id, rec);
    loopArm(id, rec);
    sayHere('/loop', ['Looping every ' + rec.label + ' (up to ' + LOOP_MAX_ITERS + ' runs): "' + prompt.slice(0, 60) + '". First run in ' + rec.label + '. Each run costs a real model turn — /loop off stops it, and so does quitting starnet.']);
  }

  /* /goal, /subgoal: the app's SESSION GOAL LOOP (frontend/app/goalloop.js, its own state machine), driven from here. A goal
     belongs to the conversation it was set in. Each step is sent there; when that step's run ends, a judge — an internal
     call on the agent's own model and effort, as the app makes it — reads its reply and the state machine says continue,
     done or paused. It waits while an ask is open, a message you type yourself pauses it, and its budget (20 turns) stops
     it. It lives as long as this terminal (the app keeps its goals with its own sessions). */
  let GoalLoop = null, stationIO = null;
  const goals = new Map();       // streamId -> { agentId, s, expectCont, contRun, judging, waitSaid, retry }
  const runStream = new Map();   // runId -> the conversation it ran on (from its run.start)
  function goalLib() { try { GoalLoop = GoalLoop || appModule('goalloop.js'); } catch (_) { GoalLoop = null; } return GoalLoop; }
  const sayGoal = (id, line, ok) => { model.noteSaid(id, '/goal', '', [line], ok !== false, now()); ui.scroll = 0; paint(); };
  function busyOn(id, sid) {
    const a = model.state.agents.get(id);
    return !!(a && [...a.runs].some(r => { const run = model.state.runs.get(r); return run && run.streamId === sid; })) || [...mine.values()].some(m => m.kind === 'run' && m.agentId === id && m.streamId === sid);
  }
  function kickGoal(sid) {
    const g = goals.get(sid);
    if (!g || stopped || !GoalLoop || !GoalLoop.isActive(g.s) || g.judging) return;
    // a goal steps only the conversation it was set in while that is the one its agent shows (the app steps a goal only on
    // the displayed stream): after /new or /resume no paid step goes where /goal cannot see or pause it — it waits, and
    // going back to that conversation (/resume) picks it up (review 10-24)
    if (streamOf(g.agentId) !== sid) return;
    // one retry timer per goal at a time (stop() clears it): never a timer kept per retry for the life of the terminal
    const retry = ms => { if (!g.retry) g.retry = setTimeout(() => { g.retry = null; kickGoal(sid); }, ms); };
    if (busyOn(g.agentId, sid) || g.expectCont || g.contRun) return retry(1500);   // a step still running: the next waits for it
    const q = model.front();
    if (q && q.agentId === g.agentId) {
      const wait = 'your answer to ' + ((model.state.agents.get(g.agentId) || {}).name || 'its') + '\'s ask';
      if (!g.waitSaid.has(wait)) { g.waitSaid.add(wait); sayGoal(g.agentId, '⏸ session goal waiting for ' + wait + ' — the next step starts once that is settled.'); }
      return retry(7000);
    }
    const prompt = GoalLoop.continuationPrompt(g.s);
    if (!prompt) return;
    g.expectCont = true;
    send(g.agentId, prompt, '/goal · step ' + (g.s.turnsUsed + 1) + ' of ' + g.s.maxTurns, sid, { onFail: why => goalStepRefused(sid, g, why) });
  }
  // the station never started a step (no model, a refusal such as a spend cap, the connection lost): the goal pauses and
  // says why — the app's goalStall — never "active" with nothing coming
  function goalStepRefused(sid, g, why) {
    if (goals.get(sid) !== g) return;
    g.expectCont = false;
    if (!GoalLoop || !GoalLoop.isActive(g.s)) return;
    GoalLoop.pause(g.s, 'the last step was refused: ' + why);
    sayGoal(g.agentId, '⏸ session goal paused: the last step was refused (' + why + ') — /goal resume to try again.', false);
  }
  async function judgeGoalTurn(sid, reply) {
    const g = goals.get(sid);
    if (!g || !GoalLoop.isActive(g.s)) return;
    if (!String(reply || '').trim()) {
      GoalLoop.pause(g.s, 'the last step ended without a reply');
      return sayGoal(g.agentId, '⏸ session goal paused: the last step ended without a reply — /goal resume to continue.', false);
    }
    g.judging = true;
    let raw = '';
    try {
      const a = model.state.agents.get(g.agentId) || {};
      stationIO = stationIO || require('./station-io.js').makeStationIO(client);
      const res = await stationIO.chat({ agentId: g.agentId, model: a.model, provider: a.provider, effort: a.reasoningEffort, keepEffort: true, system: GoalLoop.judgeSystem(), directive: GoalLoop.judgeUser(g.s, reply, { now: new Date().toISOString() }), ms: 120000 });
      raw = res && !res.error ? String(res.text || '') : '';
    } finally { g.judging = false; }
    // re-read: a /goal pause or clear, or a message of yours, may have landed while the judge thought
    const g2 = goals.get(sid);
    if (!g2 || !GoalLoop.isActive(g2.s)) return;
    const d = GoalLoop.evaluate(g2.s, GoalLoop.parseVerdict(raw), { now: now() });
    const away = d.shouldContinue && streamOf(g2.agentId) !== sid;   // judged while another conversation is shown
    if (d.message) sayGoal(g2.agentId, d.message + (away ? ' (an earlier conversation\'s goal: its next step waits until that conversation is shown again — /resume opens it)' : ''), d.verdict !== 'paused');
    if (d.shouldContinue) kickGoal(sid);
  }
  // every run event, after the model has it: which conversation a run is on, and the end of a goal's step
  function afterEvent(name, p) {
    if (name === 'agent.run.start' && p.runId) {
      const sid = String(p.streamId || '');
      runStream.set(String(p.runId), sid);
      if (runStream.size > 500) runStream.delete(runStream.keys().next().value);
      const g = goals.get(sid);
      if (g && g.expectCont) { g.expectCont = false; g.contRun = String(p.runId); }
      return;
    }
    if (name === 'agent.run.end' && p.runId && GoalLoop) {
      const sid = runStream.get(String(p.runId));
      const g = sid != null ? goals.get(sid) : null;
      if (!g) return;
      // the step's run is over whatever the goal's state (a pause during the step must not leave it marked running)
      const wasStep = String(p.runId) === g.contRun;
      if (wasStep) g.contRun = '';
      if (!GoalLoop.isActive(g.s)) return;
      if (wasStep) {
        // only a step that ended cleanly is judged (the app's rule): a stopped, failed, budget-cut or step-limited one
        // pauses and says why — never judged on its partial text, never followed by another paid step
        const reason = String(p.reason || '');
        if (reason && reason !== 'done') {
          GoalLoop.pause(g.s, 'the step stopped (' + reason + ')');
          return sayGoal(g.agentId, '⏸ session goal paused: the step stopped (' + reason + ') — /goal resume to continue.', false);
        }
        const reply = model.logOf(g.agentId).filter(e => e.k === 'agent' && e.runId === String(p.runId)).map(e => e.text).join('\n');
        setTimeout(() => { judgeGoalTurn(sid, reply).catch(() => {}); }, 0);
      } else if (!g.expectCont && !g.judging) setTimeout(() => kickGoal(sid), 0);   // the turn that was running when the goal was set: now the loop starts
    }
  }
  // a message you type to a conversation whose goal is working: you took over — the loop pauses (the app's own rule)
  function goalPreempt(id) {
    const g = GoalLoop && goals.get(streamOf(id));
    if (!g || !GoalLoop.isActive(g.s)) return;
    const d = GoalLoop.evaluate(g.s, null, { preempt: true });
    if (d.message) sayGoal(id, d.message);
  }
  function goalCommand(args) {
    if (!goalLib()) return sayHere('/goal', ['Session goals could not load (the app\'s goalloop.js is not beside this starnet).'], false);
    const id = ui.focus, a = model.state.agents.get(id);
    if (!a) return sayHere('/goal', ['No agent shown.'], false);
    const sid = streamOf(id), g = goals.get(sid), cur = g && g.s;
    const raw = String(args || '').trim(), low = raw.toLowerCase();
    // a goal set in an earlier conversation of this agent's is not this one's: it waits (no step goes) until that
    // conversation is shown again — said, so "no goal here" never hides one that is still set
    const waiting = [...goals.entries()].filter(([s, x]) => s !== sid && x.agentId === id && GoalLoop.isActive(x.s)).length;
    const elsewhere = waiting ? ' (' + (waiting === 1 ? 'A session goal set in an earlier conversation waits' : waiting + ' session goals set in earlier conversations wait') + ' — no step goes until that conversation is shown again; /resume opens it.)' : '';
    if (!raw || low === 'status') return sayHere('/goal', [GoalLoop.statusLine(cur) + (cur ? '' : elsewhere)]);
    if (low === 'pause') {
      if (!cur || cur.status === 'cleared') return sayHere('/goal', ['No session goal to pause in this conversation.' + elsewhere]);
      GoalLoop.pause(cur, 'you paused it');
      return sayHere('/goal', [busyOn(id, sid) ? '⏸ session goal paused — the step already running finishes, and no next step starts. /goal resume to continue.' : '⏸ session goal paused. /goal resume to continue.']);
    }
    if (low === 'resume') {
      if (!cur || cur.status !== 'paused') return sayHere('/goal', ['No paused session goal to resume.']);
      GoalLoop.resume(cur); g.waitSaid.clear();
      // nothing running on this conversation: no step is still owed an end (one that ended unseen, or never started)
      if (!busyOn(id, sid)) { g.expectCont = false; g.contRun = ''; }
      sayHere('/goal', ['▶ session goal resumed (' + cur.turnsUsed + '/' + cur.maxTurns + '). ' + (busyOn(id, sid) ? 'The next step starts when the turn running now ends…' : 'Kicking off the next step…')]);
      return kickGoal(sid);
    }
    if (low === 'clear') {
      if (!cur || cur.status === 'cleared') return sayHere('/goal', ['No session goal to clear.']);
      GoalLoop.clear(cur); if (g.retry) clearTimeout(g.retry); goals.delete(sid);
      return sayHere('/goal', ['Cleared the session goal.']);
    }
    const s = GoalLoop.create(raw, { now: now() });
    if (!s) return sayHere('/goal', ['Usage: /goal <what you want done> · /goal status · pause · resume · clear'], false);
    if (g && g.retry) clearTimeout(g.retry);
    goals.set(sid, { agentId: id, s, expectCont: false, contRun: '', judging: false, waitSaid: new Set(), retry: null });
    sayHere('/goal', ['⊙ goal set for this conversation: ' + s.goal + ' (budget ' + s.maxTurns + ' turns). After each step a judge decides whether it is done; it keeps going until it is, you type, or /goal pause. It works while this terminal is open and this conversation is shown (after /new it waits; /resume back to it goes on). Working toward it…']);
    kickGoal(sid);
  }
  function subgoalCommand(args) {
    if (!goalLib()) return sayHere('/subgoal', ['Session goals could not load (the app\'s goalloop.js is not beside this starnet).'], false);
    const g = goals.get(streamOf(ui.focus)), cur = g && g.s;
    const raw = String(args || '').trim(), low = raw.toLowerCase();
    if (!raw) { const subs = (cur && cur.subgoals) || []; return sayHere('/subgoal', [subs.length ? 'Subgoals: ' + subs.map((t, i) => (i + 1) + '. ' + t).join(' | ') : 'No subgoals set. Use /subgoal <text> once a session goal is set.']); }
    if (!cur || !GoalLoop.hasGoal(cur)) return sayHere('/subgoal', ['Set a goal first with /goal <text>, then add criteria with /subgoal.'], false);
    if (low === 'clear') { cur.subgoals = []; return sayHere('/subgoal', ['Cleared subgoals.']); }
    const rm = /^remove\s+(\d+)$/i.exec(raw);
    if (rm) {
      const i = Number(rm[1]) - 1;
      if (i >= 0 && i < cur.subgoals.length) return sayHere('/subgoal', ['Removed subgoal: ' + cur.subgoals.splice(i, 1)[0]]);
      return sayHere('/subgoal', ['No subgoal #' + rm[1] + '.'], false);
    }
    const added = GoalLoop.addSubgoal(cur, raw);
    sayHere('/subgoal', [added ? 'Added subgoal #' + cur.subgoals.length + '. The loop will now require: ' + added : 'Could not add that subgoal.'], !!added);
  }

  /* /yolo, /personality: the agent's approval mode and personality, on the station's own routes (POST /api/agent/approval,
     /api/agent/personality): through the StarNet app when it is open (its own controls save them), else that agent's roster
     entry alone — and then the app's own setting applies again the next time it opens, which the reply says. */
  /* with no app open: a change that GIVES power holds on the roster until the app opens with its own setting (said so); one
     that takes it away the station also writes into the app's save — the reply says only what the station says took it
     (the roster, the save, or the roster alone and why), never a promise about what the app does when it opens */
  const viaRoster = (r, name) => {
    const j = r && r.json;
    if (!(j && j.via === 'roster')) return '';
    if (j.save === 'patched' || j.save === 'agrees') return ' (No StarNet app is open: the station\'s roster and the app\'s save both hold this now.)';
    if (j.save === 'no-record') return ' (No StarNet app is open: the station\'s roster holds this; the app\'s save has no record of ' + name + '.)';
    if (j.save === 'not-saved') return ' (No StarNet app is open: the station\'s roster holds this, but the app\'s save did not take it (' + (j.saveError || 'refused') + '), so the app may give ' + name + ' its own saved setting back when it opens — /yolo off again then.)';
    return ' (No StarNet app is open, so the station\'s roster holds this; the app\'s own setting applies again when it opens.)';
  };
  const refused = r => (r.json && r.json.error) || r.error || (r.status === 404 ? 'this station is older than this command' : 'HTTP ' + r.status);
  /* the app was asked and did not confirm in time (the station's 6 s): it applies a change before it proves its save, so
     the change may already be in force or still land. Never "unchanged": the station's roster as it is NOW (read after the
     wait, in the reply) is what the terminal says, and takes. null when this was not that answer. */
  const unconfirmed = (r, a) => {
    const j = r && r.json;
    if (!(r && r.status === 409 && j && j.unanswered)) return null;
    if (j.gone) return { gone: true, line: 'The StarNet app did not confirm in time, and ' + a.name + ' is no longer on the station\'s roster.' };
    return { st: j.station || {}, lead: 'The StarNet app did not confirm in time — it may still be applying it.' };
  };
  async function yoloCommand(args) {
    const a = model.state.agents.get(ui.focus);
    if (!a) return sayHere('/yolo', ['No agent shown.'], false);
    const raw = String(args || '').trim().toLowerCase();
    const was = a.approvalMode === 'full' ? 'run without prompts' : 'ask first';
    const want = raw ? /^(1|true|yes|on|full|yolo)$/.test(raw) : a.approvalMode !== 'full';
    const mode = want ? 'full' : 'ask', now2 = want ? 'run without prompts' : 'ask first';
    if ((a.approvalMode === 'full' ? 'full' : 'ask') === mode) return sayHere('/yolo', ['Approval mode unchanged for ' + a.name + ': ' + now2 + '.']);
    const r = await client.request('POST', '/api/agent/approval', { agentId: a.id, mode }, { timeoutMs: 15000 });
    const u = unconfirmed(r, a);
    if (u) {
      if (u.gone) return sayHere('/yolo', [u.line], false);
      const held = u.st.approvalMode === 'full' ? 'full' : 'ask', words = m => m === 'full' ? 'run without prompts' : 'ask first';
      a.approvalMode = held;
      return sayHere('/yolo', [u.lead + ' The station\'s roster says ' + a.name + ' will ' + words(held) + ' right now'
        + (held !== mode ? '; if the app applies it, ' + a.name + ' will ' + words(mode) : '') + '.'], false);
    }
    if (!(r.ok && r.status === 200 && r.json && r.json.ok)) return sayHere('/yolo', ['Could not change approval mode (' + refused(r) + ') — ' + a.name + ' still will ' + was + '.'], false);
    a.approvalMode = mode;
    sayHere('/yolo', ['Approval mode: ' + was + ' → ' + now2 + ' for ' + a.name + '. ' + (want ? 'It will NOT pause for approval prompts — /yolo off restores them.' : 'It will pause before gated actions.') + viaRoster(r, a.name)]);
  }
  async function personalityCommand(args) {
    const a = model.state.agents.get(ui.focus);
    if (!a) return sayHere('/personality', ['No agent shown.'], false);
    let mods;
    try { mods = require('./app-modules.js').load(); } catch (e) { return sayHere('/personality', ['The app\'s personalities could not load beside this starnet (' + ((e && e.message) || e) + ').'], false); }
    const P = mods.Personas, key = String(args || '').trim().toLowerCase();
    if (key && P.exists && P.exists(key)) {
      const id = P.resolve ? P.resolve(key) : key;
      // the prompt the app would compose with it, from the agent's own record in the save (sent for a station with no app open)
      let system = '';
      try {
        const s = await get('/api/save?agent=agent', 30000);
        const doc = s.ok && s.status === 200 && s.json ? s.json.save : null;
        const byId = new Map();
        for (const x of (doc && Array.isArray(doc.agents) ? doc.agents : [])) if (x && x.id) byId.set(String(x.id), x);
        if (doc && doc.agent && doc.agent.id) byId.set(String(doc.agent.id), doc.agent);
        const rec = byId.get(a.id);
        if (rec) {
          const D = mods.Dossier;
          system = mods.composer.compose(Object.assign({}, rec, { personaId: id }), { crew: [...byId.values()].filter(x => x !== rec), dossierBlock: D.composeBlock(D.hydrate ? D.hydrate(doc.dossier) : doc.dossier) });
        }
      } catch (_) { system = ''; }   // with the app open its own composer does it; with none, the station says it needs the prompt
      const r = await client.request('POST', '/api/agent/personality', Object.assign({ agentId: a.id, personality: id }, system ? { system } : {}), { timeoutMs: 20000 });
      const u = unconfirmed(r, a);
      if (u) {
        if (u.gone) return sayHere('/personality', [u.line], false);
        a.personaId = u.st.personaId || null;
        const held = a.personaId && P.get ? P.get(a.personaId) : null;
        return sayHere('/personality', [u.lead + ' The station\'s roster has ' + a.name + '\'s personality as ' + ((held && held.name) || a.personaId || 'the default') + ' right now' + (a.personaId === id ? '.' : '; if the app applies it, it becomes ' + P.get(id).name + '.')], false);
      }
      if (!(r.ok && r.status === 200 && r.json && r.json.ok)) return sayHere('/personality', ['Could not set the personality (' + refused(r) + ').'], false);
      a.personaId = id;
      const swears = id === 'unhinged' && P.effective && (P.effective(id, null) || {}).profanity > 0;
      return sayHere('/personality', ['Personality set to ' + P.get(id).name + ' for ' + a.name + '.' + (swears ? ' Heads up: this one swears — for real.' : '') + viaRoster(r, a.name)]);
    }
    const list = P.list ? P.list() : [];
    const cur = a.personaId && P.get ? P.get(a.personaId) : null;
    sayHere('/personality', [(key ? 'Unknown personality "' + key + '". ' : '') + 'Personality: ' + ((cur && cur.name) || a.personaId || 'the default') + (list.length ? '. Options: ' + list.map(p => p.id).join(', ') + '.' : '.')], !key);
  }

  // what the terminal answers for what only the app (or the station by itself) does
  const APP_ONLY = {
    '/voice': 'Spoken replies play in the StarNet app — a terminal has no speaker or microphone path.',
    '/suggestions': 'Recurring-task suggestions are learned in the StarNet app\'s own storage — open the app to review them.',
    '/save': 'Nothing to save from here: the station records every run, transcript and setting as it happens.',
    // the station keeps a conversation's transcript as it happened (append-only, no copy route yet): these stay the app's
    '/branch': 'Forking a conversation is the StarNet app\'s for now — the station keeps a terminal conversation\'s transcript as it happened and has no copy of one yet. /new starts a fresh conversation; /resume goes back to an earlier one.',
    '/fork': 'Forking a conversation is the StarNet app\'s for now — the station keeps a terminal conversation\'s transcript as it happened and has no copy of one yet. /new starts a fresh conversation; /resume goes back to an earlier one.',
    '/undo': 'The station keeps this conversation\'s transcript as it happened, so no turn can be taken back from here yet. /new starts clean; /resume goes back to an earlier conversation.',
    '/title': 'A terminal conversation is named by its first message (/resume lists them by it); renaming one is the StarNet app\'s for now.'
  };

  function showStatus() {
    const a = model.state.agents.get(ui.focus);
    if (!a) return flash('no agent on this station yet');
    const row = model.rows(now()).find(r => r.id === a.id);
    ui.overlay = {
      title: 'STATUS · ' + a.name,
      items: [
        ['agent', a.name + ' (' + a.id + ')' + (row ? ' · ' + row.status.text : '')],
        ['model', (a.provider ? a.provider + ' · ' : '') + (a.model || 'not set')],
        ['conversation', streamOf(a.id)],
        ['folder', ui.project ? ui.project.root : 'its own workspace (no trusted project here)'],
        ['station', ui.stationLabel],
        ['spend', costText(model.header(now()).cost)]
      ],
      foot: 'any key closes this'
    };
    paint();
  }
  async function showVersion() {
    const cli = require('./version.js').cliVersion(require('node:path').join(__dirname, '..', '..'));
    const r = await get('/api/version');
    const v = (r.ok && r.status === 200 && r.json) || {};
    ui.overlay = { title: 'VERSION', items: [['starnet', cli], ['station', v.harness ? 'harness ' + v.harness + (v.app ? ' · app ' + v.app : '') : 'did not say (' + (r.error || 'HTTP ' + r.status) + ')'], ['node', (v.node ? v.node + ' (station) · ' : '') + process.version + ' (here)']], foot: 'any key closes this' };
    paint();
  }
  // /skills: the agent's skills and recipes as the station lists them for it (its saved floor), picked into the prompt
  async function openSkillsPicker(filter) {
    const a = model.state.agents.get(ui.focus);
    if (!a) return flash('no agent on this station yet');
    const p = {
      kind: 'skills', title: 'SKILLS · ' + a.name, note: 'run one: /<skill> <task>', filter: String(filter || ''), sel: 0, items: [], loading: true,
      foot: '↑ ↓ pick · enter puts it in the prompt · esc close · type to filter',
      onPick: it => { ui.input = '/' + it.name + ' '; paint(); }
    };
    ui.picker = p; ui.overlay = null; paint();
    const r = await get('/api/slash/catalog?agent=' + encodeURIComponent(a.id) + '&client=terminal', 15000);
    const cmds = (r.ok && r.status === 200 && r.json && Array.isArray(r.json.commands)) ? r.json.commands : null;
    if (!cmds) p.error = 'the station did not list its skills (' + (r.error || 'HTTP ' + r.status) + ')';
    else {
      // your own commands, then the agent's skills, then the recipes everyone has
      const rank = { user: 0, skill: 1, recipe: 2 };
      p.items = cmds.filter(c => c && rank[c.source] != null).sort((x, y) => rank[x.source] - rank[y.source]).map(c => ({
        name: c.name, search: (c.name + ' ' + c.desc + ' ' + c.source).toLowerCase(),
        cols: [[padTo('/' + c.name, 24), 'ph'], [c.source === 'recipe' ? 'recipe  ' : c.source === 'user' ? 'yours   ' : 'skill   ', 'dim'], [c.desc || '', 'fg']]
      }));
      if (!p.items.length) p.error = a.name + ' has no skills ready · add them in the desktop app';
    }
    p.loading = false;
    paint();
  }
  // ---- THE AWAKENING: a station with no agent is onboarded here, the desktop app's own ceremony (bin/lib/awaken.js) -----
  // ui.wake = { log: [{ who, text, born, cps, full, you }], ask, stage: { title, detail }, speaker, feedKey, note, typing, ff }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitOrSkip(ms) { const end = now() + ms; while (now() < end && ui.wake && !ui.wake.ff) await sleep(40); }
  const wakeIO = {
    stage: (title, detail) => { if (ui.wake) { ui.wake.stage = { title: String(title || ''), detail: String(detail || '') }; paint(); } },
    speaker: name => { if (ui.wake) ui.wake.speaker = String(name || 'STARNET'); },
    note: (text, style) => { if (ui.wake) { ui.wake.note = String(text || ''); ui.wake.noteStyle = style || 'dim'; paint(); } },
    feed: key => { if (ui.wake) { ui.wake.feedKey = key || null; paint(); } },
    roster: list => { model.setRoster({ agents: list }); ui.focus = 'agent'; if (ui.wake) ui.wake.crew = true; loadSkins().then(paint, () => {}); paint(); },
    // typed lines: each one appears at its pace (any key shows the rest of this beat at once)
    async say(segs, o) {
      const w = ui.wake; if (!w) return;
      const list = typeof segs === 'string' ? [{ text: segs, cps: 46, hold: 0 }] : (segs || []);
      const who = (o && o.who) || w.speaker;
      w.ff = false;
      for (let i = 0; i < list.length; i++) {
        if (!ui.wake) return;
        const s = list[i];
        // /connect is not the ceremony: its lines come quickly (a key is waited on, not a story told)
        const e = { who, text: String(s.text).replace(/^\s+/, ''), first: i === 0, born: now(), cps: w.connect ? Math.max(s.cps || 44, 300) : s.cps || 44, full: false };
        w.log.push(e); w.typing = true; ui.scroll = 0;
        await waitOrSkip(Math.min(9000, e.text.length / e.cps * 1000));
        e.full = true;
        if (s.hold && !w.connect) await waitOrSkip(Math.min(900, s.hold));
      }
      if (ui.wake) ui.wake.typing = false;
      paint();
    },
    ask(spec) { return new Promise(resolve => { if (!ui.wake) return resolve({ value: '', skip: true }); ui.wake.ask = Object.assign({}, spec, { resolve }); ui.input = ''; paint(); }); },
    cancelAsk(ans) { const a = ui.wake && ui.wake.ask; if (!a) return; ui.wake.ask = null; a.resolve(ans); paint(); }
  };
  function wakeAnswer(ans) {
    const w = ui.wake, a = w && w.ask;
    if (!a) return;
    w.ask = null;
    // a secret (a /connect key) is never written out, not even here: only that one was typed
    w.log.push({ who: 'YOU', text: ans.custom ? (a.secret ? '•••••••• (hidden)' : String(ans.value)) : String(ans.label || ''), full: true, you: true, skip: !!ans.skip });
    a.resolve(ans);
    paint();
  }
  // a key while the awakening runs; false = the ordinary prompt handles it (typing an answer, backspace, esc)
  function wakeKey(str, k) {
    const w = ui.wake;
    // /connect: esc leaves it, whatever it is waiting on (a sign-in in flight is cancelled on the station)
    if (w.connect && k.name === 'escape') {
      if (connecting) connecting.cancelled = true;
      ui.input = ''; w.ff = true;
      if (w.ask) wakeIO.cancelAsk({ value: 'back', skip: true });
      return true;
    }
    if (w.typing && !w.ask) { w.ff = true; return true; }
    if (!w.ask) return k.name === 'return' || k.name === 'enter' || k.name === 'tab';
    if (k.name === 'return' || k.name === 'enter') {
      const t = ui.input.trim();
      if (t) {
        if (w.ask.custom) { ui.input = ''; wakeAnswer({ value: t, custom: true }); }
        else flash('pick a number — 1 to ' + w.ask.options.length);
        return true;
      }
      if (w.ask.optional) { const sk = (w.ask.options || []).find(o => o.skip); wakeAnswer(sk ? Object.assign({}, sk) : { value: '', label: 'skip', skip: true }); }
      return true;
    }
    if (k.name === 'tab' || k.name === 'up' || k.name === 'down') return true;
    const ch = typeof str === 'string' ? str : '';
    // a key or a URL is text from its first character on (a key may start with a digit): its options are clicked, or esc
    if (!ui.input && !w.ask.secret && !w.ask.freeText && /^[1-9]$/.test(ch) && w.ask.options[Number(ch) - 1]) { wakeAnswer(Object.assign({}, w.ask.options[Number(ch) - 1])); return true; }
    if (!ui.input && !w.ask.custom && ch && !/^[\x00-\x1f]$/.test(ch) && k.name !== 'backspace' && k.name !== 'escape' && k.name !== 'pageup' && k.name !== 'pagedown') { flash('pick a number — 1 to ' + w.ask.options.length); return true; }
    return false;
  }
  async function checkOnboarding() {
    const r = await get('/api/save?agent=agent', 15000);
    if (!(r.ok && r.status === 200 && r.json)) return false;
    const save = r.json.save || null;
    // an agent a headless run set up (`starnet -p` on an empty station) was never met by a person: it gets the full awakening
    const boot = !!(save && save.agent && save.agent.bootstrappedBy === 'starnet-cli' && save.agent.onboarded !== true);
    const a = boot ? null : save && save.agent;
    if (a && !((a.onboarded === undefined) ? !a.purpose : !a.onboarded)) return false;   // the app's own needsAwakening
    ui.wake = { log: [], ask: null, stage: { title: 'THE AWAKENING', detail: '' }, speaker: 'STARNET', feedKey: null, note: '', typing: false, ff: false };
    paint();
    /* one setup at a time: the app runs this station (open, or in the background for a terminal) and its page holds the
       setup it started — a save written from here would leave that page stale. Quitting it never helps now: `starnet`
       starts it again. A prior install's station is the app's to recover. */
    if (station.mode === 'attached' && station.workspace) {
      await wakeIO.say([{ text: 'StarNet’s setup isn’t finished on this station. open StarNet — it’s already running — and finish creating your Overseer in its window, then come back here.', cps: 60 }], { who: 'STARNET' });
      return true;
    }
    if (!a && !boot && r.json.lineage && r.json.lineage.priorInstallEvidence) {
      await wakeIO.say([{ text: 'this computer has a station from an earlier StarNet install. open the StarNet app to recover it before setting up a new one.', cps: 60 }], { who: 'STARNET' });
      return true;
    }
    let aw;
    try {
      aw = require('./awaken.js').makeAwakening({ st: require('./station-io.js').makeStationIO(client), io: wakeIO, mods: require('./app-modules.js').load(), env });
    } catch (e) {
      await wakeIO.say([{ text: 'the setup could not load the StarNet app’s files (' + ((e && e.message) || e) + '). open the StarNet app to set up this station.', cps: 80 }], { who: 'STARNET' });
      return true;
    }
    aw.run({ save, resume: !!a, privateStation: station.mode === 'spawned' }).then(async res => {
      const last = ui.wake && [...ui.wake.log].reverse().find(e => e.who !== 'YOU' && e.who !== 'STARNET');
      ui.wake = null;
      await loadRoster().catch(() => {});
      ui.focus = 'agent';
      if (last) model.noteAgentLine('agent', last.text, now());
      if (res && res.firstMove) { ui.input = String(res.firstMove); slashReset(); }
      loadSkins().then(paint, () => {});
      flash(((res && res.agent && res.agent.name) || 'your agent') + ' is awake — and it knows why.', 'ok', 7000);
    }, e => {
      if (!ui.wake) return;
      ui.wake.ask = null; ui.wake.typing = false;
      ui.wake.log.push({ who: 'STARNET', text: 'setup stopped: ' + ((e && e.message) || e) + '. press ctrl+c, then run starnet again to pick up from here.', full: true, bad: true });
      paint();
    });
    return true;
  }
  function focusStep(d) {
    const ids = model.state.order;
    if (!ids.length) return;
    const i = Math.max(0, ids.indexOf(ui.focus));
    ui.focus = ids[(i + d + ids.length) % ids.length];
    ui.scroll = 0; ui.overlay = null;
  }
  function quit(force) {
    const live = [...mine.values()].filter(x => x.kind === 'run').length;
    const flows = [...mine.values()].filter(x => x.kind === 'flow').length;
    if (!force && (live || flows) && !(ui.quitArmed > now())) {
      ui.quitArmed = now() + 3000;
      ui.quitNote = (live ? 'stops ' + live + ' run(s) you started here' : '') + (live && flows ? ' and ' : '') + (flows ? 'stops waiting on ' + flows + ' workflow job(s)' : '');
      return paint();
    }
    stop(0);
  }
  const F_PAGES = { f1: 'stat', f2: 'crew', f3: 'comms', f4: 'work', f5: 'skills' };
  function onKey(str, key) {
    const k = key || {};
    if (mouseReader(str, k)) return;   // a mouse report, put back together from the keys Node split it into
    if (k.ctrl && k.name === 'c') return quit(false);
    if (k.ctrl && k.name === 'l') { redrawAll(); return; }
    ui.quitArmed = 0;
    if (F_PAGES[k.name] && !ui.pasting) return openPage(F_PAGES[k.name]);
    if (ui.picker) return pickerKey(str, k);
    // the agent menu: its letters act on it (with nothing typed), esc closes it, any other key closes it and goes on
    if (ui.agentMenu && !ui.pasting) {
      if (k.name === 'escape') return menuKey('escape');
      const ch = typeof str === 'string' ? str.toLowerCase() : '';
      const a = model.state.agents.get(ui.agentMenu);
      if (!ui.input && /^[omnh]$/.test(ch)) return menuKey(ch);
      if (!ui.input && ch === 's' && a && a.runs.size) return menuKey('s');
      ui.agentMenu = '';
    }
    if (k.name === 'escape' && ui.wake && ui.wake.connect) { wakeKey(str, k); return paint(); }
    if (k.name === 'escape') {
      if (tui.slashMenu(ui)) { ui.slashHidden = ui.input; slashReset(); return paint(); }   // esc hides the "/" menu first (what you typed stays)
      ui.input = ''; slashReset(); ui.overlay = null; ui.scroll = 0; ui.page = ''; return paint();
    }
    // a PASTE is text (bracketed paste, ESC[?2004h): its newlines stay in the message — nothing is sent or answered mid-paste
    if (k.name === 'paste-start') { ui.pasting = true; return; }
    if (k.name === 'paste-end') { ui.pasting = false; return paint(); }
    if (ui.pasting) {
      if (k.name === 'return' || k.name === 'enter') { if (ui.input.length < 20000) ui.input += '\n'; return schedulePaint(); }
      if (typeof str === 'string' && str) { const ch = str.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''); if (ch && ui.input.length < 20000) ui.input += ch; }
      return schedulePaint();
    }
    if (ui.wake && wakeKey(str, k)) return paint();
    // the "/" menu, while it shows: ↑ ↓ pick · tab completes · enter runs the one picked (a command that takes something is
    // completed first, so what it takes can be typed)
    // ↑ ↓ stay your history while you step through it (a recalled "/model" is a line to go past, not a menu to pick in)
    // until you type into the recalled line
    const sm = tui.slashMenu(ui);
    if (sm) {
      const n = sm.items.length;
      if ((k.name === 'up' || k.name === 'down') && (ui.histAt == null || ui.histEdited)) { ui.slashSel = (sm.sel + (k.name === 'up' ? n - 1 : 1)) % n; ui.slashPicked = true; ui.slashPickedOn = ui.input; return paint(); }
      if (k.name === 'tab') return completeSlash(sm.items[sm.sel].name);
      if (k.name === 'return' || k.name === 'enter') {
        const typed = ui.input.slice(1).toLowerCase();
        // a lone "/" runs nothing until a command is picked with ↑ ↓ (its top row is only the first of the list)
        const picked = ui.slashPicked && ui.slashPickedOn === ui.input;   // picked on THIS line
        if (!typed && !picked) { flash('pick a command with ↑ ↓ then enter, or type its name', 'dim', 4000); return paint(); }
        const c = sm.items[sm.sel];
        const exact = ui.slashCatalog.some(x => x.name.toLowerCase() === typed || (x.aliases || []).some(a => a.toLowerCase() === typed));
        // the command typed whole runs as typed, unless you picked another row; a part-word runs the row picked
        if ((picked || !exact) && typed !== c.name.toLowerCase() && !(c.aliases || []).some(a => a.toLowerCase() === typed)) {
          if (c.argsHint) return completeSlash(c.name);
          ui.input = '/' + c.name;
        }
        slashReset();
        const t = ui.input; ui.input = ''; submit(t); return paint();
      }
    }
    // tab / shift+tab: the agent shown in COMMS · ↑ ↓: your earlier messages (and back to what you were typing)
    if (k.name === 'tab') { focusStep(k.shift ? -1 : 1); return paint(); }
    if (k.name === 'up') { historyStep(-1); return paint(); }
    if (k.name === 'down') { historyStep(1); return paint(); }
    // pgup / pgdn scroll what is shown: a list laid over COMMS, the page, or the conversation
    if (k.name === 'pageup' || k.name === 'pagedown') {
      const d = k.name === 'pageup' ? 1 : -1;
      if (ui.overlay) ui.overlay.scroll = Math.max(0, (ui.overlay.scroll | 0) - 8 * d);
      else if (ui.page) ui.pageScroll = Math.max(0, (ui.pageScroll | 0) - 8 * d);
      else ui.scroll = Math.max(0, ui.scroll + 8 * d);
      return paint();
    }
    if (k.name === 'return' || k.name === 'enter') { const t = ui.input; ui.input = ''; submit(t); return paint(); }
    if (k.name === 'backspace') { ui.input = ui.input.slice(0, -1); slashReset(); if (ui.histAt != null) ui.histEdited = true; return paint(); }
    if (k.sequence && /^\x1b\[[?\d;]*[ct]$/.test(k.sequence)) return;   // a late reply to the startup probe
    if (typeof str !== 'string' || !str || k.ctrl || k.meta || str.charCodeAt(0) === 27) return;
    const ch = str.replace(/[\x00-\x1f\x7f]/g, '');
    if (!ch) return;
    ui.overlay = null;
    const q = model.front();
    if (!ui.input && /^[ynva]$/i.test(ch) && answerKey(ch.toLowerCase())) return;
    if (!ui.input && q && q.question && /^[1-6]$/.test(ch) && q.question.options[Number(ch) - 1]) { answerQuestion(q.question.options[Number(ch) - 1]); return; }
    if (ui.input.length < 4000) ui.input += ch;
    slashReset();
    if (ui.histAt != null) ui.histEdited = true;
    // a "/" for an agent whose commands are not read yet (its skills are its own): read them now
    if (ui.input === '/' && ui.slashFor !== ui.focus) loadCatalog().then(paint, () => {});
    paint();
  }

  // ---- the screen ---------------------------------------------------------------------------------------------
  let paintTimer = null;
  function schedulePaint() { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 33); }
  function paint() {
    if (stopped) return;
    const t = now();
    model.tick(t);
    // the last column stays empty: a glyph there leaves the cursor in a pending wrap, so an erase after it ate the
    // character, and on consoles without a deferred wrap the bottom-right cell scrolls the whole screen
    const size = { cols: Math.max(20, (out.columns || 80) - 1), rows: out.rows || 24 };
    const skip = ui.logoImage ? ui.logoImage.cols : 0, skipRows = ui.logoImage ? ui.logoImage.rows : 0;
    const screen = tui.render(model, ui, size, t);
    lastHits = screen.hits || []; lastAreas = screen.areas || {}; lastScreen = screen;   // what a click lands on
    const av = screen.avatar;   // where the camera feed goes, when the card is up
    // every rendered row is padded to the full width, so no erase-to-end is needed (or wanted). A row beside the logo
    // image starts to its right, a row beside the feed is written either side of it: an image's cells are never
    // written over (that would erase it)
    const rows = screen.map((segs, y) => {
      if (y < skipRows) return '\x1b[' + (y + 1) + ';' + (skip + 1) + 'H' + tui.toAnsi(tui.sliceSegs(segs, skip), level);
      if (av && y >= av.y && y < av.y + av.rows) {
        return '\x1b[' + (y + 1) + ';1H' + tui.toAnsi(tui.sliceSegs(segs, 0, av.x), level) + '\x1b[0m' +
          '\x1b[' + (y + 1) + ';' + (av.x + av.cols + 1) + 'H' + tui.toAnsi(tui.sliceSegs(segs, av.x + av.cols), level);
      }
      return '\x1b[' + (y + 1) + ';1H' + tui.toAnsi(segs, level);
    });
    let s = '';
    for (let y = 0; y < rows.length; y++) if (prevRows[y] !== rows[y]) s += rows[y] + '\x1b[0m';
    if (image && !imageShown) { s += '\x1b[1;1H' + image.sixel; imageShown = true; }
    // the camera feed: drawn again only when what it shows (or where) changes; until the agent's sprites are in, the
    // card stays empty while they load
    if (av) {
      const pic = feed.frame(av.id, av.key, t, ui.still, { cellW: term.cellW, cellH: term.cellH, cols: av.cols, rows: av.rows });
      if (!pic) loadFeedAssets(av.id);
      const key = pic ? pic.key + '@' + av.x + ',' + av.y : '';
      if (pic && key !== avatarShown) { s += '\x1b[0m\x1b[' + (av.y + 1) + ';' + (av.x + 1) + 'H' + pic.sixel; avatarShown = key; }
    } else avatarShown = '';
    if (rows.length < prevRows.length) s += '\x1b[' + (rows.length + 1) + ';1H\x1b[J';
    prevRows = rows;
    if (s) try { out.write(s); } catch (_) {}
  }
  // the mouse, wherever the terminal reports it (STARNET_MOUSE=0 keeps the terminal's own selection; shift+drag selects
  // text while it is on, in most terminals)
  const mouseOn = env.STARNET_MOUSE !== '0';
  function enterScreen() {
    out.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H' + (mouseOn ? mouse.ENABLE : ''));   // …and bracketed paste on, so a paste arrives marked
    readline.emitKeypressEvents(inp);
    if (inp.isTTY && typeof inp.setRawMode === 'function') inp.setRawMode(true);
    inp.on('keypress', onKey);
    inp.resume();
    out.on('resize', onResize);
  }
  function redrawAll() { prevRows = []; imageShown = false; avatarShown = ''; buildImage(); try { out.write('\x1b[2J'); } catch (_) {} paint(); }
  function onResize() { redrawAll(); }

  // ---- the real logo, as an image -----------------------------------------------------------------------------------
  let term = {}, image = null, imageShown = false, avatarShown = '';
  // ask the terminal (before the screen opens) whether it draws Sixel and how big a cell is. Replies arrive in order, so
  // DA1, which every terminal answers, goes last and closes the probe.
  function probeTerminal(ms) {
    return new Promise(resolve => {
      if (!inp.isTTY || !out.isTTY || ui.logo !== 'full') return resolve({});
      let buf = '', done = false, timer = null;
      const onData = d => { buf += String(d); if (/\x1b\[\?[\d;]*c/.test(buf)) finish(); };
      function finish() { if (done) return; done = true; clearTimeout(timer); inp.removeListener('data', onData); resolve(sixel.parseTermReplies(buf, out.columns || 80, out.rows || 24)); }
      try { if (typeof inp.setRawMode === 'function') inp.setRawMode(true); } catch (e) { return resolve({ error: e.message }); }
      timer = setTimeout(finish, ms);
      inp.on('data', onData);
      inp.resume();
      try { out.write('\x1b[16t\x1b[14t\x1b[c'); } catch (e) { finish(); }
    });
  }
  // the image fits three rows of this terminal's cells, the wordmark drawn at 80% within them, and leaves the crew bar at
  // least 44 columns beside it
  function buildImage() {
    image = null; ui.logoImage = null;
    // the camera feed at the foot of CREW is an image too: only where the terminal draws them
    ui.images = !!(term.sixel && term.cellW && term.cellH && ui.logo === 'full');
    if (!term.sixel || !term.cellW || !term.cellH || ui.logo !== 'full') return;
    const r = sixel.logoSixel({ cellW: term.cellW, cellH: term.cellH, rows: 3, scale: 0.8, maxCols: Math.max(0, (out.columns || 80) - 1 - 47) });
    if (r) { image = r; ui.logoImage = { cols: r.cols, rows: r.rows }; }
  }
  function leaveScreen() {
    try { inp.removeListener('keypress', onKey); } catch (_) {}
    try { out.removeListener('resize', onResize); } catch (_) {}
    try { if (inp.isTTY && typeof inp.setRawMode === 'function') inp.setRawMode(false); } catch (_) {}
    try { inp.pause(); } catch (_) {}
    try { out.write((mouseOn ? mouse.DISABLE : '') + '\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l'); } catch (_) {}
  }
  const onExit = () => { if (!stopped) leaveScreen(); };
  /* A SIGTERM (the desktop app's boot reaper on macOS, a `kill`, an update) or a SIGHUP kills node WITHOUT 'exit', so
     onExit never ran and the terminal stayed on the alternate screen with mouse reporting on. Give it back, then end
     with the signal's conventional code (128 + its number); starnet.js still stops a station it booted. */
  const SIGNALS = ['SIGTERM', 'SIGHUP'];
  const onSignal = sig => stop(128 + ((os.constants.signals && os.constants.signals[sig]) || 15));
  function stop(code) {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearInterval(t);
    for (const rec of loops.values()) clearTimeout(rec.timer);
    for (const g of goals.values()) if (g.retry) clearTimeout(g.retry);
    if (feedRetry) clearTimeout(feedRetry);
    if (paintTimer) clearTimeout(paintTimer);
    try { if (feedReq) feedReq.destroy(); } catch (_) {}
    for (const m of mine.values()) { try { if (m.req) m.req.destroy(); } catch (_) {} }
    leaveScreen();
    process.removeListener('exit', onExit);
    for (const s of SIGNALS) process.removeListener(s, onSignal);
    resolveExit(code || 0);
  }

  // ---- go ----------------------------------------------------------------------------------------------------
  (async () => {
    process.on('exit', onExit);
    for (const s of SIGNALS) process.on(s, onSignal);
    term = await probeTerminal(400);
    if (stopped) return;   // a signal during the probe: never take the screen back after giving it back
    buildImage();
    enterScreen();
    paint();
    const rt = await loadRoster();
    if (stopped) return;
    if (!(rt.ok && rt.status === 200)) {
      stop(core.EXIT.STATION);
      process.stderr.write('starnet: could not read the station roster (' + (rt.error || 'HTTP ' + rt.status) + ')\n');
      return;
    }
    await Promise.all([loadSnapshot(), loadBudget(), loadLines().catch(() => {}), locateFolder().catch(() => {})]);
    if (stopped) return;
    await loadHistory().catch(() => {});
    if (stopped) return;   // …and no feed or refresh timers armed after a stop
    loadSkins().then(paint, () => {});
    loadStats().then(paint, () => {});
    ui.focus = pickFocus() || ui.focus;
    loadCatalog().then(paint, () => {});   // the "/" menu's commands
    connectFeed();
    paint();
    const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).then(paint, () => {}); }, ms); timers.push(t); };
    every(3000, loadSnapshot);
    every(10000, loadBudget);
    every(6000, () => loadLines().catch(() => {}));
    every(20000, () => loadRoster().then(() => { if (ui.images && model.state.order.some(id => !feed.hasSkin(id))) return loadSkins(); }));
    every(60000, loadStats);   // the level the stat bar shows
    every(15000, () => (ui.page ? loadPage() : null));   // an open page keeps what it read off the station current
    timers.push(setInterval(paint, 100));   // the working spinner turns at 10 frames a second (paint writes only rows that changed)
    timers.push(setInterval(flushQueued, 500));   // a queued message goes the moment its conversation is free
    checkOnboarding().catch(() => {});   // a station with no agent yet: the awakening, here
  })().catch(e => { stop(0); process.stderr.write('starnet: ' + ((e && e.message) || e) + '\n'); });
  return exited;
}

module.exports = { runDashboard };
