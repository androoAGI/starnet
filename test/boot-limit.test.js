'use strict';
/* node test/boot-limit.test.js — a sidecar boot gets time to finish on a loaded box, and a dead boot still fails at once.

   THE HOLE THIS CLOSES (2026-11-01): 50 e2e rigs gave a sidecar 9 s to print its address. On a box running a gate plus
   other work, a healthy boot outran that: 7 of G1's 10 failed steps in one http run were this line. A rig is copied to
   start the next test, so the number has to be held here or it comes back.

     L0 every line that reports a boot timeout is one of the shapes below, so a rig this rule cannot read goes red, not unseen;
     L1 a boot timer waits at least 30 s, and so does the shared sidecar fixture's default on every platform;
     L2 a timer is unref'd or cleared: a test that ends in 5 s must not sit open until it fires;
     L3 a rig holding its own settled flag rejects as soon as the child closes, so a sidecar that dies at boot fails in its
        own time, with its output. 'close', not 'exit': stdio is read by then, so a bind refusal is seen and retried before
        this reads as a death. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const MIN_MS = 30000;
const files = fs.readdirSync(__dirname).filter(name => /\.(js|mjs|cjs)$/.test(name) && name !== path.basename(__filename));
// the rig's own timer, on one line, or spread from its setTimeout down to its limit
const TIMER = /setTimeout\(\(\) => \{ if \(!settled\) \{ settled = true; try \{ (\w+)\.kill\(\); \}[^\n]*?boot timeout[^\n]*?\}, (\w+)\)(\.unref\(\))?;/;
const SPREAD = /^\s*reject\(new Error\('[^']*boot timeout[^\n]*\);$/;
const SPREAD_HEAD = /setTimeout\(\(\) => \{$/;
const SPREAD_END = /^\s*\}, (\w+)\)(\.unref\(\))?;$/;
// a timer the rig clears when the boot ends, a polling wait with its limit in the call, and the helper behind such a wait
const CLEARED = /const (\w+) ?= ?setTimeout\(\(\) ?=> ?reject\(new Error\('[^']*boot timeout[^\n]*?\)\), ?(\w+)\);/;
const POLLED = /\bwaitFor\([^\n]*, (\w+), 'sidecar boot timeout/;
const POLL_HELPER = /if \(Date\.now\(\) - start > ms\) return reject\(new Error\('sidecar boot timeout'\)\);/;

const limitOf = (token, source) => {
  if (/^\d+$/.test(token)) return Number(token);
  const named = new RegExp('const ' + token + ' = (\\d+);').exec(source);
  return named ? Number(named[1]) : NaN;
};
let seen = 0;
for (const name of files) {
  const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
  const lines = source.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/boot timeout/.test(line) || /^\s*\/\//.test(line)) return;
    const where = name + ':' + (i + 1);
    const limit = token => A.ok(limitOf(token, source) >= MIN_MS, 'L1: ' + where + ' gives the boot ' + MIN_MS + ' ms or more (found ' + token + ')');
    const before = lines.slice(Math.max(0, i - 20), i + 1).join('\n');
    const closes = child => A.ok(new RegExp(child + "\\.(on|once)\\('close'").test(before), 'L3: ' + where + ' fails at once when the child dies during boot');
    let m;
    if ((m = TIMER.exec(line))) {
      seen++;
      limit(m[2]);
      A.ok(!!m[3], 'L2: ' + where + ' does not hold the process open');
      closes(m[1]);
    } else if (SPREAD.test(line)) {
      seen++;
      const end = lines.slice(i + 1, i + 4).map(l => SPREAD_END.exec(l)).find(Boolean);
      const head = lines.slice(Math.max(0, i - 6), i).reverse().find(l => SPREAD_HEAD.test(l));
      A.ok(!!end && !!head, 'L0: ' + where + ' is a boot timer this rule can read');
      if (!end || !head) return;
      limit(end[1]);
      const held = /const (\w+) = setTimeout/.exec(head);
      A.ok(!!end[2] || (!!held && source.includes('clearTimeout(' + held[1] + ')')), 'L2: ' + where + ' does not hold the process open');
      closes('child');
    } else if ((m = CLEARED.exec(line))) {
      seen++;
      limit(m[2]);
      A.ok(source.includes('clearTimeout(' + m[1] + ')'), 'L2: ' + where + ' clears its timer');
    } else if ((m = POLLED.exec(line))) {
      seen++;
      limit(m[1]);
    } else {
      A.ok(POLL_HELPER.test(line), 'L0: ' + where + ' is a boot timer this rule can read: ' + line.trim().slice(0, 100));
    }
  });
}
A.ok(seen >= 90, 'the rule reads the rigs it is for (found ' + seen + ')');
const fixture = fs.readFileSync(path.join(__dirname, 'helpers', 'sidecar-fixture.js'), 'utf8');
A.ok(/this\.timeoutMs = Number\(opts\.timeoutMs\) \|\| 30000;/.test(fixture), 'L1: the shared sidecar fixture gives a boot 30 s on every platform');
A.report('boot-limit.test');
