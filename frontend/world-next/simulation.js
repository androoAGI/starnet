/* The fresh client's presentation simulation. Harness run state is an input, never a timer outcome. */
'use strict';
const NextSimulation = (() => {
  const key=(x,y)=>x+','+y;
  const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
  function create(){
    let model=null,geo=null,doc=null,actors=[],clock=0;
    const traversable=(x,y)=>!!(geo&&geo.walkable(x-geo.origin.tx,y-geo.origin.ty));
    function nearest(x,y){
      x=Math.floor(x);y=Math.floor(y);if(traversable(x,y))return{x:x+.5,y:y+.88};
      for(let r=1;r<100;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++)if((Math.abs(dx)===r||Math.abs(dy)===r)&&traversable(x+dx,y+dy))return{x:x+dx+.5,y:y+dy+.88};
      return null;
    }
    function setStation(next){
      model=next;doc=model.serialize();geo=model.projectGeometry();
      for(const a of actors){const p=nearest(a.x,a.y);if(p){a.x=p.x;a.y=p.y;a.unplaced=false;}else a.unplaced=true;a.path=[];}
    }
    function path(a,target){
      if(!geo||!target||!a||a.unplaced)return[];
      const o=geo.origin,start={x:Math.floor(a.x)-o.tx,y:Math.floor(a.y)-o.ty},end={x:Math.floor(target.x)-o.tx,y:Math.floor(target.y)-o.ty};
      const p=geo.path(start.x,start.y,end.x,end.y);
      return(p||[]).map(t=>({x:(Array.isArray(t)?t[0]:t.x)+o.tx+.5,y:(Array.isArray(t)?t[1]:t.y)+o.ty+.88}));
    }
    function deskFor(id){return doc&&doc.props.find(p=>p.agentId===id&&/desk|console|bench|pixelrig/.test(p.t))||doc&&doc.props.find(p=>p.agentId===id);}
    function setRoster(roster){
      const old=new Map(actors.map(a=>[a.id,a]));
      actors=(roster||[]).map((r,i)=>{const id=r.id||r.agentId,desk=deskFor(id),rm=doc&&doc.rooms[doc.meta.spawnRoomId],rect=rm&&rm.rects[0];const pos=nearest(desk?desk.x+desk.w/2:rect?(rect.x1+rect.x2)/2:0,desk?desk.y+desk.h:rect?(rect.y1+rect.y2)/2:0);
        return Object.assign(old.get(id)||{id,x:pos?pos.x:0,y:pos?pos.y:0,path:[],dir:'south',moving:false,working:false,wait:2+i*2,phase:hash(id)%1000,unplaced:!pos},
          {name:r.name||id,color:r.color||['#99cbd2','#e0ad70','#accb93'][i%3],appearance:i%3,role:r.role||'Crew member'});});
    }
    function updateWork(runList,online){
      for(const a of actors){const run=(runList||[]).find(r=>(r.agentId===a.id||r.agent_id===a.id)&&/^(running|working|active|streaming|awaiting_approval)$/.test(r.status||r.state));
        const next=!!run&&online;if(next&&!a.working){const d=deskFor(a.id);if(d)a.path=path(a,nearest(d.x+d.w/2,d.y+d.h));}
        a.working=next;a.runId=run&&run.runId||run&&run.id||null;a.workUnknown=!online;
      }
    }
    function move(id,x,y){const a=actors.find(a=>a.id===id),target=nearest(x,y);if(!a||!target)return false;const route=path(a,target);if(!route.length)return false;a.path=route;a.wait=20;return true;}
    function tick(dt){
      dt=Math.min(.05,Math.max(0,dt));clock+=dt;
      for(const a of actors){if(a.unplaced)continue;a.moving=false;
        while(a.path.length&&Math.hypot(a.path[0].x-a.x,a.path[0].y-a.y)<.08)a.path.shift();
        if(a.path.length){const target=a.path[0],dx=target.x-a.x,dy=target.y-a.y,d=Math.hypot(dx,dy),step=Math.min(d,dt*2.1);a.x+=dx/d*step;a.y+=dy/d*step;a.moving=true;a.dir=Math.abs(dx)>Math.abs(dy)?dx>0?'east':'west':dy>0?'south':'north';}
        else if(a.working){a.dir='north';a.wait=4;}
        else if((a.wait-=dt)<=0){const n=hash(a.id+Math.floor(clock/5)),dx=n%13-6,dy=(n>>>8)%11-5;const target=nearest(a.x+dx,a.y+dy);a.path=path(a,target);a.wait=5+(n%7);}
      }
      return actors;
    }
    return{setStation,setRoster,updateWork,move,tick,actors:()=>actors,walkable:traversable,nearest,path:(id,p)=>path(actors.find(a=>a.id===id),p)};
  }
  return{create,hash};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=NextSimulation;
