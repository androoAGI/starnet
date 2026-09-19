'use strict';
// Mandatory browser/sidecar lifecycle journey; never silently skips missing Chrome.
import('../scripts/qa/session-reliability.mjs').catch(error => {
  console.error(error); process.exitCode = 1;
});
