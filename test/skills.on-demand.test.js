/* node test/skills.on-demand.test.js — INSTALLED SKILLS on demand (progressive disclosure, 2026-09-23).

   The enabled library recipe BODIES were the largest block of every task prompt (~12.4K of ~37K on a default
   station, re-sent on every model call). The prompt now carries one index line per enabled recipe (name + its
   "use when" line + the library:<slug> name to load it by) and skill.view serves the exact body. Project law:
   simplify = organization, never removal — so this pins that
     A. the index lists EVERY offered recipe (name, [library:slug], description) and carries NO body;
     B. a recipe without a description is indexed by the first meaningful sentence of its body;
     C. the index offers exactly the recipes the inline block would (same gating, same class-package order);
     D. skill.view returns the EXACT body for an indexed recipe, by library:<slug>, bare slug, or name;
     E. a recipe the run was NOT offered (disabled / gear absent) is not served;
     F. agent-authored skill.view is byte-identical with and without the bundled resolver (the agent's own
        store always wins; the not-found message is unchanged), and a recipe view never counts as an agent-skill
        read (no onView, no read-before-write credit);
     G. index.js composes the index ONLY when skill.view is on the run's wire and keeps the bodies inline
        otherwise — the index can never point at a tool the model cannot call.
   Pure + deterministic. The live bytes are proven by test/prompt-on-demand.e2e.test.js. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const C = require('../sidecar/skills/catalog.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');

const LIB = C.loadDir(path.join(__dirname, '..', 'sidecar', 'skills', 'library'), fs, path);
const ALL_OBJECTS = ['computer', 'notebook', 'cabinet', 'dish', 'workbench', 'studio', 'jukebox', 'orchestrator', 'connector'];
const bySlug = {}; for (const s of LIB) bySlug[s.slug] = s;

// ---- A. the index: one line per offered recipe, no bodies ----
{
  const opts = { overrides: {}, placedTypes: [] };   // a fresh station: the default-on, no-gear recipes
  const offered = C.live(LIB, opts);
  A.eq(offered.map(s => s.slug).sort(), ['ascii-art', 'creative-ideation', 'decision-1-3-1', 'humanizer', 'plan'], 'a fresh station is offered the five default recipes');
  const idx = C.composeIndex(LIB, opts);
  A.ok(idx.indexOf('\n\n## INSTALLED SKILLS\n') === 0, 'the index keeps the INSTALLED SKILLS section header');
  A.ok(/FOLLOW its recipe instead of improvising/.test(idx), 'the original "follow the recipe" instruction is kept');
  A.ok(/load its full text with skill\.view/.test(idx) && /never work from the one-line summary alone/.test(idx), 'the index tells the model to load the recipe with skill.view before following it');
  for (const s of offered) {
    const line = '- ' + s.name + ' [library:' + s.slug + '] -- ' + s.description;
    A.ok(idx.indexOf(line + '\n') >= 0 || idx.endsWith(line), s.slug + ': indexed as name [library:slug] -- description');
    A.ok(idx.indexOf(s.body) < 0, s.slug + ': the body is NOT in the prompt');
    const mid = s.body.slice(Math.floor(s.body.length / 2), Math.floor(s.body.length / 2) + 60);
    A.ok(idx.indexOf(mid) < 0, s.slug + ': not even a fragment of the body is in the prompt');
  }
  const bodies = C.compose(LIB, opts);
  A.ok(idx.length * 5 < bodies.length, 'the index is a fraction of the inline bodies (' + idx.length + ' vs ' + bodies.length + ' chars)');
  A.eq(C.composeIndex(LIB, opts), idx, 'deterministic: same inputs, same bytes (rides the cached prefix)');
  A.eq(C.composeIndex(LIB, { overrides: { 'ascii-art': false, 'creative-ideation': false, 'decision-1-3-1': false, humanizer: false, plan: false }, placedTypes: [] }), '',
    'no offered recipe -> empty block (byte-identical to a skill-less prompt)');
  A.eq(C.composeIndex([], {}), '', 'empty library -> empty block');
}

// ---- B. a recipe with no description is indexed by its first meaningful sentence ----
{
  const bare = [{ slug: 'bare', name: 'Bare Recipe', description: '', requires: [], default: true,
    body: '# Bare Recipe\n\n**When to use:** whenever the thing happens. Then do more.\n\n1. step one' }];
  const idx = C.composeIndex(bare, {});
  A.ok(idx.indexOf('- Bare Recipe [library:bare] -- When to use: whenever the thing happens.') >= 0,
    'no description -> the first meaningful body sentence (heading/emphasis stripped) is the index line: ' + idx.split('\n').pop());
  A.eq(C.summaryOf({ description: '', body: '' }), '', 'an empty recipe yields an empty summary, not junk');
  A.ok(C.summaryOf({ description: 'x'.repeat(500), body: '' }).length <= 220, 'an overlong description is bounded');
}

// ---- C. same gating + order as the inline block ----
{
  const cases = [
    { overrides: {}, placedTypes: [] },
    { overrides: {}, placedTypes: ALL_OBJECTS },
    { overrides: { 'web-research': true, 'test-driven-development': true, humanizer: false }, placedTypes: ['dish'] },
    { overrides: { 'web-research': true, 'test-driven-development': true }, placedTypes: ['dish', 'workbench'] },
    { overrides: {}, placedTypes: ['cabinet'], agentSkills: ['spike', 'web-research'] },
    { overrides: {}, placedTypes: ['workbench', 'dish'], agentSkills: ['spike', 'web-research'] }
  ];
  for (const o of cases) {
    const offered = C.live(LIB, o).map(s => s.slug);
    const block = C.compose(LIB, o);
    const inline = C.live(LIB, o).filter(s => block.indexOf('### ' + s.name + (s.description ? ' -- ' + s.description : '') + '\n' + s.body) >= 0).map(s => s.slug);
    const indexed = (C.composeIndex(LIB, o).match(/\[library:[a-z0-9-]+\]/g) || []).map(h => h.slice(9, -1));
    A.eq(indexed, offered, 'the index lists every offered recipe, in compose order: ' + JSON.stringify(o));
    A.ok(inline.every(slug => indexed.indexOf(slug) >= 0), 'every recipe the inline block carried is indexed (nothing dropped): ' + JSON.stringify(o));
    A.eq(inline, offered.slice(0, inline.length), 'the inline block is the same list in the same order (only its budget tail differs): ' + JSON.stringify(o));
  }
  // class package first, exactly like compose
  const pkg = C.composeIndex(LIB, { overrides: {}, placedTypes: ['workbench', 'dish'], agentSkills: ['spike'] });
  A.ok(pkg.indexOf('[library:spike]') >= 0 && pkg.indexOf('[library:spike]') < pkg.indexOf('[library:plan]'), 'a class-package recipe is indexed before the global defaults');
  // budget: bounded, and the overflow is SAID, never silent
  const forceOn = {}; for (const s of LIB) forceOn[s.slug] = true;
  const tight = C.composeIndex(LIB, { overrides: forceOn, placedTypes: ALL_OBJECTS, budget: 1500 });
  A.ok(/more enabled skills were omitted here to keep the prompt lean/.test(tight), 'over budget -> the omission is stated');
  const full = C.composeIndex(LIB, { overrides: forceOn, placedTypes: ALL_OBJECTS });
  A.ok(full.length <= 12000 + 800, 'even the whole library force-enabled stays within the old 12K ceiling (+ header): ' + full.length);
}

// ---- D/E. find() + viewText(): the exact body, only for offered recipes ----
{
  const offered = C.live(LIB, { overrides: { 'web-research': true }, placedTypes: ['dish', 'cabinet'] });
  const plan = bySlug.plan;
  A.eq(C.find(offered, 'library:plan'), plan, 'library:<slug> resolves');
  A.eq(C.find(offered, 'LIBRARY:Plan'), plan, 'case-insensitive');
  A.eq(C.find(offered, 'plan'), plan, 'a bare slug resolves');
  A.eq(C.find(offered, 'Make a Plan'), plan, 'the display name resolves');
  A.eq(C.find(offered, 'library:web-research'), bySlug['web-research'], 'a gear-gated recipe resolves once its gear is placed and it is enabled');
  A.eq(C.find(offered, 'library:test-driven-development'), null, 'a recipe NOT offered this run (disabled + gear absent) is not served');
  A.eq(C.find(C.live(LIB, { overrides: { plan: false }, placedTypes: [] }), 'library:plan'), null, 'a recipe the Commander DISABLED is not served');
  A.eq(C.find(offered, 'library:'), null, 'an empty library name is not a match');
  A.eq(C.find(offered, ''), null, 'no name, no recipe');
  const text = C.viewText(plan);
  A.ok(text.endsWith('\n\n' + plan.body), 'viewText ends with the EXACT body');
  A.ok(text.indexOf('# ' + plan.name + ' [library:plan]\n' + plan.description + '\n') === 0, 'viewText leads with the name, load name and description');
}

// ---- F. skill.view: bundled recipes served; agent skills byte-identical ----
function memIo() { const lines = []; return { readAll() { return lines.slice(); }, append(e) { lines.push(e); } }; }
function makeStore() {
  const s = makeSkillStore({ stageReviews: false, io: memIo(), clock: { now: () => 1000 } });
  s.write({ agentId: 'a', name: 'Deploy the site', summary: 'build, test, push', body: '1. npm ci\n2. npm test\n3. npm run deploy' });
  // an agent skill that SHARES a recipe's display name: the agent's own must keep winning
  s.write({ agentId: 'a', name: 'Make a Plan', summary: 'my own planning ritual', body: 'AGENT-OWNED PLAN BODY' });
  return s;
}
{
  const offered = C.live(LIB, { overrides: {}, placedTypes: [] });
  const resolver = (name) => { const r = C.find(offered, name); return r ? { name: r.name, content: C.viewText(r) } : null; };
  const viewed = [];
  const withLib = makeSkillTools({ store: makeStore(), bundled: resolver, onView: (s) => viewed.push(s && s.name), readBeforeWrite: true });
  const without = makeSkillTools({ store: makeStore(), onView: () => {} });
  const ctx = { agentId: 'a' };

  const r = withLib.viewTool.run({ name: 'library:plan' }, ctx);
  A.eq(r.content, C.viewText(bySlug.plan), 'skill.view library:plan returns the recipe');
  A.ok(r.content.indexOf(bySlug.plan.body) >= 0, 'with the EXACT full body the inline block used to carry');
  A.eq(r.summary, 'loaded Make a Plan', 'summary names the recipe');
  A.eq(withLib.viewTool.run({ name: 'humanizer' }, ctx).content, C.viewText(bySlug.humanizer), 'a bare slug loads the recipe too');
  A.eq(viewed.length, 0, 'a recipe view never reaches onView (it is not an agent skill the review passes may rewrite)');
  const edit = withLib.manageTool.run({ action: 'patch', target: 'Deploy the site', find: 'npm ci', replace: 'npm install' }, ctx);
  A.ok(/have not read/.test(edit.content), 'viewing a recipe earns no read-before-write credit for an agent skill');

  for (const name of ['Deploy the site', 'deploy the site', 'deploy-the-site', 'Make a Plan', 'ghost', 'library:ghost', '']) {
    const a = withLib.viewTool.run({ name }, ctx);
    const b = without.viewTool.run({ name }, ctx);
    A.eq(a, b, 'agent-authored skill.view is byte-identical with the bundled resolver wired: "' + name + '"');
  }
  A.ok(/AGENT-OWNED PLAN BODY/.test(withLib.viewTool.run({ name: 'Make a Plan' }, ctx).content), 'an agent skill named like a recipe still loads the AGENT\'s body');
  A.ok(/library:plan|installed recipe/.test(withLib.viewTool.description), 'with recipes wired, skill.view says it loads installed recipes');
  A.eq(without.viewTool.description, 'Load the full step-by-step body of one saved skill by name or id. Call this whenever a saved skill may apply.',
    'without the resolver (review/curator forks) the tool description is unchanged');
  A.ok(/No skill named "library:test-driven-development"/.test(withLib.viewTool.run({ name: 'library:test-driven-development' }, ctx).content),
    'a recipe this run was not offered answers with the ordinary not-found message');
}

// ---- G. the prompt seam: index only where skill.view is on the wire; bodies inline otherwise ----
{
  const idx = readSidecarSource();
  const once = (needle, label) => A.eq(idx.split(needle).length - 1, 1, label + ' (exactly one occurrence)');
  once("? (coreNames.indexOf('skill.view') >= 0\n        ? skillsCatalog.composeIndex(skillLibrary(), recipeOpts)\n        : skillsCatalog.compose(skillLibrary(), recipeOpts))",
    'index.js composes the recipe INDEX only when skill.view is advertised on this run, else the bodies stay inline');
  once('if (isTask) runRecipes = skillsCatalog.live(skillLibrary(), recipeOpts);', 'the run records exactly the recipes its prompt offered');
  once('const recipe = skillsCatalog.find(runRecipes, name);', 'the per-run skill.view resolves recipes against that same list');
  const seam = idx.slice(idx.indexOf('const sRoom = station.rooms'), idx.indexOf('const sRoom = station.rooms') + 2600);
  A.ok(/skillBlock = isTask/.test(seam), 'the recipe block stays gated on isTask (chat diet)');
}

A.report('skills.on-demand.test');
