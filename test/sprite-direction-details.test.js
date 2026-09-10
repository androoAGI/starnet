'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib'),A=require('./_assert');
const decode=Function('A','zlib',A.fnBody(fs.readFileSync('test/sprite-walk-motion.test.js','utf8'),'function decodePng(')+';return decodePng;')(A,zlib);
const root=process.env.SPRITE_TEST_ROOT||'frontend/assets/sprites';
for(let f=0;f<8;f++)for(const skin of ['ninjaturtle','voidwizard']){
 const p=path.join(root,skin,skin==='ninjaturtle'?`walk_north_${f}.png`:`walk_north-west_${f}.png`),im=decode(fs.readFileSync(p),p);let top=im.height,bottom=0;
 for(let y=0;y<im.height;y++)for(let x=0;x<im.width;x++)if(im.data[(y*im.width+x)*4+3]>64){top=Math.min(top,y);bottom=Math.max(bottom,y)}
 let green=0,warm=0,staff=0,staffTop=im.height;const columns=new Map();
 for(let y=top;y<=bottom;y++)for(let x=0;x<im.width;x++){
  const i=(y*im.width+x)*4,[r,g,b,a]=im.data.subarray(i,i+4);if(a<128)continue;
  if(skin==='ninjaturtle'&&y>top+(bottom-top)*.4&&y<top+(bottom-top)*.8){if(g>r*1.1&&g>b*1.2)green++;if(r>100&&g>80&&r>g*1.12)warm++;}
  if(skin==='voidwizard'&&r>60&&r>b*1.25&&r>=g*1.2){staff++;const ys=columns.get(x)||[];ys.push(y);columns.set(x,ys);}
 }
 if(skin==='ninjaturtle')A.ok(green>15&&green>2*warm,'north walk keeps a green rear shell rather than a tan chest: frame '+f);
 else{for(const ys of columns.values())if(ys.length>=5)staffTop=Math.min(staffTop,...ys);A.ok(staff>=5,'northwest staff remains visible: frame '+f);A.ok(staffTop>top+4,'northwest staff does not protrude above the hat: frame '+f);}
}
A.report('sprite-direction-details');
