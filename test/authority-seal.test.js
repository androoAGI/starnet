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
    A.ok(seal.open('permissions.bypass.json', d.files['permissions.bypass.json']).value.on === true, 'a migrated bypass keeps its value');
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
    A.eq(unreadable.seal.boot(d.list).mode, 'enforce', 'an unreadable marker is not an upgrade either');
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
    for (const cmd of ['type permissions.bypass.json', 'echo {} > agent.roster.json', 'cat hooks.json', 'copy x hooks-allowed.json', 'Set-Content plugins-allowed.json {}', 'del authority-seal.json', 'cat PERMISSIONS.BYPASS.JSON'])
      A.eq(Shell.escapesWorkspace(cmd), why, 'the floor refuses: ' + cmd);
    for (const cmd of ['ls -la', 'cat README.md', 'node build.js', 'git log'])
      A.eq(Shell.escapesWorkspace(cmd), null, 'the floor still lets through: ' + cmd);
  }

  A.report('authority-seal.test');
})().catch(e => { console.error(e); process.exit(1); });
