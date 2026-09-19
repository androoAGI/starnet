        flicker; fire and plasma breathe; lamps hold steady. `work` gates a workstation: an idle desk's CRT is
        a dark slab (that is what the art shows), so it emits only while its agent is actually working —
        truthful telemetry, not a mood light. Values are WORLD px (TILE = 12), authored for camera scale 2. */
  const SHADOW_RGB = '8,10,24';                     // a shadow has a colour: cool, the bounce-lit unlit side
  // standing height in shadow REACH px beyond the footprint's south-east edges; footprint h>=2 adds its own
  const SHADOW_TALL = { vault: 4, core: 4, connector_portal: 3, arcade: 3, arcade2: 3, bookshelf: 3, rackV: 3, cryopod: 3,
    telescope: 2, telescope_r: 2, tallplant: 2, quarters_vending: 3, quarters_lockerbank: 3, jukebox: 3, pinball: 2, safe: 3,
    war_intelcab: 3, comms_beacon: 3, bridge_relaystack: 3, incubator: 2, fabricator: 3, vat: 3, etsy_kiln: 3, etsy_dyevat: 2,
    commswall: 3, bigscreen: 3, calwall: 2, chartwall: 2, arc_indexwall: 2, weaponrack: 2, weaponrack_r: 2, shelf: 2, rack: 2,
    war_threatcore: 3, bridge_dispatch_pylon: 3, research_corelens: 3, research_trendpillar: 3, pub_outboundchute: 3,
    punchbag: 2, punchbag_r: 2, camerarig: 2, camerarig_r: 2, treasury_token_furnace: 3, monstera: 1, tv: 2, couch: 1 };
  /* 2.5D physical profile contract. Presentation-only metadata shared by shadow/depth systems. */
  const PROP_2_5D = {
    arc_floorlight:{profile:'flat',height:0}, steamvent:{profile:'flat',height:0}, industrial_floorvent:{profile:'flat',height:0}, industrial_cabletray:{profile:'flat',height:0},
    industrial_roundtable:{profile:'low',height:8,surface:true}, dinertable:{profile:'low',height:8,surface:true}, booth:{profile:'low',height:8,surface:true},
    desk:{profile:'low',height:12,surface:true}, desk2:{profile:'low',height:12,surface:true}, console:{profile:'low',height:12,surface:true}, consoleL:{profile:'low',height:12,surface:true}, pixelrig:{profile:'low',height:12,surface:true},
    bench:{profile:'low',height:10}, workbench:{profile:'low',height:10}, industrial_bench:{profile:'low',height:10}, industrial_planter:{profile:'low',height:8}, industrial_toolcaddy:{profile:'low',height:6},
    industrial_supplycart:{profile:'medium',height:14}, industrial_locker:{profile:'tall',height:24}, industrial_drawerbank:{profile:'medium',height:15}, industrial_partition:{profile:'tall',height:21}, industrial_servicecab:{profile:'tall',height:29}, industrial_wallpanel:{profile:'wall',height:25},
    vault:{profile:'tall',height:24}, core:{profile:'tall',height:24}, connector_portal:{profile:'tall',height:24}, safe:{profile:'tall',height:24}, rack:{profile:'tall',height:24}, rackV:{profile:'tall',height:24}, shelf:{profile:'tall',height:24},
    comms_beacon:{profile:'tall',height:24}, bridge_relaystack:{profile:'tall',height:24}, bigscreen:{profile:'wall',height:18}, commswall:{profile:'wall',height:19}, calwall:{profile:'wall',height:18}, chartwall:{profile:'wall',height:18}, arc_indexwall:{profile:'wall',height:18},
    plant:{profile:'medium',height:14}, monstera:{profile:'medium',height:18}, tv:{profile:'medium',height:18}, couch:{profile:'medium',height:14}
  };
  function depthProfile(id) {
    const p=PROP_2_5D[id]; if(p) return Object.assign({},p);
    const h=SHADOW_TALL[id]||0;
    return {profile:h>=3?'tall':h>0?'medium':'low',height:h?12+h*4:6};
  }
  // Cache only silhouette geometry: work lights and animation never change the shadow.
  // A sheared, vertically compressed silhouette projects the standing sprite onto the deck.
  const shadowMasks = new Map();
  function shadowMask(f) {
    if (typeof document === 'undefined') return null;
    const key=[f.t,f.w||1,f.h||1,f.r||0,f.m||0,
      typeof IndustrialTextures !== 'undefined' && IndustrialTextures.enabled(), remasterStyle()].join('|');
    if(shadowMasks.has(key)) {
      const cached=shadowMasks.get(key),g=cached.getContext('2d');
      if(g && !(g.isContextLost && g.isContextLost()))return cached;