/* Execute one tool call with the only automatic tool retry Agent OS permits:
 * a bounded repeat of a host-defined read after a clearly transient failure. Mutation and connector calls
 * always return their first result because a missing response cannot prove the effect did not happen. */
'use strict';

const RecoveryPolicy = require('./recovery-policy.js');

async function wait(delayMs, signal, sleep) {
  if (signal && signal.aborted) return false;
  if (typeof sleep === 'function') await sleep(delayMs);
  else await new Promise(resolve => setTimeout(resolve, delayMs));
  return !(signal && signal.aborted);
}

async function recoverToolResult(options) {
  const o = options || {};
  if (typeof o.dispatch !== 'function') throw new Error('recoverToolResult requires dispatch');
  const policy = typeof o.policy === 'function' ? o.policy : RecoveryPolicy.toolFailure;
  const maxRetries = Math.max(0, Number.isFinite(Number(o.maxRetries)) ? Number(o.maxRetries) : 1);
  let retriesUsed = 0;
  let result = o.result;
  while (true) {
    const decision = policy({
      tool: o.tool, result, retriesUsed, maxRetries,
      cancelled: !!(o.signal && o.signal.aborted)
    });
    if (!decision || decision.action !== 'retry') return result;
    retriesUsed++;
    if (typeof o.onRecovery === 'function') {
      o.onRecovery({
        stage: 'tool_dispatch', action: 'retry', reason: decision.reason,
        attempt: retriesUsed, model: '', delayMs: decision.delayMs
      });
    }
    if (!(await wait(decision.delayMs, o.signal, o.sleep))) return result;
    result = await o.dispatch(o.call, o.ctx);
  }
}

module.exports = { recoverToolResult };
