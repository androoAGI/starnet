'use strict';
const fs=require('node:fs'),path=require('node:path'),A=require('./_assert');
const content=require('../frontend/app/authored-service-content');
const box={x:7,y:-12,width:39,height:44};
function recorder(){
  const calls=[],stack=[],values={globalAlpha:.37,globalCompositeOperation:'multiply',shadowBlur:8};
  return new Proxy({calls,save(){stack.push({...values});calls.push(['save']);},restore(){Object.assign(values,stack.pop());calls.push(['restore']);}},
    {get(o,k){if(k in o)return o[k];if(k in values)return values[k];return(...a)=>calls.push([k,...a,values.fillStyle,values.globalAlpha]);},set(o,k,v){values[k]=v;calls.push(['set',k,v]);return true;}});
}
function trace(id,state){const g=recorder();content.draw(g,id,box,state);return g.calls;}
const paints=c=>c.filter(x=>['fill','fillRect','fillText','stroke'].includes(x[0]));
const texts=c=>c.filter(x=>x[0]==='fillText').map(x=>x[1]);
const live={work:true,scanning:true,bound:true,state:'online',fired:.7,live:true,door:'jammed',agentId:'fixture-agent',dockName:'Fixture agent',crates:12};
const catalog=require('../frontend/assets/industrial/batch03/catalog.json');
for(const id of Object.keys(content.regions)){
  const g=recorder();A.eq(content.draw(g,id,box,live),true,'supported '+id);
  A.eq(g.globalAlpha,.37,'opacity restored '+id);A.eq(g.globalCompositeOperation,'multiply','composition restored '+id);A.eq(g.shadowBlur,8,'shadow restored '+id);
  A.ok(!g.calls.some(c=>c[0]==='set'&&c[1]==='globalAlpha'),'all marks inherit caller opacity '+id);
  A.eq(g.calls.filter(c=>c[0]==='save').length,g.calls.filter(c=>c[0]==='restore').length,'balanced clips '+id);
  A.eq(trace(id,{...live,still:true,now:0}),trace(id,{...live,still:true,now:9120}),'reduced motion deterministic '+id);
  const r=content.regions[id],item=catalog.items.find(item=>item.id===id);
  A.eq([r.sourceWidth,r.sourceHeight],[item.width,item.height],'source receipt dimensions '+id);
  for(const [key,p]of Object.entries(r))if(Array.isArray(p)){
    const points=Array.isArray(p[0][0])?p.flat():p;
    A.ok(points.every(([x,y])=>x>=0&&y>=0&&x<=1&&y<=1),'normalized geometry '+id+':'+key);
  }
}
for(const bad of [undefined,null,-1,NaN,Infinity,'9'])A.eq(trace('outbox',{crates:bad}),trace('outbox',{crates:0}),'invalid crate values never mint objects');
A.eq(texts(trace('outbox',{crates:19})),['5 +14'],'five visible crates retain exact excess');
A.eq(texts(trace('outbox',{crates:2.9})),['2'],'count is an integer');
A.eq(paints(trace('outbox',{crates:900})).length,paints(trace('outbox',{crates:9})).length,'bounded crate work at arbitrary totals');
A.eq(trace('connector_portal',{bound:false,state:'online',fired:1}),trace('connector_portal',{}),'unbound portal cannot claim online or fired');
A.eq(texts(trace('connector_portal',{bound:true})),['OFFLINE'],'missing status does not claim online');
A.eq(texts(trace('connector_portal',{bound:true,state:'error'})),['ERROR'],'actual failure gets error display');
A.eq(trace('connector_portal',{bound:true,state:'offline',fired:1}),trace('connector_portal',{bound:true,state:'offline',fired:0}),'offline pulse does not claim tool call');
A.ok(JSON.stringify(trace('connector_portal',{bound:true,state:'online',fired:1}))!==JSON.stringify(trace('connector_portal',{bound:true,state:'online',fired:0})),'actual online pulse changes signal');
A.eq(trace('connector_portal',{bound:true,state:'online',toolCount:999}),trace('connector_portal',{bound:true,state:'online'}),'no inferred tool count');
A.eq(paints(trace('jukebox',{})),[],'disconnected jukebox adds no powered marks');
A.eq(trace('jukebox',{live:true,now:0}),trace('jukebox',{live:true,now:9000,work:true,scanning:true}),'connection does not animate playback');
A.eq(texts(trace('jukebox',{live:true})),['LINK'],'jukebox only labels connection');
for(const id of ['pub_publishpress','pub_outboundchute','pub_mailpod','intake','bay','merger','splitter','joiner','loop']){
  A.eq(paints(trace(id,{now:123456})),[],'idle machinery has no fabricated motion/content '+id);
  A.eq(trace(id,{...live,still:true,prog:1,crates:500,pass:9,iteration:9,held:true,route:'done'}),trace(id,{...live,still:true}),'unprovided native cargo/route/progress fields remain unused '+id);
  A.ok(paints(trace(id,live)).length>0,'real activity drives machinery '+id);
}
A.eq(texts(trace('bay',{dockName:'Unbound fixture'})),[],'name alone cannot assert binding');
A.eq(texts(trace('bay',{agentId:'fixture',dockName:'Fixture\nagent'})),['Fixture agent'],'bound live name sanitized');
A.eq(texts(trace('bay',{agentId:'fixture'})),[],'missing name remains unlabeled');
A.eq(trace('airlock',{door:'unknown',still:true}),trace('airlock',{door:'open',still:true}),'saved absent/invalid door has native open default');
A.ok(JSON.stringify(trace('airlock',{door:'closed'}))!==JSON.stringify(trace('airlock',{door:'jammed'})),'jammed iris geometry distinct from closed');
A.ok(trace('airlock',{}).some(c=>c[0]==='set'&&c[1]==='globalCompositeOperation'&&c[2]==='destination-over'),'iris sits behind authored frame');
const mapped=recorder();content.draw(mapped,'bay',{...box,crop:{x:3,y:27,width:1226,height:1200}},{agentId:'fixture'});
A.ok(mapped.calls.some(c=>c[0]==='translate'&&c[1]===-3&&c[2]===-27),'runtime alpha crop is subtracted once');
for(const candidate of [{...box,width:0},{...box,x:NaN},{...box,crop:{x:9999,y:0,width:1,height:1}}])A.eq(content.draw(recorder(),'bay',candidate),false,'invalid fit rejected');
A.eq(content.draw(recorder(),'constructor',box),false,'prototype names not IDs');
const broken=recorder();broken.fillRect=()=>{throw Error('context lost');};A.throws(()=>content.draw(broken,'intake',box,live),'paint errors reach caller fallback');A.eq(broken.globalCompositeOperation,'multiply','context restored on error');
const source=fs.readFileSync(path.join(__dirname,'../frontend/app/authored-service-content.js'),'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'');
A.ok(!/getImageData|putImageData|drawImage|Math\.random|Date\.now|PropSprites|drawNative|setTimeout/.test(source),'no raster reads, bitmap copying, old painter or own clock');
A.report('authored service content');
