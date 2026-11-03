'use strict';
/* A real canonical history owner for hand-built channel fixtures. Storage/visibility/import logic is
   production code; only its durable transcript IO and optional clock/observer are supplied by the test. */
const crypto = require('node:crypto');
const Port = require('../../sidecar/channels/history-port.js');
const { makeTranscriptStore } = require('../../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../../sidecar/transcript-history.js');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function make(legacyStore, options) {
  const o = options || {}, now = o.now || (() => 100), io = o.io || makeMemoryTranscriptIo();
  const transcript = o.transcript || makeTranscriptStore({ io, hash, clock: { now } });
  let sequence = 0;
  const history = Port.make({ legacyStore, hash, now, newId: o.newId || (() => 'fixture' + (++sequence)),
    view: (name, stream, opts) => { if (typeof o.onView === 'function') o.onView(name, stream, opts); return transcript.view(name, stream, opts); },
    append: transcript.appendStrict, cacheRetractions: transcript.cacheRetractions, outcomeOf: o.outcomeOf,
    failNote: o.failNote, deletedAt: o.deletedAt, redact: o.redact,
    writeDelivery: fields => require('../../sidecar/turn-delivery.js').write(transcript, fields) });
  return { history, transcript, io };
}
module.exports = { make };
