/* node test/delegated-file-links.test.js — the lead's report OPENS the file it names (live walk 10-14).
   The lead's final answer "COPY finished: tagline.md is saved and ready to open." was plain text: the file it named could
   be opened only by finding the delegation card. A file a worker of THIS conversation saved — the worker ledger's own
   artifacts, carried by /api/overseer as workers[].files — becomes an Open link wherever a crew message in the
   conversation names it, through the same door as the card's Open key (data-dg-file → Chat.openFile). Only files that
   were really saved; a name inside code, an existing link, a longer name or a path is left alone. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

// ---- a minimal DOM: text + element nodes, enough for the linker ----
function text(v) { return { nodeType: 3, nodeValue: v, parentNode: null }; }
function el(tag, cls, kids) {
  const n = { nodeType: 1, tagName: tag.toUpperCase(), className: cls || '', childNodes: [], parentNode: null, dataset: {}, attrs: {},
    classList: { contains: c => String(n.className).split(/\s+/).includes(c), add: c => { n.className = (n.className + ' ' + c).trim(); } },
    setAttribute(k, v) { n.attrs[k] = String(v); if (k.indexOf('data-') === 0) n.dataset[k.slice(5).replace(/-(\w)/g, (m, x) => x.toUpperCase())] = String(v); },
    getAttribute(k) { return n.attrs[k]; },
    appendChild(c) { c.parentNode = n; n.childNodes.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = n; const i = n.childNodes.indexOf(ref); n.childNodes.splice(i < 0 ? n.childNodes.length : i, 0, c); return c; },
    removeChild(c) { const i = n.childNodes.indexOf(c); if (i >= 0) n.childNodes.splice(i, 1); c.parentNode = null; return c; },
    get textContent() { return n.childNodes.map(c => c.nodeType === 3 ? c.nodeValue : c.textContent).join(''); },
    set textContent(v) { n.childNodes = [text(String(v))]; n.childNodes[0].parentNode = n; } };
  for (const k of kids || []) n.appendChild(typeof k === 'string' ? text(k) : k);
  return n;
}
global.document = { createTextNode: text, createElement: t => el(t), addEventListener() {}, getElementById: () => null };
global.Overseer = { snapshot: () => ({ workers: [
  { parentStreamId: 'ws1', agentId: 'copywriter', projectRoot: '', files: [{ path: 'tagline.md', agentId: 'copywriter' }] },
  { parentStreamId: 'ws1', agentId: 'strategist', projectRoot: 'C:/proj', files: [{ path: 'notes/plan.md', agentId: 'strategist' }] },
  { parentStreamId: 'other', agentId: 'copywriter', files: [{ path: 'secret.md', agentId: 'copywriter' }] }
] }) };
const D = require('../frontend/app/delegated.js');
const I = D._internals;

const files = I.savedFiles('ws1');
A.ok(files.get('tagline.md') && files.get('tagline.md').agentId === 'copywriter', 'a worker\'s saved file is known by its name, with the workspace it lives in');
A.ok(files.get('plan.md') && files.get('notes/plan.md') && files.get('plan.md').projectRoot === 'C:/proj', 'a file in a folder is known by its path and its name, in its project');
A.ok(!files.has('secret.md'), 'another conversation\'s files never link here');
A.eq(I.savedFiles('nobody').size, 0, 'a conversation without delegated files links nothing');

const links = body => { const out = []; const walk = n => { for (const c of n.childNodes || []) { if (c.nodeType === 1 && c.tagName === 'A' && c.dataset.dgFile) out.push(c); else if (c.nodeType === 1) walk(c); } }; walk(body); return out; };
{
  const body = el('span', 'body', ['COPY finished: tagline.md is saved and ready to open.']);
  I.linkMentions(body, files);
  const ls = links(body);
  A.eq(ls.length, 1, 'the report\'s mention of the saved file becomes one link');
  A.eq(ls[0].textContent + '|' + ls[0].dataset.dgFile + '|' + ls[0].dataset.dgAgent + '|' + ls[0].dataset.dgProject, 'tagline.md|tagline.md|copywriter|', 'it opens that file in COPY\'s workspace through the card\'s own door');
  A.eq(body.textContent, 'COPY finished: tagline.md is saved and ready to open.', 'the sentence reads exactly as written');
  I.linkMentions(body, files);
  A.eq(links(body).length, 1, 'linking again never wraps a link twice');
}
{
  const body = el('span', 'body', ['STRATEGY — wrote notes/plan.md; ', el('code', 'md-code', ['npm run tagline.md']), ' and ', el('a', '', ['tagline.md']), ' and mytagline.md and tagline.mdx and tagline.md.bak and (tagline.md)']);
  I.linkMentions(body, files);
  const ls = links(body);
  A.eq(ls.map(a => a.textContent).join(','), 'notes/plan.md,tagline.md', 'a path links whole; other code, links, longer names and other files stay text: ' + ls.map(a => a.textContent).join(','));
  A.eq(ls[0].dataset.dgProject, 'C:/proj', 'a project file opens in its project');
}
{
  // LIVE (10-14 re-walk): the lead wrote "saved it to `tagline.md`." — a code span that IS the saved file's name
  const code = el('code', 'md-code', ['tagline.md']);
  const body = el('span', 'body', [el('span', 'md-p', ['Done. COPY saved it to ', code, '.'])]);
  I.linkMentions(body, files);
  const ls = links(body);
  A.ok(ls.length === 1 && ls[0].childNodes[0] === code && ls[0].dataset.dgFile === 'tagline.md', 'a backticked saved-file name stays code-styled and becomes the link');
  A.eq(body.textContent, 'Done. COPY saved it to tagline.md.', 'and the sentence still reads as written');
}

// ---- the wiring ----
const dg = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'delegated.js'), 'utf8');
const idx = readSidecarSource();
A.ok(/linkSavedFiles\(parentId\)/.test(A.fnBody(dg, 'function repaint()')), 'every repaint (each ledger poll, each history render) links the open conversation\'s reports');
A.ok(/\.cmsg\.agent:not\(\.tool\) > \.body/.test(A.fnBody(dg, 'function linkSavedFiles(parentId)')), 'only crew message prose is linked, never a tool line or a card');
A.ok(/files: \(Array\.isArray\(w\.artifacts\) \? w\.artifacts : \[\]\)/.test(idx) && /projectRoot: w\.projectRoot \|\| ''/.test(idx), '/api/overseer carries each worker\'s saved files and its project');
A.ok(!/abs: a\.abs/.test(idx), '…by relative path, never the absolute disk path');
const click = A.fnBody(dg, 'function wire()');
A.ok(/getSelection/.test(click), 'ending a text selection over a file name never opens it');

A.report('delegated-file-links');
