'use strict';
// In-memory persistence fixture with append-owned row identities, matching the real transcript IO contract.
function makeMemoryTranscriptIo() {
  const rows = [];
  return {
    readAll: () => rows.map(row => Object.assign({}, row)),
    append: input => {
      const row = Object.assign({}, input, { rowId: rows.length + 1 });
      rows.push(row);
      return Object.assign({}, row);
    }
  };
}
module.exports = { makeMemoryTranscriptIo };
