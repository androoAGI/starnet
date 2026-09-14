'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),dir=path.join(root,'frontend/assets/industrial/props-v2');
const structures=require('./prop-structure-manifest.json');
const masksDir=process.argv[2]||path.join(root,'dev/.scratch-workspace/prop-native-masks');
const masks=JSON.parse(fs.readFileSync(path.join(masksDir,'native-layer-manifest.json'),'utf8'));
const approved=new Set(['crate','desk','desk2','chair','bridge_consolebank','bridge_tacticaltable','bridge_equipmentbay','bridge_deckperimeter']);
(async()=>{
 const manifest={version:1,props:{}},ledger=[];
 for(const [id,p]of Object.entries(structures.props)){
  if(approved.has(id)){ledger.push({id,label:p.label,family:p.family,status:'approved-existing',views:Object.keys(p.views)});continue;}
  const views={},missing=[];
  for(const [f,v]of Object.entries(p.views)){
   // Native runtime resolves mirrored views to their authored source.
   const layer=masks.props[id]?.views[f];if(!layer)continue;
   const filename=v.key+'.png',file=path.join(dir,filename);
   if(!fs.existsSync(file)){missing.push(f);continue;}
   const info=await sharp(file).metadata();
   const ratioError=Math.abs(info.width/info.height/(v.bounds.width/v.bounds.height)-1);
   if(ratioError>.081){missing.push(f);continue;}
   if(layer.nativeMask)fs.copyFileSync(path.join(masksDir,layer.nativeMask),path.join(dir,layer.nativeMask));
   views[f]={image:filename,sourceWidth:info.width,sourceHeight:info.height,footprint:v.footprint,bounds:v.bounds,exposure:1.5,mode:layer.mode,
    ...(layer.nativeMask?{nativeMask:layer.nativeMask,nativeBounds:layer.nativeBounds}:{})};
  }
  if(Object.keys(views).length)manifest.props[id]={views};
  ledger.push({id,label:p.label,family:p.family,status:missing.length?'in-progress':'casing-draft',views:Object.keys(views),missing});
 }
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const report={status:'retired-casing-drafts',catalog:ledger.length,approvedExisting:approved.size,newIds:Object.keys(manifest.props).length,newViews:Object.values(manifest.props).reduce((n,p)=>n+Object.keys(p.views).length,0),completeIds:approved.size,note:'Historical casing drafts are not completed remasters. Full designs are tracked in props-v3/coverage.json.',props:ledger};
 fs.writeFileSync(path.join(root,'docs/station-remaster/props-v2/coverage.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({catalog:report.catalog,approvedExisting:report.approvedExisting,newIds:report.newIds,newViews:report.newViews,completeIds:report.completeIds}));
})().catch(e=>{console.error(e);process.exitCode=1;});
