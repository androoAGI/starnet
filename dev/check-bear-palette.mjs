import fs from 'node:fs';
import {decodePNG} from '../scripts/lib/png.mjs';
const root = new URL('../frontend/assets/sprites/',import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json',root),'utf8'));
const paths = [...new Set(Object.values(manifest.sprites).flat())];
const faults=[]; let bearFrames=0;
for(const path of paths) {
  const image=decodePNG(fs.readFileSync(new URL(path,root)));
  if(path.startsWith('bear/'))bearFrames++;
  let bad=0;
  for(let i=0;i<image.pixels.length;i+=image.channels){
    const r=image.pixels[i],g=image.pixels[i+1],b=image.pixels[i+2],a=image.channels===4?image.pixels[i+3]:255;
    if(a<=100)continue;
    if((r===116&&g===186&&b===180) || (path.startsWith('bear/')&&g-r>20&&b-r>20))bad++;
  }
  if(bad)faults.push(path+': '+bad+' foreign palette pixels');
}
if(faults.length){console.error(faults.join('\n'));process.exitCode=1;}
else console.log('sprite-palette: '+paths.length+' frames scanned; '+bearFrames+' bear frames checked; no known contamination');
