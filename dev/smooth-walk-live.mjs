// Live proof of every selected walk direction through the production sprite renderer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';
const out = join(process.cwd(), '.worldshots', 'smooth-walk', 'live');
const url = 'http://127.0.0.1:9241/';
mkdirSync(out, { recursive: true });
let app, browser, cdp;
try {
  materializeSeedWorkspace(join(out, 'seed'));
  app = bootSeededSidecar({ port: '9241', scratchDir: join(out, 'seed') });
  if (!(await waitUp(url))) throw new Error('Seeded app did not start');
  browser = launchChrome({ cdpPort: 9441, profileDir: join(out, 'chrome') }).proc;
  cdp = await connectCDP(9441);
  const diagnostics = collectDiagnostics(cdp);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  if (!(await waitDevReady(cdp, evalJS, { url, tries: 24 }))) throw new Error('Station did not become ready');
  const skins = process.argv.slice(2).length ? process.argv.slice(2) : await evalJS(cdp, 'Object.keys(DATA.SKINS)');
  const results = {};
  for (const skin of skins) {
    const result = await evalJS(cdp, `(async () => {
      const skin = ${JSON.stringify(skin)};
      for(let i=0;i<120 && !SPRITES.ready;i++) await new Promise(r=>setTimeout(r,100));
      if(!SPRITES.ready) throw new Error('Sprite manifest never became ready');
      await SPRITES.ensureSkin(skin);
      const manifest = (await (await fetch('assets/sprites/manifest.json')).json()).sprites;
      const tracks = Object.keys(manifest).filter(k => k.startsWith(skin + '.walk.'));
      const canvas = document.createElement('canvas'); canvas.width=128; canvas.height=128;
      const g = canvas.getContext('2d', {willReadFrequently:true});
      const paint = (b) => {
        g.setTransform(1,0,0,1,0,0); g.clearRect(0,0,128,128); g.setTransform(2,0,0,2,0,0);
        if (!SPRITES.drawBody(g,b,1000)) throw new Error('Missing body: '+skin);
        const pixels=g.getImageData(0,0,128,128).data;
        let hash=2166136261, top=128, bottom=-1;
        for(let i=0;i<pixels.length;i+=4) {
          if(pixels[i+3]>16) { const y=Math.floor(i/512); top=Math.min(top,y); bottom=Math.max(bottom,y); }
          hash=Math.imul(hash^pixels[i],16777619); hash=Math.imul(hash^pixels[i+1],16777619);
          hash=Math.imul(hash^pixels[i+2],16777619); hash=Math.imul(hash^pixels[i+3],16777619);
        }
        return {hash, height:bottom-top+1, bottom};
      };
      const result={};
      for(const key of tracks) {
        const dir=key.split('.')[2];
        const b={id:'WALK_PROBE',skin,px:32,py:50,dir,state:'idle',phase:0,aph:0,odo:0,noShadow:true};
        const idle=paint(b); b.state='walk';
        const hashes=new Set(), heights=[], bottoms=[];
        for(let odo=0;odo<80;odo+=0.25) { b.odo=odo; const r=paint(b); hashes.add(r.hash); heights.push(r.height); bottoms.push(r.bottom); }
        b.state='idle'; b._rW=2; b._turnAng=0; const turnStart=paint(b).hash;
        b._turnAng=1.5*Math.PI+0.000001; const turnEnd=paint(b).hash;
        result[dir]={turnLoopClosed:turnStart===turnEnd,frames:manifest[key].length,drawnPoses:hashes.size,ratio:Math.max(...heights)/idle.height,bottomSpread:Math.max(...bottoms)-Math.min(...bottoms),pose:b._pose};
      }
      return result;
    })()`);
    results[skin]=result;
    for(const [dir,r] of Object.entries(result)) {
      if(!r.turnLoopClosed || r.frames<8 || r.drawnPoses<r.frames-1 || r.ratio<0.85 || r.ratio>1.16 || r.bottomSpread>3 || r.pose!==`${skin}.walk.${dir}`)
        throw new Error(`${skin}.${dir}: ${JSON.stringify(r)}`);
    }
    console.log(`${skin}: ${Object.keys(result).length} directions render the added poses at stable scale and floor height`);
  }
  writeFileSync(join(out,'receipt.json'),JSON.stringify({results,diagnostics},null,2));
  if(diagnostics.exceptions.length) throw new Error(JSON.stringify(diagnostics.exceptions));
  console.log(`PASS: ${skins.length} skins through the running seeded app`);
} finally {
  cdp?.ws.close(); browser?.kill('SIGKILL'); app?.kill('SIGKILL');
}
