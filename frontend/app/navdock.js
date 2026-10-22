/* AGENT OS — navdock.js : the grouped bottom-bar navigation.
   The 13 station panels were a flat, undifferentiated row of cryptic glyphs. They're now
   regrouped (in index.html) into 4 labelled docks — CREW / WORK / BUILD / SYSTEM — each a
   .bb-grp trigger that opens a .bb-menu popover of its items. The item buttons keep their
   original id / data-term, so stationui/app handlers fire unchanged; this file only manages
   the popover open/close + reflects each group's live state (a panel open under it, or a
   pending notification) onto the collapsed trigger so nothing important hides in a closed menu. */
'use strict';

(() => {
  const bar = document.getElementById('bottombar');
  if (!bar) return;
  const groups = Array.from(bar.querySelectorAll('.bb-group'));
  if (!groups.length) return;

  // the menuitem buttons inside a group's popover (role=menuitem; see index.html .bb-menu)
  // (an item whose station system is not online yet carries data-offline — systems.js — and is skipped too)
  const itemsOf = g => Array.from(g.querySelectorAll('.bb-menu .bb')).filter(item => !item.hidden && !item.hasAttribute('data-offline'));

  /* The four triggers wrap onto different rows on phone-width stations, so a fixed
     left:0 popover cannot be made viewport-safe with one CSS alignment. Clamp the open
     menu in its group's local frame. getBoundingClientRect/innerWidth are VISUAL px;
     style.left is a zoom-scaled CSS px, hence the one deliberate division. The divisor is
     U.elZoom(menu), NOT U.uiZoom(): this popover lives inside #bottombar, which TEXT SIZE
     counter-zooms back to 1:1 as cabinet, so the dock's local frame is visual px even while
     <body> is zoomed. elZoom composes what the engine actually applied, so it is right either way. */
  function clampMenu(g) {
    const menu = g && g.querySelector('.bb-menu');
    if (!menu || !g.classList.contains('open')) return;
    menu.style.left = '0px';
    if (window.innerWidth > 600) {
      menu.style.removeProperty('width');
      menu.style.removeProperty('max-width');
      return;
    }
    const edge = 8;
    let zoom = 1;
    try { zoom = (typeof U === 'object' && U && typeof U.elZoom === 'function') ? Number(U.elZoom(menu)) || 1 : 1; } catch (_) {}
    // vw is resolved before Agent OS's uiZoom transform; cap the menu in the visual frame too.
    const cssWidth = Math.max(0, window.innerWidth - edge * 2) / zoom;
    menu.style.width = cssWidth + 'px';
    menu.style.maxWidth = cssWidth + 'px';
    const r = menu.getBoundingClientRect();
    let shift = 0;
    if (r.right > window.innerWidth - edge) shift -= r.right - (window.innerWidth - edge);
    if (r.left + shift < edge) shift += edge - (r.left + shift);
    menu.style.left = (shift / zoom) + 'px';
  }

  /* ---------- popover open/close (one at a time) ---------- */
  // a toast already up re-seats above a dock menu that opens into its column, and drops back when it closes (rc walk #29)
  const reseatToasts = () => { try { if (typeof StationUI !== 'undefined' && StationUI.reseatToasts) StationUI.reseatToasts(); } catch (e) { console.warn('[navdock] toast reseat:', (e && e.message) || e); } };
  function closeAll(except) {
    groups.forEach(g => {
      if (g === except) return;
      const wasOpen = g.classList.contains('open');
      g.classList.remove('open');
      const menu = g.querySelector('.bb-menu'); if (menu) menu.inert = true;
      const t = g.querySelector('.bb-grp');
      if (t) t.setAttribute('aria-expanded', 'false');
      // a11y: if focus was inside the popover we just closed, hand it back to the trigger
      if (wasOpen && t && g.contains(document.activeElement)) { try { t.focus(); } catch (_) {} }
    });
    reseatToasts();
  }
  // viaKeyboard: only a KEYBOARD-initiated open moves focus into the popover (menu-button pattern).
  // A mouse open must NOT transfer focus to the first item (TASKS in the WORK dock) — that invisible
  // focus meant any stray Enter/Space afterwards "clicked" TASKS, so the task board popped open
  // seemingly at random. Mouse users keep their focus; keyboard users still land on the first item.
  function toggle(g, viaKeyboard) {
    const willOpen = !g.classList.contains('open');
    closeAll(g);
    g.classList.toggle('open', willOpen);
    const menu = g.querySelector('.bb-menu'); if (menu) menu.inert = !willOpen;
    const t = g.querySelector('.bb-grp');
    if (t) t.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      clampMenu(g);
      // panelchrome's opening scale changes the first synchronous rect by a few pixels;
      // re-clamp on the painted frame and once its opening animation settles.
      requestAnimationFrame(() => clampMenu(g));
      const openingMenu = g.querySelector('.bb-menu');
      if (openingMenu) openingMenu.addEventListener('animationend', () => { clampMenu(g); reseatToasts(); }, { once: true });
      requestAnimationFrame(reseatToasts);
      dismissCoach();   // they found the docks — retire the hint for good
      // a11y: on a keyboard open, move focus to the first menu item so the popover is navigable
      if (viaKeyboard) { const first = itemsOf(g)[0]; if (first) { try { first.focus(); } catch (_) {} } }
    } else reseatToasts();   // this menu just closed: a raised toast drops back to its seat
    try { if (typeof SFX === 'object' && SFX[willOpen ? 'open' : 'close']) SFX[willOpen ? 'open' : 'close'](); } catch (_) {}
  }

  /* ---------- one-time "what now" coach: teach the new grouped-dock model ----------
     The interaction model changed (flat buttons -> dock popovers), so a brand-new station
     gets one dismissible hint pointing at the docks. Shown on first game-screen view, then
     retired permanently the moment the Commander opens any dock or taps ✕. */
  const COACH_KEY = 'starnet.navcoach.seen';
  const coach = document.getElementById('nav-coach');
  let coachTimer = 0;
  // RETIRING IS NOT HIDING (live walk 10-14: the tip came back after a reload 40 minutes into heavy use). The 15 s fade
  // hides it without retiring it, and a dock opened after that returned early here because the tip was already hidden —
  // so finding every dock was never written down. Opening a dock (or GOT IT) retires it whether or not it is on screen.
  function dismissCoach(persist) {
    if (!coach) return;
    if (!coach.hidden) {
      coach.hidden = true;
      if (coachTimer) { clearTimeout(coachTimer); coachTimer = 0; }
    }
    if (persist !== false) { try { localStorage.setItem(COACH_KEY, '1'); } catch (e) { console.warn('[navdock] could not remember the dock tip was retired (storage blocked)', e); } }
  }
  // ONCE PER PAGE (live walkthrough 2026-10-13): the observer below fires on ANY class change of #screen-game, and a
  // flicker effect toggles a class there every 7 s — so the hint came back 15 s on / 7 s off for the whole session,
  // over the CREW dock, the dock menus and the approval toasts. It shows once per page; GOT IT still ends it for good.
  let coachShown = false;
  // NOT OVER THE ARRIVAL (org P31, 2026-10-14): #screen-game goes active while the awakening still owns the room
  // (World.beginAwakening), so the coach waited for nothing and talked over the first meeting. It now waits for
  // World.releaseAwakening, which fires 'starnet:awakening-released'; a returning Commander (no awakening) is unchanged.
  const awakeningHeld = () => typeof World !== 'undefined' && typeof World.awakeningHeld === 'function' && World.awakeningHeld();
  // NOT OVER A COVERED COMMS (org P31 review fix): closeOut releases the awakening while the Dialogue panel — mounted
  // over #chat-panel — still runs the first-task hand-off and the tour, so "Talk to your agent up in COMMS" would point
  // at a COMMS the panel hides. The coach also holds while a Dialogue is open; Dialogue.close fires
  // 'starnet:dialogue-closed' and the coach asks again then.
  const dialogueOpen = () => typeof Dialogue !== 'undefined' && typeof Dialogue.isOpen === 'function' && Dialogue.isOpen();
  // NOT INSIDE THE TOUR (org P31 wire): the optional tour closes the Dialogue mid-way (TRY A SMALL FILE EXAMPLE reveals
  // COMMS), and that close is not the end of onboarding — two hints would compete for the first click. The coach holds
  // while Tutorial.isCoaching() (the same check dockglow/build stand down on); Tutorial.finishUp fires
  // 'starnet:tutorial-ended' once the tour is over and the coach asks again then.
  const tourCoaching = () => typeof Tutorial !== 'undefined' && typeof Tutorial.isCoaching === 'function' && !!Tutorial.isCoaching();
  function showCoachOnce() {
    if (!coach || !coach.hidden || coachShown) return;
    if (awakeningHeld()) return;   // the arrival is still on screen — the release event asks again
    if (dialogueOpen()) return;    // COMMS is covered by the conversation panel — the close event asks again
    if (tourCoaching()) return;    // the optional tour still owns the first click — 'starnet:tutorial-ended' asks again
    try { if (localStorage.getItem(COACH_KEY)) return; } catch (_) {}
    coachShown = true;
    coach.hidden = false;
    coachTimer = setTimeout(() => dismissCoach(false), 15000);   // fade out after a while, but let it return next session
  }
  if (coach) {
    const x = document.getElementById('nav-coach-x');
    if (x) x.addEventListener('click', () => dismissCoach(true));
    const game = document.getElementById('screen-game');
    if (game) {
      if (game.classList.contains('active')) showCoachOnce();
      new MutationObserver(() => { if (game.classList.contains('active')) showCoachOnce(); })
        .observe(game, { attributes: true, attributeFilter: ['class'] });
      document.addEventListener('starnet:awakening-released', () => { if (game.classList.contains('active')) showCoachOnce(); });
      document.addEventListener('starnet:dialogue-closed', () => { if (game.classList.contains('active')) showCoachOnce(); });
      document.addEventListener('starnet:tutorial-ended', () => { if (game.classList.contains('active')) showCoachOnce(); });
    }
  }

  groups.forEach(g => {
    const trigger = g.querySelector('.bb-grp');
    // ev.detail === 0 ⇒ the click was synthesized by Enter/Space on the trigger (keyboard); > 0 ⇒ real mouse.
    // After a MOUSE toggle, also drop focus from the trigger — otherwise it silently keeps focus and a stray
    // Space/Enter later re-toggles the dock (the same "opens by itself" class of bug, one level up).
    if (trigger) trigger.addEventListener('click', ev => {
      ev.stopPropagation();
      const viaKeyboard = ev.detail === 0;
      toggle(g, viaKeyboard);
      if (!viaKeyboard) { try { trigger.blur(); } catch (_) {} }
    });
    // picking an item runs its own (existing) handler — just collapse the dock after.
    Array.from(g.querySelectorAll('.bb-menu .bb')).forEach(item => {
      item.setAttribute('role', 'menuitem');   // a11y: items inside the role=menu popover
      item.addEventListener('click', () => closeAll(null));
    });
    // a11y: full role=menu keyboard model — ArrowUp/Down cycle the items (wrapping),
    // Home/End jump, ArrowUp/Down on the closed trigger opens the menu, and Tab is
    // trapped inside an open popover so focus can't wander to the page behind it.
    // the adjacent group in the visual row (wrapping), for horizontal dock navigation.
    // (a HIDDEN dock — APPS before the first app — is skipped)
    const sibling = (dir) => { let gi = groups.indexOf(g); for (let k = 0; k < groups.length; k++) { gi = (gi + (dir > 0 ? 1 : groups.length - 1)) % groups.length; if (!groups[gi].hidden) break; } return groups[gi]; };
    g.addEventListener('keydown', ev => {
      const open = g.classList.contains('open');
      if (!open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && document.activeElement === trigger) {
        ev.preventDefault(); toggle(g, true); return;   // keyboard open → toggle() focuses the first item
      }
      // closed trigger: Left/Right walks to the adjacent dock trigger (menubar-style), no popover opened.
      if (!open && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && document.activeElement === trigger) {
        ev.preventDefault();
        const nt = sibling(ev.key === 'ArrowRight' ? 1 : -1).querySelector('.bb-grp');
        if (nt) { try { nt.focus(); } catch (_) {} }
        return;
      }
      if (!open) return;
      // open popover: Left/Right moves to the neighbouring dock's popover (open it there, focus its first item).
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        const nb = sibling(ev.key === 'ArrowRight' ? 1 : -1);
        if (nb && nb !== g) toggle(nb, true);   // keyboard walk: closes this one + focuses the neighbour's first item
        return;
      }
      const items = itemsOf(g); if (!items.length) return;
      const first = items[0], last = items[items.length - 1], act = document.activeElement;
      const i = items.indexOf(act);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); (items[i + 1] || first).focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); (i > 0 ? items[i - 1] : last).focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); first.focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); last.focus(); }
      else if (ev.key === 'Tab') {
        if (ev.shiftKey && act === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && act === last) { ev.preventDefault(); first.focus(); }
      }
    });
  });

  // click anywhere else, or Escape, dismisses an open dock
  document.addEventListener('click', ev => { if (!bar.contains(ev.target)) closeAll(null); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeAll(null); });
  window.addEventListener('resize', () => groups.forEach(g => clampMenu(g)));

  /* ---------- reflect live state onto the collapsed trigger ----------
     A group underlines its trigger while one of its panels is open (mirrors stationui's
     .bb.active), and the SYSTEM trigger mirrors the pending NOTIFS COUNT into its own chip
     so the badge isn't buried inside a closed menu. NOTE: never probe the in-menu badge via
     offsetParent — a closed .bb-menu is display:none, so offsetParent is null exactly when
     the mirror matters; read the textContent + inline display that stationui.badges() writes. */
  const nfBadge = document.getElementById('nf-badge');
  const upBadge = document.getElementById('up-badge');   // updates.js paints NEW while a verified update is armed
  const sysBadge = document.getElementById('bb-sys-badge');
  function syncGroupState() {
    groups.forEach(g => {
      const anyOpen = !!g.querySelector('.bb-menu .bb.active');
      g.classList.toggle('has-active', anyOpen);
    });
    if (nfBadge) {
      const sys = bar.querySelector('.bb-group[data-group="system"]');
      const notifs = (nfBadge.style.display !== 'none' && nfBadge.textContent) ? nfBadge.textContent : '';
      // an armed update also lights the collapsed SYSTEM trigger — the notif count wins the chip when both apply
      const update = !!(upBadge && upBadge.style.display !== 'none' && upBadge.textContent);
      const n = notifs || (update ? 'NEW' : '');
      if (sys) sys.classList.toggle('has-alert', !!n);
      // guard the writes: this runs inside a MutationObserver on the bar's subtree, and an
      // unconditional textContent set replaces the text node even when the value is identical —
      // a new mutation record every pass = an infinite observer loop that pegs the main thread.
      if (sysBadge) {
        if (sysBadge.textContent !== n) sysBadge.textContent = n;
        if (sysBadge.hidden === !!n) sysBadge.hidden = !n;
        const label = notifs ? 'unread notifications' : (update ? 'a Agent OS update is ready' : 'unread notifications');
        if (sysBadge.getAttribute('aria-label') !== label) sysBadge.setAttribute('aria-label', label);
      }
    }
  }

  // stationui toggles .bb.active and the nf-badge imperatively — observe the bar so the
  // collapsed triggers stay truthful without coupling the two files together.
  const mo = new MutationObserver(syncGroupState);
  mo.observe(bar, { subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true, characterData: true });
  syncGroupState();
})();
