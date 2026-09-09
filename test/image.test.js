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

  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}
  A.report('image.test');
})().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
