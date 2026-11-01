'use strict';
/* node test/boot-limit.test.js — a sidecar boot gets time to finish on a loaded box, and a dead boot still fails at once.

   THE HOLE THIS CLOSES (2026-11-01): 50 e2e rigs gave a sidecar 9 s to print its address. On a box running a gate plus
   other work, a healthy boot outran that: 7 of G1's 10 failed steps in one http run were this line. A rig is copied to
   start the next test, so the number has to be held here or it comes back.

     L1 a one-line boot timer waits at least 30 s;
     L2 it is unref'd, because nothing clears it: a test that ends in 5 s must not sit open until it fires;
     L3 the rig rejects as soon as the child closes, so a sidecar that dies at boot fails in its own time, with its output.
        'close', not 'exit': stdio is read by then, so a bind refusal is seen and retried before this reads as a death. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const MIN_MS = 30000;
const files = fs.readdirSync(__dirname).filter(name => /\.(js|mjs|cjs)$/.test(name) && name !== path.basename(__filename));
const TIMER = /setTimeout\(\(\) => \{ if \(!settled\) \{ settled = true; try \{ (\w+)\.kill\(\); \}[^\n]*?boot timeout[^\n]*?\}, (\w+)\)(\.unref\(\))?;/;
let seen = 0;
for (const name of files) {
  const lines = fs.readFileSync(path.join(__dirname, name), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = TIMER.exec(line);
    if (!m) return;
    seen++;
    const where = name + ':' + (i + 1);
    const named = new RegExp('const ' + m[2] + ' = (\\d+);').exec(lines.join('\n'));
    const ms = /^\d+$/.test(m[2]) ? Number(m[2]) : (named ? Number(named[1]) : NaN);
    A.ok(ms >= MIN_MS, 'L1: ' + where + ' gives the boot ' + MIN_MS + ' ms or more (found ' + m[2] + ')');
    A.ok(!!m[3], 'L2: ' + where + ' does not hold the process open');
    const watched = new RegExp(m[1] + "\\.(on|once)\\('(close|exit)'").test(lines.slice(Math.max(0, i - 20), i + 1).join('\n'));
    A.ok(watched, 'L3: ' + where + ' fails at once when the child dies during boot');
  });
}
A.ok(seen >= 80, 'the rule reads the rigs it is for (found ' + seen + ')');
A.report('boot-limit.test');
