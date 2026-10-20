'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ColonyLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function digest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  function canAdopt({ beforeDigest, localDigest, targetDigest, busy, commitId, targetCommitId }) {
    return !busy && commitId !== targetCommitId && (localDigest === beforeDigest || localDigest === targetDigest);
  }
  return { stable, digest, canAdopt };
});
