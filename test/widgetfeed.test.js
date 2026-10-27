/* node test/widgetfeed.test.js — the widget.set tool (sidecar/tools/builtin/widgets.js).

   The agent-fed widget surface: any agent publishes a small named readout the chrome rails
   render with provenance. Contract under test: id discipline, value-or-list floor, redact at
   the write boundary (a fed value can carry a secret), truncation, the 12-widget cap that
   NEVER blocks updating an existing id, clear:true retirement, and provenance stamping.
   Pure, node-loaded, injected in-memory store + clock. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeWidgetTools, MAX_WIDGETS } = require('../sidecar/tools/builtin/widgets.js');

function mem() { const m = new Map(); return { get: k => m.get(k), set: (k, v) => m.set(k, v) }; }
function make(now) {
  const store = mem();
  const t = makeWidgetTools({
    store,
    clock: { now: () => (now === undefined ? 1000 : now) },
    redact: s => String(s).replace(/sk-[a-z0-9]+/gi, '[redacted]')
  });
  return { t, store };
}
const CTX = { agentId: 'nova', runId: 'run_1' };
const run = (t, args, ctx) => t.setTool.run(args, ctx === undefined ? CTX : ctx);
const rejects = async (p, label) => { try { await p; A.ok(false, label + ' (did not throw)'); } catch (e) { A.ok(true, label + ' — ' + String(e.message).slice(0, 60)); } };

(async () => {

  /* ============================ 1. PUBLISH + PROVENANCE ============================ */
  {
    const { t } = make(777);
    const r = await run(t, { id: 'app-revenue', label: 'App Revenue', value: '$1,240', sub: 'today' });
    A.ok(r.content.indexOf('Published') === 0, 'a new id publishes');
    const w = t.list()[0];
    A.eq(w.id, 'app-revenue', 'id persists');
    A.eq(w.label, 'APP REVENUE', 'label is uppercased for the instrument caption');
    A.eq(w.value, '$1,240', 'value persists verbatim');
    A.eq(w.sub, 'today', 'sub persists');
    A.eq(w.agentId, 'nova', 'provenance: which agent fed it');
    A.eq(w.runId, 'run_1', 'provenance: which run fed it');
    A.eq(w.updatedAt, 777, 'provenance: the injected clock stamps it');
  }

  /* ============================ 2. UPSERT (same id overwrites) ============================ */
  {
    const { t } = make();
    await run(t, { id: 'subs', value: '+5' });
    const r = await run(t, { id: 'subs', value: '+7', sub: '214 total' });
    A.ok(r.content.indexOf('Updated') === 0, 'a known id updates, not duplicates');
    A.eq(t.list().length, 1, 'still ONE record');
    A.eq(t.list()[0].value, '+7', 'the newer value wins');
  }

  /* ============================ 3. ID DISCIPLINE + INPUT FLOORS ============================ */
  {
    const { t } = make();
    await rejects(run(t, { id: 'Bad Id!' }), 'a malformed id throws');
    await rejects(run(t, { id: '' }), 'an empty id throws');
    await rejects(run(t, { id: 'a'.repeat(30), value: 'x' }), 'an over-long id throws');
    await rejects(run(t, { id: 'empty-gauge' }), 'no value AND no list throws (nothing to show)');
    await rejects(run(t, { id: 'blank', value: '   ' }), 'a whitespace value throws');
    A.eq(t.list().length, 0, 'no rejected write ever lands');
    // uppercase input id normalizes down
    await run(t, { id: 'MiXeD', value: '1' }, CTX);
    A.eq(t.list()[0].id, 'mixed', 'id lowercases');
  }

  /* ============================ 4. REDACT AT THE WRITE BOUNDARY ============================ */
  {
    const { t } = make();
    await run(t, { id: 'leak', label: 'key sk-abc123', value: 'sk-deadbeef', sub: 'from sk-x1', list: ['token sk-fffff here'] });
    const w = t.list()[0];
    A.ok(w.label.indexOf('sk-') < 0, 'label is scrubbed');
    A.ok(w.value.indexOf('sk-') < 0, 'value is scrubbed');
    A.ok(w.sub.indexOf('sk-') < 0, 'sub is scrubbed');
    A.ok(w.list[0].indexOf('sk-') < 0, 'list lines are scrubbed');
  }

  /* ============================ 5. TRUNCATION + LIST CAP ============================ */
  {
    const { t } = make();
    await run(t, { id: 'long', label: 'L'.repeat(60), value: 'V'.repeat(60), sub: 'S'.repeat(60), list: ['1', '2', '3', '4', '5', '6', '7'] });
    const w = t.list()[0];
    A.ok(w.label.length <= 28, 'label truncates to the instrument limit');
    A.ok(w.value.length <= 24, 'value truncates');
    A.ok(w.sub.length <= 28, 'sub truncates');
    A.eq(w.list.length, 5, 'a ticker keeps at most 5 lines');
  }

  /* ============================ 6. THE CAP (new ids only) ============================ */
  {
    const { t } = make();
    for (let i = 0; i < MAX_WIDGETS; i++) await run(t, { id: 'w' + i, value: String(i) });
    A.eq(t.list().length, MAX_WIDGETS, 'the station holds the cap');
    await rejects(run(t, { id: 'overflow', value: 'x' }), 'a NEW id beyond the cap throws');
    const r = await run(t, { id: 'w0', value: 'updated' });
    A.ok(r.content.indexOf('Updated') === 0, 'updating an existing id at the cap still works');
    A.eq(t.list().find(w => w.id === 'w0').value, 'updated', 'the update landed');
  }

  /* ============================ 6b. EXPRESSIVE DRESSING (tone / spark / progress) ============================ */
  {
    const { t } = make();
    await run(t, { id: 'mrr', value: '$1,240', tone: 'ok', spark: [3, 5, 4, 9], progress: 62.5 });
    const w = t.list()[0];
    A.eq(w.tone, 'ok', 'a whitelisted tone persists');
    A.eq(w.spark.join(','), '3,5,4,9', 'a spark series persists');
    A.eq(w.progress, 62.5, 'progress persists');

    await run(t, { id: 'junk', value: 'x', tone: 'sparkly', spark: [1], progress: 'nope' });
    const j = t.list().find(x => x.id === 'junk');
    A.eq(j.tone, null, 'an unknown tone drops to null (never trusted through)');
    A.eq(j.spark, null, 'a 1-point spark cannot draw a line → null');
    A.eq(j.progress, null, 'a non-numeric progress drops to null');

    await run(t, { id: 'clamp', value: 'x', spark: [1, 'x', 2, Infinity, 3], progress: 250 });
    const c = t.list().find(x => x.id === 'clamp');
    A.eq(c.spark.join(','), '1,2,3', 'non-finite spark points are dropped');
    A.eq(c.progress, 100, 'progress clamps into 0-100');

    const big = []; for (let i = 0; i < 40; i++) big.push(i);
    await run(t, { id: 'cap', value: 'x', spark: big, progress: -9 });
    const k = t.list().find(x => x.id === 'cap');
    A.eq(k.spark.length, 24, 'a spark series caps at 24 points');
    A.eq(k.progress, 0, 'negative progress clamps to 0');
  }

  /* ============================ 7. CLEAR ============================ */
  {
    const { t } = make();
    await run(t, { id: 'gone', value: '1' });
    const r1 = await run(t, { id: 'gone', clear: true });
    A.ok(r1.content.indexOf('Cleared') === 0, 'clear retires the readout');
    A.eq(t.list().length, 0, 'the record is gone');
    const r2 = await run(t, { id: 'gone', clear: true });
    A.eq(r2.summary, 'no-op', 'clearing a missing id is an honest no-op, not an error');
  }

  // User definitions and readings share a transaction boundary; stale runs cannot undo edits/deletion.
  {
    const { t } = make(9000);
    const source = { kind: 'connector', id: 'stripe', label: 'Stripe' };
    const input = { id: 'my-revenue', label: 'Revenue', request: 'Revenue this month', display: 'metric' };
    const w = await t.configure(input, source);
    A.eq(w.updatedAt, 0, 'a definition alone never pretends to be a reading');
    A.eq(w.config.version, 1, 'first user definition has a version');
    A.eq((await t.configure(input, source)).config.version, 1, 'retrying an uncertain create does not duplicate or reset it');
    await rejects(run(t, { id: w.id, value: '$9' }), 'unversioned publication cannot overwrite a configured widget');
    await run(t, { id: w.id, version: 1, value: '$42', sourceUrl: 'https://example.com/report' });
    A.eq(t.list()[0].label, 'Revenue', 'agent does not override the user name');
    A.eq(t.list()[0].sourceUrl, 'https://example.com/report', 'source link is retained');
    await run(t, { id: w.id, version: 1, error: 'Source unavailable: sk-private' });
    A.eq(t.list()[0].value, '$42', 'failed refresh preserves the previous reading');
    A.eq(t.list()[0].updatedAt, 9000, 'failed refresh preserves the reading timestamp');
    A.ok(!t.list()[0].error.includes('sk-private'), 'refresh errors are redacted');
    const edited = await t.configure({ ...input, version: 1, request: 'Revenue yesterday' }, source);
    A.eq(edited.config.version, 2, 'editing invalidates the old refresh definition');
    A.eq(edited.value, null, 'changing the requested metric does not mislabel the previous reading');
    await rejects(run(t, { id: w.id, version: 1, value: '$100' }), 'late result from old definition is rejected');
    await rejects(t.configure({ ...input, version: 1 }, source), 'stale editor cannot overwrite a newer definition');
    A.ok(t.instruction(w.id).includes('Revenue yesterday'), 'refresh instructions use the saved current definition');
    A.ok((await t.getTool.run({ id: w.id })).content.includes('version=2'), 'scheduled runs fetch the current version');
    await rejects(run(t, { id: w.id, clear: true }), 'agent cannot delete a user-created widget');
    await t.remove(w.id);
    A.eq(t.list().length, 0, 'user deletion removes it from the visible inventory');
    await rejects(run(t, { id: w.id, version: 2, value: '$99' }), 'late result cannot resurrect deleted widget');
    await rejects(t.getTool.run({ id: w.id }), 'scheduled update stops on a deleted definition');
  }
  {
    const { t } = make(); const source = { kind: 'agent', id: 'starnet', label: 'StarNet' };
    for (const display of ['list', 'trend', 'progress']) {
      await t.configure({ id: display, label: display, request: 'real data', display }, source);
      await rejects(run(t, { id: display, version: 1, value: '9' }), display + ' refuses an invented/missing shape');
    }
    await run(t, { id: 'list', version: 1, list: ['No tasks due today'] });
    await run(t, { id: 'trend', version: 1, value: '9', spark: [3, 7, 9] });
    await run(t, { id: 'progress', version: 1, value: '0 of 4', progress: 0, sourceUrl: 'javascript:alert(1)' });
    A.eq(t.list().find(w => w.id === 'progress').progress, 0, 'real zero progress survives');
    A.eq(t.list().find(w => w.id === 'progress').sourceUrl, null, 'non-web source links are rejected');
    await run(t, { id: 'progress', version: 1, value: '1 of 4', progress: 25, sourceUrl: 'not a URL' });
    A.eq(t.list().find(w => w.id === 'progress').sourceUrl, null, 'malformed source links are omitted');
    A.eq(t.list().find(w => w.id === 'progress').progress, 25, 'malformed optional link does not discard the reading');
    A.eq(t.list().find(w => w.id === 'trend').spark.length, 3, 'actual trend points are retained');
  }

  /* ============================ 8. THE WIDGET'S OWN UPDATE RUN (releases#6) ============================ */
  // the host grants widget.get/widget.set to the run whose purpose IS a configured widget: its own conversation
  // ('widget-<id>', frontend/app/widgets.js openWidgetTask) or a routine whose job meta names it — never anything else
  {
    const { t } = make(); const source = { kind: 'agent', id: 'starnet', label: 'StarNet' };
    await t.configure({ id: 'w-ai-spend', label: 'AI spend', request: 'total spend this month from the ledger', display: 'metric' }, source);
    await run(t, { id: 'app-revenue', value: '$5' });   // an agent-fed readout: no user definition behind it
    A.eq(t.updateRunOf({ streamId: 'widget-w-ai-spend' }), 'w-ai-spend', 'the widget\'s own conversation is its update run');
    A.eq(t.updateRunOf({ streamId: 'cron-run1', widgetId: 'w-ai-spend' }), 'w-ai-spend', 'a routine whose job names the widget is its update run');
    A.eq(t.updateRunOf({ streamId: 'ws_general' }), null, 'an ordinary conversation is not');
    A.eq(t.updateRunOf({ streamId: 'widget-app-revenue' }), null, 'an agent-fed readout nobody configured grants nothing');
    A.eq(t.updateRunOf({ streamId: 'widget-nope' }), null, 'an unknown widget grants nothing');
    A.eq(t.updateRunOf({ streamId: 'widget-' }), null, 'a bare prefix grants nothing');
    A.eq(t.updateRunOf({ streamId: 'widget-W/../x' }), null, 'a malformed id grants nothing');
    A.eq(t.updateRunOf(null), null, 'no run facts grant nothing');
    await t.remove('w-ai-spend');
    A.eq(t.updateRunOf({ streamId: 'widget-w-ai-spend' }), null, 'a deleted widget\'s conversation grants nothing');
    // the host wiring: after the run's narrowing, exactly the registry's widget grants, keyed by the stream / job meta
    const idx = readSidecarSource();
    const wire = /resolved = enforceEnabledToolsets\([^\n]*\n[\s\S]{0,1300}?widgetTools\.updateRunOf\(\{ streamId: o\.streamId, widgetId: widgetJob && widgetJob\.meta && widgetJob\.meta\.widgetId \}\)[\s\S]{0,200}?\(CAP_REGISTRY\.notebook \|\| \[\]\)\.filter\(g => g && \/\^widget\\\.\/\.test\(g\.tool\)\)/.exec(idx);
    A.ok(!!wire, 'runOnce grants exactly the notebook\'s widget.* rows to the widget\'s update run, after per-run narrowing');
    A.ok(/widgetScope = widgetTools\.updateRunOf\(/.test(idx) && /const capCtx = makeCapCtx\(resolved, Object\.assign\(\{[\s\S]{0,700}\n    widgetScope,\n/.test(idx), 'and stamps that widget id on the tool ctx (widgetScope)');
  }
  // the update run reads and publishes ITS OWN widget only; any other id is refused with a clear error
  {
    const { t } = make(); const source = { kind: 'agent', id: 'starnet', label: 'StarNet' };
    await t.configure({ id: 'w-mine', label: 'Mine', request: 'mine', display: 'metric' }, source);
    await t.configure({ id: 'w-other', label: 'Other', request: 'other', display: 'metric' }, source);
    const scoped = { agentId: 'nova', runId: 'run_9', widgetScope: 'w-mine' };
    A.ok((await t.getTool.run({ id: 'w-mine' }, scoped)).content.includes('version=1'), 'the scoped run reads its own widget');
    await run(t, { id: 'w-mine', version: 1, value: '$7' }, scoped);
    A.eq(t.list().find(w => w.id === 'w-mine').value, '$7', 'and publishes its own widget');
    let msg = '';
    try { await run(t, { id: 'w-other', version: 1, value: '$1' }, scoped); } catch (e) { msg = String(e.message); }
    A.eq(msg, 'This run updates widget "w-mine" only; it cannot read or publish widget "w-other".', 'publishing another configured widget is refused, clearly');
    A.eq(t.list().find(w => w.id === 'w-other').value, null, 'and the other widget is untouched');
    await rejects(run(t, { id: 'brand-new', value: '1' }, scoped), 'creating a new agent-fed readout is refused too');
    await rejects(run(t, { id: 'w-other', clear: true }, scoped), 'and clearing another id');
    await rejects(t.getTool.run({ id: 'w-other' }, scoped), 'reading another widget\'s definition is refused');
    await run(t, { id: 'w-other', version: 1, value: '$2' });   // no scope (an ordinary notebook grant): unchanged
    A.eq(t.list().find(w => w.id === 'w-other').value, '$2', 'a run without a widget scope keeps the notebook grant\'s reach');
  }

  console.log('widgetfeed.test.js OK');
  // report() settles the assertion counter — the .catch below only fires on a THROWN error, so
  // without this a failed assertion still exits 0 and the gate scores it green.
  A.report('widgetfeed.test');
})().catch(e => { console.error('widgetfeed.test.js FAILED:', e); process.exit(1); });
