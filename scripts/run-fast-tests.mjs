#!/usr/bin/env node
/* Compatibility entry point for the canonical fast gate. The generic manifest runner also owns test/http.list,
   so list parsing, filtering, process isolation, failure reporting, and exit propagation cannot drift.
   Options are the runner's (--shard=K/N, --timings=<file>); every other argument is a substring filter. */
import { parseArgs, runList } from './run-test-list.mjs';

let parsed;
try { parsed = parseArgs(['test/fast.list'].concat(process.argv.slice(2))); }
catch (error) { console.error(error.message); process.exit(1); }
process.exit(await runList(Object.assign(parsed, { label: 'run-fast-tests' })));
