'use strict';
// Real headless Chromium against a local, disposable export fixture. No account data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { _internals: browser } = require('../../sidecar/tools/builtin/browser.js');

async function run(directory) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true });
  const csv = 'project,status\r\nStarNet CUA evaluation,exported\r\n';
  const server = http.createServer((req, res) => {
    if (req.url === '/report.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="evaluation-report.csv"' });
      return res.end(csv);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>StarNet export fixture</title><h1>Evaluation report</h1><a href="/report.csv" download>Export report</a>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const driver = browser.makeCdpDriver({ cdpPort: 0, forceHeadless: true, profileDir: path.join(root, 'chrome-profile'), downloadDir: path.join(root, 'downloads') });
  const start = performance.now();
  try {
    await driver.navigate('http://127.0.0.1:' + server.address().port);
    const snapshot = await driver.snapshot();
    const nodes = Array.isArray(snapshot) ? snapshot : snapshot.nodes;
    const link = nodes.find(n => n.text === 'Export report');
    assert.ok(link, 'live browser must expose export link');
    const result = await driver.click(link);
    const file = path.join(root, 'downloads', 'evaluation-report.csv');
    assert.equal(fs.readFileSync(file, 'utf8'), csv);
    const receipt = { scenario: 'browser-export', ms: Math.round(performance.now() - start), passed: true, file, bytes: Buffer.byteLength(csv), browserResult: result };
    fs.writeFileSync(path.join(root, 'browser-export.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally { await driver.close(); await new Promise(r => server.close(r)); }
}
if (require.main === module) run(process.argv[2] || '.qa_tmp/cua-evaluation').then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { run };
