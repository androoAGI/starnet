/* sidecar/tasteref.js — THE DESIGN ANCHOR: what an approved (or rejected) run REALLY made, so the next run can match it.

   User report (2026-10-11): "They'll do a task correctly and then the next time completely forget it or do a different
   way. Same with designs. Say I approve one, the next comes out with a complete off-the-wall style and concept." A 👍
   stored one line — "LIKED the result of: <request>" — with no file, no colour, no font, no image prompt and no method:
   nothing a later run could match. This module turns the RATED RUN's own durable record into a compact reference:

     paths    the deliverables the run wrote / edited / generated (runstore `artifacts`, harness-observed)
     images   each SUCCESSFUL image_generate call: its prompt, the model that RENDERED it (read back from the tool's own
              "Generated and saved … model X" line, never the requested one), the reported saved shape, verified transparency, and
              any reference image it matched (the run's transcript rows: tool_call arguments paired with the result)
     palette  the dominant colours IN the deliverable files (hex / rgb() / hsl(); a CSS custom property counts extra,
              it is a design token), by frequency. A file a later run rewrote holds THAT run's style: when the caller
              passes ranUntil and each file's mtimeMs, such a file keeps its path but lends no colours or fonts. Without
              ranUntil every file is read as it is NOW, so the host must pass both (captureTasteRef in index.js)
     fonts    the primary family of each font-family declaration in those same files (plus Google Fonts links)
     tools    the approach: the run's successful tool calls in order (runstore `toolTrace`), repeats folded

   Truthful telemetry: every field is read from a real record or a real file at capture time; nothing is inferred or
   invented. A run that read third-party content (taintedBy) keeps its structural facts (paths, colours, fonts, tools)
   but never its free text (image prompts), so outside words never ride into every later prompt as the Commander's
   approved reference. Font names are charset-checked for the same reason.

   PURE: no I/O, no clock. index.js reads the run row, the transcript rows and the files, and hands them in. */
'use strict';

const UserText = require('../frontend/app/usertext.js');   // the one flattener of a message's text parts (STORED policy)
const DESIGN_EXT =/\.(html?|css|scss|sass|less|styl|svg|jsx?|mjs|tsx?|vue|svelte|astro|md|mdx)$/i;
const MARKDOWN_EXT = /\.(md|mdx)$/i;
const SCRIPT_EXT = /\.(jsx?|mjs|tsx?)$/i;
const PATHS_MAX = 4;
const PATH_CHARS = 180;   // a project run's files are stored ABSOLUTE (any trusted run can open them)
const IMAGES_MAX = 2;
const PROMPT_CHARS = 220;
const PALETTE_MAX = 6;
const FONTS_MAX = 3;
const TOOLS_MAX = 8;
const FILE_CHARS = 400000;   // per file scanned (the caller already refuses big files; this is the pure module's own cap)

function str(v) { return v == null ? '' : String(v); }
function clean(s, n) {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
function isDesignPath(p) { return DESIGN_EXT.test(str(p)); }

// ---------------- colours ----------------
function hex2(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }
function chan(v) { const s = str(v); return /%$/.test(s) ? parseFloat(s) * 2.55 : parseFloat(s); }
function normHex(h) {
  h = h.toLowerCase();
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('');
  return '#' + h.slice(0, 6);
}
function hslHex(h, s, l) {
  h = ((Number(h) % 360) + 360) % 360; s = Math.max(0, Math.min(100, Number(s))) / 100; l = Math.max(0, Math.min(100, Number(l))) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + hex2((r + m) * 255) + hex2((g + m) * 255) + hex2((b + m) * 255);
}
// every colour literal in a text, in order of appearance, normalized to #rrggbb (alpha dropped: a palette is hues)
function colorsIn(text, markdown, script) {
  const out = [];
  const s = str(text);
  // a hex needs a CSS-ish left edge (not an HTML entity &#123;, a JS private field .#abc, or a word) and no right word
  // char; markdown prose is full of "#123" issue numbers, so only the unambiguous 6/8-digit form counts there
  // in a SCRIPT a colour lives in a string or a CSS-in-JS value ('#abc', color: #abc), never after a bare space
  // (class X { #abc = 1 } is a private field)
  const HEX = script
    ? /(['"`]|[:,(]\s*)#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g
    : /(^|[^\w&#.$])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
  const RGB = /rgba?\(\s*(\d{1,3}(?:\.\d+)?%?)[\s,]+(\d{1,3}(?:\.\d+)?%?)[\s,]+(\d{1,3}(?:\.\d+)?%?)/gi;
  const HSL = /hsla?\(\s*(-?\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/gi;
  let m;
  while ((m = HEX.exec(s))) { if (!markdown || m[2].length >= 6) out.push({ at: m.index + m[1].length, hex: normHex(m[2]) }); }
  while ((m = RGB.exec(s))) out.push({ at: m.index, hex: '#' + hex2(chan(m[1])) + hex2(chan(m[2])) + hex2(chan(m[3])) });
  while ((m = HSL.exec(s))) out.push({ at: m.index, hex: hslHex(m[1], m[2], m[3]) });
  return out.sort((a, b) => a.at - b.at).map(c => c.hex);
}

// ---------------- fonts ----------------
const GENERIC_FONT = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong|-apple-system|blinkmacsystemfont|inherit|initial|unset|revert|revert-layer)$/i;
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
// the PRIMARY family of one declaration list: the first real face ("VT323", monospace -> VT323); all-generic -> the first
function primaryFamily(list) {
  // a quote ENDS a family: "Space Grotesk" -> Space Grotesk, and an inline style's closing quote (Inter" class="x) stops there
  const fams = str(list).replace(/!important/i, '').split(',').map(f => f.trim().replace(/^['"`]+/, '').split(/['"`]/)[0].trim()).filter(Boolean);
  const pick = fams.find(f => !GENERIC_FONT.test(f) && !/^var\(/i.test(f)) || fams.find(f => !/^var\(/i.test(f) && !/^(inherit|initial|unset|revert)/i.test(f));
  return pick && FONT_NAME.test(pick) ? pick : '';
}
function fontsIn(text) {
  const s = str(text);
  const out = [];
  let m;
  const DECL = /font-family\s*:\s*([^;}{\n<>]+)/gi;            // CSS and inline style=""
  const JS = /fontFamily\s*[:=]\s*\{?\s*['"`]([^'"`\n]+)['"`]/g;  // JSX / TS style objects and props
  const VARS = /--[\w-]*font[\w-]*\s*:\s*([^;}{\n<>]+)/gi;       // font tokens (--font-body: "Inter", sans-serif)
  const GF = /fonts\.googleapis\.com\/css2?\?([^"'\s)<>]+)/gi;   // <link href=".../css2?family=Inter:wght@400&family=VT323">
  // font: 700 16px/1.4 "Inter", sans-serif — the families follow the LAST size token (greedy, then backtrack)
  const SHORT = /(^|[;{\s"'])font\s*:\s*[^;}{\n<>]*\d[\w.%]*(?:\s*\/\s*[\w.%]+)?\s+([^;}{\n<>\d\s][^;}{\n<>]*)/gi;
  const found = [];
  while ((m = DECL.exec(s))) found.push({ at: m.index, name: primaryFamily(m[1]) });
  while ((m = SHORT.exec(s))) found.push({ at: m.index, name: primaryFamily(m[2]) });
  while ((m = JS.exec(s))) found.push({ at: m.index, name: primaryFamily(m[1]) });
  while ((m = VARS.exec(s))) { if (!/^\s*var\(/i.test(m[1]) && !/^\s*\d/.test(m[1])) found.push({ at: m.index, name: primaryFamily(m[1]) }); }
  while ((m = GF.exec(s))) {
    for (const part of m[1].split(/&(?:amp;)?/)) {
      const fm = /^family=([^:&]+)/i.exec(part);
      if (fm) { let name = fm[1].replace(/\+/g, ' '); try { name = decodeURIComponent(name); } catch (_) { name = ''; } if (FONT_NAME.test(name)) found.push({ at: m.index, name }); }
    }
  }
  for (const f of found.sort((a, b) => a.at - b.at)) if (f.name) out.push(f.name);
  return out;
}

// files: [{ path, text }] -> { palette: ['#rrggbb', …], fonts: ['Inter', …] } by frequency, ties by first appearance
function styleSpec(files) {
  const colors = new Map(), fonts = new Map();
  let seq = 0;
  const bump = (map, key, by) => { const prev = map.get(key); if (prev) prev.n += by; else map.set(key, { key, n: by, first: seq++ }); };
  for (const f of (Array.isArray(files) ? files : [])) {
    if (!f || !isDesignPath(f.path)) continue;
    const text = str(f.text).slice(0, FILE_CHARS);
    const md = MARKDOWN_EXT.test(str(f.path)), js = SCRIPT_EXT.test(str(f.path));
    for (const hex of colorsIn(text, md, js)) bump(colors, hex, 1);
    // a colour DEFINED as a custom property is a design token: it outranks a one-off literal of the same count
    const TOKEN = /--[\w-]+\s*:\s*([^;}{\n]+)/g;
    let m;
    while ((m = TOKEN.exec(text))) for (const hex of colorsIn(':' + m[1], md, js)) bump(colors, hex, 2);   // ':' = the value's own left edge
    for (const name of fontsIn(text)) bump(fonts, name, 1);
  }
  const rank = map => Array.from(map.values()).sort((a, b) => (b.n - a.n) || (a.first - b.first)).map(x => x.key);
  // case-insensitive font dedupe (Inter / inter), first spelling wins
  const seenFont = new Set();
  const fontList = rank(fonts).filter(f => { const k = f.toLowerCase(); if (seenFont.has(k)) return false; seenFont.add(k); return true; });
  return { palette: rank(colors).slice(0, PALETTE_MAX), fonts: fontList.slice(0, FONTS_MAX) };
}

// ---------------- image_generate calls (transcript rows or provider messages) ----------------
function callsOf(row) {
  let tc = row && (row.tool_calls != null ? row.tool_calls : row.toolCalls);
  if (typeof tc === 'string') { try { tc = JSON.parse(tc); } catch (_) { tc = null; } }
  return Array.isArray(tc) ? tc : [];
}
function contentText(c) {
  return UserText.flatten(c, UserText.STORED);   // the transcript row's own flattening
}
const SAVED = /^Generated and saved (.+?) \(\d+ KB, [^,]+, model ([^,)\s]+)([^\n]*)/;
// -> [{ path, prompt, model, aspect, transparent, reference }] for every image_generate call whose result says it SAVED
function imageCalls(rows) {
  const byId = new Map(), order = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    if (r.role === 'assistant') {
      for (const c of callsOf(r)) {
        const fn = c && c.function;
        const name = str(fn && fn.name);
        if (!/^image[._]generate$/.test(name) || !c.id) continue;
        let args = fn.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = null; } }
        if (!args || typeof args !== 'object') continue;
        const rec = { id: str(c.id), args };
        if (!byId.has(rec.id)) order.push(rec);
        byId.set(rec.id, rec);
      }
    } else if (r.role === 'tool') {
      const rec = byId.get(str(r.toolCallId != null ? r.toolCallId : r.tool_call_id));
      if (rec) rec.result = contentText(r.content);
    }
  }
  const out = [];
  for (const rec of order) {
    const m = SAVED.exec(str(rec.result));
    if (!m) continue;   // failed / refused / unanswered: it made nothing
    const a = rec.args;
    // Receipt fields describe the saved output. Args describe intentions that a provider may ignore.
    // A model's optional caption is not a host receipt and cannot attest these properties.
    const receipt = str(rec.result).split('\nModel note:')[0];
    const fitted = / fitted to (\d+x\d+)/.exec(m[3]);
    const shape = /^, (\d+(?::|x)\d+)/.exec(m[3]);
    const aspect = fitted ? fitted[1] : shape ? shape[1] : '';
    const transparent = /^Transparent background verified in the saved file:/m.test(receipt);
    const reference = /^Reference: (.+) was sent to the model as the style to match\.$/m.exec(receipt);
    out.push({ path: clean(m[1], PATH_CHARS), prompt: clean(a.prompt, PROMPT_CHARS), model: clean(m[2], 60), aspect, transparent, reference: reference ? clean(reference[1], PATH_CHARS) : '' });
  }
  return out;
}

// ---------------- the approach ----------------
// bookkeeping tools say nothing about HOW the work was done
const QUIET_TOOLS = /^(deliverable[._]note|tool[._]search|todo[._]|notebook[._]|memory[._]|skill[._](view|list)|manual[._]read|time[._]now)/;
function methodOf(trace) {
  const steps = [];
  for (const t of (Array.isArray(trace) ? trace : [])) {
    if (!t || t.ok !== true || t.isError) continue;
    const n = str(t.name).trim().slice(0, 48);
    if (!n || QUIET_TOOLS.test(n)) continue;
    const last = steps[steps.length - 1];
    if (last && last.name === n) last.n++; else steps.push({ name: n, n: 1 });
  }
  const parts = steps.map(s => s.name + (s.n > 1 ? ' ×' + s.n : ''));
  if (parts.length > TOOLS_MAX) return parts.slice(0, TOOLS_MAX - 1).concat(['… ' + parts[parts.length - 1]]).join(' → ');
  return parts.join(' → ');
}

// a design file changed after the rated run ended is a LATER run's work (review memory-learning-11). The slack covers
// mtime granularity and the gap between the run's last write and its runstore record. With the end known, a file whose
// change time is unknown proves nothing; a caller that knows no end time (ranUntil 0) reads every file as before.
const MTIME_SLACK_MS = 2000;
function unchangedSince(file, ranUntil) {
  const until = Number(ranUntil) || 0;
  if (!until) return true;
  const at = Number(file && file.mtimeMs);
  return isFinite(at) && at > 0 && at <= until + MTIME_SLACK_MS;
}

/* buildRef({ artifacts, toolTrace, rows, files, ranUntil, tainted, redact, agentId }) -> the reference, or null when the
   run left nothing to point at. artifacts/toolTrace = the run row's own fields; rows = its transcript rows (or provider
   messages); files = [{ path, text, mtimeMs }] read from the run's design deliverables; ranUntil = when the run ended (ms):
   files modified after it lend no palette or fonts; redact = the host's secret scrub for free text; agentId = whose
   PRIVATE workspace the relative paths live in (omitted for a project run: its paths arrive absolute). */
function buildRef(input) {
  input = input || {};
  const scrub = typeof input.redact === 'function' ? (t) => { try { return str(input.redact(t)); } catch (_) { return ''; } } : (t) => t;
  const arts = (Array.isArray(input.artifacts) ? input.artifacts : []).filter(a => a && (a.kind === 'file' || a.kind === 'image') && str(a.path).trim());
  // the work a later run should open first: images and design files lead, then everything else, written order kept
  const lead = arts.filter(a => a.kind === 'image' || isDesignPath(a.path)), rest = arts.filter(a => lead.indexOf(a) < 0);
  const paths = [];
  for (const a of lead.concat(rest)) { const p = clean(a.path, PATH_CHARS); if (p && paths.indexOf(p) < 0 && paths.length < PATHS_MAX) paths.push(p); }
  const images = imageCalls(input.rows).slice(-IMAGES_MAX).map(im => {
    const out = { path: im.path, model: im.model };
    if (im.prompt && !input.tainted) out.prompt = clean(scrub(im.prompt), PROMPT_CHARS);
    if (im.aspect) out.aspect = im.aspect;
    if (im.transparent) out.transparent = true;
    if (im.reference) out.reference = im.reference;
    return out;
  });
  const style = styleSpec((Array.isArray(input.files) ? input.files : []).filter(f => unchangedSince(f, input.ranUntil)));
  const tools = methodOf(input.toolTrace);
  if (!paths.length && !images.length && !style.palette.length && !style.fonts.length && !tools) return null;
  // v1 copied requested shape/alpha/reference. v2 derives those fields from the saved receipt.
  const ref = { v: 2 };
  if (paths.length) ref.paths = paths;
  if (images.length) ref.images = images;
  if (style.palette.length) ref.palette = style.palette;
  if (style.fonts.length) ref.fonts = style.fonts;
  if (tools) ref.tools = tools;
  if (paths.length && input.agentId) ref.agent = clean(input.agentId, 40);
  return ref;
}

/* refLine(ref, level, viewer) -> the " → …" tail a taste line carries. level 0 = everything; 1 = the main file + 3 colours +
   the main font; 2 = the main file only (or the first two steps of the method when the work left no file). viewer = the
   agent whose prompt this is: files in ANOTHER agent's private workspace are tagged [<agent> workspace] — that agent's
   jail, which this one cannot open, so it matches them from the line instead of failing a read. */
function tailClip(p, n) { const t = str(p); return t.length > n ? '…' + t.slice(t.length - n + 1) : t; }
function imageBit(im, receiptBacked) {
  // Old records still point to useful files/prompts, but their requested-only properties are unproved.
  const how = [im.model, receiptBacked ? im.aspect : '', receiptBacked && im.transparent ? 'transparent' : '', receiptBacked && im.reference ? 'reference sent: ' + im.reference : ''].filter(Boolean).join(', ');
  return 'image' + (im.prompt ? ' "' + im.prompt + '"' : '') + (how ? ' (' + how + ')' : '');
}
function refLine(ref, level, viewer) {
  if (!ref || typeof ref !== 'object') return '';
  const where = ref.agent && ref.agent !== viewer ? '[' + str(ref.agent) + ' workspace] ' : '';
  const paths = Array.isArray(ref.paths) ? ref.paths : [];
  const palette = Array.isArray(ref.palette) ? ref.palette : [];
  const fonts = Array.isArray(ref.fonts) ? ref.fonts : [];
  const images = Array.isArray(ref.images) ? ref.images : [];
  const tools = str(ref.tools);
  const lv = Number(level) || 0;
  const bits = [];
  if (lv >= 2) {
    if (paths[0]) return ' → ' + where + tailClip(paths[0], 80);
    return tools ? ' · via ' + tools.split(' → ').slice(0, 2).join(' → ') : '';
  }
  if (lv === 1) {
    if (palette.length) bits.push('palette ' + palette.slice(0, 3).join(' '));
    if (fonts[0]) bits.push('font ' + fonts[0]);
    if (!paths[0] && tools) bits.push('via ' + tools.split(' → ').slice(0, 3).join(' → '));
    return (paths[0] ? ' → ' + where + paths[0] : '') + (bits.length ? ' · ' + bits.join(' · ') : '');
  }
  if (palette.length) bits.push('palette ' + palette.join(' '));
  if (fonts.length) bits.push('fonts ' + fonts.join(', '));
  for (const im of images) bits.push(imageBit(im, ref.v >= 2));
  if (tools) bits.push('via ' + tools);
  return (paths.length ? ' → ' + where + paths.join(', ') : '') + (bits.length ? ' · ' + bits.join(' · ') : '');
}

module.exports = { isDesignPath, colorsIn, fontsIn, styleSpec, imageCalls, methodOf, buildRef, refLine, DESIGN_EXT };
