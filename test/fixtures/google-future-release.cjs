'use strict';
// Test-only module injection keeps future Google protocol coverage exercised.
// Product code has no environment or UI switch around the release deferral.
require('../../sidecar/mcp/google-client.js').RELEASE_DEFERRED = false;
