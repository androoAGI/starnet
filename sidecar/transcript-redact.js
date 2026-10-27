/* sidecar/transcript-redact.js — POST /api/transcript/redact { texts: [string, ...] } -> { texts }

   THE DESK'S COPY, REDACTED THE WAY THE STATION REDACTS (reliability wave 1, quick win 18, 2026-10-27).
   The desk save holds every turn as it was typed. The transcript store redacts each row as it writes it
   (transcriptstore.js buildEntry), and the phone redacts the desk copy before it merges the two
   (remote/host.js mergedTurns). The desk's own read-back (frontend/app/chat.js reconcileServerHistory) merged
   its RAW copy against the redacted rows, so a turn holding a secret-shaped token never keyed equal: it showed
   twice and its raw copy stayed in the save beside the station's redacted one. COMMS now posts its copy's turn
   texts here before that merge, and each comes back through the SAME redact() the transcript store and the phone
   use (index.js injects it). The page has no redaction of its own and must never guess one.

   Returns only what it was sent, minus secrets, in the same order; never a stored value. A redact() that throws
   answers 500: the raw text is never passed back as if it were redacted. Pure over its injected deps (no fs, no
   stores), so the test drives it without booting a sidecar. */
'use strict';

const MAX_TEXTS = 500;        // a desk copy keeps at most ~120 turns (chat.js HISTORY_CAP)
const MAX_BODY = 8 << 20;     // …and a long paste is a few hundred KB; past this readBody answers 413

// each text through redact, in order. Throws when redact throws (the route turns that into a 500).
function redactTexts(texts, redact) {
  return texts.map(t => String(redact(t)));
}

function makeTranscriptRedactRoute(deps) {
  const redact = deps && deps.redact, readBody = deps && deps.readBody, json = deps && deps.json;
  if (typeof redact !== 'function' || typeof readBody !== 'function' || typeof json !== 'function') throw new Error('transcript-redact: redact, readBody and json are required');
  return async function handleTranscriptRedact(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req, MAX_BODY, res)) || {}; } catch (_) { return json(res, 400, { error: 'bad json' }); }   // json no-ops after readBody's own 413
    const texts = body.texts;
    if (!Array.isArray(texts) || texts.length > MAX_TEXTS || texts.some(t => typeof t !== 'string')) return json(res, 400, { error: 'texts must be an array of at most ' + MAX_TEXTS + ' strings' });
    let out;
    try { out = redactTexts(texts, redact); } catch (_) { return json(res, 500, { error: 'redaction failed' }); }   // never echo the error: it may quote the text
    return json(res, 200, { texts: out });
  };
}

module.exports = { makeTranscriptRedactRoute, redactTexts, MAX_TEXTS, MAX_BODY };
