/* sidecar/routing/saved-hold.js — WHAT A HELD SAVED FLOOR IS CALLED, and the one sentence that says it.

   The saved floor routes (routing/saved-authority.js). When it cannot be proved right now, nothing may be routed from it, and
   the person is told so in the words below, wherever the refusal shows: a chat reply, a routine's blocked row, Run Now's 409, a
   line's stop. A leaf with no dependency, so the router, the authority, the chain runner and the hub can all use it.

     HOLD_STATUSES  the statuses of a floor that cannot be proved: absent (a primary gone beside a copy), corrupt, unreadable,
                    unavailable, unstamped, invalid, future, migration-required, unvouched, unsupported-geometry, changed.
                    NOT unfloored (a new install: nothing to route) and NOT unroutable (a proved floor the compiler refuses).
     heldWhy(s)     'the saved floor is <plain words>; routing is held until it is readable'. A hold the person can end says the step
                    inside the plain words, in brackets, so every refusal that reads the sentence carries it: migration-required
                    (open StarNet once: the page migrates the save) and future (update StarNet). The sentence keeps its one grammar;
                    test/routing.saved-seams.test.js section 11 holds every status to it.
     holdOf(error)  { status, why } for an error the router or the authority threw for a held floor, else null */
'use strict';

const WORDS = Object.freeze({
  absent: 'missing', corrupt: 'corrupt', unreadable: 'unreadable', unavailable: 'unavailable', unstamped: 'not stamped',
  invalid: 'invalid', future: 'from a newer StarNet (update StarNet to read it)',
  'migration-required': 'waiting for a migration (open StarNet once to bring it up to date)', unvouched: 'not vouched for',
  'unsupported-geometry': 'in a layout this version cannot route', changed: 'still being saved'
});
const HOLD_STATUSES = Object.freeze(Object.keys(WORDS));

const wordsOf = status => (Object.prototype.hasOwnProperty.call(WORDS, status) ? WORDS[status] : 'unreadable');
function heldWhy(status) { return 'the saved floor is ' + wordsOf(String(status)) + '; routing is held until it is readable'; }

// an error carries .held === true only when it was made for a held floor (router.js savedFailure, saved-authority.js RoutingHeld)
function holdOf(error) {
  if (!error || error.held !== true) return null;
  const status = typeof error.status === 'string' ? error.status : 'unreadable';
  return { status, why: typeof error.why === 'string' && error.why ? error.why : heldWhy(status) };
}

module.exports = { HOLD_STATUSES, heldWhy, holdOf };
