/* Explicit, on-demand browser fixture checks. Readback belongs to QA, never the
   product painter or its frame loop. Open authored-content-fixture.html. */
'use strict';
function runAuthoredContentPixelChecks() {
  const results=[];
  const check=(name,pass,detail)=>results.push({name,pass,detail});
  const hash=bytes=>{let h=2166136261;for(const b of bytes)h=Math.imul(h^b,16777619);return h>>>0;};
  function render(id,state) {
    const spec=AuthoredPropContent.regions[id],cv=document.createElement('canvas');
    cv.width=Math.ceil(spec.sourceWidth/3);cv.height=Math.ceil(spec.sourceHeight/3);
    const g=cv.getContext('2d',{willReadFrequently:true});
    AuthoredPropContent.draw(g,id,{x:0,y:0,width:cv.width,height:cv.height},state);
    const data=g.getImageData(0,0,cv.width,cv.height).data;
    return {cv,data,hash:hash(data)};
  }
  const active={pins:28,proposals:7,trophies:33,journeyStage:9,hot:true,jam:true};
  for(const id of Object.keys(AuthoredPropContent.regions)) {
    const first=render(id,{...active,still:true,now:0}),later=render(id,{...active,still:true,now:19000});
    check('reduced motion remains pixel-identical: '+id,first.hash===later.hash,{first:first.hash,later:later.hash});
  }
  for(const id of ['missionboard','calwall','arc_microfiche']) {
    const first=render(id,{...active,now:0}),later=render(id,{...active,now:7400});
    check('authored ambience changes pixels: '+id,first.hash!==later.hash,{first:first.hash,later:later.hash});
  }
  for(const id of ['missionboard','trophycase']) {
    const empty=render(id,{still:true}),populated=render(id,{...active,still:true});
    check('actual counts change painted content: '+id,empty.hash!==populated.hash,{empty:empty.hash,populated:populated.hash});
  }
  const inbox=render('comms_inbox',{work:true,unread:80,now:9000});
  check('no invented mail from activity or time',!inbox.data.some(Boolean),{hash:inbox.hash});
  const mail=render('comms_inbox',{inboxItems:[{id:'fixture-message'}]}),duplicate=render('comms_inbox',{inboxItems:[{id:'fixture-message'},{id:'fixture-message'}]});
  check('identified message paints; duplicate IDs stay one item',mail.data.some(Boolean)&&mail.hash===duplicate.hash,{one:mail.hash,duplicate:duplicate.hash});
  const emptyTrophy=render('trophycase',{}),shelves=AuthoredPropContent.regions.trophycase.shelves;
  let clear=true;
  for(const r of shelves)for(let y=Math.ceil(r.y*emptyTrophy.cv.height);y<Math.floor((r.y+r.height)*emptyTrophy.cv.height);y++)for(let x=Math.ceil(r.x*emptyTrophy.cv.width);x<Math.floor((r.x+r.width)*emptyTrophy.cv.width);x++)if(emptyTrophy.data[(y*emptyTrophy.cv.width+x)*4+3])clear=false;
  check('zero earned trophies leave all shelf apertures clear',clear);
  const cv=document.createElement('canvas');cv.width=400;cv.height=300;const g=cv.getContext('2d');
  g.globalAlpha=.35;g.globalCompositeOperation='multiply';g.translate(31,17);
  const before=g.getTransform();AuthoredPropContent.draw(g,'missionboard',{x:0,y:0,width:300,height:180},{...active,still:true});const after=g.getTransform();
  check('caller alpha, composite and transform survive',g.globalAlpha===.35&&g.globalCompositeOperation==='multiply'&&before.a===after.a&&before.d===after.d&&before.e===after.e&&before.f===after.f,{alpha:g.globalAlpha,composite:g.globalCompositeOperation});
  const scene=render('trophycase',active),fade=document.createElement('canvas');fade.width=scene.cv.width;fade.height=scene.cv.height;
  const fg=fade.getContext('2d');fg.globalAlpha=.35;fg.drawImage(scene.cv,0,0);const faded=fg.getImageData(0,0,fade.width,fade.height).data;
  let maxAlpha=0;for(let p=3;p<faded.length;p+=4)maxAlpha=Math.max(maxAlpha,faded[p]);
  check('composed content respects whole-prop 35% fade',maxAlpha>80&&maxAlpha<=90,{maxAlpha});
  return {fixture:true,checks:results.length,passed:results.filter(r=>r.pass).length,results};
}
