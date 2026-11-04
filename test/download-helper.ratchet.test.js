'use strict';
/* Actual U + production export handlers, allocated real writer, browser boundary only stubbed.
   ACK_DOWNLOAD_CONTROL_DIR swaps exact saved caller source, not the new helper, so the
   control proves existing false/absent receipts rather than a missing helper exception. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const A = require('./_assert.js');
const writer = require('../sidecar/backupfile.js');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-download-proof-'));
const source = rel => fs.readFileSync(process.env.ACK_DOWNLOAD_CONTROL_DIR
  ? path.join(process.env.ACK_DOWNLOAD_CONTROL_DIR, 'truthful-ack-download-original-' + rel.replaceAll('/', '-') + '.txt')
  : path.join(root, rel), 'utf8');
const util = fs.readFileSync(path.join(root, 'frontend/js/util.js'), 'utf8');
function rig(desktop, response) {
  const posts = [], clicks = [], revokes = [], timers = [], notices = [], nodes = [];
  const context = { console, Blob, Promise, Map, Set, localStorage: { getItem: () => null },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    URL: { createObjectURL(blob) { const url = 'blob:fixture/' + nodes.length; nodes.push({ url, blob }); return url; }, revokeObjectURL(url) { revokes.push(url); } },
    document: { body: { appendChild() {}, removeChild(node) { node.remove(); } }, createElement() { return { style: {}, click() { clicks.push(this.download); }, remove() { this.removed = true; } }; } },
    Harness: { isDesktop: () => desktop, api: { post: async (route, body) => {
      posts.push({ route, body });
      return response ? response(route, body) : { ok: true, status: 200, j: writer.saveExportFile(body.text, { dir: tmp, base: body.name, ext: body.ext }) };
    }, why: r => r.j && r.j.error || 'HTTP ' + r.status } },
    StationUI: { notify: line => notices.push(line) }, SFX: { click() {}, bad() {} }
  };
  vm.createContext(context); vm.runInContext(util + '\nthis.U=U;', context);
  return { context, U: context.U, posts, clicks, revokes, timers, notices, nodes };
}
function named(src, name) {
  const match = src.match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\('));
  if (!match) throw Error('missing actual caller ' + name);
  const body = A.fnBody(src, match[0]);
  if (!body || body.length > 15000) throw Error('unbounded caller extraction ' + name);
  return body;
}
function callback(src, marker) {
  const body = A.fnBody(src, marker);
  if (!body || body.length > 5000) throw Error('unbounded actual callback ' + marker);
  return body;
}
(async () => {
  try {
    const desktop = rig(true);
    const saved = await desktop.U.saveFile({ name: 'truth.txt', ext: 'txt', text: 'actual bytes' });
    A.eq([saved.ok, saved.where, saved.path], [true, 'disk', path.join(tmp, 'truth.txt')], 'desktop receipt names the real allocated output');
    A.eq(fs.readFileSync(saved.path, 'utf8'), 'actual bytes', 'named output holds the exact text');
    A.ok(saved.line.includes(saved.path), 'success line names the host-proved path');
    A.eq([desktop.posts.length, desktop.clicks.length], [1, 0], 'proven desktop save never starts a duplicate browser handoff');

    const browser = rig(false, () => { throw Error('browser must not ask host to write'); });
    let custom = 0, supplied = 0;
    const handed = await browser.U.saveFile({ name: 'remote.txt', text: async () => { supplied++; return 'browser bytes'; }, save: async () => { custom++; throw Error('host callback forbidden'); } });
    A.eq([handed.ok, handed.where, handed.path, browser.posts.length, custom, supplied], [true, 'browser', undefined, 0, 0, 1], 'browser only reads its lazy text and never invokes either host-write path');
    A.eq(browser.clicks, ['remote.txt'], 'browser requests the named download');
    A.ok(/requested/.test(handed.line) && /browser's downloads/.test(handed.line) && !/saved to/.test(handed.line), 'handoff line claims a request, not completed local save');
    browser.timers.forEach(fn => fn());
    A.eq(browser.revokes, browser.nodes.map(n => n.url), 'the shared helper releases its own browser URL');

    for (const r of [{ ok: false, status: 404, j: { error: 'route absent' } }, { ok: false, status: 500, j: { error: 'disk full' } },
      { ok: false, status: 413, j: { error: 'too large' } }, { ok: true, status: 200, j: { ok: true, path: 'relative.txt', file: 'relative.txt', dir: '.', bytes: 1 } },
      { ok: true, status: 200, j: { ok: true, path: path.join(tmp, 'x.txt'), file: 'different.txt', dir: tmp, bytes: 1 } },
      { ok: true, status: 200, j: { ok: true, path: path.join(tmp, 'x.txt'), file: 'x.txt', dir: tmp } }]) {
      const app = rig(true, () => r), fallback = await app.U.saveFile({ name: 'fallback.txt', text: 'the file' });
      A.eq([fallback.ok, fallback.where, fallback.path, app.clicks], [true, 'browser', undefined, ['fallback.txt']], 'refused or unproven save falls back without a fabricated local path');
      A.ok(fallback.line.includes('could not save it') && (!r.j.error || fallback.line.includes(r.j.error)), 'fallback keeps the actual refusal reason');
      A.ok(/download requested as fallback\.txt/.test(fallback.line) && /check the app's downloads/.test(fallback.line) && !/saved to|handed to|usually|landed/.test(fallback.line), 'desktop fallback claims only the attempted download request');
    }
    const lazy = rig(true);
    let reads = 0, writes = 0;
    const backed = await lazy.U.saveFile({ name: 'station.json', ext: 'json', text: () => { reads++; throw Error('unused browser envelope'); },
      save: async () => { writes++; return { ok: true, status: 200, j: writer.saveExportFile('{}', { dir: tmp, base: 'station' }) }; } });
    A.eq([backed.where, writes, reads, lazy.posts.length, lazy.clicks.length], ['disk', 1, 0, 0, 0], 'station envelope fast path stays host-built and never fetches fallback text');
    const refusedText = await lazy.U.saveFile({ name: 'failed.txt', save: async () => ({ ok: false, status: 500, j: { error: 'disk full' } }), text: () => { throw Error('export unavailable'); } });
    A.ok(!refusedText.ok && refusedText.line.includes('disk full') && refusedText.line.includes('export unavailable'), 'failed text after host refusal keeps both actual causes');
    const clickFailure = rig(false); clickFailure.context.document.createElement = () => ({ remove() {}, click() { throw Error('refused gesture'); } });
    const unhanded = await clickFailure.U.saveFile({ name: 'blocked.txt', text: 'bytes' });
    clickFailure.timers.forEach(fn => fn());
    A.eq([unhanded.ok, unhanded.where, clickFailure.revokes.length], [false, 'none', 1], 'a refused browser click is not a successful export and releases its URL');

    // Source census is paired with real production handler execution below.
    for (const rel of ['frontend/app/backup.js', 'frontend/app/app.js', 'frontend/app/build.js', 'frontend/app/marketplace.js', 'frontend/app/stationui.js']) {
      A.ok(!/createObjectURL|\.download\s*=/.test(source(rel)), rel + ': scoped text exports have no independent browser writer');
    }
    const appSource = source('frontend/app/app.js');
    const session = rig(true);
    session.context.Workstreams = { get: id => ({ id }), needsHydration: () => false, exportConversation: () => ({ text: 'conversation', filename: 'conversation.md' }), titleOf: () => 'fixture session' };
    vm.runInContext(named(appSource, 'sessionDownload') + '\n' + named(appSource, 'exportSession') + '\nthis.run=exportSession;', session.context);
    await session.context.run('session-exact', 'markdown');
    A.eq([session.posts.length, session.clicks.length], [1, 0], 'actual session handler requests a desktop save instead of assuming a browser export');
    A.ok(session.notices.length === 1 && session.notices[0].includes(path.join(tmp, 'conversation.md')), 'actual session notification shows the exact shared receipt');

    const recipe = rig(true);
    recipe.context.note = line => recipe.notices.push(line); recipe.context.sfx = () => {};
    const market = source('frontend/app/marketplace.js');
    vm.runInContext(named(market, 'safeFilename') + '\n' + named(market, 'downloadRecipeFile') + '\nthis.run=downloadRecipeFile;', recipe.context);
    await recipe.context.run({ name: 'Honest recipe', steps: [] });
    A.eq([recipe.posts.length, recipe.clicks.length], [1, 0], 'actual recipe export uses the desktop owner');
    A.ok(recipe.notices[0] && recipe.notices[0].includes(path.join(tmp, 'honest-recipe.starnet-recipe.json')), 'recipe no longer calls an unobserved handoff saved');

    const build = rig(true), status = { innerHTML: '', textContent: '' };
    Object.assign(build.context, { exp: {}, station: { serialize: () => ({}), doc: () => ({ meta: { name: 'fixture' } }) }, WorldModel: {},
      BuildShare: { exportBuild: () => ({ text: '{"build":1}', filename: 'build.json', stats: {}, dropped: [] }) }, status,
      esc: build.U.esc, sharedBuildCopy: () => '<span>real build metadata</span>', sfx() {} });
    vm.runInContext(callback(source('frontend/app/build.js'), 'exp.onclick =') + ';', build.context);
    await build.context.exp.onclick();
    A.eq([build.posts.length, build.clicks.length], [1, 0], 'actual shared-build callback uses the same desktop owner');
    A.ok(status.innerHTML.includes(path.join(tmp, 'build.json')), 'actual shared-build status preserves the receipt alongside metadata');

    for (const action of ['export', 'publish']) {
      const skill = rig(true), text = action === 'export' ? '{"sealed":true}' : '{"handoff":true}\n';
      Object.assign(skill.context, { act: action, skill: { id: 'skill-fixture' }, agentId: 'agent', btn: { classList: { add() {}, remove() {} } },
        notify: line => skill.notices.push(line) });
      skill.context.Harness.skillExchangeExport = async () => ({ ok: true, envelope: text, filename: 'sealed.json', digest: 'fixture' });
      skill.context.Harness.skillExchangePublishHandoff = async () => ({ ok: true, handoff: { handoff: true } });
      const run = vm.runInContext('(async()=>{' + callback(source('frontend/app/stationui.js'), "if (act === '" + action + "')") + '})', skill.context);
      await run();
      A.eq([skill.posts.length, skill.clicks.length], [1, 0], action + ': actual skill action saves through the shared owner');
      A.ok(skill.notices[0] && skill.notices[0].includes(tmp), action + ': actual skill notice names the proven destination');
    }
    // Actual backup import must distinguish an unavailable memory restore from a
    // confirmed zero-addition restore, after the local half has already changed.
    for (const accepted of [false, true]) {
      const restore = rig(false), values = new Map();
      const answer = accepted ? { ok: true, status: 200, j: { ok: true, added: 0, forgotten: 2 } }
        : { ok: false, status: 503, j: { ok: false, error: 'memory storage unconfirmed' } };
      restore.context.localStorage = { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k), key: n => [...values.keys()][n], get length() { return values.size; } };
      restore.context.FileReader = class { readAsText(value) { this.result = value; this.onload(); } };
      restore.context.Harness.api.post = async () => answer;
      restore.context.fetch = async () => ({ ok: answer.ok, json: async () => answer.j });
      vm.runInContext(source('frontend/app/backup.js') + '\nthis.Backup=Backup;', restore.context);
      const B = restore.context.Backup;
      const result = await B.importFile(JSON.stringify({ schema: B.SCHEMA, version: B.VERSION, store: { 'starnet.save': '{}' }, notebook: [{ text: 'a saved memory' }] }));
      if (accepted) A.eq([result.ok, result.memoriesRestored, result.memoriesForgotten], [true, 0, 2], 'confirmed zero additions still preserve the host forgotten count');
      else {
        A.eq([result.ok, result.memoriesRestored], [false, undefined], 'unconfirmed memory restore is never advertised as zero restored successfully');
        A.ok(result.error && /partly restored.*memory storage unconfirmed/.test(result.error), 'partial restore keeps the real refusal and its recovery context');
      }
    }
  } finally {
    const owned = path.resolve(tmp);
    if (path.dirname(owned) !== path.resolve(os.tmpdir()) || !path.basename(owned).startsWith('starnet-download-proof-')) throw Error('fixture cleanup escaped allocated directory');
    fs.rmSync(owned, { recursive: true, force: true });
  }
  A.report('download-helper.ratchet');
})().catch(e => { A.ok(false, 'download proof threw: ' + (e.stack || e)); A.report('download-helper.ratchet'); });
