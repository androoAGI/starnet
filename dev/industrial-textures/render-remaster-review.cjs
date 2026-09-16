'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),{createCanvas,Image}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'dev/.scratch-workspace/remaster-review');
class Asset extends Image {set src(url){super.src=fs.readFileSync(path.join(root,'frontend',url));}}
const document={documentElement:{dataset:{}},createElement:()=>createCanvas(1,1)};
const env={Image:Asset,document,location:{search:''},URLSearchParams,module:{exports:{}}};
vm.runInNewContext(fs.readFileSync(path.join(root,'frontend/app/industrialtextures.js'),'utf8'),env);
const pack=env.module.exports;
(async()=>{
 await pack.ready; if(!pack.enabled())throw Error(JSON.stringify(pack.status()));
 fs.mkdirSync(out,{recursive:true});
 const ids='spine alloy plate panel tile tread soft grate hex plank turf diamond resin ceramic cargo runner treadway meshway basalt parquet rubber slotted terrazzo octile'.split(' ');
 const cv=createCanvas(1152,850),g=cv.getContext('2d');g.fillStyle='#101213';g.fillRect(0,0,cv.width,cv.height);
 g.fillStyle='#d4d0c3';g.font='18px sans-serif';g.fillText('BRIDGE REMASTER / 24 FLOOR MATERIALS',20,28);
 for(let i=0;i<ids.length;i++){const X=(i%6)*192+16,Y=Math.floor(i/6)*198+48;
 g.fillStyle='#b5b0a5';g.font='13px sans-serif';g.fillText(ids[i],X,Y+15);
 g.save();g.translate(X,Y+24);g.scale(1.65,1.65);
 for(let y=0;y<8;y++)for(let x=0;x<8;x++)pack.floor(g,x*12,y*12,12,x,y,ids[i]);g.restore();}
 fs.writeFileSync(path.join(out,'floors.png'),cv.toBuffer('image/png'));
 const wcv=createCanvas(1152,550),wg=wcv.getContext('2d');wg.fillStyle='#101213';wg.fillRect(0,0,wcv.width,wcv.height);
 wg.fillStyle='#d4d0c3';wg.font='18px sans-serif';wg.fillText('BRIDGE REMASTER / WALL BAYS',20,28);
 const walls='bulkhead courses service plating ribbed panelled pipework'.split(' ');
 for(let i=0;i<walls.length;i++){const X=(i%4)*288+16,Y=Math.floor(i/4)*245+50;
 wg.fillStyle='#b5b0a5';wg.font='13px sans-serif';wg.fillText(walls[i],X,Y);
 wg.save();wg.translate(X,Y+14);wg.scale(5,5);for(let x=0;x<4;x++)pack.wall(wg,x*12,0,12,39,x,walls[i]);wg.restore();}
 fs.writeFileSync(path.join(out,'walls.png'),wcv.toBuffer('image/png'));
 const pcv=createCanvas(1152,770),pg=pcv.getContext('2d');pg.fillStyle='#101213';pg.fillRect(0,0,pcv.width,pcv.height);
 pg.fillStyle='#d4d0c3';pg.font='18px sans-serif';pg.fillText('WORKSTATIONS / ACTUAL TILE FOOTPRINTS / SAME CAMERA',20,28);
 for(let row=0;row<2;row++)for(let i=0;i<4;i++){const face=['s','w','n','e'][i],side=i%2,L=row?24:36,w=side?12:L,h=side?L:12,X=i*280+25,Y=110+row*350;
 pg.fillStyle='#aaa594';pg.font='13px sans-serif';pg.fillText((row?'COMPACT ':'BROAD ')+face.toUpperCase()+' / '+w/12+' × '+h/12,X,Y-40);
 pg.save();pg.translate(X+50,Y);pg.scale(4,4);
 for(let yy=0;yy<5;yy++)for(let xx=0;xx<4;xx++)pack.floor(pg,xx*12,yy*12,12,xx,yy,'plate');
 pg.strokeStyle='#756744';pg.lineWidth=.3;pg.strokeRect(0,0,w,h);
 if(face==='w'){pg.translate(w,0);pg.scale(-1,1);}
 pack.workstation(pg,0,0,w,h,face==='w'?'e':face);
 pg.restore();}
 fs.writeFileSync(path.join(out,'workstations.png'),pcv.toBuffer('image/png'));
 console.log(JSON.stringify({assets:pack.status().assets.length,review:out}));
})().catch(e=>{console.error(e);process.exitCode=1;});
