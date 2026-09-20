'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Small DOM executes the actual controller; HTTP timing is controlled, not UI state.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this.value = ''; this.classList = { add() {}, remove() {} }; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, next) { node.parent = this; const index = this.children.indexOf(next); if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
  setAttribute() {}
  focus() {}
  set innerHTML(html) {
    const stack = [this]; this.children = [];
    for (const match of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
      if (match[0].startsWith('</')) { stack.pop(); continue; }
      const node = new Element(match[1]); node.className = (match[2].match(/class="([^"]*)"/) || [,''])[1]; stack.at(-1).append(node);
      if (!['input', 'br'].includes(match[1])) stack.push(node);
    }
  }
  querySelectorAll(selector) {
    if (selector.includes(' ')) { const [head, tail] = selector.split(' '); return this.querySelectorAll(head).flatMap(n => n.querySelectorAll(tail)); }
    const walk = n => n.children.flatMap(c => [c, ...walk(c)]);
    return walk(this).filter(n => selector[0] === '.' ? n.className.split(' ').includes(selector.slice(1)) : n.tagName === selector.split(':')[0] && (!selector.endsWith(':checked') || n.checked));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
(async () => {
  const stage = new Element('div'), comms = new Element('aside'), log = new Element('div'), body = new Element('body'), timers = new Map(), sessions = new Map();
  let serial = 0, active = '', opens = 0, request;
  const data = root => ({ project: { root, blessed: true, preferredAgents: [] }, session: { id: root + '-home' }, crew: [{ id: 'agent', name: 'Lead' }, { id: 'mira', name: 'Mira' }], activity: [{ id: root + '-worker', agentId: 'mira', prompt: 'Research the project', status: 'running', working: true, canInterrupt: true, generation: 1 }] });
  request = async url => ({ ok: true, json: async () => data(url.includes('root=') ? decodeURIComponent(url.split('root=')[1]) : 'alpha') });
  const ctx = vm.createContext({ console, AbortController, document: { body, createElement: t => new Element(t), getElementById: id => ({ 'stage-wrap': stage, 'chat-panel': comms, 'chat-log': log })[id] },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); }, fetch: (...args) => request(...args),
    Workstreams: { get: id => sessions.get(id), adopt: row => sessions.set(row.id, row), activeId: () => active }, App: { persist() {}, openWorkstream(id) { active = id; opens++; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/project-home.js'), 'utf8') + '\nthis.controller = ProjectHome;', ctx);
  comms.appendChild(log);
  await ctx.controller.open('alpha'); const panel = comms.children[0];
  assert.equal(stage.children.length, 0, 'project controls never enter the world view');
  assert.equal(comms.children[1], log, 'project controls sit before the unchanged transcript');
  assert.equal(panel.querySelector('.ph-drawer').open, false, 'project controls begin collapsed');
  assert.equal(active, 'alpha-home'); assert.equal(opens, 1);
  const card = panel.querySelector('.ph-card'); card.open = true;
  const draft = card.querySelector('textarea'); draft.value = 'My unsent direction';
  const checkbox = panel.querySelector('input'); checkbox.checked = true; checkbox.onchange();
  const poll = Array.from(timers.values()).find(t => t.ms === 2500); await poll.fn();
  assert.equal(card, panel.querySelector('.ph-card'), 'polling keeps the existing activity DOM');
  assert.equal(draft.value, 'My unsent direction'); assert.equal(card.open, true);
  assert.equal(panel.querySelector('input').checked, true, 'polling does not overwrite unsaved crew choice');
  assert.equal(opens, 1, 'polling never steals COMMS focus');
  request = async () => ({ ok: true, json: async () => ({ ...data('alpha'), activity: [{ ...data('alpha').activity[0], id: 'newer-work' }, ...data('alpha').activity] }) });
  await poll.fn();
  assert.notEqual(panel.querySelectorAll('.ph-card')[0], card, 'new activity appears first consistently with reload order');
  assert.equal(panel.querySelectorAll('.ph-card')[1], card, 'existing open activity keeps its DOM and draft');
  let resolveAlpha;
  request = (_url, opts) => JSON.parse(opts.body || '{}').root === 'alpha' ? new Promise(resolve => { resolveAlpha = resolve; }) : Promise.resolve({ ok: true, json: async () => data('beta') });
  const slow = ctx.controller.open('alpha'); await ctx.controller.open('beta');
  resolveAlpha({ ok: true, json: async () => data('alpha') }); await slow;
  assert.equal(active, 'beta-home', 'late project response cannot reopen the previous conversation');
  let resolveClosed; request = () => new Promise(resolve => { resolveClosed = resolve; });
  const pending = ctx.controller.open('alpha'); ctx.controller.close(); resolveClosed({ ok: true, json: async () => data('alpha') }); await pending; await settle();
  assert.equal(panel.hidden, true); assert.equal(active, 'beta-home', 'closing cancels pending focus changes');
  console.log('project home UI: draft preservation, unsaved crew, stable focus, rapid project switching and close races PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
