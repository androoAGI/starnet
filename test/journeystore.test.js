/* node test/journeystore.test.js — browser citizen for the durable journey route. */
'use strict';
const A = require('./_assert.js');
const calls = [], notes = [];
global.document = { body: { dataset: {} } };
global.StationUI = { invalidate: key => calls.push({ rerender: key }), notify: (text, tone) => notes.push({ text, tone }) };
global.SFX = { milestone: () => calls.push({ sfx: 'milestone' }) };
let responseJourney = { evolution: { stage: 1, name: 'VECTOR', goalsReached: 1 }, metrics: [], mastery: [], receipts: [], outcomes: [], suppressed: {} };
const { QuerySpine } = require('../frontend/app/queryspine.js');
global.QuerySpine = QuerySpine;
let queryError = null, clock = 1000;
QuerySpine._resetForTest();
QuerySpine._setClockForTest(() => clock);
QuerySpine._setGetForTest(async url => {
  calls.push({ query: url });
  if (queryError) throw queryError;
  return { ok: true, journey: responseJourney };
});
global.fetch = async (url, opts) => {
  calls.push({ url, opts: opts || {} });
  return { ok: true, json: async () => ({ ok: true, journey: responseJourney, metric: { id: 'jm:1' } }) };
};
const { JourneyStore } = require('../frontend/app/journeystore.js');

(async () => {
  JourneyStore._apply({ evolution: { stage: 0, name: 'DRIFT', goalsReached: 0 }, metrics: [], mastery: [], receipts: [], outcomes: [], suppressed: {} });
  A.eq(notes.length, 0, 'initial hydration never fabricates an evolution celebration');
  JourneyStore._apply(responseJourney);
  A.eq(document.body.dataset.journeyStage, '1', 'proof-backed stage projects into the world dataset');
  A.eq(notes.length, 0, 'notification diet (2026-08-18): an evolution never toasts — the sting is the beat');
  A.eq(calls.filter(c => c.sfx === 'milestone').length, 1, 'a later proven stage increase produces one audible receipt beat');
  JourneyStore.init({ epoch: () => 42 });
  await new Promise(resolve => setImmediate(resolve));
  A.ok(JourneyStore.state().hasData && !JourneyStore.state().stale, 'journey GET truth is fresh in QuerySpine after hydration');

  const created = await JourneyStore.createMetric({ label: 'Users', baseline: 0, target: 10 });
  A.ok(created.ok, 'metric create returns the sidecar acknowledgement');
  let post = calls.filter(c => c.url === '/api/journey').pop();
  A.eq(JSON.parse(post.opts.body).op, 'metric.create', 'metric create uses the narrow journey operation');
  A.eq(JSON.parse(post.opts.body).epoch, 42, 'journey mutations carry the live Commander generation');
  await JourneyStore.updateMetric('jm:1', 5, 'billing');
  post = calls.filter(c => c.url === '/api/journey').pop();
  A.eq(JSON.parse(post.opts.body), { op: 'metric.update', id: 'jm:1', current: 5, note: 'billing', epoch: 42 }, 'metric update sends the explicit Commander value, note, and generation');
  await JourneyStore.suppress('builder', 'building');
  A.eq(JSON.parse(calls.filter(c => c.url === '/api/journey').pop().opts.body).op, 'adaptation.suppress', 'Commander correction reaches the reversible adaptation operation');
  await JourneyStore.reset(99);
  A.eq(JSON.parse(calls.filter(c => c.url === '/api/journey').pop().opts.body), { op: 'journey.reset', epoch: 99 }, 'new-Commander reset clears the server-owned journey at its new generation');

  const lastGood = JourneyStore.status();
  queryError = new Error('journey offline'); clock += 1;
  await JourneyStore.sync(true);
  A.eq(JourneyStore.status(), lastGood, 'failed refresh retains the exact last-good journey projection');
  A.ok(JourneyStore.state().stale && JourneyStore.state().error && JourneyStore.state().error.message === 'journey offline',
    'failed refresh exposes explicit stale/error metadata to the renderer');
  A.report('journeystore.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
