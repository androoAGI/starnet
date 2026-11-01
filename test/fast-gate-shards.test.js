'use strict';
/* node test/fast-gate-shards.test.js — CI runs all of test/fast.list, split, without anyone maintaining the split.

   THE HOLE THIS CLOSES (2026-11-01): one fast-gate job ran test/fast.list and the customer journeys in series and had
   reached ~24.5 of its 25 minutes, with every lane adding steps. fast-gate.yml now runs the list as K/N shards plus a
   journeys leg. A split can lose steps without going red: a leg dropped from the matrix, or a filter on the command,
   leaves every remaining leg green. So:

     S1 the matrix names every shard 1..N exactly once, and one journeys leg; one red leg never cancels another.
     S2 each fast leg runs its own shard with no filter, bounded inside the job; the journeys leg runs the journeys;
        nothing lets a red leg pass.
     S3 the real test/fast.list: every line lands in exactly one shard, in declared order, and no shard is empty.
     S4 a line added anywhere is placed with no other edit, and still runs exactly once.
     S5 through the real runner: each fixture step EXECUTES exactly once across the shards.
     S6 the entry point CI calls takes --shard.
     S7 local and tag-time behaviour is unchanged: `npm run test:fast` and the release train run the whole list. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  const runner = await import(pathToFileURL(path.join(root, 'scripts', 'run-test-list.mjs')).href);
  const job = (read('.github/workflows/fast-gate.yml').match(/^ {2}gate:\n(?:(?: {4}.*)?\n)+/m) || [''])[0];
  A.ok(job, 'fast-gate.yml has a gate job');

  // S1
  const partsLine = job.match(/^\s+part: \[(.*)\]$/m);
  const parts = partsLine ? partsLine[1].split(',').map(p => p.trim().replace(/^'|'$/g, '')) : [];
  const shardParts = parts.filter(p => p !== 'journeys');
  A.eq(parts.length - shardParts.length, 1, 'S1: the matrix has one journeys leg');
  const total = shardParts.length;
  A.ok(total >= 2, 'S1: the matrix has shards');
  A.eq(shardParts, Array.from({ length: total }, (_, i) => (i + 1) + '/' + total), 'S1: the matrix names every shard 1..N exactly once');
  A.ok(/^\s+fail-fast: false$/m.test(job), 'S1: one red leg never cancels another');
  A.ok(!/^\s+(exclude|include):/m.test(job), 'S1: nothing edits the matrix behind the part list');
  A.ok(!/^ {4}if:/m.test(job), 'S1: the job itself is never skipped');
  const triggers = (read('.github/workflows/fast-gate.yml').match(/^on:\n((?: .*\n)+)/m) || ['', ''])[1];
  A.ok(/^ {2}pull_request:\n/m.test(triggers) && !/paths|branches-ignore/.test(triggers), 'S1: no path filter keeps the gate from a change');

  // S2
  const fast = job.match(/- name: Fast test gate[^\n]*\n\s+if: matrix\.part != 'journeys'\n\s+run: node scripts\/timeout\.mjs --label test:fast --timeout=(\d+) -- node scripts\/run-fast-tests\.mjs --shard=\$\{\{ matrix\.part \}\} --deadline=(\d+)\n/);
  A.ok(fast, 'S2: each fast leg runs its own shard of the list, with no filter');
  A.ok(/- name: Customer journey[^\n]*\n\s+if: matrix\.part == 'journeys'\n\s+run: npm run qa:customer-journeys\n/.test(job), 'S2: the journeys leg runs the customer journeys');
  const jobMinutes = job.match(/^\s+timeout-minutes: (\d+)$/m);
  A.ok(jobMinutes, 'S2: the job has a timeout');
  if (fast && jobMinutes) {
    A.ok(Number(fast[2]) < Number(fast[1]), 'S2: the runner\'s deadline ends inside its wrapper, so a late leg still prints its failure list');
    A.ok(Number(fast[1]) < Number(jobMinutes[1]) * 60000, 'S2: the wrapper ends inside the job\'s timeout');
  }
  A.ok(!/continue-on-error/.test(job), 'S2: no step of the job may fail without failing the job');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-fast-shards-'));
  try {
    const cut = (steps, n) => Array.from({ length: n }, (_, i) => runner.shardSteps(steps, runner.parseShard((i + 1) + '/' + n)));

    // S3
    const steps = runner.readSteps(path.join(root, 'test', 'fast.list'));
    A.ok(steps.length > total, 'S3: the real list has more steps than shards');
    const shards = cut(steps, total);
    A.eq(shards.flat(), steps, 'S3: every line of the real test/fast.list lands in exactly one shard, in declared order');
    A.ok(shards.every(shard => shard.length > 0), 'S3: no shard is empty');

    // S4
    const listFile = path.join(dir, 'grown.list');
    const added = 'test/a-new-lane-step.test.js';
    const middle = Math.floor(steps.length / 2);
    fs.writeFileSync(listFile, [...steps.slice(0, middle), '# a comment is not a step', added, ...steps.slice(middle)].join('\n') + '\n');
    const grown = runner.readSteps(listFile);
    A.eq(cut(grown, total).flat(), grown, 'S4: a line added to the list is placed with no other edit, and the rest still run once');
    A.eq(cut(grown, total).filter(shard => shard.includes(added)).length, 1, 'S4: the new line lands in exactly one shard');
    fs.writeFileSync(listFile, [...steps, added].join('\n') + '\n');
    const appended = runner.readSteps(listFile);
    A.eq(cut(appended, total).flat(), appended, 'S4: so does a line added at the end');
    A.ok(cut(appended, total).pop().includes(added), 'S4: which runs in the last shard');

    // S5 — 11 is deliberately not a multiple of the shard count
    const marks = path.join(dir, 'ran.log');
    const fixture = Array.from({ length: 11 }, (_, i) => {
      const file = path.join(dir, 'step' + i + '.js');
      fs.writeFileSync(file, 'require("node:fs").appendFileSync(' + JSON.stringify(marks) + ', ' + JSON.stringify(i + '\n') + ');\n');
      return file;
    });
    const fixtureList = path.join(dir, 'fixture.list');
    fs.writeFileSync(fixtureList, fixture.join('\n') + '\n');
    const none = path.join(dir, 'none.list');
    fs.writeFileSync(none, '# nothing\n');
    for (let k = 1; k <= total; k++) {
      const code = await runner.runList({ label: 'fixture', listFile: fixtureList, shard: runner.parseShard(k + '/' + total), slowList: none, flakyList: none, log: () => {}, stdout: { write() { return true; } }, stderr: { write() { return true; } } });
      A.eq(code, 0, 'S5: shard ' + k + '/' + total + ' exits green');
    }
    A.eq(fs.readFileSync(marks, 'utf8').trim().split('\n').map(Number), fixture.map((_, i) => i), 'S5: every step executed exactly once across the shards, in order');

    // S6 — out of range, so the run stops before any step starts
    const entry = spawnSync(process.execPath, [path.join('scripts', 'run-fast-tests.mjs'), '--shard=' + (total + 1) + '/' + total], { cwd: root, encoding: 'utf8', timeout: 30000 });
    A.eq(entry.status, 1, 'S6: the fast entry point refuses a shard past the total');
    A.ok(/out of range/.test(entry.stderr || ''), 'S6: because it read --shard');
    A.ok(!/step \d+\//.test(entry.stdout || ''), 'S6: and it started no step');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // S7
  const scripts = JSON.parse(read('package.json')).scripts;
  A.ok(/^node scripts\/run-fast-tests\.mjs --deadline=\d+$/.test(scripts['test:fast:raw']), 'S7: test:fast:raw runs the whole list: no shard, no filter');
  A.ok(/-- npm run test:fast:raw$/.test(scripts['test:fast']), 'S7: and npm run test:fast still runs it');
  A.ok(/^\s+run: npm run test:fast\s*$/m.test(read('.github/workflows/release-train.yml')), 'S7: the release train still gates on the whole list');

  A.report('fast-gate-shards.test');
})().catch(error => { console.error(error); process.exit(1); });
