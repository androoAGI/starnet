'use strict';
const { readSidecarSource } = require('./helpers/source');
/* node test/compress-run-window.test.js — context-cost-1023: /compress measures against the window a run works in.

   0.14.0 stops a run's working window at the model's long-context price tier (prices.js promptTierCeiling: Gemini Pro
   and grok 200k, Claude Haiku 5.5 100K on a direct key), so a 1M-window Gemini 2.5 Pro run folds at ~130k. /compress
   still printed "Chat memory: N / 1048576 tokens used ... When it nears full, older turns are folded", promising a
   window no run on that route works in. Locked here, on the REAL bodies:
     1. the sidecar's /api/models/:provider rows carry runWindow — the model's window stopped at its price tier on a
        route the caps price from the table, the whole window on OpenRouter (billed usage.cost) and unmetered routes;
     2. the browser catalog keeps runWindow and Harness.runWindowOf reads it;
     3. /compress measures against runWindow and says why it is smaller than the model's window;
     4. the website app mirror ships the same. */
const A = require('./_assert.js');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { promptTierCeiling } = require('../sidecar/providers/prices.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
function region(source, marker, closing) {
  const start = source.indexOf(marker), end = source.indexOf(closing, start);
  if (start < 0 || end < start) throw Error('Production function not found: ' + marker);
  return source.slice(start, end + closing.length);
}
const backend = readSidecarSource();
const harness = read('frontend/app/harness.js');
const chat = read('frontend/app/chat.js');

module.exports = (async () => {
  // ---- 1. the sidecar's catalog rows carry the run's window ----
  let rows = [];
  const profiles = { gemini: {}, anthropic: {}, openrouter: {}, xai: {}, ollama: { unmetered: true } };
  const api = vm.runInNewContext(region(backend, 'function publicModel(m)', '\n}\n') + region(backend, 'async function handleProviderModels(', '\n}\n')
    + '\n({ handleProviderModels })', {
    URL, promptTierCeiling,
    normalizeProvider: p => String(p || '').trim().toLowerCase(),
    getProviderProfile: id => profiles[id] || null,
    listModelsForProvider: async () => rows
  });
  async function catalog(provider, list) {
    rows = list;
    let status = 0, body = null;
    await api.handleProviderModels({ url: '/api/models/' + provider }, { writeHead(c) { status = c; }, end(v) { body = JSON.parse(v); } });
    A.eq(status, 200, provider + ': the catalog answers 200');
    return body.models;
  }
  const PRO = { id: 'gemini-2.5-pro', context_length: 1048576 };
  const FLASH = { id: 'gemini-2.5-flash', context_length: 1048576 };
  A.eq((await catalog('gemini', [PRO]))[0].runWindow, 200000, 'a Gemini key: Gemini 2.5 Pro runs work in its 200k price tier, not its 1M window');
  A.eq((await catalog('gemini', [FLASH]))[0].runWindow, 1048576, 'a Gemini key: a model with no price tier keeps its whole window');
  A.eq((await catalog('anthropic', [{ id: 'claude-haiku-5-5', context_length: 200000 }]))[0].runWindow, 100000, 'an Anthropic key: Haiku 5.5 runs work in its 100K tier');
  A.eq((await catalog('xai', [{ id: 'grok-4', context_length: 2000000 }]))[0].runWindow, 200000, 'an xAI key: grok runs work in its 200k tier');
  A.eq((await catalog('openrouter', [{ id: 'google/gemini-2.5-pro', context_length: 1048576 }]))[0].runWindow, 1048576, 'OpenRouter (billed usage.cost prices every tier): the whole window');
  A.eq((await catalog('ollama', [{ id: 'grok-4', context_length: 2000000 }]))[0].runWindow, 2000000, 'an unmetered route (no dollar cap to stay under): the whole window');
  const unknown = (await catalog('gemini', [{ id: 'gemini-2.5-pro', context_length: 0 }]))[0];
  A.ok(!('runWindow' in unknown), 'a window the catalog does not know is never invented: ' + JSON.stringify(unknown));

  // ---- 2. the browser catalog keeps it, and Harness.runWindowOf reads it ----
  const browser = vm.runInNewContext(region(harness, '  function normalizeModel(m)', '\n  }\n')
    + region(harness, '  function runWindowOf(id)', '\n  }\n') + '\n({ normalizeModel, runWindowOf })',
    { catalogModel: id => (id === 'gemini-2.5-pro' ? { runWindow: 200000 } : null) });
  A.eq(browser.normalizeModel({ id: 'gemini-2.5-pro', context_length: 1048576, runWindow: 200000 }).runWindow, 200000, 'the browser catalog keeps runWindow');
  A.eq(browser.normalizeModel({ id: 'm', context_length: 8000 }).runWindow, 0, 'a row without one reads 0 (unknown)');
  A.eq(browser.runWindowOf('gemini-2.5-pro'), 200000, 'Harness.runWindowOf reads the catalog row');
  A.eq(browser.runWindowOf('other'), 0, 'Harness.runWindowOf: a model the catalog lacks reads 0');
  A.ok(/contextLimitOf, runWindowOf, contextState/.test(harness), 'Harness exports runWindowOf');

  // ---- 3. /compress measures against the window a run works in ----
  const compressBody = chat.slice(chat.indexOf('  function compressCommand() {'), chat.indexOf('\n  // /clear', chat.indexOf('  function compressCommand() {')));
  function compress(state, runWindowOf) {
    const lines = [];
    const Harness = { contextState: () => state };
    if (runWindowOf) Harness.runWindowOf = runWindowOf;
    vm.runInNewContext(compressBody + '\ncompressCommand();', {
      activeWs: { id: 'ws', agentId: 'agent' }, contextRef: () => ({ agentId: 'agent', streamId: 'ws', messages: [] }), Harness, localLine: l => lines.push(l)
    });
    return lines[0] || '';
  }
  const pro = compress({ used: 13000, limit: 1048576, model: 'gemini-2.5-pro' }, id => (id === 'gemini-2.5-pro' ? 200000 : 0));
  A.ok(/^Chat memory: 13000 \/ 200000 tokens used \(7%/.test(pro), 'Gemini 2.5 Pro on a key: /compress measures against the 200k window a run works in: ' + pro);
  A.ok(pro.indexOf('The model can hold 1048576, but it bills a higher rate for a prompt over 200000 tokens, so a run works in 200000.') >= 0, 'and says why it is smaller than the model\'s window: ' + pro);
  A.ok(pro.indexOf('1048576 tokens used') < 0, 'and never measures against the 1M window a run folds inside 200k');
  const whole = compress({ used: 13000, limit: 200000, model: 'm' }, () => 200000);
  A.ok(/^Chat memory: 13000 \/ 200000 tokens used \(7%/.test(whole) && whole.indexOf('higher rate') < 0, 'a run that works in the whole window: the line is as before: ' + whole);
  const old = compress({ used: 13000, limit: 200000, model: 'm' }, null);
  A.ok(/^Chat memory: 13000 \/ 200000 tokens used \(7%/.test(old), 'no runWindowOf (an older harness): the model window, as before: ' + old);

  // ---- 4. the website app ships the same ----
  const webChat = read('website/app/app/chat.js'), webHarness = read('website/app/app/harness.js');
  A.ok(webChat.indexOf('Harness.runWindowOf(cs.model)') >= 0, 'the website chat.js mirror carries the /compress run window');
  A.ok(webHarness.indexOf('function runWindowOf(id)') >= 0 && webHarness.indexOf('runWindow: (m && +m.runWindow) || 0') >= 0, 'the website harness.js mirror carries runWindow');

  A.report('compress-run-window.test');
})().catch(e => { console.log('FAIL: compress-run-window.test threw - ' + (e && e.stack || e)); process.exit(1); });
