/* sidecar/persist/names.js — the ONE grammar for the files persist keeps beside a store file.

     <file>                    the store of record
     <file>.bak                its last-known-good copy (a hard link to, or a copy of, the previous committed main)
     <file>.<pid>.<nonce>.tmp  a writeAtomic temp: the writer's pid and a random nonce ([A-Za-z0-9_-], hex by default)
     <file>.<label>-<n>        a forensic copy at the first free n from 1. label 'corrupt': bad bytes moved aside or
                               kept before a replace; label 'unseen': bytes this process never read, kept before a blind
                               replace. A bad .bak is kept as <file>.bak.<label>-<n>.

   Legacy shapes are still recognised and never produced again:
     temps     <file>.<n>.tmp (savestore, channels/store), <file>.tmp-<pid>-<now>-<seq> (workspace-recovery),
               <file>.repair-<hex> (run-journal repair)
     forensic  <file>.corrupt (run-journal, deliverables), <file>.corrupt-<pid>-<seq> (index.js quarantineCorrupt)
   Legacy copies are kept: never renamed, never swept, and first-free numbering steps over them (a legacy name is never
   <file>.corrupt-<n> with a single number, so it never collides).

   Run-journal damage-evidence copies (<journal>.corrupt-r<hex>, <journal>.torn-r<hex>) are NOT forensic generations:
   they mark a repaired journal and ride with it, so isForensic() never matches them. The letter keeps a new one from
   ever reading as a numbered quarantine; the base repair wrote a bare 10-hex nonce, and an all-digit one of those
   (<64 hex>.jsonl.corrupt-<10 digits>) is told apart by the run-journal name and the nonce's fixed width.

   Pure string functions, no I/O. */
'use strict';

const LABELS = Object.freeze({ CORRUPT: 'corrupt', UNSEEN: 'unseen' });

// the regex source of a numbered quarantine suffix, for readers that build their own pattern (workspace-lineage)
const QUARANTINE_N_SOURCE = '\\.corrupt-\\d+';

// every temp shape, checked against the name alone: the sweeper keeps only these names from its one readdir
const TEMP_SHAPE = /\.tmp$|\.tmp-\d+-\d+-\d+$|\.repair-[0-9a-f]+$/i;
// the historical broad rule ('.tmp' at the end or before another extension) plus the legacy temp shapes
const BROAD_TEMP = /\.tmp(?:$|\.)/i;
const LEGACY_TEMP_ANY = /\.tmp-\d+-\d+-\d+$|\.repair-[0-9a-f]+$/i;
const FORENSIC = /\.(?:corrupt(?:-\d+(?:-\d+)?)?|unseen-\d+)$/i;
const BACKUP = /\.bak$/i;
// a run journal's damage evidence, persist's (r<hex>) or the base repair's (a bare 10-hex nonce)
const JOURNAL_EVIDENCE = /(?:^|[\\/])[0-9a-f]{64}\.jsonl\.(?:corrupt|torn)-(?:r[0-9a-f]+|[0-9a-f]{10})$/i;

const OWN_TAIL = /^(\d+)\.([A-Za-z0-9_-]+)\.tmp$/;
const LEGACY_TAILS = [/^\d+\.tmp$/, /^tmp-\d+-\d+-\d+$/, /^repair-[0-9a-f]+$/i];

// the temp writeAtomic opens for <file>
function tempFor(file, pid, nonce) { return String(file) + '.' + pid + '.' + nonce + '.tmp'; }
// the forensic copy name for <file> under label at number n
function forensicName(file, label, n) { return String(file) + '.' + label + '-' + n; }
// a run journal's damage-evidence copy: kind 'torn' (only the final record was cut off) or anything else 'corrupt'
function evidenceFor(journal, kind, hex) { return String(journal) + (kind === 'torn' ? '.torn-r' : '.corrupt-r') + hex; }

/* what a directory entry is to the store file named base (both bare names, no directory):
   { kind: 'own', pid, nonce } | { kind: 'legacy' } | null. Exact: another file's temps (the .bak's included) are null. */
function tempOf(base, name) {
  const b = String(base) + '.';
  const n = String(name);
  if (n.length <= b.length || n.slice(0, b.length) !== b) return null;
  const tail = n.slice(b.length);
  const own = OWN_TAIL.exec(tail);
  if (own) return { kind: 'own', pid: Number(own[1]), nonce: own[2] };
  for (const re of LEGACY_TAILS) if (re.test(tail)) return { kind: 'legacy' };
  return null;
}
// strict: a temp writeAtomic itself made for base (what the sweeper checks pid liveness on)
function isOwnTemp(base, name) { const t = tempOf(base, name); return !!t && t.kind === 'own'; }
// any temp of exactly base, own or legacy
function isTempOf(base, name) { return tempOf(base, name) !== null; }
// any temp-shaped name, for the store-guarded classifiers (station-recovery, workspace-lineage)
function isTemp(name) { const n = String(name); return BROAD_TEMP.test(n) || LEGACY_TEMP_ANY.test(n); }
function isBackup(name) { return BACKUP.test(String(name)); }
function isJournalEvidence(name) { return JOURNAL_EVIDENCE.test(String(name)); }
function isForensic(name) { const n = String(name); return FORENSIC.test(n) && !JOURNAL_EVIDENCE.test(n); }

module.exports = {
  LABELS, QUARANTINE_N_SOURCE, TEMP_SHAPE,
  tempFor, forensicName, evidenceFor, tempOf, isOwnTemp, isTempOf, isTemp, isBackup, isJournalEvidence, isForensic
};
