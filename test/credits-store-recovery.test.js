'use strict';
// Execute the production STORE handlers with controlled native/HTTP failures. No customer credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ArmConfirm = require('../frontend/app/armconfirm.js');
const source = fs.readFileSync(require.resolve('../frontend/app/stationui.js'), 'utf8');
const start = source.indexOf('  let _creditsLinkPoll =');
const end = source.indexOf('  // BUDGET panel', start);
assert.ok(start >= 0 && end > start);
// the STORE reads through the shared, repaint-proof credits read (live walk 10-14: one SETTINGS open = 12 x /api/credits)
const readStart = source.indexOf('  const CREDITS_FRESH_MS');
const readEnd = source.indexOf('  function refreshCreditsProvider()', readStart);
assert.ok(readStart >= 0 && readEnd > readStart);

class Host {
  constructor() { this.isConnected = true; this.buttons = new Map(); }
  set innerHTML(html) {
    this.html = html; this.buttons = new Map();
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const id = /\bid="([^"]+)"/.exec(match[1]); if (!id) continue;
      const listeners = [];
      this.buttons.set('#' + id[1], { textContent: match[2], dataset: {}, isConnected: true,
        classList: { add() {}, remove() {} }, addEventListener(_, fn) { listeners.push(fn); },
        removeEventListener() {}, click() { for (const fn of listeners) fn({ preventDefault() {} }); }
      });
    }
  }
  get innerHTML() { return this.html; }
  querySelector(selector) { return this.buttons.get(selector) || null; }
}
const linked = { configured: true, linkSaved: true, linked: true, accountId: 'old', balanceUsd: 0 };
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
function fixture({ native, get, post } = {}) {
  const host = new Host(); const calls = [];
  const body = { querySelector: selector => selector === '#credits-store' ? host : null };
  const context = vm.createContext({ console, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    ArmConfirm, esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'), fmtUsd: n => '$' + n,
    sfx() {}, openExternal() {}, scheduleSettingsRepaint() {},
    tauriInvoke: () => native || null,
    H: () => ({ refreshCreditsConfigured: async () => { calls.push('refresh'); } }),
    refreshCreditsProvider: async () => { calls.push('provider'); },
    Harness: { api: {
      get: async route => { calls.push(route); return get ? get(route) : linked; },
      post: async route => { calls.push(route); return post ? post(route) : { ok: true, j: { ok: true, unlinked: true } }; }
    } }, document: { body: { contains: () => true } }
  });
  vm.runInContext(source.slice(readStart, readEnd) + source.slice(start, end) + '\nthis.store = { wireCredits, forgetCreditsReads };', context);
  return { host, calls, read: async () => { await context.store.wireCredits(body); await flush(); },
    // a read after something changed (LINK / UNLINK / RETRY / REFRESH forget the shared answer first)
    fresh: async () => { context.store.forgetCreditsReads(); await context.store.wireCredits(body); await flush(); },
    async unlink() { const button = host.querySelector('#credits-unlink'); assert.ok(button); button.click(); button.click(); await flush(); }
  };
}

(async () => {
  const native = fixture({ native: async () => { throw new Error('sensitive native error'); } });
  await native.read(); await native.unlink();
  assert.match(native.host.innerHTML, /Could not clear the saved account credential/);
  assert.doesNotMatch(native.host.innerHTML, /sensitive native error/);
  assert.ok(!native.calls.includes('/api/credits/unlink'), 'failed native deletion must not claim sidecar unlink');
  await native.read();
  assert.match(native.host.innerHTML, /Unlink was not completed/, 'failure survives a Settings repaint');
  assert.ok(native.host.querySelector('#credits-unlink'), 'failed native deletion remains retryable');
  const thrown = fixture({ native: () => { throw new Error('bridge unavailable'); } });
  await thrown.read(); await thrown.unlink(); assert.match(thrown.host.innerHTML, /Could not clear/);

  for (const response of [{ ok: false, j: { ok: false } }, { ok: true, j: { ok: true, unlinked: false } }, { ok: true, j: {} }]) {
    const f = fixture({ post: async () => response }); await f.read(); await f.unlink();
    assert.match(f.host.innerHTML, /Could not confirm that unlink completed/);
    assert.ok(!f.calls.includes('refresh'), 'failed acknowledgement cannot enter the success path');
  }
  const dropped = fixture({ post: async () => { throw new Error('network'); } });
  await dropped.read(); await dropped.unlink(); assert.match(dropped.host.innerHTML, /Could not confirm/);

  for (const failureAt of ['status', 'linkable', 'malformed']) {
    let failed = true;
    const f = fixture({ get: async route => {
      if (route === '/api/credits') {
        if (failed && failureAt === 'status') throw new Error('http 503');
        if (failed && failureAt === 'malformed') return {};
        throw new Error('http 404');
      }
      if (failed && failureAt === 'linkable') throw new Error('network');
      return { available: true, cloud: true };
    } });
    await f.read(); assert.match(f.host.innerHTML, /Could not check your account connection/);
    assert.ok(f.host.querySelector('#credits-retry'));
    failed = false; f.host.querySelector('#credits-retry').click(); await flush();
    assert.ok(f.host.querySelector('#credits-link'), 'retry restores linking after ' + failureAt + ' failure');
  }

  // #182 ("now I can't sign off the station"): an account that cannot be read keeps its way out. A station with no link
  // answers the status read 404 at once, so a read that did not answer offers UNLINK beside RETRY; it works from there.
  {
    let gone = false;
    const stuck = fixture({
      get: async route => {
        if (route === '/api/credits') { if (gone) throw new Error('http 404'); throw new Error('timed out after 26000ms'); }
        return { available: true, cloud: true };
      },
      post: async () => { gone = true; return { ok: true, j: { ok: true, unlinked: true } }; }
    });
    await stuck.read();
    assert.match(stuck.host.innerHTML, /Could not check your account connection/);
    assert.ok(stuck.host.querySelector('#credits-retry') && stuck.host.querySelector('#credits-unlink'), 'a status read that never answered offers RETRY and UNLINK');
    assert.match(stuck.host.innerHTML, /your credits stay on your account/, 'and says the credits are not lost');
    await stuck.unlink();
    assert.ok(stuck.calls.includes('/api/credits/unlink') && stuck.calls.includes('refresh') && stuck.calls.includes('provider'), 'UNLINK from the unavailable card takes the whole unlink path');
    assert.ok(stuck.host.querySelector('#credits-link'), 'and the station can link again');
  }
  {
    const unlinkedStation = fixture({ get: async route => { if (route === '/api/credits') throw new Error('http 404'); throw new Error('network'); } });
    await unlinkedStation.read();
    assert.match(unlinkedStation.host.innerHTML, /Could not check your account connection/);
    assert.ok(!unlinkedStation.host.querySelector('#credits-unlink'), 'a station that answered "no link" (404) is offered no UNLINK');
  }

  let resolveOld; let statusReads = 0;
  const race = fixture({ get: route => route === '/api/credits'
    ? (++statusReads === 1 ? new Promise(r => { resolveOld = r; }) : { configured: false })
    : { available: true, cloud: true } });
  const old = race.read(); await flush(); await race.fresh(); resolveOld(linked); await old;
  assert.ok(race.host.querySelector('#credits-link'), 'late old-account read cannot hide new linking controls');

  let resolveNative; let unlinked = false;
  const success = fixture({ native: () => new Promise(r => { resolveNative = r; }),
    get: async route => route === '/api/credits' ? (unlinked ? { configured: false } : linked) : { available: true, cloud: true },
    post: async () => { unlinked = true; return { ok: true, j: { ok: true, unlinked: true } }; }
  });
  await success.read(); await success.unlink(); assert.match(success.host.innerHTML, /Unlinking this station/);
  await success.read(); assert.match(success.host.innerHTML, /Unlinking this station/, 'repaint preserves pending status');
  resolveNative(); await flush(); assert.ok(success.host.querySelector('#credits-link'));
  assert.ok(success.calls.includes('refresh') && success.calls.includes('provider'));

  const byok = fixture({ get: async route => route === '/api/credits' ? { configured: false } : { available: false, cloud: false } });
  await byok.read(); assert.equal(byok.host.innerHTML, '', 'an explicitly unavailable cloud stays hidden');

  // The first-run switch-account button must honor the same unlink acknowledgment as STORE.
  const app = fs.readFileSync(require.resolve('../frontend/app/app.js'), 'utf8');
  const switchStart = app.indexOf('  async function switchStarnetAccount()');
  const switchEnd = app.indexOf('  // Mint a pairing code', switchStart);
  assert.ok(switchStart >= 0 && switchEnd > switchStart);
  for (const nativeFailure of [false, true]) {
    for (const response of [{ ok: false, j: { ok: false } }, { ok: true, j: {} },
      { ok: true, j: { ok: true, unlinked: false } }, { ok: true, j: { ok: true, unlinked: true } }]) {
      let starts = 0;
      const status = { textContent: '' }; const button = { disabled: false, classList: { add() {} } };
      const context = vm.createContext({ SFX: { click() {} }, stopStarnetLinkPoll() {}, stopStarnetBalancePoll() {},
        _starnetStatusSeq: 0, el: id => id === 'starnet-status' ? status : button,
        window: { __TAURI__: { core: { invoke: async () => { if (nativeFailure) throw new Error('keychain'); } } } },
        Harness: { api: { post: async () => response }, refreshCreditsConfigured: async () => {} },
        startStarnetLink: () => { starts++; } });
      vm.runInContext(app.slice(switchStart, switchEnd) + '\nthis.switchAccount = switchStarnetAccount;', context);
      await context.switchAccount();
      const success = !nativeFailure && response.ok && response.j.ok === true && response.j.unlinked === true;
      assert.equal(starts, success ? 1 : 0, 'pairing starts only after proven unlink');
      if (!success) { assert.match(status.textContent, /could not disconnect/); assert.equal(button.disabled, false); }
    }
  }
  console.log('credits STORE recovery: native/HTTP/network failures, retry, stale reads, pending and successful unlink PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
