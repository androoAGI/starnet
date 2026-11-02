/* node test/aux-panel-ceiling.test.js — issue #105, the Memory panel's token ceiling (UI1, UI2). The real loadReflectionConfig is cut out of
   stationui.js and executed over stub elements: REFLECTION must not read plain ON while the ceiling has stopped the passes, the
   stopped line must name the route and say nothing queues, and SAVE must send the setting or refuse junk. The wording is locked too,
   because it is the claim: what is not stopped, what is not counted. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const at = ui.indexOf('function loadReflectionConfig()');
A.ok(at >= 0, 'loadReflectionConfig found');
const src = ui.slice(at, ui.indexOf('\n  }\n', at) + 4);

function el(init) { const h = {}; return Object.assign({ value: '', checked: false, textContent: '', className: '', style: {}, focus() {}, addEventListener(n, fn) { h[n] = fn; }, fire(n) { return h[n] && h[n](); } }, init || {}); }
async function panel(cfg) {
  const els = {};
  for (const id of ['mc-reflect-on', 'mc-reflect-state', 'mc-cooldown', 'mc-scope', 'mc-reflect-msg', 'mc-reflect-save', 'mc-aux-tokens', 'mc-aux-tokens-used', 'mc-aux-tokens-blocked']) els['#' + id] = el();
  const posts = [];
  const box = { cfg };
  const Harness = { api: { get: async () => box.cfg, post: async (url, body) => { posts.push([url, body]); return { ok: true, j: {} }; } } };
  const load = new Function('$', 'Harness', 'sfx', src + '\nreturn loadReflectionConfig;')(s => els[s] || null, Harness, () => {});
  load();
  await new Promise(r => setImmediate(r));
  return { els, posts, box };
}
const CFG = { reflectEnabled: true, reflectCooldownMs: 180000, auxTokenCeiling: 200000, auxTokenRoutes: [], auxTokensUsed24h: 0, auxTokenBlocked: [] };

(async () => {
  // UI1: the state the panel paints
  {
    const { els } = await panel(CFG);
    A.eq(els['#mc-reflect-state'].textContent, 'ON', 'under the ceiling REFLECTION reads ON');
    A.eq(els['#mc-aux-tokens-blocked'].style.display, 'none', 'and no stopped line shows');
    A.eq(els['#mc-aux-tokens'].value, '200000', 'the ceiling is shown');
    A.ok(/No background tokens used/.test(els['#mc-aux-tokens-used'].textContent), 'nothing used says so');
  }
  {
    const { els } = await panel(Object.assign({}, CFG, { auxTokenBlocked: ['claude-cli'], auxTokenRoutes: [{ provider: 'claude-cli', label: 'CLAUDE CLI', used: 250000, blocked: true }, { provider: 'codex', label: 'CODEX', used: 10, blocked: false }] }));
    A.eq(els['#mc-reflect-state'].textContent, 'ON, PAUSED ON CLAUDE CLI', 'at the ceiling the word names where it stopped, and only there');
    const line = els['#mc-aux-tokens-blocked'];
    A.eq(line.style.display, '', 'the stopped line shows');
    A.ok(line.textContent.includes('CLAUDE CLI') && !line.textContent.includes('CODEX'), 'and names only the stopped route');
    A.ok(/do not catch up later/.test(line.textContent) && /lost for good/.test(line.textContent), 'it says nothing queues and a failure review is lost');
    A.ok(/skill-review count holds/.test(line.textContent), 'and what does hold');
    A.ok(/CLAUDE CLI 250/.test(els['#mc-aux-tokens-used'].textContent) && /CODEX 10 tokens/.test(els['#mc-aux-tokens-used'].textContent), 'each route shows its own figure');
    A.ok(/not published/.test(els['#mc-aux-tokens-used'].textContent), 'and plan accounting is not claimed');
  }
  {
    const { els } = await panel(Object.assign({}, CFG, { reflectEnabled: false, auxTokenRoutes: [{ provider: 'claude-cli', label: 'CLAUDE CLI', used: 9, blocked: true }] }));
    A.eq(els['#mc-reflect-state'].textContent, 'OFF', 'OFF stays OFF at the ceiling');
  }
  // one route stopped says so without pausing the others: the state test/aux-token-ceiling.e2e scopeArm sets up
  {
    const { els } = await panel(Object.assign({}, CFG, { auxTokenBlocked: ['codex'], auxTokenRoutes: [{ provider: 'claude-cli', label: 'CLAUDE CLI', used: 10, blocked: false }, { provider: 'codex', label: 'CODEX', used: 250000, blocked: true }] }));
    A.eq(els['#mc-reflect-state'].textContent, 'ON, PAUSED ON CODEX', 'Codex at its ceiling names Codex, not the station');
    A.eq(els['#mc-reflect-on'].checked, true, 'the switch itself stays on');
    els['#mc-reflect-on'].checked = false; els['#mc-reflect-on'].fire('change');
    A.eq(els['#mc-reflect-state'].textContent, 'OFF', 'flipping it off repaints');
    els['#mc-reflect-on'].checked = true; els['#mc-reflect-on'].fire('change');
    A.eq(els['#mc-reflect-state'].textContent, 'ON, PAUSED ON CODEX', 'and back on keeps the route');
  }
  {
    const { els } = await panel(Object.assign({}, CFG, { auxTokenRoutes: [{ provider: 'claude-cli', label: 'CLAUDE CLI', used: 9, blocked: true }, { provider: 'codex', label: 'CODEX', used: 9, blocked: true }] }));
    A.eq(els['#mc-reflect-state'].textContent, 'ON, PAUSED ON CLAUDE CLI, CODEX', 'every stopped route is named');
  }
  // a save that raises the ceiling repaints from the server's read: the stopped line goes, the word follows, the toggle listener too
  {
    const blocked = Object.assign({}, CFG, { auxTokenCeiling: 1, auxTokenRoutes: [{ provider: 'claude-cli', label: 'CLAUDE CLI', used: 900, blocked: true }] });
    const { els, box } = await panel(blocked);
    A.eq(els['#mc-aux-tokens-blocked'].style.display, '', 'fixture: stopped before the save');
    box.cfg = Object.assign({}, CFG, { auxTokenCeiling: 5000, auxTokenRoutes: [{ provider: 'claude-cli', label: 'CLAUDE CLI', used: 900, blocked: false }] });
    els['#mc-cooldown'].value = '3';
    els['#mc-reflect-on'].checked = true;
    els['#mc-aux-tokens'].value = '5000';
    els['#mc-reflect-save'].fire('click');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    A.eq(els['#mc-aux-tokens-blocked'].style.display, 'none', 'the stopped line is gone without reopening the panel');
    A.eq(els['#mc-reflect-state'].textContent, 'ON', 'the word follows');
    A.eq(els['#mc-reflect-msg'].textContent, '✓ saved', 'the saved note survives the reload');
    els['#mc-reflect-on'].checked = false; els['#mc-reflect-on'].fire('change');
    els['#mc-reflect-on'].checked = true; els['#mc-reflect-on'].fire('change');
    A.eq(els['#mc-reflect-state'].textContent, 'ON', 'the once-wired listener reads the new state, not the old one');
    box.cfg = blocked;
    els['#mc-reflect-save'].fire('click');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    A.eq(els['#mc-reflect-state'].textContent, 'ON, PAUSED ON CLAUDE CLI', 'and a save that lowers it pauses the word again');
  }
  // UI2: SAVE
  {
    const { els, posts } = await panel(CFG);
    els['#mc-cooldown'].value = '3';
    els['#mc-reflect-on'].checked = true;
    els['#mc-aux-tokens'].value = '50000';
    els['#mc-reflect-save'].fire('click');
    await new Promise(r => setImmediate(r));
    A.eq(posts.length, 1, 'SAVE posts once');
    A.eq(posts[0][1].auxTokenCeiling, 50000, 'with the ceiling as a number');
    for (const bad of ['', '-1', '1.5', 'lots']) {
      posts.length = 0;
      els['#mc-aux-tokens'].value = bad;
      els['#mc-reflect-save'].fire('click');
      await new Promise(r => setImmediate(r));
      A.eq(posts.length, 0, 'refused without a post: ' + JSON.stringify(bad));
      A.ok(/token ceiling/.test(els['#mc-reflect-msg'].textContent), 'and it says why');
    }
    posts.length = 0;
    els['#mc-aux-tokens'].value = '0';
    els['#mc-reflect-save'].fire('click');
    await new Promise(r => setImmediate(r));
    A.eq(posts[0] && posts[0][1].auxTokenCeiling, 0, '0 is a real setting: off');
  }
  // the standing note: the claim itself
  {
    const m = ui.match(/id="mc-aux-tokens-note">([^<]*)</);
    A.ok(m, 'the note is in the panel');
    const note = m[1];
    A.ok(/not queued/.test(note), 'it does not promise skipped passes wait');
    A.ok(!/\bwait\b/.test(note), 'the word that overclaimed is gone');
    A.ok(/Local models have no ceiling/.test(note), 'local routes are named');
    A.ok(/stops on that route/.test(note) && !/that sign-in/.test(note), 'the key is the route, not the account');
    A.ok(/several accounts on one route share it/.test(note) && /earlier subscription usage still counts/.test(note), 'and what that means is stated');
    A.ok(/reviews from rating a run and REFRESH QUESTS/.test(note), 'the Commander-triggered bypasses are named');
    A.ok(/your own runs, one-off actions you press, and planning runs the app starts for you/.test(note), 'what is neither stopped nor counted is named, the internal planning runs included');
    A.ok(/counts as 0/.test(note) && /can go over/.test(note), 'the soft edges are named');
  }
  A.report('aux-panel-ceiling.test');
})().catch(e => { console.log('FAIL: aux-panel-ceiling.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
