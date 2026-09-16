import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChrome, connectCDP, evalJS } from '../scripts/lib/cdp.mjs';
import { waitUp, waitDevReady } from '../scripts/lib/seed.mjs';
const url = 'http://127.0.0.1:8985/';
const out = new URL('../.shell-proof/', import.meta.url);
mkdirSync(out, { recursive: true });
const { proc } = launchChrome({ cdpPort: 9385, profileDir: new URL('chrome/', out).pathname.replace(/^\/([A-Z]:)/, '$1') });
let cdp;
try {
  if (!await waitUp(url)) throw Error('seed server unavailable');
  cdp = await connectCDP(9385);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  if (!await waitDevReady(cdp, evalJS, { url })) throw Error('live station did not become ready');
  const result = await evalJS(cdp, `(async () => {
    await IndustrialTextures.ready;
    const status = IndustrialTextures.status();
    if (!status.loaded || status.failed.length) throw Error(JSON.stringify(status));
    const ids = WorldModel.HULL_ORDER;
    const cv = document.createElement('canvas'); cv.width = 960; cv.height = ids.length * 122;
    const g = cv.getContext('2d'); g.fillStyle = '#121619'; g.fillRect(0,0,cv.width,cv.height);
    const receipt = [];
    ids.forEach((id,i) => {
      const row = document.createElement('canvas'); row.width = 240; row.height = 96;
      const r = row.getContext('2d');
      const hue = WorldModel.HULL_MATERIALS[id].suggest;
      StationBake.sampleHull(r, id, WorldModel.FLOOR_STYLES[hue]?.base || null, 20, 96, 12);
      const pixels = r.getImageData(0,0,240,96).data;
      let nonempty = 0, sum = 0;
      for (let k=0;k<pixels.length;k+=4) { if(pixels[k+3]) nonempty++; sum += pixels[k]+pixels[k+1]+pixels[k+2]; }
      if (!nonempty || !sum) throw Error(id + ' empty');
      receipt.push({id, nonempty, sum, hue});
      g.fillStyle='#ddd'; g.font='16px monospace'; g.fillText(id.toUpperCase(), 12, i*122+20);
      g.drawImage(row, 180, i*122+8, 720, 108);
    });
    if (new Set(receipt.map(x=>x.sum)).size !== ids.length) throw Error('materials not distinct');
    const painted = [];
    for (const colour of ['#603020', '#203060']) {
      const c=document.createElement('canvas'); c.width=c.height=96;
      const cg=c.getContext('2d'); IndustrialTextures.shellPlate(cg,0,0,96,96,'brick',colour);
      const d=cg.getImageData(0,0,96,96).data; const total=[0,0,0];
      for(let k=0;k<d.length;k+=4) { if(d[k+3]!==255) throw Error('texture alpha leaked'); for(let j=0;j<3;j++) total[j]+=d[k+j]; }
      painted.push(total);
    }
    if (!(painted[0][0]>painted[0][2] && painted[1][2]>painted[1][0])) throw Error('paint hue lost');
    const doc = WorldModel.defaultDoc();
    doc.rooms = {}; doc.order = []; doc.props = []; doc.belts = {}; doc.edges = []; doc.meta.spawnRoomId = null;
    const st = WorldModel.create(doc);
    ids.slice(1).forEach((mat,i) => {
      const x = (i%3)*20, y = Math.floor(i/3)*20;
      const room = st.addRoom({kind:'hab', rects:[{x1:x,y1:y,x2:x+16,y2:y+10}]});
      if (!room.ok) throw Error('room creation '+JSON.stringify(room));
      st.setHull(room.id,{mat,style:WorldModel.HULL_MATERIALS[mat].suggest});
    });
    const bake = StationBake.bake(st.projectGeometry());
    const scene = document.createElement('canvas'); scene.width=bake.W*2; scene.height=bake.H*2;
    const sg=scene.getContext('2d'); sg.fillStyle='#080b10'; sg.fillRect(0,0,scene.width,scene.height);
    sg.scale(2,2); StationBake.drawBase(sg,bake,0,0); StationBake.drawLight(sg,bake,0,0);
    return {status, receipt, painted, roomCount:st.doc().order.length,
      samples:cv.toDataURL('image/png').split(',')[1], scene:scene.toDataURL('image/png').split(',')[1]};
  })()`);
  for (const key of ['samples','scene']) { writeFileSync(new URL(key+'.png',out),Buffer.from(result[key],'base64')); delete result[key]; }
  writeFileSync(new URL('receipt.json',out), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  cdp?.ws.close(); proc.kill();
}
process.exit(0);
