/* Isolated development station. Real roster, pathfinding and furniture; no generated work events. */
'use strict';
(() => {
  if (!['127.0.0.1','localhost'].includes(location.hostname)) return;
  const skins=[['blank','ultron','Ultron'],['skeleton','skeleton','Skeleton'],['plaguedoctor','plaguedoctor','Plague Doctor'],['secretagent','secretagent','Secret Agent'],['voidwizard','voidwizard','Void Wizard']];
  const height=18; // Original Secret Agent is 41 * .404 = 16.56 world pixels; this is 8.7% taller.
  DATA.SKINS.readability_secretagent={name:'Secret Agent readability study',set:'readability_secretagent',scale:18/76};
  for(const [skin,id,name]of skins) {
    DATA.SKINS[skin]={...DATA.SKINS[skin],name,set:'approved_'+id,scale:height/76};
    DATA.SKINS['approved_'+id]=DATA.SKINS[skin];
    DATA.SKINS['industrial_'+id]={name,set:'industrial_'+id,scale:height/76};
    DATA.SKINS['readability_'+id]={name:name+' readability study',set:'readability_'+id,scale:18/76};
  }
  const panel=document.createElement('aside');panel.id='agent-station-demo';
  panel.style.cssText='position:fixed;z-index:9999;bottom:55px;left:14px;padding:10px 14px;background:#10191bea;border:1px solid #877957;color:#d8ceae;font:12px monospace;max-width:420px;box-shadow:0 4px 18px #0008';
  panel.innerHTML='<strong>INDUSTRIAL CREW · LIVE STATION DEMO</strong><div style="margin:7px 0">Normal station movement · no agent tasks running</div><label>Sprite height <input aria-label="Sprite height" type="range" min="16" max="30" value="18" style="width:110px;vertical-align:middle"> <output>18 px</output></label><div style="margin-top:7px"><label>Follow <select aria-label="Follow agent" style="background:#1a2528;color:#d8ceae;padding:3px"><option value="">Station view</option></select></label> <a href="agent-motion-review.html" style="color:#98c5ca">Earlier frame study</a></div><div id="agent-demo-status" style="margin-top:7px">Loading station…</div>';
  panel.querySelector('div').textContent='Normal station movement · visual review';
  panel.querySelector('option').textContent='Choose agent';
  panel.querySelector('option').disabled=true;
  document.body.append(panel);
  const compare=document.createElement('div');
  compare.style.cssText='margin-top:9px;border-top:1px solid #877957;padding-top:8px';
  compare.innerHTML='<strong>FRONT POSE COMPARISON</strong><div>Current left · revised right · both 18 px</div><div style="margin:6px 0">Art mannequins beside live station furniture</div><button class="bb" id="review-normal">Compare at normal zoom</button> <button class="bb" id="review-close">Close look</button> <button class="bb" id="review-hide">Hide comparison</button>';
  const skinPicker=document.createElement('select');skinPicker.id='review-skin';skinPicker.className='fbc-sel';skinPicker.setAttribute('aria-label','Compare skin');
  skinPicker.style.cssText='appearance:none;background:#1a2528;color:#d8ceae;border:1px solid #877957;padding:5px 24px 5px 7px;background-image:linear-gradient(45deg,transparent 50%,#d8ceae 50%),linear-gradient(135deg,#d8ceae 50%,transparent 50%);background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;background-size:4px 4px;background-repeat:no-repeat';
  for(const[,id,name]of skins){const o=document.createElement('option');o.value=id;o.textContent=name;skinPicker.append(o);}skinPicker.value='ultron';
  const skinLabel=document.createElement('label');skinLabel.style.cssText='display:block;margin-bottom:8px';skinLabel.textContent='Compare skin ';skinLabel.append(skinPicker);compare.prepend(skinLabel);
  panel.append(compare);
  const showReview=z=>{panel.querySelector('input').value='18';panel.querySelector('output').textContent='18 px';for(const[skin]of skins)DATA.SKINS[skin].scale=18/76;World.showSkinReview(true,z,skinPicker.value);};
  skinPicker.onchange=()=>showReview(Number(panel.dataset.reviewZoom)||2);
  compare.querySelector('#review-normal').onclick=()=>showReview(2);
  compare.querySelector('#review-close').onclick=()=>showReview(4);
  compare.querySelector('#review-hide').onclick=()=>{World.showSkinReview(false);panel.dataset.comparison='hidden';};
  panel.querySelector('input').oninput=e=>{World.showSkinReview(false);panel.dataset.comparison='hidden';const h=Number(e.target.value);for(const[skin]of skins)DATA.SKINS[skin].scale=h/76;panel.querySelector('output').textContent=h+' px';};
  panel.querySelector('select').onchange=e=>{World.showSkinReview(false);panel.dataset.comparison='hidden';if(e.target.value)World.lockBody(e.target.value);else World.focusAgent();};
  let tries=0;
  const timer=setInterval(async()=>{
    if(++tries>180){clearInterval(timer);panel.querySelector('#agent-demo-status').textContent='Station did not finish loading.';return;}
    if(!window.__STARNET_DEV__||typeof App==='undefined'||!App.currentAgent()||!World.dbg()||!SPRITES.ready)return;
    clearInterval(timer);
    try{
      const hero=App.currentAgent();World.setSkin(hero.id,'blank');
      for(const[skin,,name]of skins.slice(1))if(!App.agents().some(a=>a.skin===skin))App.summonAgent({id:'industrial-demo-'+skin,name,agentName:name,skin},{desk:true,activate:false});
      const requiredSkins=[...skins.map(([skin])=>skin),...skins.map(([,id])=>'readability_'+id),...skins.map(([,id])=>'industrial_'+id)];
      const loaded=await Promise.all(requiredSkins.map(skin=>SPRITES.ensureSkin(skin)));
      const missing=requiredSkins.filter((_,i)=>!loaded[i]);if(missing.length)throw new Error('Could not load: '+missing.join(', '));
      const picker=panel.querySelector('select');
      for(const a of App.agents()){const o=document.createElement('option');o.value=a.id;o.textContent=a.id===hero.id?a.name+' · Ultron':a.name;picker.append(o);}
      panel.querySelector('#agent-demo-status').textContent='Repaired walk cycles · five animated skins';
      panel.dataset.revision='grounded-walks-0915';
      panel.dataset.ready='true';
      World.showSkinReview(false);panel.dataset.comparison='hidden';
      picker.value=hero.id;World.lockBody(hero.id);
    }catch(e){panel.querySelector('#agent-demo-status').textContent='Demo setup: '+e.message;console.error(e);}
  },500);
})();
