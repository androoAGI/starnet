/* node test/image-reference.test.js — image_generate's REFERENCE image (the design anchor, 2026-10-11: "say I approve one,
   the next comes out with a complete off-the-wall style and concept"). Offline + deterministic (fetch injected, real temp
   workspace), in the image.test.js mold. Proves, per route: OpenRouter sends the reference as an image_url part beside the
   text; the ChatGPT plan as an input_image part; the OpenAI Images API through /images/edits (multipart, the reference as
   the `image` file). Where a connection cannot carry it (DALL-E, a base URL with no edits endpoint, a GIF on the Images API)
   the image is rendered from the prompt alone and the result SAYS so; a refusal still fails like any render. A missing /
   URL / escaping / non-image reference fails BEFORE anything is spent. Without a reference every wire is byte-identical.
   The PRODUCT photo (2026-11-09, a seller's marketer redrew the product instead of using it) is the item to KEEP: it rides
   every route with a keep-it-exact instruction (first, before any style reference), and where a route cannot carry it the
   call is REFUSED, never rendered from the prompt alone as a lookalike. */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');
const TasteRef = require('../sidecar/tasteref.js');

const ROOT = path.join(os.tmpdir(), 'starnet-image-ref-test-' + process.pid);
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA_URL = 'data:image/png;base64,' + PNG_B64;
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    let body = null; try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (_) {}
    calls.push({ url: String(url), body, init });
    return handler(String(url), body, init);
  };
  fn.calls = calls;
  return fn;
}
const jsonResp = (obj, status) => ({ status: status || 200, json: async () => obj, text: async () => JSON.stringify(obj), arrayBuffer: async () => Buffer.alloc(0), headers: { get: () => 'application/json' } });
const orImage = () => jsonResp({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] });
const oaImage = () => jsonResp({ data: [{ b64_json: PNG_B64 }] });
const anchorFor = (args, out) => TasteRef.buildRef({ rows: [
  {role:'assistant',tool_calls:[{id:'anchor',type:'function',function:{name:'image_generate',arguments:JSON.stringify(args)}}]},
  {role:'tool',tool_call_id:'anchor',content:out.content}
] });
const rejects = async (p, re, msg) => { let m = ''; try { await p; } catch (e) { m = String(e && e.message || e); } A.ok(re.test(m), msg + ' (got: ' + m + ')'); };

(async () => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}
  const ctx = { agentId: 'hero', emit: () => {} };
  const refBytes = Buffer.from(PNG_B64, 'base64');
  await fsp.mkdir(path.join(ROOT, 'hero', 'images'), { recursive: true });
  await fsp.writeFile(path.join(ROOT, 'hero', 'images', 'approved.png'), refBytes);
  await fsp.writeFile(path.join(ROOT, 'hero', 'images', 'anim.gif'), Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'));
  await fsp.writeFile(path.join(ROOT, 'hero', 'notes.txt'), 'not an image');
  const refUrl = 'data:image/png;base64,' + refBytes.toString('base64');

  // ---- schema: one optional string, named in the description ----
  {
    const T = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: async () => orImage() });
    A.eq(T.generateTool.schema.properties.reference, { type: 'string' }, 'reference is one optional string (schema bytes are budgeted)');
    A.ok(T.generateTool.schema.required.indexOf('reference') < 0, 'and never required');
    A.ok(/"reference": an image file \(e\.g\. an APPROVED one\) whose style, palette and concept to match/.test(T.generateTool.description), 'the description teaches it');
  }

  // ---- OpenRouter: an image_url part beside the text ----
  {
    const f = stubFetch(() => orImage());
    const T = makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: f });
    const out = await T.generateTool.run({ prompt: 'a candle shop banner', reference: 'images/approved.png', aspect_ratio: '16:9' }, ctx);
    const content = f.calls[0].body.messages[0].content;
    A.ok(Array.isArray(content) && content.length === 2, 'the user turn carries two parts');
    A.eq(content[0], { type: 'text', text: 'Match the attached reference image: the same art style, colour palette, lighting and overall concept. a candle shop banner' }, 'text first, with the match instruction');
    A.eq(content[1], { type: 'image_url', image_url: { url: refUrl } }, 'the reference file\'s own bytes as a data URL');
    A.eq(f.calls[0].body.image_config, { aspect_ratio: '16:9' }, 'the shape still rides image_config');
    A.ok(/\nReference: images\/approved\.png was sent to the model as the style to match\./.test(out.content), 'the result says it was SENT (not that it matched)');
    A.ok(/^image → images\/gen-[0-9a-f]+\.png$/.test(out.summary), 'the summary stays exactly "image → <rel>" (artifacts.js reads the path from it)');
    // the design anchor reads the call back: the reference arg is captured with the render
    const rows = [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a candle shop banner', reference: 'images/approved.png', aspect_ratio: '16:9' }) } }] }, { role: 'tool', tool_call_id: 'c1', content: out.content }];
    A.eq(TasteRef.imageCalls(rows)[0].reference, 'images/approved.png', 'tasteref pairs the reference with the saved render');
    const actual = anchorFor({prompt:'a candle shop banner',reference:'images/approved.png',aspect_ratio:'16:9'}, out);
    A.eq(actual.images[0].aspect, '1x1', 'the anchor records the saved square bytes, not the requested wide shape');
    A.ok(!/matching images/.test(TasteRef.refLine(actual,0)), 'sending a reference does not prove the model matched it');

    // a GIF is fine on this route
    const g = stubFetch(() => orImage());
    await makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: g }).generateTool.run({ prompt: 'x', reference: 'images/anim.gif' }, ctx);
    A.ok(/^data:image\/gif;base64,/.test(g.calls[0].body.messages[0].content[1].image_url.url), 'a GIF reference rides as image/gif');
    // without a reference the wire is unchanged
    const n = stubFetch(() => orImage());
    await makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: n }).generateTool.run({ prompt: 'plain' }, ctx);
    A.eq(n.calls[0].body.messages, [{ role: 'user', content: 'plain' }], 'no reference = the old plain-string user turn');
  }

  // ---- bad references fail BEFORE anything is spent ----
  for (const [reference, re, why] of [
    ['images/missing.png', /reference image not found: images\/missing\.png/, 'a missing file'],
    ['https://example.com/a.png', /not a URL/, 'a URL'],
    ['../other/x.png', /illegal path|escape/, 'an escaping path'],
    ['notes.txt', /must be a PNG, JPEG, WEBP or GIF image/, 'a non-image']
  ]) {
    const f = stubFetch(() => orImage());
    await rejects(makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: f }).generateTool.run({ prompt: 'x', reference }, ctx), re, why + ' is refused');
    A.eq(f.calls.length, 0, why + ': no provider call, nothing spent');
  }

  // ---- the ChatGPT plan: an input_image part on the Responses wire ----
  {
    const jwt = 'h.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url') + '.sig';
    const events = [{ type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG_B64 } }, { type: 'response.completed', response: { output: [] } }];
    const f = stubFetch(() => ({ status: 200, text: async () => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') }));
    const T = makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: f });
    const out = await T.generateTool.run({ prompt: 'a poster', reference: 'images/approved.png' }, ctx);
    const parts = f.calls[0].body.input[0].content;
    A.eq(parts[0], { type: 'input_text', text: 'Match the attached reference image: the same art style, colour palette, lighting and overall concept. a poster' }, 'the plan route gets the match instruction');
    A.eq(parts[1], { type: 'input_image', image_url: refUrl }, 'and the reference as an input_image part');
    A.ok(/Reference: images\/approved\.png was sent/.test(out.content), 'reported as sent');
    const plain = stubFetch(() => ({ status: 200, text: async () => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') }));
    await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: plain }).generateTool.run({ prompt: 'a poster' }, ctx);
    A.eq(plain.calls[0].body.input[0].content, [{ type: 'input_text', text: 'a poster' }], 'no reference = the old single text part');
  }

  // ---- the OpenAI Images API: /images/edits, multipart ----
  {
    const f = stubFetch(url => url.endsWith('/images/edits') ? oaImage() : jsonResp({}, 500));
    const T = makeImageTools({ openrouter: { apiKey: 'oa-key', provider: 'openai', protocol: 'openai-images', baseUrl: 'https://api.openai.com/v1/' }, fsp, pathMod: path, root: ROOT, fetchImpl: f });
    const out = await T.generateTool.run({ prompt: 'a fox logo', reference: 'images/approved.png', transparent: true, aspect_ratio: 'portrait' }, ctx);
    A.eq(f.calls.length, 1, 'one call');
    A.eq(f.calls[0].url, 'https://api.openai.com/v1/images/edits', 'a referenced render goes to /images/edits');
    const form = f.calls[0].init.body;
    A.ok(form instanceof FormData, 'multipart form body');
    A.eq(f.calls[0].init.headers, { Authorization: 'Bearer oa-key' }, 'the key, and no JSON content-type (fetch sets the multipart boundary)');
    A.eq([form.get('model'), form.get('size'), form.get('background'), form.get('output_format')], ['gpt-image-2', '1024x1536', 'transparent', 'png'], 'model, size and transparency ride as fields');
    A.ok(/^Match the attached reference image: .* a fox logo/.test(form.get('prompt')), 'the prompt carries the match instruction');
    const img = form.get('image');
    A.ok(img && img.type === 'image/png' && img.size === refBytes.length && img.name === 'reference.png', 'the reference file is the image part');
    A.ok(/Reference: images\/approved\.png was sent/.test(out.content), 'reported as sent');
    const opaque = anchorFor({prompt:'a fox logo',reference:'images/approved.png',transparent:true,aspect_ratio:'portrait'},out);
    A.ok(/NOT TRANSPARENT|Transparency NOT verified/.test(out.content), 'the saved bytes do not prove transparent output');
    A.ok(!opaque.images[0].transparent && !/, transparent/.test(TasteRef.refLine(opaque,0)), 'the design anchor does not promote the transparency request into an observed property');

    // a base URL that does not serve /images/edits: rendered from the prompt alone, and said so
    const g = stubFetch(url => url.endsWith('/images/edits') ? jsonResp({ error: { message: 'Not found' } }, 404) : oaImage());
    const fb = await makeImageTools({ openrouter: { apiKey: 'oa-key', provider: 'openai', protocol: 'openai-images', baseUrl: 'http://127.0.0.1:9/v1' }, fsp, pathMod: path, root: ROOT, fetchImpl: g }).generateTool.run({ prompt: 'a fox logo', reference: 'images/approved.png' }, ctx);
    A.eq(g.calls.map(c => c.url.replace(/^.*\/images\//, '')), ['edits', 'generations'], 'edits 404 -> one plain generation');
    A.eq(g.calls[1].body, { model: 'gpt-image-2', prompt: 'a fox logo', size: '1024x1024' }, 'the fallback is the ordinary request (no reference text pretending)');
    A.ok(/\nReference NOT used: this connection has no image-edit endpoint \(http 404\), so this image was rendered from the prompt alone\. Do not describe it as matching images\/approved\.png\./.test(fb.content), 'the result says the reference was NOT used: ' + fb.content);
    const dropped = anchorFor({prompt:'a fox logo',reference:'images/approved.png'},fb);
    A.ok(!dropped.images[0].reference && !/approved.png|matching/.test(TasteRef.refLine(dropped,0)), 'the saved anchor omits a reference the route could not send');
    // a refusal is not a missing endpoint: it fails like any render
    const h = stubFetch(url => url.endsWith('/images/edits') ? jsonResp({ error: { message: 'content policy' } }, 400) : oaImage());
    await rejects(makeImageTools({ openrouter: { apiKey: 'oa-key', provider: 'openai', protocol: 'openai-images' }, fsp, pathMod: path, root: ROOT, fetchImpl: h }).generateTool.run({ prompt: 'x', reference: 'images/approved.png' }, ctx), /OpenAI 400: content policy/, 'an edits refusal propagates');
    A.eq(h.calls.length, 1, 'and is not silently re-rendered without the reference');
    // DALL-E and a GIF cannot take a reference here: no edits call, an honest note
    for (const [args, re, why] of [
      [{ prompt: 'x', model: 'dall-e-3', reference: 'images/approved.png' }, /Reference NOT used: dall-e-3 cannot take a reference image/, 'DALL-E'],
      [{ prompt: 'x', reference: 'images/anim.gif' }, /Reference NOT used: the OpenAI Images API takes a PNG, JPEG or WEBP reference, not image\/gif/, 'a GIF']
    ]) {
      const k = stubFetch(() => oaImage());
      const o = await makeImageTools({ openrouter: { apiKey: 'oa-key', provider: 'openai', protocol: 'openai-images' }, fsp, pathMod: path, root: ROOT, fetchImpl: k }).generateTool.run(args, ctx);
      A.ok(k.calls.length === 1 && /\/images\/generations$/.test(k.calls[0].url) && re.test(o.content), why + ': rendered from the prompt, reported plainly');
    }
  }

  // ---- PRODUCT PHOTO (2026-11-09: a seller's marketer redrew the product instead of using it): the real item to KEEP ----
  {
    const prodBytes = Buffer.concat([refBytes, Buffer.from('the real mug')]);   // distinct bytes, so order is provable
    await fsp.writeFile(path.join(ROOT, 'hero', 'images', 'product.png'), prodBytes);
    await fsp.writeFile(path.join(ROOT, 'hero', 'images', 'product.gif'), Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'));
    const prodUrl = 'data:image/png;base64,' + prodBytes.toString('base64');
    const KEEP = 'Keep that product exactly as it is: the same shape, proportions, colours, materials, printed design, text and logos. Do not redesign, redraw, restyle or replace it; change only the scene around it (setting, people, props, lighting). ';
    const SOLO = 'Feature the exact product shown in the attached photo. ' + KEEP;
    const BOTH = 'The FIRST attached image is the exact product to feature. ' + KEEP + 'The SECOND attached image is a style reference for the scene only: match its art style, colour palette, lighting and overall concept, but never change the product to match it. ';
    const SENT = /\nProduct: images\/product\.png was sent to the model as the product to keep unchanged\. The station cannot prove every detail survived: check the render \(image_analyze\) before presenting it as the real product\./;

    // schema + description
    const S = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: async () => orImage() });
    A.eq(S.generateTool.schema.properties.product, { type: 'string' }, 'product is one optional string');
    A.ok(S.generateTool.schema.required.indexOf('product') < 0, 'and never required');
    A.ok(/"product": a photo file of a REAL product/.test(S.generateTool.description) && /as a "reference" it comes back redrawn/.test(S.generateTool.description), 'the description steers a product photo to "product", not "reference"');

    // OpenRouter, product alone: the keep instruction + the photo
    const f = stubFetch(() => orImage());
    const out = await makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: f }).generateTool.run({ prompt: 'a woman holding it in a sunny cafe', product: 'images/product.png' }, ctx);
    A.eq(f.calls[0].body.messages[0].content, [{ type: 'text', text: SOLO + 'a woman holding it in a sunny cafe' }, { type: 'image_url', image_url: { url: prodUrl } }], 'OpenRouter: the keep-it-exact instruction, then the product photo');
    A.ok(SENT.test(out.content), 'the result says the product photo was SENT, and that the render still needs a look: ' + out.content);
    A.ok(!/\nReference/.test(out.content), 'no style-reference line for a product-only render');
    const rows = [{ role: 'assistant', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'x', product: 'images/product.png' }) } }] }, { role: 'tool', tool_call_id: 'p1', content: out.content }];
    A.eq(TasteRef.imageCalls(rows)[0].reference, '', 'the design anchor never records a product photo as a style it matched');

    // OpenRouter, product + style reference: product FIRST, then the style
    const b = stubFetch(() => orImage());
    const both = await makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: b }).generateTool.run({ prompt: 'flat lay', product: 'images/product.png', reference: 'images/approved.png' }, ctx);
    A.eq(b.calls[0].body.messages[0].content, [{ type: 'text', text: BOTH + 'flat lay' }, { type: 'image_url', image_url: { url: prodUrl } }, { type: 'image_url', image_url: { url: refUrl } }], 'OpenRouter: product photo first, style reference second, each named in the text');
    A.ok(SENT.test(both.content) && /\nReference: images\/approved\.png was sent to the model as the style to match\./.test(both.content), 'both receipts');

    // the ChatGPT plan: both as input_image parts, product first
    const jwt = 'h.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url') + '.sig';
    const events = [{ type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG_B64 } }, { type: 'response.completed', response: { output: [] } }];
    const c = stubFetch(() => ({ status: 200, text: async () => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') }));
    const cOut = await makeImageTools({ openrouter: { provider: 'codex', protocol: 'codex-responses', getToken: async () => jwt }, fsp, pathMod: path, root: ROOT, fetchImpl: c }).generateTool.run({ prompt: 'on a shelf', product: 'images/product.png', reference: 'images/approved.png' }, ctx);
    A.eq(c.calls[0].body.input[0].content, [{ type: 'input_text', text: BOTH + 'on a shelf' }, { type: 'input_image', image_url: prodUrl }, { type: 'input_image', image_url: refUrl }], 'the plan route: product then style as input_image parts');
    A.ok(SENT.test(cOut.content), 'reported as sent');

    // the OpenAI Images API: /images/edits, the product photo as the `image` file
    const oa = (extra) => makeImageTools(Object.assign({ openrouter: { apiKey: 'oa-key', provider: 'openai', protocol: 'openai-images', baseUrl: 'https://api.openai.com/v1/' }, fsp, pathMod: path, root: ROOT }, extra));
    const e1 = stubFetch(url => url.endsWith('/images/edits') ? oaImage() : jsonResp({}, 500));
    const eOut = await oa({ fetchImpl: e1 }).generateTool.run({ prompt: 'on a model', product: 'images/product.png' }, ctx);
    const form = e1.calls[0].init.body;
    A.ok(e1.calls.length === 1 && e1.calls[0].url.endsWith('/images/edits'), 'a product render goes to /images/edits');
    A.eq(form.get('prompt'), SOLO + 'on a model', 'with the keep instruction');
    A.ok(form.get('image') && form.get('image').name === 'product.png' && form.get('image').size === prodBytes.length && form.getAll('image[]').length === 0, 'one input = the `image` file, the product photo');
    A.ok(SENT.test(eOut.content), 'reported as sent');
    // product + style reference: two `image[]` files, product first
    const e2 = stubFetch(url => url.endsWith('/images/edits') ? oaImage() : jsonResp({}, 500));
    await oa({ fetchImpl: e2 }).generateTool.run({ prompt: 'flat lay', product: 'images/product.png', reference: 'images/approved.png' }, ctx);
    const two = e2.calls[0].init.body.getAll('image[]');
    A.eq(two.map(x => [x.name, x.size]), [['product.png', prodBytes.length], ['reference.png', refBytes.length]], 'two inputs = two `image[]` files, product first');
    A.eq(e2.calls[0].init.body.get('prompt'), BOTH + 'flat lay', 'with both named in the prompt');
    // a GIF style reference the Images API cannot take: the product still goes, the reference is said NOT used
    const e3 = stubFetch(url => url.endsWith('/images/edits') ? oaImage() : jsonResp({}, 500));
    const gOut = await oa({ fetchImpl: e3 }).generateTool.run({ prompt: 'x', product: 'images/product.png', reference: 'images/anim.gif' }, ctx);
    A.ok(e3.calls.length === 1 && e3.calls[0].init.body.get('image').name === 'product.png' && e3.calls[0].init.body.get('prompt') === SOLO + 'x', 'the product alone rides /images/edits, with the product-only instruction');
    A.ok(SENT.test(gOut.content) && /Reference NOT used: the OpenAI Images API takes a PNG, JPEG or WEBP reference, not image\/gif/.test(gOut.content), 'product sent, reference plainly not used');

    // NEVER a lookalike: where the photo cannot ride, nothing is drawn
    const e4 = stubFetch(url => url.endsWith('/images/edits') ? jsonResp({ error: { message: 'Not found' } }, 404) : oaImage());
    await rejects(oa({ fetchImpl: e4 }).generateTool.run({ prompt: 'x', product: 'images/product.png' }, ctx), /no image-edit endpoint \(http 404\), so it cannot place the real product photo images\/product\.png and will not draw a lookalike\. No image was produced\./, 'no edits endpoint: refused, not re-rendered from the prompt');
    A.eq(e4.calls.map(x => x.url.replace(/^.*\/images\//, '')), ['edits'], 'and no plain generation followed');
    for (const [args, re, why] of [
      [{ prompt: 'x', model: 'dall-e-3', product: 'images/product.png' }, /dall-e-3 cannot take a product photo, so it could only draw a lookalike of images\/product\.png/, 'DALL-E'],
      [{ prompt: 'x', product: 'images/product.gif' }, /takes a PNG, JPEG or WEBP product photo, not image\/gif/, 'a GIF product photo']
    ]) {
      const k = stubFetch(() => oaImage());
      await rejects(oa({ fetchImpl: k }).generateTool.run(args, ctx), re, why + ' on the Images API is refused');
      A.eq(k.calls.length, 0, why + ': refused before anything was spent');
    }

    // bad product paths fail BEFORE anything is spent, and say what to do
    for (const [product, re, why] of [
      ['https://i.etsystatic.com/x/il_794xN.jpg', /product must be a photo file in your workspace or project .*not a URL: save the real product photo into your workspace first, or ask the Commander to attach it/, 'a listing URL'],
      ['images/missing.jpg', /product photo not found: images\/missing\.jpg/, 'a missing file'],
      ['notes.txt', /product must be a PNG, JPEG, WEBP or GIF image/, 'a non-image']
    ]) {
      const k = stubFetch(() => orImage());
      await rejects(makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: k }).generateTool.run({ prompt: 'x', product }, ctx), re, why + ' is refused');
      A.eq(k.calls.length, 0, why + ': no provider call, nothing spent');
    }
  }

  try { fssync.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  A.report('image-reference.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
