/* node test/manual.on-demand.test.js — the operator manual on demand (progressive disclosure, 2026-09-23).

   The manual was ~9.3K of every interactive task prompt. It is now ordered sections, each classified as
   orientation/rule (ALWAYS inline — behaviour the agent must follow unprompted) or reference (product facts,
   named in an inline table of contents and served verbatim by the read-only manual.read tool). Project law:
   simplify = organization, never removal. This pins that
     A. the WHOLE manual is byte-identical to the pre-split literal (hash) — starnetManual() is still the fallback
        and manual.read "all";
     B. the sections partition it: every line of the manual lives in a section, and joined they are the manual;
     C. the inline form carries every orientation/rule section VERBATIM, a TOC line per reference section, the
        rule excerpt that lives inside a reference section (never OS crontab), and no reference body;
     D. manual.read returns each section verbatim, "all" = the whole manual, and an unknown id lists the sections;
     E. manual.read rides the always-present COMPUTER (capId stationinfo: read, no consent, no network), and
        index.js only uses the inline TOC form when manual.read is on the run's wire.
   Pure + deterministic. The live bytes are proven by test/prompt-on-demand.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('../sidecar/manual.js');
const { makeManualReadTool } = require('../sidecar/tools/builtin/manual-read.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

const full = M.starnetManual();
const index = M.starnetManualIndex();
const ids = M.MANUAL_SECTIONS.map(s => s.id);
const reference = M.MANUAL_SECTIONS.filter(s => s.kind === 'reference');
const inline = M.MANUAL_SECTIONS.filter(s => s.kind !== 'reference');

// ---- A. nothing removed: the whole manual is the pre-split manual, byte for byte ----
// Re-pinned 2026-09-28 (first-hour fixes) for ONE deliberate text change: the two "ABILITIES › KEYS" directions now
// name tabs that exist (INSTALLED › SAVED API CONNECTIONS; CREATE / ADVANCED › Add a custom API key). Swapping those
// two phrases back reproduces the pre-split pin exactly (9269 / 876bf2e4…), so nothing else moved.
// Re-pinned 2026-10-02 (overnight sweep) for ONE deliberate change: NAVIGATION / CONNECTING / TROUBLESHOOTING name the 0.13 dock
// (MY WORK · AUTOMATE · QUESTS, BUILD MODE · CONNECT · NEW APP, ABILITIES tabs INSTALLED / DISCOVER / CREATE / ADVANCED) — the
// agent was sending Commanders to 0.12.5 dock buttons that no longer exist.
// Re-pinned 2026-10-04 (self-driving) for ONE deliberate change: the APPROVALS hotspot and its Alt+A are gone (approvals render
// in COMMS where the agent paused), and NAVIGATION tells the agent to OPEN a place with station.show instead of describing clicks.
// Re-pinned 2026-10-05 (self-driving lane 2) for ONE deliberate addition: the agent learns EVERYTHING on demand — a CONCEPTS
// reference section (every StarNet thing, its place, its tool, its trap), NAVIGATION's generated EVERY PLACE list (frontend/app/
// places.js), and the dossier's CAN DO replaces the gone SKILLS tab. All reference: the inline form got SHORTER.
// Re-pinned 2026-10-11: CONCEPTS documents SEND TO and the implemented line operations.
// Re-pinned 2026-10-13: CONCEPTS names group.add (an agent brings crew into this chat) and that group.configure's members
// is the WHOLE list (+127), on top of trunk's FIND removal (-330).
// Re-pinned 2026-10-14 (org pass P08): the approval card's 'Full access' key is now 'Never ask' (NAVIGATION -2, CONCEPTS +8).
// Re-pinned 2026-10-14 (org pass P30): NAVIGATION's APPROVALS line names NEEDS YOU at the top of SESSIONS first (+40), and EVERY
// PLACE no longer lists START FRESH under APP & BACKUP — it lives only on the boot recovery screen (-13).
// Re-pinned 2026-10-14 (org pass P01): ONE NEEDS YOU — EVERY PLACE gains needs-you (SESSIONS › NEEDS YOU), and CONCEPTS /
// TROUBLESHOOTING name NEEDS YOU at the top of SESSIONS first, NOTIFICATIONS › NEEDS YOU second (+312). All reference.
// Re-pinned 2026-10-14 (org pass P04): AI & MODELS calls its chain FALLBACK MODELS — CONCEPTS' "Backup models live in" and the
// settings-ai place's "default and backup models" say fallback (+4). All reference.
// Re-pinned 2026-10-14 (org pass P08/P09 review fix): CONCEPTS says what Never ask grants — "never asks and can use the whole
// local computer" (approvalMode full IS unrestricted host in the sidecar), and AUTONOMY's rungs read SMALL JOBS, not BUILD (+27).
// All reference.
// Re-pinned 2026-10-14 (org pass P30 review fix): CONCEPTS no longer puts START FRESH in APP & BACKUP — it says START FRESH
// is only on the startup recovery screen, when a station cannot load (+63). All reference.
// Re-pinned 2026-10-14 (org pass P08 review fix): the approval key that grants the whole computer is called Full power, the
// same word as the FULL POWER access answer — NAVIGATION's APPROVALS line and CONCEPTS' key gloss say Full power, not Never ask (+2).
// Re-pinned 2026-10-14 (org P16): CONCEPTS' scheduler trap names the switch by its one label, ▶ TURN SCHEDULING ON (+1).
// Re-pinned 2026-10-14 (org P20): NAVIGATION / CONCEPTS / TROUBLESHOOTING stop saying a crew-row click focuses an agent — messages go to the agent ON THE LINE; a row click shows its sessions; DOSSIER / right-click / the sprite open its file (+272).
// Re-pinned 2026-10-14 (org P22): TROUBLESHOOTING says RECRUIT one (the bay's one verb), not SUMMON (+1).
// Re-pinned 2026-10-14 (org P12 fix): NAVIGATION (its MY WORK line and the EVERY PLACE to-review entry from places.js) and CONCEPTS say TO REVIEW holds away runs and workflow jobs waiting for a rating (already filed in the library; chats are rated in COMMS), not every finished result waiting on a verdict (+199; reference sections only, the inline form is unchanged).
// Re-pinned 2026-10-14 (org pass merge): track A and track B manual edits combined — TROUBLESHOOTING says NEEDS YOU at the top of SESSIONS AND the agent ON THE LINE in one sentence.
// Re-pinned 2026-10-14 (org P20 STRUCK): the always-shown DOSSIER key is gone again (only 2+ agents, only on the pointed-at row), so NAVIGATION / CONCEPTS / TROUBLESHOOTING say a row click opens the dossier with one agent and shows its sessions with 2+, and never promise a DOSSIER key on every row; a row click still never focuses (+176). All reference.
// Re-pinned 2026-10-14 (org P12 live walk): a TO REVIEW run with no files is not in the library, so NAVIGATION's MY WORK line and
// CONCEPTS say the files they made are in the library, never that every run is already filed there (+12). All reference.
// Re-pinned 2026-10-14 (org P08 STRUCK): the approval card's standing key is the candidate's 'Full access' again — NAVIGATION's APPROVALS line says Full access (+1) and CONCEPTS' key gloss is the candidate's 'Full access (that agent goes FULL POWER)' (-31); NEEDS YOU at the top of SESSIONS (P30) and SMALL JOBS (P09) stay (-30). All reference.
// Re-pinned 2026-10-26 (UX night, Andrew: CONNECT "more like the settings menu"): ABILITIES is ONE flat list — APPS, CONNECTED
// (with API KEYS), SKILL MARKET (with ADD FROM A LINK), SKILLS (with LEARNED SKILLS), TOOLS (with COMPUTER CONTROL), EXTENSIONS — so
// NAVIGATION, CONNECTING, TROUBLESHOOTING and CONCEPTS name those places instead of INSTALLED / DISCOVER / CREATE (-32; the inline
// CONNECTING rule got 17 bytes SHORTER).
A.eq(full.length, 27516,'the whole manual keeps its length (-84: the crew card DOSSIER key removed, NAVIGATION / CONCEPTS name right-click only, 2026-10-26; -32: ONE FLAT LIST, CONNECT › ABILITIES names APPS / CONNECTED › API KEYS / SKILLS / TOOLS, 2026-10-26; +12: org P12 live walk 2026-10-14: TO REVIEW runs are not all in the library — files they made are, in NAVIGATION and CONCEPTS; -30: org P08 struck 2026-10-14: the approval key is Full access again in NAVIGATION and CONCEPTS; +176: org P20 struck 2026-10-14: the row click per crew size, no DOSSIER key promised on every row; org pass A+B merge 2026-10-14; track B: +199: org P12 fix 2026-10-14: TO REVIEW = away runs and workflow jobs waiting for a rating, chats rated in COMMS; +1: org P22 2026-10-14: RECRUIT one, not SUMMON; +272: org P20 2026-10-14: crew-row click no longer described as focus; +1: CONCEPTS names the scheduling switch ▶ TURN SCHEDULING ON, org P16track A: +2: the approval key Never ask → Full power in NAVIGATION and CONCEPTS, 2026-10-14 org P08 review fix; +63: CONCEPTS puts START FRESH on the startup recovery screen, not APP & BACKUP, 2026-10-14 org P30 fix; +27: Never ask names the whole local computer, the AUTONOMY rung BUILD → SMALL JOBS in CONCEPTS, 2026-10-14 org P08/P09 fix; +4: Backup models → Fallback models in CONCEPTS and the settings-ai place, 2026-10-14 org P04; +312: the needs-you place + NEEDS YOU at the top of SESSIONS in CONCEPTS and TROUBLESHOOTING, 2026-10-14 org P01; +27: APPROVALS names NEEDS YOU at the top of SESSIONS, START FRESH leaves APP & BACKUP, 2026-10-14 org P30; +6: the approval key Full access → Never ask, 2026-10-14; +127: group.add in CONCEPTS, 2026-10-13; +30: REFIT is named BUILD MODE; +2: SETTINGS › AI & MODELS; +308: the 0.13 dock, 2026-10-02; +494: station.show + approvals in COMMS, 2026-10-04; +13388: CONCEPTS + EVERY PLACE + the lane-3 actions + FIND, 2026-10-05; +1803: CONCEPTS learns the trunk since 10-04 (desk seats, SETTLE, held credits, browser reset, HINTS, ERASE EVERYTHING) + "conveyor" + the budget.set call shape, 2026-10-08; +287: NAVIGATION says changing is not opening, 2026-10-08; +143: never around the station tools via shell/files/web, 2026-10-08; +160: the SESSIONS rule (pin = a rail session, never a memory note) inline, 2026-10-08; -330: FIND (Ctrl+K) removed with its window and place, 2026-10-13)');
A.eq(crypto.createHash('sha256').update(full, 'utf8').digest('hex'), '89f3be553b82cb9ff51f9198fd9d533ccdcec5d11e5f8fd0f42255962e5d2f5d',
  'the whole manual is byte-identical to the literal that shipped before the split');

// ---- B. the sections partition the manual ----
A.eq(ids, ['about', 'live-state', 'navigation', 'props', 'connectors', 'approval', 'connecting', 'troubleshooting', 'concepts'], 'sections in manual order');
A.eq(reference.map(s => s.id), ['navigation', 'props', 'troubleshooting', 'concepts'], 'reference sections: navigation, props, troubleshooting, concepts');
A.eq(inline.map(s => s.kind), ['orientation', 'rule', 'rule', 'rule', 'rule'], 'everything else is orientation or a behaviour rule');
const body = full.replace('\n<starnet_operator_manual>\n', '').replace('</starnet_operator_manual>', '');
A.eq(ids.map(id => M.manualSection(id)).join('').replace(/\n/g, ''), body.replace(/\n/g, ''), 'the sections, joined in order, ARE the manual (only blank separator lines differ)');
for (const line of body.split('\n').filter(Boolean)) {
  const homes = ids.filter(id => M.manualSection(id).split('\n').indexOf(line) >= 0);
  A.eq(homes.length, 1, 'every manual line lives in exactly one section: ' + line.slice(0, 50));
}

// ---- C. the inline form ----
A.ok(index.indexOf('\n<starnet_operator_manual>\n') === 0 && index.endsWith('</starnet_operator_manual>'), 'inline form keeps the manual fence');
for (const s of inline) A.ok(index.indexOf(M.manualSection(s.id)) >= 0, s.id + ' (' + s.kind + ') rides inline VERBATIM');
for (const s of reference) {
  A.ok(index.indexOf(M.manualSection(s.id)) < 0, s.id + ': the reference body is NOT inline');
  A.ok(index.indexOf('\n- ' + s.id + ': ' + s.summary + '\n') >= 0, s.id + ': has a TOC line with its summary');
}
A.eq(M.INLINE_RULE_EXCERPTS.length, 2, 'two rules live inside a reference section (SESSIONS, AUTOMATE)');
for (const r of M.INLINE_RULE_EXCERPTS) {
  A.ok(M.manualSection('navigation').indexOf(r) >= 0, 'the excerpt is a verbatim line of its reference section');
  A.ok(index.indexOf(r) >= 0, 'and rides inline on its own');
}
A.ok(/call\s+manual\.read with the section id/.test(index) && /never from memory/.test(index), 'the TOC tells the model to call manual.read before naming a window/menu/prop');
// the behaviour rules the manual test (test/manual.test.js) pins on the whole manual, still in the PROMPT form
A.ok(/CALL station\.inspect first/.test(index), 'rule inline: live harness state -> station.inspect');
A.ok(/NEVER send the Commander to BUILD MODE to connect a platform/.test(index), 'rule inline: never BUILD MODE for a connector');
A.ok(/Do not refuse in chat/.test(index), 'rule inline: approval mode -> just call the tool');
A.ok(/HONESTY RULE/.test(index) && /If you have the connectors\.list tool, CALL IT/.test(index) && /not connected YET/.test(index), 'rule inline: the connect-a-platform honesty rules');
A.ok(/Windows Task Scheduler/.test(index) && /OS crontab/.test(index), 'rule inline: routines never go to OS schedulers');
A.ok(/capabilities_ground_truth/.test(index) && /NOT a list of your own powers/.test(index), 'the inline form still defers to <capabilities_ground_truth>');
A.ok(/DISH → WEB/.test(index) && /INTEL CAB → FILES/.test(index) && /WORKBENCH → TERMINAL/.test(index) && /SERVER CART → MEMORY/.test(index) && /WORKSTATION → COMPUTE/.test(index),
  'the props TOC line keeps the prop → power pairings in the live UI vocabulary');
A.ok(full.length - index.length >= 2500, 'the inline form is materially smaller (' + index.length + ' vs ' + full.length + ' chars)');
A.eq(M.starnetManualIndex(), index, 'deterministic: rides the cached prefix');
A.ok(!/undefined|null|\[object/.test(index), 'no junk leaks into the inline form');

// ---- D. manual.read ----
{
  const { tool } = makeManualReadTool();
  for (const id of ids) {
    const r = tool.run({ section: id });
    A.eq(r.content, M.manualSection(id), 'manual.read ' + id + ' returns the section verbatim');
    A.eq(r.summary, 'manual: ' + id, 'summary names the section');
  }
  A.eq(tool.run({ section: 'NAVIGATION' }).content, M.manualSection('navigation'), 'section ids are case-insensitive');
  A.eq(tool.run({ section: 'all' }).content, full, '"all" returns the whole manual');
  const bad = tool.run({ section: 'secrets' });
  A.ok(/No manual section "secrets"/.test(bad.content) && /navigation, props, troubleshooting/.test(bad.content), 'an unknown section lists the real ones');
  A.ok(/Name a section/.test(tool.run({}).content), 'no section -> the list, not an error');
  A.eq(tool.schema.properties.section.enum, ids.concat(['all']), 'the schema enumerates the real section ids');
  A.eq([tool.name, tool.capability, tool.scope, tool.requiresConsent], ['manual.read', 'stationinfo', 'read', false], 'a read-only, consent-free self-knowledge tool');
}

// ---- E. granted everywhere a run has compute; the prompt only points at it when it is on the wire ----
{
  const g = CAP_REGISTRY.computer.filter(x => x.tool === 'manual.read');
  A.eq(g.length, 1, 'manual.read is granted by the COMPUTER object');
  A.eq([g[0].capId, g[0].scope, g[0].requiresConsent, g[0].network, !!g[0].deferred], ['stationinfo', 'read', false, false, false],
    'same grant class as station.inspect, and never deferred (the TOC must point at an advertised tool)');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.eq(idx.split("(coreNames.indexOf('manual.read') >= 0 ? starnetManualIndex() : starnetManual())").length - 1, 1,
    'index.js uses the TOC form only when manual.read is advertised, else the whole manual stays inline');
  A.eq(idx.split('makeManualReadTool().register(registry);').length - 1, 1, 'the run registers manual.read');
}

A.report('manual.on-demand.test');
