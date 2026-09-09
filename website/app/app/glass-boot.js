/* The body ships with glass before first paint. Honor the fallback before app initialization;
   ?glass=0 remains an explicit diagnostic fallback without rewriting saved preferences. */
(() => {
  'use strict';
  document.body.classList.toggle('glass-demo', new URLSearchParams(location.search).get('glass') !== '0');
})();
