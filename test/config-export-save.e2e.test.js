/* node test/config-export-save.e2e.test.js — #134: the desktop EXPORT STATION route writes a real file the line can name.
   Boots a real sidecar whose home (USERPROFILE/HOME) is a scratch dir with a Downloads folder, then proves through
   HTTP: the route saves the envelope into <home>/Downloads, returns that exact path, never overwrites a same-day
   backup, and stays behind the launch token like every /api route. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-export-home-'));
  const downloads = path.join(home, 'Downloads');
  fs.mkdirSync(downloads);
  const fixture = SidecarFixture.create({ prefix: 'starnet-export-save-', env: { USERPROFILE: home, HOME: home } });
  if (process.env.EXPORT_SAVE_CONTROL) {
    const index = path.resolve(__dirname, '../sidecar/index.js'), entry = path.join(fixture.profile, 'export-control.cjs');
    fs.writeFileSync(entry, "const fs=require('node:fs'),M=require('node:module'),p=require('node:path');\n"
      + 'const f=' + JSON.stringify(index) + ',m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));\n'
      + 'm._compile(fs.readFileSync(' + JSON.stringify(path.resolve(process.env.EXPORT_SAVE_CONTROL)) + ",'utf8'),f);\n");
    fixture.entry = entry;
  }
  try {
    await fixture.start();

    const first = await fixture.json('POST', '/api/config/export/save', { sections: { settings: { theme: 'blue' } } });
    A.eq(first.status, 200, 'POST /api/config/export/save -> 200');
    A.eq(first.body.ok, true, 'the save reports ok');
    A.eq(path.dirname(first.body.path), downloads, 'the file lands in the Commander\'s Downloads folder');
    A.ok(/^starnet-station-\d{4}-\d{2}-\d{2}\.json$/.test(first.body.file), 'the file carries the dated backup name: ' + first.body.file);
    A.eq(path.join(downloads, first.body.file), first.body.path, 'the returned path is the file\'s real absolute path');
    const env = JSON.parse(fs.readFileSync(first.body.path, 'utf8'));
    A.eq(env.starnetExport, 1, 'the saved file is the station export envelope');
    A.eq(env.sections.settings, { theme: 'blue' }, 'the browser-owned slices ride into the saved file');
    // save v7 (history by reference): a saved history may name rows only the station's transcript holds, so a file that leaves the station must
    // never carry one. The station export is configuration, not conversations: no session, no history, and so no reference that would dangle.
    const exported = fs.readFileSync(first.body.path, 'utf8');
    A.ok(!/"\$ref"/.test(exported) && !/"workstreams"/.test(exported) && !/"history"/.test(exported), 'the export holds no conversation and no reference to one (a packed history is only meaningful beside its own transcript)');

    const second = await fixture.json('POST', '/api/config/export/save', { sections: {} });
    A.eq(second.status, 200, 'a second save the same day succeeds');
    A.ok(second.body.path !== first.body.path && /-2\.json$/.test(second.body.file), 'a second save gets its own name: ' + second.body.file);
    A.eq(JSON.parse(fs.readFileSync(first.body.path, 'utf8')).sections.settings, { theme: 'blue' }, 'the first backup is not overwritten');

    const tokenless = await fetch(fixture.baseUrl + '/api/config/export/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.baseUrl }, body: '{}'
    });
    A.eq(tokenless.status, 403, 'the save route is behind the launch token');
    A.eq(fs.readdirSync(downloads).length, 2, 'a refused request writes nothing');

    const plain = await fixture.json('POST', '/api/config/export', { sections: {} });
    A.eq(plain.status, 200, 'the browser export route is unchanged');
    A.eq(plain.body.starnetExport, 1, 'the browser export still returns the envelope itself');

    // Generic exports still use the actual host, token gate, allocated home and filesystem.
    for (const [ext, text] of [['json', '{"real":"bytes"}\n'], ['txt', 'typed export — snow ☃\n'], ['md', '# Actual export\n']]) {
      const saved = await fixture.json('POST', '/api/export/save', { name: 'report.' + ext, ext, text, dir: path.dirname(home), path: 'ignored' });
      const value = saved.body || {};
      A.eq([saved.status, value.ok, value.file, value.dir], [200, true, 'report.' + ext, downloads], ext + ': receipt names the actual host-owned destination');
      A.eq(value.path, path.join(downloads, 'report.' + ext), ext + ': caller dir/path cannot select the output location');
      A.eq(value.path && fs.existsSync(value.path) ? fs.readFileSync(value.path, 'utf8') : null, text, ext + ': receipt bytes are present on the allocated disk');
      A.eq(value.bytes, Buffer.byteLength(text), ext + ': byte count measures actual UTF-8 text');
    }
    const duplicate = await fixture.json('POST', '/api/export/save', { name: 'report.txt', ext: 'txt', text: 'second text' });
    A.eq([duplicate.status, duplicate.body && duplicate.body.file], [200, 'report-2.txt'], 'generic export collision gets an exclusive suffix');
    A.eq(fs.existsSync(path.join(downloads, 'report.txt')) ? fs.readFileSync(path.join(downloads, 'report.txt'), 'utf8') : null, 'typed export — snow ☃\n', 'repeat export preserves the original bytes');
    for (const [name, expected] of [['../evil\\name:report.txt', '-evil-name-report.txt'], ['CON.txt', 'starnet-CON.txt'], ['... ', 'starnet-export.txt']]) {
      const saved = await fixture.json('POST', '/api/export/save', { name, ext: 'txt', text: 'safe label' });
      A.eq([saved.status, saved.body && saved.body.file, saved.body && saved.body.path], [200, expected, path.join(downloads, expected)], 'a path/device/empty label remains one ordinary export filename');
    }
    const beforeRefusals = fs.readdirSync(downloads).sort();
    for (const body of [{ name: 'report', ext: 'exe', text: 'no' }, { name: '../report', ext: '../txt', text: 'no' },
      { name: 'report', ext: 'txt', text: {} }, { name: null, ext: 'txt', text: '' }, null, []]) {
      const refused = await fixture.json('POST', '/api/export/save', body);
      A.eq([refused.status, refused.headers.get('x-starnet-code'), refused.body && refused.body.code, refused.body && refused.body.ok],
        [400, 'bad_request', 'bad_request', false], 'invalid export shape/extension has one typed refusal');
    }
    const malformed = await fixture.request('/api/export/save', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } });
    const malformedBody = await malformed.json().catch(() => null);
    A.eq([malformed.status, malformed.headers.get('x-starnet-code'), malformedBody && malformedBody.code], [400, 'bad_json', 'bad_json'], 'invalid JSON is not a write acknowledgement');
    const noToken = await fetch(fixture.baseUrl + '/api/export/save', { method: 'POST', headers: { Origin: fixture.baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'unauthorized', ext: 'txt', text: 'no' }) });
    A.eq([noToken.status, noToken.headers.get('x-starnet-code')], [403, 'token_missing'], 'generic export retains the real launch-token gate');
    await noToken.text();
    const large = await fixture.json('POST', '/api/export/save', { name: 'oversized', ext: 'txt', text: 'x'.repeat((16 << 20) + 1) });
    A.eq([large.status, large.headers.get('x-starnet-code'), large.body && large.body.code, large.body && large.body.ok],
      [413, 'too_large', 'too_large', false], 'body cap refuses the actual oversized HTTP upload');
    A.eq(fs.readdirSync(downloads).sort(), beforeRefusals, 'all refused uploads create no files');

    for (let i = 1; i <= 99; i++) fs.writeFileSync(path.join(downloads, 'full' + (i === 1 ? '' : '-' + i) + '.txt'), 'existing ' + i);
    const full = await fixture.json('POST', '/api/export/save', { name: 'full', ext: 'txt', text: 'cannot land' });
    A.eq([full.status, full.headers.get('x-starnet-code'), full.body && full.body.code, full.body && full.body.ok],
      [500, 'station_error', 'station_error', false], 'exhausted exclusive filenames produce an honest host refusal');
    A.ok(full.body && typeof full.body.error === 'string' && full.body.error.includes(downloads), 'write refusal names the actual destination and reason');
    A.ok(Array.from({ length: 99 }, (_, n) => n + 1).every(i => fs.readFileSync(path.join(downloads, 'full' + (i === 1 ? '' : '-' + i) + '.txt'), 'utf8') === 'existing ' + i), 'exhaustion preserves every pre-existing file');
  } catch (e) {
    A.ok(false, 'config-export-save.e2e threw: ' + (e && e.stack ? e.stack : e));
    console.error(fixture.output().slice(-2000));
  } finally {
    await fixture.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  }
  A.report('config-export-save.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
