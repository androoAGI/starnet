'use strict';
const A = require('./_assert.js');
const P = require('../sidecar/recovery-policy.js');

A.eq(P.providerFailure({ classification: { shouldCompress: true, reason: 'context_overflow' }, canCompress: true, recoveriesUsed: 0, maxRecoveries: 1 }),
  { action: 'compress', reason: 'context_overflow', retryable: true, delayMs: 0 }, 'compression is the first recovery path');
A.eq(P.providerFailure({ classification: { shouldFallback: true, reason: 'overloaded' }, hasFallback: true, recoveriesUsed: 0, maxRecoveries: 1 }).action,
  'fallback', 'available fallback outranks same-provider retry');
A.eq(P.providerFailure({ classification: { shouldFallback: true, retryable: true, reason: 'overloaded' }, hasFallback: false, retriesUsed: 0, maxRetries: 6 }).action,
  'retry', 'exhausted fallback chain uses bounded same-provider retry');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'timeout', retryAfterMs: 2500 }, retriesUsed: 1, maxRetries: 6 }).delayMs,
  2500, 'server retry-after outranks the local rung');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'timeout' }, firstByteTimeout: true, hasFallback: true, recoveriesUsed: 0, maxRecoveries: 2 }),
  { action: 'fallback', reason: 'provider_first_byte_timeout', retryable: true, delayMs: 0, rotate: true }, 'a silent first-byte timeout uses the fallback ladder');
A.eq(P.providerFailure({ classification: { retryable: true, reason: 'timeout' }, firstByteTimeout: true, hasFallback: false, recoveriesUsed: 0, maxRecoveries: 0 }),
  { action: 'fail', reason: 'provider_first_byte_timeout', retryable: false, delayMs: 0 }, 'an exhausted silent provider fails instead of retrying forever');
A.eq(P.providerFailure({ classification: { retryable: true }, retriesUsed: 6, maxRetries: 6 }).action,
  'fail', 'retry budget is a hard bound');
A.eq(P.providerFailure({ classification: { retryable: true }, preStreamRetriesExhausted: true, retriesUsed: 0, maxRetries: 6 }).action,
  'fail', 'adapter-exhausted pre-stream ladder is never multiplied');
A.eq(P.providerFailure({ classification: { retryable: true }, cancelled: true }).action,
  'fail', 'cancellation cannot enter recovery');

const transientRead = { provenance: 'host', scope: 'read', readOnly: true };
A.eq(P.toolFailure({ tool: transientRead, result: { isError: true, summary: 'timeout', content: 'timed out' }, retriesUsed: 0, maxRetries: 1 }).action,
  'retry', 'a transient host-defined read is retryable');
A.eq(P.toolFailure({ tool: { provenance: 'host', scope: 'write', readOnly: false }, result: { isError: true, summary: 'timeout' } }).action,
  'fail', 'mutations are never retried automatically');
A.eq(P.toolFailure({ tool: { provenance: 'connector', scope: 'read', readOnly: true }, result: { isError: true, summary: 'timeout' } }).action,
  'fail', 'remote read-only metadata never grants retry authority');
A.eq(P.toolFailure({ tool: transientRead, result: { isError: true, summary: 'error', content: 'invalid arguments' } }).action,
  'fail', 'deterministic read failures are not retried');
A.eq(P.toolFailure({ tool: transientRead, result: { isError: true, summary: 'timeout' }, retriesUsed: 1, maxRetries: 1 }).action,
  'fail', 'tool retry budget is a hard one-attempt bound');
A.report('recovery-policy.test');
