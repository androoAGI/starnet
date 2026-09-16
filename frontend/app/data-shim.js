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
  blank: {"name":"Cadet","set":"approved_android","scale":0.25,"sourceStandingHeight":76},
  astronaut: {"name":"Retro Astronaut","set":"approved_astronaut","scale":0.25,"sourceStandingHeight":76},
  robot: {"name":"Robot","set":"approved_robot","scale":0.25,"sourceStandingHeight":76},
  crthead: {"name":"CRT Head","set":"approved_crthead","scale":0.25,"sourceStandingHeight":76},
  alien: {"name":"Alien","set":"approved_alien","scale":0.25,"sourceStandingHeight":76},
  ultron: {"name":"Ultron Overseer","set":"approved_ultron","scale":0.25,"sourceStandingHeight":76},
  skeleton: {"name":"Skeleton","set":"approved_skeleton","scale":0.25,"sourceStandingHeight":76},
  plaguedoctor: {"name":"Plague Doctor","set":"approved_plaguedoctor","scale":0.25,"sourceStandingHeight":76},
  secretagent: {"name":"Secret Agent","set":"approved_secretagent","scale":0.25,"sourceStandingHeight":76},
  voidwizard: {"name":"Void Wizard","set":"approved_voidwizard","scale":0.25,"sourceStandingHeight":76},
  xenomorph: {"name":"Xenomorph","set":"approved_xenomorph","scale":0.25,"sourceStandingHeight":76},
  robocop: {"name":"Robocop","set":"approved_robocop","scale":0.25,"sourceStandingHeight":76},
  masterchief: {"name":"Master Chief","set":"approved_masterchief","scale":0.25,"sourceStandingHeight":76},
  grimreaper: {"name":"Grim Reaper","set":"approved_grimreaper","scale":0.25,"sourceStandingHeight":76},
  crewmate: {"name":"Crewmate","set":"approved_crewmate","scale":0.25,"sourceStandingHeight":76},
  bear: {"name":"Teddy Bear","set":"approved_bear","scale":0.25,"sourceStandingHeight":76},
  pepe: {"name":"Pepe","set":"approved_pepe","scale":0.25,"sourceStandingHeight":76},
  capybara: {"name":"Capybara","set":"approved_capybara","scale":0.25,"sourceStandingHeight":76},
  vaultboy: {"name":"Vault Boy","set":"approved_vaultboy","scale":0.25,"sourceStandingHeight":76},
  station_minion: {"name":"Clean Cadet","set":"approved_station_minion","scale":0.25,"sourceStandingHeight":76},
  blank_blue: {"name":"Blank Blue","set":"approved_blank_blue","scale":0.25,"sourceStandingHeight":76},
  blank_green: {"name":"Blank Green","set":"approved_blank_green","scale":0.25,"sourceStandingHeight":76},
  blank_red: {"name":"Blank Red","set":"approved_blank_red","scale":0.25,"sourceStandingHeight":76},
  blank_amber: {"name":"Blank Amber","set":"approved_blank_amber","scale":0.25,"sourceStandingHeight":76},
  heisenberg: {"name":"Heisenberg","set":"approved_heisenberg","scale":0.25,"sourceStandingHeight":76},
  endoskeleton: {"name":"Endoskeleton","set":"approved_endoskeleton","scale":0.25,"sourceStandingHeight":76},
  ultrondroid: {"name":"Ultron","set":"approved_ultrondroid","scale":0.25,"sourceStandingHeight":76},
  samaltman: {"name":"Sam","set":"approved_samaltman","scale":0.25,"sourceStandingHeight":76},
  dario: {"name":"Dario","set":"approved_dario","scale":0.25,"sourceStandingHeight":76},
  freddyfazbear: {"name":"Freddy","set":"approved_freddyfazbear","scale":0.25,"sourceStandingHeight":76},
  ghostface: {"name":"Ghostface","set":"approved_ghostface","scale":0.25,"sourceStandingHeight":76},
  morpheus: {"name":"Morpheus","set":"approved_morpheus","scale":0.25,"sourceStandingHeight":76},
  ricksanchez: {"name":"Rick","set":"approved_ricksanchez","scale":0.25,"sourceStandingHeight":76},
  ninjaturtle: {"name":"Ninja Turtle","set":"approved_ninjaturtle","scale":0.25,"sourceStandingHeight":76},
  pikachu: {"name":"Pikachu","set":"pikachu","scale":0.41304347826086957,"sourceStandingHeight":46},
  caseyjones: {"name":"Casey Jones","set":"approved_caseyjones","scale":0.25,"sourceStandingHeight":76},
  finn: {"name":"Finn","set":"approved_finn","scale":0.25,"sourceStandingHeight":76},
};
// Keep the retired duplicate readable in old saves without offering it in the picker.
Object.defineProperty(DATA.SKINS, 'minionchar', { value: DATA.SKINS.station_minion });
DATA.DEFAULT_SKIN = 'blank';
