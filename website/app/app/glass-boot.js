/* Set the station material before any interface content is parsed. Glass is the default;
   ?glass=0 remains an explicit diagnostic fallback without rewriting saved preferences. */
(() => {
  'use strict';
  document.body.classList.toggle('glass-demo', new URLSearchParams(location.search).get('glass') !== '0');
})();
