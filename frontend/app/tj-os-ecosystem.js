/* TJ OS — ecosystem registry. Pure identity/navigation metadata; no runtime state or persistence. */
'use strict';
(function(root){
  const ZONES=Object.freeze([
    {id:'core',name:'TJ CORE',kind:'hub',purpose:'OS control, global status, orchestration and navigation'},
    {id:'forge',name:'TJ FORGE',kind:'workshop',purpose:'code, Git, terminal, build, test and deployment'},
    {id:'labs',name:'TJ LABS',kind:'research',purpose:'AI research, analysis, experiments and knowledge'},
    {id:'studio',name:'TJ STUDIO',kind:'creative',purpose:'design, writing, media and creative production'},
    {id:'vault',name:'TJ VAULT',kind:'archive',purpose:'files, documents, archives, backups and protected data'},
    {id:'network',name:'TJ NETWORK',kind:'network',purpose:'APIs, integrations, communications and data exchange'},
    {id:'garden',name:'TJ GARDEN',kind:'garden',purpose:'notes, ideas, personal knowledge and productivity'},
    {id:'observatory',name:'TJ OBSERVATORY',kind:'metrics',purpose:'analytics, trends, performance and ecosystem health'},
    {id:'security',name:'TJ SECURITY',kind:'security',purpose:'authentication, permissions, access control and security events'},
    {id:'village',name:'AGENT VILLAGE',kind:'agents',purpose:'persistent agent workstations, identity and status'},
    {id:'meeting',name:'TJ MEETING HALL',kind:'meeting',purpose:'evidence-backed strategic collaboration and decisions'},
    {id:'commons',name:'TJ COMMONS',kind:'commons',purpose:'idle recovery, social space and agent restaurant'}
  ]);
  const byId=Object.freeze(ZONES.reduce((m,z)=>(m[z.id]=z,m),{}));
  function get(id){return byId[String(id||'').toLowerCase()]||null;}
  root.TJOS_ECOSYSTEM=Object.freeze({version:1,name:'TJ OS ECOSYSTEM',zones:ZONES,get,all:()=>ZONES.slice()});
})(typeof globalThis!=='undefined'?globalThis:this);
if(typeof module!=='undefined'&&module.exports)module.exports=globalThis.TJOS_ECOSYSTEM;
