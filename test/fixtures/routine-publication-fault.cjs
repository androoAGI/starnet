'use strict';
// Only this fixture-owned child uses this preload. The real transcript writer and
// its rollback/readback still run; the one controlled fault happens before bytes land.
const fs = require('node:fs'), path = require('node:path');
const workspace = path.resolve(process.env.STARNET_WORKSPACES);
const history = path.join(workspace, 'transcript-history-v2');
const arm = path.join(workspace, 'publication-fault.arm');
const evidence = path.join(workspace, 'publication-fault-observed.jsonl');
const handles = new Map(), open = fs.openSync, close = fs.closeSync, write = fs.writeSync;
fs.openSync = function (file, ...args) {
  const fd = open.call(this, file, ...args);
  if (typeof file === 'string' && path.dirname(path.resolve(file)) === history && /^segment-\d+\.jsonl$/.test(path.basename(file))) handles.set(fd, path.resolve(file));
  return fd;
};
fs.closeSync = function (fd, ...args) { handles.delete(fd); return close.call(this, fd, ...args); };
fs.writeSync = function (fd, data, ...args) {
  if (handles.has(fd) && Buffer.isBuffer(data) && fs.existsSync(arm)) {
    let row; try { row = JSON.parse(data.toString('utf8').trim()); } catch (_) {}
    if (row && row.kind === 'delivery' && row.streamId === 'publication_original') {
      fs.appendFileSync(evidence, JSON.stringify({ file: handles.get(fd), runId: row.sourceRunId, streamId: row.streamId, kind: row.kind }) + '\n');
      throw Object.assign(new Error('fixture canonical publication disk failure'), { code: 'EIO' });
    }
  }
  return write.call(this, fd, data, ...args);
};
// Cross the real retry deadline on restart without modifying any persisted receipt.
const advance = Number(process.env.STARNET_TEST_PUBLICATION_CLOCK_MS || 0);
if (advance === 61000) { const now = Date.now; Date.now = () => now() + advance; }
