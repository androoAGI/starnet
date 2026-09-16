'use strict';
(()=>{
  if(!['localhost','127.0.0.1'].includes(location.hostname)||new URLSearchParams(location.search).get('showcase')!=='kepler')return;
  const style=document.createElement('style');style.textContent='#skin-study-preview,#nav-coach{display:none!important} #kepler-review{position:fixed;z-index:99999;top:56px;left:50%;transform:translateX(-50%);padding:10px 18px;background:#091214ed;border:1px solid #746546;color:#d7c89d;max-width:calc(100vw - 36px);width:max-content;text-align:center;font:13px VT323, monospace} #kepler-review strong{font-size:16px;letter-spacing:.18em} #kepler-review p{margin:6px 0 9px;color:#9aa8a5;font-size:11px} #kepler-review nav{display:flex;gap:6px;flex-wrap:wrap;justify-content:center} #kepler-review button{background:#172124;border:1px solid #495853;color:#c7c7af;padding:6px 10px;font:12px VT323, monospace;cursor:pointer} #kepler-review button[aria-pressed=true]{border-color:#bda36d;color:#f0d39a;background:#28312d}';document.head.append(style);
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
  let attempts=0;
  const timer=setInterval(()=>{
    if(++attempts>100){clearInterval(timer);return;}
    if(!document.querySelector('#screen-game.active')||typeof World==='undefined')return;
    const cinema=document.querySelector('.cam-cine');
    if(cinema&&cinema.textContent.includes('CINEMA')){cinema.click();return;}
    if(frame(''))clearInterval(timer);
  },300);
})();
