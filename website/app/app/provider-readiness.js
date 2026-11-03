/* A cache of sidecar verdicts, never a second credential resolver. Offline keeps the last answer and
   labels it cached; a local edit invalidates its proof until the station answers for the new pair. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providerReadiness = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function makeCache() {
    let rows = Object.create(null), cached = true, revision = 0;
    const clone = value => JSON.parse(JSON.stringify(value));
    function read(id) {
      return Object.assign({ provider: id, configured: false, unattendedReady: false,
        credential: { present: false, status: 'unknown' }, endpoint: { configured: false, status: 'unknown' },
        lastVerified: null, reason: 'station status unavailable' }, clone(rows[id] || {}), { cached });
    }
    function accept(list, ticket) {
      if (ticket !== revision || !Array.isArray(list)) return false;
      const next = Object.create(null);
      for (const row of list) {
        if (!row || typeof row.id !== 'string' || typeof row.unattendedReady !== 'boolean' || !row.credential || !row.endpoint) return false;
        next[row.id] = clone(row);
      }
      rows = next; cached = false;
      return true;
    }
    function invalidate(id) {
      revision++;
      if (rows[id]) rows[id] = Object.assign({}, rows[id], { configured: false, unattendedReady: false,
        lastVerified: null, credential: Object.assign({}, rows[id].credential, { status: 'unverified' }), reason: 'connection changed; waiting for station' });
      cached = true;
    }
    return { read, accept, invalidate, ticket: () => revision, offline: () => { cached = true; } };
  }
  return { makeCache };
});
