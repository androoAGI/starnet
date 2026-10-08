/* node test/future-gate-update-door.test.js — the forward-version gate names a paused install and offers the full installer (#91).

   The gate (app.js showFutureSaveGate) is a HARD STOP for a save written by a newer StarNet, and the Update Center is not
   reachable from it. Updates.install() pauses by RETURNING its snapshot (a failed pre-update recovery point, an unverified
   save, an agent still working) rather than throwing, so the gate kept reading "checking for an update…" forever while
   the only signal was a toast. The function is LIFTED out of app.js and run against fakes. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const gateSrc = A.fnBody(appSrc, 'function showFutureSaveGate(');
A.ok(gateSrc.length > 500 && gateSrc.length < 9000, 'showFutureSaveGate located (length guard)');

function makeGate(updates) {
  const nodes = {};
  const node = (id) => ({ id, textContent: '', onclick: null, className: '', children: [], appendChild(c) { this.children.push(c); nodes[c.id] = c; c.parentNode = this; } });
  const actions = node('actions');
  for (const id of ['future-sub', 'future-msg']) nodes[id] = node(id);
  nodes['btn-future-update'] = node('btn-future-update');
  actions.appendChild(nodes['btn-future-update']);
  const document = { createElement: () => node('') };
  const shown = [];
  const run = new Function('el', 'document', 'window', 'Updates', 'SFX', 'Chat', 'World', 'Save', 'show',
    'let gateActive = false;\n' + gateSrc + '\nreturn showFutureSaveGate;');
  const gate = run(id => nodes[id] || null, document, { __TAURI__: { core: {} } }, updates, { click() {} }, { abort() {} }, { stop() {} }, { CURRENT: 5 }, id => shown.push(id));
  gate(6);
  return { nodes, actions, shown };
}

(async () => {
  {
    // #91: the in-app path failed at the recovery point -> say so, and offer the full installer (it keeps the station)
    let opened = 0;
    const g = makeGate({
      check: async () => ({ phase: 'available' }),
      install: async () => ({ phase: 'available', error: "Pre-update recovery point failed - ENOENT: no such file or directory, lstat 'C:\\W\\.checkpoints\\a\\git\\tw40mZg'" }),
      openReleasesPage: () => { opened++; }
    });
    A.eq(g.shown, ['screen-future'], 'the gate screen is shown');
    await g.nodes['btn-future-update'].onclick();
    const msg = g.nodes['future-msg'].textContent;
    A.ok(!/checking for an update/.test(msg), 'the gate no longer claims it is still checking');
    A.ok(/Pre-update recovery point failed - ENOENT/.test(msg), 'it names why the install paused');
    A.ok(/keeps your station/.test(msg), 'and says the full installer keeps the station');
    const dl = g.nodes['btn-future-download'];
    A.ok(!!dl && g.actions.children.indexOf(dl) >= 0, 'a DOWNLOAD LATEST door appears beside UPDATE STARNET');
    A.eq(dl && dl.className, 'btn-xl', 'in the gate\'s own button skin (no OS paint)');
    if (dl) await dl.onclick();
    A.eq(opened, 1, 'the door opens the public releases page through Updates.openReleasesPage');
    await g.nodes['btn-future-update'].onclick();
    A.eq(g.actions.children.filter(c => c.id === 'btn-future-download').length, 1, 'a retry never stacks a second door');
  }
  {
    // an install() that THROWS is a failed install too: same door, no dead-end "open the Update Center" (unreachable here)
    const g = makeGate({ check: async () => ({ phase: 'available' }), install: async () => { throw new Error('native failed'); }, openReleasesPage() {} });
    await g.nodes['btn-future-update'].onclick();
    A.ok(!/Update Center/.test(g.nodes['future-msg'].textContent), 'the gate never points at the Update Center it cannot open');
    A.ok(!!g.nodes['btn-future-download'], 'a thrown install offers the installer door too');
  }
  {
    // an agent still working pauses the install (GB-4): name it, never "checking…"
    const g = makeGate({ check: async () => ({ phase: 'available' }), install: async () => ({ phase: 'available', error: '', confirmRuns: 2 }), openReleasesPage() {} });
    await g.nodes['btn-future-update'].onclick();
    A.ok(/2 agents are still working/.test(g.nodes['future-msg'].textContent), 'the paused-for-agents state is named with its count');
  }
  {
    // a committed install says what is happening, and offers no failure door
    const g = makeGate({ check: async () => ({ phase: 'available' }), install: async () => ({ phase: 'restarting', error: '' }), openReleasesPage() {} });
    await g.nodes['btn-future-update'].onclick();
    A.ok(/installing the update/.test(g.nodes['future-msg'].textContent), 'a committed install reads as installing');
    A.eq(!!g.nodes['btn-future-download'], false, 'no installer door when nothing failed');
  }
  A.report('future-gate-update-door.test');
})().catch(e => { console.error(e); process.exit(1); });
