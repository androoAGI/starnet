/* STARNET — data-shim.js
   The reused v7 sprite engine (js/assets.js) recolors a body by looking up
   DATA.AGENT[id].color. v7 shipped a giant 17-agent roster (data.js); the real
   harness has no fixed roster — each user-created agent registers itself here.
   This is the ONLY thing assets.js needs from the old data layer. */
'use strict';

const DATA = { AGENT: {} };

/* register (or recolor) an agent so the sprite engine can tint its suit */
function registerAgent(id, color) {
  DATA.AGENT[id] = { id, color: color || '#5ad0ff' };
  return DATA.AGENT[id];
}

/* SKIN REGISTRY — each agent picks a skin (a natively-colored sprite set) at
   creation. assets.js drawBody maps agent.skin -> DATA.SKINS[skin].set -> the
   manifest's "<set>.<state>.<dir>" frames. ADDITIVE: new skins = new entries
   here + a matching sprite set in assets/sprites/manifest.json. `scale` is the
   per-set downscale applied at tint time (crew sprites render on a 92px canvas). */
DATA.SKINS = {
  bear:       { name: 'Teddy Bear', set: 'bear',       scale: 0.425 },   // v2 8-dir master: south content is 39px (was 46) — 0.36*46/39 keeps the canonical on-floor size; kept sit/type/blink masters are pre-scaled x0.8471 to match
  pepe:       { name: 'Pepe',       set: 'pepe',       scale: 0.36 },
  alien:      { name: 'Alien',      set: 'alien',      scale: 0.376 },
  skeleton:   { name: 'Skeleton',   set: 'skeleton',   scale: 0.414 },
  crewmate:   { name: 'Crewmate',   set: 'crewmate',   scale: 0.385 },
  capybara:   { name: 'Capybara',   set: 'capybara',   scale: 0.425 },
  robot:      { name: 'Robot',      set: 'robot',      scale: 0.385 },
  vaultboy:   { name: 'Vault Boy',  set: 'vaultboy',   scale: 0.376 },
  blank:       { name: 'Cadet',       set: 'blank',       scale: 0.385 },
  station_minion: { name: 'Clean Cadet', set: 'station_minion', scale: 0.385 },
  blank_blue:  { name: 'Blank Blue',  set: 'blank_blue',  scale: 0.385 },
  blank_green: { name: 'Blank Green', set: 'blank_green', scale: 0.385 },
  blank_red:   { name: 'Blank Red',   set: 'blank_red',   scale: 0.385 },
  blank_amber: { name: 'Blank Amber', set: 'blank_amber', scale: 0.385 },
  heisenberg:  { name: 'Heisenberg',  set: 'heisenberg',  scale: 0.36  },
  crthead:      { name: 'CRT Head',       set: 'crthead',      scale: 0.404 },
  astronaut:    { name: 'Retro Astronaut', set: 'astronaut',    scale: 0.404 },
  endoskeleton: { name: 'Endoskeleton',   set: 'endoskeleton', scale: 0.404 },
  ultrondroid:  { name: 'Ultron',         set: 'ultrondroid',  scale: 0.404 },
  xenomorph:    { name: 'Xenomorph',      set: 'xenomorph',    scale: 0.385 },
  voidwizard:   { name: 'Void Wizard',    set: 'voidwizard',   scale: 0.368 },
  samaltman:    { name: 'Sam',            set: 'samaltman',    scale: 0.385 },
  dario:        { name: 'Dario',          set: 'dario',        scale: 0.376 },
  secretagent:  { name: 'Secret Agent',   set: 'secretagent',  scale: 0.404 },
  grimreaper:   { name: 'Grim Reaper',    set: 'grimreaper',   scale: 0.394 },
  plaguedoctor: { name: 'Plague Doctor',  set: 'plaguedoctor', scale: 0.376 },
  freddyfazbear: { name: 'Freddy',         set: 'freddyfazbear', scale: 0.368 },
  ghostface:     { name: 'Ghostface',      set: 'ghostface',     scale: 0.376 },
  morpheus:      { name: 'Morpheus',       set: 'morpheus',      scale: 0.385 },
  ricksanchez:   { name: 'Rick',           set: 'ricksanchez',   scale: 0.376 },
  ninjaturtle:   { name: 'Ninja Turtle',   set: 'ninjaturtle',   scale: 0.414 },
  robocop:       { name: 'Robocop',        set: 'robocop',       scale: 0.385 },
  minionchar:    { name: 'Minion',         set: 'minionchar',    scale: 0.404 },
  masterchief:   { name: 'Master Chief',   set: 'masterchief',   scale: 0.376 },
  pikachu:       { name: 'Pikachu',        set: 'pikachu',       scale: 0.36  },
  caseyjones:    { name: 'Casey Jones',    set: 'caseyjones',    scale: 0.404 },
  finn:          { name: 'Finn',           set: 'finn',          scale: 0.394 },
};
DATA.DEFAULT_SKIN = 'blank';
