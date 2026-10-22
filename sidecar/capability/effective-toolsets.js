/* Read-only disclosure of host authority and profile projection used by runOnce.
   effectiveToolsets describes capability grants, not service availability or a particular run's task policy;
   the CERTAIN-unavailability signals runOnce applies per run live below (unavailableTools). */
'use strict';
const { toolsetRows } = require('./toolsets.js');
const profiles = require('../execution-profiles.js');
function effectiveToolsets({ registry, agentId, agent, placed = [], disabled = {}, fullAccess = false, masterBypass = false, lead = false, backendId = 'local' } = {}) {
  agent = agent || {};
  const source = fullAccess ? 'environment' : masterBypass ? 'station' : agent.approvalMode === 'full' ? 'agent' : null;
  const unrestricted = !!source;
  const profile = profiles.resolve(agent.executionProfile, { approvalMode: agent.approvalMode, backendId });
  const onFloor = new Set(placed);
  const projected = new Set(profile.capabilityObjects);
  return {
    authority: { agentId: agentId || null, name: agent.name || agentId || 'Station defaults', unrestricted, source,
      context: lead ? 'interactive lead' : 'capability grants',
      profile: profile.id, profileLabel: profile.label, filesystemLabel: unrestricted ? 'Whole local computer' : profile.filesystemLabel,
      approvalLabel: unrestricted ? 'FULL ACCESS — no Agent OS approval prompts' : 'ASK — standing grants apply',
      revoke: source === 'environment' ? 'Clear SKYNET_FULL_ACCESS in the launch environment and restart.' : source === 'station' ? 'Turn off the station master bypass in Settings → Permissions; individual Full Access agents stay unrestricted.' : source === 'agent' ? 'Set this agent to ASK in its dossier.' : 'Revoke standing grants in Settings → Permissions.' },
    toolsets: toolsetRows(registry).map(r => {
      const enabled = disabled[r.id] !== false;
      const placedHere = !!(r.object && onFloor.has(r.object));
      const profileGranted = projected.has(r.object);
      const runtimeGranted = lead && r.object === 'orchestrator';
      return Object.assign({}, r, { toolCount: r.tools.length, enabled, placed: placedHere, profileGranted, runtimeGranted,
        available: unrestricted || (enabled && (placedHere || profileGranted || runtimeGranted)),
        grantSource: unrestricted ? 'Full Access' : profileGranted ? profile.label : placedHere ? 'station prop' : runtimeGranted ? 'lead run' : null,
        switchEffective: !unrestricted, consentGated: !unrestricted && r.consentGated });
    })
  };
}
/* CERTAIN UNAVAILABILITY (w2 footprint, 2026-09-22). effectiveToolsets above describes GRANTS. This names the
   narrow set of granted tools the host can PROVE will fail on this run, from signals the host already holds —
   never a guess, never a probe. runOnce moves exactly these from advertised to DEFERRED: still granted, still
   dispatchable, still found by tool.search, whose result carries `why` + `enable` so the model can tell the
   Commander what is missing instead of calling a dead tool or claiming it worked. Nothing here locks a power
   behind an unlock — the fix is always the service's own setup, named in `enable`.
   A fact is certain only as `false`. true = available; undefined = the host does not know -> stays advertised.
   Signals deliberately NOT here because they are not certain: browser.* without a Chromium binary
   (browser.attach can still drive a Chrome the Commander started), channel.send with no known chat (a person
   may message the station mid-run), image_analyze (falls back to the run's own model). */
const AVAILABILITY_SIGNALS = [
  { id: 'media-route', fact: 'mediaRoute', tools: ['image_generate'], label: 'image_generate', announce: true,
    why: 'no image-generation connection is configured for this station',
    enable: 'the Commander signs in to ChatGPT, or connects an OpenAI or OpenRouter key or a Agent OS account in SETTINGS' },
  { id: 'voice-route', fact: 'voiceRoute', tools: ['voice_generate'], label: 'voice_generate', announce: true,
    why: 'no voice route exists: no OpenRouter, Gemini or OpenAI key is connected and the free Edge voice is switched off',
    enable: 'the Commander connects one of those keys in SETTINGS, or removes STARNET_EDGE_TTS=0 from the launch environment' },
  { id: 'spotify', fact: 'spotifyConnected', label: 'spotify_*', announce: true,
    tools: ['spotify_search', 'spotify_now_playing', 'spotify_playlists', 'spotify_play', 'spotify_pause', 'spotify_next', 'spotify_previous', 'spotify_queue'],
    why: 'Spotify is not connected',
    enable: 'the Commander connects Spotify in ABILITIES > TOOLSETS' },
  // Only the four that need a LIVE pty: status/read/stop still answer for recorded sessions, so they stay.
  { id: 'pty', fact: 'ptyRuntime', tools: ['terminal.start', 'terminal.write', 'terminal.resize', 'terminal.interrupt'], label: 'terminal_start/write/resize/interrupt', announce: true,
    why: 'the interactive terminal runtime (node-pty) is not installed or could not load in this Agent OS install',
    enable: 'use shell_exec (background:true for long-running processes) instead; interactive terminals need node-pty in the install' },
  // Found by search, never announced: every interactive run would otherwise carry a sentence about routines.
  { id: 'routine-run', fact: 'routineRun', tools: ['routine.notepad'], label: 'routine_notepad', announce: false,
    why: 'it works only inside a scheduled routine run, and this run is not one',
    enable: 'nothing to enable here: it activates by itself when this agent runs as a Agent OS routine' }
];
// unavailableTools(facts, granted) -> { byTool: { name: { signal, why, enable } }, bySignal: { signalId: [name] } }
// `granted` (Set or array) limits the answer to tools this run actually holds; absent = every signal tool.
function unavailableTools(facts, granted) {
  facts = facts || {};
  const has = granted instanceof Set ? (n => granted.has(n)) : Array.isArray(granted) ? (n => granted.indexOf(n) >= 0) : (() => true);
  const byTool = {}, bySignal = {};
  for (const s of AVAILABILITY_SIGNALS) {
    if (facts[s.fact] !== false) continue;
    const hit = s.tools.filter(has);
    if (!hit.length) continue;
    bySignal[s.id] = hit;
    for (const t of hit) byTool[t] = { signal: s.id, why: s.why, enable: s.enable };
  }
  return { byTool, bySignal };
}
// The prompt line for the announced signals (empty when none fired, so an all-available run gains no bytes).
function unavailableLine(bySignal) {
  const parts = [];
  for (const s of AVAILABILITY_SIGNALS) {
    if (!s.announce || !bySignal || !Array.isArray(bySignal[s.id]) || !bySignal[s.id].length) continue;
    parts.push(s.label + ' — ' + s.why + '; to enable, ' + s.enable);
  }
  if (!parts.length) return '';
  return 'Granted tools that CANNOT work right now (tool_search still finds them): ' + parts.join('. ') + '. '
    + 'Never claim one of these worked; tell the Commander what is missing. ';
}
module.exports = { effectiveToolsets, AVAILABILITY_SIGNALS, unavailableTools, unavailableLine };
