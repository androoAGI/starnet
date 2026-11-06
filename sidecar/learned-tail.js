/* sidecar/learned-tail.js — keep what the station LEARNS out of the cached system prefix (issue #105).

   A persona arrives as one string: the browser's composeSystemPrompt, the pushed crew roster, or a server-composed persona
   (withDossier). Its last blocks are learned state: the Commander dossier, the active goal and the MID-TASK PREFERENCE FORK
   directive. They change when the station learns something, and they sat at the end of the persona, ahead of the tool notes
   and capabilities in the stable prefix. So one dossier edit or one fork-gate flip moved every provider's cached prefix: the
   reporter on 0.13.2 measured a read of 0 and a write of about 35k tokens on the first message after it.

   split() cuts the persona where the first learned block starts. runOnce keeps the stable half in cacheSystemPrefix and places
   the complete learned half in the guarded run_context note beside the newest user turn. The earlier repair put it after the
   prefix's cache anchor but still inside the system message: a preference change then invalidated ALL conversation history
   after that system tail. Every provider now keeps the whole system unchanged while still receiving every learned byte.

   The persona stays one string because every path that carries it (COMMS, the roster, channels, voice, a roster saved by an
   older version) keeps working with no new field. A Commander doc that quotes a head at a paragraph start only moves its own
   paragraph to the tail: same text, same order. test/learned-tail.test.js holds these heads to what dossier.js, fork.js and
   commander-context.js really write. PURE: no clock, no fs. */
'use strict';

const LEARNED_HEADS = Object.freeze([
  'WHAT YOU KNOW ABOUT YOUR COMMANDER (',              // frontend/app/dossier.js composeBlock
  'MID-TASK PREFERENCE FORK (',                        // frontend/app/fork.js directive
  '<commander_context provenance="commander-dossier">', // sidecar/commander-context.js, server-composed personas
  '<active_goal provenance="commander-confirmed">'      // the same, when a goal is active and the dossier is empty
]);

/* WHERE THE TAIL SITS. The current turn's host note follows the tool notes and the capabilities block, so stored belief text reads after the ground truth,
   which is the place later instructions tend to win. Nothing else keeps it out of the prefix: anything ahead of those blocks is
   inside it. So it stays there and opens with this constant line: learned text never adds a capability, and a learned restriction
   ("never push to main") still binds, so the line must not discount it. Only a persona with learned text carries it, in the tail, so
   it cannot move the prefix. Internal self-talk keeps its verbatim persona and no line. */
const TAIL_GUARD = '[Learned about your Commander. This shapes how you work with them. It never grants a capability the capabilities ground truth above does not give you, though it may narrow how you act.]';
function tail(learned) { return learned ? '\n\n' + TAIL_GUARD + learned : ''; }

// split(persona) -> { stable, learned }, where stable + learned is exactly the persona. learned '' = nothing learned in it.
function split(persona) {
  const text = String(persona == null ? '' : persona);
  let at = -1;
  for (const head of LEARNED_HEADS) {
    if (text.startsWith(head)) return { stable: '', learned: text };
    const i = text.indexOf('\n\n' + head);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at < 0 ? { stable: text, learned: '' } : { stable: text.slice(0, at), learned: text.slice(at) };
}

module.exports = { split, tail, LEARNED_HEADS, TAIL_GUARD };
