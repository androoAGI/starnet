/* node test/browser.download-receipt.test.js -- pure receipt bookkeeping tests. */
'use strict';
const A = require('./_assert.js');
const FS = require('node:fs');
const OS = require('node:os');
const P = require('node:path');
const { _internals: T } = require('../sidecar/tools/builtin/browser.js');

(async () => {
  const dir = FS.mkdtempSync(P.join(OS.tmpdir(), 'starnet-download-receipt-'));
  try {
    const ledger = T.makeDownloadLedger(dir);
    const before = ledger.cursor();
    const begun = ledger.begin({ guid: 'one', suggestedFilename: '../Latest Resume.docx' });
    A.eq(begun.filename, 'Latest Resume.docx', 'download filenames are reduced to a basename');
    A.ok(ledger.startedAfter(before) !== null, 'a new download is visible after the click cursor');

    const bytes = Buffer.from('owned docx fixture bytes');
    FS.writeFileSync(P.join(dir, 'Latest Resume.docx'), bytes);
    ledger.progress({ guid: 'one', state: 'completed', receivedBytes: bytes.length, totalBytes: bytes.length });
    const receipt = await ledger.waitAfter(before, 20);
    A.eq(receipt.status, 'completed', 'a terminal event plus a real file produces a receipt');
    A.eq(receipt.relative, 'downloads/Latest Resume.docx', 'the receipt gives the agent-jail-relative path');
    A.eq(receipt.bytes, bytes.length, 'receipt bytes come from the on-disk stat');

    const missingCursor = ledger.cursor();
    ledger.begin({ guid: 'two', suggestedFilename: 'missing.docx' });
    ledger.progress({ guid: 'two', state: 'completed', receivedBytes: 99, totalBytes: 99 });
    const missing = await ledger.waitAfter(missingCursor, 20);
    A.eq(missing.status, 'unverified', 'a completion event cannot claim a path when no file exists');

    const canceledCursor = ledger.cursor();
    ledger.begin({ guid: 'three', suggestedFilename: 'canceled.docx' });
    ledger.progress({ guid: 'three', state: 'canceled' });
    const canceled = await ledger.waitAfter(canceledCursor, 20);
    A.eq(canceled.status, 'canceled', 'a canceled download is represented honestly');

    // downloadClickReceipt: the click's words for each receipt, exactly what clickOn returns (run-paths review M4)
    const say = T.downloadClickReceipt;
    A.ok(/Saved path: downloads\/Latest Resume\.docx/.test(say(receipt, {})), 'completed, unscoped: the jail-relative saved path');
    const placed = say(receipt, { place: abs => '/abs' + (abs === receipt.absolute ? '/placed' : '/other'), downloadDir: dir });
    A.ok(/Saved path: \/abs\/placed\n/.test(placed), 'completed, in a run: the saved path as the run places it');
    A.ok(/Download canceled\. No saved path was claimed/.test(say(canceled, {})), 'canceled: no path claimed');
    A.ok(/could not verify a readable saved file/.test(say(missing, {})), 'unverified: no path claimed');
    const started = { status: 'started' };
    A.ok(/Use fs\.list on downloads\/ later/.test(say(started, {})), 'incomplete, unscoped: the jail-relative folder');
    A.ok(/Use fs\.list on \/abs\/other later/.test(say(started, { place: () => '/abs/other', downloadDir: dir })), 'incomplete, in a project run: the placed (absolute) folder, no trailing slash');
    A.ok(/Use fs\.list on downloads\/ later/.test(say(null, {})), 'no receipt at all reads as not completed');
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
  A.report('browser.download-receipt');
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
