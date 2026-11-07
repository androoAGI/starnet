'use strict';
/* The actual interruption helper, two real /api/run requests and the real stop boundary.
   The observer changes neither provider bytes nor crash/recovery behavior. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const { runContextOf, lastUserWords } = require('./helpers/host-notes.js');
const Merge = require('../frontend/app/turnmerge.js');
const { mulberry32 } = require('./helpers/turn-oracle.js');
const RunOutcome = require('../frontend/app/runoutcome.js');
const filename = require.resolve('./helpers/turn-http-fixture.js');
const selected = process.env.TURN_HTTP_HOLD_CONTROL || filename;
const source = fs.readFileSync(selected, 'utf8');
console.log('HELPER_SOURCE ' + selected + ' SHA256=' + crypto.createHash('sha256').update(source).digest('hex'));
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(source, filename);
const { TurnHttpFixture, until, eventsOf } = loaded.exports;
const completeEvents = raw => eventsOf(raw.slice(0, raw.lastIndexOf('\n')));

async function scenario(foreignFirst) {
  const label = foreignFirst ? 'foreign request interposed' : 'ordinary interruption';
  const fx = new TurnHttpFixture('hold-' + Number(foreignFirst), mulberry32(17429));
  const requests = [];
  let armed = false, observedStop = false, targetRaw = '', foreignRaw = '', foreignReading, failure;
  try {
    await fx.start();
    // Independent listener records the actual server Response identity after the fixture's
    // own callback runs. No synthetic held marker or rewritten helper predicate is supplied.
    fx.mock.on('request', (req, res) => {
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return;
      let raw = ''; req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw), match = /Run id:\s*([^\s<]+)/.exec(runContextOf(body.messages));
        requests.push({ response: res, runId: match && match[1], words: lastUserWords(body.messages) });
      });
    });
    const request = fx.fx.request.bind(fx.fx), crash = fx.fx.crash.bind(fx.fx);
    const foreignWords = 'FOREIGN_INTERPOSED_DIRECTIVE';
    function observe(response, append) {
      const original = response.body.getReader.bind(response.body);
      response.body.getReader = (...args) => {
        const reader = original(...args), read = reader.read.bind(reader), decoder = new TextDecoder();
        reader.read = async () => { const part = await read(); if (!part.done) append(decoder.decode(part.value, { stream: true })); return part; };
        return reader;
      };
      return response;
    }
    async function insertForeign() {
      const response = await request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'turnpeer', streamId: 'hold_foreign', model: 'test/model', provider: 'openrouter', isTask: false,
          turnId: Merge.newTurnId(fx.rng), messages: [{ role: 'user', content: foreignWords }] }) });
      A.eq(response.status, 200, label + ': foreign actual route admitted');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      foreignReading = (async () => { try { for (;;) { const part = await reader.read(); if (part.done) break; foreignRaw += decoder.decode(part.value, { stream: true }); } } catch (_) {} })();
      // Old helper may hold the foreign request. Current helper must let it finish normally.
      // Do not demand a foreign partial from the corrected behavior.
      await until(() => requests.some(r => r.words === foreignWords) &&
        (requests.some(r => r.words === foreignWords && fx.held === r.response) || completeEvents(foreignRaw).some(e => e.name === 'agent.run.end')),
      'actual foreign request is held or normally complete before target dispatch');
    }
    let targetForwarded = false;
    fx.fx.request = async (route, options) => {
      if (route !== '/api/run' || targetForwarded) return request(route, options);
      targetForwarded = true;
      if (foreignFirst) await insertForeign();
      armed = true;
      return observe(await request(route, options), text => { targetRaw += text; });
    };
    fx.fx.crash = async () => {
      if (armed) {
        armed = false; observedStop = true;
        const events = completeEvents(targetRaw), own = events.find(e => e.name === 'agent.run.start')?.payload;
        const held = requests.find(r => r.response === fx.held);
        const partial = events.some(e => e.name === 'agent.token' && e.payload?.runId === own?.runId && String(e.payload.delta).includes('INTERRUPTED_PARTIAL'));
        const ended = events.some(e => e.name === 'agent.run.end' && e.payload?.runId === own?.runId);
        console.log('STOP_OWNERSHIP ' + JSON.stringify({ label, sourceRunId: own?.runId, heldRunId: held?.runId, ownPartial: partial, ownEnded: ended,
          requests: requests.map(r => ({ runId: r.runId, foreign: r.words === foreignWords, held: r.response === fx.held })) }));
        A.ok(!!own?.runId, label + ': target actually started before abrupt stop');
        A.ok(!!held && held.runId === own?.runId, label + ': held Response belongs to the target run');
        A.ok(partial, label + ': target emitted its own partial before abrupt stop');
        A.eq(ended, false, label + ': target has not ended at the crash boundary');
        if (foreignFirst) {
          const foreignEnd = completeEvents(foreignRaw).find(e => e.name === 'agent.run.end');
          A.ok(!!foreignEnd && RunOutcome.ofEnd(foreignEnd.payload).ok, label + ': unrelated run completes normally instead of satisfying the hold');
        }
      }
      return crash();
    };
    try { await fx.interruptAndContinue(); } catch (error) { failure = error; console.log('INTERRUPTION_ERROR ' + (error.stack || error)); }
    A.ok(observedStop, label + ': actual helper reached the observed stop boundary');
    A.ok(!failure, label + ': original real recovery and continuation oracles succeed');
  } finally { armed = false; await fx.dispose(); if (foreignReading) await foreignReading; }
}
(async () => {
  await scenario(false);
  await scenario(true);
  A.report('HTTP interruption ownership');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
