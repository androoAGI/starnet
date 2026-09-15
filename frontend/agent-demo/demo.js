/* Isolated development station. Real roster, pathfinding and furniture; no generated work events. */
'use strict';
(() => {
  if (!['127.0.0.1','localhost'].includes(location.hostname)) return;
  const skins=[['blank','ultron','Ultron'],['skeleton','skeleton','Skeleton'],['plaguedoctor','plaguedoctor','Plague Doctor'],['secretagent','secretagent','Secret Agent'],['voidwizard','voidwizard','Void Wizard']];
  const height=18; // Original Secret Agent is 41 * .404 = 16.56 world pixels; this is 8.7% taller.
  for(const [skin,id,name]of skins) {
    DATA.SKINS[skin]={...DATA.SKINS[skin],name,set:'industrial_'+id,scale:height/76};
    DATA.SKINS['industrial_'+id]=DATA.SKINS[skin];
  }
  const panel=document.createElement('aside');panel.id='agent-station-demo';
  panel.style.cssText='position:fixed;z-index:9999;bottom:55px;left:14px;padding:10px 14px;background:#10191bea;border:1px solid #877957;color:#d8ceae;font:12px monospace;max-width:420px;box-shadow:0 4px 18px #0008';
  panel.innerHTML='<strong>INDUSTRIAL CREW · LIVE STATION DEMO</strong><div style="margin:7px 0">Normal station movement · no agent tasks running</div><label>Sprite height <input aria-label="Sprite height" type="range" min="16" max="30" value="18" style="width:110px;vertical-align:middle"> <output>18 px</output></label><div style="margin-top:7px"><label>Follow <select aria-label="Follow agent" style="background:#1a2528;color:#d8ceae;padding:3px"><option value="">Station view</option></select></label> <a href="agent-motion-review.html" style="color:#98c5ca">Frame review</a></div><div id="agent-demo-status" style="margin-top:7px">Loading station…</div>';
  panel.querySelector('div').textContent='Normal station movement · visual review';
  panel.querySelector('option').textContent='Choose agent';
  panel.querySelector('option').disabled=true;
  document.body.append(panel);
  panel.querySelector('input').oninput=e=>{const h=Number(e.target.value);for(const[skin]of skins)DATA.SKINS[skin].scale=h/76;panel.querySelector('output').textContent=h+' px';};
  panel.querySelector('select').onchange=e=>{if(e.target.value)World.lockBody(e.target.value);else World.focusAgent();};
  let tries=0;
  const timer=setInterval(async()=>{
    if(++tries>180){clearInterval(timer);panel.querySelector('#agent-demo-status').textContent='Station did not finish loading.';return;}
    if(!window.__STARNET_DEV__||typeof App==='undefined'||!App.currentAgent()||!World.dbg())return;
    clearInterval(timer);
    try{
      const hero=App.currentAgent();World.setSkin(hero.id,'blank');
      for(const[skin,,name]of skins.slice(1))if(!App.agents().some(a=>a.skin===skin))App.summonAgent({id:'industrial-demo-'+skin,name,agentName:name,skin},{desk:true,activate:false});
      await Promise.all(skins.map(([skin])=>SPRITES.ensureSkin(skin)));
      const picker=panel.querySelector('select');
      for(const a of App.agents()){const o=document.createElement('option');o.value=a.id;o.textContent=a.id===hero.id?a.name+' · Ultron':a.name;picker.append(o);}
      panel.querySelector('#agent-demo-status').textContent='Five animated skins · 18 px is 9% taller than the old Secret Agent';
      panel.dataset.ready='true';
    }catch(e){panel.querySelector('#agent-demo-status').textContent='Demo setup: '+e.message;console.error(e);}
  },500);
})();
