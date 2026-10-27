/* node test/consent-timer-hint.test.js — org(P02): where Always lives, and when an unanswered ask is denied — said in
   SETTINGS, never on the approval card (Andrew 10-14: "the approval key doesn't have to mention the auto denies").
   GENUINE: chat.js consentHintFor run for real — a first ask has NO hint line; the SECOND ask for the same tool in the same
   direct chat carries one line teaching Always, naming the tool in the card title's words (a re-render of one ask is not a
   second ask; a worker's ask never gets it). stationui.js consentTipText run for real — the STANDING APPROVALS heading's
   tip names the sidecar's own timeout in minutes, its on-screen bound (5×, capped at 15 min), and where to change it.
   SOURCE-LOCKED: no approval card says it auto-denies; the line is only on the default card (never station.power /
   plugin.submit / browser.login, the freshConsent tools whose Always grants one call); the heading's tip is a data-tip. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const part = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('slice ' + a); return s.slice(i, j); };

// ---- the card: no auto-deny line; a repeat ask's one Always line ----
const chat = read('frontend/app/chat.js');
const hintSrc = part(chat, '  const askedTools = new Map();', '  function retireOpenConsents(');
const c = vm.createContext({ String, Map, Set });
vm.runInContext(hintSrc + '\n;this.hint = consentHintFor;', c);
const ws = { id: 'w1', agentId: 'agent' }, other = { id: 'w2', agentId: 'agent' };
A.eq(c.hint({ promptId: 'a1', tool: 'fs.write' }, ws), '', 'a first ask carries no hint line');
A.eq(c.hint({ promptId: 'a1', tool: 'fs.write' }, ws), '', 'a re-render of the same ask is not a second ask');
A.eq(c.hint({ promptId: 'a2', tool: 'fs.write' }, ws), 'Always stops asking for fs write from now on', 'the second ask for the same tool in the same chat teaches Always, in the title words');
A.eq(c.hint({ promptId: 'a3', tool: 'shell.exec' }, ws), '', 'another tool starts its own count');
A.eq(c.hint({ promptId: 'a4', tool: 'fs.write' }, other), '', 'another chat starts its own count');
A.eq(c.hint({ promptId: 'm1', tool: 'mcp__sheets__write_values' }, other), '', 'a first connector ask: no line');
A.eq(c.hint({ promptId: 'm2', tool: 'mcp__sheets__write_values' }, other), 'Always stops asking for sheets write values from now on', 'a connector tool says whose, as its title does');
for (const w of [{ workerAgentId: 'writer' }, { workerRunId: 'wr1' }, { background: true }]) {
  c.hint(Object.assign({ promptId: 'b1', tool: 'web_request' }, w), ws);
  A.eq(c.hint(Object.assign({ promptId: 'b2', tool: 'web_request' }, w), ws), '', 'a worker\'s ask never gets a line: ' + Object.keys(w)[0]);
}
A.ok(!/auto-den/i.test(hintSrc.replace(/\/\*[\s\S]*?\*\//g, '')) && !/readConsentDeadline|consentSeenMs|liveAckMs/.test(chat), 'no approval card says it auto-denies, and the card never reads the deny deadline');
const branches = part(chat, "    if (p.tool === 'browser.login') {", "    appendConsentDetails(r.body, p, 'plan');");
const dflt = branches.slice(branches.lastIndexOf('    } else {'));
A.ok(/const hintText = consentHintFor\(p, ws\);/.test(dflt) && /if \(hintText\) \{ const hint = document\.createElement\('span'\); hint\.className = 'consent-hint'; hint\.textContent = hintText; btns\.appendChild\(hint\); \}/.test(dflt),
  'the default card adds the line only when there is one, inside its keys (it leaves with them)');
A.eq((branches.match(/consentHintFor\(/g) || []).length, 1, 'only the default card has it: never station.power / plugin.submit / browser.login');
A.ok(/\.consent-hint \{[^}]*flex-basis: 100%/.test(read('frontend/css/app.css')), 'the line is a full-width line in the keys row');

// ---- the STANDING APPROVALS heading's tip ----
const ui = read('frontend/app/stationui.js');
const u = vm.createContext({ Number, Math });
vm.runInContext(part(ui, '  function consentMinutes(ms)', '  function paintConsentTip(host)') + '\n;this.tip = consentTipText;', u);
A.eq(u.tip(120000), 'unanswered asks are denied after 2 min (10 min once the card is on screen) · change it in APP & BACKUP › Runtime limits', 'the default: 2 min unseen, 10 min on screen');
A.eq(u.tip(300000), 'unanswered asks are denied after 5 min (15 min once the card is on screen) · change it in APP & BACKUP › Runtime limits', 'the on-screen bound is capped at 15 min');
A.eq(u.tip(90000), 'unanswered asks are denied after 1.5 min (7.5 min once the card is on screen) · change it in APP & BACKUP › Runtime limits', 'minutes, never MS');
A.eq(u.tip(null), 'unanswered asks are denied on a timer · change it in APP & BACKUP › Runtime limits', 'unknown timeout: no number');
A.eq(u.tip(120000, 600000, 300000), 'unanswered asks are denied after 2 min (10 min once the card is on screen) · changes to 5 min after a restart · change it in APP & BACKUP › Runtime limits',
  'a CONSENT TIMEOUT saved since boot is not the deadline yet: the tip states the enforced one and says the new one waits for a restart');
A.eq(u.tip(120000, 600000, 120000), u.tip(120000), 'saved == enforced: no restart note');
A.ok(/if \(f && Number\(f\.live\) > 0\) h\.setAttribute\('data-tip', consentTipText\(f\.live, f\.liveAckMs, f\.effective\)\);/.test(ui),
  'the stated number is the sidecar\'s ENFORCED deadline (live), never `effective` (which a save changes before the next boot)');
{
  const side = readSidecarSource();
  const st = part(side, 'function runtimeKnobsStatus() {', 'function handleRuntimeKnobsGet(');
  A.ok(/fields\.consentTimeoutMs\.live = CONSENT_TIMEOUT_MS;/.test(st) && /fields\.consentTimeoutMs\.liveAckMs = CONSENT_ACK_EXTEND_MS;/.test(st),
    'GET /api/runtime/knobs reports the boot-frozen constants the consent waiters use');
  A.ok(/timeoutMs: CONSENT_TIMEOUT_MS, extendMs: CONSENT_ACK_EXTEND_MS/.test(side), 'those are the constants the waiters are handed');
}
A.ok(/<h4 class="ms-h" id="perm-standing-h" data-tip="' \+ esc\(consentTipText\(null\)\) \+ '">STANDING APPROVALS/.test(ui), 'the heading carries the tip as a data-tip (no new row, no native title)');
A.ok(/st\.fields && st\.fields\.consentTimeoutMs/.test(ui) && /paintConsentTip\(host\);/.test(ui), 'the number is the sidecar\'s own consentTimeoutMs, read when PERMISSIONS opens');
A.ok(/label: 'APP & BACKUP'/.test(ui) && /Runtime limits <span class="dim">/.test(ui), 'the tip names a place that exists');
A.ok(/Math\.min\(CONSENT_TIMEOUT_MS \* 5, 900000\)/.test(readSidecarSource()), 'the on-screen bound matches the sidecar (5×, 15 min cap)');
A.report('consent-timer-hint.test');
