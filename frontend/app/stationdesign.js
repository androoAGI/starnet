/* frontend/app/stationdesign.js — HOW A ROOM IS COMPOSED, AND HOW A DESIGN IS JUDGED (2026-11-01).

   Andrew: "better judgement of building, better design capability … prompt gorgeous amazing starnet stations". The renders of
   the older dresser showed the art was never the problem: every room stood a feature wall and one centred cluster on a big
   empty floor, pieces floated alone, papers lay on bare deck, and the only light was the ceiling's.

   Pure, zero-dep, UMD (node tests + the browser). Two halves:
   - COMPOSE: furniture arrives in VIGNETTES, groups that read as one place to be (a sofa on its rug with lamps at its ends, a
     card table with its chairs), never one by one. A room is a back wall with a rhythm, a hero vignette, then the largest
     empty floor is filled again and again, mirrored across the room when the twin fits, until the floor reads as lived in;
     then corners, real light sources in the dark places, and a floor inlay.
   - CRITIQUE: what a designer would say about any floor, on a copy, before anything is built: numbers plus findings that name
     the tile and the fix. It judges; it never refuses. A design call belongs to the model and the Commander. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StationDesign = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* VIGNETTES: [type, x, y, facing?], y grows toward the room's front. A chair west of its table faces 3, east of it 1, north
     of it 0, south of it 2. What stands on a table shares the table's tile and comes after it. Only cosmetic pieces, except
     where a style already brings that equipment (its `about` says so, and the card names it). */
  const V = {
    sofa_set: { w: 9, h: 5, p: [['rug_large', 2, 0], ['lowtable', 3, 2], ['mug', 3, 2], ['bookstack', 5, 2], ['couch', 2, 4], ['recliner_r', 1, 2], ['recliner', 7, 2], ['sidetable', 1, 4], ['lavalamp', 1, 4], ['sidetable', 7, 4], ['plasmaglobe', 7, 4]] },
    snug_sofa: { w: 7, h: 4, p: [['rug', 1, 0], ['loungetable', 2, 1], ['mug', 2, 1], ['couch', 1, 3], ['sidetable', 0, 3], ['lavalamp', 0, 3], ['sidetable', 6, 3], ['radio', 6, 3]] },
    reading_pair: { pair: true, w: 5, h: 3, p: [['rug_small', 1, 0], ['recliner_r', 1, 1], ['sidetable', 2, 1], ['desklamp', 2, 1], ['recliner', 3, 1]] },
    beanbag_pit: { w: 6, h: 3, p: [['rug', 1, 0], ['beanbag', 1, 1], ['loungetable', 2, 1], ['figurine', 2, 1], ['beanbag', 4, 1], ['beanbag', 2, 0]] },
    bar_nook: { w: 6, h: 2, wall: true, p: [['quarters_minifridge', 0, 0], ['bar', 1, 0], ['coffee', 5, 0], ['stool', 2, 1], ['stool', 3, 1]] },
    card_table: { w: 6, h: 4, p: [['pokertable', 1, 1], ['chair', 2, 0, 0], ['chair', 3, 0, 0], ['chair', 0, 1, 3], ['chair', 5, 1, 1], ['chair', 2, 3, 2], ['chair', 3, 3, 2]] },
    pool_table: { w: 8, h: 5, p: [['rug_large', 1, 0], ['quarters_pooltable', 1, 1], ['stool', 6, 1], ['stool', 6, 2], ['stool', 2, 4]] },
    dj_corner: { w: 6, h: 3, wall: true, p: [['speaker', 0, 0], ['djbooth', 1, 0], ['speaker', 5, 0], ['gigs_amp', 0, 1]] },
    cafe_four: { pair: true, repeat: true, w: 5, h: 2, p: [['dinerchair', 0, 0, 3], ['dinertable', 1, 0], ['dinerchair', 4, 0, 1], ['dinerchair', 0, 1, 3], ['dinerchair', 4, 1, 1]] },
    cafe_round: { repeat: true, w: 4, h: 1, p: [['dinerchair', 0, 0, 3], ['industrial_roundtable', 1, 0], ['mug', 1, 0], ['dinerchair', 3, 0, 1]] },
    booth_pair: { pair: true, w: 2, h: 3, wall: true, p: [['booth', 0, 0], ['loungetable', 0, 1], ['mug', 1, 1], ['booth', 0, 2, 2]] },
    study_table: { w: 9, h: 5, p: [['rug_large', 2, 0], ['chair', 2, 1, 0], ['chair', 4, 1, 0], ['chair', 6, 1, 0], ['longtable', 2, 2], ['desklamp', 2, 2], ['bookstack', 3, 2], ['longtable', 5, 2], ['research_papers', 5, 2], ['desklamp', 7, 2], ['chair', 2, 3, 2], ['chair', 4, 3, 2], ['chair', 6, 3, 2]] },
    telescope_nook: { w: 4, h: 2, p: [['telescope_r', 0, 0], ['sidetable', 2, 0], ['modelship', 2, 0], ['sidetable', 1, 1], ['bookstack', 1, 1]] },
    archive_table: { w: 5, h: 2, p: [['arc_microfiche', 0, 0], ['longtable', 2, 0], ['bookstack', 2, 0], ['desklamp', 4, 0], ['chair', 3, 1, 2]] },
    bunk_bay: { repeat: true, w: 8, h: 3, wall: true, p: [['bunk', 0, 0], ['sidetable', 2, 0], ['lavalamp', 2, 0], ['bunk', 3, 0], ['quarters_lockerbank', 5, 2]] },
    cryo_row: { pair: true, w: 5, h: 2, wall: true, p: [['cryopod', 0, 0], ['terrarium', 1, 0], ['cryopod', 2, 0], ['industrial_servicecab', 4, 0]] },
    rest_corner: { w: 6, h: 3, p: [['rug_small', 1, 0], ['beanbag', 1, 1], ['guitar', 3, 0], ['sidetable', 3, 1], ['radio', 3, 1], ['recliner', 4, 1]] },
    koi_court: { w: 8, h: 5, p: [['industrial_bench', 0, 0], ['industrial_bench', 5, 0], ['monstera', 3, 0], ['monstera', 4, 0], ['fishtank', 3, 2], ['terrarium', 2, 2], ['terrarium', 5, 2], ['industrial_bench', 2, 4], ['tallplant', 0, 3], ['tallplant', 7, 3]] },
    plant_bed: { pair: true, repeat: true, w: 5, h: 2, p: [['industrial_planter', 0, 0], ['monstera', 2, 0], ['industrial_planter', 3, 0], ['plant', 2, 1]] },
    grove: { pair: true, w: 4, h: 3, p: [['tallplant', 0, 0], ['monstera', 1, 0], ['tallplant', 3, 0], ['monstera', 0, 1], ['plant', 3, 1], ['industrial_bench', 1, 2]] },
    desk_row: { w: 12, h: 3, p: [['desk', 0, 0], ['plant', 3, 0], ['desk', 4, 0], ['plant', 7, 0], ['desk', 8, 0], ['plant', 11, 0]] },
    huddle: { pair: true, w: 4, h: 3, p: [['chair', 1, 0, 0], ['industrial_roundtable', 1, 1], ['mug', 1, 1], ['chair', 0, 1, 3], ['chair', 3, 1, 1], ['chair', 2, 2, 2]] },
    file_wall: { w: 6, h: 1, wall: true, p: [['industrial_drawerbank', 0, 0], ['industrial_drawerbank', 3, 0]] },
    boardroom: { w: 11, h: 4, p: [['chair', 2, 0, 0], ['chair', 4, 0, 0], ['chair', 6, 0, 0], ['chair', 8, 0, 0], ['chair', 0, 1, 3], ['longtable', 1, 1], ['mug', 1, 1], ['longtable', 4, 1], ['research_papers', 4, 1], ['longtable', 7, 1], ['desklamp', 9, 1], ['chair', 10, 1, 1], ['chair', 2, 2, 2], ['chair', 4, 2, 2], ['chair', 6, 2, 2], ['chair', 8, 2, 2]] },
    war_table: { w: 7, h: 4, p: [['wartable', 1, 1], ['podchair', 2, 0, 0], ['podchair', 4, 0, 0], ['podchair', 0, 1, 3], ['podchair', 6, 1, 1], ['podchair', 2, 3, 2], ['podchair', 4, 3, 2]] },
    exhibit_hall: { w: 9, h: 5, p: [['rug_large', 2, 0], ['terrarium', 3, 2], ['fishtank', 4, 2], ['terrarium', 6, 2], ['sidetable', 0, 2], ['modelship', 0, 2], ['sidetable', 8, 2], ['plasmaglobe', 8, 2], ['industrial_bench', 3, 4]] },
    display_case: { pair: true, w: 4, h: 2, p: [['sidetable', 0, 0], ['figurine', 0, 0], ['terrarium', 1, 0], ['sidetable', 2, 0], ['modelship', 2, 0], ['arc_floorlight', 3, 0]] },
    coffee_point: { w: 3, h: 2, wall: true, p: [['quarters_minifridge', 0, 0], ['coffee', 1, 0], ['quarters_vending', 2, 0]] },
    holo_core: { w: 6, h: 4, p: [['holotable', 1, 1], ['podchair', 2, 0, 0], ['podchair', 0, 1, 3], ['podchair', 5, 1, 1], ['podchair', 3, 3, 2]] },
    lab_bench: { w: 8, h: 3, p: [['desk', 0, 0], ['longtable', 4, 0], ['research_papers', 4, 0], ['deskterminal', 6, 0], ['research_samplecart', 4, 1], ['tube', 0, 2]] },
    specimen_row: { pair: true, w: 6, h: 2, wall: true, p: [['incubator', 0, 0], ['research_corelens', 1, 0], ['tube', 2, 0], ['research_trendpillar', 4, 0], ['incubator', 5, 0]] },
    sample_station: { pair: true, w: 5, h: 2, p: [['research_samplecart', 0, 0], ['longtable', 2, 0], ['mug', 2, 0], ['research_papers', 3, 0], ['stool', 3, 1]] },
    desk_nook: { w: 5, h: 3, p: [['desk', 0, 0], ['research_samplecart', 3, 0]] },
    console_nook: { w: 5, h: 3, p: [['consoleL', 0, 0], ['screens', 3, 0]] },
    bench_nook: { w: 5, h: 2, p: [['bench', 0, 0], ['industrial_toolcaddy', 4, 0]] },
    fab_bay: { w: 10, h: 4, p: [['hazardpad', 0, 2], ['hazardpad', 7, 2], ['fabricator', 3, 0], ['workbench', 0, 0], ['toolbox', 2, 0], ['industrial_toolcaddy', 7, 0], ['industrial_supplycart', 8, 0], ['steamvent', 3, 3]] },
    forge: { w: 6, h: 2, wall: true, p: [['etsy_kiln', 0, 0], ['etsy_dyevat', 2, 0], ['treasury_token_furnace', 4, 0], ['industrial_toolcaddy', 5, 0]] },
    parts_row: { pair: true, w: 7, h: 2, p: [['crate', 0, 0], ['boxes', 2, 0], ['gigs_partsbin', 4, 0], ['boxes', 0, 1], ['crt_pile', 6, 0]] },
    ops_row: { repeat: true, w: 8, h: 3, p: [['consoleL', 0, 0], ['consoleL', 5, 0], ['industrial_cabletray', 2, 2], ['cablerun', 5, 2]] },
    tactical: { w: 9, h: 6, p: [['bridge_tacticaltable', 1, 1], ['podchair', 3, 0, 0], ['podchair', 5, 0, 0], ['podchair', 0, 2, 3], ['podchair', 8, 2, 1], ['podchair', 3, 5, 2], ['podchair', 5, 5, 2]] },
    signal_rack: { w: 5, h: 2, wall: true, p: [['bridge_dispatch_pylon', 0, 0], ['arc_microfiche', 1, 0], ['bridge_orderqueue', 3, 0]] },
    lift_mat: { w: 7, h: 5, p: [['rug_large', 1, 0], ['benchpress', 2, 1], ['benchpress', 2, 3]] },
    bag_row: { pair: true, w: 5, h: 2, wall: true, p: [['punchbag', 0, 0], ['tallplant', 2, 0], ['punchbag', 4, 0]] },
    spar_ring: { w: 6, h: 4, p: [['rug', 1, 0], ['punchbag_r', 0, 0], ['punchbag', 5, 0], ['stool', 2, 3], ['stool', 3, 3]] },
    pallet_row: { repeat: true, w: 9, h: 3, p: [['crate', 0, 0], ['goldcrate', 2, 0], ['crate', 4, 0], ['boxes', 7, 0], ['boxes', 0, 2], ['crate', 2, 2], ['boxes', 4, 2], ['goldcrate', 7, 2]] },
    locker_block: { w: 6, h: 2, wall: true, p: [['industrial_locker', 0, 0], ['industrial_locker', 2, 0], ['rackV', 4, 0], ['rackV', 5, 0]] },
    supply_cart: { pair: true, w: 4, h: 2, p: [['industrial_supplycart', 0, 0], ['boxes', 2, 0], ['hazardpad', 0, 1]] },
  };

  /* RECIPES, by RoomStyles.ROOMS id. back: a centre piece and a motif walked out from it, mirrored; fill: true repeats the
     motif to the corners. hero: the room's reason to exist, largest that fits. fill: vignettes for the largest empty floor, in
     order, mirrored when the twin fits. density: how much of the floor it should read as occupied. accent: the floor style of
     the field the hero stands on. The conveyor hall has no recipe: its floor is for lines. */
  const RECIPES = {
    lounge: { back: { centre: ['tv'], motif: ['bookshelf', 'fishtank', 'bookshelf'] }, hero: ['sofa_set', 'snug_sofa'], fill: ['reading_pair', 'beanbag_pit', 'booth_pair', 'grove', 'coffee_point'], accent: 'ember', density: 0.3 },
    cozy: { back: { centre: ['tv'], motif: ['bookshelf', 'bookshelf', 'fishtank'] }, hero: ['snug_sofa', 'reading_pair'], fill: ['reading_pair', 'rest_corner', 'beanbag_pit', 'coffee_point', 'grove'], accent: 'amber', density: 0.32 },
    games: { back: { motif: ['arcade', 'arcade2', 'pinball', 'gachapon', 'jukebox', 'arcade2', 'arcade'], tight: true }, hero: ['pool_table', 'card_table'], fill: ['card_table', 'dj_corner', 'booth_pair', 'beanbag_pit', 'bar_nook'], accent: 'orchid', density: 0.32 },
    library: { back: { motif: ['bookshelf'], fill: true, tight: true }, hero: ['study_table', 'reading_pair'], fill: ['reading_pair', 'telescope_nook', 'archive_table', 'grove'], accent: 'ember', density: 0.28 },
    quarters: { back: { centre: ['quarters_lockerbank'], motif: ['bunk', 'sidetable', 'bunk'], tight: true }, hero: ['rest_corner', 'beanbag_pit'], fill: ['bunk_bay', 'cryo_row', 'rest_corner', 'grove'], accent: 'moss', density: 0.28 },
    garden: { back: { centre: ['tallplant'], motif: ['industrial_planter', 'monstera', 'industrial_planter'], fill: true, tight: true }, hero: ['koi_court', 'grove'], fill: ['plant_bed', 'grove', 'plant_bed'], accent: 'meadow', density: 0.3 },
    cafe: { back: { centre: ['bar'], motif: ['coffee', 'quarters_minifridge', 'quarters_vending', 'quarters_vending'], tight: true }, hero: ['cafe_four', 'cafe_round'], fill: ['cafe_four', 'cafe_round', 'booth_pair', 'grove'], accent: 'bone', density: 0.3 },
    desks: { back: { centre: ['whiteboard'], motif: ['bookshelf', 'chartwall'] }, hero: ['desk_row', 'desk_nook'], fill: ['huddle', 'file_wall', 'reading_pair', 'coffee_point', 'grove'], accent: 'teal', density: 0.26 },
    meeting: { back: { centre: ['bigscreen'], motif: ['plant', 'calwall'] }, hero: ['boardroom', 'huddle'], fill: ['coffee_point', 'huddle', 'grove'], accent: 'cobalt', density: 0.26 },
    lab: { back: { centre: ['research_corelens', 'research_trendpillar', 'research_corelens'], motif: ['incubator', 'tube', 'vat'], tight: true }, hero: ['holo_core', 'lab_bench'], must: { needs: ['desk'], v: ['lab_bench', 'desk_nook'] }, fill: ['sample_station', 'specimen_row', 'grove'], accent: 'teal', density: 0.28 },
    workshop: { back: { centre: ['fabricator'], motif: ['industrial_drawerbank', 'rackV', 'industrial_servicecab'], tight: true }, hero: ['fab_bay', 'bench_nook'], must: { needs: ['bench'], v: ['bench_nook'] }, fill: ['forge', 'parts_row', 'supply_cart'], accent: 'rust', density: 0.3 },
    comms: { back: { centre: ['commswall'], motif: ['screens', 'rack', 'screens'], tight: true }, hero: ['tactical', 'war_table', 'ops_row', 'console_nook'], must: { needs: ['consoleL'], v: ['ops_row', 'console_nook'] }, fill: ['signal_rack', 'coffee_point'], accent: 'cobalt', density: 0.28 },
    storage: { back: { centre: ['shelf'], motif: ['industrial_locker', 'rackV', 'rackV', 'industrial_locker'], tight: true }, hero: ['pallet_row'], fill: ['pallet_row', 'locker_block', 'supply_cart'], accent: 'rust', density: 0.34 },
    // the main room, dressed round what already works there: a bridge with nothing but its desk is the first thing anyone sees
    court: { hero: ['koi_court'], fill: ['grove', 'reading_pair', 'grove', 'reading_pair'], accent: 'meadow', density: 0.16 },
    bridge: { back: { centre: ['bigscreen'], motif: ['chartwall', 'screens'] }, hero: ['holo_core'], fill: ['huddle', 'reading_pair', 'grove', 'coffee_point', 'file_wall'], density: 0.24 },
    gym: { back: { centre: ['weaponrack'], motif: ['punchbag', 'industrial_locker', 'punchbag'], tight: true }, hero: ['lift_mat'], fill: ['spar_ring', 'bag_row', 'coffee_point'], accent: 'crimson', density: 0.28 },
  };

  /* VARIANTS: the second and third room of a style in one station, so a street of galleries is not one room stamped five times. Only the
     pieces of the composition change: a recipe's must (a style's real equipment) and accent stay. */
  const VARIANTS = {
    lounge: [{ back: { centre: ['fishtank'], motif: ['bookshelf', 'plant', 'bookshelf'] }, hero: ['beanbag_pit', 'snug_sofa'], fill: ['booth_pair', 'reading_pair', 'grove', 'coffee_point'] },
      { back: { centre: ['bigscreen'], motif: ['plant', 'bookshelf'] }, hero: ['card_table', 'snug_sofa'], fill: ['reading_pair', 'coffee_point', 'grove'] }],
    cozy: [{ back: { centre: ['fishtank'], motif: ['bookshelf', 'plant'] }, hero: ['reading_pair', 'snug_sofa'], fill: ['beanbag_pit', 'grove', 'coffee_point'] },
      { hero: ['beanbag_pit', 'snug_sofa'], fill: ['rest_corner', 'reading_pair', 'grove'] }],
    games: [{ back: { motif: ['jukebox', 'arcade', 'pinball', 'arcade', 'jukebox'], tight: true }, hero: ['card_table', 'pool_table'], fill: ['dj_corner', 'booth_pair', 'bar_nook'] },
      { back: { centre: ['bigscreen'], motif: ['arcade2', 'gachapon'], tight: true }, hero: ['beanbag_pit', 'card_table'], fill: ['bar_nook', 'dj_corner', 'card_table'] }],
    library: [{ back: { motif: ['chartwall', 'bookshelf', 'chartwall'] }, hero: ['exhibit_hall', 'telescope_nook'], fill: ['display_case', 'telescope_nook', 'grove'] },
      { back: { centre: ['bigscreen'], motif: ['bookshelf', 'plant'] }, hero: ['archive_table', 'reading_pair'], fill: ['display_case', 'archive_table', 'reading_pair', 'grove'] }],
    quarters: [{ hero: ['beanbag_pit', 'rest_corner'], fill: ['cryo_row', 'bunk_bay', 'grove'] },
      { hero: ['reading_pair', 'rest_corner'], fill: ['bunk_bay', 'rest_corner', 'grove'] }],
    garden: [{ hero: ['grove', 'koi_court'], fill: ['koi_court', 'plant_bed', 'reading_pair'] },
      { back: { motif: ['monstera', 'tallplant'], fill: true, tight: true }, hero: ['plant_bed', 'grove'], fill: ['reading_pair', 'grove', 'plant_bed'] }],
    cafe: [{ hero: ['cafe_round', 'cafe_four'], fill: ['booth_pair', 'cafe_round', 'grove'] },
      { back: { centre: ['quarters_vending'], motif: ['coffee', 'plant', 'quarters_minifridge'], tight: true }, hero: ['card_table', 'cafe_round'], fill: ['booth_pair', 'coffee_point', 'grove'] }],
    desks: [{ back: { centre: ['bigscreen'], motif: ['plant', 'calwall'] }, fill: ['reading_pair', 'huddle', 'grove'] },
      { back: { centre: ['chartwall'], motif: ['whiteboard', 'bookshelf'] }, hero: ['boardroom', 'desk_row'], fill: ['desk_nook', 'file_wall', 'grove'] }],
    meeting: [{ back: { centre: ['whiteboard'], motif: ['plant', 'chartwall'] }, hero: ['war_table', 'huddle'], fill: ['grove', 'coffee_point'] },
      { hero: ['huddle'], fill: ['huddle', 'reading_pair', 'grove'] }],
    lab: [{ hero: ['lab_bench', 'holo_core'], fill: ['specimen_row', 'sample_station', 'grove'] },
      { hero: ['sample_station', 'lab_bench'], fill: ['holo_core', 'specimen_row', 'grove'] }],
    workshop: [{ hero: ['bench_nook', 'fab_bay'], fill: ['parts_row', 'forge', 'supply_cart'] },
      { fill: ['supply_cart', 'parts_row', 'bench_nook'] }],
    comms: [{ hero: ['war_table', 'tactical', 'ops_row'], fill: ['coffee_point', 'signal_rack'] },
      { hero: ['ops_row', 'console_nook'], fill: ['war_table', 'signal_rack'] }],
    storage: [{ hero: ['supply_cart', 'pallet_row'], fill: ['pallet_row', 'locker_block'] },
      { back: { motif: ['rackV', 'industrial_locker'], fill: true, tight: true }, fill: ['supply_cart', 'parts_row'] }],
    gym: [{ hero: ['spar_ring', 'lift_mat'], fill: ['lift_mat', 'bag_row'] },
      { fill: ['bag_row', 'grove', 'coffee_point'] }],
  };
  // the n-th room of a style: the recipe itself, then its variants, then round again
  const variantOf = (id, n) => { const base = RECIPES[id], v = VARIANTS[id], k = v && n ? n % (v.length + 1) : 0; return k ? Object.assign({}, base, v[k - 1]) : base; };

  /* THEMES: one palette for a whole station, so it reads as one place. Each room takes its family's floor and walls; corridors,
     hull and the inlay follow. A theme changes materials only: never a piece, so never what a room can do. */
  const FAMILY = { lounge: 'living', cozy: 'living', quarters: 'living', library: 'living', cafe: 'living', desks: 'work', meeting: 'work', lab: 'work', comms: 'work', workshop: 'heavy', works: 'heavy', storage: 'heavy', gym: 'heavy', games: 'play', garden: 'green' };
  const THEMES = {
    noir: { plan: 'enfilade', name: 'Noir', about: 'black stone, oxblood walls, deep shadow and pools of lamplight', words: ['dark', 'moody', 'black', 'shadow', 'luxury', 'sleek', 'detective'], accent: 'oxblood', corridor: { style: 'onyx', mat: 'runner', walls: { style: 'onyx', mat: 'panelled' } }, hull: { mat: 'monocoque' },
      living: { deck: { style: 'onyx', mat: 'parquet' }, walls: { style: 'oxblood', mat: 'panelled' } }, work: { deck: { style: 'onyx', mat: 'basalt' }, walls: { style: 'oxblood', mat: 'acoustic' } }, heavy: { deck: { style: 'onyx', mat: 'slotted' }, walls: { style: 'onyx', mat: 'braced' } }, play: { deck: { style: 'oxblood', mat: 'hex' }, walls: { style: 'oxblood', mat: 'acoustic' } }, green: { deck: { style: 'moss', mat: 'turf' }, walls: { style: 'moss', mat: 'hedge' } } },
    observatory: { plan: 'pinwheel', name: 'Observatory', about: 'deep blue decks and viewport walls looking out on the stars', words: ['space', 'stars', 'starship', 'cosmic', 'astronomy', 'window', 'windows', 'view', 'celestial', 'galaxy'], accent: 'sapphire', corridor: { style: 'royal', mat: 'meshway', walls: { style: 'cobalt', mat: 'viewport' } }, hull: { mat: 'curtain' },
      living: { deck: { style: 'royal', mat: 'lunar' }, walls: { style: 'sapphire', mat: 'viewport' } }, work: { deck: { style: 'sapphire', mat: 'octile' }, walls: { style: 'royal', mat: 'viewport' } }, heavy: { deck: { style: 'cobalt', mat: 'maggrid' }, walls: { style: 'cobalt', mat: 'pressure' } }, play: { deck: { style: 'plum', mat: 'lunar' }, walls: { style: 'royal', mat: 'viewport' } }, green: { deck: { style: 'fern', mat: 'turf' }, walls: { style: 'fern', mat: 'viewport' } } },
    biolab: { plan: 'campus', name: 'Biolab', about: 'clean white ceramic, jade lines, a place of careful experiments', words: ['clean', 'white', 'clinical', 'hospital', 'science', 'sterile', 'medical', 'minimal'], accent: 'jade', corridor: { style: 'bone', mat: 'terrazzo', walls: { style: 'white', mat: 'service' } }, hull: { mat: 'ceramic' },
      living: { deck: { style: 'bone', mat: 'terrazzo' }, walls: { style: 'white', mat: 'plating' } }, work: { deck: { style: 'white', mat: 'ceramic' }, walls: { style: 'white', mat: 'service' } }, heavy: { deck: { style: 'ash', mat: 'tile' }, walls: { style: 'bone', mat: 'service' } }, play: { deck: { style: 'jade', mat: 'hex' }, walls: { style: 'white', mat: 'plating' } }, green: { deck: { style: 'meadow', mat: 'turf' }, walls: { style: 'meadow', mat: 'hedge' } } },
    neon: { plan: 'colony', name: 'Neon', about: 'plum and magenta decks that come alive under arcade light', words: ['cyberpunk', 'synthwave', 'vaporwave', 'arcade', 'club', 'nightclub', 'vibrant', 'purple', 'party', 'retro'], accent: 'magenta', corridor: { style: 'plum', mat: 'meshway', walls: { style: 'plum', mat: 'ribbed' } }, hull: { mat: 'thermal' },
      living: { deck: { style: 'plum', mat: 'parquet' }, walls: { style: 'magenta', mat: 'acoustic' } }, work: { deck: { style: 'royal', mat: 'hex' }, walls: { style: 'plum', mat: 'ribbed' } }, heavy: { deck: { style: 'onyx', mat: 'treadway' }, walls: { style: 'plum', mat: 'machinery' } }, play: { deck: { style: 'magenta', mat: 'hex' }, walls: { style: 'plum', mat: 'acoustic' } }, green: { deck: { style: 'jade', mat: 'turf' }, walls: { style: 'jade', mat: 'hedge' } } },
    timber: { plan: 'enfilade', name: 'Timber', about: 'warm wood floors and wainscot, a lodge among the stars', words: ['cozy', 'warm', 'wood', 'wooden', 'cabin', 'lodge', 'rustic', 'home', 'homely', 'autumn'], accent: 'honey', corridor: { style: 'walnut', mat: 'plank', walls: { style: 'walnut', mat: 'wainscot' } }, hull: { mat: 'timber' },
      living: { deck: { style: 'oak', mat: 'parquet' }, walls: { style: 'walnut', mat: 'wainscot' } }, work: { deck: { style: 'walnut', mat: 'plank' }, walls: { style: 'oak', mat: 'panelled' } }, heavy: { deck: { style: 'ember', mat: 'plank' }, walls: { style: 'ember', mat: 'courses' } }, play: { deck: { style: 'walnut', mat: 'parquet' }, walls: { style: 'honey', mat: 'wainscot' } }, green: { deck: { style: 'fern', mat: 'turf' }, walls: { style: 'fern', mat: 'hedge' } } },
    foundry: { plan: 'axis', name: 'Foundry', about: 'rust, copper and pipework, heavy industry with fire in it', words: ['industrial', 'factory', 'steampunk', 'rust', 'gritty', 'mechanical', 'engine', 'forge', 'dieselpunk'], accent: 'honey', corridor: { style: 'rust', mat: 'treadway', walls: { style: 'rust', mat: 'pipework' } }, hull: { mat: 'heatsink' },
      living: { deck: { style: 'copper', mat: 'plate' }, walls: { style: 'rust', mat: 'pipework' } }, work: { deck: { style: 'rust', mat: 'tread' }, walls: { style: 'copper', mat: 'machinery' } }, heavy: { deck: { style: 'rust', mat: 'cargo' }, walls: { style: 'copper', mat: 'radiator' } }, play: { deck: { style: 'oxblood', mat: 'plate' }, walls: { style: 'rust', mat: 'pipework' } }, green: { deck: { style: 'moss', mat: 'turf' }, walls: { style: 'rust', mat: 'pipework' } } },
    solarpunk: { plan: 'colony', name: 'Solarpunk', about: 'living walls, turf and warm light, a greenhouse people work in', words: ['green', 'nature', 'garden', 'plants', 'eco', 'organic', 'forest', 'jungle', 'botanical', 'greenhouse'], accent: 'meadow', corridor: { style: 'moss', mat: 'runner', walls: { style: 'verdant', mat: 'hedge' } }, hull: { mat: 'hedge' },
      living: { deck: { style: 'oak', mat: 'plank' }, walls: { style: 'verdant', mat: 'hedge' } }, work: { deck: { style: 'jade', mat: 'soft' }, walls: { style: 'oak', mat: 'wainscot' } }, heavy: { deck: { style: 'moss', mat: 'grate' }, walls: { style: 'moss', mat: 'hedge' } }, play: { deck: { style: 'fern', mat: 'soft' }, walls: { style: 'jade', mat: 'hedge' } }, green: { deck: { style: 'meadow', mat: 'turf' }, walls: { style: 'meadow', mat: 'hedge' } } },
    flagship: { plan: 'court', name: 'Flagship', about: 'sapphire command decks, bright flight lines, the bridge of a capital ship', words: ['navy', 'command', 'military', 'scifi', 'ship', 'bridge', 'blue', 'capital', 'fleet'], accent: 'royal', corridor: { style: 'cobalt', mat: 'flightdeck', walls: { style: 'cobalt', mat: 'bulkhead' } }, hull: { mat: 'station' },
      living: { deck: { style: 'sapphire', mat: 'panel' }, walls: { style: 'cobalt', mat: 'panelled' } }, work: { deck: { style: 'sapphire', mat: 'flightdeck' }, walls: { style: 'cobalt', mat: 'bulkhead' } }, heavy: { deck: { style: 'hull', mat: 'maggrid' }, walls: { style: 'cobalt', mat: 'pressure' } }, play: { deck: { style: 'royal', mat: 'hex' }, walls: { style: 'sapphire', mat: 'ribbed' } }, green: { deck: { style: 'fern', mat: 'turf' }, walls: { style: 'cobalt', mat: 'viewport' } } },
    brutalist: { plan: 'terrace', name: 'Brutalist', about: 'pale concrete terrazzo and ribbed walls, huge and calm', words: ['concrete', 'stone', 'minimalist', 'monumental', 'grey', 'gray', 'austere', 'modernist'], accent: 'oxblood', corridor: { style: 'concrete', mat: 'basalt', walls: { style: 'concrete', mat: 'braced' } }, hull: { mat: 'stone' },
      living: { deck: { style: 'limestone', mat: 'terrazzo' }, walls: { style: 'concrete', mat: 'ribbed' } }, work: { deck: { style: 'concrete', mat: 'basalt' }, walls: { style: 'limestone', mat: 'braced' } }, heavy: { deck: { style: 'hull', mat: 'basalt' }, walls: { style: 'hull', mat: 'braced' } }, play: { deck: { style: 'oxblood', mat: 'terrazzo' }, walls: { style: 'limestone', mat: 'ribbed' } }, green: { deck: { style: 'moss', mat: 'turf' }, walls: { style: 'concrete', mat: 'braced' } } },
  };
  /* THE ARCHITECTURES: how a station's rooms relate. The model picks one for the brief; a palette with no plan named takes its own. */
  const ARCHITECTURES = [
    { id: 'diamond', about: 'An even grid all round the main room with a corridor loop at its centre: formal, symmetrical, easy to grow.', suits: 'a civic or ceremonial station' },
    { id: 'concourse', about: 'One wide corridor off one side of the main room, rooms down both sides, a big room at the far end.', suits: 'a street of shops, a journey toward one big destination' },
    { id: 'axis', about: 'A corridor out of both ends of the main room, which stands amidships, rooms down both sides.', suits: 'a ship, a long and purposeful place' },
    { id: 'enfilade', about: 'No long corridors: each room opens into the next through a short passage, doubling back when the line runs long. You walk through everything.', suits: 'a private home, a gallery, a story told in sequence' },
    { id: 'colony', about: 'Grown: rooms of different sizes bud off one another near the middle, never quite in line.', suits: 'an organic, lived-in, unplanned place' },
    { id: 'campus', about: 'Separate pods standing apart, each a small plaza with rooms round it, on long bridges from the main room.', suits: 'teams that work apart, labs, things kept separate on purpose' },
    { id: 'pinwheel', about: 'Four off-centre corridors each carry their rooms to one side, so the plan turns around the main room.', suits: 'a station with energy, something that should not feel static' },
    { id: 'court', about: 'One big open square off the main room, with every room opening onto it: the biggest across it, the rest along its sides.', suits: 'a town square, a club, a flagship, people meeting by chance' },
    { id: 'terrace', about: 'Rooms stepping away from the main room in two diagonal flights, each overlapping the last by little more than its door.', suits: 'housing, a hillside, a bold diagonal silhouette' },
  ];
  const THEME_ORDER = Object.keys(THEMES);
  const lower = s => String(s == null ? '' : s).toLowerCase().trim();
  // a theme by its id, its name or a word in the Commander's own phrase ("moody cyberpunk"): null when nothing matches
  function resolveTheme(raw) {
    const n = lower(raw); if (!n) return null;
    if (THEMES[n]) return n;
    const ws = n.split(/[^a-z-]+/).filter(Boolean);
    for (const id of THEME_ORDER) if (ws.indexOf(id) >= 0) return id;
    let best = null, most = 0;
    for (const id of THEME_ORDER) { const n2 = THEMES[id].words.filter(w => ws.indexOf(w) >= 0).length; if (n2 > most) { most = n2; best = id; } }
    return best;
  }
  const themeMenu = () => THEME_ORDER.map(id => ({ id, name: THEMES[id].name, about: THEMES[id].about }));
  // a room style's record in a theme: its pieces as ever, its floor and walls the theme's
  function themed(rec, styleId, themeId) {
    const th = THEMES[themeId]; if (!rec || !th) return rec;
    const f = th[FAMILY[styleId] || 'work'];
    return Object.assign({}, rec, { deck: f.deck, walls: f.walls });
  }
  const themeOfKind = (themeId, kind) => { const th = THEMES[themeId]; if (!th) return null; return th[{ quarters: 'living', hab: 'work', bridge: 'work', lab: 'work', factory: 'heavy', storage: 'heavy' }[kind] || 'work']; };

  /* FROM A PREBUILD: a preset's rooms as a layout's rooms, so the model starts from a station that already works and designs on
     from it. A kit with a line stays a line (the preset's own, with its instructions); the rest become the whole-room style nearest
     what the kit was. Kit ids are StationTemplates' own. */
  const KIT_STYLE = { cozyLounge: 'lounge', reading: 'library', creative: 'desks', review: 'meeting', engineering: 'workshop', comms: 'comms', archive: 'library' };
  function prebuildRooms(T, presetId) {
    const ks = T && T.presetKits ? T.presetKits(presetId) : [], all = T && T.kits ? T.kits() : [];
    return ks.map(id => {
      const k = all.find(x => x.id === id); if (!k) return null;
      if (k.line) return { name: k.name, size: 'large', lines: [{ line: k.line.bp, name: k.line.label, staff: Object.keys(k.line.briefs || {}).map(role => ({ role, instructions: k.line.briefs[role] })) }] };
      return { name: k.name, style: KIT_STYLE[id] || 'lounge' };
    }).filter(Boolean);
  }

  /* THE DESIGN GUIDE: what station.map { guide: true } hands the model before a big design: how to think, not what to place. */
  const GUIDE = [
    'Start from the brief. Name in a sentence what this station is, who works in it and how it should feel; every choice below serves that sentence.',
    'Choose the architecture before the rooms: pattern is the biggest decision you make. The ring is one choice of nine, and rarely the most interesting: match it to the brief (the guide says what each suits).',
    'One palette: pick a theme and stay in it. Depart from it for one room at most, on purpose.',
    'One heart: every station has a room it is for. Make that room bigger (size large or { w, h }), give it the best spot, and let lesser rooms be small (a store, quarters). Rooms all one size read as a grid, not a place.',
    'Walk it: think of arriving from the bridge. What is seen first, where does the corridor lead the eye, what is at the end of it? Work rooms near the hub, quiet rooms further out, a line’s hall on a wing with room to grow.',
    'Compose in groups, never single pieces: a sofa on its rug with lamps at its ends, a table with its chairs. A piece standing alone in open floor reads as a mistake.',
    'A back wall has a rhythm: a centre piece framed by open wall, then matching pieces outward. North walls show their faces; a door there frames the view.',
    'A quarter to a third of a room’s floor should hold something. Under that it reads empty, over half it reads crowded. Leave a clear walk from each door to the room’s main group.',
    'Light makes the mood: something that glows beside each main group (arc_floorlight, a lamp on a table, a tank, a screen) so a room has pools of light and dark, not one flat wash.',
    'Small things stand on tables, never on the deck: mugs, papers, lamps, book stacks.',
    'Equipment is real: a desk, rack, dish or workbench gives the room’s agents a capability. Place what the room needs and no more; cosmetic pieces are free.',
    'Build, then judge: read the plan’s design review before building, look at the result, and refit what is wrong before you tell the Commander it is done. A review is advice, your eye decides.',
  ];

  const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const tileKey = (x, y) => x + ',' + y;

  /* the largest empty rectangle of a boolean grid (true = taken): the classic histogram sweep */
  function largestRect(grid, W, H) {
    const heights = new Array(W).fill(0);
    let best = null;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) heights[x] = grid[y][x] ? 0 : heights[x] + 1;
      const stack = [];
      for (let x = 0; x <= W; x++) {
        const h = x < W ? heights[x] : 0;
        let start = x;
        while (stack.length && stack[stack.length - 1][1] >= h) {
          const [s, sh] = stack.pop();
          const area = sh * (x - s);
          // ties go to the squarer space: a long sliver is a walkway, not a place to furnish
          if (sh && (!best || area > best.area || (area === best.area && Math.abs(sh - (x - s)) < Math.abs(best.h - best.w)))) best = { x: s, y: y - sh + 1, w: x - s, h: sh, area };
          start = s;
        }
        if (h) stack.push([start, h]);
      }
    }
    return best;
  }

  /* COMPOSE a room. c: { R, S, doors, occ, belts, reserve, add, blocks, twinOf, recipe, seed }. add/blocks are the dresser's own, so
     every placing rule (a desk's seat row, a doorway's lane, what stands on what) holds exactly as it does for any other piece. */
  function compose(c) {
    const { R, S, doors, occ, belts, reserve, add, blocks, twinOf, recipe, seed } = c;
    const W = R.x2 - R.x1 + 1, H = R.y2 - R.y1 + 1, area = W * H, placedBefore = c.placed.length;
    const northDoors = doors.filter(d => d.dy > 0), mid = R.x1 + ((W - 1) >> 1);
    // the walk from each doorway to the heart of the room stays open: floor nobody furnishes. It is laid once the hero stands, and
    // stops at the hero's edge, so the room's centre holds its reason to exist and not an empty crossing
    const lane = new Set();
    const layLanes = hero => {
      const tx = hero ? Math.min(Math.max((R.x1 + R.x2) >> 1, hero.x - 1), hero.x + hero.w) : (R.x1 + R.x2) >> 1, ty = hero ? Math.min(Math.max((R.y1 + R.y2) >> 1, hero.y - 1), hero.y + hero.h) : (R.y1 + R.y2) >> 1;
      const inHero = (x, y) => hero && x >= hero.x && x < hero.x + hero.w && y >= hero.y && y < hero.y + hero.h;
      for (const d of doors) {
        let x = d.x, y = d.y, guard = 0;
        while (guard++ < 200 && (x !== tx || y !== ty)) {
          lane.add(tileKey(x, y));
          let nx = x, ny = y;
          if (d.dy && y !== ty) ny += Math.sign(ty - y); else if (d.dx && x !== tx) nx += Math.sign(tx - x); else if (y !== ty) ny += Math.sign(ty - y); else nx += Math.sign(tx - x);
          if (inHero(nx, ny)) break;
          x = nx; y = ny;
        }
      }
    };
    // every wall keeps a stretch at its middle clear: a room furnished wall to wall could never take another hallway, or a new desk
    const midY = (R.y1 + R.y2) >> 1, midX = (R.x1 + R.x2) >> 1;
    for (let k = -2; k <= 1; k++) for (let d = 0; d < 2; d++) {
      lane.add(tileKey(R.x1 + d, midY + k)); lane.add(tileKey(R.x2 - d, midY + k));
      lane.add(tileKey(midX + k, R.y2 - d));
    }
    const northSlot = (x, w) => recipe.back && recipe.back.centre ? false : x <= midX + 1 && x + w - 1 >= midX - 2;
    const freeOf = (sp, x, y) => {
      if (blocks(sp, x, y)) return false;
      if (sp.blocks === false) return true;
      for (let yy = y; yy < y + sp.h; yy++) for (let xx = x; xx < x + sp.w; xx++) if (lane.has(tileKey(xx, yy))) return false;
      return true;
    };
    // ---- the back wall: a centre piece, then the motif walked outward both ways, so it reads as one composed wall
    let depth = 0;
    const backRow = sp => R.y1;
    const back = recipe.back || {};
    const clearsNorthDoor = (x, w) => !northSlot(x, w) && !northDoors.some(d => d.x >= x - 1 && d.x <= x + w);
    const centre = (back.centre || []).map(t => S.spec(t)).filter(Boolean), cw = centre.reduce((n, s) => n + s.w, 0);
    let spanL = mid + 1, spanR = mid;
    if (centre.length) {
      const offs = [0]; for (let k = 1; k < W; k++) offs.push(-k, k);
      const types = (back.centre || []).filter(t => S.spec(t));
      for (const o of offs) {
        const x0 = R.x1 + ((W - cw) >> 1) + o;
        if (x0 < R.x1 + 1 || x0 + cw - 1 > R.x2 - 1 || !clearsNorthDoor(x0, cw)) continue;
        let x = x0, fits = true;
        for (const sp of centre) { if (!freeOf(sp, x, backRow(sp))) { fits = false; break; } x += sp.w; }
        if (!fits) continue;
        x = x0;
        types.forEach(t => { const sp = S.spec(t); if (add(t, x, backRow(sp), 0)) depth = Math.max(depth, sp.h); x += sp.w; });
        spanL = x0; spanR = x0 + cw - 1;
        break;
      }
    }
    const gap = back.tight ? 0 : 1, motif = (back.motif || []).filter(t => S.spec(t));
    if (motif.length) {
      // the wall either side of a centre piece stays open for three tiles: a frame for it, and where a hallway can still open later
      const frame = centre.length ? (W >= 16 ? 3 : gap) : 0;
      let xl = spanL - 1 - frame, xr = spanR + 1 + frame, i = 0;
      const limit = back.fill ? 40 : motif.length;
      while (i < limit) {
        const t = motif[i % motif.length], sp = S.spec(t);
        if (!sp) break;
        let moved = false;
        // left of the centre, then its mirror on the right; a doorway's lane steps the run past it
        for (let step = 0; step < 6 && xl - sp.w + 1 >= R.x1 + 1; step++) {
          const px = xl - sp.w + 1;
          if (clearsNorthDoor(px, sp.w) && freeOf(sp, px, backRow(sp)) && add(t, px, backRow(sp), 0)) { depth = Math.max(depth, sp.h); xl = px - 1 - gap; moved = true; break; }
          xl--;
        }
        for (let step = 0; step < 6 && xr + sp.w - 1 <= R.x2 - 1; step++) {
          if (clearsNorthDoor(xr, sp.w) && freeOf(sp, xr, backRow(sp)) && add(t, xr, backRow(sp), 0)) { depth = Math.max(depth, sp.h); xr = xr + sp.w + gap; moved = true; break; }
          xr++;
        }
        if (!moved) break;
        i++;
      }
    }
    // ---- vignettes
    const mirrored = v => ({ w: v.w, h: v.h, wall: v.wall, p: v.p.map(([t, x, y, r]) => {
      const sp = S.spec(t); if (!sp) return [t, x, y, r];
      const nr = r === 1 ? 3 : r === 3 ? 1 : r;
      return [twinOf(S, t) || t, v.w - x - sp.w, y, nr];
    }) });
    const placeSet = (v, ax, ay) => {
      const ps = v.p.map(([t, x, y, r]) => { const sp = S.spec(t); return sp ? { t, x: ax + x, y: ay + y, r: r || 0, sp } : null; }).filter(Boolean);
      if (!ps.length) return false;
      const solid = p => p.sp.blocks !== false && !p.sp.stack && p.sp.mount !== 'surface';
      // every solid piece has its floor, or the group does not stand here at all: half a group reads as a mistake
      if (ps.some(p => solid(p) && !freeOf(p.sp, p.x, p.y))) return false;
      const rank = p => p.sp.flat ? 0 : (p.sp.stack || p.sp.mount === 'surface') ? 2 : 1;
      let n = 0;
      for (const p of ps.slice().sort((a, b) => rank(a) - rank(b))) if (add(p.t, p.x, p.y, p.r)) n++;
      return n > 0;
    };
    const vs = names => (names || []).map(n => V[n]).filter(Boolean);
    let hero = null;
    const top = R.y1 + depth + 1, northLane = northDoors.length ? 3 : 0;
    for (const v of vs(recipe.hero)) {
      if (v.w > W - 2) continue;
      const y0 = Math.max(top, R.y1 + northLane), span = R.y2 - 1 - y0 + 1;
      if (v.h > span) continue;
      const ax = R.x1 + ((W - v.w) >> 1), ay = y0 + Math.max(0, (span - v.h) >> 1);
      const tries = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0], [-2, 0], [2, 0], [-3, 0], [3, 0], [-4, 0], [4, 0], [-2, 1], [2, 1], [-2, -1], [2, -1], [-5, 0], [5, 0], [-5, 1], [5, 1]];
      for (const [dx, dy] of tries) if (ax + dx >= R.x1 && ax + dx + v.w - 1 <= R.x2 && ay + dy >= top && ay + dy + v.h - 1 <= R.y2 && placeSet(v, ax + dx, ay + dy)) { hero = { x: ax + dx, y: ay + dy, w: v.w, h: v.h }; break; }
      if (hero) break;
    }
    layLanes(hero);
    // what the room is FOR stands whatever else fits: a prop is a capability, and a lab with no desk is a lie about what it can do
    const queuedMust = recipe.must && !c.placed.concat(c.existing || []).some(p => recipe.must.needs.indexOf(p.t) >= 0) ? vs(recipe.must.v) : [];
    // ---- fill the largest empty floor, again and again, until the room reads as occupied
    const coverage = () => {
      let n = 0;
      for (let y = R.y1; y <= R.y2; y++) for (let x = R.x1; x <= R.x2; x++) { const o = occ.get(tileKey(x, y)); if (o === 'flat') n += 0.4; else if (o) n += 1; }
      return n / area;
    };
    const skip = new Set();
    let pad = 2;
    let mustDone = !queuedMust.length;
    const gridNow = () => {
      const g = []; for (let y = 0; y < H; y++) g.push(new Array(W).fill(false));
      const take = (x, y) => { const gx = x - R.x1, gy = y - R.y1; if (gx >= 0 && gy >= 0 && gx < W && gy < H) g[gy][gx] = true; };
      for (let y = R.y1; y <= R.y2; y++) for (let x = R.x1; x <= R.x2; x++) {
        const k = tileKey(x, y);
        if (lane.has(k) || reserve.has(k) || belts[k] || skip.has(k)) take(x, y);
        // a clear tile all round what stands, so groups read as separate and a person fits between them
        // (what hangs on a wall takes no floor, so it keeps none clear)
        if ((occ.has(k) && !(occ.get(k) === 'other' && y === R.y1)) || belts[k]) for (let q = -pad; q <= pad; q++) for (let w = -pad; w <= pad; w++) if (Math.abs(q) + Math.abs(w) <= pad) take(x + w, y + q);
      }
      // the front row stays clear too: the hull's wall face hides what stands against it
      return g;
    };
    const queue = vs(recipe.fill), target = recipe.density || 0.26, used = new Set();
    let turn = seed % Math.max(1, queue.length);
    let again = area < 300 ? 0 : 3, spare = 0;
    const SPARE = vs(['grove', 'reading_pair', 'coffee_point']);
    const block = (X0, Y0, rect) => { for (let y = Y0; y < Y0 + rect.h; y++) for (let x = X0; x < X0 + rect.w; x++) skip.add(tileKey(x, y)); };
    const hasNeed = () => recipe.must && c.placed.some(p => recipe.must.needs.indexOf(p.t) >= 0);
    for (const v of queuedMust) {
      if (mustDone) break;
      const rect = largestRect(gridNow(), W, H);
      if (rect && v.w <= rect.w && v.h <= rect.h && placeSet(v, rect.x + R.x1 + ((rect.w - v.w) >> 1), rect.y + R.y1 + ((rect.h - v.h) >> 1))) mustDone = hasNeed();
      // no open rectangle takes it: anywhere its own pieces can stand
      for (let y = R.y1; !mustDone && y + v.h - 1 <= R.y2; y++) for (let x = R.x1; !mustDone && x + v.w - 1 <= R.x2; x++) if (placeSet(v, x, y)) mustDone = hasNeed();
    }
    // still nothing (a small room, its floor all doorway): the piece itself, wherever the room's own rules let it stand
    if (!mustDone && queuedMust.length) {
      const t = recipe.must.needs[0], sp = S.spec(t);
      for (let y = R.y1; sp && !mustDone && y + sp.h - 1 <= R.y2; y++) for (let x = R.x1; !mustDone && x + sp.w - 1 <= R.x2; x++) if (!blocks(sp, x, y)) mustDone = add(t, x, y, 0);
    }
    for (let round = 0; round < (area >= 300 ? 48 : 24) && coverage() < target; round++) {
      const rect = largestRect(gridNow(), W, H);
      if ((!rect || rect.area < 6) && area >= 300 && pad === 2 && coverage() < target * 0.75) { pad = 1; skip.clear(); used.clear(); again = 1; continue; }
      if (!rect || rect.area < 6) break;
      const X0 = rect.x + R.x1, Y0 = rect.y + R.y1;
      const onWallRow = Y0 <= R.y1 + depth + 1, onFront = Y0 + rect.h - 1 >= R.y2;
      // the next group in turn that fits and has not stood here yet. Three bars in one lounge read as a bug, so a group stands once
      // unless it is the kind a room has several of (café tables, planters). A wall group needs a wall behind it.
      let pick = null;
      for (let k = 0; k < queue.length; k++) {
        const v = queue[(turn + k) % queue.length];
        if (v.w > rect.w || v.h > rect.h || (used.has(v) && !v.repeat) || (v.wall && !onWallRow && !onFront)) continue;
        pick = v; turn = (turn + k + 1) % queue.length; break;
      }
      if (!pick && again > 0) { again--; used.clear(); continue; }
      if (!pick && area >= 300 && pad === 2 && coverage() < target * 0.75) { pad = 1; skip.clear(); used.clear(); again = 1; continue; }
      if (!pick && area >= 300 && spare < 4) for (const v of SPARE) if (v.w <= rect.w && v.h <= rect.h && (!v.wall || onWallRow || onFront)) { pick = v; spare++; break; }
      if (!pick) { block(X0, Y0, rect); continue; }
      const ax = X0 + ((rect.w - pick.w) >> 1), ay = pick.wall ? (onWallRow ? Y0 : Y0 + rect.h - pick.h) : Y0 + ((rect.h - pick.h) >> 1);
      const onLeft = ax + pick.w / 2 < R.x1 + W / 2;
      if (!placeSet(onLeft ? pick : mirrored(pick), ax, ay)) { block(X0, Y0, rect); continue; }
      used.add(pick);
      // its twin across the room, when it is the kind that pairs and the twin's floor is free
      const mx = R.x1 + R.x2 - (ax + pick.w - 1);
      if (pick.pair && Math.abs(mx - ax) >= pick.w) placeSet(onLeft ? mirrored(pick) : pick, mx, ay);
    }
    // ---- light: real sources in the darkest places beside what stands, so a room has pools instead of one flat wash
    const emit = S.EMIT || {};
    const lights = () => { const out = []; for (const p of c.placed) if (emit[p.t]) out.push({ x: p.x + (p.w || 1) / 2, y: p.y + (p.h || 1) / 2 }); for (const p of c.existing || []) if (emit[p.t]) out.push({ x: p.x + (p.w || 1) / 2, y: p.y + (p.h || 1) / 2 }); return out; };
    const lampSp = S.spec('arc_floorlight'), lamps = Math.max(2, Math.round(area / 55));
    if (lampSp) for (let n = 0; n < lamps; n++) {
      const have = lights();
      let best = null;
      for (let y = R.y1 + 1; y <= R.y2 - 1; y++) for (let x = R.x1 + 1; x <= R.x2 - 1; x++) {
        const k = tileKey(x, y);
        if (occ.has(k) || lane.has(k) || !freeOf(lampSp, x, y)) continue;
        let near = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const o = occ.get(tileKey(x + dx, y + dy)); if (o && o !== 'flat') near = true; }
        if (!near) continue;
        const d = have.length ? Math.min(...have.map(h => Math.hypot(h.x - x - 0.5, h.y - y - 0.5))) : 99;
        if (!best || d > best.d) best = { x, y, d };
      }
      if (!best || best.d < 5) break;
      add('arc_floorlight', best.x, best.y, 0);
    }
    // ---- the inlay: the hero stands on its own field of another floor, one tile proud of it. A one-tile ring and door runners were
    // tried first: once a palette's accent could actually be seen they read as hazard tape
    const paint = [];
    if (recipe.accent && hero) {
      const list = [];
      for (let y = hero.y - 1; y <= hero.y + hero.h; y++) for (let x = hero.x - 1; x <= hero.x + hero.w; x++) if (x >= R.x1 && x <= R.x2 && y >= R.y1 && y <= R.y2) list.push([x, y]);
      if (list.length) paint.push({ style: recipe.accent, tiles: list });
    }
    return { hero, paint, added: c.placed.length - placedBefore };
  }

  /* ---------- CRITIQUE ---------- */
  const TABLETOP = new Set(['research_papers', 'mug', 'bookstack', 'figurine', 'desklamp', 'radio', 'deskterminal', 'modelship', 'lavalamp', 'plasmaglobe']);
  const bboxOfRoom = r => { const xs = r.rects.map(q => q.x1), ys = r.rects.map(q => q.y1), xe = r.rects.map(q => q.x2), ye = r.rects.map(q => q.y2); return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xe), y2: Math.max(...ye) }; };

  /* one room: { name, score, metrics, findings }. findings are ordered worst first, each one sentence naming a tile and a fix. */
  function critiqueRoom(st, env, room, doorsOf) {
    const S = env.PropSprites, B = bboxOfRoom(room), W = B.x2 - B.x1 + 1, H = B.y2 - B.y1 + 1;
    const inRoom = (x, y) => st.roomAt(x, y) === room.id;
    let area = 0; const grid = [];
    for (let y = 0; y < H; y++) { grid.push([]); for (let x = 0; x < W; x++) { const ok = inRoom(x + B.x1, y + B.y1); grid[y].push(!ok); if (ok) area++; } }
    const props = st.props().filter(p => st.roomAt(p.x, p.y) === room.id);
    const belts = st.serialize().belts || {};
    const spec = p => (S && S.spec ? S.spec(p.t) : null) || {};
    const isFlat = p => !!spec(p).flat, isTop = p => !!(spec(p).stack || spec(p).mount === 'surface') && TABLETOP.has(p.t);
    const solid = props.filter(p => !isFlat(p) && !isTop(p));
    let cover = 0;
    for (const p of props) {
      if (isTop(p)) continue;
      const a = (p.w || 1) * (p.h || 1); cover += isFlat(p) ? a * 0.4 : a;
      for (let yy = p.y; yy < p.y + (p.h || 1); yy++) for (let xx = p.x; xx < p.x + (p.w || 1); xx++) { const gx = xx - B.x1, gy = yy - B.y1; if (grid[gy] && gx >= 0 && gx < W) grid[gy][gx] = true; }
    }
    let onBelt = 0;
    for (const k of Object.keys(belts)) { const [x, y] = k.split(',').map(Number); if (inRoom(x, y)) { onBelt++; const gx = x - B.x1, gy = y - B.y1; grid[gy][gx] = true; } }
    const isWorks = room.kind === 'factory' && props.some(p => ['bay', 'intake', 'outbox'].indexOf(p.t) >= 0);
    const metrics = { tiles: area, pieces: props.length, kinds: new Set(props.map(p => p.t)).size, coverage: +(area ? (cover + onBelt) / area : 0).toFixed(3) };
    const empty = largestRect(grid, W, H);
    metrics.largestEmpty = empty ? +(empty.area / Math.max(1, area)).toFixed(3) : 0;
    const emit = (S && S.EMIT) || {};
    metrics.lights = props.filter(p => emit[p.t]).length;
    const findings = [];
    const say = (weight, text, code) => findings.push({ weight, text, code });
    const at = p => '(' + p.x + ', ' + p.y + ')';
    if (area >= 60 && !props.length) say(40, room.name + ' is bare: nothing stands in it. Furnish it with a style or a refit.', 'bare');
    else if (area >= 60 && !isWorks) {
      if (metrics.coverage < 0.1) say(30, room.name + ' reads empty: only ' + Math.round(metrics.coverage * 100) + '% of its floor holds anything. Group more pieces around what it is for.', 'sparse');
      else if (metrics.coverage < 0.17) say(16, room.name + ' reads thin at ' + Math.round(metrics.coverage * 100) + '% of its floor. Add a second group of furniture.', 'thin');
      if (metrics.coverage > 0.55) say(18, room.name + ' is crowded at ' + Math.round(metrics.coverage * 100) + '% of its floor. Take pieces out so it can be walked.', 'crowded');
      if (empty && empty.area >= 30 && metrics.largestEmpty > 0.3) say(18, room.name + ' has dead floor: ' + empty.w + ' × ' + empty.h + ' clear tiles at (' + (empty.x + B.x1) + ', ' + (empty.y + B.y1) + '). Give that floor a purpose.', 'dead-floor');
      if (metrics.kinds > 0 && metrics.kinds < 4 && props.length >= 3) say(8, room.name + ' repeats itself: ' + metrics.kinds + ' kinds of piece. Mix in what the room is for.', 'monotone');
    }
    // a small thing lying on the deck: papers, a mug, a lamp with no table under it
    const tables = props.filter(p => spec(p).surface || /table|desk|bench|bar$/.test(p.t));
    const onTable = q => tables.some(t => q.x >= t.x && q.x < t.x + (t.w || 1) && q.y >= t.y && q.y < t.y + (t.h || 1));
    for (const q of props) if (TABLETOP.has(q.t) && !onTable(q)) say(10, 'The ' + q.t.replace(/_/g, ' ') + ' at ' + at(q) + ' lies on the bare floor. Stand it on a table, or take it up.', 'on-floor');
    // a piece alone in open floor, away from any wall and any other piece
    const nearAny = p => solid.some(q => q !== p && !(q.x > p.x + (p.w || 1) + 1 || q.x + (q.w || 1) < p.x - 1 || q.y > p.y + (p.h || 1) + 1 || q.y + (q.h || 1) < p.y - 1));
    const byWall = p => { for (let x = p.x - 1; x <= p.x + (p.w || 1); x++) for (let y = p.y - 1; y <= p.y + (p.h || 1); y++) if (!inRoom(x, y)) return true; return false; };
    const rugUnder = p => props.some(q => isFlat(q) && p.x >= q.x && p.x < q.x + (q.w || 1) && p.y >= q.y && p.y < q.y + (q.h || 1));
    for (const p of solid) if (spec(p).blocks !== false && !nearAny(p) && !byWall(p) && !rugUnder(p) && (p.w || 1) * (p.h || 1) < 8) say(7, 'The ' + p.t.replace(/_/g, ' ') + ' at ' + at(p) + ' floats alone. Group it with something, or set it against a wall.', 'floating');
    // what crowds a doorway, even where it does not quite block it
    for (const d of doorsOf(room.id)) for (const p of solid) if (spec(p).blocks !== false) {
      const dx = Math.max(p.x - d.x, 0, d.x - (p.x + (p.w || 1) - 1)), dy = Math.max(p.y - d.y, 0, d.y - (p.y + (p.h || 1) - 1));
      if (dx + dy <= 1) { say(9, 'The ' + p.t.replace(/_/g, ' ') + ' at ' + at(p) + ' crowds the doorway at (' + d.x + ', ' + d.y + '). Move it a couple of tiles along.', 'door'); break; }
    }
    if (area >= 80 && props.length && metrics.lights === 0) say(12, room.name + ' has no light of its own, so it is lit flat. Stand a floor light (arc_floorlight) or something that glows beside its main group.', 'unlit');
    // lopsided: the visual weight far from the middle of the room
    if (solid.length >= 4 && !isWorks) {
      let mx = 0, m = 0;
      for (const p of solid) { const a = (p.w || 1) * (p.h || 1); mx += a * (p.x + (p.w || 1) / 2 - B.x1); m += a; }
      const off = Math.abs(mx / m - W / 2) / W;
      metrics.balance = +(1 - off * 2).toFixed(2);
      if (off > 0.22) say(8, room.name + ' is lopsided: its weight sits to the ' + (mx / m < W / 2 ? 'west' : 'east') + '. Balance it with a group on the other side.', 'lopsided');
    }
    findings.sort((a, b) => b.weight - a.weight);
    const seen = {}, kept = findings.filter(f => { seen[f.code] = (seen[f.code] || 0) + 1; return seen[f.code] <= 3; });
    const score = Math.max(0, 100 - findings.reduce((n, f) => n + f.weight, 0));
    return { name: room.name, score, metrics, findings: kept.map(f => f.text) };
  }

  const gradeOf = (score, weakest) => score >= 85 && weakest >= 60 ? 'finished' : score >= 65 ? 'getting there' : 'rough';
  /* the station: every room, then what only shows at the scale of the whole */
  function critique(st, env, doorsOf, opts) {
    const all = st.rooms(), rooms = all.filter(r => r.kind !== 'corridor'), only = opts && opts.room;
    const list = rooms.filter(r => !only || r.id === only || r.name === only).map(r => critiqueRoom(st, env, r, doorsOf));
    const station = [];
    if (!only && rooms.length >= 4) {
      const dims = {}; for (const r of rooms) { const b = bboxOfRoom(r), k = (b.x2 - b.x1 + 1) + 'x' + (b.y2 - b.y1 + 1); dims[k] = (dims[k] || 0) + 1; }
      const top = Math.max(...Object.values(dims));
      if (top === rooms.length) station.push('Every room is the same size, so nothing reads as the heart of the station. Make the room it is for bigger.');
      const decks = new Set(rooms.map(r => r.floorStyle)), kinds = new Set(rooms.map(r => r.wallMat || 'plating'));
      if (decks.size >= rooms.length && rooms.length >= 6) station.push('Every room has its own floor, so the station reads as many places instead of one. Share a palette.');
      if (kinds.size === 1 && decks.size === 1) station.push('Every room shares one floor and one wall, so it reads as a single grey space. Vary them by what each room is for.');
      // what a floor of good rooms can still get wrong: one room stamped twice, or no room that matters more than the rest
      const prints = {};
      for (const r of rooms) { const ts = st.props().filter(p => st.roomAt(p.x, p.y) === r.id).map(p => p.t).sort().join(); if (ts.split(',').length >= 4) (prints[ts] = prints[ts] || []).push(r.name); }
      const twins = Object.values(prints).find(n => n.length > 1);
      if (twins) station.push(twins.slice(0, 3).join(' and ') + ' hold exactly the same furniture, so they read as one room twice. Give each its own purpose.');
      const areas = rooms.map(r => { const b = bboxOfRoom(r); return (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1); }).sort((a, b) => a - b);
      if (top !== rooms.length && areas[areas.length - 1] < areas[areas.length >> 1] * 1.3) station.push('No room stands out in size, so nothing reads as the heart of the station. Make the room it is for clearly bigger.');
      const tilesOf = r => r.rects.reduce((n, q) => n + (q.x2 - q.x1 + 1) * (q.y2 - q.y1 + 1), 0);
      const hallTiles = all.filter(r => r.kind === 'corridor').reduce((n, r) => n + tilesOf(r), 0), roomTiles = rooms.reduce((n, r) => n + tilesOf(r), 0);
      if (hallTiles > roomTiles * 0.6) station.push('Corridor covers ' + Math.round(hallTiles * 100 / (hallTiles + roomTiles)) + '% of the floor, so it reads as passages more than places. Bring the rooms closer or choose a tighter plan.');
    }
    const avg = list.length ? Math.round(list.reduce((n, r) => n + r.score, 0) / list.length) : 100;
    const score = Math.max(0, avg - station.length * 6);
    // one poor room stops a station being finished, however good the average
    const weakest = list.length ? list.reduce((a, b) => b.score < a.score ? b : a) : null;
    if (weakest && weakest.score < 60 && score >= 85) station.push(weakest.name + ' scores ' + weakest.score + ' of 100, so the station is not finished until it is fixed.');
    return { score, grade: gradeOf(score, weakest ? weakest.score : 100), station, rooms: list.map(r => ({ name: r.name, score: r.score, coverage: r.metrics.coverage, lights: r.metrics.lights, findings: r.findings })) };
  }

  // the review as the model reads it in a plan or a receipt: the verdict and what to fix first, never a page of it
  function brief(r) {
    if (!r) return null;
    const worst = r.rooms.filter(x => x.findings.length).sort((a, b) => a.score - b.score).slice(0, 6);
    return { score: r.score, grade: r.grade, station: r.station.slice(0, 3), rooms: worst.map(x => ({ name: x.name, score: x.score, fix: x.findings.slice(0, 3) })) };
  }

  return { brief, gradeOf, variantOf, VARIANTS, ARCHITECTURES, VIGNETTES: V, RECIPES, THEMES, THEME_ORDER, FAMILY, GUIDE, resolveTheme, themeMenu, themed, themeOfKind, prebuildRooms, compose, critique, critiqueRoom, largestRect, hash };
});
