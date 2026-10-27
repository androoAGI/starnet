/* node test/comms-busy-age.test.js — exact human age wording for same-agent mutex refusals. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = readSidecarSource();
const match = /function\s+formatRunHolderAge\s*\(ageMs\)\s*\{([\s\S]*?)\n\}/.exec(src);
A.ok(match, 'sidecar exposes one bounded formatter for holder age copy');
// This formatter is intentionally pure. Evaluate only its body, not the ambient-I/O sidecar.
const formatRunHolderAge = match ? Function('ageMs', match[1]) : () => null;
A.eq(formatRunHolderAge(0), 'just now', '0s is just now');
A.eq(formatRunHolderAge(59000), 'just now', '59s is still just now');
A.eq(formatRunHolderAge(60000), '1 min ago', '60s is one minute');
A.eq(formatRunHolderAge(5 * 60000), '5 min ago', 'multi-minute age is truthful');
A.ok(/streamId/.test(src.slice(src.indexOf('runsMeta.set(runId'), src.indexOf('runsMeta.set(runId') + 600)),
  'interactive run metadata retains the holding session id for refusal guidance');

A.report('comms-busy-age.test');
