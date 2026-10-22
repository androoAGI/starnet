/* AGENT OS — skinstage.js : a shared LIVE skin preview.
   A 40px still of a chunky pixel sprite is unreadable, so wherever a player picks a skin
   (the create screen, the recruitment bay, the agent dossier's CONFIG › SKIN) a STAGE plays
   that skin's real south-facing walk cycle, big. Frames come straight from the sprite manifest
   — the same art the floor engine walks — with a rot_south fallback for sets lacking a walk
   cycle, so the demo never lies.

   MULTI-STAGE: more than one picker can be on screen at once (the dossier window stays open
   behind the Recruitment Bay modal), so each mount owns its OWN frame list + cycle index and
   mount() hands back a per-stage handle. One rAF loop drives them all, self-throttled to idle
   while a stage's <img> is off-screen, and stages whose <img> left the DOM (every dossier
   re-render replaces it) are dropped so a rebuilt panel never leaks a dead entry. */
'use strict';

const SkinStage = (() => {
  let manifest = null;          // cached sprite manifest (frame lists keyed "<set>.<state>.<dir>")
  let stages = [];              // live stages: { img, name, frames, ix, last }
  let current = null;           // the most recent mount — the target of the module-level show()
  let looping = false;

  // the frames to play for a set: prefer the south-facing walk cycle, fall back to the idle
  // rotation, then the bare still — straight from the manifest, so the demo matches the floor.
  function frameList(set) {
    const m = manifest && manifest.sprites;
    const walk = m && m[set + '.walk.south'];
    const rot  = m && m[set + '.rot.south'];
    const list = (walk && walk.length) ? walk : ((rot && rot.length) ? rot : [set + '/rot_south.png']);
    return list.map(p => 'assets/sprites/' + p);
  }

  // put a skin on ONE stage: preload its frames, reset the cycle, update the name label
  function showOn(st, id) {
    const sk = (typeof DATA !== 'undefined' && DATA.SKINS) ? DATA.SKINS[id] : null;
    if (!st || !sk) return;
    st.ix = 0;
    st.frames = frameList(sk.set).map(src => { const im = new Image(); im.src = src; return im; });
    if (st.name) st.name.textContent = sk.name || id;
    if (st.img && st.frames[0]) st.img.src = st.frames[0].src;
  }

  // ~8fps walk on every mounted stage, but only while that stage's <img> is actually on screen
  // (offsetParent === null when hidden), so a closed panel/modal costs nothing.
  function tick(now) {
    if (stages.length) {
      // drop stages whose <img> was removed by a panel rebuild before advancing the survivors
      const live = [];
      for (const st of stages) {
        if (!st.img || !st.img.isConnected) continue;
        live.push(st);
        if (st.img.offsetParent && st.frames.length > 1 && now - st.last > 120) {
          st.last = now;
          st.ix = (st.ix + 1) % st.frames.length;
          const f = st.frames[st.ix];
          if (f && f.complete) st.img.src = f.src;
        }
      }
      if (live.length !== stages.length) {
        stages = live;
        if (current && stages.indexOf(current) === -1) current = stages[stages.length - 1] || null;
      }
    }
    requestAnimationFrame(tick);
  }

  // bind a stage's <img> + name element, show an initial skin, and start the loop once. Loads
  // the manifest on first use, then reuses it. Returns a handle whose show() drives THIS stage
  // (use it — the module-level show() targets whichever stage mounted last). Re-mounting the same
  // <img> reuses its entry rather than stacking duplicates.
  function mount(img, name, id) {
    if (!img) return { show: () => {} };
    let st = stages.find(s => s.img === img);
    if (!st) { st = { img, name: name || null, frames: [], ix: 0, last: 0 }; stages.push(st); }
    else st.name = name || null;
    current = st;
    const start = () => {
      showOn(st, id);
      if (!looping) { looping = true; requestAnimationFrame(tick); }
    };
    if (manifest) start();
    else fetch('assets/sprites/manifest.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => { manifest = j; start(); })
      .catch(() => { manifest = { sprites: {} }; start(); });
    return { show: (nextId) => showOn(st, nextId) };
  }

  // legacy module-level show(): drives the stage that mounted last. Kept for call sites that
  // own the only stage on screen; anything that can share the screen should hold mount()'s handle.
  function show(id) { showOn(current, id); }

  return { mount, show, frameList };
})();
