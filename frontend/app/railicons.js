/* AGENT OS — railicons.js : ONE line-icon set for every window side menu (Andrew 10-02).
   The rails used symbol characters (▤ ◎ ◷ ▦ ⌁ …) that VT323 does not contain, so each fell back to a different
   system font: off-grid, mismatched weights. This draws them as 16×16 stroke SVGs in currentColor instead, chosen
   by the section's own label/id (the same words the menu prints). No match = null, and the caller keeps the old
   glyph, so a new section never renders blank. Pure lookup, no state. */
'use strict';
const RailIcons = (() => {
  const P = {
    person:   '<circle cx="8" cy="5.2" r="2.6"/><path d="M3 14c.5-3 2.6-4.6 5-4.6s4.5 1.6 5 4.6"/>',
    star:     '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    record:   '<rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h3.5"/>',
    memory:   '<rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M6 1.8v2.2M10 1.8v2.2M6 12v2.2M10 12v2.2M1.8 6h2.2M1.8 10h2.2M12 6h2.2M12 10h2.2"/>',
    gear:     '<path d="M14.21,6.93 L14.21,9.07 L12.58,9.04 L11.98,10.51 L13.14,11.64 L11.64,13.14 L10.51,11.98 L9.04,12.58 L9.07,14.21 L6.93,14.21 L6.96,12.58 L5.49,11.98 L4.36,13.14 L2.86,11.64 L4.02,10.51 L3.42,9.04 L1.79,9.07 L1.79,6.93 L3.42,6.96 L4.02,5.49 L2.86,4.36 L4.36,2.86 L5.49,4.02 L6.96,3.42 L6.93,1.79 L9.07,1.79 L9.04,3.42 L10.51,4.02 L11.64,2.86 L13.14,4.36 L11.98,5.49 L12.58,6.96Z"/><circle cx="8" cy="8" r="2"/>',
    grid:     '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    book:     '<path d="M3 2.5h7.5A2.5 2.5 0 0 1 13 5v8.5H5.5A2.5 2.5 0 0 1 3 11z"/><path d="M3 11a2.5 2.5 0 0 1 2.5-2.5H13"/>',
    pen:      '<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/><path d="M9 4l3 3"/>',
    download: '<path d="M8 2v8M4.8 7.2L8 10.4l3.2-3.2M2.5 13.5h11"/>',
    spark:    '<path d="M8 1.8v3.4M8 10.8v3.4M1.8 8h3.4M10.8 8h3.4"/><path d="M8 5.2L9.2 8 8 10.8 6.8 8z"/>',
    loop:     '<path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11"/><path d="M3.4 2.3v2.9h2.9M12.6 13.7v-2.9H9.7"/>',
    shield:   '<path d="M8 1.8l5 2v4c0 3.1-2.1 5.4-5 6.4-2.9-1-5-3.3-5-6.4v-4z"/>',
    coin:     '<circle cx="8" cy="8" r="5.8"/><path d="M9.8 5.8c-.4-.7-1.1-1-1.8-1-1 0-1.8.6-1.8 1.4 0 1.9 3.6 1 3.6 3 0 .8-.8 1.4-1.8 1.4-.8 0-1.5-.4-1.9-1M8 3.8v1M8 11.2v1"/>',
    sun:      '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
    bell:     '<path d="M4 11V7.3a4 4 0 0 1 8 0V11l1.2 1.2H2.8z"/><path d="M6.5 13.6a1.6 1.6 0 0 0 3 0"/>',
    phone:    '<rect x="4.5" y="1.6" width="7" height="12.8" rx="1.5"/><path d="M7 12h2"/>',
    globe:    '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.8 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.8 5.4 8s.8 4.3 2.6 6"/>',
    target:   '<circle cx="8" cy="8" r="5.8"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".6"/>',
    sliders:  '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/><circle cx="5" cy="12" r="1.4"/>',
    doc:      '<path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6 8h4.5M6 10.5h4.5"/>',
    link:     '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8"/><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8"/>',
    cube:     '<path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z"/><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4"/>',
    monitor:  '<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>',
    key:      '<circle cx="5" cy="10.8" r="2.8"/><path d="M7 8.8l6-6M10.8 5l1.6 1.6M12.4 3.4l1.2 1.2"/>',
    plug:     '<path d="M6 2v3.2M10 2v3.2M4 5.2h8v2.3a4 4 0 0 1-8 0zM8 11.5V14"/>',
    home:     '<path d="M2.2 7.5L8 2.5l5.8 5"/><path d="M3.8 6.3v7.2h8.4V6.3"/>',
    clock:    '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.6"/>',
    plus:     '<circle cx="8" cy="8" r="5.8"/><path d="M8 5.2v5.6M5.2 8h5.6"/>',
    flag:     '<path d="M3.5 14V2.2M3.5 2.8h8l-1.6 2.6 1.6 2.6h-8"/>',
    chat:     '<path d="M2.2 3.2h11.6v7.6H7l-3 2.6v-2.6H2.2z"/>',
    flow:     '<rect x="1.8" y="5.8" width="3.6" height="4.4" rx=".8"/><rect x="10.6" y="5.8" width="3.6" height="4.4" rx=".8"/><path d="M5.4 8h5.2M8.8 6.2L10.6 8 8.8 9.8"/>',
    moon:     '<path d="M12.8 9.6A5.6 5.6 0 0 1 6.4 3.2a5.6 5.6 0 1 0 6.4 6.4z"/>',
    search:   '<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3l3.4 3.4"/>'
  };
  // first match wins — specific words before generic ones
  const RULES = [
    [/\bbuilt-?in\b/, 'cube'], [/computer/, 'monitor'], [/\bapi\b|\bkeys?\b/, 'key'], [/connected|connector|integration/, 'plug'],
    [/agent skills/, 'pen'], [/exchange|import/, 'download'], [/market|catalog|discover/, 'grid'], [/library|skills?\b|recipes?/, 'book'],
    [/installed/, 'cube'], [/create|advanced|new schedule|\bnew\b/, 'plus'],
    [/\bbrief\b|about you|profile|identity/, 'person'], [/briefing/, 'doc'], [/growth|achievement|trophy/, 'star'],
    [/record|history|log\b|logbook/, 'record'], [/memory|remember/, 'memory'], [/config|app & backup|system|general/, 'gear'],
    [/ai & models|models?|providers?/, 'spark'], [/autonomy|away|night/, 'moon'], [/permission|access|safety/, 'shield'],
    [/spend|budget|cost|credits?/, 'coin'], [/look|appearance|sound|theme/, 'sun'], [/alert|notif/, 'bell'], [/remote|phone/, 'phone'],
    [/browser|web/, 'globe'], [/aims?|goals?|quest/, 'target'], [/preference/, 'sliders'], [/sources?/, 'link'],
    [/overview|home/, 'home'], [/schedul|routine|timer/, 'clock'], [/loop/, 'loop'], [/workflow|line/, 'flow'],
    [/channel|chat|message/, 'chat'], [/mission|task/, 'flag'], [/search|find/, 'search']
  ];
  function svg(name) {
    return '<svg class="rail-ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + '</svg>';
  }
  function forSection(label, id) {
    const hay = (String(label || '') + ' ' + String(id || '')).toLowerCase();
    for (const [re, name] of RULES) if (re.test(hay)) return svg(name);
    return null;
  }
  return { forSection, svg, names: Object.keys(P) };
})();
if (typeof module !== 'undefined') module.exports = RailIcons;
