/* node test/provider.qwencloud.test.js — QwenCloud/DashScope first-class provider behavior. */
'use strict';
const A = require('./_assert.js');
const factory = require('../sidecar/providers/factory.js');
const prices = require('../sidecar/providers/prices.js');

module.exports = (async () => {
  const profile = factory.getProviderProfile('qwencloud');
  A.ok(profile, 'qwencloud profile exists');
  A.eq(profile.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'default DashScope compatible-mode base URL');
  A.eq(profile.priceFamily, 'qwen', 'qwen price family is wired');
  A.eq(prices.priceOf('qwen', 'qwen-plus').in, 0.40, 'qwen-plus has list pricing for spend caps');

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init && init.method === 'POST') {
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ data: [{ id: 'qwen-plus', context_length: 131072 }] }), { status: 200 });
  };
  const p = factory.selectProvider({ provider: 'qwencloud', fetch: fetchImpl, key: 'dashscope-test-key' });
  const models = await p.listModels();
  A.eq(models[0].id, 'qwen-plus', 'lists models from DashScope /models');
  A.eq(p.supportsTools('qwen-plus'), true, 'profile asserts tool support when catalog is silent');
  A.eq(p.supportsTools('brand-new-qwen-model'), true, 'unknown qwencloud ids inherit profile tool support');
  for await (const _ of p.stream({ model: 'qwen-plus', messages: [], reasoningEffort: 'medium' })) { /* drain */ }
  const post = calls.find(c => c.init && c.init.method === 'POST');
  A.eq(JSON.parse(post.init.body).reasoning_effort, undefined, 'QwenCloud does not send OpenAI reasoning_effort');

  A.report('provider.qwencloud.test');
})();
