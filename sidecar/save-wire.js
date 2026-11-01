/* sidecar/save-wire.js — what POST /api/save (and /api/save/adopt) answer when a save cannot be taken, by NAME.

   The page's save light and the update drain say why the newest save is not in the station file. They can only be honest
   when the station says which failure it was (10-26 reliability audit, B3 station saves; gh#121, starnet-releases#4):
     • a body over the station file's 16 MiB cap was answered 400 'bad json' — the page called it a failed disk;
     • every failed write was answered 400 with the error text, and the page told the user to "check disk space" for all
       of them, on machines with plenty of disk.
   Now an over-cap body is a 413 that says it is too large, and a failed write carries the errno it failed with. Only ENOSPC
   (the disk is full) and EPERM/EACCES (the folder refused the write) are disk causes; any other failure is named as what it
   was, never as the disk. Pure: no I/O, no host state. */
'use strict';

// Measured long-haul boundary: 5,000 three-turn workstreams serialize to ~8.47 MiB. An explicit 16 MiB ceiling (roughly
// 9,000 at that density) instead of resetting a valid 30-90 day save at the former 8 MiB limit.
const SAVE_BODY_MAX = 16 << 20;

// the 413 a save body over SAVE_BODY_MAX gets (the route answers it; the body is not read past the cap)
function tooLargeReply() {
  return { ok: false, tooLarge: true, limitBytes: SAVE_BODY_MAX,
    error: 'this station save is larger than the 16 MiB the station file takes, so it was not saved' };
}

// ENOSPC: the disk holding the station file is full. EPERM/EACCES: the folder (or the file) refused the write.
const DISK_CODES = { ENOSPC: 'diskFull', EPERM: 'diskDenied', EACCES: 'diskDenied' };

// a failed station-file write, named: { status, body } for the route to answer. An errno failure is the station's own
// (5xx) and carries its code; the cause names the disk only for the codes above. Anything else (a validation throw) stays
// a 400 with its message, as before.
function writeFailureReply(e) {
  const message = String((e && e.message) || 'save failed');
  const code = e && typeof e.code === 'string' && /^E[A-Z0-9]{2,20}$/.test(e.code) ? e.code : null;
  if (!code) return { status: 400, body: { ok: false, error: message } };
  const disk = DISK_CODES[code] || null;
  return { status: 500, body: Object.assign({ ok: false, error: message, code }, disk ? { cause: disk } : {}) };
}

module.exports = { SAVE_BODY_MAX, tooLargeReply, writeFailureReply, DISK_CODES };
