/* Original eight-facing crew sprites. Animation is presentation; only the bridge supplies work state. */
'use strict';
const NextCharacters = (() => {
  const names=['nova','ember','fern'];
  const base='assets/characters/';
  async function create(){
    const cast=await Promise.all(names.map(async name=>{
      const root=base+name+'/',response=await fetch(root+'metadata.json');
      if(!response.ok)throw Error('Crew metadata could not load: '+name);
      const metadata=await response.json(),state=metadata.states[0],images=new Map();
      const paths=Object.values(state.frames.rotations).concat(Object.values(state.frames.animations).flatMap(animation=>Object.values(animation).flat()));
      await Promise.all([...new Set(paths)].map(path=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{images.set(path,img);resolve();};img.onerror=()=>reject(Error('Crew sprite could not load: '+name+'/'+path));img.src=root+path;})));
      return{root,state,images};
    }));
    const member=i=>cast[((Number(i)||0)%cast.length+cast.length)%cast.length];
    function draw(ctx,actor,now){
      if(actor.unplaced)return;
      const c=member(actor.appearance),rot=c.state.frames.rotations,animations=c.state.frames.animations;
      const walking=Object.values(animations)[0]||{},direction=actor.dir||'south',frames=walking[direction];
      const path=actor.moving&&frames?.length?frames[Math.floor(now/95+(actor.phase||0))%frames.length]:rot[direction]||rot.south;
      const img=c.images.get(path);if(!img)return;
      const x=Math.round(actor.x*32),y=Math.round(actor.y*32);
      ctx.save();ctx.imageSmoothingEnabled=false;ctx.drawImage(img,x-32,y-61,64,64);
      if(actor.working){ctx.fillStyle='#d5cb97';ctx.fillRect(x+19,y-47,3,3);ctx.fillStyle='#b8dcbd';ctx.fillRect(x+23,y-50,2,6);}
      ctx.restore();
    }
    return{draw,portrait:i=>{const c=member(i);return c.root+c.state.frames.rotations.south;},stats:()=>({ready:true,characters:cast.length,images:cast.reduce((n,c)=>n+c.images.size,0),directions:8,walkDirections:4,walkFrames:8})};
  }
  return{create};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=NextCharacters;
