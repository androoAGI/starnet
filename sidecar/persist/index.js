/* sidecar/persist — the ONE owner of how a store file is written, read, kept aside and named.

   Four primitives and a grammar; every store keeps its own API and record format and calls them:
     writeAtomic(deps, file, data)            write.js     temp + fsync + rename, no temp left by a failure, the sweeper
     readTagged(deps, file, { text }?)        read.js      ok | recovered | absent | corrupt | unreadable, the unread mark
                                                           (text: one file read as text, for an append journal)
     moveAside / preserve(deps, file, label)  quarantine.js first-free <file>.<label>-<n>, honest on failure
     copyExclusive(fs, from, to)             quarantine.js owned evidence copy: true | 'taken' | { ok:false, error }
     replaceJson(deps, file, value, opts)     replace.js   the last-known-good replace (D1, D2)
     names                                    names.js     the sibling-file grammar every reader classifies with

   host({ fs, path, writeDurable }) -> { quarantineCorrupt, readResilient, loadResilient, saveResilient } is the composition index.js
   binds for its full-state stores (channel secrets, connector service keys, OAuth tokens, allowlist, dossier, ...) and
   hands to its general stores as onCorrupt. Moved from index.js, with three changes: a quarantine is the first free
   <file>.corrupt-<n> through moveAside (index.js named copies <file>.corrupt-<pid>-<seq> and renamed over a reused pid's
   earlier copy); the ONE READ POLICY (a present-but-bad main is moved aside even when a good .bak recovers it, and a bad
   .bak too when the main is also bad); and an unreadable load is noted (failNote 'persist.load.unreadable') instead of
   silent, and marks the file so the next blind save keeps its bytes (D2). */
'use strict';

const names = require('./names.js');
const write = require('./write.js');
const read = require('./read.js');
const quarantine = require('./quarantine.js');
const replace = require('./replace.js');
const { note: failNote } = require('../failopen.js');

function host(deps) {
  const fs = deps && deps.fs;
  const pathMod = deps && deps.path;
  const writeDurable = deps && deps.writeDurable;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('persist.host: an injected fs is required');
  if (typeof writeDurable !== 'function') throw new Error('persist.host: writeDurable is required (the host passes its update-frozen writer)');
  const tagOf = tag => '[' + (tag || 'store') + '] ';

  // move bad bytes aside to the first free <file>.corrupt-<n>; the destination, or null when they could not be moved
  function quarantineCorrupt(file, tag) {
    const moved = quarantine.moveAside({ fs: fs }, file, names.LABELS.CORRUPT);
    if (moved.ok) {
      console.error(tagOf(tag) + 'bad store bytes ' + file + ' moved aside to ' + moved.to + ' (kept, never silently wiped); the store continues from its .bak, or empty.');
      return moved.to;
    }
    if (!moved.absent) console.error(tagOf(tag) + 'bad store bytes ' + file + ' could not be moved aside (' + ((moved.error && (moved.error.code || moved.error.message)) || 'unknown') + '); left in place, and the next save keeps them before replacing.');
    return null;
  }
  // Read with full status so credential reconciliation can distinguish unreadable from absent.
  function readResilient(file, tag) {
    const r = read.readTagged({ fs: fs }, file);
    if (r.status === 'recovered') {
      console.warn(tagOf(tag) + 'recovered ' + file + ' from .bak last-known-good after a torn/corrupt main.');
      if (read.isBad(r.main)) quarantineCorrupt(file, tag);
    } else if (r.status === 'corrupt') {
      for (const bad of read.badCopies(file, r)) quarantineCorrupt(bad, tag);
    } else if (r.status === 'unreadable') {
      failNote('persist.load.unreadable', r.err || new Error('store unreadable: ' + (r.problemFile || file)));
    }
    return r;
  }
  // Value-only compatibility for full-state consumers. Read/quarantine policy remains shared.
  function loadResilient(file, tag) {
    const r = readResilient(file, tag);
    return (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined;
  }
  // durable single-file write: the last-known-good replace through the host's writer
  function saveResilient(file, value) {
    replace.replaceJson({ fs: fs, path: pathMod, writeDurable: writeDurable }, file, value);
  }
  return { quarantineCorrupt, readResilient, loadResilient, saveResilient };
}

// test-only: a fresh process (the sweep memos and the unread mark are per process)
function _resetForTests() {
  write._resetForTests();
  read._resetForTests();
}

module.exports = {
  names,
  writeAtomic: write.writeAtomic,
  sweep: write.sweep,
  readTagged: read.readTagged,
  readOne: read.readOne,
  badCopies: read.badCopies,
  isBad: read.isBad,
  isUnread: read.isUnread,
  moveAside: quarantine.moveAside,
  preserve: quarantine.preserve,
  copyExclusive: quarantine.copyExclusive,
  replaceJson: replace.replaceJson,
  host,
  STALE_MS: write.STALE_MS,
  _resetForTests
};
