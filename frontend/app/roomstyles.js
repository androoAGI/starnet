/* frontend/app/roomstyles.js — THE ZONE STYLES the station builder furnishes with (vibe design, 2026-09-29).

   Pure, zero-dep, UMD (node tests + the browser). When the Commander says "the left side cozy, the right side a line", the
   lead names a STYLE for each part of the room and Agent OS furnishes it from here: never a piece the model chose or placed.
   A style is a few hand-arranged SETS of furniture, largest first, in the same pieces the station presets are made of; the
   builder takes the largest set that fits the zone and seats it against the room's outer walls. Each set is
   [type, x, y, facing?] in its own tiles (y grows toward the front of the room). A chair left of a table faces 3, right of
   it faces 1 (the presets' own convention). Some pieces are EQUIPMENT (object = capability: a desk is a computer, a rack
   holds files, a dish reaches the web, a workbench runs commands); the approval card names what each style brings. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.RoomStyles = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STYLES = {
    cozy: { name: 'a cozy corner', about: 'a couch on a rug, a beanbag, a side table, a lamp and plants', words: ['comfy', 'chill', 'relax', 'relaxing', 'hangout', 'warm', 'snug'],
      sets: [
        { w: 8, h: 6, pieces: [['bookshelf', 0, 0], ['tallplant', 7, 0], ['rug', 2, 1], ['beanbag', 7, 2], ['couch', 1, 4], ['sidetable', 6, 4], ['lavalamp', 6, 4], ['plant', 7, 5]] },
        { w: 6, h: 4, pieces: [['rug_small', 1, 0], ['plant', 0, 0], ['couch', 0, 3], ['sidetable', 5, 3]] },
      ] },
    lounge: { name: 'a lounge', about: 'a TV, a couch, recliners and a side table', words: ['tv', 'movie', 'movies', 'living', 'sofa', 'couch'],
      sets: [
        { w: 8, h: 6, pieces: [['tv', 2, 0], ['plant', 0, 0], ['plant', 7, 0], ['rug', 2, 1], ['recliner_r', 1, 2], ['recliner', 6, 2], ['couch', 1, 4], ['sidetable', 6, 4]] },
        { w: 6, h: 4, pieces: [['tv', 1, 0], ['rug_small', 1, 1], ['couch', 0, 3], ['plant', 5, 3]] },
      ] },
    library: { name: 'a reading nook', about: 'bookshelves, a recliner on a rug, a side table and a book stack', words: ['reading', 'books', 'book', 'study', 'quiet'],
      sets: [
        { w: 8, h: 5, pieces: [['bookshelf', 0, 0], ['bookshelf', 2, 0], ['bookshelf', 4, 0], ['tallplant', 7, 0], ['rug_small', 2, 2], ['recliner_r', 1, 3], ['sidetable', 6, 3], ['bookstack', 7, 4]] },
        { w: 6, h: 4, pieces: [['bookshelf', 0, 0], ['bookshelf', 2, 0], ['plant', 5, 0], ['recliner_r', 1, 2], ['sidetable', 3, 2], ['bookstack', 4, 3]] },
      ] },
    desks: { name: 'work desks', about: 'desks (each seats its own agent)', words: ['desk', 'office', 'workspace', 'work', 'workstations', 'computers'],
      sets: [
        // spaced for either desk: the classic one is 2 tiles wide, the remastered one 3
        { w: 12, h: 3, pieces: [['desk', 0, 0], ['desk', 4, 0], ['desk', 8, 0], ['plant', 11, 0]] },
        { w: 7, h: 3, pieces: [['desk', 0, 0], ['desk', 4, 0]] },
      ] },
    meeting: { name: 'a meeting table', about: 'a long table with chairs and a whiteboard', words: ['meeting', 'meetings', 'conference', 'planning', 'standup', 'huddle'],
      sets: [
        { w: 7, h: 5, pieces: [['whiteboard', 1, 0], ['plant', 6, 0], ['chair', 2, 1], ['chair', 4, 1], ['chair', 1, 2, 3], ['longtable', 2, 2], ['chair', 5, 2, 1], ['chair', 3, 3, 2]] },
        { w: 5, h: 3, pieces: [['chair', 0, 1, 3], ['longtable', 1, 1], ['chair', 4, 1, 1], ['plant', 4, 0]] },
      ] },
    cafe: { name: 'a café corner', about: 'a bar with stools, coffee, a fridge and a table', words: ['coffee', 'kitchen', 'bar', 'snacks', 'food', 'break', 'breakroom', 'cafe'],
      sets: [
        { w: 8, h: 5, pieces: [['quarters_minifridge', 0, 0], ['bar', 1, 0], ['coffee', 5, 0], ['quarters_vending', 7, 0], ['stool', 1, 1], ['stool', 3, 1], ['dinerchair', 1, 3, 3], ['dinertable', 2, 3], ['dinerchair', 5, 3, 1]] },
        { w: 6, h: 3, pieces: [['bar', 0, 0], ['coffee', 4, 0], ['quarters_minifridge', 5, 0], ['stool', 0, 1], ['stool', 2, 1]] },
      ] },
    games: { name: 'a games corner', about: 'a pool table, arcade cabinets and a pinball', words: ['game', 'arcade', 'fun', 'play', 'pool', 'gaming'],
      sets: [
        { w: 8, h: 5, pieces: [['arcade', 0, 0], ['arcade2', 1, 0], ['pinball', 2, 0], ['gachapon', 7, 0], ['quarters_pooltable', 2, 3], ['stool', 7, 4]] },
        { w: 5, h: 4, pieces: [['arcade', 0, 0], ['arcade2', 1, 0], ['pinball', 2, 0], ['beanbag', 4, 3]] },
      ] },
    garden: { name: 'a garden', about: 'planters, tall plants, a terrarium and a bench', words: ['plants', 'green', 'nature', 'calm', 'zen', 'greenhouse'],
      sets: [
        { w: 8, h: 5, pieces: [['tallplant', 0, 0], ['industrial_planter', 1, 0], ['monstera', 3, 0], ['industrial_planter', 4, 0], ['tallplant', 7, 0], ['terrarium', 0, 2], ['industrial_bench', 3, 3], ['plant', 7, 3], ['monstera', 0, 4]] },
        { w: 5, h: 3, pieces: [['tallplant', 0, 0], ['industrial_planter', 1, 0], ['monstera', 4, 0], ['industrial_bench', 1, 2]] },
      ] },
    quarters: { name: 'sleeping quarters', about: 'beds, lockers, a side table and a lamp', words: ['sleep', 'bed', 'beds', 'bedroom', 'bunks', 'rest', 'dorm'],
      sets: [
        { w: 8, h: 5, pieces: [['bunk', 0, 0], ['sidetable', 2, 0], ['lavalamp', 2, 0], ['bunk', 3, 0], ['quarters_lockerbank', 5, 0], ['rug_small', 0, 2], ['plant', 7, 4]] },
        { w: 5, h: 3, pieces: [['bunk', 0, 0], ['sidetable', 2, 0], ['quarters_lockerbank', 2, 2]] },
      ] },
    storage: { name: 'storage', about: 'crates, boxes, lockers and a drawer bank', words: ['stock', 'supplies', 'inventory', 'crates', 'warehouse', 'boxes'],
      sets: [
        { w: 8, h: 4, pieces: [['industrial_locker', 0, 0], ['industrial_drawerbank', 2, 0], ['rackV', 6, 0], ['crate', 0, 2], ['boxes', 3, 3], ['crate', 6, 3]] },
        { w: 5, h: 3, pieces: [['industrial_locker', 0, 0], ['crate', 3, 0], ['boxes', 0, 2]] },
      ] },
    gym: { name: 'a gym', about: 'a heavy bag, a bench press and a locker', words: ['workout', 'fitness', 'exercise', 'training'],
      sets: [
        { w: 7, h: 4, pieces: [['punchbag', 0, 0], ['industrial_locker', 2, 0], ['tallplant', 6, 0], ['benchpress', 2, 3]] },
        { w: 5, h: 3, pieces: [['punchbag', 0, 0], ['benchpress', 2, 2]] },
      ] },
    lab: { name: 'a lab bench', about: 'a desk, a sample cart, a core lens and research papers', words: ['science', 'research', 'experiments', 'laboratory', 'analysis'],
      sets: [
        { w: 8, h: 4, pieces: [['research_corelens', 0, 0], ['desk', 2, 0], ['research_samplecart', 5, 0], ['plant', 7, 0], ['research_papers', 4, 3], ['tube', 0, 3]] },
        { w: 5, h: 3, pieces: [['desk', 0, 0], ['research_samplecart', 3, 0]] },
      ] },
    comms: { name: 'a comms desk', about: 'a console, screens and a comms dish', words: ['communications', 'radio', 'signal', 'network', 'web', 'internet'],
      sets: [
        { w: 8, h: 4, pieces: [['screens', 0, 0], ['consoleL', 2, 0], ['comms_dish', 6, 0], ['plant', 0, 3]] },
        { w: 6, h: 3, pieces: [['consoleL', 0, 0], ['screens', 4, 0]] },
      ] },
    workshop: { name: 'a workshop', about: 'a workbench, a fabricator, a toolbox and crates', words: ['maker', 'tools', 'build', 'fabrication', 'engineering', 'garage'],
      sets: [
        { w: 8, h: 4, pieces: [['workbench', 0, 0], ['toolbox', 2, 0], ['fabricator', 4, 0], ['industrial_toolcaddy', 7, 0], ['crate', 0, 3], ['boxes', 6, 3]] },
        { w: 5, h: 3, pieces: [['workbench', 0, 0], ['toolbox', 2, 0], ['crate', 3, 2]] },
      ] },
  };
  // what the approval card calls a piece where its catalog label reads badly in a sentence ("RECLINER ‹ LEFT", "BOOKS")
  const NAMES = { tv: 'TV', recliner: 'recliner', recliner_r: 'recliner', bookstack: 'book stack', coffee: 'coffee machine', quarters_vending: 'vending machine',
    arcade: 'arcade cabinet', arcade2: 'arcade cabinet', punchbag: 'heavy bag', punchbag_r: 'heavy bag', benchpress: 'bench press', benchpress_r: 'bench press',
    rackV: 'rack', consoleL: 'console', comms_dish: 'comms dish', research_papers: 'stack of papers', quarters_lockerbank: 'locker bank', boxes: 'stack of boxes',
    screens: 'screen wall', tube: 'specimen tube', bunk: 'bed', industrial_bench: 'bench', industrial_planter: 'planter', industrial_locker: 'locker' };
  const ORDER = Object.keys(STYLES);
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z]+/g, ' ').trim();

  // a style by its id, its name ("a cozy corner"), or one of its words ("comfy") — null when nothing matches
  function resolve(raw) {
    const n = norm(raw);
    if (!n) return null;
    if (STYLES[n]) return n;
    for (const id of ORDER) if (norm(STYLES[id].name) === n || norm(STYLES[id].name).replace(/^(a|an) /, '') === n) return id;
    for (const id of ORDER) if (STYLES[id].words.indexOf(n) >= 0 || n.split(' ').some(w => w === id)) return id;
    return null;
  }
  const menu = () => ORDER.map(id => ({ id, name: STYLES[id].name, about: STYLES[id].about }));

  /* WHOLE-ROOM STYLES (2026-09-30): a room furnished from wall to wall the way the hand-built showcase stations were —
     its own floor and walls, a FEATURE WALL lined with its signature pieces, a CENTREPIECE cluster, plants in the corners,
     accents along the side walls. StationLayouts.dressRoom places them: the feature wall is the one opposite the door, the
     centrepiece faces it, a lane from every door stays clear, and a piece that cannot be walked up to is left out.
     feature / front: { left, centre, right } lists of piece types lined along that wall. centre: clusters, largest first,
     [type, x, y, facing?] as in the zone sets (y grows away from the feature wall). */
  const ROOMS = {
    lounge: { name: 'a lounge', about: 'a TV, a couch on a big rug, recliners, lamps, a fish tank, a fridge, beanbags', kind: 'quarters', deck: { style: 'walnut', mat: 'plank' }, walls: { mat: 'wainscot' },
      feature: { left: ['bookshelf'], centre: ['tv'], right: ['fishtank'] },
      centre: [
        { w: 11, h: 5, pieces: [['rug_large', 3, 0], ['lowtable', 4, 2], ['couch', 3, 4], ['recliner_r', 1, 1], ['recliner', 9, 1], ['sidetable', 1, 3], ['lavalamp', 1, 3], ['sidetable', 9, 3], ['plasmaglobe', 9, 3]] },
        { w: 7, h: 4, pieces: [['rug_small', 2, 0], ['couch', 1, 3], ['sidetable', 0, 3], ['lavalamp', 0, 3], ['recliner', 6, 1]] }],
      corners: ['tallplant', 'monstera', 'plant', 'plant'], sides: ['quarters_minifridge', 'beanbag', 'coffee', 'beanbag'] },
    cozy: { name: 'a cozy den', about: 'a TV, bookshelves, a couch and beanbags on a rug, lamps, a guitar, a radio', kind: 'quarters', deck: { style: 'oak', mat: 'plank' }, walls: { mat: 'wainscot' },
      feature: { left: ['bookshelf', 'bookshelf'], centre: ['tv'], right: ['fishtank'] },
      centre: [
        { w: 9, h: 5, pieces: [['rug_large', 2, 0], ['beanbag', 3, 1], ['beanbag', 5, 1], ['couch', 2, 4], ['sidetable', 1, 4], ['lavalamp', 1, 4], ['sidetable', 7, 4], ['plasmaglobe', 7, 4], ['recliner_r', 0, 2]] },
        { w: 6, h: 4, pieces: [['rug_small', 1, 0], ['couch', 0, 3], ['sidetable', 5, 3], ['lavalamp', 5, 3]] }],
      corners: ['tallplant', 'monstera', 'plant', 'terrarium'], sides: ['beanbag', 'guitar', 'coffee', 'radio'] },
    games: { name: 'an arcade', about: 'arcade cabinets, pinballs, a jukebox, a pool table, a vending machine, speakers', kind: 'hab', deck: { style: 'violet', mat: 'hex' }, walls: { mat: 'acoustic' },
      feature: { left: ['arcade', 'arcade2', 'arcade', 'arcade2'], right: ['pinball', 'pinball', 'gachapon', 'jukebox'] },
      centre: [
        { w: 8, h: 5, pieces: [['rug_large', 1, 0], ['quarters_pooltable', 1, 1], ['stool', 7, 1], ['stool', 7, 3], ['stool', 0, 4]] },
        { w: 5, h: 3, pieces: [['quarters_pooltable', 0, 0], ['stool', 4, 2]] }],
      corners: ['speaker', 'speaker', 'plant', 'plant'], sides: ['quarters_vending', 'booth', 'holopet', 'stool'] },
    library: { name: 'a library', about: 'walls of bookshelves, a reading nook with recliners, a study table, a telescope', kind: 'quarters', deck: { style: 'oak', mat: 'parquet' }, walls: { mat: 'panelled' },
      feature: { left: ['bookshelf', 'bookshelf', 'bookshelf'], right: ['bookshelf', 'bookshelf', 'bookshelf'] },
      centre: [
        { w: 12, h: 3, pieces: [['rug', 0, 0], ['recliner_r', 0, 1], ['sidetable', 1, 1], ['desklamp', 1, 1], ['recliner', 3, 1], ['industrial_roundtable', 8, 1], ['dinerchair', 7, 1, 3], ['dinerchair', 10, 1, 1], ['bookstack', 9, 0]] },
        { w: 6, h: 3, pieces: [['rug_small', 0, 0], ['recliner_r', 1, 1], ['sidetable', 2, 1], ['bookstack', 5, 1]] }],
      corners: ['tallplant', 'monstera', 'terrarium', 'plant'], sides: ['telescope', 'bookstack', 'terrarium', 'plant'] },
    quarters: { name: 'sleeping quarters', about: 'four beds, a locker bank, bedside tables and lamps, a cryopod', kind: 'quarters', deck: { style: 'verdant', mat: 'soft' }, walls: { mat: 'wainscot' },
      feature: { left: ['bunk', 'bunk'], centre: ['quarters_lockerbank'], right: ['bunk', 'bunk'] },
      centre: [
        { w: 9, h: 3, pieces: [['sidetable', 0, 1], ['lavalamp', 0, 1], ['rug_small', 3, 0], ['sidetable', 8, 1], ['radio', 8, 1]] },
        { w: 3, h: 3, pieces: [['rug_small', 0, 0]] }],
      corners: ['tallplant', 'plant', 'plant', 'tallplant'], sides: ['cryopod', 'guitar', 'industrial_locker', 'plant'] },
    garden: { name: 'a garden', about: 'planters, tall plants, monsteras, terrariums, benches, a fish tank, a turf floor', kind: 'quarters', deck: { style: 'fern', mat: 'turf' }, walls: { mat: 'hedge' },
      feature: { left: ['industrial_planter', 'industrial_planter'], centre: ['tallplant'], right: ['industrial_planter', 'industrial_planter'] },
      front: { left: ['industrial_planter'], right: ['industrial_planter'] },
      centre: [
        { w: 10, h: 7, pieces: [['industrial_bench', 3, 0], ['arc_floorlight', 9, 0], ['monstera', 0, 2], ['terrarium', 1, 4], ['fishtank', 4, 3], ['terrarium', 8, 2], ['monstera', 9, 5], ['industrial_bench', 4, 6], ['arc_floorlight', 0, 6]] },
        { w: 6, h: 4, pieces: [['industrial_bench', 1, 0], ['monstera', 0, 2], ['terrarium', 5, 2], ['plant', 2, 3]] }],
      corners: ['tallplant', 'tallplant', 'tallplant', 'tallplant'], sides: ['monstera', 'monstera', 'plant', 'plant'] },
    cafe: { name: 'a café', about: 'a bar, coffee, a fridge, vending machines, diner tables and chairs', kind: 'hab', deck: { style: 'amber', mat: 'ceramic' }, walls: { mat: 'wainscot' },
      feature: { left: ['bar'], centre: ['coffee', 'quarters_minifridge'], right: ['quarters_vending', 'quarters_vending'] },
      centre: [
        { w: 11, h: 2, pieces: [['dinerchair', 0, 0, 3], ['dinertable', 1, 0], ['dinerchair', 4, 0, 1], ['dinerchair', 6, 0, 3], ['dinertable', 7, 0], ['dinerchair', 10, 0, 1]] },
        { w: 5, h: 2, pieces: [['dinerchair', 0, 0, 3], ['dinertable', 1, 0], ['dinerchair', 4, 0, 1]] }],
      corners: ['plant', 'tallplant', 'plant', 'plant'], sides: ['stool', 'stool', 'booth', 'plant'] },
    desks: { name: 'an office', about: 'desks (each seats its own agent), a whiteboard, bookshelves, a rack', kind: 'hab', deck: { style: 'ash', mat: 'resin' }, walls: { mat: 'panelled' },
      feature: { left: ['bookshelf'], centre: ['whiteboard'], right: ['industrial_drawerbank'] },
      centre: [
        { w: 12, h: 3, pieces: [['desk', 0, 0], ['desk', 4, 0], ['desk', 8, 0]] },
        { w: 7, h: 3, pieces: [['desk', 0, 0], ['desk', 4, 0]] }],
      corners: ['tallplant', 'plant', 'plant', 'monstera'], sides: ['rack', 'coffee', 'plant', 'bookstack'] },
    meeting: { name: 'a meeting room', about: 'a long table with chairs, a big screen, coffee', kind: 'hab', deck: { style: 'indigo', mat: 'panel' }, walls: { mat: 'panelled' },
      feature: { left: ['plant'], centre: ['bigscreen'], right: ['plant'] },
      centre: [
        { w: 9, h: 4, pieces: [['chair', 1, 0], ['chair', 4, 0], ['chair', 7, 0], ['longtable', 0, 1], ['longtable', 3, 1], ['longtable', 6, 1], ['chair', 1, 2, 2], ['chair', 4, 2, 2], ['chair', 7, 2, 2]] },
        { w: 5, h: 3, pieces: [['chair', 0, 1, 3], ['longtable', 1, 1], ['chair', 4, 1, 1]] }],
      corners: ['tallplant', 'tallplant', 'plant', 'plant'], sides: ['coffee', 'screens', 'whiteboard'] },
    lab: { name: 'a lab', about: 'a vat, specimen tubes, incubators, core lenses, a lab desk and a sample cart', kind: 'lab', deck: { style: 'sterile', mat: 'tile' }, walls: { mat: 'service' },
      feature: { left: ['vat', 'tube'], centre: ['research_corelens', 'research_trendpillar', 'research_corelens'], right: ['incubator', 'incubator'] },
      centre: [
        { w: 9, h: 3, pieces: [['desk', 0, 0], ['research_samplecart', 4, 0], ['research_papers', 7, 0]] },
        { w: 5, h: 3, pieces: [['desk', 0, 0], ['research_samplecart', 3, 0]] }],
      corners: ['plant', 'tallplant', 'plant', 'plant'], sides: ['telescope', 'research_samplecart', 'tube'] },
    workshop: { name: 'a workshop', about: 'a workbench, a fabricator, a tool bench, drawers, crates', kind: 'factory', deck: { style: 'hull', mat: 'tread' }, walls: { mat: 'pipework' },
      feature: { left: ['workbench', 'toolbox'], centre: ['fabricator'], right: ['industrial_drawerbank'] },
      centre: [
        { w: 8, h: 3, pieces: [['bench', 0, 0], ['industrial_toolcaddy', 5, 0], ['industrial_supplycart', 6, 2]] },
        { w: 4, h: 1, pieces: [['bench', 0, 0]] }],
      corners: ['crate', 'boxes', 'plant', 'crate'], sides: ['rackV', 'industrial_toolcaddy', 'rackV'] },
    comms: { name: 'a comms room', about: 'a comms wall, screens, consoles, a rack, a comms dish', kind: 'bridge', deck: { style: 'hull', mat: 'resin' }, walls: { mat: 'service' },
      feature: { left: ['screens'], centre: ['commswall'], right: ['rack'] },
      centre: [
        { w: 8, h: 2, pieces: [['consoleL', 0, 0], ['consoleL', 5, 0]] },
        { w: 3, h: 2, pieces: [['consoleL', 0, 0]] }],
      corners: ['plant', 'plant', 'plant', 'tallplant'], sides: ['comms_dish', 'screens', 'plant'] },
    storage: { name: 'a store room', about: 'lockers, racks, a shelf, stacks of crates and boxes', kind: 'storage', deck: { style: 'rust', mat: 'cargo' }, walls: { mat: 'utility' },
      feature: { left: ['industrial_locker', 'industrial_locker'], centre: ['shelf'], right: ['rackV', 'rackV'] },
      centre: [
        { w: 7, h: 4, pieces: [['crate', 0, 0], ['boxes', 3, 0], ['crate', 5, 0], ['goldcrate', 1, 3], ['boxes', 4, 3]] },
        { w: 4, h: 2, pieces: [['crate', 0, 0], ['boxes', 2, 1]] }],
      corners: ['goldcrate', 'crate', 'boxes', 'crate'], sides: ['industrial_drawerbank', 'rackV'] },
    gym: { name: 'a gym', about: 'heavy bags, bench presses on a mat, a weapon rack, lockers', kind: 'hab', deck: { style: 'crimson', mat: 'rubber' }, walls: { mat: 'ribbed' },
      feature: { left: ['punchbag', 'punchbag'], centre: ['weaponrack'], right: ['industrial_locker'] },
      centre: [
        { w: 9, h: 5, pieces: [['rug_large', 2, 0], ['benchpress', 3, 1], ['benchpress', 3, 3]] },
        { w: 5, h: 3, pieces: [['benchpress', 1, 1]] }],
      corners: ['tallplant', 'plant', 'plant', 'tallplant'], sides: ['punchbag', 'industrial_locker', 'coffee'] },
    // a hall for workflow lines: its floor is kept for the belts; the walls get crates, racks and cable
    works: { name: 'a conveyor hall', about: 'its floor kept for workflow lines, crates and racks at the walls', kind: 'factory', deck: { style: 'rust', mat: 'treadway' }, walls: { mat: 'pipework' },
      feature: { left: ['industrial_cabletray', 'industrial_cabletray', 'industrial_cabletray'], centre: ['industrial_floorvent'], right: ['industrial_cabletray', 'industrial_cabletray', 'industrial_cabletray'] },
      front: { left: ['hazardpad', 'industrial_cabletray'], right: ['industrial_cabletray', 'hazardpad'] }, centre: [],
      corners: ['crate', 'boxes', 'crate', 'boxes'], sides: ['rackV', 'rackV', 'industrial_toolcaddy', 'industrial_supplycart', 'industrial_servicecab', 'industrial_servicecab'] },
  };
  const ROOM_ORDER = ['lounge', 'cozy', 'games', 'library', 'quarters', 'garden', 'cafe', 'desks', 'meeting', 'lab', 'workshop', 'comms', 'storage', 'gym', 'works'];
  const ROOM_WORDS = { arcade: 'games', game: 'games', gaming: 'games', 'game room': 'games', rec: 'games', 'rec room': 'games', den: 'cozy', living: 'lounge', tv: 'lounge',
    office: 'desks', study: 'library', books: 'library', reading: 'library', bedroom: 'quarters', bunks: 'quarters', dorm: 'quarters', sleep: 'quarters',
    greenhouse: 'garden', atrium: 'garden', park: 'garden', kitchen: 'cafe', coffee: 'cafe', canteen: 'cafe', mess: 'cafe', 'break room': 'cafe',
    conference: 'meeting', boardroom: 'meeting', science: 'lab', research: 'lab', maker: 'workshop', engineering: 'workshop', garage: 'workshop',
    radio: 'comms', signals: 'comms', stores: 'storage', warehouse: 'storage', fitness: 'gym', training: 'gym',
    conveyor: 'works', conveyors: 'works', factory: 'works', foundry: 'works', workflow: 'works', workflows: 'works', lines: 'works', production: 'works', assembly: 'works',
    // the rooms people ask for by other names, each to the nearest of the fifteen (2026-09-30: "build anything the user wants")
    pub: 'cafe', diner: 'cafe', dining: 'cafe', cafeteria: 'cafe', restaurant: 'cafe', snack: 'cafe', food: 'cafe', shop: 'cafe', market: 'cafe', vending: 'cafe',
    sleeping: 'quarters', barracks: 'quarters', cabin: 'quarters', cabins: 'quarters', crew: 'quarters', nap: 'quarters',
    med: 'lab', medbay: 'lab', medical: 'lab', infirmary: 'lab', hospital: 'lab', clinic: 'lab', sick: 'lab', surgery: 'lab', chemistry: 'lab', biology: 'lab', observatory: 'lab', telescope: 'lab',
    server: 'comms', servers: 'comms', data: 'comms', datacenter: 'comms', control: 'comms', command: 'comms', ops: 'comms', operations: 'comms', network: 'comms', broadcast: 'comms',
    communications: 'comms', radar: 'comms', monitoring: 'comms', surveillance: 'comms', security: 'comms', mission: 'comms',
    studio: 'cozy', art: 'cozy', music: 'cozy', recording: 'cozy', jam: 'cozy', creative: 'cozy', pet: 'cozy', pets: 'cozy', nook: 'cozy',
    theater: 'lounge', theatre: 'lounge', cinema: 'lounge', movie: 'lounge', movies: 'lounge', screening: 'lounge', film: 'lounge', aquarium: 'lounge', chill: 'lounge', hangout: 'lounge', common: 'lounge', relax: 'lounge',
    classroom: 'meeting', class: 'meeting', school: 'meeting', lecture: 'meeting', seminar: 'meeting', briefing: 'meeting', council: 'meeting', war: 'meeting',
    dojo: 'gym', sparring: 'gym', boxing: 'gym', weights: 'gym', workout: 'gym', exercise: 'gym',
    spa: 'garden', zen: 'garden', meditation: 'garden', yoga: 'garden', hydroponics: 'garden', farm: 'garden', botanical: 'garden', plants: 'garden', nursery: 'garden', conservatory: 'garden',
    armory: 'storage', armoury: 'storage', supply: 'storage', supplies: 'storage', cargo: 'storage', hold: 'storage', hangar: 'storage', vault: 'storage', store: 'storage', storeroom: 'storage', pantry: 'storage',
    engine: 'workshop', reactor: 'workshop', machine: 'workshop', machinery: 'workshop', fabrication: 'workshop', fab: 'workshop', repair: 'workshop', maintenance: 'workshop', robotics: 'workshop', hardware: 'workshop',
    archive: 'library', archives: 'library', records: 'library', museum: 'library', gallery: 'library', chapel: 'library', quiet: 'library',
    coworking: 'desks', work: 'desks', desk: 'desks', cubicle: 'desks', cubicles: 'desks', bullpen: 'desks', hq: 'desks', headquarters: 'desks', admin: 'desks',
    observation: 'lounge', playroom: 'games', play: 'games', party: 'games', mancave: 'games', 'man cave': 'games', esports: 'games', casino: 'games' };
  // a whole-room style by its id or a word for it ("arcade", "conveyor hall") — null when nothing matches
  function resolveRoom(raw) {
    const full = norm(raw);
    if (!full) return null;
    if (ROOMS[full]) return full;
    if (ROOM_WORDS[full]) return ROOM_WORDS[full];   // "break room", "game room"
    const n = full.replace(/ (room|hall|area|space|bay|deck)$/, '');
    if (ROOMS[n]) return n;
    if (ROOM_WORDS[n]) return ROOM_WORDS[n];
    const ws = n.split(' ');
    for (const w of ws) if (ROOMS[w]) return w;   // a style named anywhere wins ("crew lounge")
    for (const w of ws.slice().reverse()) if (ROOM_WORDS[w]) return ROOM_WORDS[w];   // else the head word, read from the end ("mission control")
    const z = resolve(raw);
    return z && ROOMS[z] ? z : null;
  }
  const roomMenu = () => ROOM_ORDER.map(id => ({ id, name: ROOMS[id].name, about: ROOMS[id].about }));

  return { STYLES, ORDER, NAMES, resolve, menu, ROOMS, ROOM_ORDER, resolveRoom, roomMenu };
});
