/* A group rail row READS whole names (walk 10-14 #6, Andrew 10-13: "ULTRON, CYPHER +3").
   Measured on the 0.13.5 candidate at 1440x900: COMPACT gave the names 66 of the 74 px they need ("ULTRON, CYP… +3"),
   INBOX gave 48-82 of 123 ("ULTR… +3") at every width — the time and an empty pin column shared the names' line.
   Locks: (1) the row gives the names line its WHOLE first line in both layouts (the time moves to the title's line);
   (2) when two names still cannot fit, the line reads the first name + the rest counted ("ULTRON +4"), never a name
   cut mid-word, and a wider rail brings the second name back; (3) the compact names line is not shrunken text. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('frontend/app/app.js');

/* ---- (2) the fit: a small DOM whose names span measures its own text against the room it was given ---- */
const CH = 8;   // px per character in this fake font
class El {
  constructor(cls, text) { this.className = cls; this.textContent = text || ''; this.dataset = {}; this.children = []; this.parent = null; this.room = 0; this.laidOut = true; }
  get scrollWidth() { return this.textContent.length * CH; }
  get clientWidth() { return Math.min(this.room, this.scrollWidth); }
  getClientRects() { return this.laidOut ? [{}] : []; }
  querySelector(sel) { const c = sel.replace(/^\./, ''); return this.children.find(k => k.className === c) || null; }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(k => k !== this); this.parent = null; }
}
const body = A.fnBody(app, 'function fitRailAgentLine(line)');
A.ok(body.length > 40 && body.length < 4000, 'app.js has one bounded fitRailAgentLine(line)');
const ctx = vm.createContext({ document: { createElement: () => new El('') } });
vm.runInContext(body + '\nthis.fit = fitRailAgentLine;', ctx);
const line = (names, more, room) => {
  const l = new El('ws-agent ws-agent-group'), n = l.appendChild(new El('ws-agent-names', names));
  n.room = room; if (more) l.appendChild(new El('ws-agent-more', more));
  return l;
};
const read2 = l => [l.querySelector('.ws-agent-names').textContent, (l.querySelector('.ws-agent-more') || {}).textContent || ''];
{
  const l = line('ULTRON, CYPHER', '+3', 14 * CH);
  ctx.fit(l);
  A.eq(read2(l), ['ULTRON, CYPHER', '+3'], 'both names fit: the line reads "ULTRON, CYPHER +3" untouched');
}
{
  const l = line('ULTRON, CYPHER', '+3', 9 * CH);
  ctx.fit(l);
  A.eq(read2(l), ['ULTRON', '+4'], 'two names cannot fit: the first name stays whole and CYPHER joins the count — never "ULTRON, CYP…"');
  l.querySelector('.ws-agent-names').room = 20 * CH; ctx.fit(l);
  A.eq(read2(l), ['ULTRON, CYPHER', '+3'], 'a wider rail (or the COMPACT/INBOX switch) brings the second name back from the full reading');
}
{
  const l = line('ULTRON, CYPHER', '', 9 * CH);
  ctx.fit(l);
  A.eq(read2(l), ['ULTRON', '+1'], 'a two-member group that cannot show both names counts the second one');
  l.querySelector('.ws-agent-names').room = 20 * CH; ctx.fit(l);
  A.eq(read2(l), ['ULTRON, CYPHER', ''], 'and drops the count again when both fit (no "+0")');
}
{
  const l = line('ULTRON, CYPHER', '+3', 9 * CH); l.laidOut = false;
  ctx.fit(l);
  A.eq(read2(l), ['ULTRON, CYPHER', '+3'], 'a line that is not laid out (hidden row) is left alone, never folded on a zero measure');
}
{
  // the glass INBOX headline WRAPS its names at a space (pipglass.css, rc walk 10-14): every name already shows whole on its
  // own lines there, so the line keeps "ULTRON, CYPHER +3" however narrow the rail — it never folds to "ULTRON +4"
  const wrapCtx = vm.createContext({ document: { createElement: () => new El('') }, getComputedStyle: () => ({ whiteSpace: 'normal' }) });
  vm.runInContext(body + '\nthis.fit = fitRailAgentLine;', wrapCtx);
  const l = line('ULTRON, CYPHER', '+3', 9 * CH);
  wrapCtx.fit(l);
  A.eq(read2(l), ['ULTRON, CYPHER', '+3'], 'a names line that wraps keeps both whole names and its count');
  const nowrapCtx = vm.createContext({ document: { createElement: () => new El('') }, getComputedStyle: () => ({ whiteSpace: 'nowrap' }) });
  vm.runInContext(body + '\nthis.fit = fitRailAgentLine;', nowrapCtx);
  const l2 = line('ULTRON, CYPHER', '+3', 9 * CH);
  nowrapCtx.fit(l2);
  A.eq(read2(l2), ['ULTRON', '+4'], 'a names line that never wraps still folds the second name into the count');
}
const render = A.fnBody(app, 'function renderRail()');
A.ok(/fitRailAgentLines\(\)/.test(render), 'renderRail fits every group line after it builds the rows');
const lines = A.fnBody(app, 'function fitRailAgentLines()');
A.ok(/ResizeObserver/.test(lines) && /fitRailAgentLine\(/.test(lines), 'a rail width or row-layout change re-fits the lines (ResizeObserver)');

/* ---- (1)(3) the layout: the names own their whole first line; the time sits on the title's line ---- */
const rulesOf = file => {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sels: m[1].split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, ' ')), body: m[2] }));
};
const decl = (rules, sel, prop) => {
  let v = null;
  for (const r of rules) if (r.sels.includes(sel)) { const m = r.body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)')); if (m) v = m[1].trim(); }
  return v;
};
const appCss = rulesOf('frontend/css/app.css'), pip = rulesOf('frontend/css/pipglass.css');
const compact = 'body:not(.rows-inbox) #workstreams .ws-row:has(> .ws-agent-group)';
// COMPACT opens on the title like every other row (Andrew 10-27); the names keep a whole line of their own, under it
A.ok(/"dot title pin meta"\s*"\. agent agent agent"/.test(decl(appCss, compact, 'grid-template-areas') || ''), 'COMPACT: the names span a whole line under the title; pin and time sit on the title line');
const compactAttn = 'body:not(.rows-inbox) #workstreams .ws-row.attn:has(> .ws-agent-group)';
A.ok(/^"dot title title pin"\s*"\. agent agent agent"/.test(decl(appCss, compactAttn, 'grid-template-areas') || ''), 'COMPACT attention row: the names still own a whole line (a hover kebab never squeezes them)');
const fsz = parseFloat(decl(appCss, 'body:not(.rows-inbox) #workstreams .ws-agent.ws-agent-group', 'font-size') || '0');
A.ok(fsz >= 14, 'the COMPACT names line is at least the 14px glass floor (was 12px under a 17px title), got ' + fsz);
const inboxGlass = 'body.glass-demo.rows-inbox:not(.hud-mode) #left #workstreams .ws-row:has(> .ws-agent-group)';
A.ok(/"dot\s+agent\s+agent\s+agent"\s*"\.\s+title\s+pin\s+meta"/.test(decl(pip, inboxGlass, 'grid-template-areas') || ''), 'INBOX (glass): the names span the whole first line; pin and time sit on the title line');
const inboxGlassAttn = 'body.glass-demo.rows-inbox:not(.hud-mode) #left #workstreams .ws-row.attn:has(> .ws-agent-group)';
A.ok(/^"dot agent agent agent"/.test(decl(pip, inboxGlassAttn, 'grid-template-areas') || ''), 'INBOX attention row: the names own the first line too');
A.ok(/"dot agent agent agent"/.test(decl(appCss, 'body.rows-inbox #workstreams .ws-row:has(> .ws-agent-group)', 'grid-template-areas') || ''), 'INBOX (base sheet): the same names line');
A.report('rail-group-line-fit.test');
