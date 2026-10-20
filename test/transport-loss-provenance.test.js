/* node test/transport-loss-provenance.test.js — a transport loss is decided by WHERE the error came from, never by
   what its text says (night N2, found by the GH#116 lane, 2026-10-15).

   THE DEFECT. In Chromium/WebView2 — the Windows desktop app — a sidecar death mid-stream rejects the run body read
   (reader.read()) with a TypeError reading "network error" (Chromium also logs net::ERR_INCOMPLETE_CHUNKED_ENCODING).
   friendlyerror's isTransportLoss word list knows "Failed to fetch" / "Load failed" / "terminated" but not those, so
   the drop classified as `unknown`, chat.js never armed the reconnect watch, and the probe + automatic recovery
   never started: the user only got Try again.

   THE TRAP IN THE OBVIOUS FIX. Adding "network error" to the word list would also catch IN-BAND text: an error the
   SIDECAR composed and streamed (a provider's "network error", a forwarded undici "terminated") flows through the
   same classifier. On that path the connection never dropped, the run's journal was retired on its in-band end, and
   an armed probe answers at once with "connection restored — no safe automatic continuation…" — a claim about a
   connection that was never lost.

   THE RULE (structural, fail-closed). Harness tags the error AT ITS THROW SITE in the stream reader — the
   fetch() rejection, the body read rejection, the body ending without the lead's completion — and only a tagged
   error is a transport loss (`verdict.transport`). Text the sidecar sent arrives as a STRING and can never carry
   the tag, so no wording can arm the reconnect watch. Every assertion here runs the production functions: the real
   Harness.chat stream reader, the real friendlyError (both the node and the browser-shaped load), and the real
   COMMS failure branches of chat.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const harnessSrc = read('frontend/app/harness.js');
const chatSrc = read('frontend/app/chat.js');
const friendlySrc = read('frontend/app/friendlyerror.js');

// the two ways Friendly runs: under node (delegates to the sidecar classifier) and in the BROWSER (no require —
// the kindFromRaw fallback every real user executes)
const NodeFriendly = require('../frontend/app/friendlyerror.js');
const BrowserFriendly = (() => {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(friendlySrc + '\nthis.__F = Friendly;', sandbox, { filename: 'friendlyerror.js' });
  return sandbox.__F;
})();
A.ok(BrowserFriendly && typeof BrowserFriendly.friendlyError === 'function', 'friendlyerror loads with no require() in scope (the browser shape)');
const FRIENDLIES = [['node', NodeFriendly], ['browser', BrowserFriendly]];

/* ---- the REAL Harness.chat stream reader, against a fake fetch/reader ---- */
const event = (name, payload) => JSON.stringify({ name, payload });
const start = event('agent.run.start', { runId: 'lead', agentId: 'agent', model: 'test' });
const token = event('agent.token', { runId: 'lead', agentId: 'agent', delta: 'A partial reply' });
async function runHarness(opts) {
  const bytes = new TextEncoder().encode(opts.wire || '');
  let offset = 0;
  const reader = {
    async read() {
      if (offset >= bytes.length) {
        if (opts.readError) throw opts.readError;
        return { done: true };
      }
      const value = bytes.slice(offset); offset = bytes.length;
      return { done: false, value };
    },
    releaseLock() {}
  };
  const scope = {
    TextDecoder, console, DESKTOP: false, DEVMODE: true, DEV_HOST_KEY: false,
    getModel: () => 'test', getProv: () => 'openrouter', getKey: () => '',
    getReasoningEffort: () => '', getBaseUrl: () => '', providerNeedsKey: () => false,
    sidecarErrorDetail: t => String(t || ''),
    fetch: opts.fetch || (async () => ({ ok: true, body: { getReader: () => reader } })),
    U: { bus: { emit() {} } },
    totals: { calls: 0, tokens: 0, cost: 0 }, runModels: {}, internalRuns: new Set(),
    registerRun() {}, foldContextCost() {}
  };
  const first = harnessSrc.indexOf('  async function chat(');
  const last = harnessSrc.indexOf('  /* Read-only fetch of an agent', first);
  A.ok(first >= 0 && last > first, 'execute the complete production Harness.chat');
  // anything chat() needs from the rest of harness.js between the two markers rides along with it
  const chat = vm.runInNewContext(harnessSrc.slice(first, last) + '\nchat', scope);
  let result, error;
  try { result = await chat({ messages: [], agentId: 'agent', onRunId() {} }); } catch (e) { error = e; }
  return { result, error };
}

/* ---- the REAL COMMS failure branches of chat.js send() ---- */
function sliceBetween(src, startMarker, endMarker, label) {
  const i = src.indexOf(startMarker), j = src.indexOf(endMarker, i + 1);
  A.ok(i > 0 && j > i, 'locate ' + label);
  return src.slice(i, j);
}
// the THROWN branch (catch (e) { … } before the finally)
const catchBody = sliceBetween(chatSrc, '    } catch (e) {\n      const aborted', '    } finally {\n      aborters.delete', 'the COMMS thrown-failure branch')
  .slice('    } catch (e) {'.length);
// the IN-BAND branch (the sidecar streamed `error`): from `if (error) {` up to its `} else {` (the completed run)
const inbandBody = sliceBetween(chatSrc, '      if (error) {\n        // PLAIN-LANGUAGE', '      } else {\n        // the run COMPLETED', 'the COMMS in-band failure branch') + '}';

function commsSandbox(Friendly, extra) {
  const calls = [], interruptedStreams = new Set();
  const ws = { id: 'original', agentId: 'agent', history: [] };
  const sandbox = Object.assign({
    ws, acc: 'Retained partial', thisRunId: 'lead', runRoot: null, retry: false, text: 'do the thing', input: null,
    interrupted: new Set(), interruptedStreams, stopSource: new Map(), Friendly,
    persistPartial: () => calls.push('partial'),
    Harness: { pingEngine: async () => { calls.push('health'); return false; } },
    Workstreams: { noteRunEnd() {} }, StationUI: { clearRunning() {}, notify() {} },
    armReconnectWatch: () => calls.push('arm'), isActiveWs: () => true,
    activeLiveRow: { error: (msg) => calls.push(['row', msg]) }, resolvePresence() {}, offerRetry: v => calls.push(['retry', v.kind]),
    errorHistoryLine: v => '⚠ ' + v.userMessage, settleRunNeeds() {}, autoGrowInput() {},
    whoOf: () => 'Agent', sessionNote: () => '', brief: s => s
  }, extra || {});
  return { sandbox, calls, interruptedStreams };
}
async function runCatch(Friendly, e) {
  const s = commsSandbox(Friendly);
  await vm.runInNewContext('(async function(e) {' + catchBody + '\n})', s.sandbox)(e);
  return s;
}
function runInband(Friendly, error) {
  const s = commsSandbox(Friendly, { error, busyRefusal: '' });
  vm.runInNewContext('(function() {' + inbandBody + '\n})', s.sandbox)();
  return s;
}
const armed = s => s.calls.filter(c => c === 'arm').length;

(async () => {
  /* 1. A REAL BODY-READ REJECTION ARMS THE RECONNECT WATCH — whatever words the browser chose.
        Chromium/WebView2 says "network error" (the GH#116 desktop shape); the rest are the other engines' words for
        the same event. The sidecar died, so /api/health answers nothing and the probe must start. */
  const bodyReadRejections = [
    ['Chromium/WebView2', () => new TypeError('network error')],
    ['Chromium net code', () => new TypeError('net::ERR_INCOMPLETE_CHUNKED_ENCODING')],
    ['Firefox', () => new TypeError('NetworkError when attempting to fetch resource.')],
    ['Firefox body', () => new TypeError('Error in body stream')],
    ['Safari', () => new TypeError('Load failed')],
    ['Safari lost', () => new TypeError('The network connection was lost.')],
    ['undici', () => new TypeError('terminated')],
    ['DOMException', () => new DOMException('The network connection was lost.', 'NetworkError')]
  ];
  for (const [label, make] of bodyReadRejections) {
    const readError = make();
    const h = await runHarness({ wire: start + '\n' + token + '\n', readError });
    A.ok(h.error === readError, label + ': the stream reader rethrows the browser\'s own error (identity kept)');
    for (const [where, Friendly] of FRIENDLIES) {
      const v = Friendly.friendlyError(h.error, null, { engineAlive: false });
      A.eq(v.kind, 'network', label + ' (' + where + '): a body-read rejection is a transport loss');
      A.eq(v.transport, true, label + ' (' + where + '): the verdict carries the transport provenance');
      A.eq(v.retryable, true, label + ' (' + where + '): and stays retryable');
      const c = await runCatch(Friendly, h.error);
      A.eq(armed(c), 1, label + ' (' + where + '): COMMS arms the reconnect watch exactly once');
      A.ok(c.interruptedStreams.has('original'), label + ' (' + where + '): the interrupted session is flagged for recovery');
    }
  }

  // the other two throw sites of the same reader are transport by construction too
  {
    const refused = await runHarness({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const eof = await runHarness({ wire: start + '\n' + token + '\n' });
    for (const [label, h] of [['fetch() rejected', refused], ['body ended before completion', eof]]) {
      A.ok(h.error && typeof h.error.message === 'string', label + ': Harness throws');
      for (const [where, Friendly] of FRIENDLIES) {
        const v = Friendly.friendlyError(h.error, null, { engineAlive: false });
        A.eq(v.transport, true, label + ' (' + where + '): tagged at the throw site');
        A.eq(armed(await runCatch(Friendly, h.error)), 1, label + ' (' + where + '): arms the reconnect watch');
      }
    }
  }

  // a Stop is not a transport loss: the AbortError the reader throws keeps its identity and is never tagged
  {
    const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
    const h = await runHarness({ wire: start + '\n', readError: abort });
    A.ok(h.error === abort, 'abort: identity kept');
    for (const [where, Friendly] of FRIENDLIES) {
      const v = Friendly.friendlyError(h.error);
      A.eq(v.kind, 'user_abort', 'abort (' + where + '): stays a user abort');
      A.ok(v.transport !== true, 'abort (' + where + '): never carries transport provenance');
    }
  }

  /* 2. TEXT THE SIDECAR SENT NEVER ARMS IT — whatever its words.
        In-band, the sidecar composed and streamed the error, so it was alive; the run's journal is retired on that
        end, so a probe could only print "connection restored" about a connection that never dropped. */
  const inbandTexts = [
    'OpenAI stream error: network error',
    'Provider returned an error: net::ERR_INCOMPLETE_CHUNKED_ENCODING',
    'terminated',
    'other side closed',
    'Failed to fetch'
  ];
  for (const raw of inbandTexts) {
    const h = await runHarness({ wire: [start, token, event('agent.run.error', { runId: 'lead', message: raw }), event('agent.run.end', { runId: 'lead', reason: 'error' })].join('\n') + '\n' });
    A.eq(h.result && h.result.error, raw, 'in-band "' + raw + '": arrives as the sidecar\'s own string, not a throw');
    for (const [where, Friendly] of FRIENDLIES) {
      const v = Friendly.friendlyError(h.result.error, null, { engineAlive: true });
      A.ok(v.transport !== true, 'in-band "' + raw + '" (' + where + '): text never carries transport provenance');
      const c = runInband(Friendly, h.result.error);
      A.eq(armed(c), 0, 'in-band "' + raw + '" (' + where + '): COMMS does NOT arm the reconnect watch');
      A.ok(!c.interruptedStreams.has('original'), 'in-band "' + raw + '" (' + where + '): the session is not flagged interrupted');
      A.ok(c.calls.some(x => Array.isArray(x) && x[0] === 'row'), 'in-band "' + raw + '" (' + where + '): the failure still renders its row');
    }
  }

  // a THROWN error whose text the sidecar wrote (a pre-stream HTTP failure) is not a transport loss either, even when
  // its words match the transport word list: the sidecar answered the request
  {
    const h = await runHarness({ fetch: async () => ({ ok: false, status: 502, body: null, text: async () => 'upstream terminated: network error' }) });
    A.ok(h.error && /sidecar HTTP 502/.test(h.error.message), 'pre-stream HTTP failure: Harness throws the sidecar\'s answer');
    for (const [where, Friendly] of FRIENDLIES) {
      A.ok(Friendly.friendlyError(h.error).transport !== true, 'pre-stream HTTP failure (' + where + '): not transport provenance');
      A.eq(armed(await runCatch(Friendly, h.error)), 0, 'pre-stream HTTP failure (' + where + '): the sidecar answered — no reconnect watch');
    }
  }

  // and an untagged Error built from the same words (anything that did not come through the reader's throw sites)
  for (const [where, Friendly] of FRIENDLIES) {
    for (const raw of ['network error', 'terminated', 'Failed to fetch']) {
      A.ok(Friendly.friendlyError(new Error(raw)).transport !== true, 'untagged "' + raw + '" (' + where + '): words alone are never provenance');
    }
  }

  A.report('transport-loss-provenance');
})().catch(e => { console.error(e); process.exit(1); });
