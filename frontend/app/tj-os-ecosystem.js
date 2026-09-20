/* TJ OS — ecosystem registry. Pure identity/navigation metadata; no runtime state or persistence. */
'use strict';
(function(root){
  /*
   * Spatial design contract:
   * - This registry is a presentation/layout catalog only.
   * - It does not mutate saved worlds, agents, props, paths or persistence.
   * - Coordinates are logical world-tile anchors for the future physical layout pass.
   * - Every surface key maps to an existing WorldModel catalog value.
   */
  const ZONES=Object.freeze([
    {id:'core',name:'TJ CORE',kind:'hub',purpose:'OS control, global status, orchestration and navigation',visual:{kind:'hub',floor:'oak',wall:'wainscot',hull:'timber',anchor:[0,0],size:[18,11]}},
    {id:'forge',name:'TJ FORGE',kind:'workshop',purpose:'code, Git, terminal, build, test and deployment',visual:{kind:'workshop',floor:'rust',wall:'utility',hull:'station',anchor:[22,0],size:[16,10]}},
    {id:'labs',name:'TJ LABS',kind:'research',purpose:'AI research, analysis, experiments and knowledge',visual:{kind:'research',floor:'sterile',wall:'acoustic',hull:'curtain',anchor:[22,15],size:[16,10]}},
    {id:'studio',name:'TJ STUDIO',kind:'creative',purpose:'design, writing, media and creative production',visual:{kind:'creative',floor:'orchid',wall:'wainscot',hull:'clapboard',anchor:[-20,15],size:[16,10]}},
    {id:'vault',name:'TJ VAULT',kind:'archive',purpose:'files, documents, archives, backups and protected data',visual:{kind:'archive',floor:'walnut',wall:'wainscot',hull:'stone',anchor:[-20,0],size:[16,10]}},
    {id:'network',name:'TJ NETWORK',kind:'network',purpose:'APIs, integrations, communications and data exchange',visual:{kind:'network',floor:'teal',wall:'utility',hull:'thermal',anchor:[0,16],size:[14,8]}},
    {id:'garden',name:'TJ GARDEN',kind:'garden',purpose:'notes, ideas, personal knowledge and productivity',visual:{kind:'garden',floor:'meadow',wall:'hedge',hull:'hedge',anchor:[-20,-12],size:[16,8]}},
    {id:'observatory',name:'TJ OBSERVATORY',kind:'metrics',purpose:'analytics, trends, performance and ecosystem health',visual:{kind:'metrics',floor:'indigo',wall:'acoustic',hull:'curtain',anchor:[58,16],size:[14,8]}},
    {id:'security',name:'TJ SECURITY',kind:'security',purpose:'authentication, permissions, access control and security events',visual:{kind:'security',floor:'cobalt',wall:'pressure',hull:'monocoque',anchor:[58,28],size:[12,8]}},
    {id:'village',name:'AGENT VILLAGE',kind:'agents',purpose:'persistent agent workstations, identity and status',visual:{kind:'agents',floor:'fern',wall:'hedge',hull:'timber',anchor:[-40,15],size:[16,12]}},
    {id:'meeting',name:'TJ MEETING HALL',kind:'meeting',purpose:'evidence-backed strategic collaboration and decisions',visual:{kind:'meeting',floor:'ash',wall:'acoustic',hull:'clapboard',anchor:[40,28],size:[16,10]}},
    {id:'commons',name:'TJ COMMONS',kind:'commons',purpose:'idle recovery, social space and agent restaurant',visual:{kind:'commons',floor:'meadow',wall:'hedge',hull:'shingle',anchor:[0,28],size:[18,10]}}
  ]);

  /*
   * Physical-layout blueprint.
   * The core stays at the original starter footprint. The remaining facilities are deliberately
   * separated by corridors so the eventual world-model seeding can use addRoom()/placeHallway()
   * instead of teleporting zones or changing agent behavior.
   */
  const WORLD_LAYOUT=Object.freeze({
    version:1,
    grid:'world-tile',
    origin:'core',
    corridors:[
      {from:'core',to:'forge',axis:'x'},
      {from:'core',to:'vault',axis:'x'},
      {from:'core',to:'network',axis:'y'},
      {from:'garden',to:'core',axis:'x'},
      {from:'network',to:'commons',axis:'y'},
      {from:'commons',to:'meeting',axis:'x'},
      {from:'meeting',to:'security',axis:'y'},
      {from:'security',to:'observatory',axis:'y'},
      {from:'forge',to:'labs',axis:'y'},
      {from:'vault',to:'studio',axis:'y'},
      {from:'studio',to:'village',axis:'x'},
      {from:'labs',to:'observatory',axis:'x'}
    ],
    navigation:'world-mode spatial launcher; command-mode remains authoritative fallback'
  });

  const byId=Object.freeze(ZONES.reduce((m,z)=>(m[z.id]=z,m),{}));
  function get(id){return byId[String(id||'').toLowerCase()]||null;}
  root.TJOS_ECOSYSTEM=Object.freeze({
    version:3,
    name:'TJ OS ECOSYSTEM',
    zones:ZONES,
    layout:WORLD_LAYOUT,
    get,
    all:()=>ZONES.slice()
  });
})(typeof globalThis!=='undefined'?globalThis:this);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.TJOS_ECOSYSTEM;
