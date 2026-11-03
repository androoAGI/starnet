/* Real export writer + allocated files. Only the named filesystem failure is injected;
   exclusive creation, file contents, collisions and cleanup use the actual filesystem.
   EXPORT_FILE_CONTROL compiles exact saved old source at its real module path. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const A = require('./_assert.js');
const filename = path.resolve(__dirname, '../sidecar/backupfile.js');
let writer = require(filename);
if (process.env.EXPORT_FILE_CONTROL) {
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(process.env.EXPORT_FILE_CONTROL, 'utf8'), filename); writer = m.exports;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-export-owned-'));
const error = code => Object.assign(new Error('allocated export fault'), { code });
const bytes = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
function dir(name) { const p = path.join(tmp, name); fs.mkdirSync(p); return p; }
try {
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOSPC']) {
    const root = dir('open-' + code), file = path.join(root, 'report.json');
    fs.writeFileSync(file, 'existing report');
    let opens = 0, deletes = 0;
    const facade = Object.assign({}, fs, {
      openSync(p, flags, mode) { if (p === file && flags === 'wx') { opens++; throw error(code); } return fs.openSync(p, flags, mode); },
      writeFileSync(p, body, opts) {
        // Old path-taking API and current fd-taking API encounter the same pre-creation fault.
        if (p === file && opts && opts.flag === 'wx') { opens++; throw error(code); }
        return fs.writeFileSync(p, body, opts);
      },
      unlinkSync(p) { if (p === file) deletes++; return fs.unlinkSync(p); }
    });
    const r = writer.saveExportFile('new report', { dir: root, base: 'report', fs: facade });
    A.eq([r.ok, opens], [false, 1], code + ': actual export refuses the single pre-ownership failure');
    A.eq(deletes, 0, code + ': failed exclusive creation never authorizes unlink');
    A.eq(bytes(file), 'existing report', code + ': the unrelated existing file survives intact');
  }
  for (const mode of ['partial-write', 'readback-failure', 'readback-mismatch']) {
    const root = dir(mode), file = path.join(root, 'report.json');
    let hit = false;
    const facade = Object.assign({}, fs, {
      writeFileSync(p, body, opts) {
        if (mode === 'partial-write' && !hit) {
          hit = true;
          if (typeof p === 'number') fs.writeSync(p, Buffer.from('partial'));
          else fs.writeFileSync(p, 'partial', opts);
          throw error('ENOSPC');
        }
        return fs.writeFileSync(p, body, opts);
      },
      readFileSync(p, opts) {
        if (p === file && mode === 'readback-failure') { hit = true; throw error('EIO'); }
        if (p === file && mode === 'readback-mismatch') { hit = true; return 'different bytes'; }
        return fs.readFileSync(p, opts);
      }
    });
    const r = writer.saveExportFile('whole report', { dir: root, base: 'report', fs: facade });
    A.eq([r.ok, hit], [false, true], mode + ': real owned output refuses unproven bytes');
    A.eq(fs.existsSync(file), false, mode + ': this call can clean up its own partial output');
  }
  {
    const root = dir('replacement'), file = path.join(root, 'report.json');
    let replaced = false;
    const facade = Object.assign({}, fs, {
      readFileSync(p, opts) {
        if (p === file && !replaced) {
          replaced = true; fs.unlinkSync(file); fs.writeFileSync(file, 'another owner replaced the name', { flag: 'wx' });
        }
        return fs.readFileSync(p, opts);
      }
    });
    const r = writer.saveExportFile('our initial output', { dir: root, base: 'report', fs: facade });
    A.eq([r.ok, replaced], [false, true], 'a replaced destination cannot prove our export');
    A.eq(bytes(file), 'another owner replaced the name', 'failed readback cannot unlink a different file at the same name');
  }
  {
    const root = dir('success'), first = path.join(root, 'report.json');
    fs.writeFileSync(first, 'older report');
    const r = writer.saveExportFile('complete new report', { dir: root, base: 'report' });
    A.eq([r.ok, r.file, r.path], [true, 'report-2.json', path.join(root, 'report-2.json')], 'exclusive collision creates the next actual filename');
    A.eq(bytes(first), 'older report', 'collision never overwrites the older report');
    A.eq(bytes(r.path), 'complete new report', 'success receipt names the exact readback-proved output');
    A.eq(r.bytes, Buffer.byteLength('complete new report'), 'receipt reports the real byte count');
  }
} finally {
  const owned = path.resolve(tmp), parent = path.resolve(os.tmpdir()) + path.sep;
  if (!owned.startsWith(parent) || !path.basename(owned).startsWith('starnet-export-owned-')) throw new Error('refusing cleanup outside allocated fixture');
  fs.rmSync(owned, { recursive: true, force: true });
}
A.report('export-file-ownership');
