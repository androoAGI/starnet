/* node test/composer-paste-limit.test.js — the COMMS composer must accept genuinely large pasted prompts.

   The old HTML maxlength stopped input at 4,000 characters before the send path or sidecar ever saw it.
   Keep the DOM ceiling and chat.js's truthful counter in lockstep, with a high enough limit for large
   documents while retaining a bounded request. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const CtxGauge = require('../frontend/app/ctxgauge.js');

const textarea = /<textarea\s+id="chat-input"[^>]*>/i.exec(html);
A.ok(textarea, 'COMMS still renders the chat textarea');
const htmlMax = textarea && /\bmaxlength="(\d+)"/i.exec(textarea[0]);
A.ok(htmlMax, 'the composer retains an explicit bounded maxlength');
A.eq(Number(htmlMax && htmlMax[1]), 100000, 'the composer accepts a 100,000-character paste');

const limits = /const COMPOSER_MAX = (\d+), COMPOSER_WARN_AT = (\d+), COMPOSER_WARN_CHARS = (\d+);/.exec(chat);
A.ok(limits, 'chat.js declares the composer counter limits together');
A.eq(Number(limits && limits[1]), Number(htmlMax && htmlMax[1]), 'the visible counter uses the real DOM ceiling');
A.eq(Number(limits && limits[2]), 90000, 'the counter stays quiet until a paste is near the enlarged cap');
A.eq(Number(limits && limits[3]), 1000, 'the warning state covers the final 1,000 characters');
A.ok(/n >= COMPOSER_MAX - COMPOSER_WARN_CHARS/.test(chat), 'the warning state derives from the declared ceiling');

function extract(name) {
  const body = A.fnBody(chat, '  function ' + name + '(');
  A.ok(body, 'chat.js still defines ' + name + '()');
  return body;
}
const helpers = new Function('CtxGauge', 'HistoryFit',
  'const HISTORY_WIRE_MAX_BYTES = 1 << 20;\n' +
  extract('utf8Bytes') + '\n' + extract('fitHistoryBytes') + '\n' + extract('contextEstimateMessages') + '\n' + extract('fitHistoryTokens') + '\n' + extract('contextIssueFor') + '\n' +
  'return { utf8Bytes, fitHistoryBytes, fitHistoryTokens, contextIssueFor };')(CtxGauge, require('../frontend/app/historyfit.js'));

A.eq(helpers.utf8Bytes('A😀é'), 7, 'wire accounting measures real UTF-8 bytes, including surrogate pairs');
const old = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) + 'x'.repeat(120000) }));
const newest = { role: 'user', content: 'Z'.repeat(100000) };
const fitted = helpers.fitHistoryBytes(old.concat([newest]), 1 << 20);
A.eq(fitted[fitted.length - 1].content.length, 100000, 'the newest 100K paste is preserved byte-for-byte');
A.ok(helpers.utf8Bytes(JSON.stringify(fitted)) <= (1 << 20), 'older wire history yields before the 1 MiB dialogue budget');
A.ok(fitted.length < old.length + 1, 'repeated giant turns are actually removed from the outbound window');
const tokenFitted = helpers.fitHistoryTokens(old.concat([newest]), 60000);
A.eq(tokenFitted[tokenFitted.length - 1].content.length, 100000, 'model fitting also preserves the newest 100K paste');
A.ok(CtxGauge.estimateMessages(tokenFitted) <= 60000, 'older turns yield before the model dialogue budget');

A.eq(helpers.contextIssueFor([newest], 128000, 0), null, 'a 100K English paste fits a cold 128K-context model conservatively');
A.ok(helpers.contextIssueFor([newest], 32000, 0), 'the same paste is blocked before overflowing a cold 32K-context model');
A.ok(helpers.contextIssueFor([{ role: 'user', content: '😀'.repeat(50000) }], 128000, 0), 'dense Unicode is not undercounted as if it were English text');
A.ok(helpers.contextIssueFor([{ role: 'user', content: '😀'.repeat(50000) }], 128000, 30000), 'a prior char/4 calibration cannot suppress the Unicode safety check');
A.ok(helpers.contextIssueFor([newest], 128000, 116000), 'an honest calibrated projection blocks at 90% occupancy');
A.eq(helpers.contextIssueFor([newest], 0, 0), null, 'an unknown catalog never fabricates a model ceiling');

A.report('composer-paste-limit.test');
