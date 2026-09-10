'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'app.css'), 'utf8');

for (const id of ['safe-cell', 'remote-ssh', 'trusted-project', 'this-computer']) A.ok(ui.includes("id: '" + id + "'"), 'dossier offers ' + id);
A.ok(/id="ag-execution-chips"/.test(ui) && /setExecutionProfile/.test(ui), 'dossier profile control writes the live roster');
A.ok(/id="perm-crew"/.test(ui) && /data-perm-profile/.test(ui), 'Settings offers per-agent execution profiles too');
A.ok(/ROUTES NEXT COMMAND TO <b>/.test(ui) && /AVAILABILITY <b>/.test(ui), 'dossier shows the per-agent routed backend and readiness truth');
A.ok(/routes next command to/.test(ui) && /availability/.test(ui), 'Settings shows the per-agent runtime selected for the next command');
A.ok(!/backend change requires a station restart/.test(ui), 'profile selection is not falsely described as a boot-only setting');
A.ok(/never grants real mouse, keyboard, or screen control/.test(ui), 'profile card names the separate desktop lease');
A.ok(/FULL POWER/.test(ui) && /whole local computer/.test(ui), 'approval copy names the host-wide authority honestly');
A.ok(/protected files, arbitrary commands, visible apps/.test(ui), 'Settings states the concrete Full Power reach');
A.ok(/executionProfile: executionProfileOf\(a\)/.test(app), 'profile persists in the browser save and roster push');
A.ok(/setAgentExecutionProfile/.test(app), 'profile has an independent app setter');
A.ok(/approvalMode: .*executionProfile:/.test(app), 'approval and profile ride the roster as separate fields');
A.ok(/Full power allows actions across your computer without approval prompts/.test(html), 'genesis teaches the host-wide Full Power meaning');
A.ok(/data-ssh-host/.test(ui) && /data-ssh-root/.test(ui) && /SAVE &amp; PROBE/.test(ui), 'Settings exposes owner-configured SSH target fields');
A.ok(/StrictHostKeyChecking|strict known_hosts/.test(ui), 'SSH copy names the strict host-key boundary');
A.ok(/\/api\/execution\/sync/.test(ui) && /PUSH NOW/.test(ui) && /PULL NOW/.test(ui), 'Settings exposes explicit remote workspace sync controls');
A.ok(/\/api\/execution\/policy/.test(ui) && /STOP IDLE CELL/.test(ui), 'Settings exposes stop-only idle-cell policy and action');
// The crew row STACKS (header → CAN REACH → ASKS FIRST → advanced): the SSH disclosure and the cleanup
// action each own a full-width lane of their own inside .pc-more, so neither can wrap into a chip strip.
A.ok(/\.perm-agent\[data-profile-agent\]\{display:block\}/.test(css), 'the crew row stacks its axes rather than packing them into columns');
A.ok(/\.perm-crew-row \.pc-more \{[^}]*border-top/.test(css) && /class="pc-more">' \+ cell \+ ssh/.test(ui), 'SSH disclosure + STOP IDLE CELL occupy their own separated lane under both axes');
A.ok(/\.perm-crew-row \.pc-truth \{/.test(css) && /class="mc-hint pc-truth">' \+ sandboxChip\(row\) \+ 'routes next command to/.test(ui), 'the routing truth line survives the redesign, demoted below the plain sentence');

// Lane C: SANDBOX UNAVAILABLE chip — rendered from the router's real resolution (backendMatched:false), both on
// the dossier truth line and the Settings crew row, naming the fix. Exercised by evaluating the helper for real.
A.ok(/function sandboxChip\(row\)/.test(ui) && /env\.backendMatched !== false/.test(ui), 'sandboxChip keys off the sidecar backendMatched truth only');
A.ok(/epTruth\.innerHTML = sandboxChip\(row\)/.test(ui), 'dossier truth line carries the chip');
A.ok(/class="mc-hint pc-truth">' \+ sandboxChip\(row\)/.test(ui), 'Settings crew row carries the chip');
A.ok(/\.sandbox-chip \{[^}]*var\(--bad\)/.test(css), 'chip is painted from theme vars (no white control)');
{
  const m = /function sandboxChip\(row\) \{[\s\S]*?\n  \}\n/.exec(ui);
  const fn = new Function('esc', m[0] + 'return sandboxChip;')(s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  A.eq(fn(null), '', 'no row (unknown) renders no chip');
  A.eq(fn({ environment: { backendMatched: true } }), '', 'matched backend renders no chip');
  const out = fn({ environment: { backendMatched: false, requestedBackend: 'docker', mismatchReason: 'Docker is not available on this machine', refusing: true } });
  A.ok(/SANDBOX UNAVAILABLE/.test(out) && /data-sandbox-unavailable="docker"/.test(out), 'backendMatched:false renders the red chip');
  A.ok(/Start Docker, or change the execution profile/.test(out) && /REFUSED/.test(out), 'chip names the fix and the refusal');
  A.ok(/running on this computer instead/.test(fn({ environment: { backendMatched: false, requestedBackend: 'ssh', refusing: false } })), 'allow policy is described honestly as running on the host');
}
A.report('execution-profiles-ui.test');
