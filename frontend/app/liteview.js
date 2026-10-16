/* STARNET — liteview.js : LITE VIEW. The station's picture paused; the harness untouched.

   WHY (Commander 2026-10-15: "i don't really need the videogame gui … freeze it … but all the functionality"):
   measured in a headless Chrome against a real station, the page cost ~1.7 GB in Chrome's GPU process (a blank tab:
   ~190 MB) while its whole JS heap was 16 MB. The weight is the PICTURE — the baked station, its sprite and backdrop
   plates, and the 60fps draw — not the harness. Every working surface (COMMS, the CREW and SESSIONS rails, every dock
   window, approvals, BUILD MODE) is DOM or server work, and routines / Night Shift run in the sidecar.

   LITE VIEW keeps the world MODEL and drops the picture:
     · world.js never enters its draw loop: World.start() only keeps the floor's routing plan posted (a floor edit
       still reaches the sidecar), so the station bake, the sprite plates and the backdrop are never built;
     · the stage shows one quiet panel, and COMMS takes the room;
     · BUILD MODE still opens (it draws its own editor), so the floor stays fully editable.
   Per browser (localStorage), default OFF: nothing changes for anyone who does not ask for it.

   Doors: the LITE key on the station view, SHOW STATION on the paused panel, Ctrl+Shift+L, and ?lite=1 / ?lite=0 on
   the URL (persisted, for a bookmark or a desktop shortcut). Loaded BEFORE world.js: World.start() asks LiteView.on()
   on the very first boot, so a lite station never bakes a frame. */
'use strict';
const LiteView = (() => {
  const KEY = 'starnet.liteView';
  const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; } };
  const write = v => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (_) {} };
  try {
    const q = new URLSearchParams(location.search).get('lite');
    if (q === '1' || q === '0') write(q === '1');
  } catch (_) {}
  let lite = read();

  const el = id => document.getElementById(id);
  function paint() {
    if (!document.body) return;
    document.body.classList.toggle('lite-view', lite);
    const key = el('lite-key');
    if (key) key.setAttribute('aria-pressed', lite ? 'true' : 'false');
  }

  function set(next) {
    next = !!next;
    if (next === lite) return lite;
    lite = next; write(lite); paint();
    try {
      if (typeof World === 'undefined') return lite;
      if (lite) { if (World.releaseView) World.releaseView(); }   // stop drawing AND drop the baked plates now
      else { if (World.refit) World.refit(); if (World.start) World.start(); }   // frame the whole station; the first frame re-bakes it
    } catch (_) {}
    return lite;
  }
  const toggle = () => set(!lite);

  function build() {
    const wrap = el('stage-wrap');
    if (!wrap) return;
    if (!el('lite-panel')) {
      const p = document.createElement('div');
      p.id = 'lite-panel'; p.className = 'lite-panel';
      p.setAttribute('role', 'region'); p.setAttribute('aria-label', 'Station view paused');
      const card = document.createElement('div'); card.className = 'lite-card';
      const title = document.createElement('b'); title.className = 'lite-title'; title.textContent = 'STATION VIEW PAUSED';
      const body = document.createElement('p'); body.className = 'lite-copy';
      body.textContent = 'Lite view: the station picture is not drawn, to save memory. Agents, routines, Night Shift, '
        + 'COMMS and every panel keep working. BUILD MODE still opens from the dock.';
      const show = document.createElement('button'); show.type = 'button'; show.className = 'lite-show';
      show.textContent = 'SHOW STATION'; show.addEventListener('click', () => set(false));
      const hint = document.createElement('span'); hint.className = 'lite-hint'; hint.textContent = 'Ctrl+Shift+L switches';
      card.append(title, body, show, hint);
      p.appendChild(card);
      wrap.appendChild(p);
    }
    const hud = wrap.querySelector('.cam-hud');
    if (hud && !el('lite-key')) {
      const b = document.createElement('button');
      b.id = 'lite-key'; b.type = 'button'; b.className = 'cam-lite'; b.textContent = '◐ LITE';
      b.title = 'Lite view: pause the station picture to save memory (everything else keeps working) — Ctrl+Shift+L';
      b.addEventListener('click', () => set(true));
      hud.appendChild(b);
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyL' || e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        toggle();
      }
    });
    build(); paint();   // the stage markup is already parsed (scripts load after <body> content): no flash of the station
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { build(); paint(); });
  }

  return { on: () => lite, set, toggle };
})();
