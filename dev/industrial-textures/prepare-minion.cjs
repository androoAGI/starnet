'use strict';
// Package generated art only: uniform scaling, transparent padding and foot anchoring.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '../..');
const source = path.resolve(process.argv[2] || path.join(__dirname, 'minion-source/base'));
const out = path.join(root, 'frontend/assets/sprites/station_minion');
const dirs = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const cardinal = ['south', 'east', 'north', 'west'];
async function box(file) {
  const {data, info} = await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let l=info.width,t=info.height,r=-1,b=-1;
  for(let y=0;y<info.height;y++) for(let x=0;x<info.width;x++) if(data[(y*info.width+x)*4+3]>0) {
    l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);
  }
  if(r<l) throw new Error('Empty art: '+file);
  return {l,t,r:r+1,b:b+1,w:r-l+1,h:b-t+1,cx:(l+r+1)/2};
}
async function place(file, scale, anchorX, name) {
  const original=await box(file);
  const crop=await sharp(file).ensureAlpha().extract({left:original.l,top:original.t,width:original.w,height:original.h})
    .resize(Math.round(original.w*scale),Math.round(original.h*scale),{kernel:'lanczos3'}).png().toBuffer();
  const b={w:Math.round(original.w*scale),h:Math.round(original.h*scale)};
  const left=Math.round(46+(original.l-anchorX)*scale),top=69-b.h;
  if(left<0 || top<0 || left+b.w>92) throw new Error('Clipped art: '+name);
  await sharp({create:{width:92,height:92,channels:4,background:'#00000000'}})
    .composite([{input:crop,left,top}]).png({palette:false}).toFile(path.join(out,name));
  return {name,width:b.w,height:b.h,bottom:69,scale};
}
async function main() {
  fs.mkdirSync(out,{recursive:true});
  const spriteRoot=path.dirname(out), manifestPath=path.join(spriteRoot,'manifest.json');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')), report=[];
  const south=await box(path.join(source,'Idle/rotations/south.png'));
  const scale=44/south.h;
  const add=(key,files)=>{manifest.sprites['station_minion.'+key]=files.map(f=>'station_minion/'+f);};
  for(const d of dirs) {
    const idle=path.join(source,'Idle/rotations',d+'.png'), ib=await box(idle);
    report.push(await place(idle,scale,ib.cx,'rot_'+d+'.png'));add('rot.'+d,['rot_'+d+'.png']);
    const walkDir=path.join(source,'Idle/animations/walk',d);
    const files=fs.readdirSync(walkDir).filter(f=>f.endsWith('.png')).sort();
    if(files.length!==8) throw new Error('Expected 8 walking frames: '+d);
    const wb=await Promise.all(files.map(f=>box(path.join(walkDir,f))));
    const ratio=Math.max(...wb.map(b=>b.h))/ib.h;
    const walkScale=scale*(ratio>1.08 || ratio<0.96 ? 1.03/ratio : 1);
    const names=[];
    for(let i=0;i<files.length;i++) {
      const name='walk_'+d+'_'+i+'.png'; names.push(name);
      report.push(await place(path.join(walkDir,files[i]),walkScale,ib.cx,name));
    }
    add('walk.'+d,names);
  }
  for(const d of cardinal) {
    const sit=path.join(source,'Seated/rotations',d+'.png'), sb=await box(sit);
    report.push(await place(sit,scale,sb.cx,'sit_'+d+'.png'));add('sit.'+d,['sit_'+d+'.png']);
    const typeDir=path.join(source,'Seated/animations/typing',d);
    if(fs.existsSync(typeDir)) {
      const files=fs.readdirSync(typeDir).filter(f=>f.endsWith('.png')).sort();
      const names=[];
      for(let i=0;i<files.length;i++) {
        const name='type_'+d+'_'+i+'.png';names.push(name);
        report.push(await place(path.join(typeDir,files[i]),scale,sb.cx,name));
      }
      add('type.'+d,names);
    }
  }
  fs.writeFileSync(manifestPath,(JSON.stringify(manifest,null,2)+'\n').replace(/\n/g,'\r\n'));
  fs.writeFileSync(path.join(__dirname,'minion-source/assembly.json'),JSON.stringify({scale,report},null,2)+'\n');
  console.log(JSON.stringify({frames:report.length,scale,heights:report.filter(r=>!r.name.startsWith('walk')).map(r=>[r.name,r.height])},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
