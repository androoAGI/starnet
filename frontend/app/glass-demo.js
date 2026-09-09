/* Opt-in local material/interaction demo: ?glass=1. Uses real app windows and data. */
(() => {
  'use strict';
  if (new URLSearchParams(location.search).get('glass') !== '1') return;
  document.body.classList.add('glass-demo');
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'css/glass-demo.css'; document.head.append(css);
  const badge = document.createElement('span'); badge.className = 'gd-badge'; badge.textContent = 'GLASS DEMO'; document.body.append(badge);
  // One small, square-stroke instrument icon set; decorative, so labels remain plain text.
  const dockIcons = {
    crew: '<path d="M5 2h5v5H5zM3 14v-4h9v4M12 3h2v4M14 10h1v4"/>',
    work: '<path d="M3 2h10v12H3zM6 5h4M6 8h4M6 11h2"/>',
    build: '<path d="M2 2h5v5H2zM2 9h5v5H2zM9 9h5v5H9zM11.5 2v5M9 4.5h5"/>',
    system: '<path d="M4 4h8v8H4zM6 6h4v4H6zM6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3"/>'
  };
  Object.entries(dockIcons).forEach(([group, paths]) => {
    const icon = document.querySelector('#bottombar [data-group="'+group+'"] > .bb-grp .bb-gi');
    if (icon) { icon.setAttribute('aria-hidden','true'); icon.innerHTML = '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'+paths+'</svg>'; }
  });

  const states = new Map();
  const zoom = () => Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
  const rect = el => el && el.getBoundingClientRect();
  function band() {
    const z = zoom(), top = rect(document.querySelector('#topbar')), bottom = rect(document.querySelector('#bottombar'));
    const left = rect(document.querySelector('#left')), right = rect(document.querySelector('#chat-panel'));
    let x = left && left.width ? left.right + 10 : 12;
    let end = right && right.width ? right.left - 10 : innerWidth - 12;
    if (end - x < 520) { x = 12; end = innerWidth - 12; }
    return { x:x/z, width:(end-x)/z, top:((top ? top.bottom : 0)+10)/z, bottom:((bottom ? bottom.top : innerHeight)-10)/z };
  }
  function seat(w, s, animate = false) {
    if (!w.isConnected || w.classList.contains('term-min-hidden') || !s.docked) return;
    const b = band(), available = Math.max(160,b.bottom-b.top);
    const h = s.expanded ? available : Math.min(available, Math.max(220, s.height || available * .56));
    w.style.animation = 'none'; w.style.transform = 'none';
    Object.assign(w.style, {left:b.x+'px',top:(b.bottom-h)+'px',width:b.width+'px',height:h+'px',maxWidth:b.width+'px',maxHeight:available+'px'});
    w.classList.add('term-moved','gd-docked');
    s.expand.textContent = s.expanded ? 'RESTORE' : 'EXPAND';
    s.expand.setAttribute('aria-expanded',String(s.expanded));
    s.dock.hidden = true;
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      w.animate([{translate:'0 65px',opacity:.25},{translate:'0 0',opacity:1}],{duration:260,easing:'ease-out'});
  }
  function attach(w) {
    if (states.has(w) || w.classList.contains('pw')) return;
    const head = w.querySelector('.term-head'); if (!head) return;
    const s = {docked:true,expanded:false,height:null}; states.set(w,s);
    w.classList.add('gd-sheet');
    w._fitDockedSheet = () => { if (!s.docked) return false; seat(w,s); return true; };
    const controls = document.createElement('span'); controls.className = 'gd-controls';
    const button = (label, action) => {
      const b = document.createElement('button'); b.type='button'; b.textContent=label;
      b.addEventListener('mousedown', e=>e.stopPropagation());
      b.addEventListener('dblclick', e=>e.stopPropagation());
      b.addEventListener('click',e=>{e.stopPropagation();action();}); controls.append(b); return b;
    };
    s.dock = button('DOCK',()=>{s.docked=true;s.expanded=false;seat(w,s,true);});
    s.expand = button('EXPAND',()=>{
      if (!s.docked) s.docked=true;
      s.expanded=!s.expanded;seat(w,s);
    });
    button('MINIMIZE',()=>w._minimize());
    head.addEventListener('dblclick',e=>{
      if(e.target.closest('button'))return;
      e.preventDefault();e.stopImmediatePropagation();w._minimize();
    },true);
    head.insertBefore(controls,head.querySelector('.term-x'));
    const pull = document.createElement('button'); pull.className='gd-pull'; pull.type='button';
    pull.setAttribute('aria-label','Resize panel height. Drag or use arrow keys.');
    head.append(pull);
    let drag = null;
    pull.addEventListener('mousedown',e=>e.stopPropagation());
    pull.addEventListener('dblclick',e=>e.stopPropagation());
    pull.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      e.preventDefault();e.stopPropagation();s.docked=true;s.expanded=false;
      drag={y:e.clientY,h:w.getBoundingClientRect().height/zoom()};pull.setPointerCapture(e.pointerId);
    });
    pull.addEventListener('pointermove',e=>{
      if(!drag)return;s.height=drag.h+(drag.y-e.clientY)/zoom();seat(w,s);
    });
    const finish=()=>{drag=null;};pull.addEventListener('pointerup',finish);pull.addEventListener('pointercancel',finish);
    pull.addEventListener('keydown',e=>{
      if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
      e.preventDefault();e.stopPropagation();s.docked=true;
      if(e.key==='Home'){s.expanded=false;s.height=220;}
      else if(e.key==='End'){s.expanded=true;}
      else {s.expanded=false;s.height=w.getBoundingClientRect().height/zoom()+(e.key==='ArrowUp'?40:-40);}
      seat(w,s);
    });
    head.addEventListener('mousedown',e=>{
      if(e.target.closest('button'))return;
      const startX=e.clientX, startY=e.clientY;
      let moved=false;
      const move=ev=>{
        if(moved || Math.hypot(ev.clientX-startX,ev.clientY-startY)<4)return;
        moved=true;s.docked=false;s.expanded=false;s.dock.hidden=false;s.expand.textContent='EXPAND';
        s.expand.setAttribute('aria-expanded','false');w.classList.remove('gd-docked');
        w.style.maxWidth='calc(100vw * var(--sn-unzoom,1) - 24px)';
      };
      window.addEventListener('mousemove',move);
      window.addEventListener('mouseup',()=>{
        window.removeEventListener('mousemove',move);
        if(!moved){w._lastDragMoved=false;seat(w,s);}
      },{once:true});
    },true);
    s.visibility = new MutationObserver(records => {
      if (records.some(r => (r.oldValue || '').split(' ').includes('term-min-hidden')) && !w.classList.contains('term-min-hidden'))
        requestAnimationFrame(()=>seat(w,s));
    });
    s.visibility.observe(w,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
    requestAnimationFrame(()=>seat(w,s,true));
  }
  const host=document.querySelector('#terms'); if(!host)return;
  let queued=false;
  const update=()=>{
    queued=false;
    states.forEach((s,w)=>{if(!w.isConnected){s.visibility.disconnect();states.delete(w);}});
    host.querySelectorAll('.term').forEach(w=>{if(!states.has(w))attach(w);else seat(w,states.get(w));});
  };
  new MutationObserver(()=>{if(!queued){queued=true;requestAnimationFrame(update);}}).observe(host,{childList:true});
  const layout=new ResizeObserver(()=>states.forEach((s,w)=>seat(w,s)));
  ['#topbar','#bottombar','#left','#chat-panel'].forEach(sel=>{const el=document.querySelector(sel);if(el)layout.observe(el);});
  window.addEventListener('resize',()=>requestAnimationFrame(()=>states.forEach((s,w)=>seat(w,s))));
  update();
})();
