/* sidecar/learned-blocks.js — keep the LEARNED Commander blocks out of the cached system prefix.

   The browser's composeSystemPrompt (frontend/app/app.js) ends every agent persona with two blocks the station
   LEARNS over time: the Commander dossier (DossierStore.composeBlock, frontend/app/dossier.js) and, while the style
   model is unsure, the mid-task preference fork directive (Fork.directive, frontend/app/fork.js). The persona is the
   first thing in the sidecar's cacheSystemPrefix, so every time either block changes — a new belief, the fork
   gate flipping, or the frontend's init order composing a persona before the dossier has hydrated — the WHOLE
   ~35k-token stable prefix re-bills as a cold cache write.

   splitLearned() lifts exactly those bytes out of the persona so the caller can place them AFTER the cache prefix
   (in the per-run part of the system prompt). Nothing is rewritten: `base + learned` holds exactly the same
   characters, only the learned blocks move to the end, in their original order. Whatever followed a block stays
   in the base at the same spot.

   A block always starts a paragraph ("\n\n" before it, the way composeSystemPrompt appends it). Its END is not
   always a paragraph boundary: on a TASK turn chat.js glues " If this needs real work — …" straight onto the
   persona, so the last learned block is followed by a space, not "\n\n". So:
     - fork: the exact directive text (a constant) at a paragraph start; the tail after it is never inspected.
     - dossier, exact: the block the sidecar holds (POST /api/dossier — dossierstore.js pushes it on init, seed and
       every commit), at a paragraph start, and NOT continued by more dossier text: a following ';' or '…' (another
       belief) or a single "\n" (another "- Lead:" line) means the sidecar copy is a stale prefix and is rejected.
       A belief may itself contain "\n\n" (beliefs are only trimmed); the exact match carries that naturally.
     - dossier, structural fallback (stale or empty sidecar copy): the header line, then each following line joined
       by a single "\n" that starts with "- ". It stops at "\n\n" or at the first line that does not start with
       "- ". Known residual: a tail glued onto the last bullet line (the task hint) moves with it, so a stale copy
       on a fork-off task turn costs one cold write while it stays stale.
   The dossier copy that the evidence pack adds inside a <commander_context> wrapper (cron / remote personas via
   withDossier, or a stale copy) is not at a paragraph start and stays put; the roster persona's own plain dossier
   and fork blocks inside those personas DO move.

   PURE: no clock, randomness, fs or network (lint-determinism.js). Idempotent: splitting `base` again moves nothing. */
'use strict';

const DOSSIER_HEAD = 'WHAT YOU KNOW ABOUT YOUR COMMANDER (the station has learned this — honor it; if anything here is wrong, the Commander will correct it):';
const SEP = '\n\n';

function overlaps(ranges, start, end) {
  return ranges.some(r => start < r.end && r.start < end);
}

// does more dossier text continue right after `end`? (another belief, or another "- Lead:" line)
function dossierContinues(s, end) {
  if (end >= s.length) return false;
  const c = s[end];
  if (c === ';' || c === '…') return true;
  if (c === '\n') return s[end + 1] !== '\n';   // "\n\n" closes the paragraph; a single "\n" is the next line
  return !/\s/.test(c);                          // mid-token: the copy stops inside a word
}

// every paragraph-start occurrence of `text`, as [start, end) ranges over the "\n\n" + text.
function exactBlocks(s, text, ranges, kind, rejectIf) {
  if (!text) return;
  const needle = SEP + text;
  let from = 0;
  while (from <= s.length) {
    const at = s.indexOf(needle, from);
    if (at < 0) return;
    const end = at + needle.length;
    if (!(rejectIf && rejectIf(s, end)) && !overlaps(ranges, at, end)) { ranges.push({ start: at, end, kind }); from = end; }
    else from = at + 1;
  }
}

// every dossier block found by its shape: the header line, then "\n- …" lines.
function structuralDossiers(s, ranges) {
  const needle = SEP + DOSSIER_HEAD;
  let from = 0;
  while (from <= s.length) {
    const at = s.indexOf(needle, from);
    if (at < 0) return;
    let end = at + needle.length;
    while (s.startsWith('\n- ', end)) {
      const nl = s.indexOf('\n', end + 1);
      end = nl < 0 ? s.length : nl;
    }
    if (end > at + needle.length && !overlaps(ranges, at, end)) ranges.push({ start: at, end, kind: 'dossier' });
    from = Math.max(end, at + 1);
  }
}

function splitLearned(system, opts) {
  const o = opts || {};
  const s = system == null ? '' : String(system);
  const moved = { dossier: false, fork: false };
  if (!s) return { base: '', learned: '', moved };
  const ranges = [];
  exactBlocks(s, String(o.forkDirective == null ? '' : o.forkDirective).trim(), ranges, 'fork', null);
  exactBlocks(s, String(o.dossierBlock == null ? '' : o.dossierBlock).trim(), ranges, 'dossier', dossierContinues);
  structuralDossiers(s, ranges);
  if (!ranges.length) return { base: s, learned: '', moved };
  ranges.sort((a, b) => a.start - b.start);
  let base = '', learned = '', at = 0;
  for (const r of ranges) {
    base += s.slice(at, r.start);
    learned += s.slice(r.start, r.end);   // each range already begins with its own "\n\n"
    moved[r.kind] = true;
    at = r.end;
  }
  base += s.slice(at);
  return { base, learned, moved };
}

module.exports = { splitLearned, DOSSIER_HEAD };
