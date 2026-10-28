'use strict';
/* sidecar/route-prefix.js — how a prefix entry of index.js's ROUTES table matches a request URL.

   Prefix routes are route families, not arbitrary string aliases. A route whose declared prefix already ends in '/'
   owns every child below it; otherwise the next byte must be a real URL boundary ('', '?' or '/'), so
   '/api/save' answers '/api/save?x' and '/api/save/conflicts' but never '/api/savefoo'.

   Pure: no I/O. dispatchRoute (sidecar/index.js) calls it for every `prefix` and `qprefix` route. */
function routePrefixMatches(url, prefix) {
  if (url.indexOf(prefix) !== 0) return false;
  if (prefix.charAt(prefix.length - 1) === '/') return true;
  const next = url.charAt(prefix.length);
  return next === '' || next === '?' || next === '/';
}

module.exports = { routePrefixMatches };
