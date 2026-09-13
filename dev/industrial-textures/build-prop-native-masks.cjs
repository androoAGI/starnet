'use strict';
// Offline only. Native render differences become alpha replacement layers; the
// running app reads no pixels per frame. This does NOT generate/repaint prop art.
// Usage: NODE_PATH=<bundled runtime node_modules> node dev/industrial-textures/build-prop-native-masks.cjs
//   --out <directory> [--id <catalog-id>] [--structures <structure-manifest.json>]
// Output: *-native.png + native-layer-manifest.json, merged by the art owner into
// props-v2/manifest.json. Original geometry is never resized to suit generated art.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createCanvas,Image}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..');
const opt=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];};
const out=path.resolve(opt('out')||path.join(root,'dev/.scratch-workspace/prop-native-masks'));
const only=opt('id'),structuresFile=opt('structures');
const structures=structuresFile?JSON.parse(fs.readFileSync(structuresFile,'utf8')):null;
const APPROVED=new Set(['crate','desk','desk2','chair','bridge_consolebank','bridge_tacticaltable','bridge_equipmentbay','bridge_deckperimeter']);
const document={createElement:()=>createCanvas(1,1),addEventListener(){},documentElement:{dataset:{},style:{setProperty(){}}}};
const window={addEventListener(){},matchMedia:()=>({matches:false})};
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const U=new Function('window','document',read('frontend/js/util.js')+';return U;')(window,document);
class Asset extends Image {set src(url){super.src=fs.readFileSync(path.join(root,'frontend',url));}}
const times=[0,73,137,251,419,683,997,1277,1699,2129,2777,3331,4111,5003,6101,7507,9011,11003,14009,19001,27011,41011];
function states(id){
 const result=[{}];
 if(id==='airlock')result.push({door:'open'},{door:'closed'},{door:'jammed'});
 if(id==='connector_portal')for(const state of ['unbound','offline','connecting','online','error'])
   for(const fired of [false,true])result.push({connection:state,fired});
 if(id==='workbench')result.push({bench:true},{bench:false});
 if(id==='jukebox')result.push({music:true});
 if(id==='bunk')result.push({sleeper:true});
 if(id==='outbox')for(const crates of [1,2,3,4,5,6,12,99])result.push({crates});
 if(id==='missionboard')for(const pins of [0,1,3,5,9,20])for(const hot of [false,true])
   result.push({pins,hot,jam:true,proposals:pins});
 if(id==='trophycase')for(const trophies of [1,2,3,4,5,9,20])result.push({trophies,journeyStage:trophies});
 return result;
}
// Complete native canvases, not only the few changed phosphor pixels: a screen's
// empty glass and the space a moving part vacates must also replace the static art.
// Polygons use the exact native geometry; these small explicit regions supplement
// temporal/state unions where unchanged backdrop pixels would otherwise be missed.
function manual(id,w,h){
 if(id==='bunk')return [[[3,7],[w-3,7],[w-3,h-8],[3,h-8]]];
 if(id==='airlock')return [[[1,1],[w-1,1],[w-1,h-1],[1,h-1]]];
 return [];
}
function apply(ps,p,s,at){
 ps.setNow(at);
 ps.reconcileConnectors([]);
 ps.setConnectorState('mask-connector',s.connection||'offline',0);
 if(s.fired)ps.pulseConnector('mask-connector');
 // Real APIs feed the exact o object passed by draw(); no synthetic runtime store.
 ps.pulseWorkbench(s.bench!==false,'mask-bench'); // reset then expire unless this scenario fires
 if(s.bench==null){ps.setNow(at-2000);ps.pulseWorkbench(true,'mask-bench');ps.setNow(at);}
 ps.setSpotifyConnected(!!s.music);ps.setOutboxCrates(s.crates||0);
 ps.setMissionPins(s.pins||0,!!s.hot,!!s.jam,s.proposals||0);
 ps.setTrophyCount(s.trophies||0);ps.setJourneyStage(s.journeyStage||0);
 p.connectorId=s.connection&&s.connection!=='unbound'?'mask-connector':null;
 p.id='mask-bench';p.door=s.door||null;p.sleeper=!!s.sleeper;
}
(async()=>{
 const te={document,window,Image:Asset,URLSearchParams,location:{search:''},module:{exports:{}}};
 vm.runInNewContext(read('frontend/app/industrialtextures.js'),te);const textures=te.module.exports;await textures.ready;
 let captured=null;
 const intercept={ready:Promise.resolve(),revision:()=>0,
   draw(ctx,id,view,x,y,w,h,state,native){captured={native,state,view};return true;}};
 const pe={document,window,U,IndustrialTextures:textures,PropRemaster:intercept,module:{exports:{}}};
 vm.runInNewContext(read('frontend/app/propsprites.js'),pe);const ps=pe.module.exports;
 fs.mkdirSync(out,{recursive:true});
 const result={version:1,density:1,dilation:1,timeSamples:times,stateSource:'PropSprites public state setters and draw()',props:{}};
 for(const c of ps.CATALOG){
  if(APPROVED.has(c.id)||(only&&c.id!==only))continue;
  const views={};
  for(const rotation of ps.facings(c.id)){
   const view=ps.viewAt(c.id,rotation);if(view.mirror||view.turned)continue;
   const facing=rotation===0?'s':rotation===2?'n':rotation===3?'e':'w';
   const fp=ps.footprintAt(c.id,rotation),W=fp.w*12,H=fp.h*12;
   const pad=64,CW=W+pad*2,CH=H+pad*2,cv=createCanvas(CW,CH),g=cv.getContext('2d');
   const p={t:c.id,x:pad/12,y:pad/12,w:fp.w,h:fp.h,r:rotation,m:0};
   const union=new Uint8Array(CW*CH),coverage=new Uint8Array(CW*CH);let baseline=null,samples=0;
   function render(s,work,at){
    apply(ps,p,s,at);g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,CW,CH);ps.setCtx(g);captured=null;
    ps.draw(p,work,{still:false,occupied:work,heat:0,prog:null});
    if(!captured)throw Error('missing native view '+c.id+':'+facing);
    g.clearRect(0,0,CW,CH);captured.native(g);
    const bytes=g.getImageData(0,0,CW,CH).data;
    if(!baseline)baseline=Uint8ClampedArray.from(bytes);
    for(let i=0;i<union.length;i++){
     const j=i*4;if(bytes[j+3])coverage[i]=1;
     if(bytes[j]!==baseline[j]||bytes[j+1]!==baseline[j+1]||bytes[j+2]!==baseline[j+2]||bytes[j+3]!==baseline[j+3])union[i]=1;
    }
    samples++;
   }
   for(const work of [false,true])for(const at of times)render({},work,at);
   for(const state of states(c.id).slice(1))for(const work of [false,true])
    for(const at of [137,683,2129,5003,9011])render(state,work,at);
   // One-world-pixel expansion seals the glass background around moving pixels.
   const expanded=new Uint8Array(union.length);
   for(let y=0;y<CH;y++)for(let x=0;x<CW;x++)if(union[y*CW+x])
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
     if(x+dx>=0&&x+dx<CW&&y+dy>=0&&y+dy<CH)expanded[(y+dy)*CW+x+dx]=1;
    }
   const mg=createCanvas(CW,CH).getContext('2d'),mi=mg.createImageData(CW,CH);
   for(let i=0;i<expanded.length;i++)if(expanded[i])mi.data.set([255,255,255,255],i*4);
   mg.putImageData(mi,0,0);mg.fillStyle='#fff';
   for(const polygon of manual(c.id,W,H)){mg.beginPath();polygon.forEach((p,i)=>i?mg.lineTo(p[0]+pad,p[1]+pad):mg.moveTo(p[0]+pad,p[1]+pad));mg.closePath();mg.fill();}
   const data=mg.getImageData(0,0,CW,CH).data;
   let left=CW,top=CH,right=-1,bottom=-1,changed=0;
   for(let i=0;i<expanded.length;i++)if(data[i*4+3]||coverage[i]){
    const x=i%CW,y=Math.floor(i/CW);left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
    if(data[i*4+3])changed++;
   }
   if(left===0||top===0||right===CW-1||bottom===CH-1)throw Error('native layer exceeded capture: '+c.id);
   if(right<left)throw Error('empty native render '+c.id);
   const nativeBounds={x:left-pad,y:top-pad,width:right-left+1,height:bottom-top+1};
   const file=c.id+(facing==='s'?'':'-'+facing)+'-native.png';
   const entry={footprint:fp,mode:changed?'native':'static',nativeBounds,samples,changedPixels:changed};
   if(changed){
    const cut=createCanvas(nativeBounds.width,nativeBounds.height);
    cut.getContext('2d').drawImage(mg.canvas,left,top,nativeBounds.width,nativeBounds.height,0,0,nativeBounds.width,nativeBounds.height);
    fs.writeFileSync(path.join(out,file),cut.toBuffer('image/png'));entry.nativeMask=file;
   }
   // A guide manifest may supply the authoritative body bbox; never substitute
   // animation spill/halos for its physical casing proportions.
   const supplied=structures&&structures.props&&structures.props[c.id]&&structures.props[c.id].views&&structures.props[c.id].views[facing];
   if(supplied&&(supplied.bounds||supplied.bbox))entry.bounds=supplied.bounds||supplied.bbox;
   views[facing]=entry;
  }
  result.props[c.id]={views};
  process.stdout.write(c.id+': '+Object.keys(views).length+' native view(s)\n');
 }
 fs.writeFileSync(path.join(out,'native-layer-manifest.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({out,props:Object.keys(result.props).length,views:Object.values(result.props).reduce((n,p)=>n+Object.keys(p.views).length,0)}));
})().catch(e=>{console.error(e);process.exitCode=1;});

