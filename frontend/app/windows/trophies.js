/* STARNET — windows/trophies.js : the TROPHY CASE window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const esc = StationUI.h.esc;

  /* ============== TROPHY CASE (G3b) ==============
     The station-wide surface the TROPHY CASE prop opens: REAL earned achievements made permanent. Every trophy
     is a genuine completion (a completed quest / an earned milestone) projected by the pure Trophies engine over
     the live quest view + the durable QuestState memory. Dates are honest — a completion with no knowable date
     (a resumed pre-fix save) renders "date unknown", NEVER 1969 (the whole point of the G3b hydrate fix). An
     empty case shows honest dust, not placeholder trophies. The LIVING TOOLS shelf lists Commander-saved seeds
     with their real lifetime + 7-day run counts (the seed-reuse aggregate). No XP is minted anywhere here. */
  function buildTrophies(body) {
    // fold the live memory first so a just-completed quest is a trophy the instant this opens (buildQuests idiom).
    const QSS = (typeof QuestStateStore !== 'undefined') ? QuestStateStore : null;
    const SQS = (typeof StationQuestStore !== 'undefined') ? StationQuestStore : null;
    if (SQS && SQS.sync) { try { SQS.sync(); } catch (_) {} }
    if (QSS && QSS.sync) { try { QSS.sync(); } catch (_) {} }
    const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
    const quests = (v && Array.isArray(v.quests)) ? v.quests : [];
    const stateOf = (QSS && QSS.stateOf) ? (id => QSS.stateOf(id)) : (() => null);
    const tools = (typeof SeedReuseStore !== 'undefined' && SeedReuseStore.livingTools) ? SeedReuseStore.livingTools() : [];
    const surf = (typeof Trophies !== 'undefined' && Trophies.build)
      ? Trophies.build({ quests, stateOf, tools })
      : { trophies: [], tools: [], earned: 0, empty: true };

    const KIND = { milestone: 'MILESTONE', 'station-gap': 'CAPABILITY', station: 'STATION', dossier: 'DOSSIER', idea: 'WORK' };
    // a date as the station prints one (old-UI review 10-26 #12): "Oct 13", the year only when it is not this one — not 10/13/2026
    const fmtDate = at => { if (at == null) return 'date unknown'; const d = new Date(at); if (isNaN(d.getTime())) return 'date unknown';
      const o = { month: 'short', day: 'numeric' }; if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric'; return d.toLocaleDateString('en-US', o); };
    // the case's marks, drawn on the 16px icon grid in gold (old-UI review 10-26 #10) — the ★ and ◆ were fallback-font glyphs
    const STAR = '<svg viewBox="0 0 16 16" focusable="false"><path d="M8 1.5l1.9 4.2 4.6.5-3.4 3.1 1 4.5L8 11.5l-4.1 2.3 1-4.5-3.4-3.1 4.6-.5z"/></svg>';
    const GEM = '<svg viewBox="0 0 16 16" focusable="false"><path d="M8 2l5 6-5 6-5-6z"/></svg>';
    const troRow = t =>
      '<div class="gx-tro on">'
      + '<div class="tro-hd"><span class="gl" aria-hidden="true">' + STAR + '</span><span class="nm">' + esc(t.title) + '</span>'
      + '<span class="gx-tag">' + esc(KIND[t.kind] || 'HONOUR') + '</span></div>'
      + '<div class="sub">' + (t.reward ? '<span class="tro-rw">' + esc(t.reward) + '</span>' : '')
      + '<span style="opacity:' + (t.dateKnown ? '1' : '.6') + ';">' + esc(fmtDate(t.completedAt)) + '</span></div></div>';

    const toolRow = tl =>
      '<div class="gx-tro on">'
      + '<div class="tro-hd"><span class="gl" aria-hidden="true">' + GEM + '</span><span class="nm">' + esc(tl.name) + '</span>'
      + '<span class="gx-tag">' + tl.runs + '&times; LIFETIME</span></div>'
      + '<div class="sub">the seed you saved &middot; ' + tl.sevenDay + '&times; in the last 7 days</div></div>';

    const trophiesHtml = surf.trophies.length
      ? '<div class="gx-tros">' + surf.trophies.map(troRow).join('') + '</div>'
      : '<div class="gx-tros"><p class="dim" style="font-style:italic;">The case stands empty &mdash; dust on the glass. Ship real work and your first milestone lands here.</p></div>';

    const toolsHtml = surf.tools.length
      ? '<div class="gx-sec" style="margin-top:14px;"><span class="gx-title">LIVING TOOLS</span> <span class="gx-tag">' + surf.tools.length + '</span></div>'
        + '<div class="gx-tros">' + surf.tools.map(toolRow).join('') + '</div>'
      : '';

    body.innerHTML = '<div class="gx">'
      + '<div class="dim" style="margin:2px 0 10px;">The station&rsquo;s real achievements, made permanent. Every milestone here is a completion that genuinely happened &mdash; never points, never invented. No dates are guessed.</div>'
      + '<div class="gx-sec"><span class="gx-title">MILESTONES</span> <span class="gx-tag">' + surf.earned + ' EARNED</span></div>'
      + trophiesHtml
      + toolsHtml
      + '</div>';
  }

  StationUI.registerWindow('trophies', 'TROPHY CASE', buildTrophies, { className: 'trophies-win' });   // G3b: the TROPHY CASE prop opens this station-wide surface. PANEL shell — see the two-sizes note in style.css
})();
