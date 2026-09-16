/* Opt-in local appearance preview. Never changes saved agents or their activity. */
'use strict';
const SkinStudy=(()=>{
 const enabled=['127.0.0.1','localhost'].includes(location.hostname)&&new URLSearchParams(location.search).get('skinSet')==='study';
 const bySet={},assigned=new Map();let selection='mixed',sets=[];
 async function install(man){
  if(!enabled)return;
  const response=await fetch('assets/skin-study-0914/runtime-motion.json');if(!response.ok)throw Error('Skin study manifest missing');
  const data=await response.json();
  Object.assign(man.sprites,data.sprites);
  for(const skin of data.skins.filter(s=>s.readyForStation)){const set=skin.renderSet;bySet[set]=skin;sets.push(set);DATA.SKINS[set]={name:skin.name,set,scale:data.standingHeight/skin.sourceStandingHeight,sourceStandingHeight:skin.sourceStandingHeight};}
  const panel=document.createElement('aside');panel.id='skin-study-preview';panel.style.cssText='position:fixed;z-index:99999;top:58px;left:16px;padding:8px 12px;background:#091214e8;border:1px solid #746546;color:#d7c89d;font:12px VT323,monospace;max-width:calc(100vw - 32px)';
  const label=document.createElement('label');label.textContent=sets.length+' skins · animated preview ';
  const picker=document.createElement('select');picker.setAttribute('aria-label','Preview agent skin');picker.style.cssText='background:#172124;color:#ded5b6;border:1px solid #746546;padding:4px';
  for(const [value,text]of [['mixed','Mixed crew'],...sets.map(set=>[set,bySet[set].name+(bySet[set].retainedOriginal?' (original)':'')])]){const option=document.createElement('option');option.value=value;option.textContent=text;picker.append(option);}
  picker.onchange=()=>{selection=picker.value;panel.dataset.selection=selection;};label.append(picker);panel.append(label);
  const catalog=document.createElement('a');catalog.href='prop-catalog-review.html?propSet=projection';catalog.textContent='Review all props';catalog.style.cssText='display:block;color:#bda77a;margin-top:6px;text-underline-offset:3px';panel.append(catalog);
  document.body.append(panel);panel.dataset.expected=String(sets.length);panel.dataset.selection='mixed';
 }
 function setFor(b){
  if(!enabled||!sets.length)return null;
  if(selection!=='mixed')return selection;
  const id=String(b.id||'preview');if(!assigned.has(id))assigned.set(id,sets[assigned.size%sets.length]);
  return assigned.get(id);
 }
 function scale(set){return DATA.SKINS[set]?.scale;}
 function frame(set,dir){return bySet[set]?.views?.[dir];}
 return {enabled,install,setFor,scale,frame,get sets(){return sets;}};
})();
