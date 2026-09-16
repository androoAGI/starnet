const fs=require('fs');
let w=fs.readFileSync('frontend/app/world.js','utf8');
const marker='  /* ---------- camera helpers ---------- */';
const injected=`  // This file is an isolated snapshot for the development art review entry only.
  // Mannequins are render-only: never roster members, tasks, or persisted station objects.
  let skinReview = null;
  function showSkinReview(enabled, zoom, id='secretagent') {
    if (!window.__STARNET_DEV__ || !geo || !agent || !cache) return false;
    if (!enabled) { skinReview = null; return true; }
    const deskRef = (geo.props || []).find(p => p.t === 'desk') || {x:tileOf(agent.px,agent.py).x,y:tileOf(agent.px,agent.py).y,w:2,h:1};
    let spot = null;
    for (let radius=0;radius<18&&!spot;radius++) for(let dy=0;dy<=radius&&!spot;dy++) for(let dx=-radius;dx<=radius&&!spot;dx++) {
      const x=Math.floor(deskRef.x+dx), y=Math.floor(deskRef.y+(deskRef.h||1)+2+dy);
      if ([0,1,2].every(n=>geo.walkable(x+n,y,blocked)&&geo.walkable(x+n,y-1,blocked))) spot={x,y};
    }
    if (!spot) return false;
    if (!['ultron','skeleton','plaguedoctor','secretagent','voidwizard'].includes(id)) return false;
    skinReview={spot,id};
    const panel=document.getElementById('agent-station-demo');if(panel){delete panel.dataset.reviewPose0;delete panel.dataset.reviewPose1;panel.dataset.comparison='loading';}
    camLock=null;camAnim=null;camUserAt=fnow;
    const z=zoom || scale;
    camLerp={scale:z,panX:cv.width/2-(spot.x+1.5)*T*z,panY:cv.height*.43-((spot.y+1)*T-10)*z};
    return true;
  }
`;
w=w.replace(marker,injected+marker);
w=w.replace('    loadStation, spawn, spawnAgent,','    showSkinReview, loadStation, spawn, spawnAgent,');
const hook='    // A raised doorway stands in front of a body until its feet clear the wall.';
w=w.replace(hook,`    if (skinReview) {
      camUserAt=now; // Keep the idle camera director from leaving an explicit art comparison.
      const spot=skinReview.spot;
      const light=sceneRenderer && sceneRenderer.sampleLight((spot.x+1.5)*T,(spot.y+1)*T-1);
      ['industrial_'+skinReview.id,'readability_'+skinReview.id].forEach((skin,i)=>{
        const f=footOf(spot.x+i*2,spot.y);
        const b={id:'skin-review-'+i,skin,px:f.x,py:f.y,dir:'south',state:'idle',aph:0};
        items.push({y:f.y,draw:()=>{
          const result=SPRITES.drawBody(ctx,b,0,{reducedMotion:true,light,skipGroundShadow:false});
          if(result){
            ctx.save();ctx.font='5px VT323';ctx.textAlign='center';ctx.fillStyle='#e4dab9';ctx.shadowColor='#000';ctx.shadowBlur=2;ctx.fillText(i?'REVISED':'CURRENT',f.x,f.y+5);ctx.restore();
            const p=document.getElementById('agent-station-demo');if(p){p.dataset['reviewPose'+i]=b._pose;p.dataset.comparison=p.dataset.reviewPose0&&p.dataset.reviewPose1?'drawn':'loading';p.dataset.reviewHeight='18';p.dataset.reviewZoom=String(scale);p.dataset.reviewPos=JSON.stringify(spot);}
          }
        }});
      });
    }
`+hook);
fs.writeFileSync('frontend/agent-demo/review-world.js',w);
let html=fs.readFileSync('frontend/agent-station-demo.html','utf8').replace('src="app/world.js"','src="agent-demo/review-world.js"');fs.writeFileSync('frontend/agent-station-demo.html',html);
