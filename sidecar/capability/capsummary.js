/* sidecar/capability/capsummary.js -- summarizeCapabilities: a SHORT, truthful "what you can and
   can't do right now" note appended to the agent's system prompt, derived from the SAME resolved
   grant set the tool gate enforces (resolveTools + enforceRunAuthority). Purpose: stop the agent
   VERBALLY over-promising capabilities it lacks, while also preventing the opposite failure: hiding
   real built-ins the run host actually granted.

   BOTH surfaces get a note, for different reasons:
   - INTERACTIVE: the floor is real, so a missing power is actionable -- name the object to place.
   - AUTONOMOUS/headless (cron, night shift, delegated workers, chat channels): there is no placement
     UI and no Commander watching, and enforceRunAuthority additionally strips shell/verify, live MCP
     connector tools, and Spotify on this surface REGARDLESS of what is placed. Sending no note at all
     left those runs believing they had powers the gate had already removed -- the agent then promised
     work it could not do and blamed the failure on the user's credentials. So the autonomous note
     states the same ground truth minus the (meaningless) placement advice, and tells the agent to
     report the blocker instead of pretending.

   A capId is NOT sufficient evidence of its headline power: a capId can outlive its own flagship tool
   (an autonomous run keeps workbench's background-shell and browser-test tools while shell.exec and
   verify.run are stripped). So when the caller supplies the resolved tool list -- production always
   does -- presence is confirmed against the capability's PROBE tool, not merely its capId. */

'use strict';

// capId -> plain-English power + the object/role that grants it. Order = display order.
// `probe` is the capability's HEADLINE tool: the one whose survival actually justifies the prose.
// Static capIds + probes come from CAP_REGISTRY. MCP connector tools are dynamic and therefore
// detected from resolved.tools below.
const CAPS = [
  { id: 'orchestrator', probe: 'team.dispatch',   have: 'delegate to crew, spawn subagents, summon specialists, and create routines', object: 'the lead ORCHESTRATOR role' },
  { id: 'web',          probe: 'web_search',      have: 'search/fetch the web and use the controlled browser', object: 'a DISH' },
  { id: 'cabinet',      probe: 'fs.read',         have: 'read and write files', object: 'an INTEL CAB' },
  // NOT "control the desktop computer": computer.use/desktop.open carry no capability grant at all and are
  // stripped unconditionally by enforceSyntheticOnly, so claiming desktop control here was a standing lie.
  { id: 'workbench',    probe: 'shell.exec',      have: 'run shell commands and verify code', object: 'a WORKBENCH' },
  { id: 'memory',       probe: 'notebook.write',  have: 'keep long-term memory, reusable skills, and recall conversation history', object: 'a NOTEBOOK' },   // task plans ride the computer now (taskplan freebie, 2026-08-17)
  // `alt`: a narrower true claim when the headline tool is gone but a sibling survives (image generation deferred as
  // certainly unavailable -- no image connection -- while image_analyze still works). Never claim the headline then.
  { id: 'studio',       probe: 'image_generate',  have: 'generate and analyze images, record voice, and render short videos', object: 'a STUDIO', alt: { probe: 'image_analyze', have: 'analyze images' } },
  { id: 'knowledge',    probe: 'knowledge_search', have: 'search a configured local knowledge base (RAGFlow) for relevant passages', object: 'a NOTEBOOK' },
  { id: 'jukebox',      probe: 'spotify_play',    have: 'search and control Spotify', object: 'a JUKEBOX' }
];

// The powers a Commander most often assumes an agent has -> highest over-promise risk -> nag if absent.
const CORE = ['web', 'cabinet', 'workbench'];

function summarizeCapabilities(resolved, opts) {
  opts = opts || {};
  const interactive = !opts.surface || opts.surface === 'interactive';
  // An authenticated owner Telegram DM has desktop-equivalent authority, but no physical floor UI. Keep its
  // capability prose distinct from both a watched browser floor and ordinary unattended automation.
  const ownerTrusted = !!opts.ownerTrusted;
  const unrestrictedHost = opts.unrestrictedHost === true;

  const capIds = new Set(((resolved && resolved.grants) || []).map((g) => g && g.capId).filter(Boolean));
  const toolNames = Array.isArray(resolved && resolved.tools) ? resolved.tools : [];
  // Only trust the tool list as evidence when the caller actually supplied one; a grants-only caller
  // (older callers and unit fixtures) still resolves by capId alone.
  const byTool = toolNames.length > 0;
  const holds = (c) => capIds.has(c.id) && (!byTool || toolNames.indexOf(c.probe) !== -1);

  const hasConnectorTools = toolNames.some((t) => /^mcp__/.test(String(t || '')));
  const have = CAPS.filter(holds);
  const altHave = CAPS.filter((c) => c.alt && byTool && !holds(c) && capIds.has(c.id) && toolNames.indexOf(c.alt.probe) !== -1);
  const lackCore = CAPS.filter((c) => CORE.indexOf(c.id) !== -1 && !holds(c));

  const havePhrases = have.map((c) => c.have).concat(altHave.map((c) => c.alt.have));
  if (hasConnectorTools) havePhrases.push('use live MCP connector tools listed above');
  if (unrestrictedHost) havePhrases.push('use arbitrary local host commands and host paths');
  if (unrestrictedHost && toolNames.indexOf('computer.use') >= 0 && toolNames.indexOf('desktop.open') >= 0)
    havePhrases.push('control visible apps and physical screen/input');
  const haveStr = havePhrases.length
    ? havePhrases.join(', ')
    : (interactive ? 'think and reply (no tools are placed yet)' : 'think and reply (no tools are available on this run)');

  let note = '\n<capabilities_ground_truth>\n' +
    (unrestrictedHost
      ? 'FULL POWER is active: the Commander authorized the whole local computer. StarNet policy must not refuse a host task; only report real unavailable OS, hardware, credential, account, or service prerequisites. '
      : 'These are your REAL powers this run, decided by the objects placed on your station floor and host-granted station roles -- not aspirational. ') +
    'This block is AUTHORITATIVE: if anything earlier in your instructions implies you always have web or file access, ignore it -- what follows is what you ACTUALLY have right now:\n' +
    '- You CAN: ' + haveStr + '.\n';

  // On the UNATTENDED surface, absent connector tools are themselves a missing power worth naming -- and the
  // block must render even when lackCore is EMPTY (a routine granted the terminal has no lacking core cap, yet
  // still needs to be told whether its Commander's connectors are reachable). Interactive is unchanged.
  const lackAutonomous = lackCore.map((c) => c.have).concat(hasConnectorTools ? [] : ['use live MCP connector tools']);
  const missing = interactive ? lackCore.map((c) => c.have) : lackAutonomous;
  if (missing.length) {
    note += '- You do NOT have: ' + missing.join(', ') + '.\n';
    if (interactive) {
      note += 'If the Commander asks for something you lack, do NOT claim, promise, or pretend to do it. Say plainly you can\'t yet, ' +
        'and name the object to place to grant it: ' +
        lackCore.map((c) => c.have + ' -> place ' + c.object).join('; ') + '. ' +
        'You can always think and reply; that needs nothing.\n';
    } else if (ownerTrusted) {
      note += 'This is an authenticated owner Telegram session: it has the same non-physical authority as the StarNet desktop app. ' +
        'Do NOT claim, promise, or pretend to do what is genuinely absent; state the actual missing setup or tool plainly.\n';
    } else {
      // GRANT-AWARE (2026-07-25): a routine can now be granted the terminal and/or its Commander's MCP
      // connectors for unattended use, so this branch must NOT assert a blanket "no shell, no connectors" --
      // that would be a fresh lie to the model on exactly the granted runs the grant exists to enable. Only
      // the capabilities genuinely absent from THIS run's resolved set (lackCore, plus connectors when none
      // survived) are named; desktop control is unconditional because it carries no grant on any surface.
      note += 'This is an UNATTENDED run: no Commander is watching, so ' + lackAutonomous.join(', ') + ' and desktop control ' +
        'are unavailable on this run -- each needs either a watched session or an explicit per-routine grant the ' +
        'Commander sets on the routine itself. Placing objects cannot change that here. ' +
        'Do NOT claim, promise, or pretend to do what you lack, and do NOT blame missing credentials for a power you were never granted. ' +
        'Do everything you genuinely can, then state plainly what you could not do and why, so the Commander can finish it in a watched session.\n';
    }
  }

  note += '</capabilities_ground_truth>';
  return note;
}

module.exports = { summarizeCapabilities };
