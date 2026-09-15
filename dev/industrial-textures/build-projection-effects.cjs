'use strict';
// Regenerate bindings/coverage only after reviewing changed source art. This
// never updates the runtime manifest or alters a PNG.
const fs=require('node:fs'),crypto=require('node:crypto');
const file='frontend/app/projection-prop-effects.js',dir='docs/station-remaster/projection-effects';
const root='frontend/assets/industrial/projection-correction',m=JSON.parse(fs.readFileSync(root+'/manifest.json'));
const quiet={};
function group(ids,reason){for(const id of ids.split(' ')){if(quiet[id])throw Error('Duplicate quiet '+id);quiet[id]=reason;}}
group('desk desk2','Accepted workstation screen/occupancy renderer remains authoritative, including compact native fallback and separately authored facings. No added effects.');
group('industrial_locker industrial_drawerbank industrial_supplycart industrial_toolcaddy industrial_wallpanel safe vault shelf quarters_lockerbank arc_indexwall','Storage or passive hardware; no evidenced moving mechanism or live display region on this source.');
group('industrial_partition industrial_bench industrial_roundtable industrial_floorvent industrial_cabletray bridge_deckperimeter cablerun hazardpad rug rug_small rug_large arc_ladder','Passive structural, floor or support object. Painted surface remains still; no fabricated process.');
group('industrial_planter plant tallplant terrarium monstera','Quiet painted foliage/colony. Old ambient sway or spores were decorative, not a live process; omitted intentionally.');
group('whiteboard calwall easel research_papers crate boxes goldcrate gigs_partsbin guitar mug bookstack toolbox figurine modelship bookshelf','Static authored contents or materials. No inferred activity, inventory, light or material animation.');
group('bar','Serving counter has no per-instance dispensing/order state in renderer input; no invented pour or service cycle.');
group('couch bunk stool chair sidetable lowtable glasstable dinertable booth dinerchair podchair loungetable longtable beanbag recliner recliner_r','Seating/table body remains untouched; occupancy, sleep and mounting stay with existing body/foreground/surface owners.');
group('quarters_pooltable pokertable pinball_unused','No per-instance game/ball state is available. Static approved playfield avoids invented shots, cards or wins.');
delete quiet.pinball_unused;
group('gachapon','No purchase/turn/dispense state is provided. Painted capsules remain static; no invented vend.');
group('telescope telescope_r weaponrack weaponrack_r punchbag punchbag_r benchpress benchpress_r','Passive instrument/equipment pose. No backend aim, firing, strike or repetition state is available.');
const bindings=Object.fromEntries(Object.entries(m.props).map(([id,p])=>[id,Object.fromEntries(Object.entries(p.views).map(([view,s])=>[view,{image:s.image,width:s.sourceWidth,height:s.sourceHeight}]))]));
let source=fs.readFileSync(file,'utf8');
source=source.replace(/const BINDINGS = \/\* projection-bindings \*\/ [\s\S]*?;\n/,`const BINDINGS = /* projection-bindings */ ${JSON.stringify(bindings)};\n`);
source=source.replace(/const QUIET = \/\* projection-quiet \*\/ [\s\S]*?;\n/,`const QUIET = /* projection-quiet */ ${JSON.stringify(quiet)};\n`);
fs.writeFileSync(file,source);
const fx=require('../../'+file),native=fs.readFileSync('frontend/app/propsprites.js','utf8').split(/\r?\n/);
const demo=JSON.parse(fs.readFileSync('docs/station-remaster/projection-correction/demo-placement-audit.json'));
const records=[];
for(const[id,p]of Object.entries(m.props))for(const[view,v]of Object.entries(p.views)){
 const c=fx.classify(id,view);if(!c||!c.reason)throw Error('Unclassified '+id+':'+view);
 const image=root+'/'+v.image,bytes=fs.readFileSync(image),nativeLine=native.findIndex(l=>l.includes('F.'+id+' ='))+1;
 records.push({id,view,classification:c.classification,reason:c.reason,inCurrentDemo:!demo.missingTypes.includes(id),image,sourceWidth:v.sourceWidth,sourceHeight:v.sourceHeight,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),regions:c.effects,evidence:[`frontend/app/propsprites.js:${nativeLine||11296}`,'frontend/app/propsprites.js:11296','frontend/app/propremaster.js:285'],frameBounds:fx.frameBounds(id,view)});
}
for(const id of Object.keys(quiet))if(!m.props[id])throw Error('Unknown quiet ID '+id);
for(const id of fx.ids)if(!m.props[id])throw Error('Unknown effects ID '+id);
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/coverage.json',JSON.stringify({version:1,coordinateSpace:'full-export-normalized',catalogTypes:Object.keys(m.props).length,views:records.length,effectTypes:fx.ids.length,quietTypes:Object.keys(quiet).length,records},null,2)+'\n');
console.log({types:Object.keys(m.props).length,views:records.length,effectTypes:fx.ids.length,quietTypes:Object.keys(quiet).length});
