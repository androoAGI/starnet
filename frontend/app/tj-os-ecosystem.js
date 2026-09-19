/* TJ OS — ecosystem registry. Pure identity/navigation metadata; no runtime state or persistence. */
'use strict';
(function(root){
  const ZONES=Object.freeze([
    {id:'core',name:'TJ CORE',kind:'hub',purpose:'OS control, global status, orchestration and navigation',visual:{kind:'hub',floor:'oak',wall:'wainscot',hull:'timber',anchor:[0,0],size:[18,11]}},
    {id:'forge',name:'TJ FORGE',kind:'workshop',purpose:'code, Git, terminal, build, test and deployment',visual:{kind:'workshop',floor:'rust',wall:'utility',hull:'heatsink',anchor:[22,0],size:[16,10]}},
    {id:'labs',name:'TJ LABS',kind:'research',purpose:'AI research, analysis, experiments and knowledge',visual:{kind:'research',floor:'sterile',wall:'acoustic',hull:'curtain',anchor:[22,15],size:[16,10]}},
    {id:'studio',name:'TJ STUDIO',kind:'creative',purpose:'design, writing, media and creative production',visual:{kind:'creative',floor:'orchid',wall:'wainscot',hull:'clapboard',anchor:[-20,15],size:[16,10]}},
    {id:'vault',name:'TJ VAULT',kind:'archive',purpose:'files, documents, archives, backups and protected data',visual:{kind:'archive',floor:'walnut',wall:'wainscot',hull:'stone',anchor:[-20,0],size:[16,10]}},
    {id:'network',name:'TJ NETWORK',kind:'network',purpose:'APIs, integrations, communications and data exchange',visual:{kind:'network',floor:'teal',wall:'utility',hull:'thermal',anchor:[0,16],size:[14,8]}},
    {id:'garden',name:'TJ GARDEN',kind:'garden',purpose:'notes, ideas, personal knowledge and productivity',visual:{kind:'garden',floor:'meadow',wall:'hedge',hull:'hedge',anchor:[-20,-12],size:[16,8]}},
    {id:'observatory',name:'TJ OBSERVATORY',kind:'metrics',purpose:'analytics, trends, performance and ecosystem health',visual:{kind:'metrics',floor:'indigo',wall:'acoustic',hull:'curtain',anchor:[18,-12],size:[14,8]}},
    {id:'security',name:'TJ SECURITY',kind:'security',purpose:'authentication, permissions, access control and security events',visual:{kind:'security',floor:'cobalt',wall:'pressure',hull:'monocoque',anchor:[38,14],size:[12,8]}},
    {id:'village',name:'AGENT VILLAGE',kind:'agents',purpose:'persistent agent workstations, identity and status',visual:{kind:'agents',floor:'fern',wall:'hedge',hull:'timber',anchor:[-40,-4],size:[16,12]}},
    {id:'meeting',name:'TJ MEETING HALL',kind:'meeting',purpose:'evidence-backed strategic collaboration and decisions',visual:{kind:'meeting',floor:'ash',wall:'acoustic',hull:'clapboard',anchor:[40,-6],size:[16,10]}},
    {id:'commons',name:'TJ COMMONS',kind:'commons',purpose:'idle recovery, social space and agent restaurant',visual:{kind:'commons',floor:'meadow',wall:'hedge',hull:'shingle',anchor:[0,-16],size:[18,10]}}
  ]);
  const byId=Object.freeze(ZONES.reduce((m,z)=>(m[z.id]=z,m),{}));
  function get(id){return byId[String(id||'').toLowerCase()]||null;}
  root.TJOS_ECOSYSTEM=Object.freeze({version:1,name:'TJ OS ECOSYSTEM',zones:ZONES,get,all:()=>ZONES.slice()});
})(typeof globalThis!=='undefined'?globalThis:this);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.TJOS_ECOSYSTEM;
