/* Static portrait thumbnails. Crop transparent master padding once per sprite set,
   reuse the same result across crew and COMMS, and never touch the world sprite. */
'use strict';
const AgentPortraits = (() => {
  const cache = new Map();
  function crop(set) {
    if (cache.has(set)) return cache.get(set);
    const promise = new Promise(resolve => {
      const source = new Image();
      source.onload = () => {
        const cv = document.createElement('canvas'); cv.width = source.naturalWidth; cv.height = source.naturalHeight;
        const ctx = cv.getContext('2d'); ctx.drawImage(source, 0, 0);
        const pixels = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let left = cv.width, top = cv.height, right = -1, bottom = -1;
        for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
          if (pixels[(y * cv.width + x) * 4 + 3] <= 16) continue;
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        if (right < left) { resolve(null); return; }
        const out = document.createElement('canvas'); out.width = right - left + 1; out.height = bottom - top + 1;
        out.getContext('2d').drawImage(cv, left, top, out.width, out.height, 0, 0, out.width, out.height);
        resolve(out.toDataURL());
      };
      source.onerror = () => { cache.delete(set); resolve(null); };
      source.src = 'assets/sprites/' + set + '/rot_south.png';
    });
    cache.set(set, promise); return promise;
  }
  function paint(img, agent) {
    if (!img) return;
    const skins = typeof DATA !== 'undefined' ? DATA.SKINS : null;
    const skin = agent && skins && ((agent.id === 'ULTRON' && skins.ultron) || skins[agent.skin] || skins[DATA.DEFAULT_SKIN]);
    const set = skin && skin.set;
    if (!set) { delete img.dataset.portraitSet; img.hidden = true; return; }
    if (img.dataset.portraitSet === set) return;
    img.dataset.portraitSet = set; img.hidden = true;
    crop(set).then(src => {
      if (img.dataset.portraitSet !== set || !img.isConnected) return;
      if (src) { img.src = src; img.hidden = false; }
      else delete img.dataset.portraitSet;
    });
  }
  return { paint };
})();
