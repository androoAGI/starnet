'use strict';
(()=>{
  if(!['localhost','127.0.0.1'].includes(location.hostname)||new URLSearchParams(location.search).get('showcase')!=='kepler')return;
  const style=document.createElement('style');style.textContent='#skin-study-preview,#nav-coach{display:none!important} body.refit-on #kepler-review{display:none} #kepler-review{position:fixed;z-index:99999;top:56px;left:50%;transform:translateX(-50%);padding:10px 18px;background:#091214ed;border:1px solid #746546;color:#d7c89d;max-width:calc(100vw - 36px);width:max-content;text-align:center;font:13px monospace} #kepler-review strong{font-size:16px;letter-spacing:.18em} #kepler-review p{margin:6px 0 9px;color:#9aa8a5;font-size:11px} #kepler-review nav{display:flex;gap:6px;flex-wrap:wrap;justify-content:center} #kepler-review button{background:#172124;border:1px solid #495853;color:#c7c7af;padding:6px 10px;font:12px monospace;cursor:pointer} #kepler-review button[aria-pressed=true]{border-color:#bda36d;color:#f0d39a;background:#28312d}';document.head.append(style);
  const panel=document.createElement('aside');panel.id='kepler-review';panel.setAttribute('aria-label','Kepler station review');
  panel.innerHTML='<strong>KEPLER RELAY</strong><p>A three-room station study · new station graphics</p><nav aria-label="Station views"></nav>';
  const nav=panel.querySelector('nav');
  function frame(id){
    if(typeof World==='undefined'||!World.frameReviewRoom(id))return false;
    World.setCinecamIdle(86400000);panel.dataset.room=id||'overview';
    for(const b of nav.children)b.setAttribute('aria-pressed',String(b.dataset.room===(id||'')));
    return true;
  }
  for(const[id,label]of [['','Whole station'],['command','01 · Command'],['fabrication','02 · Fabrication'],['lounge','03 · Lounge']]){
    const b=document.createElement('button');b.textContent=label;b.dataset.room=id;b.setAttribute('aria-pressed','false');b.onclick=()=>frame(id);nav.append(b);
  }
  document.body.append(panel);
  // Opt-in local QA: exercise actual bodies, navigation and seating in the running station.
  // No fixture object is saved, and these controls never appear in the normal showcase.
  if(new URLSearchParams(location.search).get('fitAudit')==='1'){
    const audit=document.createElement('aside');audit.id='kepler-fit-audit';
    audit.style.cssText='position:fixed;bottom:10px;left:10px;z-index:99999;max-width:360px;padding:10px;background:#091214f5;color:#d7c89d;border:1px solid #746546;font:12px monospace';
    audit.innerHTML='<b>LOCAL DEPTH REVIEW</b><br><select aria-label="Review furniture"></select><div></div><output style="display:block;white-space:pre-wrap"></output>';
    const choose=audit.querySelector('select'),buttons=audit.querySelector('div'),out=audit.querySelector('output');
    let filled=false,last='Choose furniture, then walk behind/in front or use a seat.';
    const current=()=>{
      const doc=World.stationDoc();if(!doc)return null;
      const geo=WorldModel.deserialize(doc).projectGeometry(),p=geo.props.find(p=>p.id===choose.value),b=World.bodies().find(b=>b.hero);
      return p&&b?{p,b,geo}:null;
    };
    const add=(name,fn)=>{const b=document.createElement('button');b.textContent=name;b.style.margin='6px 4px 6px 0';b.onclick=()=>{const s=current();if(s)last=name+': '+(fn(s)?'planned':'unavailable');};buttons.append(b);};
    add('Walk behind',({p,b})=>World._dbgReviewWalk(b.id,Math.floor(p.x+p.w/2),p.y-1));
    add('Walk in front',({p,b})=>World._dbgReviewWalk(b.id,Math.floor(p.x+p.w/2),p.y+p.h));
    add('Use seat',({p,b})=>World._dbgReviewSeat(b.id,p.id));
    choose.onchange=()=>{const doc=World.stationDoc(),p=doc&&doc.props.find(p=>p.id===choose.value);if(!p)return;const room=Object.values(doc.rooms).find(r=>(r.rects||[]).some(r=>p.x>=r.x1&&p.x<=r.x2&&p.y>=r.y1&&p.y<=r.y2));if(room)frame(room.id);};
    document.body.append(audit);
    setInterval(()=>{
      if(typeof World==='undefined')return;
      if(!filled){const d=World.stationDoc();if(!d)return;for(const p of d.props){if(!/chair|couch|recliner|stool|table|workbench|desk/.test(p.t))continue;const o=document.createElement('option');o.value=p.id;o.textContent=p.t+' · '+p.id;choose.append(o);}filled=true;}
      const s=current();if(!s)return;
      out.textContent=last+'\n'+s.p.w+'×'+s.p.h+' floor · facing '+(s.p.r||0)+'\n'+s.b.name+': '+s.b.state+' · '+(s.b.seated?'seated':'on floor')+'\nusing: '+(s.b.usingProp||'none')+'\nfeet: '+s.b.px+', '+s.b.py+' · pose '+(s.b.pose||'none');
    },300);
  }
  let attempts=0;
  const timer=setInterval(()=>{
    if(++attempts>100){clearInterval(timer);return;}
    if(!document.querySelector('#screen-game.active')||typeof World==='undefined')return;
    const cinema=document.querySelector('.cam-cine');
    if(cinema&&cinema.textContent.includes('CINEMA')){cinema.click();return;}
    if(frame(''))clearInterval(timer);
  },300);
})();
