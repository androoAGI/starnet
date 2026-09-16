// Import a completed skin snapshot without touching the authoring workspace.
const fs=require('fs'),path=require('path');
const source=process.argv[2];if(!source)throw Error('Pass the source worktree');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(source,p),'utf8');
const catalog=JSON.parse(read('frontend/agent-demo/catalog.json'));
const manifest=JSON.parse(read('frontend/agent-demo/manifest.json'));
const sets=new Set(catalog.skins.filter(s=>s.readyForStation).map(s=>s.renderSet));
const sprites=Object.fromEntries(Object.entries(manifest.sprites).filter(([k])=>sets.has(k.split('.')[0])));
let count=0;for(const p of new Set(Object.values(sprites).flat())){
 const rel=path.normalize(path.join('frontend/assets/sprites',p));
 if(!rel.startsWith('frontend'+path.sep+'assets'+path.sep))throw Error('Invalid asset '+p);
 const dest=path.join(root,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(source,rel),dest);count++;
}
const out=path.join(root,'frontend/assets/skin-study-0914/runtime-motion.json');
fs.writeFileSync(out,JSON.stringify({...catalog,sprites},null,2)+'\n');
// Keep the proven motion renderer; retain the opt-in preview and normal manifest entry point.
let renderer=read('frontend/agent-demo/sprites.js');
renderer=renderer.replace("return (b && b.id === 'ULTRON') ? 'approved_ultron'", "const study=typeof SkinStudy!=='undefined'&&SkinStudy.setFor(b);if(study)return study;\n    return (b && b.id === 'ULTRON') ? 'ultron'");
renderer=renderer.replace("fetch('agent-demo/manifest.json'", "fetch('assets/sprites/manifest.json'");
renderer=renderer.replace('tracksBySet = SpriteLoadPlan.groupTracks(man.sprites);',"if(typeof SkinStudy!=='undefined')await SkinStudy.install(man);\n      tracksBySet = SpriteLoadPlan.groupTracks(man.sprites);");
renderer=renderer.replace("&& b.state !== 'sleep' && b.state !== 'walk' && !b.working\n", "&& b.state !== 'sleep' && b.state !== 'walk' && !b.working && (!b.speaking || isReviewSet(set))\n");
renderer=renderer.replace('      ctx.save();\n      if(speech){const foot=', '      if(speech){ctx.save();const foot=');
renderer=renderer.replace('      ctx.restore();\n    }\n    finally {\n      ctx.imageSmoothingEnabled', '      if(speech)ctx.restore();\n    }\n    finally {\n      ctx.imageSmoothingEnabled');
fs.writeFileSync(path.join(root,'frontend/js/assets.js'),renderer);
console.log(JSON.stringify({skins:sets.size,frames:count,tracks:Object.keys(sprites).length}));
