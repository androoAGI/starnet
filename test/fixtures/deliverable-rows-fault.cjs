'use strict';
// Only the sidecar child of test/deliverable-rows.e2e.test.js uses this preload. The real transcript writer, its rollback and its
// read-back still run; while the arm file exists, the one write of a kind:'deliverable' row fails with EIO before any byte lands.
const fs = require('node:fs'), path = require('node:path');
const workspace = path.resolve(process.env.STARNET_WORKSPACES);
const history = path.join(workspace, 'transcript-history-v2');
const arm = path.join(workspace, 'deliverable-fault.arm');
const evidence = path.join(workspace, 'deliverable-fault-observed.jsonl');
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
    if (row && row.kind === 'deliverable') {
      fs.appendFileSync(evidence, JSON.stringify({ runId: row.sourceRunId, streamId: row.streamId, kind: row.kind }) + '\n');
      throw Object.assign(new Error('fixture file-row disk failure'), { code: 'EIO' });
    }
  }
  return write.call(this, fd, data, ...args);
};
