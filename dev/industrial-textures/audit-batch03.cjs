'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..');process.chdir(root);
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p));
async function main(){
const old=read('frontend/assets/industrial/batch02/catalog.json').items,claims=read('docs/station-remaster/batch03/claims.json'),structure=read('dev/industrial-textures/prop-structure-manifest.json').props;
const candidates=[...old.map(a=>({...a,kind:'repaint'})),...claims.newSections.flatMap(g=>g.ids.map(id=>({id,lane:g.lane,section:g.section,kind:'new'})))],records=[],missing=[];
const hashCache=new Map(),getHash=p=>{if(!hashCache.has(p))hashCache.set(p,sha(p));return hashCache.get(p);};
for(const a of candidates){
const lanes=[a.lane,'coordinator','crew','storage','utility','habitat','control'],lane=lanes.find(l=>fs.existsSync('frontend/assets/industrial/batch03/'+l+'/'+a.id+'.png'));
if(!lane){missing.push(a.id);continue;}
for(const v of Object.values(structure[a.id].views)){
const output='frontend/assets/industrial/batch03/'+lane+'/'+v.image,key=path.basename(v.image,'.png'),doc='docs/station-remaster/batch03/'+lane+'/';
if(!fs.existsSync(output)){missing.push(key);continue;}
let receipt,receiptPath;
if(lane==='crew'||lane==='storage'){receiptPath=doc+key+'.export.json';receipt=read(receiptPath);}
else {receiptPath=(lane==='utility'?doc:'frontend/assets/industrial/batch03/'+lane+'/')+'export-checks.json';receipt=read(receiptPath).records.find(x=>x.id===a.id);}
if(!receipt)throw Error('No receipt '+output);
let source=receipt.source;
if(source&&!fs.existsSync(source))source=doc+source;
if(!source||!fs.existsSync(source)||getHash(source)!==receipt.sourceSha256){source=fs.readdirSync(doc).filter(f=>f.startsWith(key)&&f.endsWith('.png')).map(f=>doc+f).find(p=>getHash(p)===receipt.sourceSha256);}
if(!source)throw Error('Source hash not found '+key);
const outputHash=getHash(output);if(outputHash!==receipt.outputSha256)throw Error('Output hash mismatch '+key);
const sr=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true}),dst=await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject:true}),crop=receipt.crop||{left:0,top:0,width:sr.info.width,height:sr.info.height};let transparent=0,opaque=0,rgbChanges=0;
if(dst.info.width!==crop.width||dst.info.height!==crop.height)throw Error('Crop mismatch '+key);
for(let y=0;y<dst.info.height;y++)for(let x=0;x<dst.info.width;x++){const d=(y*dst.info.width+x)*4,alpha=dst.data[d+3];if(!alpha){transparent++;continue;}if(alpha===255)opaque++;const p=((y+crop.top)*sr.info.width+x+crop.left)*4;for(let c=0;c<3;c++)if(dst.data[d+c]!==sr.data[p+c])rgbChanges++;}
if(!transparent||!opaque||rgbChanges)throw Error('Alpha/RGB failed '+key);
records.push({id:a.id,kind:a.kind,view:v.r,output,source,sourceSha256:getHash(source),outputSha256:outputHash,receipt:receiptPath,width:dst.info.width,height:dst.info.height,transparentPixels:transparent,opaquePixels:opaque,retainedRgbChanges:rgbChanges});
}}
const report={plannedUnique:candidates.length,exportedUnique:new Set(records.map(r=>r.id)).size,repaintedUnique:new Set(records.filter(r=>r.kind==='repaint').map(r=>r.id)).size,newUnique:new Set(records.filter(r=>r.kind==='new').map(r=>r.id)).size,authoredPngs:records.length,missing,allPresent:missing.length===0,allVerified:true,scope:'Source export validation only. No runtime, animation or user acceptance claim.',records};
fs.writeFileSync('docs/station-remaster/batch03/source-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,records:undefined}));}
main().catch(e=>{console.error(e);process.exitCode=1;});
