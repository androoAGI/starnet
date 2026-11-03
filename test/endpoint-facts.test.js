/* node test/endpoint-facts.test.js — ENDPOINT FACTS: where an endpoint is and the window it reported, in one cached object
   per base URL (local-runtime-profile lane, gap B, 2026-11-03).

   The local runtime profile (one request on a silent local server) and the local prompt budget both ask the same two
   questions of an endpoint: is it on this computer or this network, and what window did its /models row report for this
   model. Both answers come from what StarNet already has — the host's name (errorClass.hostScope) and the catalog reads the
   adapter already makes — never a new probe. Locked here:
     1. scope from the name alone: loopback / private / public / '' (no host); `local` = loopback or private
     2. ONE object per base URL (a trailing slash is the same URL); a credential never rides into host/hostPort
     3. windows: only a positive REPORTED window is kept; a model with none reads 0
     4. the adapter: after the catalog read it already makes, endpointFacts(model) answers the scope and the window LM
        Studio reported (loaded_context_length — never max_context_length, the trained maximum), vLLM's max_model_len,
        0 for an unloaded LM Studio model; a second instance on the same URL answers from the same object with no
        request of its own; a public CUSTOM host reads public and runs no local profile */
'use strict';
const A = require('./_assert.js');
const EF = require('../sidecar/providers/endpoint-facts.js');
const errorClass = require('../sidecar/providers/errorClass.js');
const factory = require('../sidecar/providers/factory.js');

(async () => {
  // ---- 1. scope ----
  {
    const rows = [
      ['http://127.0.0.1:1234/v1', 'loopback', true], ['http://localhost:1234/v1', 'loopback', true], ['http://[::1]:8000/v1', 'loopback', true],
      ['http://192.168.1.50:1234/v1', 'private', true], ['http://10.0.0.7:8000/v1', 'private', true], ['http://gpu-box.lan:8000/v1', 'private', true],
      ['http://llmbox:8000/v1', 'private', true], ['https://llm.example.com/v1', 'public', false], ['http://203.0.113.10:8000/v1', 'public', false],
      ['not a url', '', false]
    ];
    for (const [url, scope, local] of rows) A.eq([EF.of(url).scope, EF.of(url).local], [scope, local], url + ' -> ' + scope);
    A.eq(errorClass.hostScope('192.168.1.50'), 'private', 'errorClass exports hostScope, the one place the rule lives');
  }

  // ---- 2. one object per base URL, no credential in it ----
  {
    A.ok(EF.of('http://127.0.0.1:1234/v1') === EF.of('http://127.0.0.1:1234/v1/'), 'a trailing slash is the same endpoint');
    const f = EF.of('http://user:secret@192.168.1.9:1234/v1');
    A.eq([f.host, f.hostPort], ['192.168.1.9', '192.168.1.9:1234'], 'host and hostPort carry no userinfo');
    A.ok(JSON.stringify(EF.snapshot('http://user:secret@192.168.1.9:1234/v1')).indexOf('secret') < 0, 'nor does the snapshot');
  }

  // ---- 3. windows ----
  {
    const u = 'http://127.0.0.1:5555/v1';
    EF.noteWindow(u, 'a', 8192); EF.noteWindow(u, 'b', 0); EF.noteWindow(u, 'c', -1); EF.noteWindow(u, '', 4096);
    A.eq([EF.windowOf(u, 'a'), EF.windowOf(u, 'b'), EF.windowOf(u, 'c'), EF.windowOf(u, 'zzz')], [8192, 0, 0, 0], 'only a positive reported window is kept');
    A.eq(EF.snapshot(u, 'a'), { scope: 'loopback', local: true, host: '127.0.0.1', hostPort: '127.0.0.1:5555', window: 8192 }, 'the snapshot is a plain copy');
  }

  // ---- 4. the adapter reads it ----
  {
    let gets = 0;
    const LM = { data: [
      { id: 'qwen-loaded', object: 'model', state: 'loaded', quantization: 'Q4_K_M', max_context_length: 32768, loaded_context_length: 8192 },
      { id: 'llama-unloaded', object: 'model', state: 'not-loaded', quantization: 'Q8_0', max_context_length: 131072 },
      { id: 'vllm-served', object: 'model', max_model_len: 16384 }
    ] };
    const fetch = async (url, init) => {
      if (!init || init.body == null) { gets++; return new Response(JSON.stringify(LM), { status: 200 }); }
      throw new Error('no chat in this test');
    };
    const url = 'http://127.0.0.1:1234/v1';
    const p = factory.selectProvider({ provider: 'lmstudio', baseUrl: url, fetch });
    A.eq(typeof p.endpointFacts, 'function', 'the adapter exposes its endpoint facts');
    await p.listModels();
    const loaded = p.endpointFacts && p.endpointFacts('qwen-loaded');
    A.eq(loaded && [loaded.scope, loaded.local, loaded.window, loaded.localProfile], ['loopback', true, 8192, true], 'LM Studio: the window it LOADED the model at, and the local profile is on');
    A.eq(p.endpointFacts && p.endpointFacts('llama-unloaded').window, 0, 'an unloaded LM Studio model has no window (never its trained maximum)');
    A.eq(p.endpointFacts && p.endpointFacts('vllm-served').window, 16384, 'vLLM: the window it serves');
    A.eq(p.endpointFacts && p.endpointFacts('never-listed').window, 0, 'a model no read listed: 0');
    const before = gets;
    const q = factory.selectProvider({ provider: 'custom', baseUrl: url + '/', fetch });
    A.eq(q.endpointFacts && q.endpointFacts('qwen-loaded').window, 8192, 'a fresh instance on the same URL answers from the same object');
    A.eq(gets, before, 'without a request of its own');
    const pub = factory.selectProvider({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', fetch });
    const pf = pub.endpointFacts && pub.endpointFacts('qwen-loaded');
    A.eq(pf && [pf.scope, pf.local, pf.localProfile], ['public', false, false], 'a public CUSTOM host: public, no local profile');
    const ol = factory.selectProvider({ provider: 'ollama', fetch });
    const of = ol.endpointFacts && ol.endpointFacts('qwen3:8b');
    A.eq(of && [of.scope, of.localProfile], ['loopback', false], 'the OLLAMA card keeps its own (native) profile');
  }

  A.report('endpoint-facts.test');
})();
