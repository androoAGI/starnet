/* sidecar/durable-write.js — writeFileDurable({ fs, path, randomTmpId?, mode? }, file, data) is persist.writeAtomic:
   temp <file>.<pid>.<nonce>.tmp (0o600), short-write loop, fsync before rename, best-effort directory fsync, no temp
   left by a failed write, and the per-file temp sweeper. The contract and its history live in sidecar/persist/write.js;
   this name stays so every importer (cron, connector vault, transcripts, checkpoints, the stores) is unchanged. */
'use strict';
module.exports = { writeFileDurable: require('./persist/write.js').writeAtomic };
