/* node test/image.test.js — the STUDIO skills: image_generate + image_analyze. Offline + deterministic
   (fetch injected, real temp workspace). Pairs with sidecar/tools/builtin/image.js. Verifies: the OpenRouter
   request shape (modalities for gen; text-then-image_url parts for analyze), base64 data-URL decode + jailed
   save, content-addressed default naming, a 'deliverable' emit, workspace-path read for analysis, jail escape
   refusal, and a clean error when no API key is set. */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');

// Per-process root. The name used to be fixed, and the first thing this file does is rm -rf it —
// so two gates running at once (two worktrees, or a lane gating beside the integration tree) raced
// on the same directory. Worse, the saved file is CONTENT-ADDRESSED, so both runs wrote the same
// path: one process read the file while the other was truncating it and the PNG-magic assertion
// failed with nothing wrong in the product. A phantom RED on merge night. Keep this unique.
const ROOT = path.join(os.tmpdir(), 'starnet-image-test-' + process.pid);

// a 1x1 transparent PNG (real bytes), as base64 — used as the model's "generated" image
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA_URL = 'data:image/png;base64,' + PNG_B64;

// build a fetch stub: records the last request body, returns a routed response
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    calls.push({ url: String(url), body, init });
    return handler(String(url), body, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonResp(obj, status) { return { status: status || 200, json: async () => obj, arrayBuffer: async () => Buffer.alloc(0), headers: { get: () => 'application/json' } }; }

// real PNG fixtures (every scanline filter, 8/16-bit, RGB/RGBA/grey+alpha/palette) for the transparency verdicts
const { encodePng, logoPng } = require('./helpers/png-fixture.js');
const imageReply = png => jsonResp({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }] } }] });

(async () => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}

  // ---- A. parseImageFromResponse / dataUrlToBuffer pure helpers ----
  const T0 = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: async () => jsonResp({}) });
  A.eq(T0._internals.parseImageFromResponse({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } } ] } }] }), DATA_URL, 'parses images[].image_url.url');
  A.eq(T0._internals.parseImageFromResponse({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: DATA_URL } }] } }] }), DATA_URL, 'parses content[] image_url part fallback');
  A.eq(T0._internals.parseImageFromResponse({ choices: [{ message: { content: 'no image here' } }] }), '', 'no image -> empty string');
  const dec = T0._internals.dataUrlToBuffer(DATA_URL);
  A.eq(dec.mime, 'image/png', 'dataUrlToBuffer reads the mime');
  A.ok(dec.buffer.length > 0 && dec.buffer[0] === 0x89 && dec.buffer[1] === 0x50, 'dataUrlToBuffer decodes real PNG bytes (\\x89P…)');

  // ---- B. image_generate: posts modalities, decodes the data URL, saves a content-addressed file, emits deliverable ----
  const genFetch = stubFetch((url) => {
    if (url.indexOf('/chat/completions') >= 0) return jsonResp({ choices: [{ message: { content: 'here you go', images: [{ type: 'image_url', image_url: { url: DATA_URL } }] } }] });
    return jsonResp({}, 404);
  });
  const T1 = makeImageTools({ openrouter: { apiKey: 'sk-test' }, fsp, pathMod: path, root: ROOT, fetchImpl: genFetch });
  const emits = [];
  const ctx = { agentId: 'hero', room: 'office', emit: (n, p) => emits.push({ n, p }) };
  const g = await T1.generateTool.run({ prompt: 'a red cube' }, ctx);
  // request shape
  A.eq(genFetch.calls[0].body.modalities, ['image', 'text'], 'image_generate sends modalities:[image,text]');
  // 2026-07-07 image-quality escape: the default was the OLDEST slug in the live catalog (garbled text on
  // mockups). Default is now current-gen Nano Banana 2; premium (gemini-3-pro-image) is taught in the description.
  A.eq(genFetch.calls[0].body.model, 'google/gemini-3.1-flash-image', 'image_generate defaults to the CURRENT-GEN image model');
  A.ok(/gemini-3-pro-image/.test(T1.generateTool.description) && /READABLE TEXT/.test(T1.generateTool.description), 'the tool teaches the premium model for text-heavy/hero assets');
  A.ok(genFetch.calls[0].init.headers.Authorization === 'Bearer sk-test', 'image_generate sends the BYOK key');
  // saved file
  const rel = (g.summary.match(/image → (\S+)/) || [])[1];
  A.ok(rel && rel.indexOf('images/gen-') === 0 && rel.endsWith('.png'), 'image_generate uses a content-addressed images/gen-*.png name');
  const onDisk = fssync.readFileSync(path.join(ROOT, 'hero', rel));
  A.ok(onDisk[0] === 0x89 && onDisk[1] === 0x50, 'the saved PNG matches the decoded bytes');
  A.ok(g.content.indexOf('/api/file?agent=hero&path=') >= 0, 'image_generate returns the /api/file viewer URL');
  A.ok(emits.some(e => e.n === 'deliverable' && e.p.kind === 'image' && e.p.agentId === 'hero'), 'image_generate emits a deliverable event');

  // A configured OpenRouter-compatible base is part of the authorized route (local proxy/tests included).
  const baseFetch = stubFetch(() => jsonResp({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] }));
  const TB = makeImageTools({ openrouter: { apiKey: 'base-key', baseUrl: 'http://127.0.0.1:43210/api/v1/' }, fsp, pathMod: path, root: ROOT, fetchImpl: baseFetch });
  await TB.generateTool.run({ prompt: 'local route' }, ctx);
  A.eq(baseFetch.calls[0].url, 'http://127.0.0.1:43210/api/v1/chat/completions', 'image_generate honors the configured OpenRouter base URL');

  // OpenAI keys use the dedicated Images API. gpt-image-2 is the media model inside STUDIO,
  // never a streaming chat agent.
  const openAIFetch = stubFetch(() => jsonResp({ data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 8, output_tokens: 16 } }));
  const TO = makeImageTools({ openrouter: { apiKey: 'openai-key', provider: 'openai', protocol: 'openai-images', baseUrl: 'https://api.openai.com/v1/' }, fsp, pathMod: path, root: ROOT, fetchImpl: openAIFetch });
  const go = await TO.generateTool.run({ prompt: 'a moonlit landscape', aspect_ratio: '16:9' }, ctx);
  A.eq(openAIFetch.calls[0].url, 'https://api.openai.com/v1/images/generations', 'OpenAI generation uses /images/generations');
  A.eq(openAIFetch.calls[0].body, { model: 'gpt-image-2', prompt: 'a moonlit landscape', size: '1536x1024' }, 'OpenAI request uses its native prompt/model/size shape without chat streaming fields');
  A.eq(openAIFetch.calls[0].init.headers.Authorization, 'Bearer openai-key', 'OpenAI Images API receives the configured OpenAI key');
  A.ok(/gpt-image-2/.test(TO.generateTool.description) && !/gemini-3-pro-image/.test(TO.generateTool.description), 'OpenAI STUDIO teaches the model valid for its route');
  A.ok(go.summary.indexOf('image → ') === 0, 'OpenAI base64 output is saved as an image artifact');
  A.eq(TO.hasVision, false, 'an OpenAI generation-only route does not falsely advertise chat vision');
  const invalidOverrideFetch = stubFetch(() => jsonResp({ data: [{ b64_json: PNG_B64 }] }));
  const TOInvalidOverride = makeImageTools({ openrouter: { apiKey: 'openai-key', provider: 'openai', protocol: 'openai-images' }, imageModel: 'google/gemini-3-pro-image', fsp, pathMod: path, root: ROOT, fetchImpl: invalidOverrideFetch });
  await TOInvalidOverride.generateTool.run({ prompt: 'route-safe model', model: 'recraft/recraft-v4' }, ctx);
  A.eq(invalidOverrideFetch.calls[0].body.model, 'gpt-image-2', 'an OpenRouter IMAGE_MODEL override cannot cross onto the OpenAI Images API');

  // ---- B1b. aspect_ratio rides image_config; default stays bare (no image_config); bad value refused pre-flight ----
  const gAr = await T1.generateTool.run({ prompt: 'a wide vista', aspect_ratio: '16:9' }, ctx);
  A.ok(gAr.summary.indexOf('image → ') === 0, 'aspect_ratio call still saves an image');
  const arCall = genFetch.calls[genFetch.calls.length - 1];
  A.eq(arCall.body.image_config, { aspect_ratio: '16:9' }, 'aspect_ratio:"16:9" is sent as image_config.aspect_ratio');
  A.eq(genFetch.calls[0].body.image_config, undefined, 'no aspect_ratio -> no image_config field (provider default 1:1)');
  A.ok(/16:9/.test(T1.generateTool.description) && /widescreen/i.test(T1.generateTool.description), 'the tool teaches the aspect_ratio dial for widescreen asks');
  A.eq(T1.generateTool.schema.properties.aspect_ratio.enum, undefined, 'aspect_ratio is NOT an enum — any shape is accepted');
  A.ok(T1.generateTool.schema.properties.width && T1.generateTool.schema.properties.height, 'schema exposes exact width/height');
  // ---- B1c. any ratio/size snaps to the nearest provider ratio; exact pixels get fitted ----
  {
    const rs = T1._internals.resolveShape;
    A.eq(rs('99:1').ratio, '21:9', 'an off-menu ratio snaps to the nearest provider ratio (99:1 -> 21:9)');
    A.eq(rs('16/9').ratio, '16:9', 'slash separator accepted');
    A.eq(rs('1.5').ratio, '3:2', 'a bare decimal ratio works');
    A.eq(rs('landscape').ratio, '3:2', 'shape words work');
    A.eq(rs('Portrait').ratio, '2:3', 'shape words are case-insensitive');
    A.eq(rs('1920x1080'), { ratio: '16:9', width: 1920, height: 1080, exact: true }, 'WxH in aspect_ratio = exact size request');
    A.eq(rs('', 1080, 1350), { ratio: '4:5', width: 1080, height: 1350, exact: true }, 'width+height alone pick the nearest ratio');
    A.eq(rs('1:1', 800, 600).ratio, '1:1', 'an explicit ratio wins over the pixel ratio for generation');
    A.eq(rs(''), { ratio: '', width: 0, height: 0, exact: false }, 'nothing asked -> provider default, no image_config');
    A.eq(rs('banana'), null, 'garbage is refused');
    A.eq(rs('', 100, 0), null, 'width without height is refused');
    A.eq(rs('', 99999, 10), null, 'absurd pixel sizes are refused');
    const before = genFetch.calls.length;
    let badAr = null; try { await T1.generateTool.run({ prompt: 'x', aspect_ratio: 'banana' }, ctx); } catch (e) { badAr = e.message; }
    A.ok(/could not understand the requested image shape/.test(badAr) && /no image was produced/.test(badAr), 'an unparseable shape is refused with an honest, actionable error');
    A.eq(genFetch.calls.length, before, 'the bad-shape refusal fires BEFORE any network call');
    const gSnap = await T1.generateTool.run({ prompt: 'ultra wide', aspect_ratio: '32:9' }, ctx);
    A.eq(genFetch.calls[genFetch.calls.length - 1].body.image_config, { aspect_ratio: '21:9' }, '32:9 is sent to the provider as the nearest 21:9');
    A.ok(/21:9/.test(gSnap.content), 'the result names the ratio actually rendered');
    // the stub PNG is a hand-rolled fixture the resizer can't decode -> the tool must say so, not lie
    const gNoFit = await T1.generateTool.run({ prompt: 'wallpaper', width: 64, height: 36, path: 'art/nofit' }, ctx);
    A.eq(genFetch.calls[genFetch.calls.length - 1].body.image_config, { aspect_ratio: '16:9' }, 'exact 64x36 generates at 16:9');
    A.ok(/NOT resized to 64x36/.test(gNoFit.content), 'an un-resizable render is shipped with an honest NOT-resized note');
    let sharp = null; try { sharp = require('sharp'); } catch (_) {}
    if (sharp) {
      const realPng = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#336699' } }).png().toBuffer();
      const realFetch = stubFetch(() => jsonResp({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + realPng.toString('base64') } }] } }] }));
      const TR = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: realFetch });
      const gExact = await TR.generateTool.run({ prompt: 'wallpaper', width: 64, height: 36, path: 'art/exact' }, ctx);
      A.ok(/fitted to 64x36/.test(gExact.content), 'exact-size result reports the fit');
      const meta = await sharp(path.join(ROOT, 'hero', 'art', 'exact.png')).metadata();
      A.eq([meta.width, meta.height], [64, 36], 'the saved file is EXACTLY 64x36');
      const gTall = await TR.generateTool.run({ prompt: 'poster', aspect_ratio: '1000x1500', path: 'art/tall' }, ctx);
      A.eq(realFetch.calls[realFetch.calls.length - 1].body.image_config, { aspect_ratio: '2:3' }, '"1000x1500" generates at 2:3');
      const m2 = await sharp(path.join(ROOT, 'hero', 'art', 'tall.png')).metadata();
      A.eq([m2.width, m2.height], [1000, 1500], 'a WxH string in aspect_ratio yields that exact pixel size');
    }
  }

  // ---- B2. custom output path + content-addressed idempotency (same bytes -> same default name) ----
  const g2 = await T1.generateTool.run({ prompt: 'x', path: 'art/cube' }, ctx);
  A.ok(g2.summary.indexOf('art/cube.png') >= 0, 'image_generate appends .png to an extensionless custom path');
  const g3 = await T1.generateTool.run({ prompt: 'y' }, ctx);
  A.eq((g3.summary.match(/image → (\S+)/) || [])[1], rel, 'identical image bytes -> identical content-addressed name (idempotent)');

  // ---- C. image_generate errors when the model returns no image ----
  const noImgFetch = stubFetch(() => jsonResp({ choices: [{ message: { content: 'I cannot do that' } }] }));
  const T2 = makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: noImgFetch });
  let threw = false; try { await T2.generateTool.run({ prompt: 'z' }, ctx); } catch (e) { threw = /no image/.test(e.message); }
  A.ok(threw, 'image_generate throws a clear error when no image comes back');

  // ---- D. image_analyze: reads a workspace file, sends text-then-image_url parts, returns model text ----
  const anFetch = stubFetch(() => jsonResp({ choices: [{ message: { content: 'A small red cube on white.' } }] }));
  const T3 = makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: anFetch });
  const a = await T3.analyzeTool.run({ image: rel, prompt: 'what is this?' }, ctx);   // rel was saved under hero/ above
  A.ok(/red cube/i.test(a.content), 'image_analyze returns the vision model text');
  const parts = anFetch.calls[0].body.messages[0].content;
  A.eq(parts[0].type, 'text', 'analyze sends the text part first');
  A.eq(parts[1].type, 'image_url', 'analyze sends an image_url part second');
  A.ok(parts[1].image_url.url.indexOf('data:image/png;base64,') === 0, 'analyze base64-encodes the workspace image into a data URL');

  // ---- E. image_analyze passes an http(s) URL straight through (no file read) ----
  const a2 = await T3.analyzeTool.run({ image: 'https://example.com/cat.jpg' }, ctx);
  A.ok(/red cube/i.test(a2.content), 'image_analyze works with a public URL');
  A.eq(anFetch.calls[1].body.messages[0].content[1].image_url.url, 'https://example.com/cat.jpg', 'a public URL is passed through unchanged');

  // ---- F. jail escape on analyze path is refused ----
  let escaped = false; try { await T3.analyzeTool.run({ image: '../secrets.txt' }, ctx); } catch (e) { escaped = /illegal path|escapes|no such file/i.test(e.message); }
  A.ok(escaped, 'image_analyze refuses a path that escapes the workspace');

  // ---- G. no API key -> clean, actionable error ----
  const T4 = makeImageTools({ openrouter: { apiKey: '' }, fsp, pathMod: path, root: ROOT, fetchImpl: async () => jsonResp({}) });
  let noKey = false; try { await T4.generateTool.run({ prompt: 'q' }, ctx); } catch (e) { noKey = /media connection/i.test(e.message); }
  A.ok(noKey, 'image_generate errors helpfully when no OpenRouter key is configured');

  // ---- H. browserVision: reusable vision callback for browser.vision ----
  A.eq(T3.hasVision, true, 'hasVision is true when a key is present');
  A.eq(T4.hasVision, false, 'hasVision is false with no key (browser.vision stays unwired -> honest unavailable)');
  const bv = await T3.browserVision({ imageBase64: Buffer.from('png').toString('base64'), question: 'what is on screen?' });
  A.ok(/red cube/i.test(bv), 'browserVision returns the vision model text');
  const bvParts = anFetch.calls[anFetch.calls.length - 1].body.messages[0].content;
  A.eq(bvParts[0].text, 'what is on screen?', 'browserVision forwards the question');
  A.ok(bvParts[1].image_url.url.indexOf('data:image/png;base64,') === 0, 'browserVision wraps the screenshot as a PNG data URL');
  let bvNoKey = false; try { await T4.browserVision({ imageBase64: 'x', question: 'q' }); } catch (e) { bvNoKey = /API key/i.test(e.message); }
  A.ok(bvNoKey, 'browserVision throws a clear no-key error (browser.vision converts this to unavailable)');

  // ---- G. slug-drift fallback: an unknown-model rejection retries ONCE on the legacy slug; other errors don't ----
  {
    const fbFetch = stubFetch((url, body) => {
      if (body && body.model === 'google/gemini-3.1-flash-image') return jsonResp({ error: { message: 'gemini-3.1-flash-image is not a valid model ID' } }, 400);
      return jsonResp({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] });
    });
    const TF = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: fbFetch });
    const r = await TF.generateTool.run({ prompt: 'cube' }, { agentId: 'hero', emit: () => {} });
    A.eq(fbFetch.calls.length, 2, 'invalid-model 400 retries exactly once');
    A.eq(fbFetch.calls[1].body.model, 'google/gemini-2.5-flash-image', 'the retry rides the known-good LEGACY slug');
    A.ok(r.content.indexOf('gemini-2.5-flash-image') >= 0, 'the result names the model that ACTUALLY generated (honest fallback)');

    const rlFetch = stubFetch(() => jsonResp({ error: { message: 'rate limited' } }, 429));
    const TR = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: rlFetch });
    let threw = false; try { await TR.generateTool.run({ prompt: 'x' }, { agentId: 'hero', emit: () => {} }); } catch (e) { threw = /429/.test(e.message); }
    A.ok(threw && rlFetch.calls.length === 1, 'a non-model error (429) propagates untouched — no blind fallback');
  }

  // ---- H. deps.imageModel (the STARNET_IMAGE_MODEL knob) overrides the default; args.model still wins ----
  {
    const kFetch = stubFetch(() => jsonResp({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] }));
    const TK = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: kFetch, imageModel: 'openai/gpt-5-image' });
    await TK.generateTool.run({ prompt: 'a' }, { agentId: 'hero', emit: () => {} });
    A.eq(kFetch.calls[0].body.model, 'openai/gpt-5-image', 'deps.imageModel (env knob) overrides the built-in default');
    await TK.generateTool.run({ prompt: 'a', model: 'google/gemini-3-pro-image' }, { agentId: 'hero', emit: () => {} });
    A.eq(kFetch.calls[1].body.model, 'google/gemini-3-pro-image', 'an explicit per-call model still wins over the knob');
  }

  // ---- I. AUX VISION: session-provider fallback (the ref-style route; kills the "give me a key" bug) ----
  {
    // I1. NO key + auxVision -> analyze works through the session provider; no OpenRouter fetch fired
    const auxCalls = [];
    const noOrFetch = stubFetch(() => { throw new Error('must not hit OpenRouter'); });
    const TA = makeImageTools({ openrouter: { apiKey: '' }, fsp, pathMod: path, root: ROOT, fetchImpl: noOrFetch,
      auxVision: async (req) => { auxCalls.push(req); return 'a green triangle (session model)'; } });
    const r1 = await TA.analyzeTool.run({ image: 'https://example.com/x.jpg', prompt: 'what shape?' }, ctx);
    A.ok(/green triangle/.test(r1.content), 'keyless analyze answers via the session provider');
    A.eq(noOrFetch.calls.length, 0, 'no OpenRouter call was attempted without a key');
    A.eq(auxCalls[0].messages[0].content[0].text, 'what shape?', 'aux route forwards the question');
    A.eq(auxCalls[0].messages[0].content[1].type, 'image_url', 'aux route carries the image block');
    A.eq(TA.hasVision, true, 'hasVision is TRUE with auxVision even without a key (browser.vision stays wired)');
    const bva = await TA.browserVision({ imageBase64: 'AAAA', question: 'q' });
    A.ok(/green triangle/.test(bva), 'browserVision rides the aux route keyless');

    // I2. key present but OpenRouter FAILS (dead key / out of credits) -> aux route rescues
    const brokeFetch = stubFetch(() => jsonResp({ error: { message: 'This request requires more credits' } }, 402));
    const TB = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: brokeFetch,
      auxVision: async () => 'rescued by session model' });
    const r2 = await TB.analyzeTool.run({ image: 'https://example.com/x.jpg' }, ctx);
    A.ok(/rescued by session model/.test(r2.content), 'OpenRouter failure degrades to the session provider, not an error');
    A.eq(brokeFetch.calls.length, 1, 'OpenRouter was tried first when a key exists');

    // I3. both routes fail -> ONE error naming both causes
    const TC = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: brokeFetch,
      auxVision: async () => { throw new Error('model has no eyes'); } });
    let both = null; try { await TC.analyzeTool.run({ image: 'https://example.com/x.jpg' }, ctx); } catch (e) { both = e.message; }
    A.ok(/more credits/.test(both) && /no eyes/.test(both), 'double failure reports BOTH routes honestly');

    // I4. aux returning empty text -> honest may-not-support-vision error (never fake success)
    const TD = makeImageTools({ openrouter: { apiKey: '' }, fsp, pathMod: path, root: ROOT, fetchImpl: noOrFetch,
      auxVision: async () => '   ' });
    let empty = null; try { await TD.analyzeTool.run({ image: 'https://example.com/x.jpg' }, ctx); } catch (e) { empty = e.message; }
    A.ok(/may not support vision/.test(empty), 'empty session answer surfaces as a not-vision-capable error');

    // I5. image_generate is UNCHANGED: still requires the OpenRouter key even when auxVision exists
    let genKey = false; try { await TA.generateTool.run({ prompt: 'x' }, ctx); } catch (e) { genKey = /media connection/i.test(e.message); }
    A.ok(genKey, 'image_generate requires a media route; a vision callback alone cannot generate images');
  }

  // Cancellation fences: providers may ignore abort and a staged write may complete late.
  for (const phase of ['before', 'response', 'download', 'write']) {
    const ac = new AbortController(), bills = [], delivered = [];
    const aid = 'cancel-' + phase, rel = 'existing.png';
    const abs = path.join(ROOT, aid, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, 'original-image');
    let fetched = 0;
    const injectedFs = Object.assign({}, fsp, { writeFile: async (...args) => {
      await fsp.writeFile(...args);
      if (phase === 'write' && String(args[0]).includes('.pending-')) ac.abort();
    } });
    const tools = makeImageTools({ openrouter: { apiKey: 'fixture' }, fsp: injectedFs, pathMod: path, root: ROOT,
      onUsage: usage => bills.push(usage), fetchImpl: async url => {
        fetched++;
        if (phase === 'response') ac.abort();
        if (String(url).endsWith('/output.png')) {
          ac.abort();
          return { status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => Buffer.from(PNG_B64, 'base64') };
        }
        return jsonResp({ usage: { cost: .025 }, choices: [{ message: { images: [{ image_url: { url: phase === 'download' ? 'https://fixture.invalid/output.png' : DATA_URL } }] } }] });
      } });
    if (phase === 'before') ac.abort();
    let cancelled = false;
    try { await tools.generateTool.run({ prompt: 'cube', path: rel }, { agentId: aid, signal: ac.signal, emit: (...args) => delivered.push(args) }); }
    catch (e) { cancelled = e.name === 'AbortError'; }
    A.ok(cancelled, phase + ': cancellation propagates');
    A.eq(await fsp.readFile(abs, 'utf8'), 'original-image', phase + ': existing output remains intact');
    A.eq(delivered.length, 0, phase + ': no deliverable emitted');
    A.eq((await fsp.readdir(path.dirname(abs))).length, 1, phase + ': staged bytes cleaned up');
    A.eq(bills.length, phase === 'before' ? 0 : 1, phase + ': received charge retained once despite cancellation');
    if (phase === 'before') A.eq(fetched, 0, 'already cancelled dispatch makes no paid request');
  }
  // Unexpected cleanup failures stay observable without turning a published image into a failed run.
  {
    const failopen = require('../sidecar/failopen.js');
    const before = failopen.counts()['image.staging-cleanup'] || 0;
    const injectedFs = Object.assign({}, fsp, { unlink: async () => { throw Object.assign(new Error('fixture cleanup denied'), { code: 'EACCES' }); } });
    const tools = makeImageTools({ openrouter: { apiKey: 'fixture' }, fsp: injectedFs, pathMod: path, root: ROOT,
      fetchImpl: async () => jsonResp({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] }) });
    const delivered = [];
    const result = await tools.generateTool.run({ prompt: 'cube', path: 'cleanup-proof.png' }, { agentId: 'cleanup', emit: (...args) => delivered.push(args) });
    A.ok(/cleanup-proof.png/.test(result.content), 'cleanup diagnostic preserves a successfully published result');
    A.eq(delivered.length, 1, 'cleanup diagnostic does not duplicate the deliverable');
    A.eq(failopen.counts()['image.staging-cleanup'], before + 1, 'unexpected staging cleanup error is counted');
  }

  // ---- J. TRANSPARENCY (2026-09-28 user report: "a design with a transparent background"). Every Gemini image model
  //      paints a checkerboard into an opaque PNG; the agent then went hunting for raw API access nobody can grant. ----
  {
    const I = T0._internals;
    // J1. the verdict is read from the BYTES
    const logo = logoPng();
    A.eq(I.alphaCoverage(logo), { state: 'transparent', why: 'the alpha channel was checked', clearPct: 83.3 }, 'a clear background is transparent, and a subject at alpha 253 (the gpt-image-2 quirk) is not counted as clear');
    A.eq(I.alphaCoverage(encodePng({ w: 8, h: 8, ctype: 6, pixel: () => [9, 9, 9, 255] })), { state: 'opaque', why: 'the PNG has an alpha channel but no pixel is see-through' }, 'an alpha channel with no see-through pixel is opaque');
    A.eq(I.alphaCoverage(encodePng({ w: 8, h: 8, ctype: 6, pixel: (x, y) => (x > 1 && x < 6 && y > 1 && y < 6) ? [200, 40, 20, 255] : [255, 255, 255, 60] })).state, 'opaque', 'a TINTED background (alpha 60) is not a transparent one, and is never called "every pixel opaque"');
    A.eq(I.alphaCoverage(encodePng({ w: 40, h: 30, ctype: 6, pixel: (x, y) => (x || y) ? [9, 9, 9, 255] : [0, 0, 0, 0] })), { state: 'opaque', why: 'only 1 of 1200 pixels are see-through' }, 'a lone clear pixel is not a transparent background');
    const checker = encodePng({ w: 16, h: 16, ctype: 2, pixel: (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [204, 204, 204] : [255, 255, 255] });
    A.eq(I.alphaCoverage(checker), { state: 'opaque', why: 'the PNG is RGB with no alpha channel' }, 'a PAINTED checkerboard (RGB) is opaque: the Gemini failure mode');
    A.eq(I.alphaCoverage(encodePng({ w: 10, h: 4, ctype: 4, pixel: x => x < 5 ? [0, 0] : [128, 255] })).clearPct, 50, 'greyscale+alpha is decoded');
    A.eq(I.alphaCoverage(encodePng({ w: 10, h: 4, ctype: 6, depth: 16, pixel: x => x < 5 ? [0, 0, 0, 0] : [65535, 0, 0, 65535] })).clearPct, 50, '16-bit RGBA is decoded (big-endian alpha)');
    A.eq(I.alphaCoverage(encodePng({ w: 10, h: 4, ctype: 3, plte: [0, 0, 0, 255, 0, 0], trns: [0], pixel: x => [x < 5 ? 0 : 1] })).clearPct, 50, 'a palette PNG is decoded through its tRNS entries');
    A.eq(I.alphaCoverage(encodePng({ w: 10, h: 4, ctype: 3, plte: [0, 0, 0, 255, 0, 0], pixel: x => [x < 5 ? 0 : 1] })).state, 'opaque', 'a palette PNG without tRNS is opaque');
    A.eq(I.alphaCoverage(encodePng({ w: 8, h: 8, ctype: 6, interlace: 1, pixel: () => [0, 0, 0, 0] })).state, 'unverified', 'an interlaced PNG is unverified, never guessed');
    A.eq(I.alphaCoverage(encodePng({ w: 8, h: 8, ctype: 6, rawIdat: Buffer.from('definitely not deflate'), pixel: () => [0, 0, 0, 0] })), { state: 'unverified', why: 'the PNG data could not be decoded' }, 'undecodable PNG data is unverified, never a claim');
    A.eq(I.alphaCoverage(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0])).state, 'opaque', 'a JPEG is opaque');
    const webp = (tag, flags) => { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write(tag, 12, 'latin1'); b[20] = flags || 0; return b; };
    A.eq(I.alphaCoverage(webp('VP8 ')).state, 'opaque', 'a lossy WEBP is opaque');
    A.eq(I.alphaCoverage(webp('VP8X', 0x10)).state, 'unverified', 'a WEBP with an alpha flag is unverified, not claimed');
    A.eq(I.alphaCoverage(webp('VP8X', 0)).state, 'opaque', 'a WEBP without an alpha flag is opaque');
    A.eq(I.alphaCoverage(Buffer.from('not an image at all')).state, 'unverified', 'unknown bytes are unverified');
    for (const p of ['a fox logo on a transparent background', 'transparent-background sticker', 'transparent PNG icon', 'PNG with an alpha channel', 'a mascot with no background', 'a badge without a background, flat colours', 'fox logo, no background at all', 'background-free emblem', 'backgroundless crest'])
      A.ok(I.TRANSPARENT_ASK.test(p), 'a transparency ask is recognized: ' + p);
    for (const p of ['a transparent glass vase on a wooden table', 'a jellyfish with transparent tentacles', 'a red cube on a white background', 'a landscape photo with no background blur', 'a street scene without background people'])
      A.ok(!I.TRANSPARENT_ASK.test(p), 'not a transparency ask: ' + p);

    // J2. transparent:true on the OpenRouter wire: off the Gemini default, an explicit alpha instruction, a verified file
    const logoFetch = stubFetch(() => imageReply(logo));
    const TT = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: logoFetch });
    const tEmits = [];
    const tr = await TT.generateTool.run({ prompt: 'a fox logo', transparent: true, path: 'art/fox' }, { agentId: 'hero', emit: (n, p) => tEmits.push({ n, p }) });
    const sent = logoFetch.calls[0].body;
    A.eq(sent.model, I.TRANSPARENT_IMAGE_MODEL, 'transparent:true leaves the Gemini default for an alpha-capable model');
    A.eq(I.TRANSPARENT_IMAGE_MODEL, 'openai/gpt-5-image-mini', 'the alpha model is the one proven live on the OpenRouter wire');
    A.ok(sent.messages[0].content.indexOf('a fox logo ') === 0 && /fully transparent background \(PNG with an alpha channel\)/.test(sent.messages[0].content), 'the prompt gains an explicit transparency instruction');
    A.ok(/\nModel: google\/gemini-3\.1-flash-image cannot output transparency, so openai\/gpt-5-image-mini rendered this\./.test(tr.content), 'the result names the switch: ' + JSON.stringify(tr.content));
    A.ok(/\nTransparent background verified in the saved file: 83\.3% of pixels are see-through\./.test(tr.content), 'the result carries the verified coverage');
    A.eq(tr.summary, 'image → art/fox.png', 'a verified transparent render keeps the plain summary');
    A.ok(fssync.readFileSync(path.join(ROOT, 'hero', 'art', 'fox.png')).equals(logo), 'the saved bytes are the RGBA render');
    A.ok(tEmits.some(e => e.n === 'deliverable' && e.p.kind === 'image'), 'the transparent render is delivered');
    A.ok(/TRANSPARENT background/.test(TT.generateTool.description) && TT.generateTool.description.indexOf('openai/gpt-5-image-mini') >= 0, 'the tool teaches transparent:true and the model it uses');
    A.eq(TT.generateTool.schema.properties.transparent.type, 'boolean', 'the schema exposes transparent');

    // J3. a prompt that plainly asks counts as asking; an explicit false wins; a transparent SUBJECT is not a background
    await TT.generateTool.run({ prompt: 'a sticker of a cat on a transparent background' }, ctx);
    const askBody = logoFetch.calls[logoFetch.calls.length - 1].body;
    A.eq(askBody.model, 'openai/gpt-5-image-mini', 'a transparency prompt routes to the alpha model without the flag');
    A.eq(askBody.messages[0].content, 'a sticker of a cat on a transparent background', 'a prompt that already asks is sent unchanged');
    await TT.generateTool.run({ prompt: 'a logo on a transparent background', transparent: false }, ctx);
    A.eq(logoFetch.calls[logoFetch.calls.length - 1].body.model, 'google/gemini-3.1-flash-image', 'transparent:false keeps the default model');
    const glass = await TT.generateTool.run({ prompt: 'a transparent glass vase on a table' }, ctx);
    A.eq(logoFetch.calls[logoFetch.calls.length - 1].body.model, 'google/gemini-3.1-flash-image', 'a transparent subject does not switch models');
    A.ok(!/transparen/i.test(glass.content) && !/\nModel: /.test(glass.content), 'an ordinary render carries no transparency verdict');

    // J4. explicit models: Gemini is switched (and named), an alpha model is kept, an unknown one is kept and judged by its bytes
    await TT.generateTool.run({ prompt: 'hero logo', model: 'google/gemini-3-pro-image', transparent: true }, ctx);
    A.eq(logoFetch.calls[logoFetch.calls.length - 1].body.model, 'openai/gpt-5-image-mini', 'an explicit Gemini model cannot make alpha, so it is switched');
    const kept = await TT.generateTool.run({ prompt: 'hero logo', model: 'openai/gpt-5-image', transparent: true }, ctx);
    A.eq(logoFetch.calls[logoFetch.calls.length - 1].body.model, 'openai/gpt-5-image', 'an explicit alpha-capable model is kept');
    A.ok(!/\nModel: /.test(kept.content) && /Transparent background verified/.test(kept.content), 'no switch note when nothing was switched');
    const checkerFetch = stubFetch(() => imageReply(checker));
    const cEmits = [];
    const opaque = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: checkerFetch })
      .generateTool.run({ prompt: 'badge', model: 'black-forest-labs/flux.2-pro', transparent: true, path: 'art/badge' }, { agentId: 'hero', emit: (n, p) => cEmits.push({ n, p }) });
    A.eq(checkerFetch.calls[0].body.model, 'black-forest-labs/flux.2-pro', 'an explicit model of unknown ability is kept');
    A.ok(/\nNOT TRANSPARENT: the PNG is RGB with no alpha channel\./.test(opaque.content) && /painted, not transparency/.test(opaque.content), 'an opaque result is reported as NOT transparent: ' + JSON.stringify(opaque.content));
    A.ok(/Retry with transparent:true and no model override/.test(opaque.content), 'the retry that would work is named');
    A.ok(cEmits.some(e => e.n === 'deliverable'), 'the paid-for opaque image is still delivered');
    // The summary is a machine-read contract: artifacts.js takes the saved path from everything after "image → ".
    // The verdict must never ride it, or the artifact ledger records a path that does not exist.
    A.eq(opaque.summary, 'image → art/badge.png', 'the summary stays exactly "image → <saved path>"');
    const ledger = require('../sidecar/artifacts.js').makeArtifactCollector();
    ledger.observe({ toolName: 'image_generate', args: { prompt: 'badge', transparent: true }, result: Object.assign({ ok: true, isError: false }, opaque) });
    A.eq(ledger.list(), [{ kind: 'image', path: 'art/badge.png' }], 'the artifact ledger records the real saved path for an opaque verdict');
    const flatFetch = stubFetch(() => imageReply(encodePng({ w: 8, h: 8, ctype: 6, pixel: () => [1, 2, 3, 255] })));
    const flat = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: flatFetch }).generateTool.run({ prompt: 'logo', transparent: true }, ctx);
    A.ok(/no pixel is see-through/.test(flat.content) && /The model ignored the request/.test(flat.content), 'an alpha model that ignored the request is reported as such, with no model hint');

    // J5. slug drift on a transparent render falls back to another ALPHA model, never onto the opaque legacy slug
    const driftFetch = stubFetch((url, body) => body && body.model === 'openai/gpt-5-image-mini'
      ? jsonResp({ error: { message: 'openai/gpt-5-image-mini is not a valid model ID' } }, 400)
      : imageReply(logo));
    const drift = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: driftFetch }).generateTool.run({ prompt: 'logo', transparent: true }, ctx);
    A.eq(driftFetch.calls.map(c => c.body.model), ['openai/gpt-5-image-mini', 'openai/gpt-5-image'], 'a transparent render retries on the alpha fallback');
    A.ok(/model openai\/gpt-5-image\)/.test(drift.content), 'the result names the model that actually rendered');

    // J6. the OpenAI Images API takes transparency as a parameter; DALL-E has none, so it is switched
    const oaFetch = stubFetch(() => jsonResp({ data: [{ b64_json: logo.toString('base64') }] }));
    const TOA = makeImageTools({ openrouter: { apiKey: 'openai-key', provider: 'openai', protocol: 'openai-images' }, fsp, pathMod: path, root: ROOT, fetchImpl: oaFetch });
    const oa = await TOA.generateTool.run({ prompt: 'a fox logo', transparent: true }, ctx);
    const ob = oaFetch.calls[0].body;
    A.eq([ob.model, ob.size, ob.background, ob.output_format], ['gpt-image-2', '1024x1024', 'transparent', 'png'], 'the Images API gets background:transparent with a PNG output');
    A.ok(/Transparent background verified/.test(oa.content), 'an Images API render is verified the same way');
    A.ok(/real alpha channel/.test(TOA.generateTool.description) && !/gpt-5-image-mini/.test(TOA.generateTool.description), 'the OpenAI route teaches its own transparency path');
    const dalle = stubFetch(() => jsonResp({ data: [{ b64_json: logo.toString('base64') }] }));
    await makeImageTools({ openrouter: { apiKey: 'openai-key', provider: 'openai', protocol: 'openai-images' }, imageModel: 'dall-e-3', fsp, pathMod: path, root: ROOT, fetchImpl: dalle })
      .generateTool.run({ prompt: 'logo', transparent: true }, ctx);
    A.eq(dalle.calls[0].body.model, 'gpt-image-2', 'a transparent render leaves DALL-E, which has no background parameter');

    // J7. bytes the decoder cannot count are reported unverified, never claimed
    const interFetch = stubFetch(() => imageReply(encodePng({ w: 8, h: 8, ctype: 6, interlace: 1, pixel: () => [0, 0, 0, 0] })));
    const inter = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: interFetch }).generateTool.run({ prompt: 'logo', transparent: true, path: 'art/inter' }, ctx);
    A.ok(/\nTransparency NOT verified: this PNG layout/.test(inter.content) && /Do not claim the background is transparent/.test(inter.content), 'unverifiable alpha is said plainly');
    A.eq(inter.summary, 'image → art/inter.png', 'the summary keeps its machine-read shape');

    // J7b. the result names the shape RENDERED, not the one asked for: OpenAI image slugs on OpenRouter return a square
    //      whatever image_config says (live probe 2026-09-28: 16:9 asked, 1024x1024 returned)
    const square = encodePng({ w: 32, h: 32, ctype: 6, pixel: (x, y) => (x > 8 && x < 24 && y > 8 && y < 24) ? [200, 40, 20, 255] : [0, 0, 0, 0] });
    const sqFetch = stubFetch(() => imageReply(square));
    const sq = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: sqFetch }).generateTool.run({ prompt: 'logo', transparent: true, aspect_ratio: '16:9' }, ctx);
    A.eq(sqFetch.calls[0].body.image_config, { aspect_ratio: '16:9' }, 'the ratio is still asked for');
    A.ok(/model openai\/gpt-5-image-mini, 32x32, not the requested 16:9\)/.test(sq.content), 'an ignored ratio is reported as the real pixel size: ' + JSON.stringify(sq.content));
    const wideFetch = stubFetch(() => imageReply(encodePng({ w: 32, h: 18, ctype: 2, pixel: () => [1, 2, 3] })));
    const wideOk = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: wideFetch }).generateTool.run({ prompt: 'vista', aspect_ratio: '16:9' }, ctx);
    A.ok(/model google\/gemini-3\.1-flash-image, 16:9\)/.test(wideOk.content) && !/not the requested/.test(wideOk.content), 'an honoured ratio is named as before');

    // J8. an exact-size fit keeps the alpha channel, and the verdict reads the FITTED bytes (sharp-encoded, adaptive filters)
    let sharp = null; try { sharp = require('sharp'); } catch (_) {}
    if (sharp) {
      const wide = await sharp({ create: { width: 160, height: 90, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: { create: { width: 40, height: 40, channels: 4, background: { r: 200, g: 40, b: 20, alpha: 1 } } }, left: 60, top: 25 }]).png().toBuffer();
      const fitFetch = stubFetch(() => imageReply(wide));
      const fit = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: fitFetch }).generateTool.run({ prompt: 'logo', transparent: true, width: 64, height: 36, path: 'art/fit' }, ctx);
      A.ok(/fitted to 64x36/.test(fit.content) && /Transparent background verified/.test(fit.content), 'an exact-size transparent render keeps its alpha: ' + JSON.stringify(fit.content));
      A.ok(!/not the requested/.test(fit.content), 'an exact fit IS the requested shape, so no mismatch is reported');
      // 100x30 renders at the nearest provider ratio (21:9) and is then fitted: the fit, not 21:9, is what was asked
      const odd = await makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: fitFetch }).generateTool.run({ prompt: 'banner', width: 100, height: 30, path: 'art/odd' }, ctx);
      A.ok(/fitted to 100x30/.test(odd.content) && !/not the requested/.test(odd.content), 'an exact size far from any provider ratio is not misreported: ' + JSON.stringify(odd.content));
    }
  }
  // ---- K. the ChatGPT plan: gpt-image-2 through the Codex Responses image_generation tool, no API key ----
  {
    const rejects = async (p, re, msg) => { let m = ''; try { await p; } catch (e) { m = String(e && e.message || e); } A.ok(re.test(m), msg + ' (got: ' + m + ')'); };
    const sse = events => ({ status: 200, text: async () => events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('') });
    const jwt = 'h.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url') + '.sig';
    const logo = logoPng();
    const planEvents = [
      { type: 'response.image_generation_call.partial_image', partial_image_b64: PNG_B64 },
      { type: 'response.output_item.done', item: { type: 'image_generation_call', result: logo.toString('base64') } },
      { type: 'response.output_text.done', text: 'Here is your fox.' },
      { type: 'response.completed', response: { output: [] } }
    ];
    let tokenCalls = 0, usage = 0;
    const planFetch = stubFetch(() => sse(planEvents));
    const TP = makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => { tokenCalls++; return jwt; } },
      fsp, pathMod: path, root: ROOT, fetchImpl: planFetch, onUsage: () => { usage++; } });
    const plan = await TP.generateTool.run({ prompt: 'a fox logo', transparent: true, aspect_ratio: 'portrait' }, ctx);
    const pc = planFetch.calls[0];
    A.eq(pc.url, 'https://chatgpt.com/backend-api/codex/responses', 'the plan route posts to the Codex Responses wire');
    A.eq([pc.init.headers.Authorization, pc.init.headers.originator, pc.init.headers['ChatGPT-Account-ID']], ['Bearer ' + jwt, 'codex_cli_rs', 'acct-1'], 'the plan route sends the sign-in token, the Codex originator and the account id from the JWT');
    A.eq(pc.body.tool_choice, undefined, 'no tool_choice is sent: the Codex backend 400s every forcing shape for a hosted tool');
    A.eq(pc.body.tools, [{ type: 'image_generation', output_format: 'png', partial_images: 1, model: 'gpt-image-2', size: '1024x1536', quality: 'medium', background: 'transparent' }], 'the hosted tool carries the gpt-image model, size, quality and transparency');
    A.eq(pc.body.input[0].content[0].text, 'a fox logo Render the subject alone on a fully transparent background (PNG with an alpha channel): no backdrop, no scenery and no checkerboard pattern.', 'the prompt rides as the user turn');
    A.eq(tokenCalls, 1, 'the token is asked for at call time (the host refreshes it)');
    A.eq(usage, 0, 'a flat-rate plan render books no per-token media cost');
    A.ok(/model gpt-image-2/.test(plan.content) && /Transparent background verified/.test(plan.content), 'the FINAL image (not the partial frame) is saved and its alpha verified: ' + JSON.stringify(plan.content));
    A.ok(/Model note: Here is your fox\./.test(plan.content), 'the host model\'s words ride as the model note');
    A.ok(/ChatGPT plan/.test(TP.generateTool.description) && !/gemini-3-pro-image/.test(TP.generateTool.description), 'the plan route teaches its own model');
    // an OpenRouter-only model choice cannot cross onto the plan; DALL-E has no hosted tool
    const crossFetch = stubFetch(() => sse(planEvents));
    await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, imageModel: 'dall-e-3', fsp, pathMod: path, root: ROOT, fetchImpl: crossFetch })
      .generateTool.run({ prompt: 'x', model: 'google/gemini-3-pro-image' }, ctx);
    A.eq([crossFetch.calls[0].body.tools[0].model, crossFetch.calls[0].body.tools[0].background], ['gpt-image-2', 'opaque'], 'a foreign model choice falls back to gpt-image-2, opaque by default');
    // the server is the authority on expiry: one renew + retry on a 401
    let n = 0; const renewed = [];
    const expFetch = stubFetch(() => (++n === 1) ? { status: 401, text: async () => JSON.stringify({ error: { message: 'token expired' } }) } : sse(planEvents));
    await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => 'old', renewToken: async t => { renewed.push(t); return jwt; } }, fsp, pathMod: path, root: ROOT, fetchImpl: expFetch })
      .generateTool.run({ prompt: 'x' }, ctx);
    A.eq([renewed, expFetch.calls.map(c => c.init.headers.Authorization)], [['old'], ['Bearer old', 'Bearer ' + jwt]], 'a 401 renews the token once and retries');
    // provider errors surface verbatim, and a reply with no image is never saved
    const errFetch = stubFetch(() => ({ status: 403, text: async () => JSON.stringify({ error: { message: 'plan limit reached' } }) }));
    await rejects(makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: errFetch }).generateTool.run({ prompt: 'x' }, ctx),
      /ChatGPT 403: plan limit reached/, 'a plan error is reported verbatim');
    // #118: the customer supplied error TEXT, not a raw envelope. All JSON responses here are synthetic.
    const hostError = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
    const classify = TP._internals.codexHostRejected;
    A.ok(classify(400, hostError, 'gpt-5.5', 'gpt-image-2'), 'exact quoted dispatched host is recognized');
    for (const [detail, host, image] of [
      [hostError.replace('gpt-5.5', 'gpt-5.50'), 'gpt-5.5', 'gpt-image-2'],
      [hostError.replace('gpt-5.5', 'other/gpt-5.5'), 'gpt-5.5', 'gpt-image-2'],
      [hostError.replace('gpt-5.5', 'gpt-5.5-preview'), 'gpt-5.5', 'gpt-image-2'],
      [hostError, 'gpt-5.5', 'gpt-5.5'],
      [hostError, 'gpt-5.5', 'gpt-5.5-image'],
      [hostError, 'gpt-5.5', 'gpt-5'],
      [hostError, 'gpt-5.5', 'gpt-image-2 unsafe label'],
      [hostError, 'gpt-5.5', 'gpt-image-' + 'x'.repeat(150)],
      [hostError + ' Requested gpt-image-2.', 'gpt-5.5', 'gpt-image-2'],
      ['Unsupported model gpt-5.5 or image model gpt-image-2', 'gpt-5.5', 'gpt-image-2']
    ]) A.ok(!classify(400, detail, host, image), 'substring/ambiguous model is not classified: ' + detail);
    A.ok(!classify(403, hostError, 'gpt-5.5', 'gpt-image-2'), 'status alone is not reclassified');
    const privatePrompt = 'issue118-private-prompt', privateKey = 'sk-issue118-private-key-1234567890';
    const sensitive = hostError + ' token=' + jwt + ' account=acct-1 key=' + privateKey + ' prompt=' + privatePrompt;
    const existingPath = path.join(ROOT, 'hero', 'issue118-existing.png');
    const missingPath = path.join(ROOT, 'hero', 'issue118-missing.png');
    await fsp.writeFile(existingPath, 'original image bytes');
    for (const [tag, status, detail, expected] of [
      ['host', 400, hostError, true],
      ['sensitive', 400, sensitive, true],
      ['substring', 400, hostError.replace('gpt-5.5', 'gpt-5.50'), false],
      ['ambiguous', 400, hostError + ' Requested gpt-image-2.', false],
      ['image', 400, hostError.replace('gpt-5.5', 'gpt-image-2'), false],
      ['generic', 400, 'invalid request', false],
      ['plan', 403, 'plan limit reached', false],
      ['oversized', 400, hostError + 'x'.repeat(9000) + privateKey, false]
    ]) {
      for (const output of ['issue118-existing.png', 'issue118-missing.png']) {
        let renewals = 0, usageCalls = 0, message = '';
        const beforeEmits = emits.length;
        const failing = stubFetch(() => ({ status, text: async () => JSON.stringify({ error: { message: detail } }) }));
        const tool = makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', apiKey: privateKey, model: 'conversation-only', getToken: async () => jwt, renewToken: async () => { renewals++; return jwt; } }, fsp, pathMod: path, root: ROOT, fetchImpl: failing, onUsage: () => { usageCalls++; } });
        try { await tool.generateTool.run({ prompt: privatePrompt, model: 'gpt-image-2', path: output }, ctx); } catch (e) { message = String(e.message); }
        A.ok(!!message, tag + ': actual tool rejects');
        A.eq(message.startsWith('ChatGPT rejected image host '), expected, tag + ': precise host classification');
        if (expected) {
          A.ok(message.includes('image host gpt-5.5') && message.includes('Requested image model: gpt-image-2'), tag + ': distinct dispatched model roles');
          A.ok(message.includes('No image was returned or saved by this attempt'), tag + ': no claim about unseen server production');
        }
        A.eq([failing.calls.length, renewals, usageCalls, emits.length - beforeEmits], [1, 0, 0, 0], tag + ': one request, no renewal, booking or publication');
        A.eq([failing.calls[0].url, failing.calls[0].body.model, failing.calls[0].body.tools[0].model], ['https://chatgpt.com/backend-api/codex/responses', 'gpt-5.5', 'gpt-image-2'], tag + ': route/constants unchanged despite API key and different conversation model');
        A.eq(await fsp.readFile(existingPath, 'utf8'), 'original image bytes', tag + ': existing output untouched');
        A.ok(!fssync.existsSync(missingPath), tag + ': absent output not created');
        for (const secret of [jwt, 'acct-1', privateKey, privatePrompt]) A.ok(!message.includes(secret), tag + ': known sensitive detail withheld');
        A.ok(message.length < 600, tag + ': displayed error bounded');
      }
    }
    // Synthetic error envelopes: exercise original-only and augmented prompt echoes through the real tool path.
    const campaignPrompt = 'private-campaign-marker';
    const referenceName = 'issue118-reference.png';
    await fsp.writeFile(path.join(ROOT, 'hero', referenceName), logo);
    const referenceUrl = 'data:image/png;base64,' + logo.toString('base64');
    const transparencySuffix = ' Render the subject alone on a fully transparent background (PNG with an alpha channel): no backdrop, no scenery and no checkerboard pattern.';
    const referencePrefix = 'Match the attached reference image: the same art style, colour palette, lighting and overall concept. ';
    for (const [tag, transparent, withReference] of [['transparent', true, false], ['reference', false, true], ['combined', true, true]]) {
      const dispatchedPrompt = (withReference ? referencePrefix : '') + campaignPrompt + (transparent ? transparencySuffix : '');
      for (const echoedPrompt of [campaignPrompt, dispatchedPrompt]) {
        for (const output of ['issue118-existing.png', 'issue118-missing.png']) {
          let message = '', renewals = 0, usageCalls = 0;
          const beforeEmits = emits.length;
          const echoFetch = stubFetch(() => ({ status: 400, text: async () => JSON.stringify({ error: { message: 'echo=' + echoedPrompt + (withReference ? ' reference=' + referenceUrl : '') } }) }));
          const echoTool = makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', apiKey: privateKey, getToken: async () => jwt, renewToken: async () => { renewals++; return jwt; } }, fsp, pathMod: path, root: ROOT, fetchImpl: echoFetch, onUsage: () => { usageCalls++; } });
          try { await echoTool.generateTool.run({ prompt: campaignPrompt, transparent, reference: withReference ? referenceName : undefined, path: output }, ctx); } catch (e) { message = String(e.message); }
          A.eq(message, 'ChatGPT 400: echo=[redacted-secret]' + (withReference ? ' reference=[redacted-secret]' : ''), tag + ': original and augmented prompt echoes are fully redacted');
          A.eq([echoFetch.calls.length, renewals, usageCalls, emits.length - beforeEmits], [1, 0, 0, 0], tag + ': no retry, billing fallback, booking or publication');
          const request = echoFetch.calls[0];
          A.eq([request.url, request.body.model, request.body.tools], ['https://chatgpt.com/backend-api/codex/responses', 'gpt-5.5', [{ type: 'image_generation', output_format: 'png', partial_images: 1, model: 'gpt-image-2', size: '1024x1024', quality: 'medium', background: transparent ? 'transparent' : 'opaque' }]], tag + ': route and hosted image parameters unchanged');
          A.eq(request.body.input[0].content, [{ type: 'input_text', text: dispatchedPrompt }].concat(withReference ? [{ type: 'input_image', image_url: referenceUrl }] : []), tag + ': dispatched augmented prompt and reference bytes unchanged');
          A.eq(await fsp.readFile(existingPath, 'utf8'), 'original image bytes', tag + ': failure cannot overwrite existing output');
          A.ok(!fssync.existsSync(missingPath), tag + ': failure cannot create absent output');
          A.ok((await fsp.readFile(path.join(ROOT, 'hero', referenceName))).equals(logo), tag + ': reference file unchanged');
        }
      }
    }
    const rawSensitive = stubFetch(() => ({ status: 400, text: async () => 'not JSON: ' + jwt + ' acct-1 ' + privateKey + ' ' + privatePrompt }));
    let rawMessage = '';
    try { await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', apiKey: privateKey, getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: rawSensitive }).generateTool.run({ prompt: privatePrompt, path: 'issue118-existing.png' }, ctx); } catch (e) { rawMessage = String(e.message); }
    A.ok(rawMessage.startsWith('ChatGPT 400:') && !rawMessage.startsWith('ChatGPT rejected'), 'malformed envelope stays generic');
    for (const secret of [jwt, 'acct-1', privateKey, privatePrompt]) A.ok(!rawMessage.includes(secret), 'malformed envelope detail is sanitized before clipping');
    A.eq(await fsp.readFile(existingPath, 'utf8'), 'original image bytes', 'malformed error cannot overwrite output');
    const structuredSensitive = stubFetch(() => ({ status: 400, text: async () => JSON.stringify({ detail: { cookie: 'opaque-cookie-value', nested: { token: 'opaque-nested-token' } } }) }));
    let structuredMessage = '';
    try { await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: structuredSensitive }).generateTool.run({ prompt: privatePrompt, path: 'issue118-existing.png' }, ctx); } catch (e) { structuredMessage = String(e.message); }
    A.eq(structuredMessage, 'ChatGPT 400: [provider detail withheld]', 'structured sensitive detail is withheld before serialization');
    A.eq(await fsp.readFile(existingPath, 'utf8'), 'original image bytes', 'structured error cannot overwrite output');
    const overlappingOld = 'opaque-credential', overlappingNew = overlappingOld + '-private-tail';
    let overlapRenewals = 0, overlapMessage = '';
    const overlap401 = stubFetch(() => ({ status: 401, text: async () => JSON.stringify({ error: { message: overlappingOld + ' ' + overlappingNew } }) }));
    try { await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => overlappingOld, renewToken: async () => { overlapRenewals++; return overlappingNew; } }, fsp, pathMod: path, root: ROOT, fetchImpl: overlap401 }).generateTool.run({ prompt: privatePrompt, path: 'issue118-existing.png' }, ctx); } catch (e) { overlapMessage = String(e.message); }
    A.eq(overlapMessage, 'ChatGPT 401: [redacted-secret] [redacted-secret]', 'overlapping old and renewed credentials leave no private suffix');
    A.eq([overlap401.calls.length, overlapRenewals], [2, 1], 'overlapping credentials preserve bounded auth retry');
    A.eq(await fsp.readFile(existingPath, 'utf8'), 'original image bytes', 'overlapping auth error cannot overwrite output');
    const unknownKey = 'sk-proj-' + 'Z'.repeat(24);
    const safeDetail = TP._internals.codexErrorDetail('unknown ' + unknownKey + '\n' + 'x'.repeat(400), []);
    A.ok(!safeDetail.includes(unknownKey) && !safeDetail.includes('\n') && safeDetail.length <= 300, 'shared pattern redaction precedes one-line clipping');
    let twiceRenewed = 0, repeatedMessage = '';
    const repeated401 = stubFetch(() => ({ status: 401, text: async () => JSON.stringify({ error: { message: 'expired ' + jwt } }) }));
    try { await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => 'old-token-118', renewToken: async () => { twiceRenewed++; return jwt; } }, fsp, pathMod: path, root: ROOT, fetchImpl: repeated401 }).generateTool.run({ prompt: privatePrompt, path: 'issue118-existing.png' }, ctx); } catch (e) { repeatedMessage = String(e.message); }
    A.eq([repeated401.calls.length, twiceRenewed], [2, 1], 'repeated 401 remains bounded at one renewal and two sends');
    A.ok(repeatedMessage.startsWith('ChatGPT 401:') && !repeatedMessage.includes(jwt), 'renewed credential is redacted from generic failure');
    A.eq(await fsp.readFile(existingPath, 'utf8'), 'original image bytes', 'repeated auth failure does not overwrite output');
    // #118 phase B: when ChatGPT refuses the image HOST, the account's LIVE model list names the retry host. Every wire
    // answer below is synthetic (a fake fetch); nothing here reaches the ChatGPT backend.
    {
      const codexMod = require('../sidecar/providers/codex.js');
      const hostReject = host => ({ status: 400, text: async () => JSON.stringify({ error: { message: "The '" + host + "' model is not supported when using Codex with a ChatGPT account." } }) });
      const failWith = (status, message) => ({ status, text: async () => JSON.stringify({ error: { message } }) });
      // ONE fake wire for both seams: GET /models serves `catalog` (null = offline), POST /responses answers per host
      const wire = (catalog, answer) => stubFetch((url, body) => /\/models\?/.test(url)
        ? (catalog ? { ok: true, status: 200, json: async () => catalog } : { ok: false, status: 503, json: async () => ({}) })
        : answer(body));
      const posts = f => f.calls.filter(c => /\/responses$/.test(c.url));
      const lists = f => f.calls.filter(c => /\/models\?/.test(c.url));
      // the run host's catalog dep, built the way the composition root builds it: the codex adapter's own listModels
      // on the SAME sign-in and wire as the image POST, reduced to the ids the account's live list offered
      const liveCatalog = f => async () => codexMod.liveModelIds(await codexMod.makeCodexProvider({ fetch: f, token: jwt }).listModels());
      const planTools = (f, extra) => makeImageTools(Object.assign({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: f, codexHostModels: liveCatalog(f) }, extra || {}));
      const luna = { models: [{ slug: 'gpt-5.6-luna', priority: 1, visibility: 'list' }] };
      const outPath = name => path.join(ROOT, 'hero', name);
      const failure = async p => { try { await p; } catch (e) { return String(e && e.message || e); } return ''; };

      // the reported failure: gpt-5.5 refused, the account lists gpt-5.6-luna -> ONE retry on it, and that image is saved
      const retryFetch = wire(luna, body => body.model === 'gpt-5.5' ? hostReject('gpt-5.5') : sse(planEvents));
      const refusedTally = () => require('../sidecar/failopen.js').counts()['image.codex.host-refused'] || 0;
      const refusedBefore = refusedTally();
      const retried = await planTools(retryFetch).generateTool.run({ prompt: 'a fox logo', path: 'issue118-retry.png' }, ctx);
      A.eq(refusedTally() - refusedBefore, 1, '#118: a recovered refusal still leaves a failopen trace');
      A.eq(posts(retryFetch).map(c => c.body.model), ['gpt-5.5', 'gpt-5.6-luna'], '#118: a refused host retries ONCE, on the live list\'s host');
      A.eq(posts(retryFetch).map(c => c.body.tools[0].model), ['gpt-image-2', 'gpt-image-2'], '#118: both attempts ask for the same image model');
      A.eq(lists(retryFetch).length, 1, '#118: the live list is read once, and only after the refusal');
      A.ok(fssync.existsSync(outPath('issue118-retry.png')) && /issue118-retry\.png/.test(retried.content), '#118: the retried render is saved: ' + JSON.stringify(retried.content));

      // the historical host ALWAYS leads: an account that accepts it sends today's exact request and its list is never
      // read, whatever the run's model (listed, unlisted, or an offline list)
      for (const [tag, catalog, runModel] of [['listed', { models: [{ slug: 'gpt-5.5', priority: 1 }, { slug: 'gpt-5.6-luna', priority: 2 }] }, () => 'gpt-5.6-luna'], ['unlisted', luna, 'gpt-9-unlisted'], ['offline', null, 'gpt-9-unlisted']]) {
        const f = wire(catalog, () => sse(planEvents));
        await planTools(f, { codexRunModel: runModel }).generateTool.run({ prompt: 'x' }, ctx);
        A.eq([posts(f).map(c => c.body.model), lists(f).length], [['gpt-5.5'], 0], tag + ' run model: the historical host leads and the list is never read');
      }
      // control (review repro): a LISTED run model that cannot host the image tool (a non-refusal 400 on it) never
      // costs an account the proven host: one POST on gpt-5.5, the file is saved
      const sparkFetch = wire({ models: [{ slug: 'gpt-5.6-luna', priority: 1 }, { slug: 'gpt-5.5', priority: 2 }, { slug: 'gpt-5.3-codex-spark', priority: 3 }] },
        body => body.model === 'gpt-5.3-codex-spark' ? { status: 400, text: async () => JSON.stringify({ detail: "Tool 'image_generation' is not supported with gpt-5.3-codex-spark." }) } : sse(planEvents));
      await planTools(sparkFetch, { codexRunModel: () => 'gpt-5.3-codex-spark' }).generateTool.run({ prompt: 'a basil plant', path: 'issue118-spark.png' }, ctx);
      A.eq([posts(sparkFetch).map(c => c.body.model), lists(sparkFetch).length], [['gpt-5.5'], 0], 'a listed run model never displaces the proven host');
      A.ok(fssync.existsSync(outPath('issue118-spark.png')), 'a listed run model: the proven host\'s render is saved');
      // gpt-5.5 refused + a Codex run on a LISTED lower-priority model: the retry rides the run's model (chat rides it)
      const runRetry = wire({ models: [{ slug: 'gpt-5.6-luna', priority: 1 }, { slug: 'gpt-5.4', priority: 2 }] }, body => body.model === 'gpt-5.5' ? hostReject('gpt-5.5') : sse(planEvents));
      await planTools(runRetry, { codexRunModel: 'gpt-5.4' }).generateTool.run({ prompt: 'x', path: 'issue118-run.png' }, ctx);
      A.eq(posts(runRetry).map(c => c.body.model), ['gpt-5.5', 'gpt-5.4'], 'gpt-5.5 refused: the retry rides the listed run model first');
      A.ok(fssync.existsSync(outPath('issue118-run.png')), 'the run-model retry\'s render is saved');
      // ...an unlisted run model never hosts: the retry rides the list's top host
      const unlistedRetry = wire(luna, body => body.model === 'gpt-5.5' ? hostReject('gpt-5.5') : sse(planEvents));
      await planTools(unlistedRetry, { codexRunModel: 'gpt-9-unlisted' }).generateTool.run({ prompt: 'x' }, ctx);
      A.eq(posts(unlistedRetry).map(c => c.body.model), ['gpt-5.5', 'gpt-5.6-luna'], 'gpt-5.5 refused, run model unlisted: the retry rides the top live host');
      // ...and an image-only slug the list offers never hosts the hosted tool
      const imageSlugRetry = wire({ models: [{ slug: 'gpt-image-2', priority: 0 }, { slug: 'gpt-5.6-luna', priority: 1 }] }, body => body.model === 'gpt-5.5' ? hostReject('gpt-5.5') : sse(planEvents));
      await planTools(imageSlugRetry, { codexRunModel: 'gpt-image-2' }).generateTool.run({ prompt: 'x' }, ctx);
      A.eq(posts(imageSlugRetry).map(c => c.body.model), ['gpt-5.5', 'gpt-5.6-luna'], 'an image-only slug never hosts the retry');
      A.eq(T0._internals.codexHostOrder('', ['dall-e-3', 'chatgpt-image-latest', 'GPT-IMAGE-1', 'gpt-5.6-luna', 'bad slug']), ['gpt-5.6-luna', 'gpt-5.5'], 'host order drops image-only and malformed slugs, historical host last');

      // an unrelated 400 is never retried and never reads the list
      const otherFetch = wire(luna, () => failWith(400, 'invalid request'));
      A.eq(await failure(planTools(otherFetch).generateTool.run({ prompt: 'x' }, ctx)), 'ChatGPT 400: invalid request', 'an unrelated 400 keeps the generic error');
      A.eq([posts(otherFetch).length, lists(otherFetch).length], [1, 0], 'an unrelated 400: one POST, the list is never read');

      // an offline list: a single gpt-5.5 attempt in phase A's wording, which also says why no other host was tried
      const offFetch = wire(null, body => hostReject(body.model));
      const offMsg = await failure(planTools(offFetch).generateTool.run({ prompt: 'x', path: 'issue118-off.png' }, ctx));
      A.eq(posts(offFetch).map(c => c.body.model), ['gpt-5.5'], 'an offline list: a single attempt on the historical host');
      A.ok(offMsg.startsWith('ChatGPT rejected image host gpt-5.5 for this request (HTTP 400). Requested image model: gpt-image-2. No image was returned or saved by this attempt.')
        && /No other image host was tried: the account's live model list was unavailable/.test(offMsg), 'offline: phase A wording plus why nothing else was tried: ' + offMsg);
      A.ok(!fssync.existsSync(outPath('issue118-off.png')), 'offline: nothing is saved');
      // a live list that offers nothing new says so
      const onlyFetch = wire({ models: [{ slug: 'gpt-5.5', priority: 1 }] }, body => hostReject(body.model));
      const onlyMsg = await failure(planTools(onlyFetch).generateTool.run({ prompt: 'x' }, ctx));
      A.ok(posts(onlyFetch).length === 1 && /No other image host was tried: the account's live model list offers no other model/.test(onlyMsg), 'a list with no other host: one attempt, said plainly: ' + onlyMsg);

      // both hosts refused: exactly one retry, both hosts named, nothing saved
      const bothFetch = wire(luna, body => hostReject(body.model));
      const bothMsg = await failure(planTools(bothFetch).generateTool.run({ prompt: 'x', path: 'issue118-both.png' }, ctx));
      A.eq(posts(bothFetch).map(c => c.body.model), ['gpt-5.5', 'gpt-5.6-luna'], 'both refused: exactly one retry');
      A.ok(bothMsg.startsWith('ChatGPT rejected image hosts gpt-5.5 and gpt-5.6-luna for this request (HTTP 400). Requested image model: gpt-image-2. No image was returned or saved by these attempts.'), 'both refused: both hosts named: ' + bothMsg);
      A.ok(!fssync.existsSync(outPath('issue118-both.png')), 'both refused: nothing is saved');
      // a retry that fails another way says it was the retry
      const limitFetch = wire(luna, body => body.model === 'gpt-5.5' ? hostReject('gpt-5.5') : failWith(403, 'plan limit reached'));
      A.eq(await failure(planTools(limitFetch).generateTool.run({ prompt: 'x' }, ctx)), 'ChatGPT 403: plan limit reached (retried on image host gpt-5.6-luna after ChatGPT rejected image host gpt-5.5)', 'a retry failure names the retry');

      // the ONE 401 renew spans the host retry: 401 -> renew -> refused -> retry -> 401 again = no second renew
      for (const [tag, last, expectErr] of [['retry 401', failWith(401, 'expired'), true], ['retry ok', null, false]]) {
        let renewals = 0, n401 = 0;
        const authFetch = wire(luna, body => {
          if (++n401 === 1) return failWith(401, 'expired');
          if (body.model === 'gpt-5.5') return hostReject('gpt-5.5');
          return last || sse(planEvents);
        });
        const tools = planTools(authFetch, { openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt, renewToken: async () => { renewals++; return jwt; } } });
        const msg = await failure(tools.generateTool.run({ prompt: 'x' }, ctx));
        A.eq([posts(authFetch).map(c => c.body.model), renewals, msg.startsWith('ChatGPT 401:')], [['gpt-5.5', 'gpt-5.5', 'gpt-5.6-luna'], 1, expectErr], tag + ': at most one renewal across the host retry');
      }

      // Stop after the refusal sends no retry
      const stop = new AbortController();
      const stopFetch = wire(luna, body => { stop.abort(); return hostReject(body.model); });
      A.ok(/cancelled/.test(await failure(planTools(stopFetch).generateTool.run({ prompt: 'x' }, Object.assign({}, ctx, { signal: stop.signal })))) && posts(stopFetch).length === 1, 'Stop after a host refusal: no retry is sent');
      // a silent list never hangs the tool: past its bound it counts as unavailable
      const hangFetch = wire(null, body => hostReject(body.model));
      const hangMsg = await failure(planTools(hangFetch, { codexHostModels: () => new Promise(() => {}), codexCatalogTimeoutMs: 30 }).generateTool.run({ prompt: 'x' }, ctx));
      A.ok(posts(hangFetch).length === 1 && /live model list was unavailable/.test(hangMsg), 'a silent list is bounded and reported as unavailable: ' + hangMsg);

      // #157 (quick win 6): a host that answers 200 with TEXT and no image_generation_call did not run the image tool for
      // this account — a refusal of that host too. ONE more host from the live list; the error names the host(s).
      const noTool = { status: 200, text: async () => [{ type: 'response.output_text.done', text: 'I’m unable to generate an image in this chat because no image-generation tool is available.' }, { type: 'response.completed', response: { output: [] } }]
        .map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('') };
      const noImageTally = () => require('../sidecar/failopen.js').counts()['image.codex.host-no-image'] || 0;
      // the historical host answers text-only, the live list offers another: ONE retry on it, and its image is saved
      const quietBefore = noImageTally();
      const quietFetch = wire(luna, body => body.model === 'gpt-5.5' ? noTool : sse(planEvents));
      const quietSaved = await planTools(quietFetch).generateTool.run({ prompt: 'a heron', path: 'issue157-retry.png' }, ctx);
      A.eq(posts(quietFetch).map(c => c.body.model), ['gpt-5.5', 'gpt-5.6-luna'], '#157: a text-only 200 tries the next live host once');
      A.eq(noImageTally() - quietBefore, 1, '#157: an image-less answer leaves a failopen trace naming the host');
      A.ok(fssync.existsSync(outPath('issue157-retry.png')) && /issue157-retry\.png/.test(quietSaved.content), '#157: the retried render is saved: ' + JSON.stringify(quietSaved.content));
      // the reported shape: gpt-5.5 refused (400) -> the live host answers text-only -> one more live host renders it
      const reportFetch = wire({ models: [{ slug: 'gpt-6-luna', priority: 1 }, { slug: 'gpt-5.4', priority: 2 }] },
        body => body.model === 'gpt-5.5' ? hostReject('gpt-5.5') : body.model === 'gpt-6-luna' ? noTool : sse(planEvents));
      await planTools(reportFetch).generateTool.run({ prompt: 'a heron', path: 'issue157-report.png' }, ctx);
      A.eq(posts(reportFetch).map(c => c.body.model), ['gpt-5.5', 'gpt-6-luna', 'gpt-5.4'], '#157 as reported: refused, then text-only, then one more live host — never a host twice');
      A.eq(lists(reportFetch).length, 1, '#157: the live list is still read once');
      A.ok(fssync.existsSync(outPath('issue157-report.png')), '#157 as reported: the third host\'s render is saved');
      // the reported shape where no other host exists: the error names the text-only host and the refused one, and quotes it
      const strandFetch = wire({ models: [{ slug: 'gpt-6-luna', priority: 1 }] }, body => body.model === 'gpt-5.5' ? hostReject('gpt-5.5') : noTool);
      const strandMsg = await failure(planTools(strandFetch).generateTool.run({ prompt: 'a heron', path: 'issue157-strand.png' }, ctx));
      A.eq(posts(strandFetch).map(c => c.body.model), ['gpt-5.5', 'gpt-6-luna'], '#157: no other live host, no further POST');
      A.ok(strandMsg.startsWith('ChatGPT image host gpt-6-luna answered without generating an image (it replied: "I’m unable to generate an image')
        && /Requested image model: gpt-image-2\. No image was returned or saved by this attempt\./.test(strandMsg)
        && /ChatGPT had rejected image host gpt-5\.5 before that\./.test(strandMsg)
        && /No other image host was tried: the account's live model list offers no other model\./.test(strandMsg)
        && !/image-output model/.test(strandMsg), '#157: the error names the hosts, never blames the image model: ' + strandMsg);
      A.ok(!fssync.existsSync(outPath('issue157-strand.png')), '#157: nothing is saved');
      // both live hosts answer text-only: exactly one retry, both named
      const bothQuiet = wire(luna, () => noTool);
      const bothQuietMsg = await failure(planTools(bothQuiet).generateTool.run({ prompt: 'x' }, ctx));
      A.eq(posts(bothQuiet).map(c => c.body.model), ['gpt-5.5', 'gpt-5.6-luna'], '#157: two text-only hosts = exactly one retry');
      A.ok(bothQuietMsg.startsWith('ChatGPT image hosts gpt-5.5 and gpt-5.6-luna each answered without generating an image') && /No image was returned or saved by these attempts\./.test(bothQuietMsg), '#157: both hosts named: ' + bothQuietMsg);
      // an offline list: one attempt, and the error says why no other host was tried
      const offQuiet = wire(null, () => noTool);
      const offQuietMsg = await failure(planTools(offQuiet).generateTool.run({ prompt: 'x' }, ctx));
      A.ok(posts(offQuiet).length === 1 && /^ChatGPT image host gpt-5\.5 answered without generating an image/.test(offQuietMsg) && /live model list was unavailable/.test(offQuietMsg), '#157 offline list: one attempt, said plainly: ' + offQuietMsg);
      // a retry that fails another way says it was the retry after an image-less answer
      const quietLimit = wire(luna, body => body.model === 'gpt-5.5' ? noTool : failWith(403, 'plan limit reached'));
      A.eq(await failure(planTools(quietLimit).generateTool.run({ prompt: 'x' }, ctx)), 'ChatGPT 403: plan limit reached (retried on image host gpt-5.6-luna after image host gpt-5.5 answered without an image)', '#157: a retry failure names the retry');
      // Stop after the image-less answer sends no retry
      const quietStop = new AbortController();
      const quietStopFetch = wire(luna, () => { quietStop.abort(); return noTool; });
      A.ok(/cancelled/.test(await failure(planTools(quietStopFetch).generateTool.run({ prompt: 'x' }, Object.assign({}, ctx, { signal: quietStop.signal })))) && posts(quietStopFetch).length === 1, '#157: Stop after an image-less answer sends no retry');
    }
    const textOnly = stubFetch(() => sse([{ type: 'response.output_text.done', text: 'I cannot draw that.' }, { type: 'response.completed', response: { output: [] } }]));
    await rejects(makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: textOnly }).generateTool.run({ prompt: 'x' }, ctx),
      /^ChatGPT image host gpt-5\.5 answered without generating an image \(it replied: "I cannot draw that\."\)\. Requested image model: gpt-image-2\. No image was returned or saved by this attempt\.$/, 'a text-only reply is an honest failure that names the host and quotes the model');
    await rejects(makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses' }, fsp, pathMod: path, root: ROOT, fetchImpl: textOnly }).generateTool.run({ prompt: 'x' }, ctx),
      /sign in to ChatGPT/, 'no sign-in getter names the fix');
    // a stream that sent a PARTIAL preview frame and then FAILED is a failed render — never a half-drawn image saved as the result
    const partialThenFail = stubFetch(() => sse([{ type: 'response.image_generation_call.partial_image', partial_image_b64: PNG_B64 }, { type: 'response.failed', response: { error: { message: 'content policy' } } }]));
    await rejects(makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: partialThenFail }).generateTool.run({ prompt: 'x' }, ctx),
      /ChatGPT image generation failed: content policy/, 'a partial frame followed by response.failed is reported as the failure');
    // …and so is a partial followed by response.incomplete (a content filter), or a stream cut off with no final event
    for (const [tag, tail, re] of [['response.incomplete', [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }], /stopped before it finished \(content_filter\)/],
      ['a cut-off stream', [], /stopped before it finished \(the stream ended early\)/]]) {
      const cut = stubFetch(() => sse([{ type: 'response.image_generation_call.partial_image', partial_image_b64: PNG_B64 }].concat(tail)));
      await rejects(makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: cut }).generateTool.run({ prompt: 'x' }, ctx),
        re, 'a partial frame then ' + tag + ' is a failed render, never the half-drawn frame saved as the image');
    }
  }

  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}
  A.report('image.test');
})().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
