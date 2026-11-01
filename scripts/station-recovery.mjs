#!/usr/bin/env node
// A source checkout's way in to the recovery CLI. The CLI itself lives in bin/ because bin/ ships inside the desktop app.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../bin/station-recovery.js').main(process.argv.slice(2));
