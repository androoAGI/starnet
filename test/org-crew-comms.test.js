/* test/org-crew-comms.test.js — ORG PASS 10-14 (crew + COMMS lines). Source locks for the copy and wiring each line
   changed, so a later edit can't quietly undo what the user now reads:
     P23 — PURPOSE and the house-rules card say they are THIS agent's only; standing orders say every agent follows them.
     P20 — STRUCK 10-14 (the always-shown DOSSIER key is gone again); kept: the manual stops claiming a row click focuses.
     P21 — the AGENT DOSSIER says where each per-agent setting lives, and station-wide switches say they are for every agent.
     P22 — RECRUIT speaks one language: RECRUIT a new agent from a CLASS, RE-SPEC an existing one.
     P26 — the COMMS title names the open session ('COMMS · <session>'), with one writer.
     P25 — fewer empty sessions: a background hire mints none, a starter fills a blank open session, the busy row names who.
     P33 — starter-room machines show what they are: a capability prop raises a GLANCE nameplate on hover (no pointer until a click exists). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SUI = read('frontend/app/stationui.js');

/* ---------- P23: say where each instruction applies ---------- */
A.ok(/desc: n => 'What ' \+ n \+ ' is for\. It rides only ' \+ n \+ '’s prompt[^']*' \+ n \+ ' does\. In a workflow, a step’s DOES adds to it for that step only\.'/.test(SUI), 'P23: PURPOSE names the one agent it shapes and that a DOES adds to it for its step (D14: one plain sentence each, no ·)');
A.ok(/desc: n => 'House rules only ' \+ n \+ ' follows: tone, format, the do-nots\. Rules for every agent live in YOU › PREFERENCES\.'/.test(SUI), 'P23: the house-rules card says only this agent follows it and where every-agent rules live');
A.ok(SUI.includes("typeof f.desc === 'function' ? f.desc(esc((a && a.name) || 'this agent'))"), 'P23: fileCard renders the reach with the agent name escaped');
A.ok(SUI.includes('your standing orders (every agent follows these)'), 'P23: YOU › PREFERENCES says every agent follows the standing orders');
A.ok(read('frontend/app/app.js').includes('DossierStore.composeBlock()') && read('sidecar/index.js').includes('withDossier(CRON_PERSONA'), 'P23: the "every agent" claim stays true — the dossier rides every browser prompt and cron runs');

/* ---------- P20 STRUCK (Andrew 10-14: "hell no … insanely ugly"): the crew row's DOSSIER key is the candidate's again —
   rendered only with 2+ agents and shown only while the row is pointed at (test/agent-threads-rail, test/crew-card-fit).
   What stays is the manual's truth: a crew-row click never focuses an agent, and it says what the click does at each size. */
const ICSS = read('frontend/css/interface.css');
A.ok(!/\.crew-dossier/.test(ICSS), 'the hover DOSSIER key is gone too (Andrew 10-26: "unaligned, looks terrible"): right-click / Shift+F10 on the row open the dossier');
const MAN = require('../sidecar/manual.js').starnetManual();
A.ok(!/focuses it/.test(MAN) && !/click the row to focus/.test(MAN) && !/intended agent is focused/.test(MAN), 'the manual never says a crew-row click focuses an agent');
A.ok(/None of these changes who COMMS talks to/.test(MAN) && /agent ON THE LINE/.test(MAN), 'the manual says messages go to the agent ON THE LINE and a row click does not change that');
A.ok(/With one agent a crew-manifest row click opens its dossier; with 2\+ it shows that agent's sessions\. A right-click on the row or its sprite opens the dossier/.test(MAN) && !/DOSSIER key/.test(MAN),
  'the manual names the row click at each crew size and never promises a DOSSIER key');

/* ---------- P21: the dossier says where each per-agent setting lives ---------- */
const CONN = read('frontend/app/windows/connectors.js');
A.ok(!SUI.includes('title="change this in CONFIG"') && /data-goconfig="' \+ r\.go \+ '" data-tip="' \+ esc\(r\.tip\) \+ '"/.test(SUI), 'P21: each BRIEF setup row carries its own data-tip (no native title)');
A.ok(SUI.includes("tip: 'opens AUTOMATE › AWAY WORK'"), 'P21: AWAY WORK says it opens AUTOMATE › AWAY WORK');
A.ok(/lbl: 'VOICE',[^\n]*go: 'ag-voice'/.test(SUI) && /lbl: 'SKILLS',[^\n]*go: 'ag-skills'/.test(SUI), 'P21: the BRIEF strip has VOICE and SKILLS rows');
A.ok(/if \(anchor === 'ag-voice'\) \{ sfx\('click'\); openVoiceFor\(a\.id\); return; \}/.test(SUI) && /openTerm\('settings', 'appearance'\);/.test(SUI) && /pick\.value = agentId; if \(typeof pick\.onchange === 'function'\) pick\.onchange\(\);/.test(SUI),
  'P21: VOICE opens LOOK & SOUND with VOICE FOR preselected on this agent (and refreshes its voice list)');
A.ok(/if \(anchor === 'ag-skills'\) \{ sfx\('click'\); skillsPick = a\.id; openTerm\('connectors', 'agent'\); return; \}/.test(SUI), 'P21: SKILLS opens ABILITIES › AGENT SKILLS for this agent');
A.ok(SUI.includes('AWAY WORK ▸</button>') && !SUI.includes('WHILE I’M AWAY → AUTOMATE'), 'P21: CONFIG\'s away door reads AWAY WORK ▸');
A.ok(SUI.includes('REFLECTION <b id="mc-reflect-state">…</b> (all agents)') && SUI.includes("st.textContent = o.checked ? 'ON' : 'OFF'") && !SUI.includes('> REFLECTION ON <'), 'P21: the MEMORY reflection switch says it is station-wide and reads ON / OFF in words');
A.ok(/function workshopCard\(a\)/.test(SUI) && /H\.workshopCard\(/.test(read('frontend/app/windows/automation.js')), 'P21: workshopCard stays — AUTOMATE › AWAY WORK renders with it');
A.ok(/'Reusable procedures ' \+ n \+ ' created or learned\./.test(SUI) && SUI.includes('id="sk-agent-pick" class="ab-agent-pick"'), 'P21: AGENT SKILLS names the agent shown and has an agent picker');
A.ok(/const shownId = skillsAgentId\(\);\n\s+if \(\(p\.agentId \|\| 'agent'\) !== shownId\) return;/.test(SUI), 'P21: the live skills refresh follows the agent the lane shows (one-shot pick behaviour in test/abilities.skills-lane.test.js)');
A.ok(SUI.includes("return (AP && AP.approval === 'ask') ? AP.label : 'custom'; };") && SUI.includes("authority.unrestricted ? 'FULL POWER' : askingPosture()") && SUI.includes("'FULL POWER — on for every agent by ' + overrideBy") && SUI.includes('data-tip-below>'), 'P21: the ACCESS summary speaks the posture words, gated on the live authority');
A.ok(CONN.includes('id="ts-agent" class="ab-agent-pick"') && /select\.ab-agent-pick \{[^}]*appearance: none/.test(read('frontend/css/interface.css')), 'P21: the ABILITIES agent pickers are glass fields with a drawn chevron, not key-input/OS paint');
A.ok(/each switch turns a tool on or off for every agent; CHECK WITH ME and LET IT WORK obey the switches, FULL POWER overrides them/i.test(CONN), 'P21: TOOLS (was BUILT-IN ABILITIES) says its switches are for every agent, in ONE ACCESS words');
A.ok(CONN.includes("data-tip=\"Turns ' + esc(t.label) + ' on or off for every agent\"") && CONN.includes("notify((tsLabels[id] || id) + (enabled ? ' on' : ' off') + ' for every agent'"),'P21: the switch tip and toast name the ability and say every agent');
A.ok(/toolsetDisabled/.test(read('sidecar/index.js')), 'P21: "for every agent" stays true — the toggle writes the station-wide toolsetDisabled map');

/* ---------- P22: RECRUIT speaks one language ---------- */
const MKT = read('frontend/app/marketplace.js');
A.ok(/'⏼ RECRUIT <span class="mkt-candidate-name">'/.test(MKT) && !/⏼ SUMMON/.test(MKT), 'P22: the bay\'s primary key reads RECRUIT <NAME>');
A.ok(/RE-SPEC ' \+ esc\(ctx\.agentName\)\.toUpperCase\(\) \+ ' INSTEAD ▸<\/button>/.test(MKT) && /'<div class="mkt-cta-sub">replaces ' \+ esc\(ctx\.agentName\) \+ '’s purpose — no new agent<\/div><\/div>'/.test(MKT),
  'P22: the secondary reads RE-SPEC <AGENT> INSTEAD ▸ with the "no new agent" sub-line');
A.ok(/armCta\(deployCurBtn, 'RE-SPEC ' \+/.test(MKT), 'P22: the re-spec keeps its armed RE-SPEC <AGENT>? confirm');
A.ok(!MKT.includes("'⏼ DEPLOY TO ") && !MKT.includes("'\">⏼ DEPLOY TO ") && !MKT.includes("' deployed to '") && /' re-specced as ' \+ s\.name/.test(MKT), 'P22: no DEPLOY verb or "deployed to" toast is left; toasts say re-specced');
A.ok(!MKT.includes("sectH('▮ YOUR SPECIALISTS')") && !MKT.includes('SPECIALIST ARCHIVE — deep cuts') && !MKT.includes("SPECIALIST ARCHIVE (' +") &&
  MKT.includes("sectH('▮ YOUR CLASSES')") && MKT.includes("sectH('▮ CLASS ARCHIVE — deep cuts')"), 'P22: the nouns are CLASS / YOUR CLASSES / CLASS ARCHIVE');
A.ok(/'recruit a new agent onto your crew — it gets its own session'/.test(MKT) && /'choose a class for your agent'/.test(MKT), 'P22: the subtitles say recruit / choose a class');
A.ok(!/Same as the orchestrator|Inherits your orchestrator/.test(MKT) && !/inheritLabel: 'Same as the station default'/.test(MKT) && /Copies the model of the agent on the line now/.test(MKT),
  'P22: the model copy says an unpinned recruit copies the on-the-line agent\'s model (it does not track the station default)');
A.ok(/model:\s*\(pin && pin\.model\)\s*\|\|\s*agent\.model/.test(read('frontend/app/app.js')), 'P22: …which stays true: summonAgent copies the focused agent\'s model');
// P22 fix (review): a SETTINGS › New agent defaults tier pin REPLACES the copy (applyLoadout → resolveTierModel), so the
// bay must name that pin, never promise a copy. Run the shipped helpers in a vm with and without a tier pin.
{
  const APPJS = read('frontend/app/app.js');
  A.ok(/function tierModelFor\(tier\)/.test(APPJS) && /const pinned = tierModelFor\(tier\);/.test(APPJS) && /\n\s+tierModelFor,/.test(APPJS),
    'P22 fix: resolveTierModel and the bay read the tier pin through ONE exported reader (App.tierModelFor)');
  const vmP = require('vm');
  const src = ['function modelHelpHTML(', 'function tierModelOf(', 'function summonModelSummary(', 'function shortModel('].map(h => A.fnBody(MKT, h)).join('\n');
  const helpFor = (tierMap, pin) => {
    const sb = { App: { tierModelFor: t => tierMap[t] || null }, pickedSummonModel: pin || null, esc: x => String(x),
      clearanceLabel: m => ({ reasoning: 'DEEP', balanced: 'BALANCED', fast: 'FAST' })[m] || String(m).toUpperCase() };
    vmP.createContext(sb); vmP.runInContext(src, sb);
    const s = { model: 'reasoning', reasoningEffort: 'high' };
    return { help: sb.modelHelpHTML(s), sum: sb.summonModelSummary(s) };
  };
  const none = helpFor({}), tierPinned = helpFor({ reasoning: 'anthropic/claude-opus' });
  const hand = helpFor({ reasoning: 'anthropic/claude-opus' }, { model: 'openai/gpt-x', effort: '' });
  A.ok(/^Copies the model of the agent on the line now/.test(none.help) && none.sum === 'Copies the agent on the line',
    'P22 fix: no tier pin → the helper and summary say the recruit copies the agent on the line');
  A.ok(/uses <b>claude opus<\/b>, your <b>deep<\/b> tier model from SETTINGS › New agent defaults/.test(tierPinned.help) && !/Copies/.test(tierPinned.help) && /tier model/.test(tierPinned.sum),
    'P22 fix: a tier pin → the helper names the pinned model and where it is set, never a copy');
  A.ok(/overrides the class default/.test(hand.help), 'P22 fix: a hand-picked model still beats the tier pin (applyLoadout skips the tier when pin.model is set)');
  A.ok(/inheritLabel: tierModelOf\(s\) \? 'Use your '/.test(MKT), 'P22 fix: the blank MODEL option names the tier model when one is pinned');
}
A.ok(!/AS A SPECIALTY|SAVE SPECIALTY|EDIT SPECIALTY|none of your specialists|as a specialty above|before summoning|its own <span data-hint="workstream">chat thread/.test(MKT) &&
  MKT.includes('＋ SAVE THIS AGENT AS A CLASS') && MKT.includes("'none of your classes match your search — '") && MKT.includes('before recruiting') &&
  MKT.includes('its own <span data-hint="workstream">session</span>'), 'P22 fix: the hints, save key, name helper and CTA sub-line speak RECRUIT / CLASS / session too');
A.ok(read('frontend/index.html').includes('<b>RECRUIT</b><small>pick a class, or re-spec your agent</small>') && /Recruitment Bay and RECRUIT one/.test(MAN), 'P22: the dock subtitle and the manual say RECRUIT');

/* ---------- P26: name the open session in the COMMS title (behaviour, run in a vm against the shipped functions) ---------- */
const CHAT = read('frontend/app/chat.js');
const from = CHAT.indexOf('  function sessionTitleText(ws) {'), to = CHAT.indexOf('  function load(ws) {', from);
A.ok(from > 0 && to > from, 'P26: chat.js has the one COMMS title writer');
const vm = require('vm');
function titleFor(ws, opts) {
  opts = opts || {};
  const kids = [];
  const title = {
    dataset: {}, attrs: {}, _text: 'COMMS',
    get textContent() { return this._text + kids.map(k => k.textContent).join(''); },
    set textContent(v) { this._text = String(v); kids.length = 0; },
    appendChild(k) { kids.push(k); }, querySelector(sel) { return sel === '.comms-session' ? kids[0] || null : null; },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }
  };
  const ctx = {
    el: id => id === 'comms-title' ? title : null,
    document: { body: { classList: { contains: c => c === 'hud-view-activity' && !!opts.hudActivity } }, createElement: () => ({ className: '', textContent: '' }) },
    activeWs: ws, Workstreams: { active: () => ws, titleOf: w => w.title || (w.id === 'general' ? 'General' : 'New session') },
    streamLabel: w => w.title || (w.id === 'general' ? 'General' : 'New session'),
    GroupChat: { membersOf: () => opts.members || null },
    App: { agentName: id => ({ agent: 'ULTRON', cy: 'CYPHER', a3: 'NOVA', a4: 'IRIS', a5: 'ECHO' })[id] || null, sessionDisplayName: opts.displayName },
    ProjectHome: { owns: () => !!opts.project }
  };
  vm.createContext(ctx);
  vm.runInContext(CHAT.slice(from, to) + '\nthis.paintTitle = paintTitle;', ctx);
  ctx.paintTitle();
  return { text: title.textContent, tip: title.attrs['data-tip'] };
}
A.eq(titleFor({ id: 'general' }).text, 'COMMS · General', 'P26: General reads COMMS · General');
A.eq(titleFor({ id: 's1', title: 'Fix the login bug' }).text, 'COMMS · Fix the login bug', 'P26: a titled session is named');
A.eq(titleFor({ id: 's2' }).text, 'COMMS · New session', 'P26: an untitled session reads New session (Workstreams.titleOf)');
A.eq(titleFor({ id: 'g1', agentId: 'agent', conversationMode: 'group' }, { members: ['agent', 'cy', 'a3', 'a4', 'a5'] }).text, 'COMMS · ULTRON, CYPHER +3',
  'P26: an untitled group follows the rail grammar (lead first, +N), never a GROUP chip');
A.eq(titleFor({ id: 'g3', title: 'Group chat', agentId: 'agent', conversationMode: 'group' }, { members: ['agent', 'cy'] }).text, 'COMMS · ULTRON, CYPHER', 'D16: the server placeholder title "Group chat" reads as untitled: the members name it');
A.eq(titleFor({ id: 'g2', title: 'Launch plan', agentId: 'agent', conversationMode: 'group' }, { members: ['agent', 'cy'] }).text, 'COMMS · Launch plan', 'P26: a titled group keeps its title');
A.eq(titleFor({ id: 's1', title: 'Fix it' }, { project: true }).text, 'COMMS', 'P26: a shown project home owns the title (the writer steps aside)');
A.eq(titleFor({ id: 's1', title: 'Fix it' }, { hudActivity: true }).text, 'COMMS', 'P26: the HUD ▮ ACTIVITY view owns the title');
A.eq(titleFor({ id: 's1', title: 'Fix it' }).tip, 'This conversation: Fix it', 'P26: the full name rides a data-tip when the panel clamps it');
// org wiring (D12 x P26 x P25): the COMMS title and the busy row print the name the RAIL printed, so two untitled sessions
// are told apart in the header exactly as in the rail ("New session · NOVA"), never a bare "New session" over both
A.eq(titleFor({ id: 's2' }, { displayName: w => (w.id === 's2' ? 'New session · NOVA' : '') }).text, 'COMMS · New session · NOVA',
  'D12 x P26: an untitled session the rail disambiguated reads the same in the COMMS title');
A.eq(titleFor({ id: 's3' }, { displayName: () => '' }).text, 'COMMS · New session', '…and with no rail name it falls back to Workstreams.titleOf');
{
  const APPSRC = read('frontend/app/app.js');
  const body = A.fnBody(APPSRC, 'function sessionDisplayName(');
  const names = new Map([['s1', { base: 'New session', shown: 'New session · NOVA' }], ['s2', { base: 'New session', shown: 'New session · NOVA 2' }]]);
  const W = { titleOf: w => w.title || 'New session' };
  const display = new Function('Workstreams', 'railShownNames', body + '\nreturn sessionDisplayName;')(W, names);
  A.eq([display({ id: 's1' }), display({ id: 's2' })], ['New session · NOVA', 'New session · NOVA 2'], 'D12 x P26: the shared name is the one the rail printed');
  A.eq(display({ id: 's1', title: 'Ship it' }), 'Ship it', 'a session titled since the last rail pass never shows the stale printed name');
  A.eq(display({ id: 's9' }), 'New session', 'a session the rail did not print (filtered out) reads its own title');
  const rail = A.fnBody(APPSRC, 'function renderRail(');
  const fill = rail.indexOf('railShownNames = new Map(rows.map((w, i) => [w.id, { base: baseTitles[i], shown: titles[i] }]));');
  A.ok(fill > 0 && rail.indexOf('Chat.paintTitle();   // ORG P26') > fill, 'renderRail records this pass\'s names BEFORE it repaints the COMMS title');
  A.ok(/refreshRail: renderRail, sessionDisplayName,/.test(APPSRC), 'App exports the shared name');
  A.ok(/' IS BUSY IN ' \+ shownName\(peer\)\.toUpperCase\(\)/.test(CHAT), 'P25 x D12: the busy row names the session as the rail does');
}
A.ok(/activeWs = nextWs;\n    paintTitle\(\);/.test(CHAT) && /return \{ init, load, paintTitle,/.test(CHAT), 'P26: Chat.load paints the title and Chat exports the writer');
A.ok(/if \(typeof Chat !== 'undefined' && Chat\.paintTitle\) Chat\.paintTitle\(\);   \/\/ ORG P26/.test(read('frontend/app/app.js')), 'P26: the rail repaint (rename / auto-title) repaints the title');
const PH = read('frontend/app/project-home.js'), HUD = read('frontend/app/hudmode.js');
A.ok(/owns: \(\) => !!root/.test(PH) && /if \(typeof Chat !== 'undefined' && Chat\.paintTitle\) Chat\.paintTitle\(\); else title\.textContent = 'COMMS';/.test(PH), 'P26: leaving a project home restores the session title');
A.ok(/S\.titleWas = null;[\s\S]{0,400}Chat\.paintTitle\(\)/.test(HUD) && /if \(S\.titleWas == null\) S\.titleWas = S\.els\.title\.textContent;/.test(HUD), 'P26: the HUD keeps its titleWas save/restore and repaints the open session after');
const APPCSS = read('frontend/css/app.css');
A.ok(/#chat-panel h3 #comms-title \{ flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/.test(APPCSS) && /#chat-panel h3 \.h3-right \{[^}]*flex: 0 0 auto;/.test(APPCSS),
  'P26: the title clamps to one line and a fault in #chat-status keeps its width first');
const HTML = read('frontend/index.html');
A.ok(!/class="comms-agent-wrap" title=/.test(HTML) && /class="comms-agent-wrap" data-tip-below data-tip="[^"]*opens its latest session/.test(HTML), 'P26: the ON THE LINE tip is a data-tip, never a native title');
// P26 fix (review): selectAgent never rebinds General (cur.id !== Workstreams.generalId()) — the tip must not promise it does
A.ok(/class="comms-agent-wrap" data-tip-below data-tip="[^"]*an empty session, not General, takes that agent\."/.test(HTML) &&
  /if \(cur && cur\.id !== Workstreams\.generalId\(\) && !isGroupWs\(cur\)/.test(read('frontend/app/app.js')),
  'P26 fix: the tip says General keeps its agent, matching selectAgent');

/* ---------- P25: fewer empty sessions ---------- */
const APP = read('frontend/app/app.js');
const summonBody = (APP.match(/function summonAgent\(spec, opts\) \{[\s\S]*?\n  \}\n/) || [''])[0];
A.ok(/const ws = \(activate && typeof Workstreams !== 'undefined'\) \? Workstreams\.create\(a\.name, \{ agentId: id, activate \}\) : null;/.test(summonBody),
  'P25: only an ACTIVATED summon (the bay\'s RECRUIT) opens a session; a background hire mints none');
A.ok(/summonAgent\(spec, \{ activate: false, desk: true \}\)/.test(APP) && /App\.summonAgent\(spec, \{ activate: false, desk: true \}\)/.test(read('frontend/app/build.js')),
  'P25: team.summon and the workflow RECRUIT are the background hires');
A.ok(/if \(!ws\) ws = Workstreams\.create\(a\.name, \{ agentId: id, activate: false \}\);/.test(APP), 'P25: ON THE LINE still mints a fresh session for an agent that has none (selectAgent)');
A.ok(/start\.onclick = \(\) => newWorkstream\(\)/.test(APP) && /'sessions with ' \+ name \+ ' yet\.'/.test(APP), 'P25: the narrowed rail offers START ONE for an agent with no session yet');
A.ok(!/switch to its stream to task it/.test(APP) && /pick it ON THE LINE in COMMS to talk to it/.test(APP) && APP.includes("' recruited — ' + deskLine") && !/' summoned — /.test(APP), 'P25: the background-hire toast no longer promises a stream that does not exist');
A.ok(/ws = blank \? cur : Workstreams\.create\(st\.label/.test(CHAT), 'P25: a starter on a blank open session fills it (behaviour in test/starters.test.js)');
A.ok(/String\(busyName\)\.toUpperCase\(\) \+ ' IS BUSY IN ' \+ shownName\(peer\)\.toUpperCase\(\)/.test(CHAT) && !/'ALSO RUNNING IN '/.test(CHAT), 'P25: the busy row reads <NAME> IS BUSY IN <SESSION> · VIEW ACTIVE RUN');
A.ok(/function\s+maybeEmptyState[\s\S]{0,300}busyPeerFor\(activeWs\)/.test(CHAT), 'P25: the busy row stays visible in an empty session (it explains why a first message queues)');

/* ---------- P33: starter-room machines show what they are (the shipped hit-test, run against the real catalogs) ---------- */
const WORLD = read('frontend/app/world.js');
const capFrom = WORLD.indexOf('  function capPropAt(wp) {'), capTo = WORLD.indexOf('  function drawCapHoverTag(now) {', capFrom);
A.ok(capFrom > 0 && capTo > capFrom, 'P33: world.js has the capability-prop hit-test');
const WM = require('../frontend/app/worldmodel.js');
const WorldModelApi = (WM && WM.grantLabelForProp) ? WM : global.WorldModel;
const LABELS = { war_intelcab: 'INTEL CAB', gigs_servercart: 'SERVER CART', comms_dish: 'DISH', workbench: 'WORKBENCH', studio: 'STUDIO', desk: 'DESK', plant: 'PLANT' };
const props = [
  { t: 'war_intelcab', x: 1, y: 0, w: 1, h: 2 }, { t: 'gigs_servercart', x: 1, y: 9, w: 1, h: 1 }, { t: 'comms_dish', x: 14, y: 0, w: 2, h: 2 },
  { t: 'workbench', x: 3, y: 1, w: 2, h: 1 }, { t: 'studio', x: 14, y: 8, w: 2, h: 2 }, { t: 'desk', x: 8, y: 1, w: 2, h: 1 }, { t: 'plant', x: 0, y: 0, w: 1, h: 1 }
];
const capCtx = vm.createContext({ geo: { props }, T: 32, station: { capForProp: t => WorldModelApi.CAP_PROP_MAP[t] || null },
  WorldModel: { grantLabelForProp: WorldModelApi.grantLabelForProp }, PropSprites: { spec: t => (LABELS[t] ? { label: LABELS[t] } : null) } });
vm.runInContext(WORLD.slice(capFrom, capTo) + '\nthis.capPropAt = capPropAt;', capCtx);
const at = (p) => capCtx.capPropAt({ x: (p.x + 0.5) * 32, y: (p.y + 0.5) * 32 });
A.eq((at(props[0]) || {}).text, 'INTEL CAB · FILES', 'P33: hovering the INTEL CAB glances INTEL CAB · FILES');
A.eq((at(props[1]) || {}).text, 'SERVER CART · MEMORY', 'P33: the SERVER CART glances its power');
A.eq((at(props[2]) || {}).text, 'DISH · WEB', 'P33: the DISH glances WEB');
A.eq((at(props[3]) || {}).text, 'WORKBENCH · TERMINAL', 'P33: the WORKBENCH glances TERMINAL');
A.eq((at(props[4]) || {}).text, 'STUDIO · IMAGES', 'P33: the STUDIO glances IMAGES');
A.eq(at(props[5]), null, 'P33: a desk keeps its own DESK SCREEN click/glance (no plate)');
A.eq(at(props[6]), null, 'P33: decor raises nothing');
// P33 fix (review): the click is not built (Andrew picks a or b), so the pointer would promise a dead click — the
// cursor stays default over a capability prop; the pointer returns in the same change that adds the click branch.
const cursorLine = (WORLD.match(/\n\s*cv\.style\.cursor = \(hit[^\n]*/) || [''])[0];
A.ok(/hoverCap = \(hit \|\| hoverOutbox \|\| hoverCrate \|\| hoverBay \|\| hoverPlate\) \? null : capPropAt\(wp\);/.test(WORLD) && cursorLine && !/hoverCap|capPropAt/.test(cursorLine),
  'P33: hover arms the plate below every existing glance, and the cursor does NOT turn to a pointer while the click does nothing');
A.ok(/drawCapHoverTag\(now\);/.test(WORLD) && !/capPropAt\(wp\)[^\n]*openTerm|hoverCap[^\n]*openTerm/.test(WORLD), 'P33: the plate is drawn as a glance — hover never opens a window');
const mouseup = (WORLD.match(/cv\.addEventListener\('mouseup', ev => \{[\s\S]*?\n    \}\);/) || [''])[0];
A.ok(mouseup && !/capPropAt|hoverCap/.test(mouseup), 'P33: no click is added (what a click does stays Andrew\'s pick)');

A.ok(APP.includes("t + ' · ' + railAgentName(w)") && APP.includes('const title = titles[i];'), 'D12: two untitled sessions in the rail read "New session · MIRA" (and a number for the same agent), never two identical rows');

A.report();
