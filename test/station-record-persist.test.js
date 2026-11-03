/* Integration: the lifecycle owner uses persist's exclusive forensic names, including a competing writer. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const SR = require('../sidecar/station-record.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-record-persist-'));
try {
  for (const mode of ['race', 'unlink-refused']) {
    const ws = path.join(scratch, mode); fs.mkdirSync(ws);
    const file = path.join(ws, SR.RECORD_FILE), first = file + '.corrupt-1', second = file + '.corrupt-2';
    fs.writeFileSync(file, 'TORN CURRENT');
    const io = Object.create(fs), notes = [];
    let raced = false;
    const collide = (from, to) => {
      if (mode === 'race' && String(from) === file && String(to) === first && !raced) {
        raced = true; fs.writeFileSync(first, 'COMPETING INCIDENT');
      }
    };
    io.renameSync = (from, to) => {
      if (mode === 'unlink-refused' && String(from) === file) throw Object.assign(new Error('fixture: original is busy'), { code: 'EBUSY' });
      collide(from, to); return fs.renameSync(from, to);
    };
    io.linkSync = (from, to) => { collide(from, to); return fs.linkSync(from, to); };
    io.unlinkSync = target => {
      if (mode === 'unlink-refused' && String(target) === file) throw Object.assign(new Error('fixture: original is busy'), { code: 'EBUSY' });
      return fs.unlinkSync(target);
    };
    const view = SR.ensure({ fs: io, path, workspaceRoot: ws, now: () => 1793500000000, randomId: () => 'fixture', failNote: (tag, err) => notes.push(tag) });
    if (mode === 'race') {
      A.eq(raced, true, 'a competitor occupied the first name between choice and preservation');
      A.eq(fs.readFileSync(first, 'utf8'), 'COMPETING INCIDENT', 'the competing forensic copy is never replaced');
      A.eq(fs.existsSync(second) ? fs.readFileSync(second, 'utf8') : null, 'TORN CURRENT', 'this incident is preserved under the next exclusive name');
      A.eq(view.persisted, true, 'the lifecycle record can be replaced after preservation succeeds');
      A.eq(notes, [], 'successful preservation does not report a false write failure');
    } else {
      A.eq(fs.readFileSync(file, 'utf8'), 'TORN CURRENT', 'failed original removal leaves the authority byte-identical');
      A.eq(view.persisted, false, 'the owner never reports a persisted replacement after a failed move');
      A.eq(view.recordProblem, 'torn', 'the unresolved record remains identified as torn');
      A.eq(notes, ['station.record.write'], 'the unresolved move is reported at the lifecycle boundary');
      A.eq(fs.existsSync(first), false, 'the failed move cleans only its own newly created destination');
    }
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
A.report('station-record-persist');
