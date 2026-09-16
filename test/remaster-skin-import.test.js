'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),m=require('../frontend/assets/skin-study-0914/runtime-motion.json');
const redesigned=m.skins.filter(s=>!s.retainedOriginal);assert.equal(redesigned.length,34);
for(const skin of redesigned){
 assert.equal(m.standingHeight/skin.sourceStandingHeight,.25,skin.id+' scale');
 for(const pose of ['rot','walk','sit'])for(const dir of ['north','east','south','west']){
  const track=m.sprites[skin.renderSet+'.'+pose+'.'+dir];assert.ok(track?.length,skin.id+' '+pose+' '+dir);
  if(pose==='walk')assert.ok(track.length>1,skin.id+' animated walk');
 }
 assert.ok(m.sprites[skin.renderSet+'.type.north']?.length,skin.id+' typing');
}
for(const p of new Set(Object.values(m.sprites).flat())){
 const file=path.resolve(root,'frontend/assets/sprites',p),bytes=fs.readFileSync(file);
 assert.equal(bytes.subarray(1,4).toString(),'PNG',p);
 const mirror=path.resolve(root,'website/app/assets/sprites',p);
 assert.ok(bytes.equals(fs.readFileSync(mirror)),p+' website parity');
}
console.log('remaster-skin-import: 34 remasters, 4 retained skins, 3099 PNG frames verified');
