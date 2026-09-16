const fs=require('fs'),vm=require('vm'),path=require('path'),sharp=require('sharp'),assert=require('node:assert/strict');
const source=fs.readFileSync('frontend/agent-demo/sprites.js','utf8');
const catalog=JSON.parse(fs.readFileSync('frontend/agent-demo/catalog.json')).skins;
const manifest=JSON.parse(fs.readFileSync('frontend/agent-demo/manifest.json')).sprites;
(async()=>{
 const frames={},skins={},loadedSets=new Set(),rows=[];
 for(const skin of catalog){skins[skin.renderSet]=skin;loadedSets.add(skin.renderSet);for(const [key,paths] of Object.entries(manifest).filter(([key])=>key.startsWith(skin.renderSet+'.'))){frames[key]=await Promise.all(paths.map(async rel=>{const {data,info}=await sharp(path.resolve('frontend/assets/sprites',rel)).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {width:info.width,height:info.height,data};}));}}
 const document={createElement(){let frame;return {getContext(){return {drawImage(f){frame=f},getImageData(){return {data:frame.data}}}}}}};
 const c={Math,WeakMap,document,DATA:{SKINS:skins},frames,loadedSets,DEFAULT_FOOT:23,footPad:{},isReviewSet:set=>set.startsWith('approved_'),setForBody:b=>b.skin,bodyLight:()=>null,loadSet(){},renderDir8:(b,d)=>d,pick8:(set,names,d)=>set+'.'+names[0]+'.'+d,pick:(set,names,d)=>set+'.'+names[0]+'.'+d,tintFrames:(id,key)=>frames[key],drawScaleFor:set=>19/skins[set].sourceStandingHeight,lightFrame:f=>f,groundShadow(){},ang:x=>x,DIR8_A:{},TURN_STEP_W:1};
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('  function measureFootPad('),source.indexOf('  function tintFrames(')),c);
 vm.runInContext(source.slice(source.indexOf('  function drawBody('),source.indexOf('  /* loading */')),c);
 for(const skin of catalog){let count=0,minGap=Infinity,maxGap=-Infinity;const cycle=c.cycleUnitsFor(skin.renderSet,19/skin.sourceStandingHeight,144);const pad=c.getFootPad(skin.renderSet);let oldMin=Infinity,oldMax=-Infinity;
  for(const [key,track] of Object.entries(frames).filter(([key])=>key.startsWith(skin.renderSet+'.walk.'))){const dir=key.slice(key.lastIndexOf('.')+1),b={id:'contact-audit',skin:skin.renderSet,px:51.1,py:80.13,dir,state:'walk',aph:0};
   for(let i=0;i<track.length;i++){b.odo=(i+.1)*cycle/track.length;let actualGap;const ctx={getTransform:()=>({a:4}),save(){},restore(){},drawImage(f,x,y,w,h){actualGap=b.py-y-(f.height-c.measureFootPad(f))*h/f.height;}};c.drawBody(ctx,b,1000,{});assert.equal(b._renderFrame,i);assert(Math.abs(actualGap-b._renderGroundGap)<1e-8,'telemetry differs from drawn foot');assert(Math.abs(actualGap-.25)<=.125001,skin.id+' walks off floor');assert.equal(b._renderStandingHeight,19);const oldGap=.25-(pad-c.measureFootPad(track[i]))*19/skin.sourceStandingHeight;oldMin=Math.min(oldMin,oldGap);oldMax=Math.max(oldMax,oldGap);minGap=Math.min(minGap,actualGap);maxGap=Math.max(maxGap,actualGap);count++;}
  }assert(cycle>=19*.56*.75&&cycle<=19);rows.push({id:skin.id,frames:count,cycleUnits:cycle,cyclesPerSecondAt28:28/cycle,minGap,maxGap,previousFootDrift:oldMax-oldMin});
 }
 const result={skins:rows.length,walkingFrames:rows.reduce((n,r)=>n+r.frames,0),height:19,rows};fs.writeFileSync(__dirname+'/contact-validation.json',JSON.stringify(result,null,2)+'\n');console.table(rows);console.log('Real-frame contact and stride: PASS');
})();
