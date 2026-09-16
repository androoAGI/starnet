/* Isolated development station. Real roster, pathfinding and furniture; no generated work events. */
'use strict';
(() => {
  if (!['127.0.0.1','localhost'].includes(location.hostname)) return;
  const skins=[['approved_ultron','ultron','Ultron'],['skeleton','skeleton','Skeleton'],['plaguedoctor','plaguedoctor','Plague Doctor'],['secretagent','secretagent','Secret Agent'],['voidwizard','voidwizard','Void Wizard']];
  const nextSkins=[['pepe','pepe','Pepe'],['vaultboy','vaultboy','Fallout 1 Vault Dweller'],['bear','bear','Teddy Bear'],['ghostface','ghostface','Ghostface'],['morpheus','morpheus','Morpheus']];
  const comparisonSkins=[...skins,...nextSkins];
  const height=19; // User-approved standing height for the industrial skin rollout.
  DATA.SKINS.readability_secretagent={name:'Secret Agent readability study',set:'readability_secretagent',scale:19/76};
  for(const [skin,id,name]of skins) {
    DATA.SKINS[skin]={...DATA.SKINS[skin],name,set:'approved_'+id,scale:height/76};
    DATA.SKINS['approved_'+id]=DATA.SKINS[skin];
    DATA.SKINS['industrial_'+id]={name,set:'industrial_'+id,scale:height/76};
    DATA.SKINS['readability_'+id]={name:name+' readability study',set:'readability_'+id,scale:19/76};
  }
  for(const[,id,name]of nextSkins)for(const prefix of ['industrial_','readability_'])DATA.SKINS[prefix+id]={name,set:prefix+id,scale:height/76};
  const panel=document.createElement('aside');panel.id='agent-station-demo';
  panel.style.cssText='position:fixed;z-index:9999;bottom:55px;left:14px;padding:10px 14px;background:#10191bea;border:1px solid #877957;color:#d8ceae;font:12px monospace;max-width:420px;box-shadow:0 4px 18px #0008';
  panel.innerHTML='<strong>INDUSTRIAL CREW · LIVE STATION DEMO</strong><div style="margin:7px 0">Normal station movement · no agent tasks running</div><label>Sprite height <input aria-label="Sprite height" type="range" min="16" max="30" value="19" style="width:110px;vertical-align:middle"> <output>19 px</output></label><div style="margin-top:7px"><label>Follow <select aria-label="Follow agent" style="background:#1a2528;color:#d8ceae;padding:3px"><option value="">Station view</option></select></label> <a href="agent-motion-review.html" style="color:#98c5ca">Earlier frame study</a></div><div id="agent-demo-status" style="margin-top:7px">Loading station…</div>';
  panel.querySelector('div').textContent='Normal station movement · visual review';
  panel.querySelector('option').textContent='Choose agent';
  panel.querySelector('option').disabled=true;
  document.body.append(panel);
  const compare=document.createElement('div');
  compare.style.cssText='margin-top:9px;border-top:1px solid #877957;padding-top:8px';
  compare.innerHTML='<strong>FRONT POSE COMPARISON</strong><div>Current left · revised right · both 19 px</div><div style="margin:6px 0">Art mannequins beside live station furniture</div><button class="bb" id="review-normal">Compare at normal zoom</button> <button class="bb" id="review-close">Close look</button> <button class="bb" id="review-hide">Hide comparison</button>';
  const skinPicker=document.createElement('select');skinPicker.id='review-skin';skinPicker.className='fbc-sel';skinPicker.setAttribute('aria-label','Compare skin');
  skinPicker.style.cssText='appearance:none;background:#1a2528;color:#d8ceae;border:1px solid #877957;padding:5px 24px 5px 7px;background-image:linear-gradient(45deg,transparent 50%,#d8ceae 50%),linear-gradient(135deg,#d8ceae 50%,transparent 50%);background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;background-size:4px 4px;background-repeat:no-repeat';
  for(const[,id,name]of comparisonSkins){const o=document.createElement('option');o.value=id;o.textContent=name;skinPicker.append(o);}skinPicker.value='ultron';
  const skinLabel=document.createElement('label');skinLabel.style.cssText='display:block;margin-bottom:8px';skinLabel.textContent='Compare skin ';skinLabel.append(skinPicker);compare.prepend(skinLabel);
  const compareContainer=document.createElement('details');const compareSummary=document.createElement('summary');compareSummary.textContent='Front pose comparison';compareContainer.append(compareSummary,compare);panel.append(compareContainer);
  const setHeight=h=>{for(const entry of Object.values(DATA.SKINS))if(/^(approved|readability|industrial)_/.test(entry.set||'')||entry.sourceStandingHeight)entry.scale=h/(entry.sourceStandingHeight||76);};
  const showReview=z=>{panel.querySelector('input').value='19';panel.querySelector('output').textContent='19 px';setHeight(19);World.showSkinReview(true,z,skinPicker.value);};
  skinPicker.onchange=()=>showReview(Number(panel.dataset.reviewZoom)||2);
  compare.querySelector('#review-normal').onclick=()=>showReview(2);
  compare.querySelector('#review-close').onclick=()=>showReview(4);
  compare.querySelector('#review-hide').onclick=()=>{World.showSkinReview(false);panel.dataset.comparison='hidden';};
  panel.querySelector('input').oninput=e=>{World.showSkinReview(false);panel.dataset.comparison='hidden';const h=Number(e.target.value);setHeight(h);panel.querySelector('output').textContent=h+' px';};
  panel.querySelector('select').onchange=e=>{World.showSkinReview(false);panel.dataset.comparison='hidden';if(e.target.value)World.lockBody(e.target.value);else World.focusAgent();const id=shownSkins.get(e.target.value);if(id){liveSkin.value=id;panel.dataset.liveSkin=id;const item=catalogSkins.find(x=>x.id===id);motionStatus.textContent=describeSkin(item);}};
  let tries=0;
  let catalogSkins=[];const shownSkins=new Map();
  const liveSkin=document.createElement('select');liveSkin.setAttribute('aria-label','Live agent skin');liveSkin.className='fbc-sel';
  const liveLabel=document.createElement('label');liveLabel.style.cssText='display:block;margin-top:8px';liveLabel.textContent='Live agent skin ';liveLabel.append(liveSkin);panel.insertBefore(liveLabel,compareContainer);
  const motionStatus=document.createElement('div');motionStatus.style.marginTop='5px';liveLabel.append(motionStatus);
  const describeSkin=item=>item?.acceptedExisting?'Approved '+item.approvedRelease+' set · 19 px':item?.retainedOriginal?'Existing art · rendered at 19 px':item?.complete?'Walk and seated frames available':'Walk ready · seated frames in progress';
  const nextGroup=document.createElement('button');nextGroup.className='bb';nextGroup.textContent='Next five skins';liveLabel.append(nextGroup);let groupOffset=0;
  const showGroup=async selected=>{const agents=App.agents().slice(0,selected.length);if(!agents.length||selected.some(x=>!x?.readyForStation))return;const loaded=await Promise.all(selected.map(x=>SPRITES.ensureSkin(x.renderSet)));if(loaded.some(x=>!x)){motionStatus.textContent='Could not load the selected skins.';return;}World.showSkinReview(false);panel.dataset.comparison='hidden';for(let i=0;i<agents.length;i++){World.setSkin(agents[i].id,selected[i].renderSet);shownSkins.set(agents[i].id,selected[i].id);const option=Array.from(panel.querySelector('select').options).find(o=>o.value===agents[i].id);if(option)option.textContent=agents[i].name+' · '+selected[i].name;}panel.dataset.reviewGroup=JSON.stringify(selected.map(x=>x.id));liveSkin.value=shownSkins.get(panel.querySelector('select').value)||selected[0].id;panel.dataset.liveSkin=liveSkin.value;motionStatus.textContent=selected.map(x=>x.name).join(' · ');};
  nextGroup.onclick=async()=>{const available=catalogSkins.filter(x=>x.walkReady).concat(catalogSkins.filter(x=>x.retainedOriginal));if(!available.length)return;await showGroup(App.agents().slice(0,5).map((a,i)=>available[(groupOffset+i)%available.length]));groupOffset=(groupOffset+5)%available.length;};
  const cadets=document.createElement('button');cadets.className='bb';cadets.textContent='Cadet colors';liveLabel.append(cadets);cadets.onclick=()=>showGroup(['android','blank_blue','blank_green','blank_red','blank_amber'].map(id=>catalogSkins.find(x=>x.id===id)));
  const skinRequests=new Map();
  liveSkin.onchange=async()=>{
    const selected=catalogSkins.find(x=>x.id===liveSkin.value);if(!selected?.readyForStation)return;
    const follow=panel.querySelector('select'),id=follow.value||App.currentAgent().id,request={};skinRequests.set(id,request);
    await SPRITES.ensureSkin(selected.renderSet);if(skinRequests.get(id)!==request)return;
    World.setSkin(id,selected.renderSet);shownSkins.set(id,selected.id);
    const option=Array.from(follow.options).find(o=>o.value===id);if(option)option.textContent=(App.agents().find(a=>a.id===id)?.name||id)+' · '+selected.name;
    if(follow.value===id){World.showSkinReview(false);panel.dataset.comparison='hidden';World.lockBody(id);liveSkin.value=selected.id;panel.dataset.liveSkin=selected.id;motionStatus.textContent=describeSkin(selected);}
  };
  const workStudy=document.createElement('button');workStudy.className='bb';workStudy.textContent='Preview at workstation';
  const workNote=document.createElement('div');workNote.style.marginTop='5px';
  liveLabel.append(workStudy,workNote);let reviewingWork=false;
  const stopWorkStudy=()=>{World.showWorkPoseReview(false);reviewingWork=false;workStudy.textContent='Preview at workstation';workNote.textContent='';delete panel.dataset.workPose;};
  workStudy.onclick=()=>{
    if(reviewingWork){stopWorkStudy();World.lockBody(panel.querySelector('select').value);return;}
    const item=catalogSkins.find(x=>x.id===liveSkin.value);
    reviewingWork=!!item&&World.showWorkPoseReview(true,panel.querySelector('select').value,item.renderSet);
    workStudy.textContent=reviewingWork?'Return to live movement':'Preview at workstation';
    workNote.textContent=reviewingWork?'Workstation pose preview · visual only · no task running':'No workstation available for preview.';
  };
  liveSkin.addEventListener('change',stopWorkStudy);panel.querySelector('select').addEventListener('change',stopWorkStudy);
  nextGroup.addEventListener('click',stopWorkStudy);cadets.addEventListener('click',stopWorkStudy);
  compare.addEventListener('click',stopWorkStudy);panel.querySelector('input').addEventListener('input',stopWorkStudy);
  const speechStudy=document.createElement('details');
  speechStudy.innerHTML='<summary>Talking pose close-up</summary><div style="margin:6px 0">Pose study · 4× view</div><canvas width="300" height="120" aria-label="Talking pose study" style="width:300px;max-width:100%;background:#182023;border:1px solid #54615b"></canvas>';
  panel.append(speechStudy);const studyCanvas=speechStudy.querySelector('canvas'),studyCtx=studyCanvas.getContext('2d');let studyBody=null;
  function drawSpeechStudy(now){
    if(speechStudy.open&&panel.dataset.ready==='true'){
      const item=catalogSkins.find(x=>x.id===liveSkin.value);
      if(item&&studyBody?.skin!==item.renderSet)studyBody={id:'pose-study',skin:item.renderSet,px:37.5,py:27,dir:'south',state:'idle',aph:1.7};
      if(studyBody){studyBody.speaking=now%4700<2900;studyCtx.clearRect(0,0,300,120);studyCtx.save();studyCtx.scale(4,4);SPRITES.drawBody(studyCtx,studyBody,now,{reducedMotion:false});studyCtx.restore();speechStudy.dataset.motion=JSON.stringify({skin:studyBody.skin,speaking:studyBody.speaking,accent:studyBody._renderSpeechAccent,standingHeight:studyBody._renderStandingHeight,groundGap:studyBody._renderGroundGap});}
    }
    requestAnimationFrame(drawSpeechStudy);
  }
  requestAnimationFrame(drawSpeechStudy);
  const timer=setInterval(async()=>{
    if(++tries>180){clearInterval(timer);panel.querySelector('#agent-demo-status').textContent='Station did not finish loading.';return;}
    if(!window.__STARNET_DEV__||typeof App==='undefined'||!App.currentAgent()||!World.dbg()||!SPRITES.ready)return;
    clearInterval(timer);
    try{
      const response=await fetch('agent-demo/catalog.json',{cache:'no-store'});if(!response.ok)throw Error('Catalog unavailable');catalogSkins=(await response.json()).skins;
      for(const item of catalogSkins){const o=document.createElement('option');o.value=item.id;o.textContent=item.name+(item.acceptedExisting?' · '+item.approvedRelease:item.retainedOriginal?' · existing art':item.walkReady?'':' · pending');o.disabled=!item.readyForStation;liveSkin.append(o);if(!item.readyForStation)continue;const set=item.renderSet;DATA.SKINS[set]={name:item.name,set,scale:height/item.sourceStandingHeight,sourceStandingHeight:item.sourceStandingHeight};if(item.id!=='ultron')DATA.SKINS[item.skin]={...DATA.SKINS[item.skin],name:item.name,set,scale:height/item.sourceStandingHeight,sourceStandingHeight:item.sourceStandingHeight};}
      liveSkin.value='ultron';
      const hero=App.currentAgent();World.setSkin(hero.id,'approved_ultron');
      for(const[skin,,name]of skins.slice(1))if(!App.agents().some(a=>a.skin===skin))App.summonAgent({id:'industrial-demo-'+skin,name,agentName:name,skin},{desk:true,activate:false});
      const requiredSkins=[...skins.map(([skin])=>skin),...comparisonSkins.map(([,id])=>'readability_'+id),...comparisonSkins.map(([,id])=>'industrial_'+id)];
      const loaded=await Promise.all(requiredSkins.map(skin=>SPRITES.ensureSkin(skin)));
      const missing=requiredSkins.filter((_,i)=>!loaded[i]);if(missing.length)throw new Error('Could not load: '+missing.join(', '));
      const picker=panel.querySelector('select');
      for(const a of App.agents()){shownSkins.set(a.id,a.id===hero.id?'ultron':catalogSkins.find(x=>x.skin===a.skin)?.id);const o=document.createElement('option');o.value=a.id;o.textContent=a.id===hero.id?a.name+' · Ultron':a.name;picker.append(o);}
      const redesigned=catalogSkins.filter(x=>x.walkReady).length,retained=catalogSkins.filter(x=>x.retainedOriginal).length,pending=catalogSkins.length-redesigned-retained;
      panel.querySelector('#agent-demo-status').textContent='19 px · '+redesigned+' redesigned · '+retained+' existing'+(pending?' · '+pending+' pending':'');
      panel.dataset.revision='industrial-rollout-19px';
      World.showSkinReview(false);panel.dataset.comparison='hidden';
      picker.value=hero.id;World.lockBody(hero.id);
      await nextGroup.onclick();
      panel.dataset.ready='true';
    }catch(e){panel.querySelector('#agent-demo-status').textContent='Demo setup: '+e.message;console.error(e);}
  },500);
})();
