'use strict';
/* node test/user-text.census.test.js — ONE flattener of a message's text parts (turn identity, commit 4; bug e7dcb889).

   Seven functions across the sidecar each joined a message's text parts their own way, so the run title, the transcript
   row, the task brief and the study pass could each read a different message for one attachment turn. They now delegate
   to frontend/app/usertext.js and name a policy. This test holds that:
     1. CENSUS — no function in sidecar/**.js or frontend/app/*.js (usertext.js aside) joins text parts itself. A line that
        joins with a `.text`-string or `type === 'text'` test, or pushes `X.text` behind a `typeof X.text === 'string'`
        test, must sit in an allowlisted function (file#fn) with its reason: provider wire mappers, model RESPONSE text,
        MCP/tool result text, a classifier over expanded input, the HUD's display. A stale
        allowlist entry (one that no longer matches anything) fails too.
     2. DELEGATES — each former copy is now a delegate that names its policy.
     3. BYTES — every policy is byte-identical to the copy it replaced (frozen verbatim below) over a fixture corpus: the
        content rung of directive reuse and transcriptstore's markRecorded/taintOf compare against rows already on disk.
   Fails on the base: the seven copies are flagged, no delegate names a policy, and usertext.js does not exist. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { sidecarSourceFiles, functionSourceIn } = require('./helpers/source');

const ROOT = path.resolve(__dirname, '..');
const OWN = 'frontend/app/usertext.js';

// ---------------- 1. the census ----------------
const ALLOW = {
  'sidecar/channels/delivery-ledger.js#deliveryText': 'CDL delivery identity signature: compares text plus file-path sentinels for idempotency collisions, omits notes; not a prompt or user-message projection',
  'sidecar/providers/anthropic.js#textFromContent': 'provider wire mapper: a message into Anthropic\'s request shape (also reads `.content` parts)',
  'sidecar/providers/gemini.js#textFromContent': 'provider wire mapper: a message into Gemini\'s request shape (also reads `.content` parts)',
  'sidecar/providers/claude-cli.js#textOf': 'provider wire mapper: the CLI prompt, with image placeholders',
  'sidecar/providers/provider.js#contentText': 'provider wire helper over any role\'s content (a non-string non-array content is String()-ed)',
  'sidecar/loop.js#sourceGroundingRequested': 'a classifier over the EXPANDED input (deliberately sees attached text), not a reader of the directive',
  'sidecar/tools/builtin/image.js#textFromResponse': 'the image model\'s RESPONSE text, not a user message',
  'sidecar/tools/builtin/cua-runtime.js#data': 'a tool RESULT\'s text parts, not a user message',
  'sidecar/mcp/translate.js#renderContent': 'an MCP tool RESULT (resources, images, audio rendered as placeholders), not a user message',
  'sidecar/index.js#readPostconditionConnector': 'a connector read-back\'s MCP tool content, not a user message',
  'frontend/app/hudmode.js#textOf': 'the HUD\'s display of a row, any role'
};
const TEXT_TEST = /typeof\s+[\w$.\[\]()]+\.text\s*===\s*['"]string['"]|\.type\s*===\s*['"]text['"]/;
const PUSH_TEXT = /\.push\([\w$]+\.text\)/;
const PUSH_GUARD = /typeof\s+[\w$]+\.text\s*===\s*['"]string['"]/;
const HEADS = [
  /\bfunction\s+([\w$]+)\s*\(/,
  /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/,
  /(?:^|[\s,{])([\w$]+)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/,
  /^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|function\b)([\w$]+)\s*\([^)]*\)\s*\{\s*$/
];
// the nearest named function head at or above line i (a scanner, not a parser: the allowlist names what it finds)
function fnAt(lines, i) {
  for (let j = i; j >= 0; j--) for (const re of HEADS) { const m = re.exec(lines[j]); if (m) return m[1]; }
  return '?';
}
function flagged(rel, text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const joins = /\.join\(/.test(l) && TEXT_TEST.test(l);
    const pushes = PUSH_TEXT.test(l) && PUSH_GUARD.test(l);
    if (joins || pushes) out.push({ key: rel + '#' + fnAt(lines, i), line: i + 1, text: l.trim().slice(0, 160) });
  });
  return out;
}
// the detector against fixtures (a census whose regex is wrong locks the wrong thing)
A.eq(flagged('x.js', "function a(c) {\n  return c.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ');\n}").map(f => f.key), ['x.js#a'], 'detects a map-join over `.text` strings');
A.eq(flagged('x.js', "function b(c) {\n  for (const p of c) {\n    if (p && typeof p.text === 'string') parts.push(p.text);\n  }\n}").map(f => f.key), ['x.js#b'], 'detects a guarded push of `.text`');
A.eq(flagged('x.js', "const c = m => m.content.filter(p => p.type === 'text').map(p => p.text).join('\\n');").map(f => f.key), ['x.js#c'], 'detects a type-filtered join, in an arrow');
A.eq(flagged('x.js', "function d(list) { return list.map(String).join(', '); }").length, 0, 'an unrelated join is not flagged');
A.eq(flagged('x.js', "function e(p) { if (typeof p.text === 'string') return p.text; }").length, 0, 'a single-part read is not a join');

const files = sidecarSourceFiles().map(f => ({ rel: f.rel, text: f.text }))
  .concat(fs.readdirSync(path.join(ROOT, 'frontend', 'app')).filter(n => n.endsWith('.js')).sort()
    .map(n => ({ rel: 'frontend/app/' + n, text: fs.readFileSync(path.join(ROOT, 'frontend', 'app', n), 'utf8') })))
  .filter(f => f.rel !== OWN);
A.ok(files.length > 300 && files.some(f => f.rel === 'sidecar/index.js') && files.some(f => f.rel === 'frontend/app/chat.js'), 'fixture: the census reads the sidecar and the page modules (' + files.length + ' files)');
const hits = [].concat(...files.map(f => flagged(f.rel, f.text)));
const copies = hits.filter(h => !Object.prototype.hasOwnProperty.call(ALLOW, h.key));
A.eq(copies.map(h => h.key + ':' + h.line), [], 'no function outside usertext.js joins a message\'s text parts (delegate to UserText and name a policy): ' + copies.map(h => h.key + ':' + h.line + ' ' + h.text).join(' | '));
for (const key of Object.keys(ALLOW)) A.ok(hits.some(h => h.key === key), 'allowlist entry ' + key + ' still matches a join (a stale entry is removed, not kept)');

// ---------------- 2. every former copy delegates and names its policy ----------------
const DELEGATES = [
  ['sidecar/index.js', 'userMsgText', 'DIRECTIVE'], ['sidecar/index.js', 'latestUserText', 'DIRECTIVE'], ['sidecar/index.js', 'recentUserTexts', 'DIRECTIVE'],
  ['sidecar/earlier-conversation.js', 'userText', 'DIRECTIVE'], ['sidecar/attachments.js', 'textOf', 'DIRECTIVE'],
  ['sidecar/tasteref.js', 'contentText', 'STORED'], ['sidecar/transcriptstore.js', 'flattenContent', 'STORED'],
  ['sidecar/observer.js', 'lastUserText', 'OBSERVER'], ['sidecar/trusted-learning.js', 'textOf', 'LEARNING'],
  ['sidecar/openai-compat.js', 'normalizeContent', 'OPENAI'], ['sidecar/compaction-fidelity.js', 'userText', 'LABELLED']
];
for (const [rel, fn, pol] of DELEGATES) {
  const file = files.find(f => f.rel === rel);
  const body = file ? functionSourceIn(file.text, fn) : '';
  A.ok(body.length > 0 && body.length < 400, rel + '#' + fn + ' is found and is a short delegate (' + body.length + ' chars)');
  A.ok(new RegExp('UserText\\.(?:flatten|latest|recent)\\([^)]*UserText\\.' + pol + '\\)').test(body), rel + '#' + fn + ' delegates to UserText under the ' + pol + ' policy');
}

// ---------------- 3. the policies are the bytes the copies wrote (each copy frozen verbatim from the base) ----------------
const TRUNK = {
  userMsgText(m) {   // index.js userMsgText = earlier-conversation userText
    if (!m || m.role !== 'user') return null;
    if (typeof m.content === 'string') return m.content;
    if (!Array.isArray(m.content)) return null;
    const parts = [];
    for (const p of m.content) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p.text === 'string') parts.push(p.text);
    }
    return parts.join('');
  },
  latestUserText(list) {
    const msgs = Array.isArray(list) ? list : [];
    for (let i = msgs.length - 1; i >= 0; i--) { const t = TRUNK.userMsgText(msgs[i]); if (t != null) return t; }
    return '';
  },
  recentUserTexts(list, n) {
    const msgs = Array.isArray(list) ? list : [];
    const out = [];
    for (let i = msgs.length - 1; i >= 0 && out.length < n; i--) { const t = TRUNK.userMsgText(msgs[i]); if (t != null) out.push(t); }
    return out;
  },
  attachmentsTextOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const out = [];
    for (const p of content) {
      if (typeof p === 'string') out.push(p);
      else if (p && typeof p.text === 'string') out.push(p.text);
    }
    return out.join('');
  },
  stored(c) {   // transcriptstore flattenContent = tasteref contentText
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ');
    return '';
  },
  observerLastUserText(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').filter(Boolean).join(' ');
      return '';
    }
    return '';
  },
  learningTextOf(message) {
    if (!message || message.role !== 'user') return '';
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  },
  normalizeContent(content, depth) {
    depth = depth || 0;
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      if (depth > 6) return '';
      const parts = [];
      for (const item of content.slice(0, 1000)) {
        if (typeof item === 'string') { if (item) parts.push(item); continue; }
        if (item && typeof item === 'object') {
          const t = String(item.type || '').trim().toLowerCase();
          if (t === 'text' || t === 'input_text' || t === 'output_text') { if (item.text != null) parts.push(String(item.text)); }
        }
      }
      return parts.join('\n');
    }
    try { return String(content); } catch (_) { return ''; }
  },
  labelled(content) {
    if (typeof content === 'string') return content.trim() ? content : '';
    if (!Array.isArray(content)) return '';
    const texts = [];
    let images = 0;
    for (const p of content) {
      if (typeof p === 'string') { if (p.trim()) texts.push(p); continue; }
      if (!p || typeof p !== 'object') continue;
      const type = String(p.type || '');
      if (typeof p.text === 'string' && (!type || /text/.test(type))) texts.push(p.text);
      else if (/image/.test(type)) images++;
    }
    if (texts.length && texts[0].indexOf('[BEGIN EXTERNAL SCREEN CAPTURE') === 0) return '';
    const t = texts.join('\n');
    if (!t.trim()) return '';
    return images ? t + '\n[' + images + ' image' + (images === 1 ? '' : 's') + ' attached - not carried]' : t;
  }
};
const CONTENTS = [
  'plain words', '', '  ', 'multi\nline', [], ['bare string part'], ['a', 'b'],
  [{ type: 'text', text: 'one' }], [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
  [{ type: 'text', text: '' }, { type: 'text', text: 'after empty' }],
  [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
  [{ type: 'text', text: 'caption' }, { type: 'image_url', image_url: { url: 'data:x' } }, { type: 'text', text: '\n\n[Attached file: notes.txt]\n```\nbytes\n```' }],
  [{ type: 'input_text', text: 'typed by another adapter' }, { text: 'untyped part' }], ['str', { type: 'text', text: 'obj' }, null, 7, { type: 'text', text: 5 }],
  [{ type: 'text' }, { type: 'text', text: null }], undefined, null, 42, { text: 'an object, not parts' },
  ['', { type: 'text', text: '' }, 'tail'], [{ type: ' OUTPUT_TEXT ', text: false }, { type: 'text', text: 0 }],
  [{ text: '[BEGIN EXTERNAL SCREEN CAPTURE pixels' }, { type: 'image_url' }],
  [{ type: 'text', text: 'caption' }, { type: 'image_url' }, { type: 'image' }],
  [{ type: 'context', text: 'regex text kind' }, { type: 'image', text: 'not a caption' }]
];
const MESSAGES = [];
for (const c of CONTENTS) MESSAGES.push({ role: 'user', content: c });
MESSAGES.push({ role: 'assistant', content: 'not a user turn' }, { role: 'system', content: [{ type: 'text', text: 'sys' }] }, null, { role: 'user' }, { role: 'tool', content: 'r' });
const LISTS = [[], MESSAGES, MESSAGES.slice(0, 5), [{ role: 'user', content: 'old' }, { role: 'user', content: 42 }], [{ role: 'user', content: 'old' }, { role: 'user', content: null }],
  [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }], [{ role: 'user', content: [{ type: 'image_url' }] }, { role: 'user', content: undefined }], 'not a list', null];

let UserText = null;
try { UserText = require('../frontend/app/usertext.js'); } catch (e) { UserText = null; }
A.ok(!!UserText, 'frontend/app/usertext.js exists and loads (the one flattener)');
if (UserText) {
  const EC = require('../sidecar/earlier-conversation.js');
  const Obs = require('../sidecar/observer.js');
  const TL = require('../sidecar/trusted-learning.js');
  const OAI = require('../sidecar/openai-compat.js');
  const labelledSource = functionSourceIn(files.find(f => f.rel === 'sidecar/compaction-fidelity.js').text, 'userText');
  const labelled = new Function('UserText', labelledSource + '; return userText;')(UserText);
  const same = (label, got, want) => A.eq(JSON.stringify(got === undefined ? '<undefined>' : got), JSON.stringify(want === undefined ? '<undefined>' : want), label);
  let n = 0;
  for (const m of MESSAGES) {
    const c = m && m.content;
    same('DIRECTIVE = userMsgText for ' + JSON.stringify(m), m && m.role === 'user' ? UserText.flatten(c, UserText.DIRECTIVE) : null, TRUNK.userMsgText(m));
    same('earlier-conversation userText (delegate) = its copy for ' + JSON.stringify(m), EC.userText(m), TRUNK.userMsgText(m));
    same('DIRECTIVE (null -> \'\') = attachments textOf for ' + JSON.stringify(c), (t => t == null ? '' : t)(UserText.flatten(c, UserText.DIRECTIVE)), TRUNK.attachmentsTextOf(c));
    same('STORED = flattenContent / tasteref contentText for ' + JSON.stringify(c), UserText.flatten(c, UserText.STORED), TRUNK.stored(c));
    same('trusted-learning textOf (delegate, LEARNING) = its copy for ' + JSON.stringify(m), TL.textOf(m), TRUNK.learningTextOf(m));
    same('OPENAI = normalizeContent for ' + JSON.stringify(c), UserText.flatten(c, UserText.OPENAI), TRUNK.normalizeContent(c));
    same('LABELLED = compaction userText for ' + JSON.stringify(c), labelled(c), TRUNK.labelled(c));
    for (const depth of [undefined, 0, 6, 7]) same('OpenAI delegate keeps depth ' + depth + ' for ' + JSON.stringify(c), OAI.normalizeContent(c, depth), TRUNK.normalizeContent(c, depth));
    n += 11;
  }
  for (const list of LISTS) {
    same('latest DIRECTIVE = latestUserText for ' + JSON.stringify(list), UserText.latest(list, UserText.DIRECTIVE), TRUNK.latestUserText(list));
    for (const k of [0, 1, 2, 30]) same('recent DIRECTIVE = recentUserTexts(' + k + ') for ' + JSON.stringify(list), UserText.recent(list, k, UserText.DIRECTIVE), TRUNK.recentUserTexts(list, k));
    same('observer lastUserText (delegate, OBSERVER) = its copy for ' + JSON.stringify(list), Obs.lastUserText(list), TRUNK.observerLastUserText(list));
    n += 6;
  }
  A.ok(n > 150, 'fixture: the byte comparison covered ' + n + ' cases');
  const capped = Array.from({ length: 1001 }, (_, i) => 'part-' + i);
  same('OPENAI keeps its 1000-part cap', OAI.normalizeContent(capped), TRUNK.normalizeContent(capped));
  const unprintable = { toString() { throw new Error('not stringifiable'); } };
  same('OPENAI keeps its fail-closed scalar coercion', OAI.normalizeContent(unprintable), TRUNK.normalizeContent(unprintable));
  A.ok(Object.isFrozen(UserText.DIRECTIVE) && Object.isFrozen(UserText.POLICIES), 'policies are frozen data');
}

A.report('user-text.census');
