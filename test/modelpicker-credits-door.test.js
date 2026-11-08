/* node test/modelpicker-credits-door.test.js — the per-agent model picker says where StarNet Credits are when the
   station is not linked yet.

   Customer report (email, 11-06 and 11-07, desktop 0.14.2 on macOS): bought $25 of Credits, and "StarNet does not appear
   as a model or provider option when configuring an agent". True: the catalog has a STARNET group only once the station
   is linked to the StarNet account (ModelDock.computeCatalog drops a provider that is not configured; managed-model-93
   locks that), and buying credits on the website links nothing. The link is a one-time step on the StarNet card in
   Settings › AI & MODELS, and nothing in the agent's model list pointed there. Now, while the station could link
   (/api/credits/linkable) and has not, the list leads with a disabled STARNET CREDITS row and a LINK STARNET CREDITS
   button beside it lands on the StarNet card. Linked, not linkable, or a failed check: nothing new is drawn.
   Runs the real frontend/app/modelpicker.js against a small fake DOM. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const MP_PATH = process.env.MODELPICKER_PATH || path.join(root, 'frontend', 'app', 'modelpicker.js');

/* ---- a fake DOM just big enough for the picker: tag/.class/[value=""] selectors, children, listeners ---- */
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.hidden = false; this.className = ''; this.textContent = ''; this.value = ''; this.disabled = false; this.label = ''; this.type = ''; this.title = ''; this._l = {}; }
  appendChild(c) { if (c.parent) c.parent.removeChild(c); c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) { if (c.parent) c.parent.removeChild(c); c.parent = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; return c; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { if (!this.parent) return null; const s = this.parent.children; return s[s.indexOf(this) + 1] || null; }
  set innerHTML(v) { this.children.forEach(c => { c.parent = null; }); this.children = []; }
  get innerHTML() { return ''; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  click() { (this._l.click || []).forEach(fn => fn({ preventDefault() {}, stopPropagation() {} })); }
  matches(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[value="([^"]*)"\])?$/i.exec(sel);
    if (!m) throw new Error('fake DOM: unsupported selector ' + sel);
    if (m[1] && m[1].toUpperCase() !== this.tagName) return false;
    const cls = String(this.className).split(/\s+/);
    if (m[2] && !m[2].split('.').filter(Boolean).every(c => cls.indexOf(c) >= 0)) return false;
    if (m[3] != null && this.value !== m[3]) return false;
    return true;
  }
  querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
  all(sel) { const out = []; const walk = e => e.children.forEach(c => { if (c.matches(sel)) out.push(c); walk(c); }); walk(this); return out; }
}
global.document = { createElement: t => new El(t) };
global.Option = function (text, value) { const o = new El('option'); o.textContent = text; o.value = value; return o; };

function mount() {
  const cell = new El('div'); cell.className = 'mc-pick';
  const wrap = cell.appendChild(new El('span')); wrap.className = 'mp-wrap';
  const sel = wrap.appendChild(new El('select')); sel.className = 'mp-model';
  return { cell, wrap, sel };
}
const item = (provider, id) => ({ provider, id, name: id });
const OPENAI = [item('openai', 'gpt-5.5'), item('openai', 'gpt-5.5-mini')];
const STARNET = [item('starnet', 'openai/gpt-5.5')];

// the world the picker reads: ModelDock's catalog, Harness's configured map + api, StationUI's doors
function world(o) {
  const calls = { linkable: 0, focus: [], openTerm: [] };
  global.ModelDock = {
    catalog: async () => (o.catalog || []).slice(),
    starnetDry: () => false,
    labels: { model: m => m.name || m.id, provider: p => String(p).toUpperCase(), orGroup: () => 'X', normProvider: p => String(p || '').trim().toLowerCase() },
    efforts: { optionsFor: () => [], label: e => e },
    normalizeEffort: e => e
  };
  global.Harness = {
    configured: p => p === 'starnet' && !!o.linked,
    api: { get: url => {
      if (url !== '/api/credits/linkable') throw new Error('unexpected read ' + url);
      calls.linkable++;
      return typeof o.linkable === 'function' ? o.linkable() : (o.linkable instanceof Error ? Promise.reject(o.linkable) : Promise.resolve(o.linkable));
    } }
  };
  global.StationUI = o.noFocus ? { openTerm: (k, s) => calls.openTerm.push([k, s]) }
    : { focusProvider: pid => calls.focus.push(pid), openTerm: (k, s) => calls.openTerm.push([k, s]) };
  return calls;
}
const optionTexts = sel => sel.children.map(c => c.tagName === 'OPTGROUP' ? '[' + c.label + '] ' + c.children.map(x => x.value).join(',') : c.value);

(async () => {
  delete require.cache[require.resolve(MP_PATH)];
  const MP = require(MP_PATH);

  /* ---- 1. the customer's station: credits bought, station not linked, another provider connected ---- */
  {
    const calls = world({ catalog: OPENAI, linked: false, linkable: { available: true, cloud: true } });
    const m = mount();
    const list = await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    A.eq(list.length, 2, 'the catalog itself is unchanged (no StarNet models are invented)');
    A.eq(calls.linkable, 1, 'the picker asks the station whether it can link');
    const og = m.sel.children[1];
    A.ok(og && og.tagName === 'OPTGROUP' && og.label === 'STARNET CREDITS', 'the list leads (after the inherit row) with a STARNET CREDITS group: ' + JSON.stringify(optionTexts(m.sel)));
    A.ok(og && og.children.length === 1 && og.children[0].disabled === true && og.children[0].value === '__link', 'its one row is disabled: it says, it cannot be picked');
    A.ok(og && /not linked/.test(og.children[0].textContent) && /LINK STARNET CREDITS/.test(og.children[0].textContent), 'it says the station is not linked and names the button');
    A.eq(m.sel.children[0].value, '', 'the inherit row stays first');
    A.eq(m.sel.all('option').filter(o => /\|/.test(o.value)).map(o => o.value), ['openai|gpt-5.5', 'openai|gpt-5.5-mini'], 'every real model is still listed');
    const door = m.wrap.querySelector('.mp-credits');
    A.ok(door && !door.hidden && /LINK STARNET CREDITS/.test(door.textContent), 'a LINK STARNET CREDITS button sits beside the list');
    A.ok(door && /Buying credits does not link it/.test(door.title) && /AI & MODELS/.test(door.title), 'its tip says buying does not link, and where linking is');
    door.click();
    A.eq(calls.focus, ['starnet'], 'pressing it lands on the StarNet card in Settings');
    A.eq(m.wrap.querySelector('.mp-none'), null, 'the no-models door stays away while there are models');
    m.sel.value = '__link';
    A.eq(MP.read(m.cell).model, '', 'the hint row never reads as a model');
    A.eq(MP.read(m.cell).provider, '', '…nor as a provider');
  }

  /* ---- 2. a linked station: StarNet models are in the list, nothing new is drawn and nothing extra is asked ---- */
  {
    const calls = world({ catalog: STARNET.concat(OPENAI), linked: true, linkable: { available: false } });
    const m = mount();
    await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    A.eq(calls.linkable, 0, 'a linked station is not asked again');
    A.eq(m.sel.querySelector('.mp-credits-hint'), null, 'no hint row');
    A.eq(m.wrap.querySelector('.mp-credits'), null, 'no link button');
    A.eq(m.sel.children[1] && m.sel.children[1].label, 'STARNET', 'the StarNet group leads as before');
  }

  /* ---- 3. a station that cannot link (no StarNet cloud in this build) or a failed check: nothing new ---- */
  for (const [name, linkable] of [['not linkable', { available: false, cloud: false }], ['check failed', new Error('http 500')], ['odd answer', { available: 'yes' }]]) {
    world({ catalog: OPENAI, linked: false, linkable });
    const m = mount();
    await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    A.eq([m.sel.querySelector('.mp-credits-hint'), m.wrap.querySelector('.mp-credits')], [null, null], name + ': no hint row and no button (never a door to a card Settings does not draw)');
  }

  /* ---- 4. an empty catalog on an unlinked station: both doors, keys and credits ---- */
  {
    world({ catalog: [], linked: false, linkable: { available: true } });
    const m = mount();
    await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    const none = m.wrap.querySelector('.mp-none'), door = m.wrap.querySelector('.mp-credits');
    A.ok(none && !none.hidden && door && !door.hidden, 'a station with no models shows the key door and the credits door');
    A.ok(m.sel.querySelector('.mp-credits-hint') && m.sel.all('option').some(o => o.value === '__none'), 'and the list says both');
  }

  /* ---- 5. after linking, the next fill drops the hint and hides the button ---- */
  {
    const o = { catalog: OPENAI, linked: false, linkable: { available: true } };
    world(o);
    const m = mount();
    await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    A.ok(m.wrap.querySelector('.mp-credits') && !m.wrap.querySelector('.mp-credits').hidden, 'before: the button shows');
    world(Object.assign(o, { linked: true, catalog: STARNET.concat(OPENAI) }));
    await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    A.eq(m.sel.querySelector('.mp-credits-hint'), null, 'after linking: the hint row is gone');
    A.eq(m.wrap.querySelector('.mp-credits').hidden, true, 'and the button is hidden');
    A.eq(m.wrap.all('.mp-credits').length, 1, 'one button, reused');
  }

  /* ---- 6. a slow check never paints over a newer fill ---- */
  {
    let release = null;
    const o = { catalog: OPENAI, linked: false, linkable: () => new Promise(r => { release = r; }) };
    world(o);
    const m = mount();
    const first = MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    await new Promise(r => setImmediate(r));
    world(Object.assign(o, { linked: true, catalog: STARNET.concat(OPENAI) }));
    await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    release({ available: true });
    await first;
    A.eq([m.sel.querySelector('.mp-credits-hint'), m.wrap.querySelector('.mp-credits')], [null, null], 'the older unlinked answer, arriving after the linked fill, draws nothing');

    let r1 = null, r2 = null;
    const o2 = { catalog: OPENAI, linked: false };
    world(Object.assign(o2, { linkable: () => new Promise(r => { r1 = r; }) }));
    const m2 = mount();
    const a = MP.populate(m2.cell, { inheritLabel: 'Follow station default' });
    await new Promise(r => setImmediate(r));
    world(Object.assign(o2, { linkable: () => new Promise(r => { r2 = r; }) }));
    const b = MP.populate(m2.cell, { inheritLabel: 'Follow station default' });
    await new Promise(r => setImmediate(r));
    r2({ available: true }); await b;
    r1({ available: true }); await a;
    A.eq(m2.sel.all('optgroup').filter(g => g.label === 'STARNET CREDITS').length, 1, 'two fills in flight leave one hint row');
  }

  /* ---- 7. without focusProvider the button still opens Settings › AI & MODELS ---- */
  {
    const calls = world({ catalog: OPENAI, linked: false, linkable: { available: true }, noFocus: true });
    const m = mount();
    await MP.populate(m.cell, { inheritLabel: 'Follow station default' });
    m.wrap.querySelector('.mp-credits').click();
    A.eq(calls.openTerm, [['settings', 'providers']], 'it falls back to the providers section');
  }

  /* ---- the door lands on something real, and the website ships the same picker ---- */
  {
    const ui = read('frontend/app/stationui.js');
    A.ok(/\bfocusProvider\b[^;]*\};\s*$/m.test(ui.slice(ui.lastIndexOf('return { init,'))) || /return \{ init,[^\n]*\bfocusProvider\b/.test(ui), 'StationUI exports focusProvider');
    A.ok(/\(\(linked \|\| saved\) \? '◆ STORE' : '↗ LINK STATION'\)/.test(ui), 'an unlinked StarNet card carries ↗ LINK STATION');
    A.ok(/PROVIDERS\.filter\(p => !p\.credits \|\| creditsProv\.state !== 'absent'\)/.test(ui) && /creditsRead\('\/api\/credits\/linkable'\)/.test(ui), 'Settings draws that card on the same /api/credits/linkable answer the picker reads');
    if (!process.env.MODELPICKER_PATH) A.eq(read('website/app/app/modelpicker.js') === read('frontend/app/modelpicker.js'), true, 'the website copy is the same picker');
  }

  A.report('modelpicker-credits-door.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
