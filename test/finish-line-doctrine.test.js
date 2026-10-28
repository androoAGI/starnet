/* node test/finish-line-doctrine.test.js — immutable task-completion doctrine.

   The editable agent identity cannot be the only place that says "finish the job": a Commander may edit it,
   autonomous surfaces may carry an older persona, and model families vary in how readily they stop after one
   failed tool. The host therefore appends one compact doctrine at the final runOnce prompt seam for every real
   task. This test locks both the behavioral contract and that final-seam wiring. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const FinishLine = require('../sidecar/finish-line.js');

const root = path.resolve(__dirname, '..');
const indexJs = readSidecarSource();

const text = FinishLine.block({ tools: ['tool.search', 'browser.login', 'shell.exec'] });
A.ok(/keep working until the requested result is actually complete/i.test(text), 'doctrine requires actual completion');
A.ok(/different query, arguments, strategy, or tool/i.test(text), 'doctrine requires an alternate route after a failed or partial tool path');
A.ok(/tool\.search/.test(text), 'doctrine tells the agent to discover a capability before declaring it absent');
A.ok(/browser\.login/.test(text) && /visible/i.test(text), 'doctrine names the first-class attended login path');
A.ok(/irreducible human input/i.test(text), 'doctrine asks the Commander only for genuinely human-only input');
A.ok(/verify/i.test(text) && /fabricat/i.test(text), 'doctrine requires evidence and forbids invented success');
A.ok(/safe, authorized, in-scope alternatives/i.test(text), 'persistence remains bounded by authority and safety');

const base = 'IDENTITY';
const applied = FinishLine.append(base, { isTask: true, internal: false, tools: ['tool.search'] });
A.ok(applied.indexOf(base) === 0 && applied.indexOf('FINISH THE JOB') > 0, 'real task receives the immutable block after its identity');
A.eq(FinishLine.append(base, { isTask: false, internal: false, tools: [] }), base, 'plain chat/non-task prompt stays byte-identical');
A.eq(FinishLine.append(base, { isTask: true, internal: true, tools: [] }), base, 'strict internal runs stay byte-identical');
A.eq(FinishLine.append(applied, { isTask: true, internal: false, tools: ['tool.search'] }), applied, 'append is idempotent');

A.ok(/FinishLine\.append\([\s\S]{0,500}isTask[\s\S]{0,200}internal[\s\S]{0,200}resolved\.tools/.test(indexJs), 'runOnce appends doctrine at the host-controlled final prompt seam using the live tool grant');

A.report('finish-line-doctrine.test');
