/* Projection-specific overlays. Coordinates address the FULL exported PNG, not
 * the world footprint or alpha crop. No old sprite painter, network, readback,
 * random activity, progress estimates, or per-frame allocation of canvases.
 * Source bodies/anchors remain owned by PropRemaster. See projection-effects/README.md. */
'use strict';
const ProjectionPropEffects = (() => {
  const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  const C={cyan:[78,206,221],amber:[238,177,62],rose:[233,103,134],green:[144,224,81],violet:[158,130,229]};
  const screen=(region,gate='occupied',colour=C.cyan,idleOpacity=.88)=>({kind:'screen',region,gate,colour,idleOpacity});
  const lamp=(region,gate='work',colour=C.amber)=>({kind:'lamp',region,gate,colour});
  const scan=(region,gate='work',colour=C.cyan)=>({kind:'scan',region,gate,colour});
  const result=(region,colour=C.amber)=>({kind:'result',region,gate:'fired',colour});
  // Each local polygon is deliberately inside the bezel/rim. Never infer a
  // screen from all cyan pixels: glass, painted panels and upholstery share hues.
  const designs={
    console:[screen(rect(.27,.16,.46,.21))],
    consoleL:[screen(rect(.12,.157,.199,.212)),screen(rect(.406,.157,.166,.212))],
    pixelrig:[screen(rect(.19,.09,.63,.19))],
    bench:[screen(rect(.10,.145,.145,.163)),screen(rect(.804,.25,.075,.088))],
    // Their painted graticules are static glass artwork. Do not cover them with
    // opaque rectangles when idle; animated sweeps still require occupancy.
    bridge_consolebank:[screen(rect(.045,.16,.22,.37),'occupied',C.cyan,0),screen(rect(.365,.16,.255,.37),'occupied',C.cyan,0),screen(rect(.725,.16,.20,.37),'occupied',C.cyan,0)],
    bridge_tacticaltable:[screen([[.15,.15],[.85,.15],[.91,.28],[.91,.75],[.85,.87],[.15,.87],[.09,.75],[.09,.28]],'occupied',C.cyan,0)],
    bigscreen:[screen(rect(.06,.20,.86,.32))],
    holotable:[screen([[.09,.20],[.89,.20],[.89,.61],[.09,.61]])],
    screens:[screen(rect(.29,.075,.42,.20)),screen(rect(.07,.49,.34,.19)),screen(rect(.60,.49,.33,.19))],
    bridge_tacscreen:[screen(rect(.14,.23,.68,.43))],
    deskterminal:[screen([[.21,.23],[.77,.23],[.81,.49],[.18,.49]])],
    workbench:[screen(rect(.212,.087,.094,.106),'work',C.cyan),result(rect(.328,.086,.024,.013),C.cyan)],
    intake:[lamp(rect(.19,.827,.05,.028)),lamp(rect(.596,.827,.045,.028))],
    bay:[lamp(rect(.415,.91,.175,.013))],
    filter:[scan(rect(.398,.236,.122,.185),'scanning',C.violet)],
    merger:[lamp(rect(.045,.205,.025,.11)),lamp(rect(.045,.58,.025,.11)),lamp(rect(.943,.34,.016,.11))],
    splitter:[lamp(rect(.025,.345,.018,.12),'work',C.cyan),lamp(rect(.94,.11,.018,.12),'work',C.cyan),lamp(rect(.94,.53,.018,.12),'work',C.cyan)],
    joiner:[lamp(rect(.058,.21,.01,.07)),lamp(rect(.936,.365,.012,.12)),lamp(rect(.058,.55,.01,.075))],
    loop:[lamp(rect(.055,.56,.018,.10),'work',C.cyan),lamp(rect(.91,.44,.018,.10),'work',C.cyan)],
    outbox:[lamp(rect(.166,.802,.088,.023),'pending',C.cyan),lamp(rect(.746,.802,.09,.023),'work',C.cyan)],
    connector_portal:[{kind:'connector',region:rect(.27,.31,.15,.51),centres:[[.292,.338],[.292,.56],[.292,.783]],gate:'bound',colour:C.cyan},result(rect(.856,.09,.012,.055),C.cyan)],
    comms_dish:[screen(rect(.425,.869,.147,.02),'work',C.cyan)],
    comms_uplink:[screen(rect(.32,.805,.15,.035),'work'),result(rect(.52,.805,.08,.025),C.cyan)],
    comms_beacon:[{kind:'bands',region:rect(.25,.37,.49,.24),gate:'work',colour:C.cyan}],
    war_intelcab:[screen(rect(.107,.372,.091,.109),'work',C.cyan)],
    rack:[lamp(rect(.145,.35,.025,.025),'work',C.cyan),lamp(rect(.145,.55,.025,.025),'work',C.cyan),lamp(rect(.145,.75,.025,.025),'work',C.cyan)],
    core:[scan(rect(.32,.24,.36,.42),'work'),result(rect(.38,.77,.08,.015),C.cyan)],
    gigs_servercart:[screen(rect(.500,.465,.220,.073),'work',C.cyan),screen(rect(.500,.658,.220,.073),'work',C.cyan),result(rect(.771,.480,.035,.032),C.cyan)],
    bridge_relaystack:[lamp(rect(.64,.22,.08,.018),'work',C.cyan),lamp(rect(.64,.32,.08,.018),'work',C.cyan),lamp(rect(.64,.42,.08,.018),'work',C.cyan),lamp(rect(.64,.52,.08,.018),'work',C.cyan),result(rect(.40,.073,.20,.016),C.violet)],
    studio:[screen(rect(.242,.112,.372,.292),'work',C.cyan),result(rect(.599,.782,.027,.013),C.cyan)],
    airlock:[{kind:'door',region:[[.48,.28],[.60,.42],[.55,.53],[.44,.55],[.38,.43]],gate:'door',colour:C.cyan}],
    missionboard:[{kind:'pins',region:rect(.10,.17,.77,.47),gate:'pins',colour:C.amber}],
    trophycase:[{kind:'awards',region:rect(.20,.36,.62,.45),gate:'trophies',colour:C.amber}],
    bridge_equipmentbay:[lamp(rect(.45,.48,.035,.025),'work',C.amber)],
    tank:[{kind:'water',region:[[.12,.42],[.77,.42],[.82,.60],[.69,.72],[.24,.72],[.105,.59]],gate:'ambient',colour:C.cyan}],
    ticker:[screen(rect(.095,.29,.81,.33),'ambient',C.green)],
    chartwall:[screen(rect(.065,.23,.225,.46),'ambient'),screen(rect(.37,.23,.25,.46),'ambient',C.amber),screen(rect(.70,.23,.23,.46),'ambient')],
    wartable:[screen([[.09,.13],[.91,.13],[.92,.68],[.08,.68]],'work',C.rose)],
    bridge_dispatch_pylon:[scan(rect(.395,.38,.16,.25),'work')],
    bridge_orderqueue:[screen(rect(.25,.07,.51,.18),'work'),screen(rect(.25,.32,.51,.17),'work'),screen(rect(.23,.55,.55,.16),'work')],
    war_pivotpanel:[lamp(rect(.49,.12,.022,.34),'work',C.amber)],
    war_threatcore:[{kind:'bands',region:rect(.37,.29,.24,.38),gate:'work',colour:C.rose}],
    fabricator:[scan(rect(.46,.15,.047,.072),'work')],
    vat:[{kind:'ripple',region:[[.18,.23],[.72,.23],[.86,.40],[.75,.53],[.25,.53],[.14,.40]],gate:'work',colour:C.amber}],
    tube:[scan(rect(.255,.21,.48,.20),'work')],
    research_corelens:[scan(rect(.39,.265,.20,.115),'occupied'),result(rect(.35,.64,.26,.015))],
    research_trendpillar:[screen(rect(.255,.26,.47,.25),'occupied')],
    research_samplecart:[{kind:'samples',region:rect(.20,.18,.39,.17),gate:'work',colour:C.cyan}],
    etsy_threadrack:[lamp(rect(.88,.075,.019,.02),'work',C.amber)],
    etsy_dyevat:[{kind:'ripple',region:[[.23,.17],[.56,.17],[.63,.26],[.55,.36],[.24,.36],[.17,.27]],gate:'work',colour:C.amber}],
    etsy_kiln:[{kind:'heat',region:rect(.235,.63,.54,.018),gate:'work',colour:C.amber}],
    etsy_packbot:[lamp(rect(.47,.842,.075,.021),'work',C.amber),scan(rect(.46,.16,.07,.025),'work',C.cyan)],
    rackV:[lamp(rect(.32,.30,.07,.015),'work',C.cyan),lamp(rect(.32,.405,.07,.015),'work',C.cyan),lamp(rect(.32,.515,.07,.015),'work',C.cyan),lamp(rect(.32,.625,.07,.015),'work',C.cyan),lamp(rect(.44,.84,.20,.013),'work',C.cyan)],
    treasury_coinsorter:[screen(rect(.755,.215,.12,.18),'work',C.green)],
    treasury_token_furnace:[{kind:'heat',region:rect(.385,.595,.13,.16),gate:'work',colour:C.green}],
    commswall:[screen(rect(.055,.18,.19,.43),'ambient'),screen(rect(.325,.18,.35,.43),'ambient'),screen(rect(.75,.18,.19,.43),'ambient')],
    comms_inbox:[screen(rect(.185,.06,.10,.26),'work'),screen(rect(.39,.055,.29,.26),'work'),screen(rect(.795,.085,.10,.20),'work')],
    gigs_thumbwall:[screen(rect(.095,.29,.23,.24),'ambient'),screen(rect(.39,.29,.23,.24),'ambient'),screen(rect(.68,.29,.23,.24),'ambient')],
    gigs_amp:[lamp(rect(.745,.20,.035,.025),'work',C.amber)],
    pub_publishpress:[{kind:'heat',region:rect(.29,.548,.405,.09),gate:'work',colour:C.amber}],
    pub_outboundchute:[scan(rect(.37,.425,.26,.24),'work',C.amber)],
    pub_mailpod:[lamp(rect(.155,.705,.035,.01),'work',C.amber),lamp(rect(.65,.705,.035,.01),'work',C.amber)],
    arc_microfiche:[screen([[.25,.22],[.74,.22],[.79,.49],[.21,.49]],'work')],
    djbooth:[screen(rect(.28,.07,.38,.065),'work')],
    speaker:[{kind:'cone',region:rect(.35,.49,.32,.26),gate:'work',colour:C.violet}],
    tv:[screen(rect(.23,.29,.48,.27),'ambient')],
    arcade:[screen(rect(.30,.365,.38,.12),'occupied'),result(rect(.38,.79,.055,.02),C.cyan)],
    arcade2:[screen(rect(.30,.365,.38,.12),'occupied',C.rose),result(rect(.38,.79,.055,.02),C.rose)],
    jukebox:[screen(rect(.30,.44,.42,.16),'connected'),lamp(rect(.36,.67,.075,.015),'connected',C.amber),result(rect(.36,.67,.075,.015),C.amber)],
    quarters_vending:[lamp(rect(.86,.40,.04,.05),'work',C.cyan)],
    quarters_minifridge:[lamp(rect(.76,.415,.06,.018),'work',C.cyan)],
    coffee:[{kind:'steam',region:rect(.42,.48,.22,.25),origin:[.54,.70],rise:.18,gate:'ambient',colour:[185,173,154]}],
    treasury_pnl_holo:[{kind:'hologram',region:rect(.32,.33,.37,.13),origin:[.5,.37],rise:1.6,gate:'ambient',colour:C.green}],
    arc_floorlight:[{kind:'light',region:[[.29,.35],[.71,.35],[.80,.46],[.71,.56],[.29,.56],[.20,.46]],gate:'ambient',colour:C.cyan}],
    lavalamp:[{kind:'wax',region:[[.32,.25],[.67,.25],[.81,.67],[.65,.735],[.35,.735],[.19,.67]],patch:rect(.32,.30,.34,.36),gate:'ambient',colour:C.cyan}],
    crt_pile:[screen(rect(.245,.176,.40,.17),'ambient'),screen(rect(.17,.575,.52,.23),'ambient')],
    holopet:[{kind:'holo',region:rect(.19,.02,.61,.38),gate:'ambient',colour:C.cyan}],
    plasmaglobe:[{kind:'plasma',region:[[.49,.055],[.78,.115],[.87,.24],[.77,.385],[.48,.43],[.20,.365],[.12,.23],[.22,.11]],origin:[.49,.24],gate:'ambient',colour:C.violet}],
    desklamp:[{kind:'light',region:[[.075,.43],[.36,.48],[.38,.58],[.18,.59],[.07,.53]],gate:'ambient',colour:C.amber}],
    radio:[{kind:'light',region:rect(.58,.31,.30,.26),gate:'ambient',colour:C.amber}],
    steamvent:[{kind:'steam',region:rect(.26,-1.2,.49,1.9),origin:[.50,.65],rise:1.8,gate:'ambient',colour:[178,191,194]}],
    fishtank:[{kind:'fish',region:rect(.13,.29,.74,.44),patch:rect(.245,.405,.225,.17),gate:'ambient',colour:C.cyan},{kind:'fish',region:rect(.13,.29,.74,.44),patch:rect(.59,.58,.19,.125),gate:'ambient',colour:C.cyan,phase:1.7}],
    pinball:[screen(rect(.27,.085,.42,.06),'occupied'),scan([[.25,.36],[.68,.36],[.70,.68],[.23,.68]],'occupied')],
    cryopod:[{kind:'cold',region:rect(.25,.26,.48,.51),gate:'ambient',colour:C.cyan}],
    incubator:[{kind:'specimen',region:rect(.27,.25,.46,.43),patch:rect(.37,.32,.27,.28),gate:'ambient',colour:C.green}],
    camerarig:[lamp(rect(.071,.195,.045,.09),'work',C.cyan)],
    camerarig_r:[lamp(rect(.884,.195,.042,.09),'work',C.cyan)],
    industrial_servicecab:[lamp(rect(.70,.483,.045,.027),'work',C.amber)]
  };
  // BINDINGS is generated from the reviewed manifest by the offline proof tool.
  const BINDINGS = /* projection-bindings */ {"industrial_locker":{"s":{"image":"industrial_locker.png","width":292,"height":300}},"industrial_drawerbank":{"s":{"image":"industrial_drawerbank.png","width":521,"height":205}},"industrial_supplycart":{"s":{"image":"industrial_supplycart.png","width":319,"height":281}},"industrial_toolcaddy":{"s":{"image":"industrial_toolcaddy.png","width":248,"height":208}},"industrial_planter":{"s":{"image":"industrial_planter.png","width":401,"height":278}},"industrial_partition":{"s":{"image":"industrial_partition.png","width":529,"height":286},"w":{"image":"industrial_partition-w.png","width":177,"height":575},"e":{"image":"industrial_partition-e.png","width":135,"height":607}},"industrial_bench":{"s":{"image":"industrial_bench.png","width":1328,"height":441}},"industrial_roundtable":{"s":{"image":"industrial_roundtable.png","width":419,"height":295}},"industrial_servicecab":{"s":{"image":"industrial_servicecab.png","width":166,"height":444}},"industrial_wallpanel":{"s":{"image":"industrial_wallpanel.png","width":294,"height":252}},"industrial_floorvent":{"s":{"image":"industrial_floorvent.png","width":423,"height":173}},"industrial_cabletray":{"s":{"image":"industrial_cabletray.png","width":1133,"height":178}},"desk":{"s":{"image":"desk.png","width":1207,"height":804},"w":{"image":"desk-w.png","width":128,"height":190},"n":{"image":"desk-n.png","width":597,"height":469},"e":{"image":"desk-e.png","width":138,"height":190}},"desk2":{"s":{"image":"desk2.png","width":687,"height":423},"w":{"image":"desk2-w.png","width":146,"height":186},"n":{"image":"desk2-n.png","width":679,"height":411},"e":{"image":"desk2-e.png","width":218,"height":529}},"console":{"s":{"image":"console.png","width":1009,"height":833}},"consoleL":{"s":{"image":"consoleL.png","width":1308,"height":719}},"pixelrig":{"s":{"image":"pixelrig.png","width":403,"height":338}},"bench":{"s":{"image":"bench.png","width":1534,"height":673}},"workbench":{"s":{"image":"workbench.png","width":1515,"height":909}},"intake":{"s":{"image":"intake.png","width":1214,"height":976}},"bay":{"s":{"image":"bay.png","width":418,"height":396}},"filter":{"s":{"image":"filter.png","width":294,"height":331}},"merger":{"s":{"image":"merger.png","width":363,"height":213}},"splitter":{"s":{"image":"splitter.png","width":323,"height":212}},"joiner":{"s":{"image":"joiner.png","width":354,"height":225}},"loop":{"s":{"image":"loop.png","width":288,"height":345}},"outbox":{"s":{"image":"outbox.png","width":1206,"height":1014}},"connector_portal":{"s":{"image":"connector_portal.png","width":924,"height":1626}},"comms_dish":{"s":{"image":"comms_dish.png","width":777,"height":1039}},"comms_uplink":{"s":{"image":"comms_uplink.png","width":244,"height":496}},"comms_beacon":{"s":{"image":"comms_beacon.png","width":272,"height":344}},"war_intelcab":{"s":{"image":"war_intelcab.png","width":950,"height":930}},"safe":{"s":{"image":"safe.png","width":203,"height":361}},"vault":{"s":{"image":"vault.png","width":459,"height":259}},"rack":{"s":{"image":"rack.png","width":342,"height":306}},"shelf":{"s":{"image":"shelf.png","width":529,"height":252}},"core":{"s":{"image":"core.png","width":209,"height":448}},"gigs_servercart":{"s":{"image":"gigs_servercart.png","width":1071,"height":1004}},"bridge_relaystack":{"s":{"image":"bridge_relaystack.png","width":293,"height":599}},"studio":{"s":{"image":"studio.png","width":1422,"height":856}},"airlock":{"s":{"image":"airlock.png","width":218,"height":215}},"missionboard":{"s":{"image":"missionboard.png","width":393,"height":229}},"trophycase":{"s":{"image":"trophycase.png","width":307,"height":345}},"bridge_consolebank":{"s":{"image":"bridge_consolebank.png","width":702,"height":218}},"bridge_tacticaltable":{"s":{"image":"bridge_tacticaltable.png","width":1614,"height":825}},"bridge_equipmentbay":{"s":{"image":"bridge_equipmentbay.png","width":1597,"height":559}},"bridge_deckperimeter":{"s":{"image":"bridge_deckperimeter.png","width":1558,"height":980}},"bigscreen":{"s":{"image":"bigscreen.png","width":638,"height":167}},"holotable":{"s":{"image":"holotable.png","width":1488,"height":810}},"screens":{"s":{"image":"screens.png","width":343,"height":306}},"tank":{"s":{"image":"tank.png","width":368,"height":326}},"whiteboard":{"s":{"image":"whiteboard.png","width":555,"height":247}},"ticker":{"s":{"image":"ticker.png","width":477,"height":214}},"chartwall":{"s":{"image":"chartwall.png","width":477,"height":232}},"wartable":{"s":{"image":"wartable.png","width":1981,"height":703}},"calwall":{"s":{"image":"calwall.png","width":737,"height":205}},"bridge_tacscreen":{"s":{"image":"bridge_tacscreen.png","width":340,"height":269}},"bridge_dispatch_pylon":{"s":{"image":"bridge_dispatch_pylon.png","width":302,"height":573}},"bridge_orderqueue":{"s":{"image":"bridge_orderqueue.png","width":405,"height":335}},"war_pivotpanel":{"s":{"image":"war_pivotpanel.png","width":509,"height":351}},"war_threatcore":{"s":{"image":"war_threatcore.png","width":200,"height":388}},"fabricator":{"s":{"image":"fabricator.png","width":420,"height":274}},"vat":{"s":{"image":"vat.png","width":382,"height":278}},"easel":{"s":{"image":"easel.png","width":649,"height":748}},"tube":{"s":{"image":"tube.png","width":340,"height":200}},"research_corelens":{"s":{"image":"research_corelens.png","width":272,"height":363}},"research_trendpillar":{"s":{"image":"research_trendpillar.png","width":272,"height":362}},"research_samplecart":{"s":{"image":"research_samplecart.png","width":650,"height":459}},"research_papers":{"s":{"image":"research_papers.png","width":433,"height":241}},"etsy_threadrack":{"s":{"image":"etsy_threadrack.png","width":406,"height":314}},"etsy_dyevat":{"s":{"image":"etsy_dyevat.png","width":368,"height":308}},"etsy_kiln":{"s":{"image":"etsy_kiln.png","width":324,"height":374}},"etsy_packbot":{"s":{"image":"etsy_packbot.png","width":270,"height":358}},"rackV":{"s":{"image":"rackV.png","width":182,"height":453}},"crate":{"s":{"image":"crate.png","width":631,"height":463}},"boxes":{"s":{"image":"boxes.png","width":314,"height":193}},"goldcrate":{"s":{"image":"goldcrate.png","width":312,"height":225}},"gigs_partsbin":{"s":{"image":"gigs_partsbin.png","width":312,"height":211}},"treasury_coinsorter":{"s":{"image":"treasury_coinsorter.png","width":578,"height":317}},"treasury_token_furnace":{"s":{"image":"treasury_token_furnace.png","width":197,"height":437}},"commswall":{"s":{"image":"commswall.png","width":646,"height":199}},"comms_inbox":{"s":{"image":"comms_inbox.png","width":457,"height":297}},"gigs_thumbwall":{"s":{"image":"gigs_thumbwall.png","width":372,"height":222}},"gigs_amp":{"s":{"image":"gigs_amp.png","width":225,"height":281}},"pub_publishpress":{"s":{"image":"pub_publishpress.png","width":435,"height":401}},"pub_outboundchute":{"s":{"image":"pub_outboundchute.png","width":428,"height":650}},"pub_mailpod":{"s":{"image":"pub_mailpod.png","width":727,"height":513}},"arc_indexwall":{"s":{"image":"arc_indexwall.png","width":532,"height":234}},"arc_microfiche":{"s":{"image":"arc_microfiche.png","width":338,"height":277}},"djbooth":{"s":{"image":"djbooth.png","width":849,"height":507}},"speaker":{"s":{"image":"speaker.png","width":231,"height":352}},"bar":{"s":{"image":"bar.png","width":974,"height":499}},"tv":{"s":{"image":"tv.png","width":287,"height":216}},"couch":{"s":{"image":"couch.png","width":1859,"height":682}},"arcade":{"s":{"image":"arcade.png","width":143,"height":326}},"arcade2":{"s":{"image":"arcade2.png","width":143,"height":326}},"jukebox":{"s":{"image":"jukebox.png","width":287,"height":383}},"bunk":{"s":{"image":"bunk.png","width":1139,"height":1188}},"quarters_pooltable":{"s":{"image":"quarters_pooltable.png","width":348,"height":239}},"quarters_vending":{"s":{"image":"quarters_vending.png","width":289,"height":465}},"quarters_lockerbank":{"s":{"image":"quarters_lockerbank.png","width":558,"height":495}},"quarters_minifridge":{"s":{"image":"quarters_minifridge.png","width":198,"height":328}},"coffee":{"s":{"image":"coffee.png","width":214,"height":313}},"plant":{"s":{"image":"plant.png","width":640,"height":1412}},"rug":{"s":{"image":"rug.png","width":350,"height":228}},"rug_small":{"s":{"image":"rug_small.png","width":248,"height":228}},"rug_large":{"s":{"image":"rug_large.png","width":556,"height":535}},"treasury_pnl_holo":{"s":{"image":"treasury_pnl_holo.png","width":322,"height":174}},"arc_floorlight":{"s":{"image":"arc_floorlight.png","width":175,"height":175}},"arc_ladder":{"s":{"image":"arc_ladder.png","width":331,"height":506}},"stool":{"s":{"image":"stool.png","width":400,"height":454}},"chair":{"s":{"image":"chair.png","width":457,"height":683},"w":{"image":"chair-w.png","width":107,"height":172},"n":{"image":"chair-n.png","width":111,"height":167},"e":{"image":"chair-e.png","width":108,"height":171}},"sidetable":{"s":{"image":"sidetable.png","width":236,"height":311}},"lowtable":{"s":{"image":"lowtable.png","width":521,"height":214},"e":{"image":"lowtable-e.png","width":163,"height":304}},"glasstable":{"s":{"image":"glasstable.png","width":548,"height":216},"e":{"image":"glasstable-e.png","width":449,"height":1325}},"dinertable":{"s":{"image":"dinertable.png","width":1237,"height":737},"e":{"image":"dinertable-e.png","width":447,"height":679}},"guitar":{"s":{"image":"guitar.png","width":218,"height":444}},"booth":{"s":{"image":"booth.png","width":333,"height":295},"w":{"image":"booth-w.png","width":289,"height":646},"e":{"image":"booth-e.png","width":696,"height":1789}},"dinerchair":{"s":{"image":"dinerchair.png","width":167,"height":311},"w":{"image":"dinerchair-w.png","width":226,"height":359},"n":{"image":"dinerchair-n.png","width":218,"height":300},"e":{"image":"dinerchair-e.png","width":227,"height":359}},"podchair":{"s":{"image":"podchair.png","width":237,"height":323},"w":{"image":"podchair-w.png","width":262,"height":384},"n":{"image":"podchair-n.png","width":356,"height":650},"e":{"image":"podchair-e.png","width":262,"height":386}},"loungetable":{"s":{"image":"loungetable.png","width":426,"height":212},"e":{"image":"loungetable-e.png","width":190,"height":264}},"longtable":{"s":{"image":"longtable.png","width":1738,"height":658},"e":{"image":"longtable-e.png","width":179,"height":380}},"lavalamp":{"s":{"image":"lavalamp.png","width":282,"height":658}},"crt_pile":{"s":{"image":"crt_pile.png","width":205,"height":309}},"cablerun":{"s":{"image":"cablerun.png","width":1135,"height":250}},"hazardpad":{"s":{"image":"hazardpad.png","width":413,"height":177}},"tallplant":{"s":{"image":"tallplant.png","width":227,"height":435}},"terrarium":{"s":{"image":"terrarium.png","width":227,"height":367}},"holopet":{"s":{"image":"holopet.png","width":436,"height":1295}},"plasmaglobe":{"s":{"image":"plasmaglobe.png","width":312,"height":656}},"gachapon":{"s":{"image":"gachapon.png","width":200,"height":316}},"monstera":{"s":{"image":"monstera.png","width":345,"height":377}},"mug":{"s":{"image":"mug.png","width":571,"height":520}},"bookstack":{"s":{"image":"bookstack.png","width":298,"height":260}},"desklamp":{"s":{"image":"desklamp.png","width":363,"height":252}},"radio":{"s":{"image":"radio.png","width":668,"height":547}},"toolbox":{"s":{"image":"toolbox.png","width":1275,"height":669}},"figurine":{"s":{"image":"figurine.png","width":231,"height":277}},"deskterminal":{"s":{"image":"deskterminal.png","width":247,"height":243}},"modelship":{"s":{"image":"modelship.png","width":447,"height":225}},"steamvent":{"s":{"image":"steamvent.png","width":845,"height":473}},"fishtank":{"s":{"image":"fishtank.png","width":1065,"height":809}},"pokertable":{"s":{"image":"pokertable.png","width":457,"height":283}},"bookshelf":{"s":{"image":"bookshelf.png","width":1125,"height":944}},"beanbag":{"s":{"image":"beanbag.png","width":322,"height":273}},"pinball":{"s":{"image":"pinball.png","width":336,"height":567}},"cryopod":{"s":{"image":"cryopod.png","width":194,"height":456}},"incubator":{"s":{"image":"incubator.png","width":193,"height":477}},"telescope":{"s":{"image":"telescope.png","width":326,"height":372}},"telescope_r":{"s":{"image":"telescope_r.png","width":312,"height":374}},"camerarig":{"s":{"image":"camerarig.png","width":199,"height":339}},"camerarig_r":{"s":{"image":"camerarig_r.png","width":202,"height":339}},"weaponrack":{"s":{"image":"weaponrack.png","width":553,"height":384}},"weaponrack_r":{"s":{"image":"weaponrack_r.png","width":1126,"height":722}},"punchbag":{"s":{"image":"punchbag.png","width":172,"height":416}},"punchbag_r":{"s":{"image":"punchbag_r.png","width":171,"height":417}},"benchpress":{"s":{"image":"benchpress.png","width":587,"height":344}},"benchpress_r":{"s":{"image":"benchpress_r.png","width":1572,"height":865}},"recliner":{"s":{"image":"recliner.png","width":232,"height":258}},"recliner_r":{"s":{"image":"recliner_r.png","width":232,"height":259}}};
  const QUIET = /* projection-quiet */ {"desk":"Accepted workstation screen/occupancy renderer remains authoritative, including compact native fallback and separately authored facings. No added effects.","desk2":"Accepted workstation screen/occupancy renderer remains authoritative, including compact native fallback and separately authored facings. No added effects.","industrial_locker":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","industrial_drawerbank":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","industrial_supplycart":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","industrial_toolcaddy":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","industrial_wallpanel":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","safe":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","vault":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","shelf":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","quarters_lockerbank":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","arc_indexwall":"Storage or passive hardware; no evidenced moving mechanism or live display region on this source.","industrial_partition":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","industrial_bench":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","industrial_roundtable":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","industrial_floorvent":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","industrial_cabletray":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","bridge_deckperimeter":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","cablerun":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","hazardpad":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","rug":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","rug_small":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","rug_large":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","arc_ladder":"Passive structural, floor or support object. Painted surface remains still; no fabricated process.","industrial_planter":"Quiet painted foliage/colony. Old ambient sway or spores were decorative, not a live process; omitted intentionally.","plant":"Quiet painted foliage/colony. Old ambient sway or spores were decorative, not a live process; omitted intentionally.","tallplant":"Quiet painted foliage/colony. Old ambient sway or spores were decorative, not a live process; omitted intentionally.","terrarium":"Quiet painted foliage/colony. Old ambient sway or spores were decorative, not a live process; omitted intentionally.","monstera":"Quiet painted foliage/colony. Old ambient sway or spores were decorative, not a live process; omitted intentionally.","whiteboard":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","calwall":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","easel":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","research_papers":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","crate":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","boxes":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","goldcrate":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","gigs_partsbin":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","guitar":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","mug":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","bookstack":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","toolbox":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","figurine":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","modelship":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","bookshelf":"Static authored contents or materials. No inferred activity, inventory, light or material animation.","bar":"Serving counter has no per-instance dispensing/order state in renderer input; no invented pour or service cycle.","couch":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","bunk":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","stool":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","chair":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","sidetable":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","lowtable":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","glasstable":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","dinertable":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","booth":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","dinerchair":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","podchair":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","loungetable":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","longtable":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","beanbag":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","recliner":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","recliner_r":"Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.","quarters_pooltable":"No per-instance game/ball state is available. Static approved playfield avoids invented shots, cards or wins.","pokertable":"No per-instance game/ball state is available. Static approved playfield avoids invented shots, cards or wins.","gachapon":"No purchase/turn/dispense state is provided. Painted capsules remain static; no invented vend.","telescope":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.","telescope_r":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.","weaponrack":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.","weaponrack_r":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.","punchbag":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.","punchbag_r":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.","benchpress":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.","benchpress_r":"Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available."};
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const clamp=n=>finite(n)?Math.max(0,Math.min(1,n)):0;
  const frac=n=>n-Math.floor(n);
  const rgb=(c,a)=>'rgba('+c.join(',')+','+Math.max(0,Math.min(1,a))+')';
  function bbox(poly){const xs=poly.map(p=>p[0]),ys=poly.map(p=>p[1]);return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};}
  function path(c,p){c.beginPath();p.forEach((q,i)=>i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]));c.closePath();}
  function clipped(c,p,fn){c.save();try{path(c,p);c.clip();fn();}finally{c.restore();}}
  function line(c,p,col,w){c.beginPath();p.forEach((q,i)=>i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]));c.strokeStyle=col;c.lineWidth=w;c.lineCap='round';c.stroke();}
  function ellipse(c,x,y,rx,ry,col){c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fillStyle=col;c.fill();}
  const regions=Object.freeze(Object.fromEntries(Object.entries(designs).map(([id,e])=>[id,{s:e.map(x=>x.region)}])));
  function classify(id,view='s'){
    const binding=BINDINGS[id]&&BINDINGS[id][view];if(!binding)return null;
    const effects=view==='s'&&designs[id];
    return {classification:effects?'effects':'none',reason:effects?'Source-specific local state or decorative mechanism.':QUIET[id],binding,effects:effects||[]};
  }
  function matches(id,view,spec){const r=classify(id,view);return !!(r&&r.classification==='effects'&&spec&&r.binding.image===spec.image&&r.binding.width===spec.sourceWidth&&r.binding.height===spec.sourceHeight);}
  function amount(g,s){
    if(g==='ambient')return 1;
    if(g==='occupied')return typeof s.occupied==='boolean'?(s.occupied?1:0):(s.work===true?1:0);
    if(g==='work')return s.work===true?1:0;
    if(g==='scanning')return s.scanning===true?1:0;
    if(g==='connected')return s.live===true?1:0;
    if(g==='bound')return s.bound===true&&s.state==='online'?1:0;
    if(g==='fired')return clamp(s.fired);
    if(g==='pending')return finite(s.crates)&&s.crates>0?1:0;
    return 0;
  }
  // Light follows the same visible phosphor as the overlay. Static navigation
  // glass still emits while unoccupied; a dark standby screen emits less.
  function screenEmission(id,view='s',state={}){
    const screens=classify(id,view)?.effects.filter(e=>e.kind==='screen');
    if(!screens?.length)return null;
    let area=0,energy=0,x=0,y=0,c=[0,0,0];
    for(const e of screens){
      const b=bbox(e.region),a=b.width*b.height;
      const power=amount(e.gate,state)?1:1-clamp(e.idleOpacity??.88),w=a*power;
      area+=a;energy+=w;x+=(b.x+b.width/2)*w;y+=(b.y+b.height/2)*w;
      e.colour.forEach((v,i)=>c[i]+=v*w);
    }
    return {x:energy?x/energy:.5,y:energy?y/energy:.5,c:c.map(v=>energy?v/energy:0),power:area?energy/area:0};
  }
  function prepare(id,view,image,spec){
    if(!matches(id,view,spec))return null;
    const needs=designs[id].some(e=>e.patch);if(!needs)return {id,view,binding:BINDINGS[id][view],image:null};
    if(!image||(image.naturalWidth||image.width)!==spec.sourceWidth||(image.naturalHeight||image.height)!==spec.sourceHeight)return null;
    const factor=Math.min(1,256/Math.max(spec.sourceWidth,spec.sourceHeight)),w=Math.max(1,Math.round(spec.sourceWidth*factor)),h=Math.max(1,Math.round(spec.sourceHeight*factor));
    let cv;if(typeof OffscreenCanvas!=='undefined')cv=new OffscreenCanvas(w,h);else if(typeof document!=='undefined'){cv=document.createElement('canvas');cv.width=w;cv.height=h;}else return null;
    const c=cv.getContext('2d');if(!c)return null;c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';c.drawImage(image,0,0,w,h);
    return {id,view,binding:BINDINGS[id][view],image:cv,width:w,height:h};
  }
  function sourcePatch(c,p,e,dx,dy){
    if(!p||!p.image)return;
    const b=bbox(e.patch),pad=.025,x=Math.max(0,b.x-pad),y=Math.max(0,b.y-pad),right=Math.min(1,b.x+b.width+pad),bottom=Math.min(1,b.y+b.height+pad);
    clipped(c,e.patch,()=>c.drawImage(p.image,x*p.width,y*p.height,(right-x)*p.width,(bottom-y)*p.height,x+dx,y+dy,right-x,bottom-y));
  }
  function emit(c,e,s,t,p){
    const b=bbox(e.region),v=amount(e.gate,s),phase=e.phase||0,wave=.5+.5*Math.sin(t/670+phase);
    const fill=(col,a)=>{c.fillStyle=rgb(col,a);c.fillRect(b.x,b.y,b.width,b.height);};
    if(e.kind==='screen'||e.kind==='lamp'||e.kind==='scan'||e.kind==='bands'||e.kind==='heat'){
      if(!v){const opacity=e.idleOpacity??.88;if(opacity>0)fill([6,13,17],opacity);return;}
      if(e.kind==='screen'||e.kind==='scan'){
        const y=b.y+b.height*frac(t/2400+phase);line(c,[[b.x,y],[b.x+b.width,y]],rgb(e.colour,.16+.14*clamp(s.heat)),Math.min(.012,b.height*.08));
      }else if(e.kind==='bands'){
        for(let i=0;i<5;i++)c.fillStyle=rgb(e.colour,.035+.075*(.5+.5*Math.sin(t/860-i))),c.fillRect(b.x,b.y+b.height*i/5,b.width,b.height*.07);
      }else fill(e.colour,(e.kind==='heat'?.08:.12)+wave*.12);
      return;
    }
    if(e.kind==='result'){if(v)fill(s.bad===true?[239,79,73]:e.colour,.45*v);return;}
    if(e.kind==='connector'){
      // No status is inferred from the clock. All three sockets share the
      // actual connector binding, while a failed result uses its own lamp.
      const colour=s.bound!==true?[33,35,35]:s.state==='error'?[223,82,67]:s.state==='online'?[84,207,163]:[181,129,57];
      for(const point of e.centres)ellipse(c,point[0],point[1],.009,.005,rgb(colour,.85));return;
    }
    if(e.kind==='door'){
      // Native setDoorState contract: open, closed, jammed. Only the existing
      // central eye changes here; body/iris geometry remains source-authored.
      if(s.door==='closed')fill([12,18,20],.96);
      else if(s.door==='jammed')fill([225,82,64],.68);
      return;
    }
    if(e.kind==='pins'){
      const n=finite(s.pins)?Math.max(0,Math.min(12,Math.floor(s.pins))):0;
      for(let i=0;i<n;i++){const x=b.x+.04+(i%6)*b.width/6,y=b.y+.06+Math.floor(i/6)*b.height*.43;c.fillStyle=rgb(s.hot?C.amber:C.cyan,.72);c.fillRect(x,y,b.width*.075,b.height*.23);}
      if(s.jam===true){c.fillStyle=rgb([238,160,53],.78);c.fillRect(b.x+b.width*.87,b.y,b.width*.08,b.height*.18);}return;
    }
    if(e.kind==='awards'){
      const n=finite(s.trophies)?Math.max(0,Math.min(6,Math.floor(s.trophies))):0;
      for(let i=0;i<n;i++){const x=b.x+b.width*(.16+(i%3)*.33),y=b.y+b.height*(.24+Math.floor(i/3)*.60);ellipse(c,x,y,b.width*.042,b.height*.065,rgb(e.colour,.85));c.fillStyle=rgb(e.colour,.80);c.fillRect(x-b.width*.008,y,b.width*.016,b.height*.09);}return;
    }
    if(!v)return;
    if(e.kind==='ripple'||e.kind==='water'){
      const q=frac(t/3800);c.beginPath();c.ellipse(b.x+b.width*.5,b.y+b.height*.5,b.width*(.10+.32*q),b.height*(.12+.3*q),0,0,Math.PI*1.6);c.strokeStyle=rgb(e.colour,.20*(1-q));c.lineWidth=.005;c.stroke();
    }else if(e.kind==='samples'){for(let i=0;i<3;i++)ellipse(c,b.x+b.width*(.13+i*.33),b.y+b.height*.70,b.width*.045,b.height*.05,rgb(e.colour,.14+.10*Math.sin(t/1300+i)));}
    else if(e.kind==='fish'||e.kind==='wax'||e.kind==='specimen'){
      const dx=e.kind==='fish'?.007*Math.sin(t/2200+phase):0,dy=(e.kind==='wax'?.010:e.kind==='specimen'?.005:.003)*Math.sin(t/3900+phase);
      sourcePatch(c,p,e,dx,dy);
      if(e.kind!=='wax')for(let i=0;i<2;i++){const q=frac(t/7100+i*.43+phase);ellipse(c,b.x+b.width*(.85-i*.1),b.y+b.height*(1-q),.003,.005,rgb(e.colour,.16*(1-q)));}
    }else if(e.kind==='plasma'){
      for(let i=0;i<4;i++){const a=i*Math.PI/2+t/4200,ox=e.origin[0],oy=e.origin[1],tx=ox+Math.cos(a)*b.width*.42,ty=oy+Math.sin(a)*b.height*.42;line(c,[[ox,oy],[(ox+tx)/2+.014*Math.sin(t/380+i),(oy+ty)/2],[tx,ty]],rgb(e.colour,.24),.005);}
    }else if(e.kind==='steam'){
      const q=frac(t/3400);if(q>.78)return;const k=q/.78,rise=e.rise*k,ox=e.origin[0],oy=e.origin[1];
      for(let i=0;i<3;i++)ellipse(c,ox+Math.sin(t/900+i)*.025,oy-rise+i*e.rise*.13,.028+i*.009,.045,rgb(e.colour,.15*(1-k)*(1-i*.22)));
    }else if(e.kind==='hologram'){
      const ox=e.origin[0],oy=e.origin[1],top=oy-e.rise;
      line(c,[[ox-.11,oy],[ox-.27,top],[ox+.27,top],[ox+.11,oy]],rgb(e.colour,.13+.025*wave),.012);
      line(c,[[ox-.21,top+.18],[ox+.21,top+.18]],rgb(e.colour,.18),.018);
    }else if(e.kind==='holo'){line(c,[[b.x+b.width*.24,b.y+b.height*.20],[b.x+b.width*.74,b.y+b.height*.20]],rgb(e.colour,.08+.06*wave),.007);}
    else if(e.kind==='cold'){line(c,[[b.x+b.width*.18,b.y+b.height*.18],[b.x+b.width*.23,b.y+b.height*.80]],rgb(e.colour,.07+.025*wave),.007);}
    else if(e.kind==='cone'){ellipse(c,b.x+b.width*.5,b.y+b.height*.5,b.width*(.32+.006*wave),b.height*(.32+.006*wave),rgb(e.colour,.09));}
    else if(e.kind==='light')fill(e.colour,.035); // steady fixture illumination, never activity
  }
  function draw(ctx,id,view,box,state={},prepared=null){
    const entry=classify(id,view);if(!entry||entry.classification!=='effects'||!box)return false;
    const sw=box.sourceWidth,sh=box.sourceHeight,crop=box.crop||{x:0,y:0,width:sw,height:sh};
    if(sw!==entry.binding.width||sh!==entry.binding.height||![box.x,box.y,box.width,box.height,crop.x,crop.y,crop.width,crop.height].every(finite)||box.width<=0||box.height<=0||crop.width<=0||crop.height<=0||crop.x<0||crop.y<0||crop.x+crop.width>sw||crop.y+crop.height>sh)return false;
    const t=state.still===true?0:Math.max(0,finite(state.now)?state.now:0);
    const p=prepared&&prepared.id===id&&prepared.view===view&&prepared.binding===entry.binding?prepared:null;
    ctx.save();try{
      ctx.translate(box.x-crop.x/crop.width*box.width,box.y-crop.y/crop.height*box.height);
      ctx.scale(sw/crop.width*box.width,sh/crop.height*box.height);
      ctx.globalCompositeOperation='source-over';
      for(const e of entry.effects){if(e.kind==='hologram')emit(ctx,e,state,t,p);else clipped(ctx,e.region,()=>emit(ctx,e,state,t,p));}
    }finally{ctx.restore();}
    return true;
  }
  function frameBounds(id,view='s'){
    if(!classify(id,view)||!designs[id]||view!=='s')return null;
    const points=[[0,0],[1,1]];for(const e of designs[id]){points.push(...e.region);if(e.rise&&e.origin)points.push([e.origin[0],e.origin[1]-e.rise]);}
    const b=bbox(points);if(b.y<0){b.y-=.01;b.height+=.01;}return b; // stroke/antialias allowance above emitters
  }
  const ids=Object.freeze(Object.keys(designs));
  function dispose(p){if(p&&p.image){p.image.width=1;p.image.height=1;p.image=null;}}
  return {ids,regions,classify,matches,prepare,draw,frameBounds,dispose,screenEmission,coverage:()=>Object.fromEntries(Object.keys(BINDINGS).map(id=>[id,Object.fromEntries(Object.keys(BINDINGS[id]).map(v=>[v,classify(id,v)]))]))};
})();
if(typeof module!=='undefined')module.exports=ProjectionPropEffects;
