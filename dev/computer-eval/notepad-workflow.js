'use strict';
// Bounded Windows integration probe: owns only its new file and tab, never the
// Notepad process (modern Notepad may restore the user's other tabs on launch).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connect, makeDriver } = require('./cua-driver.js');
const { makeComputerTools } = require('../../sidecar/tools/builtin/computer.js');
const { makeWin32DesktopDriver } = require('../../sidecar/tools/builtin/win32desktop.js');

async function run(binary, directory) {
  const root = path.resolve(directory); fs.mkdirSync(root, { recursive: true });
  const name = 'starnet-cua-' + randomUUID().slice(0, 8) + '.txt';
  const file = path.join(root, name);
  const initial = 'StarNet evaluation fixture.\r\n';
  const added = 'Background editing verified.';
  fs.writeFileSync(file, initial, { flag: 'wx' });
  const measurements = [];
  const timed = async (label, fn) => {
    const t = performance.now();
    try { const result = await fn(); measurements.push({ label, ms: Math.round(performance.now() - t), result }); return result; }
    catch (e) { measurements.push({ label, ms: Math.round(performance.now() - t), error: e.message }); throw e; }
  };
  const conn = await connect({ binary, fullPower: true });
  try {
    const launched = await conn.data('launch_app', { path: path.join(process.env.SystemRoot, 'System32', 'notepad.exe'), additional_arguments: [file] });
    const candidates = (launched.windows || []).filter(w => w.title.includes(name));
    assert.equal(candidates.length, 1, 'exactly one fixture window required');
    const target = { pid: launched.pid, window_id: candidates[0].window_id };
    const driver = makeDriver(conn, target);
    const tool = makeComputerTools({ driver, allowPhysicalInput: true }).useTool;
    const ctx = { unrestrictedHost: true, inputMode: 'full-power' };
    let state;
    async function observe() {
      state = await driver.observe();
      assert.ok(state.window_title.includes(name), 'stop if the selected tab changes');
      return state;
    }
    const pick = (label, role) => {
      const matches = state.elements.filter(e => e.label === label && (!role || e.role === role));
      assert.equal(matches.length, 1, 'unique observed element: ' + label);
      driver.selectElement(matches[0].element_index);
      return matches[0];
    };
    await observe();
    const oldToken = pick('Text editor', 'Document').element_token;
    const native = makeWin32DesktopDriver();
    const before = { cursor: await conn.data('get_cursor_position'), fg: await native.foreground() };
    await timed('background-edit', () => tool.run({ action: 'type', text: added }, ctx));
    const after = { cursor: await conn.data('get_cursor_position'), fg: await native.foreground() };
    await observe();
    assert.equal(state.elements.find(e => e.role === 'Document').value.replace(/\r\n?/g, '\n'), (initial + added).replace(/\r\n?/g, '\n'));
    const stale = await conn.call('click', { ...target, element_token: oldToken });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent?.refusal?.code, 'stale_element_token');
    // An accelerator may be hidden by a closed menu. Start with semantic File → Save.
    pick('File', 'MenuItem'); await timed('open-file-menu', () => tool.run({ action: 'click' }, ctx));
    await observe(); pick('Save', 'MenuItem'); await timed('save', () => tool.run({ action: 'click' }, ctx));
    await observe();
    assert.equal(fs.readFileSync(file, 'utf8'), initial + added);
    const tab = state.elements.find(e => e.role === 'TabItem' && e.label.startsWith(name + '.'));
    const close = state.elements.find(e => e.label === 'Close Tab' && e.parent_index === tab?.element_index);
    assert.ok(close, 'close only the fixture tab');
    driver.selectElement(close.element_index); await tool.run({ action: 'click' }, ctx);
    const closeDeadline = Date.now() + 2000;
    let closed = false;
    while (!closed && Date.now() < closeDeadline) {
      const afterClose = await conn.data('get_window_state', { ...target, include_screenshot: false, query: name });
      closed = !(afterClose.elements || []).some(e => e.role === 'TabItem' && e.label.startsWith(name + '.'));
      if (!closed) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(closed, true, 'fixture tab closure must be observed, not inferred from click dispatch');
    const receipt = {
      scenario: 'notepad-background-edit-save', passed: true, file: name, bytes: fs.statSync(file).size,
      cursorUnchangedDuringEdit: JSON.stringify(before.cursor) === JSON.stringify(after.cursor),
      foregroundUnchangedDuringEdit: JSON.stringify(before.fg) === JSON.stringify(after.fg),
      staleTargetRejected: true, ownedTabClosureVerified: true, measurements
    };
    fs.writeFileSync(path.join(root, name + '.receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally { await conn.close(); }
}
if (require.main === module) run(process.argv[2], process.argv[3] || '.qa_tmp/cua-evaluation').then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { run };
