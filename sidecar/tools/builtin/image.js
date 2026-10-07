/* sidecar/tools/builtin/image.js — the STUDIO capability: image_generate(prompt) + image_analyze(image).

   Generation rides the media route resolved by the host: OpenRouter-compatible chat completions,
   OpenAI's dedicated Images API, or the ChatGPT plan (gpt-image-2 through the Codex Responses
   image_generation tool, authorized by the station's ChatGPT sign-in, no API key). Credentials remain
   paired with their provider endpoint.

     image_generate  : POST /chat/completions with modalities:['image','text']. The model returns a
                       base64 data-URL PNG in choices[0].message.images[]; we decode it and save it through
                       the same guard as fs.write (a relative path lands in the project folder of a project-
                       scoped run, else the agent's JAILED workspace — issue #77), emit a 'deliverable' event so
                       the UI shows it, and hand back the absolute location + the /api/file viewer URL.
                       Default model: google/gemini-2.5-flash-image (override via args.model — e.g.
                       black-forest-labs/flux.2-pro, recraft/recraft-v4).
                       TRANSPARENCY: args.transparent (or a prompt that plainly asks for a transparent background)
                       renders on a route that outputs a real alpha channel, then VERIFIES the saved bytes. No
                       Gemini image model can: asked for one, they paint a checkerboard into an opaque PNG.
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
  const DEFAULT_OPENAI_IMAGE_URL = 'https://api.openai.com/v1/images/generations';
  const OPENAI_IMAGE_MODEL = 'gpt-image-2';
  /* 2026-10-01 ChatGPT-plan images (the reference harness's openai-codex image backend): the Codex backend has no
     Images endpoint, but its Responses wire hosts the image_generation tool, so a chat model is asked to call it and
     the rendered PNG comes back as an image_generation_call result. Live probe on a Pro sign-in: 200, a PNG in 18s at
     low quality; background:'transparent' returned a real RGBA PNG. Two wire facts the reference learned the hard way:
     tool_choice must be OMITTED (the backend looks hosted tools up as function names and 400s every forcing shape),
     and originator:codex_cli_rs is required past the Cloudflare layer. The host chat model is fixed: the run's own
     model may be a slug the image tool does not ride. */
  const DEFAULT_CODEX_URL = 'https://chatgpt.com/backend-api/codex';
  const CODEX_HOST_MODEL = 'gpt-5.5';
  const CODEX_IMAGE_QUALITY = 'medium';   // the reference default: ~40s; 'high' runs ~2 minutes, past this tool's timeout
  const CODEX_INSTRUCTIONS = 'You are an assistant that must fulfill image generation and image editing requests by using the image_generation tool when provided.';
  // 2026-07-07 image-quality escape: the old default (gemini-2.5-flash-image, "Nano Banana 1") is the OLDEST
  // image model in the live OpenRouter catalog — garbled text on UI mockups/marketing assets was its signature.
  // Default = current-gen fast (Nano Banana 2); PREMIUM = Nano Banana Pro (built for legible text / hero art);
  // LEGACY = the old slug, kept as the automatic fallback if the newer slug ever errors on this account.
  const DEFAULT_IMAGE_MODEL  = 'google/gemini-3.1-flash-image';   // text->image; override per call via args.model
  const PREMIUM_IMAGE_MODEL  = 'google/gemini-3-pro-image';       // readable text, hero/marketing quality
  const LEGACY_IMAGE_MODEL   = 'google/gemini-2.5-flash-image';   // known-good everywhere; the fallback wire
  const DEFAULT_VISION_MODEL = 'google/gemini-2.5-flash';         // image->text (multimodal); override via args.model
  // 2026-09-28 transparency escape: a user asked for "a design with a transparent background" and the agent, stuck
  // on the Gemini default, went hunting for raw API access it can never be given. Live probe on the OpenRouter wire,
  // same prompt: gemini-3.1-flash-image returned an RGB PNG with a checkerboard PAINTED in ($0.067);
  // openai/gpt-5-image-mini returned a real RGBA PNG, 66% of its pixels alpha 0 ($0.043).
  const TRANSPARENT_IMAGE_MODEL    = 'openai/gpt-5-image-mini';   // alpha-capable default for transparent renders
  const TRANSPARENT_FALLBACK_MODEL = 'openai/gpt-5-image';        // slug-drift net that still outputs alpha
  const ALPHA_MODEL  = /^openai\/gpt-[\w.-]*image/i;              // OpenRouter slugs known to return an alpha channel
  const OPAQUE_MODEL = /^google\/gemini-/i;                       // known never to return one
  // A prompt that plainly wants transparency counts as asking for it. Deliberately narrow: "a transparent glass
  // vase" is a subject, and "no background blur" is a photo note, not a request for alpha.
  const TRANSPARENT_ASK = /\btransparent[\s-]+(?:background|bg|backdrop|png)\b|\balpha[\s-]+channel\b|\b(?:no|without(?:\s+(?:a|any))?)\s+background(?:\s+at\s+all)?\b(?!\s+[a-z])|\bbackground[\s-]*(?:free|less)\b/i;
  const TRANSPARENT_PROMPT = ' Render the subject alone on a fully transparent background (PNG with an alpha channel): no backdrop, no scenery and no checkerboard pattern.';
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
  function parseOpenAIImageResponse(data) {
    const item = data && Array.isArray(data.data) && data.data[0];
    if (!item) return '';
    if (item.b64_json) return 'data:image/png;base64,' + item.b64_json;
    return String(item.url || '');
  }
  // The Codex Responses SSE stream -> { image (base64 PNG), text, failed }. The FINAL image_generation_call result
  // wins; a partial frame is kept only as a fallback. Liberal on event shape: the backend ships image events newer
  // than any SDK knows.
  function parseCodexImageStream(raw) {
    let finalB64 = '', partialB64 = '', text = '', failed = '', completed = false;
    for (const block of String(raw || '').split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch (_) { continue; }
      if (!ev || typeof ev !== 'object') continue;
      if (typeof ev.partial_image_b64 === 'string' && ev.partial_image_b64) partialB64 = ev.partial_image_b64;
      const items = [];
      if (ev.item) items.push(ev.item);
      if (ev.response && Array.isArray(ev.response.output)) items.push(...ev.response.output);
      for (const it of items) if (it && it.type === 'image_generation_call' && typeof it.result === 'string' && it.result) finalB64 = it.result;
      if (ev.type === 'response.output_text.done' && typeof ev.text === 'string') text = ev.text;
      if (ev.type === 'response.failed' || ev.type === 'error') {
        const er = (ev.response && ev.response.error) || ev.error || ev;
        failed = String((er && (er.message || er.code)) || 'the response failed');
      }
      if (ev.type === 'response.incomplete') {
        const why = ev.response && ev.response.incomplete_details && ev.response.incomplete_details.reason;
        failed = 'the render stopped before it finished' + (why ? ' (' + String(why).slice(0, 80) + ')' : '');
      }
      if (ev.type === 'response.completed') completed = true;
    }
    // a partial preview frame is a fallback ONLY for a stream that COMPLETED: a response.failed or response.incomplete after a
    // partial, or a stream cut off with no final event, is a failed render, never a half-drawn image saved as the result
    if (!finalB64 && partialB64 && !completed && !failed) failed = 'the render stopped before it finished (the stream ended early)';
    return { image: finalB64 || (completed && !failed ? partialB64 : ''), text: text.trim(), failed };
  }
  // ChatGPT-Account-ID rides the OAuth JWT's own claim (codex-rs auth.rs); a malformed token just omits the header.
  function jwtAccountId(token) {
    try {
      const claims = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
      const id = claims && claims['https://api.openai.com/auth'] && claims['https://api.openai.com/auth'].chatgpt_account_id;
      return typeof id === 'string' ? id : '';
    } catch (_) { return ''; }
  }
  function openAIImageSize(shape) {
    if (!shape || !shape.ratio) return '1024x1024';
    const parts = String(shape.ratio).split(':').map(Number);
    const ratio = parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : 1;
    return ratio > 1.05 ? '1536x1024' : ratio < 0.95 ? '1024x1536' : '1024x1024';
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

  /* TRANSPARENCY IS READ FROM THE BYTES. A prompt asking for a transparent background proves nothing, and neither
     does the model's caption: a painted checkerboard looks right in a thumbnail and is wrong in the file. This
     decodes the alpha channel itself and answers one of three states, never rounding a guess up to a claim:
       opaque       certain: JPEG, lossy WEBP, a PNG with no alpha channel and no tRNS, or one where (almost) no
                    pixel is see-through;
       transparent  see-through pixels exist; clearPct says how much of the image they cover;
       unverified   the bytes may carry alpha this decoder does not count (interlaced or low-bit PNGs, WEBP with
                    an alpha flag, GIF), or the image is too large to scan.
     gpt-image-2 renders OPAQUE areas at alpha 253, so "see-through" is a threshold near zero, never "< 255". */
  const CLEAR_ALPHA = 8;                          // an 8-bit alpha at or below this is see-through
  const ALPHA_SCAN_MAX_BYTES = 64 * 1024 * 1024;  // decoded ceiling: a 4096x4096 RGBA render, scanned in well under 1s

  // Undo PNG scanline filtering (types 0-4). Returns null on a filter byte the format does not define.
  function pngUnfilter(raw, width, height, bpp) {
    const stride = width * bpp, out = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
      if (filter > 4) return null;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? out[row + x - bpp] : 0;
        const b = y > 0 ? out[up + x] : 0;
        const c = (x >= bpp && y > 0) ? out[up + x - bpp] : 0;
        let v = raw[src + x];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
        out[row + x] = v & 255;
      }
    }
    return out;
  }

  function alphaCoverage(bytes) {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const verdict = (state, why, clearPct) => (clearPct == null ? { state, why } : { state, why, clearPct });
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return verdict('opaque', 'it is a JPEG, which has no alpha channel');
    if (b.length >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const tag = b.toString('latin1', 12, 16);
      if (tag === 'VP8 ') return verdict('opaque', 'it is a lossy WEBP, which has no alpha channel');
      if (tag === 'VP8X' && b.length > 20 && !(b[20] & 0x10)) return verdict('opaque', 'the WEBP has no alpha channel');
      return verdict('unverified', 'WEBP alpha is not decoded here');
    }
    if (b.length >= 6 && b.toString('latin1', 0, 3) === 'GIF') return verdict('unverified', 'GIF transparency is not decoded here');
    const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return verdict('unverified', 'the image format was not recognized');
    let o = 8, ihdr = null, trns = null;
    const idat = [];
    while (o + 12 <= b.length) {
      const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
      if (o + 12 + len > b.length) break;             // a truncated chunk: keep what is whole
      const data = b.subarray(o + 8, o + 8 + len);
      if (type === 'IHDR' && len >= 13) ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ctype: data[9], interlace: data[12] };
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      o += 12 + len;
    }
    if (!ihdr || !ihdr.w || !ihdr.h) return verdict('unverified', 'the PNG header is unreadable');
    const { w, h, depth, ctype } = ihdr;
    if ((ctype === 0 || ctype === 2) && !trns) return verdict('opaque', 'the PNG is ' + (ctype === 2 ? 'RGB' : 'greyscale') + ' with no alpha channel');
    if (ctype === 3 && !trns) return verdict('opaque', 'the palette PNG has no transparent entries');
    // Counted here: 8/16-bit greyscale+alpha and RGBA, and 8-bit palettes, non-interlaced. Everything else is unverified.
    const channels = ctype === 6 ? 4 : ctype === 4 ? 2 : ctype === 3 ? 1 : 0;
    const countable = channels > 0 && ihdr.interlace === 0 && (ctype === 3 ? depth === 8 : (depth === 8 || depth === 16));
    if (!countable) return verdict('unverified', 'this PNG layout (colour type ' + ctype + ', ' + depth + '-bit' + (ihdr.interlace ? ', interlaced' : '') + ') is not decoded here');
    const bpp = channels * (depth / 8);
    if (w * h * bpp > ALPHA_SCAN_MAX_BYTES) return verdict('unverified', 'the image is too large to scan (' + w + 'x' + h + ')');
    let raw;
    try { raw = require('node:zlib').inflateSync(Buffer.concat(idat)); }
    catch (_) { return verdict('unverified', 'the PNG data could not be decoded'); }
    if (raw.length < h * (w * bpp + 1)) return verdict('unverified', 'the PNG data is truncated');
    const px = pngUnfilter(raw, w, h, bpp);
    if (!px) return verdict('unverified', 'the PNG data is corrupt');
    let clear = 0;
    if (ctype === 3) {
      for (let i = 0; i < px.length; i++) if ((px[i] < trns.length ? trns[px[i]] : 255) <= CLEAR_ALPHA) clear++;
    } else {
      // alpha is the last sample; 16-bit samples are big-endian, so its high byte carries the verdict
      for (let i = (channels - 1) * (depth / 8); i < px.length; i += bpp) if (px[i] <= CLEAR_ALPHA) clear++;
    }
    const total = w * h;
    // "no pixel is see-through", not "every pixel is opaque": a background at alpha 60 is tinted, not clear
    if (!clear) return verdict('opaque', 'the PNG has an alpha channel but no pixel is see-through');
    if (clear * 1000 < total) return verdict('opaque', 'only ' + clear + ' of ' + total + ' pixels are see-through');
    return verdict('transparent', 'the alpha channel was checked', Math.round((clear / total) * 1000) / 10);
  }

  function extOf(P, p) { return String(P.extname(p) || '').toLowerCase(); }

  function makeImageTools(deps) {
    deps = deps || {};
    const or = deps.openrouter || {};
    const apiKey = or.apiKey || deps.apiKey || '';
    const protocol = or.protocol || 'openrouter-chat';
    // The ChatGPT plan renders the same gpt-image models as the OpenAI Images API, so model choice, transparency and
    // sizing follow one rule set; only the transport differs.
    const isCodex = protocol === 'codex-responses';
    const gptImageRoute = protocol === 'openai-images' || isCodex;
    const providerLabel = or.provider === 'starnet' ? 'StarNet' : (or.provider === 'openai' ? 'OpenAI' : (isCodex ? 'ChatGPT' : 'OpenRouter'));
    const getCodexToken = typeof or.getToken === 'function' ? or.getToken : null;
    const renewCodexToken = typeof or.renewToken === 'function' ? or.renewToken : null;
    const orBaseUrl = String(or.baseUrl || deps.baseUrl || '').trim().replace(/\/+$/, '');
    const orUrl = orBaseUrl ? orBaseUrl + '/chat/completions' : DEFAULT_OR_URL;
    const openAIImageUrl = orBaseUrl ? orBaseUrl + '/images/generations' : DEFAULT_OPENAI_IMAGE_URL;
    const codexUrl = (isCodex && orBaseUrl ? orBaseUrl : DEFAULT_CODEX_URL) + '/responses';
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root;
    if (!fsp || !P || !ROOT) throw new Error('image.js requires { fsp, pathMod, root }');
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('image.js requires global fetch (Node 18+) or deps.fetchImpl');
    const configuredImageModel = String(deps.imageModel || '').trim();
    const gptImageSlug = isCodex ? /^gpt-image-/i : /^(?:gpt-image-|dall-e-)/i;   // the hosted tool takes no DALL-E
    const IMAGE_MODEL  = gptImageRoute
      ? (gptImageSlug.test(configuredImageModel) ? configuredImageModel : OPENAI_IMAGE_MODEL)
      : (configuredImageModel || DEFAULT_IMAGE_MODEL);
    const VISION_MODEL = deps.visionModel || or.model || DEFAULT_VISION_MODEL;
    // Auxiliary vision route: a one-shot text answer from the RUN's own provider/model (injected by the run
    // host). Used when no OpenRouter key exists — and as the rescue when the OpenRouter call FAILS (dead key,
    // out of credits, model rot) — so vision never dead-ends on one vendor.
    const auxVision = typeof deps.auxVision === 'function' ? deps.auxVision : null;
    // reuse the ONE workspace jail (fs.js) so generated/analyzed paths can't escape the agent's directory.
    // pathTrust (issue #77): the run's path-trust guard, the same one fs.* gets. With it, a relative path in a
    // project-scoped run lands IN the project (where the lead's fs.read and the shell look), and an absolute path
    // inside a trusted project is allowed; without it (tests, bare rigs) every path stays in the private jail.
    const jail = fsMod.makeFsTools({ fsp, pathMod: P, root: ROOT, pathTrust: typeof deps.pathTrust === 'function' ? deps.pathTrust : undefined })._internals;

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
        const json = await r.json().catch(require('../../failopen.js').swallow('image.openrouter.response-json', null));
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

    async function openAIImagePost(body, timeoutMs, parentSignal) {
      checkCancelled(parentSignal);
      if (!apiKey) throw new Error('STUDIO image generation is unavailable: no media connection is configured. Open SETTINGS and connect an OpenAI or OpenRouter API key for image generation, or link this station to your StarNet account, then retry; no image was produced.');
      const res = await withTimeout(signal => doFetch(openAIImageUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      }).then(async r => {
        const json = await r.json().catch(require('../../failopen.js').swallow('image.openai.response-json', null));
        if (typeof deps.onUsage === 'function' && (r.status >= 200 && r.status < 300 || json && json.usage)) deps.onUsage(json && json.usage, body.model);
        return { status: r.status, json };
      }), timeoutMs, parentSignal || deps.signal);
      if (res.status < 200 || res.status >= 300) {
        const errMsg = res.json && res.json.error && (res.json.error.message || res.json.error) || ('http ' + res.status);
        throw new Error('OpenAI ' + res.status + ': ' + (typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)));
      }
      return res.json || {};
    }

    // One image_generation call on the ChatGPT plan. Returns the Images-API response shape ({ data:[{ b64_json }] }) so
    // the publish path below stays one path. No usage is booked: the plan is flat-rate, and the host chat model's
    // token counts would otherwise be priced at API rates the user never pays.
    async function codexImagePost(tool, prompt, timeoutMs, parentSignal) {
      checkCancelled(parentSignal);
      if (!getCodexToken) throw new Error('STUDIO image generation is unavailable: the ChatGPT sign-in is not connected. Open SETTINGS and sign in to ChatGPT, or connect an OpenAI or OpenRouter API key, then retry; no image was produced.');
      const body = {
        model: CODEX_HOST_MODEL, store: false, stream: true, instructions: CODEX_INSTRUCTIONS,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        tools: [Object.assign({ type: 'image_generation', output_format: 'png', partial_images: 1 }, tool)]
        // no tool_choice: see DEFAULT_CODEX_URL above
      };
      const send = (token) => {
        const headers = {
          'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'text/event-stream',
          'originator': 'codex_cli_rs', 'User-Agent': 'codex_cli_rs/0.0.0 (StarNet)'
        };
        const account = jwtAccountId(token);
        if (account) headers['ChatGPT-Account-ID'] = account;
        return withTimeout(signal => doFetch(codexUrl, { method: 'POST', headers, body: JSON.stringify(body), signal })
          .then(async r => ({ status: r.status, text: await r.text() })), timeoutMs, parentSignal || deps.signal);
      };
      let token = await getCodexToken();
      let res = await send(token);
      // The server is the authority on expiry (codex.js renewToken law): one renew + retry on a 401.
      if (res.status === 401 && renewCodexToken) { checkCancelled(parentSignal); token = await renewCodexToken(token); res = await send(token); }
      if (res.status < 200 || res.status >= 300) {
        let errMsg = 'http ' + res.status;
        try { const j = JSON.parse(res.text); errMsg = (j && j.error && (j.error.message || j.error.code)) || (j && j.detail) || errMsg; }
        catch (_) { if (res.text) errMsg = String(res.text).slice(0, 300); }
        throw new Error('ChatGPT ' + res.status + ': ' + (typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)));
      }
      const out = parseCodexImageStream(res.text);
      if (!out.image && out.failed) throw new Error('ChatGPT image generation failed: ' + out.failed);
      return { data: out.image ? [{ b64_json: out.image }] : [], choices: out.text ? [{ message: { content: out.text } }] : [] };
    }

    // ---------------- image_generate ----------------
    const generateTool = {
      name: 'image_generate', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: GEN_TIMEOUT_MS + 15000,
      description: 'Generate an image from a text prompt and SAVE it to a file (returns the absolute saved location + a viewer URL). ' +
        'A relative "path" lands in the project folder when this conversation is scoped to a trusted project, otherwise in your private workspace; an absolute "path" inside a trusted project folder saves there. ' +
        'Use for any "draw / create / generate an image of …" request. Optional "model" picks the image model: ' +
        (gptImageRoute
          ? 'default ' + OPENAI_IMAGE_MODEL + (isCodex ? ' through the signed-in ChatGPT plan (no API key; about 40s per image). ' : ' through the connected OpenAI Images API. ') + 'Optional "path" sets the output filename. '
          : 'default ' + DEFAULT_IMAGE_MODEL + ' (fast, current-gen). For HERO/MARKETING assets or ANY image that must show ' +
            'READABLE TEXT (UI mockups, landing pages, posters, infographics, product concepts), pass model:"' + PREMIUM_IMAGE_MODEL + '" ' +
            '— it renders legible text; the fast tier garbles it. Optional "path" sets the output filename. ') +
        'For a TRANSPARENT background (logos, stickers, icons, print-on-demand art) set "transparent":true: ' +
        (gptImageRoute
          ? 'it asks ' + (isCodex ? 'gpt-image' : 'the Images API') + ' for a real alpha channel '
          : 'Gemini image models cannot make one (they paint a checkerboard), so it switches to ' + TRANSPARENT_IMAGE_MODEL + ' ') +
        'and verifies the saved file, and the result says plainly if the image came back opaque. ' +
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
        height: { type: 'integer', minimum: 16, maximum: MAX_OUTPUT_PX },
        transparent: { type: 'boolean', description: 'true = a real transparent background (alpha channel), verified in the saved file' }
      } },
      run: async (args, ctx) => {
        const signal = ctx && ctx.signal;
        checkCancelled(signal);
        const aid = (ctx && ctx.agentId) || 'agent';
        const prompt = String(args.prompt || '').trim();
        if (!prompt) throw new Error('prompt is required');
        // Transparency is asked for explicitly or by a prompt that plainly wants it; an explicit false wins.
        const transparent = args.transparent === true || (args.transparent !== false && TRANSPARENT_ASK.test(prompt));
        const explicitModel = String(args.model || '').trim();
        const requestedModel = String(explicitModel || IMAGE_MODEL).trim();
        let model = gptImageRoute && !gptImageSlug.test(requestedModel)
          ? IMAGE_MODEL : requestedModel;
        // A transparent render leaves any model that cannot output alpha: the default or knob model when it is not
        // alpha-capable, and an explicit Gemini choice. An explicit model of unknown ability is kept, and the
        // verdict below reads its bytes. On the Images API only DALL-E lacks the background parameter.
        let switchNote = '';
        if (transparent) {
          const to = gptImageRoute
            ? (/^dall-e-/i.test(model) ? OPENAI_IMAGE_MODEL : '')
            : ((ALPHA_MODEL.test(model) || (explicitModel && !OPAQUE_MODEL.test(model))) ? '' : TRANSPARENT_IMAGE_MODEL);
          if (to) { switchNote = model + ' cannot output transparency, so ' + to + ' rendered this'; model = to; }
        }
        const genPrompt = transparent && !TRANSPARENT_ASK.test(prompt) ? prompt + TRANSPARENT_PROMPT : prompt;
        // Aspect ratio rides OpenRouter's image_config passthrough — prose in the prompt is
        // mostly ignored by the Gemini image models, so this field is the only real dial.
        const shape = resolveShape(args.aspect_ratio, args.width, args.height);
        if (!shape) {
          throw new Error('could not understand the requested image shape (aspect_ratio "' + String(args.aspect_ratio || '') +
            '", width ' + String(args.width || '') + ', height ' + String(args.height || '') + ') — give a W:H ratio like 16:9, ' +
            'a WxH size like 1920x1080, a word like landscape/portrait, or both width and height (16..' + MAX_OUTPUT_PX + 'px); no image was produced.');
        }
        const aspect = shape.ratio;
        const baseBody = { messages: [{ role: 'user', content: genPrompt }], modalities: ['image', 'text'] };
        if (aspect) baseBody.image_config = { aspect_ratio: aspect };
        let data;
        if (isCodex) {
          // the hosted tool takes the Images API's own parameters; quality is pinned (see CODEX_IMAGE_QUALITY)
          data = await codexImagePost({ model, size: openAIImageSize(shape), quality: CODEX_IMAGE_QUALITY, background: transparent ? 'transparent' : 'opaque' },
            genPrompt, GEN_TIMEOUT_MS, signal);
        } else if (protocol === 'openai-images') {
          const body = { model, prompt: genPrompt, size: openAIImageSize(shape) };
          // gpt-image models take transparency as a parameter (gpt-image-2: preview since 2026-08-20). Alpha needs
          // a format that can carry it, so the output format is pinned to PNG.
          if (transparent) { body.background = 'transparent'; body.output_format = 'png'; }
          data = await openAIImagePost(body, GEN_TIMEOUT_MS, signal);
        } else try {
          data = await orPost(Object.assign({ model }, baseBody), GEN_TIMEOUT_MS, signal);
        } catch (e) {
          // slug-drift safety net: if the CHOSEN model is rejected as unknown/unavailable (400/404 "not a valid
          // model" / "no endpoints"), retry ONCE on the known-good legacy slug instead of failing the whole task.
          // Only for model-shaped rejections — a rate-limit/timeout/content error propagates untouched.
          checkCancelled(signal);
          const msg = String((e && e.message) || e);
          const modelish = /\b(400|404)\b/.test(msg) && /model|endpoint/i.test(msg);
          // A transparent render never falls back onto an opaque-only model.
          const fallback = transparent ? TRANSPARENT_FALLBACK_MODEL : LEGACY_IMAGE_MODEL;
          if (!modelish || model === fallback) throw e;
          model = fallback;
          data = await orPost(Object.assign({ model }, baseBody), GEN_TIMEOUT_MS, signal);
        }
        checkCancelled(signal);
        const url = gptImageRoute ? parseOpenAIImageResponse(data) : parseImageFromResponse(data);
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
        let sizeNote = '', fittedExact = false;
        if (shape.exact) {
          const fitted = await fitToSize(buffer, shape.width, shape.height);
          if (fitted) { buffer = fitted.buffer; mime = fitted.mime; sizeNote = ' fitted to ' + shape.width + 'x' + shape.height; fittedExact = true; }
          else sizeNote = ' NOT resized to ' + shape.width + 'x' + shape.height + " (image resizer unavailable; shipped at the provider's " + aspect + ' size)';
        }
        // Name the shape that was RENDERED, not the one asked for. A model can ignore image_config (OpenAI image slugs
        // on OpenRouter return 1024x1024 for any ratio: live probe 2026-09-28), and the Images API snaps to 3 sizes.
        let shapeNote = aspect ? ', ' + aspect : '';
        if (aspect && !fittedExact) {
          const dims = require('./imagewire.js').sniff('', buffer);
          const want = aspect.split(':');
          if (dims && dims.width && dims.height && Math.abs(Math.log((dims.width / dims.height) / (want[0] / want[1]))) > Math.log(1.1)) {
            shapeNote = ', ' + dims.width + 'x' + dims.height + ', not the requested ' + aspect;
          }
        }
        // The transparency verdict comes from the exact bytes about to be saved (an exact-size fit keeps alpha).
        // An opaque result is still saved and delivered (it was paid for), but it is never reported as transparent.
        // The verdict rides the CONTENT only: the summary stays exactly "image → <rel>", because artifacts.js reads
        // the saved path out of it (a suffix there became part of the recorded path).
        let alphaNote = '';
        if (transparent) {
          const cov = alphaCoverage(buffer);
          if (cov.state === 'transparent') {
            alphaNote = '\nTransparent background verified in the saved file: ' + cov.clearPct + '% of pixels are see-through.';
          } else if (cov.state === 'opaque') {
            alphaNote = '\nNOT TRANSPARENT: ' + cov.why + '. A checkerboard in the picture is painted, not transparency, so do not ' +
              'describe this image as transparent. ' + (!gptImageRoute && !ALPHA_MODEL.test(model)
                ? 'Retry with transparent:true and no model override, which uses a model that outputs alpha.'
                : 'The model ignored the request: retry once, and if it is still opaque tell the user plainly.');
          } else {
            alphaNote = '\nTransparency NOT verified: ' + cov.why + '. Do not claim the background is transparent.';
          }
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
        // project-scoped run: a relative path lands in the project folder (issue #77, same rule as fs.write #60)
        const placed = await jail.resolveInside(aid, rel, { scope: 'write', ctx });   // throws on escape / '..' / untrusted
        const abs = placed.abs;
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
        const where = await jail.outputPlacement(aid, placed);
        const viewer = where.viewer;
        const caption = textFromResponse(data);
        const kb = (buffer.length / 1024).toFixed(0) + ' KB';
        return {
          content: 'Generated and saved ' + rel + ' (' + kb + ', ' + mime + ', model ' + model + shapeNote + sizeNote + ').' +
            (switchNote ? '\nModel: ' + switchNote + '.' : '') + alphaNote +
            '\n' + where.line +
            (viewer ? '\nView: ' + viewer : '') + (caption ? '\nModel note: ' + caption : ''),
          summary: 'image → ' + rel
        };
      }
    };

    // ---------------- image_analyze ----------------
    async function imageToUrl(aid, image, ctx) {
      const s = String(image || '').trim();
      if (!s) throw new Error('image is required (a workspace path or an http(s) URL)');
      if (/^data:/i.test(s)) return s;                          // already a data URL
      if (/^https?:\/\//i.test(s)) return s;                    // public URL — OpenRouter fetches it server-side
      if (/^[a-z]+:\/\//i.test(s)) throw new Error('only http(s) URLs, data URLs, or workspace paths are allowed');
      // else: a file path -> read + base64. Relative = the project folder in a project-scoped run, else the private
      // workspace (the same base image_generate and fs.read use, issue #77); absolute = path trust.
      const { abs } = await jail.resolveInside(aid, s, { scope: 'read', ctx });
      let buf;
      try { buf = await fsp.readFile(abs); }
      catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + s + ' (looked at ' + abs + ')'); throw e; }
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
      const canUseOpenRouterVision = protocol === 'openrouter-chat' && !!apiKey;
      if (!canUseOpenRouterVision) {
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
      description: 'Look at an image and answer a question about it (vision). "image" is EITHER a file (relative = the project folder in a project-scoped conversation, else your workspace) ' +
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
        const url = await imageToUrl(aid, args.image, ctx);
        const full = await analyzeImageUrl(url, args.prompt, args.model);
        const out = clip(full);
        return { content: out, fullContent: out === full ? undefined : full, summary: 'analyzed image (' + full.length + ' chars)' };
      }
    };

    // A vision callback for makeBrowserTools: takes a base64 PNG (CDP screenshot) + question,
    // returns the model's answer. Honest failure (no route) propagates as a thrown Error which
    // browser.vision converts to an 'vision unavailable' result. auxVision counts as a route:
    // a keyless session on a vision-capable provider still gets browser.vision.
    const hasVision = (protocol === 'openrouter-chat' && !!apiKey) || !!auxVision;
    async function browserVision({ imageBase64, question }) {
      const url = 'data:image/png;base64,' + String(imageBase64 || '');
      return clip(await analyzeImageUrl(url, question));
    }

    return {
      generateTool, analyzeTool, analyzeImageUrl, browserVision, hasVision,
      _internals: { parseImageFromResponse, parseOpenAIImageResponse, parseCodexImageStream, jwtAccountId, openAIImageSize, textFromResponse, dataUrlToBuffer, imageUrlFromPart, imageToUrl, analyzeImageUrl, resolveShape, fitToSize, alphaCoverage, TRANSPARENT_ASK, TRANSPARENT_IMAGE_MODEL },
      register(reg) { reg.register(generateTool); reg.register(analyzeTool); return reg; }
    };
  }

  return { makeImageTools };
});
