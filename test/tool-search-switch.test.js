'use strict';
/* The tool-search kill switch answers to its STARNET_ name. Both projection sites read it through index.js's ENV()
   (STARNET_TOOL_SEARCH, else the older SKYNET_TOOL_SEARCH), never process.env.SKYNET_TOOL_SEARCH alone, which left
   STARNET_TOOL_SEARCH=0 doing nothing. */
const A = require('./_assert');
const H = require('./helpers/source.js');
const src = H.readSidecarIndex();

const reads = src.match(/const deferralOff = [^\n]*/g) || [];
A.eq(reads.length, 2, 'two projection sites decide the deferral kill switch');
for (const line of reads) A.ok(/String\(ENV\('TOOL_SEARCH'\) \|\| ''\)\.trim\(\) === '0'/.test(line), 'each reads it through ENV(): ' + line.slice(0, 90));
A.ok(!/process\.env\s*&&\s*process\.env\.SKYNET_TOOL_SEARCH|process\.env\.SKYNET_TOOL_SEARCH/.test(src), 'no site reads the old name straight off process.env');

// ENV() itself: the STARNET_ name wins, the SKYNET_ name still works alone
const envFn = /function ENV\(suffix\) \{[^\n]*\}/.exec(src);
A.ok(envFn, 'index.js defines ENV()');
const ENV = (env) => new Function('process', envFn[0] + '; return ENV;')({ env });
A.eq(ENV({ STARNET_TOOL_SEARCH: '0' })('TOOL_SEARCH'), '0', 'STARNET_TOOL_SEARCH=0 reaches the switch');
A.eq(ENV({ SKYNET_TOOL_SEARCH: '0' })('TOOL_SEARCH'), '0', 'the older SKYNET_TOOL_SEARCH=0 still does');
A.eq(ENV({ STARNET_TOOL_SEARCH: '1', SKYNET_TOOL_SEARCH: '0' })('TOOL_SEARCH'), '1', 'the STARNET_ name wins when both are set');
A.report('tool-search-switch');
