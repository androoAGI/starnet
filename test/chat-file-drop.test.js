'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Node {
  constructor(parent) { this.parent = parent; this.events = {}; this.classes = new Set(); this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x) }; }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  contains(node) { return node === this || !!(node && this.contains(node.parent)); }
  appendChild(node) { node.parent = this; this.child = node; }
  setAttribute() {}
  fire(type, event = {}) { event.target ||= this; event.preventDefault = () => { event.prevented = true; }; for (const fn of this.events[type] || []) fn(event); return event; }
}
for (const root of ['frontend', 'website/app']) {
  const source = fs.readFileSync(path.join(__dirname, '..', root, 'app/chat.js'), 'utf8');
  const fn = source.match(/  function wireChatDropTarget\([^]*?\n  \}/)?.[0];
  assert.ok(fn, root + ': whole-chat drop binding exists');
  const document = new Node(), window = new Node(), panel = new Node(document), child = new Node(panel), sibling = new Node(panel), outside = new Node(document);
  document.createElement = () => new Node(); document.documentElement = new Node(document);
  const uploads = [], notices = [], input = { value: 'keep draft', focus() { this.focused = true; } };
  const ctx = { document, window, input, activeWs: { id: 'direct' }, el: () => panel, handleFiles: files => uploads.push(files), StationUI: { notify: text => notices.push(text) } };
  vm.runInNewContext(fn + ';this.wire = wireChatDropTarget;', ctx);
  ctx.wire(); const hint = panel.child;
  const drag = () => ({ dataTransfer: { types: ['Files'], files: [] } });
  assert.equal(panel.fire('dragover', drag()).prevented, true, 'protected file drag is accepted before bytes are exposed');
  assert.equal(hint.hidden, false);
  panel.fire('dragenter', { ...drag(), target: child });
  panel.fire('dragenter', { ...drag(), target: sibling });
  panel.fire('dragleave', { target: child, relatedTarget: sibling });
  assert.equal(hint.hidden, false, 'nested transitions do not flicker');
  panel.fire('dragleave', { target: sibling, relatedTarget: outside });
  assert.equal(hint.hidden, true, 'leaving chat clears target');
  const files = [{ name: 'photo.png' }, { name: 'notes.txt' }];
  const event = { dataTransfer: { types: ['Files'], files }, target: child };
  document.fire('drop', event); panel.fire('drop', event);
  assert.equal(uploads.length, 1); assert.deepEqual(Array.from(uploads[0]), files);
  assert.equal(input.value, 'keep draft'); assert.equal(input.focused, true);
  assert.equal(hint.hidden, true);
  ctx.wire(); ctx.wire();
  assert.equal(panel.events.drop.length, 1, 'session re-entry never duplicates upload handlers');
  assert.equal(document.events.drop.length, 1);
  for (const type of ['dragover', 'drop']) {
    const text = { dataTransfer: { types: ['text/plain'], files: [] } };
    assert.equal(panel.fire(type, text).prevented, undefined, 'text dragging retains native editing');
    assert.equal(document.fire(type, text).prevented, undefined);
  }
  const mixed = { dataTransfer: { types: ['Files'], items: [
    { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => ({ name: 'folder' }) },
    { kind: 'file', getAsFile: () => files[0] }
  ] } };
  panel.fire('drop', mixed); assert.equal(uploads[1].length, 1); assert.equal(notices.length, 1);
  assert.equal(document.fire('drop', { ...drag(), target: outside }).prevented, true, 'missed file drops cannot navigate away');
  for (const cancel of ['dragend', 'blur', 'outside', 'reinit']) {
    panel.fire('dragover', drag());
    if (cancel === 'dragend') document.fire('dragend');
    if (cancel === 'blur') window.fire('blur');
    if (cancel === 'outside') document.fire('dragover', { ...drag(), target: outside });
    if (cancel === 'reinit') ctx.wire();
    assert.equal(hint.hidden, true, cancel + ' clears overlay');
  }
  ctx.activeWs = null; panel.fire('drop', { dataTransfer: { types: ['Files'], files } });
  assert.equal(uploads.length, 2, 'inactive chat cannot stage files');
  ctx.activeWs = { conversationMode: 'group' }; panel.fire('drop', { dataTransfer: { types: ['Files'], files } });
  assert.equal(uploads.length, 3, 'group uses the same attachment path');
}
const rust = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
assert.match(rust, /WebviewWindowBuilder::new\(app, "main"[^]*?\.disable_drag_drop_handler\(\)[^]*?\.build\(\)/, 'desktop shell must pass OS drops through to HTML5');
console.log('chat-file-drop: PASS (desktop + website, panel/children, mixed files, directories, text, cancellation, session re-entry, groups, native bridge)');
