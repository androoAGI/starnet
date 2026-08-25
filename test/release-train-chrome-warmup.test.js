/* Locks the release train's two-phase Chrome startup guard.

   A GitHub-hosted runner may need more than the product's 10-second CDP budget for the
   first Chrome process after boot. The train warms that cold process with a bounded
   allowance, then proves a second fresh-profile launch still meets the real test budget.
   This is a structural workflow check: no node_modules or YAML parser required. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-train.yml'), 'utf8');

const wrapper = yml.match(/- name: Resolve Chrome binary for e2e gate tests([\s\S]*?)(?=\n      - name:)/);
A.ok(wrapper, 'release train resolves Chrome before the gate');
A.ok(/--no-sandbox --disable-dev-shm-usage/.test(wrapper[1]), 'CI Chrome wrapper injects hosted-runner safety flags');

const step = yml.match(/- name: Warm Chrome, then prove CDP comes up inside the tests' 10s window([\s\S]*?)(?=\n      - name:)/);
A.ok(step, 'release train has the two-phase Chrome startup guard');
const body = step[1];

const cold = body.indexOf('--remote-debugging-port=9332');
const proof = body.indexOf('--remote-debugging-port=9333');
A.ok(cold !== -1 && proof > cold, 'bounded cold warmup runs before the test-budget proof');
A.ok(/chrome-cold-warmup/.test(body), 'cold warmup has its own user-data directory');
A.ok(/seq 1 240/.test(body) && /within 60s/.test(body), 'cold warmup is bounded at 60 seconds');
A.ok(/chrome-cdp-proof/.test(body), 'proof launch uses a fresh user-data directory');
A.ok(/seq 1 40/.test(body) && /tests' 10s budget/.test(body), 'proof preserves the tests\' 10-second CDP budget');
A.ok((body.match(/kill "\$CPID"/g) || []).length === 2, 'both Chrome processes are terminated');
A.ok((body.match(/wait "\$CPID"/g) || []).length === 2, 'both Chrome processes are reaped');

A.report('release-train-chrome-warmup.test');
