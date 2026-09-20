'use strict';
require('./google-signin-preload.cjs');
// Exercise the shipping split, not the future broad-Workspace override.
require('../../sidecar/mcp/google-client.js').RELEASE_DEFERRED = true;
