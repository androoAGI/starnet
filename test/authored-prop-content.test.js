'use strict';
const fs=require('node:fs'),path=require('node:path'),A=require('./_assert');
const content=require('../frontend/app/authored-prop-content');
const box={x:7,y:-12,width:39,height:24};
function recorder(alpha=.37) {
  const calls=[],stack=[],values={globalAlpha:alpha,globalCompositeOperation:'multiply',shadowBlur:8};
  const g=new Proxy({calls,save(){stack.push({...values});calls.push(['save']);},restore(){Object.assign(values,stack.pop());calls.push(['restore']);},
    createLinearGradient(...a){const stops=[];calls.push(['linear',...a,stops]);return{addColorStop(...s){stops.push(s);}};},
    createRadialGradient(...a){const stops=[];calls.push(['radial',...a,stops]);return{addColorStop(...s){stops.push(s);}};}},
    {get(o,k){if(k in o)return o[k];if(k in values)return values[k];return(...a)=>calls.push([k,...a,values.fillStyle,values.globalAlpha]);},
     set(o,k,v){values[k]=v;calls.push(['set',k,v]);return true;}});
  return g;
}
const trace=(id,state)=>{const g=recorder();A.ok(content.draw(g,id,box,state),'supported id draws '+id);return g.calls;};
const texts=calls=>calls.filter(c=>c[0]==='fillText').map(c=>c[1]);
for(const id of Object.keys(content.regions)) {
  const g=recorder();content.draw(g,id,box,{pins:8,proposals:5,trophies:12,journeyStage:9,hot:true,jam:true});
  A.eq(g.globalAlpha,.37,'caller opacity restored '+id);A.eq(g.globalCompositeOperation,'multiply','composite restored '+id);A.eq(g.shadowBlur,8,'shadow restored '+id);
  A.ok(!g.calls.some(c=>c[0]==='set'&&c[1]==='globalAlpha'),'every mark inherits opacity '+id);
  A.eq(g.calls.filter(c=>c[0]==='save').length,g.calls.filter(c=>c[0]==='restore').length,'balanced clips '+id);
  const r=content.regions[id];
  for(const [k,v]of Object.entries(r))if(typeof v==='object')for(const q of Array.isArray(v)?v:[v])
    A.ok(q.x>=0&&q.y>=0&&q.width>0&&q.height>0&&q.x+q.width<=1&&q.y+q.height<=1,'regions remain in exported image '+id+':'+k);
}
const empty=texts(trace('missionboard',{}));
A.eq(empty,['OPEN 0','QUESTS'],'missing facts keep board empty');
const mission=texts(trace('missionboard',{pins:8,proposals:5,hot:true,jam:true}));
A.ok(mission.includes('OPEN 8')&&mission.includes('+5'),'exact open total and overflow retained');
A.ok(mission.includes('PROPOSED 5')&&mission.includes('+2'),'proposals remain a separate exact count');
A.ok(mission.includes('JAM')&&!mission.includes('GAP'),'jam stub remains distinct while gap beacon coexists');
A.ok(texts(trace('missionboard',{pins:1,hot:true})).includes('GAP'),'real gap state retained');
A.eq(texts(trace('missionboard',{pins:Infinity,proposals:-3,hot:'yes',jam:1})),empty,'invalid facts do not mint cards or alerts');
A.ok(texts(trace('trophycase',{})).includes('EMPTY'),'no placeholder earned trophy');
A.ok(texts(trace('trophycase',{trophies:900,journeyStage:8})).includes('HONOURS 900'),'earned total survives six display slots');
A.ok(texts(trace('trophycase',{trophies:0,journeyStage:8})).includes('+4'),'goal evolution stays separate from earned count');
const inboxEmpty=trace('comms_inbox',{});
A.eq(trace('comms_inbox',{work:true,pins:20,unread:4,now:9999}),inboxEmpty,'work and elapsed time never manufacture mail');
A.eq(trace('comms_inbox',{inboxItems:[null,{},'fake']}),inboxEmpty,'unidentified values never become messages');
A.ok(trace('comms_inbox',{inboxItems:[{id:'real-a'}]}).length>inboxEmpty.length,'explicit identified message gets physical paper');
for(const id of ['missionboard','trophycase','calwall','arc_microfiche','comms_inbox']) {
  const base={still:true,pins:8,proposals:5,hot:true,jam:true,trophies:9,journeyStage:7};
  A.eq(trace(id,{...base,now:0}),trace(id,{...base,now:10000}),'reduced motion freezes all content '+id);
}
for(const id of ['calwall','arc_microfiche']) {
  A.eq(trace(id,{still:true}),trace(id,{still:true,work:true,prog:1,pins:400,trophies:400}),'decorative prop never asserts backend activity '+id);
}
const receipts=require('../frontend/assets/industrial/batch03/coordinator/export-checks.json');
for(const r of receipts.records.filter(r=>content.regions[r.id])) {
  const spec=content.regions[r.id];A.eq([spec.sourceWidth,spec.sourceHeight],[r.crop.width,r.crop.height],'export geometry receipt '+r.id);
}
const mapped=recorder();content.draw(mapped,'calwall',{...box,crop:{x:2,y:3,width:2100,height:600}},{});
A.ok(mapped.calls.some(c=>c[0]==='translate'&&c[1]===-3&&c[2]===-57),'both exporter crop and runtime alpha trim applied exactly once');
for(const candidate of [{...box,width:0},{...box,x:NaN},{...box,crop:{x:9999,y:0,width:1,height:1}}])A.eq(content.draw(recorder(),'missionboard',candidate),false,'invalid geometry fails closed');
A.eq(content.draw(recorder(),'constructor',box),false,'prototype names are not prop ids');
const errorCtx=recorder();errorCtx.fillText=()=>{throw Error('context lost');};
A.throws(()=>content.draw(errorCtx,'missionboard',box),'paint failure reaches caller fallback');
A.eq(errorCtx.globalAlpha,.37,'paint failure still restores opacity');
A.eq(errorCtx.globalCompositeOperation,'multiply','paint failure restores composite');
const source=fs.readFileSync(path.join(__dirname,'../frontend/app/authored-prop-content.js'),'utf8');
A.ok(!/getImageData|putImageData|drawImage|Math\.random|Date\.now|PropSprites|drawNative/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'')),'content never samples old pixels or unbounded time');
A.report('authored prop content');
