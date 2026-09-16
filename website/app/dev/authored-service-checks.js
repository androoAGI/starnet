/* Explicit fixture QA only. No readback runs in the product frame loop. */
'use strict';
function runAuthoredServicePixelChecks(bodies){
  const results=[],check=(name,pass,detail)=>results.push({name,pass,detail});
  const hash=b=>{let h=2166136261;for(const n of b)h=Math.imul(h^n,16777619);return h>>>0;};
  function render(id,state,body=false){
    const r=AuthoredServiceContent.regions[id],cv=document.createElement('canvas');cv.width=Math.ceil(r.sourceWidth/3);cv.height=Math.ceil(r.sourceHeight/3);
    const g=cv.getContext('2d',{willReadFrequently:true}),box={x:0,y:0,width:cv.width,height:cv.height};
    if(body)g.drawImage(bodies[id],0,0,cv.width,cv.height);
    AuthoredServiceContent.draw(g,id,box,state);const data=g.getImageData(0,0,cv.width,cv.height).data;
    return{cv,data,hash:hash(data)};
  }
  const live={crates:19,bound:true,state:'online',fired:.7,live:true,door:'jammed',agentId:'fixture-agent',dockName:'Fixture agent',work:true,scanning:true};
  for(const id of Object.keys(AuthoredServiceContent.regions)){
    const a=render(id,{...live,still:true,now:0}),b=render(id,{...live,still:true,now:12345});
    check('reduced motion: '+id,a.hash===b.hash,{first:a.hash,later:b.hash});
  }
  for(const id of ['outbox','airlock','pub_publishpress','pub_outboundchute','pub_mailpod','intake','bay','merger','splitter','joiner','loop']){
    const a=render(id,{...live,now:0}),b=render(id,{...live,now:980});
    check('actual activity / jam highlight changes pixels: '+id,a.hash!==b.hash,{first:a.hash,later:b.hash});
  }
  check('connection alone never implies jukebox playback',render('jukebox',{live:true,now:0}).hash===render('jukebox',{live:true,now:9120}).hash);
  check('unbound connector cannot assert online or a call',render('connector_portal',{bound:false,state:'online',fired:1}).hash===render('connector_portal',{}).hash);
  check('real connector call changes powered sockets',render('connector_portal',{bound:true,state:'online',fired:1}).hash!==render('connector_portal',{bound:true,state:'online',fired:0}).hash);
  const alphaAt=(r,x,y)=>r.data[(Math.floor(y*r.cv.height)*r.cv.width+Math.floor(x*r.cv.width))*4+3];
  const open=render('airlock',{door:'open'},true),closed=render('airlock',{door:'closed'},true),jammed=render('airlock',{door:'jammed',still:true},true);
  check('open iris leaves center clear; closed seals it',alphaAt(open,.5,.5)===0&&alphaAt(closed,.5,.5)===255,{open:alphaAt(open,.5,.5),closed:alphaAt(closed,.5,.5)});
  check('jammed iris is visibly distinct',jammed.hash!==closed.hash&&jammed.hash!==open.hash);
  let unchanged=0,compared=0;
  for(let y=0;y<closed.cv.height;y++)for(let x=0;x<closed.cv.width;x++){
    const dx=x/closed.cv.width-.5,dy=y/closed.cv.height-.5;
    if(Math.hypot(dx,dy)<.35)continue;compared++;const i=(y*closed.cv.width+x)*4;
    if(open.data.slice(i,i+4).every((v,k)=>v===closed.data[i+k]))unchanged++;
  }
  check('authored airlock outer frame remains pixel-identical',unchanged===compared,{compared,unchanged});
  const absent=render('outbox',{crates:0}),occupied=render('outbox',{crates:1});
  check('zero crates leaves receiving mouth empty; one crate fills it',alphaAt(absent,.39,.24)===0&&alphaAt(occupied,.39,.24)>0);
  for(const id of ['pub_publishpress','pub_outboundchute','pub_mailpod','intake','merger','splitter','joiner','loop'])check('idle machinery adds no fictional contents: '+id,!render(id,{now:9999}).data.some(Boolean));
  const mail=render('pub_mailpod',live),press=render('pub_publishpress',live),loop=render('loop',live),join=render('joiner',live);
  check('working publication bays and output tray stay empty',alphaAt(mail,.3,.55)===0&&alphaAt(mail,.7,.55)===0&&alphaAt(press,.5,.78)===0);
  check('work never fabricates loop tally or join latch',alphaAt(loop,.5,.12)===0&&alphaAt(loop,.472,.19)===0&&alphaAt(join,.566,.38)===0);
  const fade=document.createElement('canvas');fade.width=closed.cv.width;fade.height=closed.cv.height;
  const g=fade.getContext('2d');g.globalAlpha=.35;g.drawImage(closed.cv,0,0);const faded=g.getImageData(0,0,fade.width,fade.height).data;
  let maxAlpha=0;for(let i=3;i<faded.length;i+=4)maxAlpha=Math.max(maxAlpha,faded[i]);
  check('grouped body and iris respect 35% occlusion',maxAlpha>80&&maxAlpha<=90,{maxAlpha});
  return{fixture:true,checks:results.length,passed:results.filter(r=>r.pass).length,results};
}
