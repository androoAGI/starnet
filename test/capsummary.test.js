/* node test/capsummary.test.js -- the truthful capabilities note appended to the system prompt.
   Verifies it is derived from the resolved grant set, names the object to place for missing core
   powers on the interactive floor, states an honest unattended-run limit on autonomous surfaces,
   refuses to claim a power whose headline tool was stripped, and does not erase real
   host-granted/dynamic tools. */
'use strict';
const A = require('./_assert.js');
const { summarizeCapabilities } = require('../sidecar/capability/capsummary.js');

// helper: a resolved-like object from a list of capIds (no tool list -> resolve by capId alone)
const resolvedWith = (...capIds) => ({ grants: capIds.map((id) => ({ capId: id, tool: id + '.x' })) });
// helper: a resolved-like object carrying BOTH grants and the surviving tool list, the shape
// production always passes (post enforceRunAuthority).
const resolvedTools = (capIds, tools) => ({
  grants: capIds.map((id) => ({ capId: id, tool: id + '.x' })),
  tools: tools.slice()
});

(function () {
  // 1) interactive, nothing placed (compute-only) -> honest "can't yet" + place-the-object guidance
  const none = summarizeCapabilities(resolvedWith(), { surface: 'interactive' });
  A.ok(/think and reply/.test(none), 'compute-only: says it can still think and reply');
  A.ok(/do NOT have/.test(none), 'compute-only: declares missing powers');
  A.ok(/place a DISH/.test(none) && /place an INTEL CAB/.test(none) && /place a WORKBENCH/.test(none),
    'compute-only: names DISH + INTEL CAB + WORKBENCH to place');
  A.ok(/do NOT claim, promise, or pretend/.test(none), 'compute-only: explicit no-over-promising instruction');

  // 2) interactive, a DISH placed (web/browser) -> web/browser in CAN, not in the lack list
  const web = summarizeCapabilities(resolvedWith('web'), { surface: 'interactive' });
  A.ok(/You CAN:.*search\/fetch the web and use the controlled browser/.test(web), 'web present: listed under CAN');
  A.ok(!/web.*-> place a DISH/.test(web), 'web present: not nagged to place a DISH');
  A.ok(/place an INTEL CAB/.test(web) && /place a WORKBENCH/.test(web), 'web present: still flags files + shell');

  // 3) interactive, all core placed -> no "do NOT have" section at all
  const full = summarizeCapabilities(resolvedWith('web', 'cabinet', 'workbench', 'memory'), { surface: 'interactive' });
  A.ok(!/do NOT have/.test(full), 'all core placed: no missing-powers section');
  A.ok(/run shell commands and verify code/.test(full) && /read and write files/.test(full),
    'all core placed: lists them under CAN');
  A.ok(!/control the desktop computer/.test(full),
    'workbench never claims desktop control (computer.use/desktop.open carry no grant and are always stripped)');

  const fullPower = summarizeCapabilities(
    resolvedTools(['web', 'cabinet', 'workbench'], ['web_search', 'fs.read', 'shell.exec', 'computer.use', 'desktop.open']),
    { surface: 'autonomous', unrestrictedHost: true });
  A.ok(/FULL POWER is active: the Commander authorized the whole local computer/.test(fullPower),
    'Full Power is stated at the final authoritative prompt seam');
  A.ok(/arbitrary local host commands and host paths/.test(fullPower) && /physical screen\/input/.test(fullPower),
    'Full Power names general host execution and the actually projected native desktop tools');

  // 4) autonomous surface -> still emits, but with the unattended limit instead of placement advice
  const auto = summarizeCapabilities(resolvedWith(), { surface: 'autonomous' });
  A.ok(auto.length > 0, 'autonomous: emits a ground-truth note (silence let it over-promise)');
  A.ok(/UNATTENDED run/.test(auto), 'autonomous: names the unattended-run limit');
  A.ok(!/place a DISH|place an INTEL CAB|place a WORKBENCH/.test(auto),
    'autonomous: no placement advice (there is no placement UI on this surface)');
  A.ok(/state plainly what you could not do/.test(auto), 'autonomous: told to report the blocker, not pretend');
  A.ok(/do NOT blame missing credentials/.test(auto),
    'autonomous: explicitly forbidden from blaming credentials for an ungranted power');

  // 4b) an admitted owner Telegram DM has desktop-equivalent non-physical authority, so it must not receive
  // the ordinary unattended warning or impossible floor-placement advice.
  const owner = summarizeCapabilities(resolvedWith(), { surface: 'autonomous', ownerTrusted: true });
  A.ok(/authenticated owner Telegram session/.test(owner), 'owner DM: names the actual trusted remote-control posture');
  A.ok(!/UNATTENDED run/.test(owner), 'owner DM: does not falsely describe the Commander as unattended automation');
  A.ok(!/place a DISH|place an INTEL CAB|place a WORKBENCH/.test(owner), 'owner DM: never suggests inaccessible floor placement');

  // 5) no surface specified -> behaves as interactive (emits the note)
  A.ok(summarizeCapabilities(resolvedWith()).length > 0, 'unspecified surface defaults to interactive (emits)');

  // 6) robustness: null/garbage input never throws, returns a string
  A.eq(typeof summarizeCapabilities(null, { surface: 'interactive' }), 'string', 'null resolved: still returns a string');
  A.eq(typeof summarizeCapabilities({}, {}), 'string', 'empty resolved + empty opts: string');

  // 7) non-core caps surface under CAN but are NEVER nagged as missing
  const studio = summarizeCapabilities(resolvedWith('studio'), { surface: 'interactive' });
  A.ok(/You CAN:.*generate and analyze images/.test(studio), 'studio present: listed under CAN');
  A.ok(!/do NOT have:[^\n]*image/i.test(none), 'studio is never listed under "do NOT have"');
  A.ok(!/do NOT have:[^\n]*memory/i.test(none), 'memory is never nagged as missing');

  // 8) the exact power -> object pairing is correct
  A.ok(/search\/fetch the web and use the controlled browser -> place a DISH/.test(none), 'pairing: web/browser -> DISH');
  A.ok(/read and write files -> place an INTEL CAB/.test(none), 'pairing: files -> INTEL CAB');
  A.ok(/run shell commands and verify code -> place a WORKBENCH/.test(none),
    'pairing: shell/verify -> WORKBENCH');

  // 8b) a capId that OUTLIVES its headline tool must not be claimed. On an autonomous run the
  // workbench capId survives via shell.bg.*/browser.test_* while shell.exec and verify.run are
  // stripped by enforceRunAuthority -- claiming "run shell commands" there is exactly the
  // over-promise this block exists to prevent.
  const partial = summarizeCapabilities(
    resolvedTools(['workbench', 'cabinet'], ['shell.bg.status', 'browser.test_state', 'fs.read', 'fs.write']),
    { surface: 'autonomous' });
  A.ok(!/You CAN:[^\n]*run shell commands/.test(partial),
    'partial workbench: shell is NOT claimed when shell.exec was stripped');
  A.ok(/do NOT have:[^\n]*run shell commands/.test(partial),
    'partial workbench: shell is reported as missing');
  A.ok(/You CAN:[^\n]*read and write files/.test(partial),
    'partial workbench: a fully-surviving cap (files) is still claimed');

  // 9) the note is AUTHORITATIVE (defeats an earlier unconditional "you always have web/files" identity clause)
  A.ok(/AUTHORITATIVE/.test(none) && /ignore it/.test(none), 'note explicitly overrides any earlier blanket capability claim');

  // 10) malformed grants array (null / {} / blank capId) is tolerated and contributes nothing
  const junk = summarizeCapabilities({ grants: [null, {}, { capId: '' }, { capId: 'web' }] }, { surface: 'interactive' });
  A.ok(/You CAN:.*search\/fetch the web and use the controlled browser/.test(junk),
    'malformed grants: still surfaces the valid web cap');
  A.ok(!/undefined|null/.test(junk), 'malformed grants: no junk leaks into the note');

  // 11) host-granted and dynamic powers must not be erased by the authoritative block
  const lead = summarizeCapabilities(resolvedWith('orchestrator'), { surface: 'interactive' });
  A.ok(/delegate to crew, spawn subagents, summon specialists, and create routines/.test(lead),
    'orchestrator present: lead powers are listed under CAN');
  const jukebox = summarizeCapabilities(resolvedWith('jukebox'), { surface: 'interactive' });
  A.ok(/search and control Spotify/.test(jukebox), 'jukebox present: listed under CAN');
  const conn = summarizeCapabilities({ grants: [], tools: ['mcp__github__list_issues'] }, { surface: 'interactive' });
  A.ok(/live MCP connector tools/.test(conn), 'dynamic MCP connector tools are acknowledged instead of hidden');

  // studio with image generation certainly unavailable (deferred: no image connection) but image_analyze live:
  // claim only what survives -- never "generate" -- and still acknowledge analysis.
  const studioGrant = { grants: [{ capId: 'studio' }], tools: ['image_analyze'] };
  const analyzeOnly = summarizeCapabilities(studioGrant, { surface: 'interactive' });
  A.ok(!/generate and analyze images/.test(analyzeOnly), 'no image-generation claim when image_generate is not in the run tools');
  A.ok(/analyze images/.test(analyzeOnly), 'image analysis is still claimed when image_analyze survives');
  const both = summarizeCapabilities({ grants: [{ capId: 'studio' }], tools: ['image_generate', 'image_analyze'] }, { surface: 'interactive' });
  A.ok(/generate and analyze images/.test(both), 'the full studio claim stands when image_generate is live');
  const neither = summarizeCapabilities({ grants: [{ capId: 'studio' }], tools: ['fs.read'] }, { surface: 'interactive' });
  A.ok(!/images/.test(neither.split('You do NOT have')[0]), 'no image claim at all when neither studio tool survives');

  // TOOLLESS TURN: a chat-classified turn carries NO tool declarations, so the grant set is stated as the station's,
  // never as "You CAN" on a reply with nothing to call; the missing-power advice stays (it is still true).
  const webToolless = summarizeCapabilities(resolvedWith('web'), { surface: 'interactive', toolless: true });
  A.ok(!/You CAN:/.test(webToolless), 'toolless: no "You CAN" claim on a turn with no tools attached');
  A.ok(/Your station grants:.*search\/fetch the web/.test(webToolless), 'toolless: the station grant is still stated');
  A.ok(/NONE of these tools are attached to THIS reply/.test(webToolless), 'toolless: says plainly that nothing is attached to this reply');
  A.ok(/never claim you searched, fetched, browsed/.test(webToolless), 'toolless: forbids claiming tool work this reply');
  A.ok(/You do NOT have:/.test(webToolless) && /place an INTEL CAB/.test(webToolless), 'toolless: the missing-power placement advice stays');
  A.eq(webToolless, summarizeCapabilities(resolvedWith('web'), { surface: 'interactive', toolless: true }), 'toolless: byte-stable (it rides the cached prefix)');
  A.eq(summarizeCapabilities(resolvedWith('web'), { surface: 'interactive', toolless: false }), web, 'a task turn is byte-identical to before');
  const noneToolless = summarizeCapabilities(resolvedWith(), { surface: 'interactive', toolless: true });
  A.eq(noneToolless, none, 'nothing granted: the "think and reply" line is already true and unchanged');
  A.report('capsummary.test');
})();
