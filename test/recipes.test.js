/* node test/recipes.test.js — the Recipe / Mission library (frontend/app/recipes.js).
   Locks the catalog's integrity (every built-in is well-formed, deep-frozen, ids unique), that the param
   form is sane (declared params, no dangling {tokens}), that fillTask() — THE launch primitive — substitutes
   params, honors optional defaults, tidies blank substitutions, and leaves a recipe untouched it doesn't own;
   that requiredMissing() gates launch honestly; that every filled recipe READS AS A REAL TASK DIRECTIVE (so it
   actually launches work) and carries ranking tags consistent with what the app's own classifier tags it as;
   and that the custom (save-your-own) round-trip behaves — including a built-in-id collision. Runs under node
   with no DOM and no localStorage, so the custom store lives in-memory here (the browser persists it). */
'use strict';
const A = require('./_assert.js');
const R = require('../frontend/app/recipes.js');
const C = require('../frontend/app/classify.js');   // the same task/tag classifier the live app uses
// Exercise the production selection reconciler: filters must not leave a launch
// button attached to an unrelated, hidden recipe.
const marketSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/app/marketplace.js'), 'utf8');
const selectionSource = marketSource.match(/function syncRecipeFocus\(\) \{[\s\S]*?\n  \}/)[0];
const selectRecipe = new Function('Recipes', 'filtRecipes', 'focusRecipe', 'query', 'catFilter', selectionSource + '; syncRecipeFocus(); return focusRecipe;');
A.eq(selectRecipe(R, rows => rows.filter(r => r.category === 'money'), 'travel-plan', '', 'money'), 'budget-build', 'category switch selects a visible recipe');
A.eq(selectRecipe(R, () => [], 'travel-plan', 'no-match', 'all'), null, 'empty search clears the launch target');
A.eq(selectRecipe(R, rows => rows.filter(r => r.category === 'money'), 'receipt-ledger', '', 'money'), 'receipt-ledger', 'a matching selection stays selected');
A.eq(selectRecipe(R, rows => rows, 'claim-fact-check', '', 'all'), 'claim-fact-check', 'explicit legacy deep links remain launchable');

/* ---------- catalog integrity ---------- */
const builtins = R.builtins();
// The public selection stays small and diverse; saved legacy ids remain usable.
A.eq(builtins.length, 45, 'public recipe library contains 45 starting points');
A.eq(builtins.filter(r => R.railBucket(r) === 'developer').length, 5, 'coding is five of the 45 workflows');
A.ok(R.RAIL_BUCKETS.every(bucket => builtins.filter(r => R.railBucket(r) === bucket).length >= 5), 'every category has at least five workflows');
A.ok(builtins.every(r => r.steps.length === 3 && r.name.length <= 28 && r.blurb.length <= 160), 'each public workflow has a short name, description, and three steps');
const archivedRecipe = R.get('claim-fact-check');
A.ok(archivedRecipe && archivedRecipe.archived && R.fillTask(archivedRecipe, { claim: 'sample claim' }).includes('sample claim'), 'retired recipe ids still fill and launch');
A.ok(!R.list().some(r => r.id === 'claim-fact-check'), 'retired recipes stay out of the public library and recommendation pool');
for (const recipe of builtins) {
  const supplied = Object.fromEntries(recipe.params.map(p => [p.key, p.default || ('sample ' + p.key)]));
  A.eq(R.requiredMissing(recipe, supplied), [], recipe.id + ' accepts its declared inputs');
  A.ok(!/\{\w+\}/.test(R.fillTask(recipe, supplied)), recipe.id + ' sends a complete workflow without unfilled tokens');
}
A.ok(builtins.length >= 8, 'catalog ships a real library (>= 8 recipes), got ' + builtins.length);

const seen = {};
for (const b of builtins) {
  A.ok(!seen[b.id], 'built-in id is unique: ' + b.id);
  seen[b.id] = true;
  A.ok(typeof b.id === 'string' && b.id.length > 0, 'has id');
  A.ok(typeof b.name === 'string' && b.name.length > 0, b.id + ' has a name');
  A.ok(typeof b.emoji === 'string' && b.emoji.length > 0, b.id + ' has an emoji');
  A.ok(typeof b.tagline === 'string' && b.tagline.length > 0, b.id + ' has a tagline');
  A.ok(typeof b.blurb === 'string' && b.blurb.length > 0, b.id + ' has a blurb');
  A.ok(typeof b.accent === 'string' && b.accent.length > 0, b.id + ' has an accent color');
  A.ok(typeof b.task === 'string' && b.task.length > 20, b.id + ' has a real directive template');
  A.eq(b.custom, false, b.id + ' is a built-in (custom=false)');

  // ranking tags: the recommender's fuel — at least one positive weight over the known lanes, frozen.
  A.ok(b.tags && typeof b.tags === 'object', b.id + ' carries ranking tags');
  const tagKeys = Object.keys(b.tags);
  A.ok(tagKeys.length >= 1, b.id + ' has at least one interest lane');
  A.ok(tagKeys.every(k => R.TAGS.indexOf(k) >= 0), b.id + ' tags use only the known lanes');
  A.ok(tagKeys.every(k => b.tags[k] > 0), b.id + ' tag weights are all positive');
  A.throws(() => { b.tags.general = 9; }, b.id + ' tags are frozen (catalog is immutable)');

  // params: a frozen array of frozen {key,label,...} descriptors with unique keys.
  A.ok(Array.isArray(b.params), b.id + ' params is an array');
  A.throws(() => { b.params.push({ key: 'x' }); }, b.id + ' params array is frozen');
  const pkeys = {};
  for (const p of b.params) {
    A.ok(typeof p.key === 'string' && p.key.length > 0, b.id + ' param has a key');
    A.ok(typeof p.label === 'string' && p.label.length > 0, b.id + ' param ' + p.key + ' has a label');
    A.ok(typeof p.required === 'boolean', b.id + ' param ' + p.key + ' has a required flag');
    A.ok(!pkeys[p.key], b.id + ' param keys are unique: ' + p.key);
    pkeys[p.key] = true;
    A.throws(() => { p.required = !p.required; }, b.id + ' param ' + p.key + ' is frozen');
  }

  // no DANGLING tokens: every {token} in the template is a declared param (else fillTask can't resolve it).
  const tokens = (b.task.match(/\{(\w+)\}/g) || []).map(t => t.slice(1, -1));
  for (const tok of tokens) A.ok(pkeys[tok], b.id + ' template token {' + tok + '} is a declared param');
}

/* built-ins are frozen — a stray mutation must not poison the shared catalog */
A.throws(() => { builtins[0].name = 'hacked'; }, 'a built-in recipe is frozen');

/* ---------- fillTask(): THE launch primitive ---------- */
A.eq(R.fillTask('no-such-recipe', {}), null, 'fillTask of an unknown id is null');

// substitutes a required param; the value lands and the token is gone
const fb = R.fillTask('fix-bug', { error: 'the login screen crashes on submit' });
A.ok(fb.indexOf('the login screen crashes on submit') >= 0, 'fillTask substitutes the param value');
A.ok(fb.indexOf('{error}') < 0, 'fillTask leaves no unresolved token for a filled param');

// accepts a recipe OBJECT too, not just an id
const fb2 = R.fillTask(R.get('fix-bug'), { error: 'X' });
A.ok(fb2.indexOf('X') >= 0, 'fillTask accepts a recipe object, not just an id');

// an optional param left blank falls back to its DEFAULT (morning-brief.window default = "the last 24 hours")
const mb = R.fillTask('morning-brief', { topic: 'AI agents' });
A.ok(mb.indexOf('the last 24 hours') >= 0, 'a blank optional param uses its default');
A.ok(mb.indexOf('{window}') < 0 && mb.indexOf('{topic}') < 0, 'no tokens survive when defaults cover the blanks');

// a clean single-line prose recipe stays clean (no stray double spaces / space-before-punctuation)
A.ok(mb.split('\n\nProcedure')[0].split('\n\nDecisions')[0].split('\n').every(line => !/\s{2,}/.test(line) && !/\s[.,;:!?]/.test(line)), 'filled prose reads clean before the structured workflow');

// CRITICAL: a filled value is inserted VERBATIM — pasted code / logs / indentation / aligned text must survive
// untouched, because the agent has to run exactly what the Commander supplied (not a whitespace-flattened version).
const code = 'def f():\n    return  1   # 4-space indent + intentional double spaces';
A.ok(R.fillTask('summarize', { content: code }).indexOf(code) >= 0, 'fillTask preserves multi-line / indented / multi-space pasted content verbatim');
const trace = '  at foo (a.js:1)\n  at bar (b.js:2)';
A.ok(R.fillTask('fix-bug', { error: trace }).indexOf(trace) >= 0, 'fillTask preserves a pasted stack trace (leading indent on every line)');

// a defaultless optional left blank drops cleanly — the seam space the gone token leaves is closed (template-only)
const optRec = R.saveCustom({ name: 'Opt', task: 'Do {a} now.', params: [{ key: 'a', required: false }] });
A.eq(R.fillTask(optRec.id, {}), 'Do now.', 'a blank defaultless optional closes its seam (no doubled space)');
R.removeCustom(optRec.id);

// a token the recipe does NOT declare is left untouched (author-error safe, never crashes)
const dangling = R.saveCustom({ name: 'Dangler', task: 'Do {thing} with {undeclared}.', params: [{ key: 'thing' }] });
const dfill = R.fillTask(dangling.id, { thing: 'it' });
A.ok(dfill.indexOf('Do it with {undeclared}.') >= 0, 'an undeclared token is left as-is');
R.removeCustom(dangling.id);

/* every built-in, filled with sample values, must READ AS A REAL TASK DIRECTIVE (so it launches work, not
   chatter) AND carry a ranking lane consistent with what the app's own classifier tags the filled task as. */
for (const b of builtins) {
  const vals = {};
  b.params.forEach(p => { if (p.required) vals[p.key] = 'something concrete to work on'; });
  const filled = R.fillTask(b.id, vals);
  A.ok(filled && filled.length > 0, b.id + ' produces a non-empty directive');
  A.ok(!/\{\w+\}/.test(filled), b.id + ' leaves no unresolved tokens once required params are filled');
  A.ok(C.isTaskDirective(filled), b.id + ' filled task reads as a real task directive (launches work)');
  const tag = C.getTag(filled);
  A.ok((b.tags[tag] || 0) > 0, b.id + ' ranking tags honestly include the lane the task classifies as (' + tag + ')');
}

/* ---------- requiredMissing(): the launch gate ---------- */
A.eq(R.requiredMissing('no-such-recipe', {}).length, 0, 'requiredMissing of an unknown id is empty');
A.eq(R.requiredMissing('fix-bug', {}), ['error'], 'a required param with no value is reported missing');
A.eq(R.requiredMissing('fix-bug', { error: 'boom' }).length, 0, 'a filled required param is not missing');
A.eq(R.requiredMissing('fix-bug', { error: '   ' }), ['error'], 'a whitespace-only value still counts as missing');
// an OPTIONAL param left blank is NOT missing (it has a default) — only required-and-blank blocks launch
A.eq(R.requiredMissing('morning-brief', { topic: 'x' }).length, 0, 'a blank optional param does not block launch');
A.eq(R.requiredMissing('morning-brief', {}), ['topic'], 'only the required param blocks, not the optional one');

/* ---------- custom (save-your-own) round-trip ---------- */
A.eq(R.customs().length, 0, 'no customs at first (node has no localStorage)');
const saved = R.saveCustom({ name: 'Nightly Standup', emoji: '🌙', tagline: 'end-of-day rollup', task: 'Summarize what shipped today and what is blocked.', params: [] });
A.ok(saved.id.indexOf('custom-recipe-') === 0, 'a saved mission id is namespaced custom-recipe- (never collides with a custom specialty): ' + saved.id);
A.eq(saved.custom, true, 'a saved custom is flagged custom=true');
A.ok(saved.tags && Object.keys(saved.tags).length >= 1, 'a saved custom carries ranking tags (classified in-browser; general fallback under node)');
A.ok(Array.isArray(saved.params), 'a saved custom carries a params array');
A.ok(R.exists(saved.id), 'the custom is now in the registry');
A.eq(R.customs().length, 1, 'exactly one custom after one save');
A.eq(R.list().length, builtins.length + 1, 'list() = built-ins + customs');

// a custom is launchable through the same fillTask primitive
A.ok(R.fillTask(saved.id, {}).indexOf('Summarize what shipped today') >= 0, 'a custom recipe fills like a built-in');

// editing the same id upserts (no duplicate)
const edited = R.saveCustom(Object.assign({}, saved, { tagline: 'changed' }));
A.eq(edited.id, saved.id, 'editing keeps the same id');
A.eq(R.customs().length, 1, 'upsert does not duplicate');
A.eq(R.get(saved.id).tagline, 'changed', 'the edit persisted');

// a missing name is rejected
A.throws(() => R.saveCustom({ name: '' }), 'a nameless recipe is rejected');

// id collision against a BUILT-IN must not clobber it — saving a custom literally named like a built-in id
const clash = R.saveCustom({ name: 'Fix Bug', task: 'mine', params: [] });
A.ok(clash.id !== 'fix-bug', 'a custom never steals a built-in id (' + clash.id + ' != fix-bug)');
A.eq(R.get('fix-bug').custom, false, 'the built-in Fix a Bug is untouched');

// remove
A.eq(R.removeCustom(saved.id), true, 'removeCustom returns true when it removed one');
A.ok(!R.exists(saved.id), 'the removed custom is gone');
A.eq(R.removeCustom('nope'), false, 'removeCustom returns false for an unknown id');
R.removeCustom(clash.id);   // tidy up the collision custom too

/* ---------- paramsFromTemplate(): authoring derives the input form from the task template ---------- */
A.eq(R.paramsFromTemplate('a fixed mission with no tokens').length, 0, 'a template with no tokens yields a one-tap mission (no params)');
const pp = R.paramsFromTemplate('Brief me on {topic} since {look_back} — more on {topic}');
A.eq(pp.length, 2, 'distinct tokens become params (duplicates collapsed)');
A.eq(pp.map(p => p.key), ['topic', 'look_back'], 'params follow first-seen token order, de-duplicated');
A.eq(pp[1].label, 'Look Back', 'a snake_case token gets a humanized Title-Case label');
A.ok(pp.every(p => p.required), 'authored template params are required by default');

// humanize handles acronym boundaries and NEVER yields a blank or indistinguishable label (review hardening)
A.eq(R.paramsFromTemplate('Check {HTTPStatus}')[0].label, 'HTTP Status', 'humanize splits an acronym boundary (HTTPStatus -> HTTP Status)');
A.eq(R.paramsFromTemplate('Do {_} now.')[0].label, '_', 'a token that humanizes to empty falls back to the raw key (never a blank launch field)');
const dupL = R.paramsFromTemplate('{look_back} vs {lookBack}');
A.eq(dupL.length, 2, 'snake and camel variants are distinct params (de-duped by key, not label)');
A.ok(dupL[0].label !== dupL[1].label, 'two tokens that would collapse to the same label are disambiguated');
A.ok(dupL[0].label.indexOf('look_back') >= 0 && dupL[1].label.indexOf('lookBack') >= 0, 'the disambiguator appends the raw key');
const caseL = R.paramsFromTemplate('Compare {topic} vs {Topic}.');
A.ok(caseL[0].label !== caseL[1].label, 'case-variant tokens ({topic} vs {Topic}) get distinguishable labels');

// auto-derive is driven by the NORMALIZED params: a keyless/garbage params array still falls through to derivation
// (a hand-edited / corrupted import can't produce an ungated mission that ships a literal {token})
const garbage = R.saveCustom({ name: 'Garbage In', task: 'Do {x} please.', params: [{ label: 'no key here' }] });
A.eq(garbage.params.map(p => p.key), ['x'], 'a keyless params array does not suppress template derivation');
A.eq(R.requiredMissing(garbage.id, {}), ['x'], 'the re-derived param still gates launch (no ungated {tokens})');
A.ok(R.fillTask(garbage.id, { x: 'it' }).indexOf('Do it please.') >= 0, 'the re-derived mission fills correctly');
R.removeCustom(garbage.id);

// an authored custom (only name + task template) gets its params auto-derived and launches like a built-in
const authored = R.saveCustom({ name: 'Standup', task: 'Summarize {project} progress and flag blockers.' });
A.eq(authored.params.map(p => p.key), ['project'], 'a saved custom auto-derives its params from the template');
A.eq(R.requiredMissing(authored.id, {}), ['project'], 'the derived param gates launch');
A.ok(R.fillTask(authored.id, { project: 'StarNet' }).indexOf('Summarize StarNet progress') >= 0, 'the authored custom fills + launches via the same primitive');
R.removeCustom(authored.id);

// explicit params still win over derivation (back-compat for an imported custom that supplies its own)
const explicit = R.saveCustom({ name: 'Explicit', task: 'Do {x}.', params: [{ key: 'x', label: 'The X', required: false, default: 'nothing' }] });
A.eq(explicit.params[0].label, 'The X', 'explicit params override template derivation');
A.eq(explicit.params[0].required, false, 'explicit optional flag is honored over the required-by-default derivation');
A.eq(R.fillTask(explicit.id, {}), 'Do nothing.', 'an explicit optional default fills when blank');
R.removeCustom(explicit.id);

/* ---------- draft(): the P3 "save what you keep asking for" seam ---------- */
const d = R.draft({ name: 'My Mission', task: 'Do the thing.' });
A.eq(d.name, 'My Mission', 'draft honors a provided name');
A.eq(d.task, 'Do the thing.', 'draft carries the task');
A.ok(Array.isArray(d.params), 'draft has a params array');

/* ---------- R1: schema v2 — gear / skills / cadence / category / source / forkedFrom ---------- */
// every built-in carries the v2 fields, normalized + frozen. gear/skills are frozen arrays of known values;
// cadence is a valid id or null; category is one of the known buckets; source is 'builtin'; forkedFrom is null.
for (const b of builtins) {
  A.ok(Array.isArray(b.gear), b.id + ' has a gear array');
  A.ok(b.gear.every(g => R.GEAR_TYPES.indexOf(g) >= 0), b.id + ' gear entries are known capability objectTypes');
  A.throws(() => { b.gear.push('dish'); }, b.id + ' gear array is frozen');
  A.ok(Array.isArray(b.skills), b.id + ' has a skills array');
  A.ok(b.cadence === null || R.CADENCES.indexOf(b.cadence) >= 0, b.id + ' cadence is a valid id or null');
  A.ok(R.CATEGORIES.indexOf(b.category) >= 0, b.id + ' category is a known browse bucket');
  A.eq(b.source, 'builtin', b.id + ' source is builtin');
  A.eq(b.forkedFrom, null, b.id + ' forkedFrom is null (a built-in is not a fork)');
}
// the honest values the plan calls out: morning-brief draws on the WEB (dish), suggests 'morning', browses under research.
const mbr = R.get('morning-brief');
A.ok(mbr.gear.indexOf('dish') >= 0, 'morning-brief gear includes dish (the WEB)');
A.eq(mbr.cadence, 'morning', 'morning-brief suggests the morning cadence');
A.eq(mbr.category, 'research', 'morning-brief browses under research');
// a code recipe wants FILES; deep-research is one-shot by nature (no suggested cadence).
A.ok(R.get('code-review').gear.indexOf('cabinet') >= 0, 'code-review gear includes cabinet (FILES)');
A.eq(R.get('deep-research').cadence, null, 'deep-research is one-shot by nature (no cadence)');

// gear normalization drops unknown/garbage objectTypes; a hand-authored custom keeps only real caps.
const geared = R.saveCustom({ name: 'Geared', task: 'Do {x}.', gear: ['dish', 'bogus', 'cabinet', 'dish'] });
A.eq(geared.gear, ['dish', 'cabinet'], 'gear drops unknown types and de-dups (dish, cabinet)');
A.eq(geared.source, 'custom', 'a hand-authored save defaults to source:custom');
A.eq(geared.forkedFrom, null, 'a hand-authored save has no forkedFrom');
R.removeCustom(geared.id);

// a custom with no explicit category derives one from its dominant lane (a code-tagged task → code bucket).
const codey = R.saveCustom({ name: 'Codey', task: 'Fix the bug in {file} and verify the code compiles.' });
A.ok(['code', 'research', 'general'].indexOf(codey.category) >= 0, 'a categoryless custom derives a browse bucket from its tags: ' + codey.category);
R.removeCustom(codey.id);

// an explicit cadence/category on a custom is honored (and validated).
const routiney = R.saveCustom({ name: 'Routiney', task: 'Brief me on {topic}.', cadence: 'morning', category: 'research' });
A.eq(routiney.cadence, 'morning', 'an explicit valid cadence is kept');
A.eq(routiney.category, 'research', 'an explicit valid category is kept');
const badcad = R.saveCustom({ name: 'BadCad', task: 'Do {x}.', cadence: 'yearly', category: 'nonsense' });
A.eq(badcad.cadence, null, 'an unknown cadence id normalizes to null (never an unschedulable id)');
A.eq(badcad.category, 'general', 'an unknown category normalizes to the general bucket');
R.removeCustom(routiney.id); R.removeCustom(badcad.id);

/* ---------- R2: forkFrom() — TWEAK mints a fork prefilled from any recipe, original untouched ---------- */
A.eq(R.forkFrom('no-such-recipe'), null, 'forkFrom of an unknown id is null');
const forkDraft = R.forkFrom('morning-brief');
A.ok(forkDraft && forkDraft.source === 'fork', 'forkFrom stamps source:fork');
A.eq(forkDraft.forkedFrom, 'morning-brief', 'forkFrom records the parent id');
A.ok(forkDraft.task === mbr.task, 'the fork copies the parent task template verbatim');
A.ok(Array.isArray(forkDraft.gear) && forkDraft.gear.indexOf('dish') >= 0, 'the fork copies the parent gear');
A.eq(forkDraft.cadence, 'morning', 'the fork copies the parent suggested cadence');
A.ok(!forkDraft.id, 'a fork draft has no id (saveCustom mints a fresh one — the original is never overwritten)');
// saving the fork mints a NEW custom and leaves the built-in intact.
const savedFork = R.saveCustom(forkDraft);
A.ok(savedFork.id.indexOf('custom-recipe-') === 0, 'a saved fork gets a fresh custom id: ' + savedFork.id);
A.eq(savedFork.source, 'fork', 'a saved fork keeps source:fork');
A.eq(savedFork.forkedFrom, 'morning-brief', 'a saved fork keeps its parent id');
A.eq(R.get('morning-brief').custom, false, 'the forked built-in is untouched (still a built-in)');
A.ok(R.fillTask(savedFork.id, { topic: 'X' }).length > 0, 'the fork launches through the same fillTask primitive');
R.removeCustom(savedFork.id);

/* ---------- R3: impliesOutbound() — the soft unattended-run warning heuristic ---------- */
A.ok(R.impliesOutbound('draft-reply'), 'draft-reply implies outbound (it drafts a reply)');
A.ok(!R.impliesOutbound('summarize'), 'summarize does not imply an outbound action');
A.ok(!R.impliesOutbound('no-such-recipe'), 'impliesOutbound of an unknown id is false');
const sendy = R.saveCustom({ name: 'Sendy', task: 'Post the update to the channel every morning.' });
A.ok(R.impliesOutbound(sendy.id), 'a task that says "post" implies outbound');
R.removeCustom(sendy.id);

/* ---------- R5: mintFromRun() — bottle a completed run's directive into a draft custom recipe ---------- */
// an empty / whitespace directive has nothing honest to bottle.
A.eq(R.mintFromRun(''), null, 'mintFromRun of an empty directive is null');
A.eq(R.mintFromRun('   \n  '), null, 'mintFromRun of whitespace-only is null');

// a plain directive with NO parameter candidates → a faithful one-tap recipe (task verbatim, zero params).
const plain = R.mintFromRun('Summarize my open pull requests and flag the risky ones.', { runId: 'run-1' });
A.ok(plain, 'mintFromRun returns a draft for a real directive');
A.eq(plain.source, 'custom', 'a bottled draft is provenance custom');
A.eq(plain.sourceRunId, 'run-1', 'the draft carries the run it was bottled from');
A.eq(plain.params.length, 0, 'a directive with no quoted strings / URLs yields a one-tap recipe (zero params)');
A.eq(plain.task, 'Summarize my open pull requests and flag the risky ones.', 'the task is the directive verbatim when no candidates are found');
A.ok(!plain.id && plain.custom !== true, 'the draft is unsaved (no id, custom not set — the editor confirm saves it)');
A.ok(/^[A-Z]/.test(plain.name) && plain.name.length > 0, 'a name is derived (Title-Cased): ' + plain.name);

// a quoted string becomes a {topic} fill-in; the raw value rides along as the placeholder (a concrete example).
const quoted = R.mintFromRun('Research "quantum computing" and write me a brief.', { runId: 'run-2' });
A.eq(quoted.params.length, 1, 'one quoted string → one param');
A.eq(quoted.params[0].key, 'topic', 'the first quoted candidate keys as topic');
A.eq(quoted.params[0].placeholder, 'quantum computing', 'the param placeholder is the value the user actually typed');
A.ok(quoted.task.indexOf('{topic}') >= 0, 'the quoted value is wrapped in a {topic} token in the task template');
A.ok(quoted.task.indexOf('"quantum computing"') < 0, 'the literal quoted value no longer appears (it became a token)');
// the wrapped token round-trips through fillTask (the derived param actually drives the launch).
const qSaved = R.saveCustom(quoted);
A.eq(R.fillTask(qSaved.id, { topic: 'gene editing' }), 'Research gene editing and write me a brief.', 'the bottled recipe fills its derived {topic} param on launch');
A.eq(R.get(qSaved.id).sourceRunId, 'run-2', 'a saved bottled recipe persists its sourceRunId');
R.removeCustom(qSaved.id);

// a URL becomes a {url} fill-in.
const urly = R.mintFromRun('Watch https://example.com/feed and ping me on changes.', { runId: 'run-3' });
A.eq(urly.params.length, 1, 'one URL → one param');
A.eq(urly.params[0].key, 'url', 'a bare URL keys as url');
A.eq(urly.params[0].placeholder, 'https://example.com/feed', 'the URL param placeholder is the real URL');
A.ok(urly.task.indexOf('{url}') >= 0, 'the URL is wrapped in a {url} token');

// multiple distinct candidates → distinct keys (topic, topic2, url); a repeated value reuses its first token.
const multi = R.mintFromRun('Compare "alpha" with "beta", then also brief me on "alpha" from https://x.io/a.', { runId: 'run-4' });
const keys = multi.params.map(p => p.key);
A.eq(keys, ['topic', 'topic2', 'url'], 'distinct candidates get distinct keys; a repeated value reuses its first token: ' + JSON.stringify(keys));
A.eq((multi.task.match(/\{topic\}/g) || []).length, 2, 'the repeated "alpha" reuses the SAME {topic} token both times');

// a leading stopword is trimmed off the derived name (concrete headline, not "Please…").
const named = R.mintFromRun('Please review the auth module for security bugs.', { runId: 'run-5' });
A.ok(/^Review/i.test(named.name), 'the derived name trims a leading stopword ("Please"): ' + named.name);

/* ---------- R6: marketplace surface — export / import / ranking ---------- */

/* categories: the R4 persona catalog (developer/creator/ops) MUST survive normalization as real buckets so the
   discovery rail can group them — not silently collapse to 'general'. */
for (const c of ['developer', 'research', 'creator', 'ops', 'general']) A.ok(R.CATEGORIES.indexOf(c) >= 0, 'the rail bucket "' + c + '" is a known category');
const catCounts = {};
R.builtins().forEach(r => { catCounts[r.category] = (catCounts[r.category] || 0) + 1; });
A.ok((catCounts.developer || 0) > 0, 'developer recipes keep their bucket (not collapsed to general): ' + (catCounts.developer || 0));
A.ok((catCounts.creator || 0) > 0, 'creator recipes keep their bucket: ' + (catCounts.creator || 0));
A.ok((catCounts.ops || 0) > 0, 'ops recipes keep their bucket: ' + (catCounts.ops || 0));

/* exportRecipe(): a portable, format-marked, deep-copied object carrying only the authoring surface. */
A.eq(R.exportRecipe('no-such-recipe'), null, 'exportRecipe of an unknown id is null');
const exp = R.exportRecipe('morning-brief');
A.eq(exp.starnetRecipe, R.EXPORT_FORMAT, 'an exported recipe carries the format marker (starnetRecipe)');
A.eq(exp.name, R.get('morning-brief').name, 'the export carries the recipe name');
A.eq(exp.task, R.get('morning-brief').task, 'the export carries the task template verbatim');
A.eq(exp.category, 'research', 'the export carries the browse category');
A.ok(!('custom' in exp), 'the export omits the runtime `custom` flag (not part of the portable unit)');
A.ok(!('seedborn' in exp), 'the export omits local-only provenance (seedborn)');
A.ok(Array.isArray(exp.params) && !Object.isFrozen(exp.params), 'the export params are a plain (unfrozen) copy');
A.ok(JSON.stringify(exp).length > 0, 'the export is JSON-serializable');

/* export → import round-trip: importing an exported recipe yields an EQUIVALENT, runnable custom (fresh id). */
const imp = R.importRecipe(exp);
A.ok(imp.ok, 'importing an exported recipe succeeds');
A.ok(imp.recipe.id.indexOf('custom-recipe-') === 0, 'an imported recipe mints a fresh custom-recipe- id: ' + imp.recipe.id);
A.ok(imp.recipe.id !== 'morning-brief', 'the import never reuses (or overwrites) the origin id');
A.eq(imp.recipe.custom, true, 'an imported recipe is a custom (always yours)');
A.eq(imp.recipe.source, 'fork', 'an imported recipe with an origin id is stamped a fork of it');
A.eq(imp.recipe.forkedFrom, 'morning-brief', 'the import records the origin id as provenance');
A.eq(R.get('morning-brief').custom, false, 'the origin built-in is untouched by the import');
// runnable + equivalent: same filled directive as the original for the same inputs
const origFilled = R.fillTask('morning-brief', { topic: 'X' });
const impFilled = R.fillTask(imp.recipe.id, { topic: 'X' });
A.eq(impFilled, origFilled, 'the imported recipe fills to the SAME directive as the original (equivalent + runnable)');
A.eq(imp.recipe.gear.join(','), R.get('morning-brief').gear.join(','), 'the import preserves the gear list');
A.eq(imp.recipe.cadence, 'morning', 'the import preserves the suggested cadence');
R.removeCustom(imp.recipe.id);

/* validateImport(): the trust boundary — rejects malformed, sanitizes, never produces an ungated recipe. */
A.eq(R.validateImport(null).ok, false, 'validateImport rejects null');
A.eq(R.validateImport('nope').ok, false, 'validateImport rejects a non-object');
A.eq(R.validateImport([]).ok, false, 'validateImport rejects an array');
A.eq(R.validateImport({ task: 'do it' }).ok, false, 'validateImport rejects a nameless file');
A.eq(R.validateImport({ name: 'X' }).ok, false, 'validateImport rejects a file with no task');
// unknown fields are stripped; only known authoring fields survive
const dirty = R.validateImport({ name: 'Dirty', task: 'Do {x}.', evil: 'rm -rf', __proto__: { polluted: 1 }, gear: ['dish', 'bogus'], cadence: 'yearly', category: 'nonsense' });
A.ok(dirty.ok, 'a well-shaped (if dirty) file validates');
A.ok(!('evil' in dirty.recipe), 'an unknown field is stripped from the sanitized draft');
// import it and confirm the normalizers ran (garbage gear/cadence/category dropped, params derived, gated)
const dimp = R.importRecipe({ name: 'Dirty', task: 'Do {x}.', evil: 'rm -rf', gear: ['dish', 'bogus'], cadence: 'yearly', category: 'nonsense' });
A.ok(dimp.ok, 'the dirty-but-valid file imports');
A.eq(dimp.recipe.gear.join(','), 'dish', 'import drops unknown gear types (bogus removed)');
A.eq(dimp.recipe.cadence, null, 'import normalizes an unknown cadence to null (never unschedulable)');
A.eq(dimp.recipe.category, 'general', 'import normalizes an unknown category to general');
A.eq(R.requiredMissing(dimp.recipe.id, {}).join(','), 'x', 'a malformed file can NEVER produce an ungated recipe — the {x} token still gates launch');
A.ok(R.fillTask(dimp.recipe.id, { x: 'it' }).indexOf('Do it.') >= 0, 'the imported recipe fills correctly');
R.removeCustom(dimp.recipe.id);
// a params array of garbage still yields a gated recipe (derived from tokens), never a literal {token}
const gimp = R.importRecipe({ name: 'Garbagey', task: 'Brief on {topic}.', params: [{ label: 'no key' }, 'not even an object', 42] });
A.ok(gimp.ok, 'a file with a garbage params array still imports');
A.eq(gimp.recipe.params.map(p => p.key).join(','), 'topic', 'a garbage params array falls through to token derivation (gated)');
R.removeCustom(gimp.recipe.id);
// import mints a UNIQUE id even for two files that share a name — never collide/overwrite
const a1 = R.importRecipe({ name: 'Dup', task: 'Do {a}.' });
const a2 = R.importRecipe({ name: 'Dup', task: 'Do {b}.' });
A.ok(a1.recipe.id !== a2.recipe.id, 'two imports of the same name get distinct ids (never overwrite): ' + a1.recipe.id + ' vs ' + a2.recipe.id);
A.eq(R.customs().length, 2, 'both imports persisted as separate customs');
R.removeCustom(a1.recipe.id); R.removeCustom(a2.recipe.id);

/* goalKeywordScore(): deterministic keyword overlap (name+tagline+tags), case-insensitive, >=3-char words. */
A.eq(R.goalKeywordScore(R.get('fix-bug'), ''), 0, 'no goal text → no goal score');
A.eq(R.goalKeywordScore(null, 'anything'), 0, 'no recipe → no goal score');
A.ok(R.goalKeywordScore(R.get('fix-bug'), 'I want to fix a bug in my code') > 0, 'a goal mentioning "bug"/"fix" scores the fix-bug recipe');
A.eq(R.goalKeywordScore(R.get('fix-bug'), 'FIX FIX FIX'), R.goalKeywordScore(R.get('fix-bug'), 'fix'), 'goal scoring is de-duped + case-insensitive (repeats/case don\'t inflate)');

/* rankRecipes(): deterministic for a fixed input; honest category-spread fallback when signal is silent. */
const items = R.builtins();
// goal-only ranking (no profile): the code-goal surfaces code recipes, deterministically
const gRank = R.rankRecipes(items, { goalText: 'ship code and fix bugs', limit: 3 });
A.ok(gRank.length === 3, 'rankRecipes honors the limit');
const gRank2 = R.rankRecipes(items, { goalText: 'ship code and fix bugs', limit: 3 });
A.eq(gRank.map(r => r.id).join(','), gRank2.map(r => r.id).join(','), 'rankRecipes is deterministic for a fixed input');
A.ok(gRank.some(r => r.id === 'fix-bug' || r.id === 'code-review'), 'a code-goal ranks code recipes into the FOR YOU row');
// profile-affinity ranking: a fake scorer that loves the research lane ranks research recipes first
const researchLover = tags => (tags && tags.research ? tags.research : 0);
const pRank = R.rankRecipes(items, { score: researchLover, limit: 3 });
A.ok(pRank.length > 0 && pRank.every(r => (r.tags && r.tags.research > 0)), 'a research-loving scorer ranks only research-tagged recipes');
// exclude: the dossier's own recipe is omitted
const exRank = R.rankRecipes(items, { score: researchLover, exclude: pRank[0].id, limit: 3 });
A.ok(!exRank.some(r => r.id === pRank[0].id), 'rankRecipes omits the excluded id');
// COLD START: no profile signal + no goal → an honest category SPREAD (distinct categories first), not arbitrary
const cold = R.rankRecipes(items, { score: () => 0, goalText: '', limit: 5 });
A.ok(cold.length === 5, 'cold-start still fills the row');
const coldCats = cold.map(r => r.category);
A.ok(new Set(coldCats).size >= 3, 'the cold-start fallback spreads across distinct categories (varied, not arbitrary): ' + coldCats.join(','));
const cold2 = R.rankRecipes(items, { score: () => 0, goalText: '', limit: 5 });
A.eq(cold.map(r => r.id).join(','), cold2.map(r => r.id).join(','), 'the cold-start fallback is deterministic (stable order)');

// ENGAGEMENT (scout lane 5): the user's OWN launch counts rank a recipe up — and count as signal on their own.
const lRank = R.rankRecipes(items, { launches: { 'summarize': { n: 4 } }, limit: 3 });
A.eq(lRank[0].id, 'summarize', 'a heavily-launched recipe ranks first on launches alone');
// the nudge is CAPPED at 5: two heavy hitters tie and fall back to catalog order (fix-bug precedes summarize),
// and the bare-number launches shape ({id: n}) is accepted alongside {id: {n}}.
const lCap = R.rankRecipes(items, { launches: { 'summarize': { n: 500 }, 'fix-bug': 400 }, goalText: '', limit: 3 });
A.eq(lCap.map(r => r.id).slice(0, 2).join(','), items.filter(r => ['fix-bug', 'summarize'].includes(r.id)).map(r => r.id).join(','), 'capped launch counts tie-break by catalog order; both launch shapes accepted');

/* OUTCOME term (lane B): the Commander's own rate-the-work verdicts rank what actually HELPED. */
// a great-rated recipe outranks an equally-launched unrated one
const oUp = R.rankRecipes(items, { launches: { 'summarize': { n: 2, rated: { great: 2, ok: 0, miss: 0 } }, 'fix-bug': { n: 2 } }, limit: 2 });
A.eq(oUp[0].id, 'summarize', 'great verdicts lift a recipe over an equally-launched unrated one');
// the great lift is capped at 3 — beyond that, catalog order decides again
const oCapA = R.rankRecipes(items, { launches: { 'summarize': { n: 2, rated: { great: 300 } }, 'fix-bug': { n: 2, rated: { great: 3 } } }, limit: 2 });
A.eq(oCapA[0].id, items.find(r => ['fix-bug', 'summarize'].includes(r.id)).id, 'the great lift caps at 3 (300 greats tie with 3, catalog order breaks it)');
// miss verdicts sink a recipe below its launch score — and can drop it out of the row entirely (the HONEST sink)
const oSink = R.rankRecipes(items, { launches: { 'summarize': { n: 2, rated: { miss: 3 } }, 'fix-bug': { n: 2 } }, limit: 4 });
A.ok(!oSink.some(r => r.id === 'summarize'), 'a miss-heavy recipe (score <= 0) drops OUT of the FOR-YOU row — the honest sink');
A.eq(oSink[0].id, 'fix-bug', 'the unrated launched recipe still ranks');
// determinism + garbage tolerance
const oDet1 = R.rankRecipes(items, { launches: { 'summarize': { n: 3, rated: { great: 1, miss: 1 } } }, limit: 3 });
const oDet2 = R.rankRecipes(items, { launches: { 'summarize': { n: 3, rated: { great: 1, miss: 1 } } }, limit: 3 });
A.eq(oDet1.map(r => r.id).join(','), oDet2.map(r => r.id).join(','), 'the outcome term is deterministic for a fixed input');
const oGarbage = R.rankRecipes(items, { launches: { 'summarize': { n: 3, rated: { great: 'lots', miss: -4 } } }, limit: 3 });
A.eq(oGarbage[0].id, 'summarize', 'garbage rated counters read as zeros (launch signal still ranks)');
// ratings NEVER signal alone: rated-but-zero-launch entries leave the row on the cold-start spread
const oAlone = R.rankRecipes(items, { launches: { 'summarize': { n: 0, rated: { great: 3 } } }, score: () => 0, goalText: '', limit: 5 });
const oCold = R.rankRecipes(items, { score: () => 0, goalText: '', limit: 5 });
A.eq(oAlone.map(r => r.id).join(','), oCold.map(r => r.id).join(','), 'ratings without launches do not flip anySignal (cold-start spread unchanged)');

/* THE SINK MUST NEVER EMPTY THE SHELF. First-session shape: no profile affinity, no goal text, ONE recipe
   launched and rated 👎. anySignal flips on the launch, but the negative outcome term scores every candidate
   <= 0 — so the positive filter finds nothing. The row must fall back to the honest cold-start spread, never
   render blank (marketplace.js drops the whole "FOR YOU" section on an empty return, so honest feedback would
   silently delete the flagship shelf). */
const sinkAll = R.rankRecipes(items, { launches: { 'summarize': { n: 1, rated: { great: 0, ok: 0, miss: 1 } } }, score: () => 0, goalText: '', limit: 5 });
A.ok(sinkAll.length === 5, 'an all-negative signal still fills the FOR-YOU row (never a blank shelf): got ' + sinkAll.length);
A.eq(sinkAll.map(r => r.id).join(','), oCold.map(r => r.id).join(','), 'the all-sunk case falls back to the SAME honest cold-start spread');
// …and the sink still works whenever anything positive survives (the honest-sink law above is unchanged).
const sinkSome = R.rankRecipes(items, { launches: { 'summarize': { n: 2, rated: { miss: 3 } }, 'fix-bug': { n: 2 } }, score: () => 0, goalText: '', limit: 4 });
A.ok(!sinkSome.some(r => r.id === 'summarize'), 'a miss-heavy recipe still sinks OUT while a positive one survives');
A.eq(sinkSome[0].id, 'fix-bug', 'the surviving positive recipe still leads the row');

/* ================= TYPED FILL-INS =================
   A param declares the KIND of value it wants so the launch form can offer the right control (a file chooser,
   a chip row, the live connector list) instead of one textarea for everything. Every type still resolves to a
   plain string through fillTask, and a type NEVER gates a launch — these locks are about the form never lying:
   no picker with nothing to pick, no preselected option the Commander was never shown. */
const typed = R.saveCustom({
  name: 'Typed Fill-ins', task: 'Review {target} with a {depth} pass, filed under {folder}, posted to {channel}.',
  params: [
    { key: 'target', type: 'file' },
    { key: 'depth', type: 'choice', options: ['quick', 'thorough', 'quick', '  thorough  '], default: 'thorough' },
    { key: 'folder', type: 'folder' },
    { key: 'channel', type: 'connector' }
  ]
});
const byKey = {}; typed.params.forEach(p => { byKey[p.key] = p; });
A.eq(byKey.target.type, 'file', 'a file param keeps its type');
A.eq(byKey.folder.type, 'folder', 'a folder param keeps its type');
A.eq(byKey.channel.type, 'connector', 'a connector param keeps its type');
A.eq(byKey.depth.type, 'choice', 'a choice param keeps its type');
A.eq(byKey.depth.options.join(','), 'quick,thorough', 'choice options are trimmed + de-duped case-insensitively');
A.eq(byKey.depth.default, 'thorough', 'a choice default that IS an option survives');
A.eq(byKey.target.options.length, 0, 'a non-choice param carries no options');
A.eq(R.get(typed.id).params[0].type, 'file', 'the saved record round-trips its param types');
// every typed value is still just a string in the directive — the launch primitive is untouched.
A.eq(R.fillTask(typed, { target: 'C:\\repo\\a.js', depth: 'quick', folder: 'C:\\repo', channel: 'slack' }),
  'Review C:\\repo\\a.js with a quick pass, filed under C:\\repo, posted to slack.',
  'typed params substitute exactly like text params');

// degradations: the form may never show a control that cannot be used honestly.
const degraded = R.saveCustom({
  name: 'Degraded Types', task: 'Do {a} then {b} then {c}.',
  params: [
    { key: 'a', type: 'dropdown' },                                          // unknown type
    { key: 'b', type: 'choice', options: ['only-one'] },                     // a picker with nothing to pick
    { key: 'c', type: 'choice', options: ['x', 'y'], default: 'z' }          // a default that is not an option
  ]
});
const dKey = {}; degraded.params.forEach(p => { dKey[p.key] = p; });
A.eq(dKey.a.type, 'text', 'an unknown param type falls back to text');
A.eq(dKey.b.type, 'text', 'a choice with fewer than 2 options degrades to a text box');
A.eq(dKey.b.options.length, 0, 'the degraded choice drops its lone option');
A.eq(dKey.c.default, '', 'a choice default that is not one of its options is dropped, never preselected');
A.ok(R.PARAM_TYPES.indexOf('choice') >= 0 && R.PARAM_TYPES.indexOf('file') >= 0, 'the param-type vocabulary is exported');
A.throws(() => { R.get(typed.id).params[1].options.push('sneaky'); }, 'a saved param options array is frozen against mutation');
// a template-derived param (author wrote only {tokens}) is plain text — no invented control.
A.ok(R.paramsFromTemplate('Ping {who} about {what}').every(p => !p.type || p.type === 'text'), 'template-derived params are text');

// export / import carry the types through the portable format, and re-validate on the way in.
const tExp = R.exportRecipe(typed.id);
A.eq(tExp.params.find(p => p.key === 'depth').type, 'choice', 'export carries the param type');
A.eq(tExp.params.find(p => p.key === 'depth').options.join(','), 'quick,thorough', 'export carries the choice options');
const tImp = R.importRecipe(tExp);
A.ok(tImp.ok, 'a typed recipe imports');
A.eq(tImp.recipe.params.find(p => p.key === 'target').type, 'file', 'import preserves a file param');
const evilImport = R.importRecipe({ name: 'Evil', task: 'Do {x}.', params: [{ key: 'x', type: 'choice', options: ['solo'] }] });
A.eq(evilImport.recipe.params[0].type, 'text', 'an imported one-option choice degrades to text (no empty picker from a file)');
R.removeCustom(typed.id); R.removeCustom(degraded.id); R.removeCustom(tImp.recipe.id); R.removeCustom(evilImport.recipe.id);

/* ================= GOAL MATCHING IS WORD-WISE, NOT SUBSTRING =================
   The FOR-YOU row's goal term is the ONLY live signal on a cold station, so a sloppy match decides the whole
   shelf. `hay.indexOf(word)` made "for" match perFORmance and "the" match oTHEr; a real goals belief scored 42
   of 50 catalog recipes above zero and filled the row with unrelated cards. Word-wise matching + a stoplist +
   dropping the internal tag keys from the haystack is what keeps the row explainable. */
const gr = { name: 'Performance Pass', tagline: 'Find where the time and memory go', blurb: 'Profiles the hot path.', tags: { code: 1 } };
A.eq(R.goalKeywordScore(gr, 'for'), 0, '"for" does not match inside "performance" (no substring hits)');
A.eq(R.goalKeywordScore(gr, 'the'), 0, '"the" does not match inside "other" (stopword AND not a substring)');
A.eq(R.goalKeywordScore(gr, 'memory'), 1, 'a real word in the tagline still scores');
A.eq(R.goalKeywordScore(gr, 'profile'), 1, 'a word matches through an ordinary suffix ("profile" -> "profiles")');
A.eq(R.goalKeywordScore(gr, 'perform'), 0, 'a mere prefix with no known suffix is not a hit');
A.eq(R.goalKeywordScore({ name: 'X', tagline: '', blurb: '', tags: { general: 1 } }, 'general'), 0,
  'the internal lane vocabulary is not part of the haystack (a goal saying "general" cannot light up every general recipe)');
A.eq(R.goalKeywordHits(gr, 'memory and time').join(','), 'memory,time', 'the matched keywords are reported in goal order');
A.eq(R.goalKeywordHits(gr, 'MEMORY').join(','), 'memory', 'matching is case-insensitive');
// the whole-catalog effect: a vague, real-world goals belief must not light up most of the library.
const vague = 'Be the always-ready dev test agent for StarNet — a fully-onboarded general assistant a developer can talk to the instant the station boots.';
const lit = R.builtins().filter(r => R.goalKeywordScore(r, vague) > 0).length;
A.ok(lit <= 10, 'a vague goal lights up at most a handful of the catalog, not most of it: got ' + lit + '/' + R.builtins().length);

/* a thin (but real) signal must still fill the row — topped up from the honest category spread, and NEVER by
   readmitting a recipe the Commander rated down (that one carries a negative score and stays sunk). */
const thin = R.rankRecipes(items, { goalText: 'summarize', launches: { 'fix-bug': { n: 1, rated: { miss: 3 } } }, score: () => 0, limit: 4 });
A.eq(thin.length, 4, 'a one-hit goal still fills the FOR-YOU row (topped up from the category spread)');
A.eq(thin[0].id, 'summarize', 'the genuinely matched recipe still leads the row');
A.ok(!thin.some(r => r.id === 'fix-bug'), 'the top-up never readmits a recipe the Commander rated down');
const thinIds = {}; thin.forEach(r => { A.ok(!thinIds[r.id], 'the topped-up row has no duplicates'); thinIds[r.id] = true; });

/* painText (momentum loop, 2026-08-21): the PAIN + AMBITION dossier dims rank the FOR YOU row with the same weight as
   goals, and the card's why names them honestly. A pain point the Commander stated must surface the recipe that
   removes it even when the goals dim is silent — and a silent painText must change nothing (byte-identical rank). */
const mlPain = R.rankRecipesExplained(items, { painText: 'I keep having to fix the same bug every week', goalText: '', limit: 3 });
A.ok(mlPain.personalized, 'a pain point alone is real signal (not cold start)');
A.ok(mlPain.items.some(r => r.id === 'fix-bug'), 'the pain point "fix the same bug" surfaces the fix-bug recipe with no goal text at all');
A.eq(R.rankRecipes(items, { painText: '', goalText: 'ship code and fix bugs', limit: 3 }).map(r => r.id).join(','), gRank.map(r => r.id).join(','), 'an empty painText leaves the goal ranking byte-identical');
A.eq(R.rankRecipes(items, { painText: 'fix bugs', goalText: '', limit: 3 }).map(r => r.id).join(','), R.rankRecipes(items, { goalText: 'fix bugs', painText: '', limit: 3 }).map(r => r.id).join(','), 'pain and goal words carry the same weight');
const mlWhy = R.forYouReason(R.get('fix-bug'), { painText: 'I keep having to fix the same bug', goalText: '' });
A.ok(/off your plate/.test(mlWhy) && /“(fix|bug)”/.test(mlWhy), 'the why names the pain-point match honestly, never as a goal: ' + mlWhy);
A.ok(/your goal/.test(R.forYouReason(R.get('fix-bug'), { painText: 'fix bug', goalText: 'fix bug' })), 'a goal match outranks the pain phrasing when both hit');
A.eq(R.forYouReason(R.get('fix-bug'), { painText: 'the the and', goalText: '' }), '', 'stoplist words never earn a pain reason');

A.report('recipes');
