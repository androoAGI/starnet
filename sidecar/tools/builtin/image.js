/* sidecar/tools/builtin/image.js — the STUDIO capability: image_generate(prompt) + image_analyze(image).

   Both skills ride the SAME BYOK OpenRouter key the agent already uses, hitting the chat-completions
   endpoint — no new provider, no new key, fully additive (matches the web.js pattern exactly):

     image_generate  : POST /chat/completions with modalities:['image','text']. The model returns a
                       base64 data-URL PNG in choices[0].message.images[]; we decode it and save it into
                       the agent's JAILED workspace (same guard as fs.write), emit a 'deliverable' event so
                       the UI shows it, and hand back the /api/file?agent=…&path=… viewer URL.
                       Default model: google/gemini-2.5-flash-image (override via args.model — e.g.
                       black-forest-labs/flux.2-pro, recraft/recraft-v4).
     image_analyze   : vision Q&A over a workspace image / http(s) URL. TWO routes, tried in order (the
                       reference harness's auxiliary-vision pattern — vision must never dead-end on one vendor key):
                         1. OpenRouter chat-completions with a dedicated vision model (when a key exists);
                         2. deps.auxVision — the RUN's OWN provider/model (injected by the run host), so a
                            session on Anthropic/Gemini/Codex/any vision-capable provider can look at images
                            with ZERO extra keys. The old behavior (hard error demanding an OpenRouter key)
                            was the root of a live user bug: blind agents asked users for a key they never needed.

   makeImageTools({ openrouter:{apiKey, model?, baseUrl?}, fsp, pathMod, root, fetchImpl?, imageModel?, visionModel?,
                    auxVision? })   // auxVision: async ({ messages, timeoutMs }) -> text (session-provider one-shot)
     -> { generateTool, analyzeTool, register(reg), _internals }

   Node 18+ (global fetch). No dependencies. Reuses the fs.js workspace jail so a generated/analyzed path
   can never escape <root>/<agentId>/. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./fs.js'));
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).image = factory(root.SK.tools.builtin.fs); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fsMod) {
  'use strict';

  const DEFAULT_OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
  // 2026-07-07 image-quality escape: the old default (gemini-2.5-flash-image, "Nano Banana 1") is the OLDEST
  // image model in the live OpenRouter catalog — garbled text on UI mockups/marketing assets was its signature.
  // Default = current-gen fast (Nano Banana 2); PREMIUM = Nano Banana Pro (built for legible text / hero art);
  // LEGACY = the old slug, kept as the automatic fallback if the newer slug ever errors on this account.
  const DEFAULT_IMAGE_MODEL  = 'google/gemini-3.1-flash-image';   // text->image; override per call via args.model
  const PREMIUM_IMAGE_MODEL  = 'google/gemini-3-pro-image';       // readable text, hero/marketing quality
  const LEGACY_IMAGE_MODEL   = 'google/gemini-2.5-flash-image';   // known-good everywhere; the fallback wire
  const DEFAULT_VISION_MODEL = 'google/gemini-2.5-flash';         // image->text (multimodal); override via args.model
  // OpenRouter image_config.aspect_ratio passthrough — the set the Gemini image endpoints accept.
  const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
  // Named shapes the model (or a human) tends to say instead of numbers.
  const ASPECT_WORDS = {
    square: '1:1', landscape: '3:2', wide: '16:9', widescreen: '16:9', banner: '21:9', ultrawide: '21:9',
    cinematic: '21:9', wallpaper: '16:9', desktop: '16:9', portrait: '2:3', tall: '9:16', story: '9:16',
    phone: '9:16', mobile: '9:16', vertical: '9:16', horizontal: '16:9', post: '4:5', instagram: '4:5'
  };
  const MAX_OUTPUT_PX = 8192;   // hard cap on a requested width/height

  // Any shape the caller asks for -> the provider ratio that matches it best, plus exact pixel dims
  // when the caller gave them. Accepts '16:9', '16/9', '1920x1080', '1920×1080', '1.777', 'landscape',
  // or separate width/height args. Returns null for an unparseable request.
  //   { ratio:'16:9', width, height, exact:boolean }   (width/height only when pixels were requested)
  function resolveShape(aspect, width, height) {
    const w = Number(width) || 0, h = Number(height) || 0;
    let rw = 0, rh = 0;
    const s = String(aspect == null ? '' : aspect).trim().toLowerCase();
    if (s) {
      if (ASPECT_RATIOS.indexOf(s) >= 0) { const p = s.split(':'); rw = +p[0]; rh = +p[1]; }
      else if (ASPECT_WORDS[s]) { const p = ASPECT_WORDS[s].split(':'); rw = +p[0]; rh = +p[1]; }
      else {
        let m = s.match(/^(\d+(?:\.\d+)?)\s*[:\/]\s*(\d+(?:\.\d+)?)$/);
        if (m) { rw = +m[1]; rh = +m[2]; }
        else if ((m = s.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})(?:\s*px)?$/))) {
          // pixel dims given as the "aspect" — treat as an exact size request
          return resolveShape('', +m[1], +m[2]);
        }
        else if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) { rw = +m[1]; rh = 1; }
        else return null;
      }
      if (!(rw > 0) || !(rh > 0)) return null;
    }
    if (w || h) {
      if (!(w > 0 && h > 0)) return null;                // both or neither
      if (w > MAX_OUTPUT_PX || h > MAX_OUTPUT_PX) return null;
      if (!rw) { rw = w; rh = h; }
    }
    if (!rw) return { ratio: '', width: 0, height: 0, exact: false };
    const want = rw / rh;
    let best = ASPECT_RATIOS[0], bestD = Infinity;
    for (const r of ASPECT_RATIOS) {
      const p = r.split(':'); const d = Math.abs(Math.log((+p[0]) / (+p[1])) - Math.log(want));
      if (d < bestD) { bestD = d; best = r; }
    }
    return { ratio: best, width: Math.round(w), height: Math.round(h), exact: !!(w && h) };
  }

  // Fit generated bytes to an exact WxH (cover-crop, centred). Uses sharp when present; returns null
  // when it isn't so the caller can ship the nearest-ratio image honestly instead of failing.
  async function fitToSize(buffer, width, height) {
    let sharp; try { sharp = require('sharp'); } catch (_) { return null; }
    try {
      const out = await sharp(buffer).resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
      return { buffer: out, mime: 'image/png' };
    } catch (_) { return null; }
  }
  const GEN_TIMEOUT_MS    = 110000;   // image generation can take 10-40s; the tool-level timeout sits above this
  const ANALYZE_TIMEOUT_MS = 55000;
  const ANALYZE_RETURN_CHARS = 8000;
  const MAX_IMAGE_BYTES   = 8 * 1024 * 1024;   // refuse to read a workspace image larger than this for analysis

  const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

  function checkCancelled(signal) {
    if (signal && signal.aborted) {
      const error = new Error('Image operation cancelled; no image was published. Upstream work may already have been billed.');
      error.name = 'AbortError'; throw error;
    }
  }
  async function withTimeout(promiseFactory, ms, parentSignal) {
    checkCancelled(parentSignal);
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    if (parentSignal) parentSignal.addEventListener('abort', abort, { once: true });
    const t = setTimeout(abort, ms);
    try { return await promiseFactory(ctrl.signal); }
    finally { clearTimeout(t); if (parentSignal) parentSignal.removeEventListener('abort', abort); }
  }
  let publicationSequence = 0;

  // Pull the first image (data-URL or http URL) out of an OpenRouter chat-completions response. Providers vary:
  // most return choices[0].message.images[] = [{type:'image_url', image_url:{url}}], but some nest the image in
  // message.content[] parts, and the url field is sometimes a bare string. Be liberal in what we accept.
  function imageUrlFromPart(p) {
    if (!p) return '';
    if (typeof p === 'string') return p;
    if (p.image_url) return (typeof p.image_url === 'string') ? p.image_url : (p.image_url.url || '');
    if (p.url) return p.url;
    if (p.b64_json) return 'data:image/png;base64,' + p.b64_json;
    return '';
  }
  function parseImageFromResponse(data) {
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return '';
    if (Array.isArray(msg.images)) { for (const im of msg.images) { const u = imageUrlFromPart(im); if (u) return u; } }
    if (Array.isArray(msg.content)) { for (const p of msg.content) { if (p && (p.type === 'image_url' || p.type === 'output_image' || p.image_url || p.url)) { const u = imageUrlFromPart(p); if (u) return u; } } }
    return '';
  }
  // Any plain text the model emitted alongside the image (e.g. a caption / refusal). Used for the tool summary.
  function textFromResponse(data) {
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) return msg.content.filter(p => p && p.type === 'text').map(p => p.text || '').join(' ').trim();
    return '';
  }

  // "data:image/png;base64,AAAA" -> { mime, buffer }. Throws on a malformed/oversized data URL.
  function dataUrlToBuffer(url) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(String(url || ''));
    if (!m) throw new Error('not a data URL');
    const mime = (m[1] || 'image/png').toLowerCase();
    const isB64 = !!m[2];
    const buf = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    if (!buf.length) throw new Error('empty image data');
    return { mime, buffer: buf };
  }

  function extOf(P, p) { return String(P.extname(p) || '').toLowerCase(); }

  function makeImageTools(deps) {
    deps = deps || {};
    const or = deps.openrouter || {};
    const apiKey = or.apiKey || deps.apiKey || '';
    const providerLabel = or.provider === 'starnet' ? 'StarNet' : 'OpenRouter';
    const orBaseUrl = String(or.baseUrl || deps.baseUrl || '').trim().replace(/\/+$/, '');
    const orUrl = orBaseUrl ? orBaseUrl + '/chat/completions' : DEFAULT_OR_URL;
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root;
    if (!fsp || !P || !ROOT) throw new Error('image.js requires { fsp, pathMod, root }');
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('image.js requires global fetch (Node 18+) or deps.fetchImpl');
    const IMAGE_MODEL  = deps.imageModel  || DEFAULT_IMAGE_MODEL;
    const VISION_MODEL = deps.visionModel || or.model || DEFAULT_VISION_MODEL;
    // Auxiliary vision route: a one-shot text answer from the RUN's own provider/model (injected by the run
    // host). Used when no OpenRouter key exists — and as the rescue when the OpenRouter call FAILS (dead key,
    // out of credits, model rot) — so vision never dead-ends on one vendor.
    const auxVision = typeof deps.auxVision === 'function' ? deps.auxVision : null;
    // reuse the ONE workspace jail (fs.js) so generated/analyzed paths can't escape the agent's directory
    const jail = fsMod.makeFsTools({ fsp, pathMod: P, root: ROOT })._internals;

    function emitDeliverable(ctx, aid, rel) {
      if (!ctx || typeof ctx.emit !== 'function') return;
      const d = { id: 'img_' + String(rel).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'image', title: String(rel) };
      if (ctx.room) d.room = ctx.room;
      ctx.emit('deliverable', d);
    }

    async function orPost(body, timeoutMs, parentSignal) {
      checkCancelled(parentSignal);
      if (!apiKey) throw new Error('STUDIO image generation is unavailable: no media connection is configured. Open SETTINGS and connect an OpenRouter API key for image generation, or link this station to your StarNet account, then retry; no image was produced.');
      const res = await withTimeout(signal => doFetch(orUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://starnet.local', 'X-Title': 'STARNET' },
        body: JSON.stringify(body),
        signal
      }).then(async r => {
        const json = await r.json().catch(() => null);
        // Book the provider's response before checking cancellation or decoding the artifact.
        // A billed refusal, failed download, or cancelled publication still incurred this cost.
        if (typeof deps.onUsage === 'function' && (r.status >= 200 && r.status < 300 || json && json.usage)) {
          deps.onUsage(json && json.usage, body.model);
        }
        return { status: r.status, json, text: null };
      }), timeoutMs, parentSignal || deps.signal);
      if (res.status < 200 || res.status >= 300) {
        const errMsg = res.json && res.json.error && (res.json.error.message || res.json.error) || ('http ' + res.status);
        throw new Error(providerLabel + ' ' + res.status + ': ' + (typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)));
      }
      return res.json || {};
    }

    // ---------------- image_generate ----------------
    const generateTool = {
      name: 'image_generate', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: GEN_TIMEOUT_MS + 15000,
      description: 'Generate an image from a text prompt and SAVE it into your workspace (returns the saved path + a viewer URL). ' +
        'Use for any "draw / create / generate an image of …" request. Optional "model" picks the image model: ' +
        'default ' + DEFAULT_IMAGE_MODEL + ' (fast, current-gen). For HERO/MARKETING assets or ANY image that must show ' +
        'READABLE TEXT (UI mockups, landing pages, posters, infographics, product concepts), pass model:"' + PREMIUM_IMAGE_MODEL + '" ' +
        '— it renders legible text; the fast tier garbles it. Optional "path" sets the output filename. ' +
        'Optional "aspect_ratio" sets the image shape — ANY ratio or size works: "16:9", "4:3", "1920x1080", "1.5", ' +
        'or a word like "landscape"/"portrait"/"wide"/"tall"/"banner"/"story" (default 1:1; the provider renders the nearest of ' +
        ASPECT_RATIOS.join(', ') + '). Optional "width"+"height" (pixels, max ' + MAX_OUTPUT_PX + ') deliver an EXACT resolution — ' +
        'the image is generated at the nearest ratio then fitted to those pixels. Use 16:9 for widescreen/banner/desktop-wallpaper ' +
        'requests, 9:16 for phone/story formats, and width/height when the user names a resolution.',
      schema: { type: 'object', required: ['prompt'], properties: {
        prompt: { type: 'string' },
        model: { type: 'string' },
        path: { type: 'string' },
        aspect_ratio: { type: 'string', description: 'any W:H ratio, WxH pixel size, or shape word (landscape, portrait, wide, tall, banner, story, square)' },
        width: { type: 'integer', minimum: 16, maximum: MAX_OUTPUT_PX },
        height: { type: 'integer', minimum: 16, maximum: MAX_OUTPUT_PX }
      } },
      run: async (args, ctx) => {
        const signal = ctx && ctx.signal;
        checkCancelled(signal);
        const aid = (ctx && ctx.agentId) || 'agent';
        const prompt = String(args.prompt || '').trim();
        if (!prompt) throw new Error('prompt is required');
        let model = String(args.model || IMAGE_MODEL);
        // Aspect ratio rides OpenRouter's image_config passthrough — prose in the prompt is
        // mostly ignored by the Gemini image models, so this field is the only real dial.
        const shape = resolveShape(args.aspect_ratio, args.width, args.height);
        if (!shape) {
          throw new Error('could not understand the requested image shape (aspect_ratio "' + String(args.aspect_ratio || '') +
            '", width ' + String(args.width || '') + ', height ' + String(args.height || '') + ') — give a W:H ratio like 16:9, ' +
            'a WxH size like 1920x1080, a word like landscape/portrait, or both width and height (16..' + MAX_OUTPUT_PX + 'px); no image was produced.');
        }
        const aspect = shape.ratio;
        const baseBody = {
          messages: [{ role: 'user', content: prompt }],
          modalities: ['image', 'text']
        };
        if (aspect) baseBody.image_config = { aspect_ratio: aspect };
        let data;
        try {
          data = await orPost(Object.assign({ model }, baseBody), GEN_TIMEOUT_MS, signal);
        } catch (e) {
          // slug-drift safety net: if the CHOSEN model is rejected as unknown/unavailable (400/404 "not a valid
          // model" / "no endpoints"), retry ONCE on the known-good legacy slug instead of failing the whole task.
          // Only for model-shaped rejections — a rate-limit/timeout/content error propagates untouched.
          checkCancelled(signal);
          const msg = String((e && e.message) || e);
          const modelish = /\b(400|404)\b/.test(msg) && /model|endpoint/i.test(msg);
          if (!modelish || model === LEGACY_IMAGE_MODEL) throw e;
          model = LEGACY_IMAGE_MODEL;
          data = await orPost(Object.assign({ model }, baseBody), GEN_TIMEOUT_MS, signal);
        }
        checkCancelled(signal);
        const url = parseImageFromResponse(data);
        if (!url) {
          const txt = textFromResponse(data);
          throw new Error('model returned no image' + (txt ? ' (' + txt.slice(0, 200) + ')' : '') + ' — is "' + model + '" an image-output model?');
        }
        // materialize the bytes (data-URL decode, or fetch a hosted URL)
        let mime, buffer;
        if (/^data:/i.test(url)) { ({ mime, buffer } = dataUrlToBuffer(url)); }
        else if (/^https?:\/\//i.test(url)) {
          const r = await withTimeout(signal => doFetch(url, { signal }).then(async rr => ({ status: rr.status, ab: await rr.arrayBuffer(), ct: rr.headers.get('content-type') || 'image/png' })), 30000, signal);
          if (r.status < 200 || r.status >= 300) throw new Error('could not download generated image (http ' + r.status + ')');
          mime = String(r.ct).split(';')[0].toLowerCase(); buffer = Buffer.from(r.ab);
        } else throw new Error('unrecognized image reference from model');
        checkCancelled(signal);
        if (buffer.length > MAX_IMAGE_BYTES) throw new Error('generated image too large (' + buffer.length + ' bytes)');
        // exact pixel request: fit the nearest-ratio render to the asked-for size (cover-crop, centred)
        let sizeNote = '';
        if (shape.exact) {
          const fitted = await fitToSize(buffer, shape.width, shape.height);
          if (fitted) { buffer = fitted.buffer; mime = fitted.mime; sizeNote = ' fitted to ' + shape.width + 'x' + shape.height; }
          else sizeNote = ' NOT resized to ' + shape.width + 'x' + shape.height + " (image resizer unavailable; shipped at the provider's " + aspect + ' size)';
        }
        // choose a jailed output path (default images/gen-<rand><ext>)
        const ext = EXT_BY_MIME[mime] || '.png';
        let rel = String(args.path || '').trim();
        if (rel) { if (!/\.[a-z0-9]+$/i.test(rel)) rel += ext; }
        else {
          // content-addressed default name: deterministic (no ambient rng — see lint-determinism) AND
          // collision-resistant, so re-generating the same bytes is idempotent rather than piling up files.
          const h = require('node:crypto').createHash('sha1').update(buffer).digest('hex').slice(0, 12);
          rel = 'images/gen-' + h + ext;
        }
        const { abs } = await jail.resolveInside(aid, rel);   // throws on jail escape / abs / '..'
        checkCancelled(signal);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        checkCancelled(signal);
        // Stage bytes separately: abort during a write must not truncate an existing output.
        const staging = abs + '.pending-' + process.pid + '-' + (++publicationSequence);
        try {
          await fsp.writeFile(staging, buffer, { flag: 'wx' });
          checkCancelled(signal);
          // A bounded atomic publication in the same event-loop turn as the cancellation check.
          // An acknowledged cancel cannot interleave between this fence and the rename/event.
          require('node:fs').renameSync(staging, abs);
          emitDeliverable(ctx, aid, rel);
        } finally {
          await fsp.unlink(staging).catch(e => {
            if (!e || e.code !== 'ENOENT') require('../../failopen.js').note('image.staging-cleanup', e);
          });
        }
        const viewer = '/api/file?agent=' + encodeURIComponent(aid) + '&path=' + encodeURIComponent(rel);
        const caption = textFromResponse(data);
        const kb = (buffer.length / 1024).toFixed(0) + ' KB';
        return {
          content: 'Generated and saved ' + rel + ' (' + kb + ', ' + mime + ', model ' + model + (aspect ? ', ' + aspect : '') + sizeNote + ').\nView: ' + viewer + (caption ? '\nModel note: ' + caption : ''),
          summary: 'image → ' + rel
        };
      }
    };

    // ---------------- image_analyze ----------------
    async function imageToUrl(aid, image) {
      const s = String(image || '').trim();
      if (!s) throw new Error('image is required (a workspace path or an http(s) URL)');
      if (/^data:/i.test(s)) return s;                          // already a data URL
      if (/^https?:\/\//i.test(s)) return s;                    // public URL — OpenRouter fetches it server-side
      if (/^[a-z]+:\/\//i.test(s)) throw new Error('only http(s) URLs, data URLs, or workspace paths are allowed');
      // else: a workspace-relative path -> read + base64
      const { abs } = await jail.resolveInside(aid, s);
      let buf;
      try { buf = await fsp.readFile(abs); }
      catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file in workspace: ' + s); throw e; }
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large to analyze (' + buf.length + ' bytes)');
      const mime = MIME_BY_EXT[extOf(P, abs)] || 'image/png';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    }

    // Core vision call, reusable by other tools (e.g. browser.vision). `url` is a data/http(s)
    // image URL; returns the model's answer text (truncated). Route order:
    //   1. OpenRouter dedicated vision model (when a key exists) — deterministic quality, honors modelOverride;
    //   2. the session provider via auxVision — both when no key exists AND when the OpenRouter call fails,
    //      so a dead/broke key degrades to the model the user is already paying for, not to a key demand.
    // Only when BOTH routes are absent/fail does this throw — with an error naming what actually happened.
    function clip(text) { return text.length > ANALYZE_RETURN_CHARS ? text.slice(0, ANALYZE_RETURN_CHARS) + '\n…[truncated]' : text; }
    async function analyzeViaAux(content) {
      const text = String(await auxVision({ messages: [{ role: 'user', content }], timeoutMs: ANALYZE_TIMEOUT_MS }) || '').trim();
      if (!text) throw new Error('the session model returned no text for the image — it may not support vision');
      return text;
    }
    async function analyzeImageUrl(url, question, modelOverride) {
      const model = String(modelOverride || VISION_MODEL);
      const q = String(question || '').trim() || 'Describe this image in detail.';
      const content = [
        { type: 'text', text: q },     // text first, then image — OpenRouter's recommended order
        { type: 'image_url', image_url: { url } }
      ];
      if (!apiKey) {
        if (!auxVision) throw new Error('no vision route available — no OpenRouter API key is connected and no session provider is wired');
        return analyzeViaAux(content);
      }
      let orErr;
      try {
        const data = await orPost({ model, messages: [{ role: 'user', content }] }, ANALYZE_TIMEOUT_MS);
        const text = textFromResponse(data);
        if (!text) throw new Error('vision model "' + model + '" returned no text — is it vision-capable?');
        return text;
      } catch (e) { orErr = e; }
      if (auxVision) {
        try { return await analyzeViaAux(content); }
        catch (e2) {
          throw new Error('vision failed on both routes — OpenRouter: ' + ((orErr && orErr.message) || orErr)
            + '; session model: ' + ((e2 && e2.message) || e2));
        }
      }
      throw orErr;
    }

    const analyzeTool = {
      name: 'image_analyze', capability: 'studio', scope: 'read', requiresConsent: false, timeoutMs: ANALYZE_TIMEOUT_MS + 15000,
      description: 'Look at an image and answer a question about it (vision). "image" is EITHER a file in your workspace ' +
        '(e.g. "images/gen-ab12cd.png") OR a public http(s) image URL. Optional "prompt" is the question (default: a ' +
        'detailed description). Optional "model" overrides the vision model. Works with the session\'s own model when ' +
        'no dedicated vision key is configured — NEVER ask the user for an API key to look at an image.',
      schema: { type: 'object', required: ['image'], properties: {
        image: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' }
      } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const url = await imageToUrl(aid, args.image);
        const full = await analyzeImageUrl(url, args.prompt, args.model);
        const out = clip(full);
        return { content: out, fullContent: out === full ? undefined : full, summary: 'analyzed image (' + full.length + ' chars)' };
      }
    };

    // A vision callback for makeBrowserTools: takes a base64 PNG (CDP screenshot) + question,
    // returns the model's answer. Honest failure (no route) propagates as a thrown Error which
    // browser.vision converts to an 'vision unavailable' result. auxVision counts as a route:
    // a keyless session on a vision-capable provider still gets browser.vision.
    const hasVision = !!apiKey || !!auxVision;
    async function browserVision({ imageBase64, question }) {
      const url = 'data:image/png;base64,' + String(imageBase64 || '');
      return clip(await analyzeImageUrl(url, question));
    }

    return {
      generateTool, analyzeTool, analyzeImageUrl, browserVision, hasVision,
      _internals: { parseImageFromResponse, textFromResponse, dataUrlToBuffer, imageUrlFromPart, imageToUrl, analyzeImageUrl, resolveShape, fitToSize },
      register(reg) { reg.register(generateTool); reg.register(analyzeTool); return reg; }
    };
  }

  return { makeImageTools };
});
