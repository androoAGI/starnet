'use strict';
/* Real domain-store recovery and actual chain daily-cap consumer. A recovered
   floor remains readable without becoming write or owned-receipt authority. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const A = require('./_assert.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { digest } = require('./helpers/line-continuation.js');
const ownerPath = require.resolve('../sidecar/routing/line-spend.js');
let M = require(ownerPath);
if (process.env.LINE_SPEND_PROJECTION_CONTROL) {
  const old = new Module(ownerPath, module); old.filename = ownerPath; old.paths = Module._nodeModulePaths(path.dirname(ownerPath));
  old._compile(fs.readFileSync(process.env.LINE_SPEND_PROJECTION_CONTROL, 'utf8'), ownerPath); M = old.exports;
}
(async () => {
  for (const primary of ['corrupt', 'missing']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-spend-projection-')), file = path.join(dir, 'line-spend.json');
    const now = 10 * M.DAY_MS + 1000;
    try {
      fs.writeFileSync(file + '.bak', JSON.stringify({ version: 1, lines: { 'line-a': { day: 10, usd: 5 } } }));
      if (primary === 'corrupt') fs.writeFileSync(file, '{fixture corrupt primary');
      const bytes = () => [fs.existsSync(file) ? digest(fs.readFileSync(file, 'utf8')) : null, digest(fs.readFileSync(file + '.bak', 'utf8'))];
      const original = bytes();
      const store = makeDomainStore({ fs, path, file, version: 1, defaults: () => ({}), normalize: M.clean,
        encode: v => { M.assertWritable(v); return { lines: v }; }, decode: e => e && e.lines });
      const recovered = store.load();
      A.eq([recovered.status, recovered.value['line-a'].usd], ['recovered', 5], primary + ' fixture truly recovers the existing five-dollar floor');
      const ledger = M.makeLineSpend({ now: () => now, read: () => store.load(), write: v => store.save(v) });
      A.eq(ledger.spentToday('line-a'), 5, primary + ' primary retains the legacy recovered spend projection');
      A.throws(() => ledger.note('line-a', 0.125, { jobId: 'job-receiptfixture1', runId: 'run-entry', endedAt: now }), primary + ' recovered data cannot confirm a new owned receipt');
      let calls = 0;
      const chain = makeChainRunner({ nextAgent: id => id === 'a' ? 'b' : null, now: () => now, daySpend: ledger,
        lineLimits: () => ({ maxUsdPerDay: 5 }), runAgent: async () => { calls++; return { text: 'downstream result', usd: 0 }; } });
      const result = await chain.advance({ agentId: 'a', lineId: 'line-a', text: 'existing entry output', entryUsd: 0 });
      A.eq(calls, 0, primary + ' recovered floor prevents the next paid hop through the actual chain');
      A.eq(result.hops.length, 0, primary + ' daily-cap refusal records no downstream stage');
      A.eq(result.stopped, 'the line reached its $5.00 daily limit', primary + ' refusal retains the established cap reason');
      A.eq(bytes(), original, primary + ' cap projection and strict refusal leave both original files unchanged');
    } finally {
      const resolved = path.resolve(dir);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('line-spend-projection-')) throw new Error('fixture cleanup escaped temporary parent');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  A.report('line-spend.projection');
})().catch(error => { console.error(error); process.exitCode = 1; });
