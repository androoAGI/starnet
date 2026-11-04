/* node test/live-markdown-incremental.test.js — a streaming reply redraws only its open end, and draws exactly what a full render does.

   perf p5 (2026-10-20, a user: "eats my PC's resources"): COMMS re-parsed the whole live paragraph's markdown and rebuilt it
   through innerHTML on every animation frame (chat.js renderProse, called from streamingAgent's flushProse) — O(n) per frame,
   O(n²) per answer. Now renderMarkdown(raw, { prev }) resumes from the last block the previous frame's lines still decide, and
   renderProseLive keeps the DOM nodes of the blocks before it. Locked by EXECUTING the shipped functions sliced from chat.js:
     1. on random markdown streamed in random pieces (and edited behind the stream, as the marker hold-back does), every live
        frame's HTML equals a full render of the same text;
     2. a long reply's frame re-parses only its last block or two;
     3. renderProse({ live }) keeps the earlier blocks' nodes (the same objects), redraws the rest, hydrates only what it drew,
        and its body always reads exactly as the full render's;
     4. the live paragraph asks for it, and a closed one lets it go. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8').replace(/\r\n/g, '\n');
function extract(name) {
  const m = new RegExp('(  function ' + name + '\\([\\s\\S]*?\\n  \\})').exec(chat);
  A.ok(m, 'chat.js still defines ' + name + '()');
  return m ? m[1] : '';
}
// eslint-disable-next-line no-new-func
const renderMarkdown = new Function('U',
  /  const REL_PATH = [^\n]*;/.exec(chat)[0] + '\n' +
  ['escapeHtml', 'linkify', 'mdInline', 'hostOf', 'linkHostNote', 'appFileRef', 'fileRefLink', 'fileRefImage', 'reportInline', 'renderFence', 'renderMarkdown'].map(extract).join('\n') +
  '\nreturn renderMarkdown;')(require('../frontend/js/util.js'));

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];
const LINES = ['Plain words here.', 'more **bold** and `code` and *it*', 'see https://example.com/a.', 'a [link](https://x.org) b', '[file](out/r.md) and ![pic](out/p.png)',
  '', '', '', '  ', '- item', '- item two', '  - nested', '    deeper', '* star', '+ plus', '1. one', '2) two', '10. ten', '   continuation', '\tindented',
  '```', '```js', 'code line', '# Heading', '### Sub', '> quote', '> more', '| a | b |', '| --- | --- |', '|:---|---:|', 'x | y', '| 1 | 2 |', 'a \\| b | c',
  'FORK: q || a | b', '---', '<b>raw</b> & stuff'];
function doc() { const n = 1 + Math.floor(rnd() * 40); const out = []; for (let i = 0; i < n; i++) out.push(pick(LINES)); return out.join(rnd() < 0.15 ? '\r\n' : '\n'); }

/* ---------- 1. every live frame equals the full render ---------- */
let frames = 0, wrong = 0, firstWrong = '', reused = 0;
for (let k = 0; k < 400; k++) {
  const text = doc();
  let prev = null, at = 0;
  while (at < text.length) {
    at = Math.min(text.length, at + (rnd() < 0.3 ? 1 : 1 + Math.floor(rnd() * 12)));
    let shown = text.slice(0, at);
    if (rnd() < 0.1) shown = shown.slice(0, Math.max(0, shown.length - Math.floor(rnd() * 6)));   // the live text held a tail back
    if (rnd() < 0.03 && shown.length > 10) { const c = Math.floor(rnd() * shown.length); shown = shown.slice(0, c) + shown.slice(c + 1); }   // edited behind the stream
    const live = { prev };
    const got = renderMarkdown(shown, live), want = renderMarkdown(shown);
    frames++; if (live.kept > 0) reused++;
    if (got !== want || !live.next || live.next.parts.join('') !== want) { wrong++; if (!firstWrong) firstWrong = JSON.stringify(shown); }
    prev = live.next;
  }
}
A.eq(wrong, 0, 'every live frame draws exactly the full render (' + frames + ' frames)' + (firstWrong ? ' — first difference on ' + firstWrong : ''));
A.ok(reused > frames / 2, 'most frames keep earlier blocks (' + reused + ' of ' + frames + ')');

/* ---------- 2. a long reply's frame re-parses only its open end ---------- */
{
  const chunk = '## Section N\n\nA paragraph with **bold**, `code` and a [link](https://example.com/page).\nIts second line.\n\n- one\n- two\n  more\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```\n\n> said\n\n';
  let text = ''; for (let n = 1; text.length < 20000; n++) text += chunk.replace('N', String(n));
  let prev = null, worst = 0, last = null;
  for (let at = 40; at <= text.length; at += 17) {
    const live = { prev }; renderMarkdown(text.slice(0, at), live);
    if (prev) worst = Math.max(worst, prev.parts.length - live.kept);   // the previous frame's blocks this frame drew again
    prev = live.next; last = live;
  }
  A.ok(last.next.parts.length > 300, 'the reply has many blocks (' + last.next.parts.length + ')');
  A.ok(worst <= 2, 'each frame drew again at most ' + worst + ' of the blocks before it (of ' + last.next.parts.length + ')');
  for (const p of last.next.parts) if (!/^<(span|div|blockquote|ol|ul)[ >][\s\S]*<\/\1>$/.test(p)) { A.ok(false, 'every block is one element: ' + p.slice(0, 60)); break; }
}

/* ---------- 3. renderProse({ live }) on a body: kept nodes stay, the body reads as the full render ---------- */
const VOID = /^<(br|img|hr|input)\b/;
function splitTop(html) {   // the generated markup's top-level elements (escaped text never holds '<')
  const out = []; let depth = 0, start = 0;
  const re = /<\/?([a-z0-9]+)[^>]*>/g; let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') { if (--depth === 0) { out.push(html.slice(start, re.lastIndex)); start = re.lastIndex; } }
    else if (!VOID.test(m[0])) { if (depth++ === 0) start = m.index; }
  }
  return out;
}
let made = 0;
const node = html => ({ id: ++made, html, querySelectorAll: () => [], querySelector: () => null });
function body() {
  const b = { childNodes: [], hydrated: [] };
  Object.defineProperty(b, 'innerHTML', { get: () => b.childNodes.map(n => n.html != null ? n.html : n.text).join(''), set: h => { b.childNodes.splice(0, b.childNodes.length, ...splitTop(h).map(node)); } });
  Object.defineProperty(b, 'textContent', { get: () => b.innerHTML, set: t => { b.childNodes.splice(0, b.childNodes.length, { text: String(t) }); } });
  b.insertAdjacentHTML = (where, h) => { A.eq(where, 'beforeend', 'new blocks go after the kept ones'); b.childNodes.push(...splitTop(h).map(node)); };
  b.removeChild = n => { const i = b.childNodes.indexOf(n); if (i < 0) throw new Error('not a child'); b.childNodes.splice(i, 1); return n; };
  b.querySelectorAll = () => [];
  return b;
}
const hydrated = [];
// eslint-disable-next-line no-new-func
const renderProse = new Function('renderMarkdown', 'hydrateFileRefs', /const MD_MARKERS = [^;]+;/.exec(chat)[0] + '\n' + extract('renderProse') + '\n' + extract('renderProseLive') + '\nreturn renderProse;')(
  renderMarkdown, (b, roots) => hydrated.push(roots ? roots.length : 'all'));
{
  const text = 'Intro paragraph with **bold**.\n\n- one\n- two\n\nSecond paragraph keeps `streaming` along\nand along.\n\n## Done\n\nTail words';
  const b = body();
  let prevNodes = [], mismatched = 0, lost = 0, notLive = 0;
  for (let at = 1; at <= text.length; at++) {
    const shown = text.slice(0, at);
    hydrated.length = 0;
    renderProse(b, shown, { live: true });
    if (b.innerHTML !== (/\*\*|`|^\s*[-*+]\s|\n\s*\n|^#{1,6}\s/m.test(shown) ? renderMarkdown(shown) : shown)) mismatched++;
    const md = b.__mdLive;
    if (md) {
      const kept = b.childNodes.filter(n => prevNodes.includes(n)).length;
      // every node that survived is one of the earlier blocks, in place, and only what was drawn was hydrated
      if (b.childNodes.slice(0, kept).some((n, k) => n !== prevNodes[k])) lost++;
      if (hydrated.length !== 1 || hydrated[0] !== b.childNodes.length - kept) lost++;
      prevNodes = b.childNodes.slice();
    } else if (b.childNodes.length && b.childNodes[0].html) notLive++;
  }
  A.eq(mismatched, 0, 'every live frame leaves the body reading exactly as the full render');
  A.eq(lost, 0, 'kept blocks keep their nodes in place, and only the redrawn blocks are hydrated');
  A.eq(notLive, 0, 'a live markdown frame keeps its parse for the next one');
  const keptIntro = b.childNodes[0];
  renderProse(b, text + ' end', { live: true });
  A.ok(b.childNodes[0] === keptIntro, 'a token at the end leaves the intro paragraph\'s node untouched');
  renderProse(b, text + ' end.', {});
  A.eq(b.innerHTML, renderMarkdown(text + ' end.'), 'the closing render draws the full render');
  A.ok(b.childNodes[0] === keptIntro && b.__mdLive === null, 'the closing render reuses the kept blocks, then frees the live parse');
  // something else drew into the body: the next frame draws it all again, from scratch
  b.childNodes.push({ text: 'stray' });
  renderProse(b, text, { live: true });
  A.eq(b.innerHTML, renderMarkdown(text), 'a body that changed under the live parse is drawn whole');
  renderProse(b, 'plain now', { live: true });
  A.ok(b.innerHTML === 'plain now' && b.__mdLive === null, 'plain text takes the fast path and drops the live parse');
  // the non-live path is the renderer it always was
  const h = body(); hydrated.length = 0; renderProse(h, text);
  A.ok(h.innerHTML === renderMarkdown(text) && hydrated[0] === 'all' && h.__mdLive === null, 'a history row renders whole and keeps no live state');
}

/* ---------- 4. the wiring: the open paragraph asks for it, a closed one frees it ---------- */
{
  const sa = A.fnBody(chat, 'function streamingAgent(');
  A.ok(sa.length > 1000 && sa.length < chat.length / 2, 'streamingAgent sliced cleanly');
  A.ok(/renderProse\(seg\.body, lastShown, \{ files, live: !final \}\)/.test(sa), 'the live paragraph renders with live: true until its closing render');
  A.ok(/seg\.body\.__mdLive = null/.test(A.fnBody(sa, 'function closeSeg(')), 'closing a paragraph frees its live parse');
}

A.report('live-markdown-incremental.test');
