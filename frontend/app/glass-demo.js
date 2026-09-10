/* Station glass window controller. Uses the existing windows, controls and real data. */
(() => {
  'use strict';
  if (!document.body.classList.contains('glass-demo')) return;
  // One small, square-stroke instrument icon set; decorative, so labels remain plain text.
  const dockIcons = {
    crew: '<path d="M5 2h5v5H5zM3 14v-4h9v4M12 3h2v4M14 10h1v4"/>',
    work: '<path d="M3 2h10v12H3zM6 5h4M6 8h4M6 11h2"/>',
    build: '<path d="M2 2h8l4 3-2 2-3-2H2zM6 5v9h3V5"/>',
    system: '<path d="M4 4h8v8H4zM6 6h4v4H6zM6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3"/>'
  };
  Object.entries(dockIcons).forEach(([group, paths]) => {
    const icon = document.querySelector('#bottombar [data-group="'+group+'"] > .bb-grp .bb-gi');
    if (icon) { icon.setAttribute('aria-hidden','true'); icon.innerHTML = '<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">'+paths+'</svg>'; }
  });

  const windowPaths = {
    maximize:'M3 3h10v10H3zM3 5h10',
    restore:'M6 3h7v7M3 6h7v7H3z',
    minimize:'M3 11h10',
    close:'M4 4l8 8M12 4l-8 8'
  };
  const svgIcon = path => '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="'+path+'"/></svg>';
  function paintWindowButton(button, kind, label) {
    button.classList.add('gd-window-button');
    button.setAttribute('aria-label',label); button.setAttribute('data-tip',label);
    if (button.dataset.glyph !== kind) { button.innerHTML=svgIcon(windowPaths[kind]);button.dataset.glyph=kind; }
  }
  const menuPaths = {
    agents:'M5 2h6v5H5zM3 14v-4h10v4',
    recruit:'M3 3h4v4H3zM1 14v-4h8v4M12 4v6M9 7h6',
    commander:'M4 3h8v10H4zM6 6h4M6 9h4',
    tasks:'M2 3h4v4H2zM8 5h6M2 10h4v4H2zM8 12h6',
    deliverables:'M2 5h12v9H2zM2 5l3-3h6l3 3M6 8h4',
    recipes:'M3 2h10v12H3zM6 5h4M6 8h4M6 11h2',
    automation:'M3 6V3h10v4M11 5l2 2 2-2M13 10v3H3V9M1 11l2-2 2 2',
    quests:'M4 14V2h8l-2 3 2 3H4',
    refit:'M2 3h12v10H2zM7 3v10M7 8h7',
    connectors:'M3 2v4M7 2v4M2 6h6v4H2zM5 10v3h8V9',
    messaging:'M2 3h12v9H7l-3 2v-2H2zM5 6h6M5 9h4',
    manual:'M8 4L2 2v10l6 2 6-2V2zM8 4v10',
    settings:'M2 4h12M2 8h12M2 12h12M5 2v4M11 6v4M7 10v4',
    updates:'M8 12V2M4 6l4-4 4 4M2 11v3h12v-3',
    notifs:'M5 3h6v7l2 2H3l2-2zM7 14h2'
  };
  document.querySelectorAll('#bottombar .bb-menu .bb').forEach(button=>{
    const key=button.dataset.term || ({'bb-recruit':'recruit','bb-missions':'recipes','bb-build':'refit'})[button.id];
    const icon=button.querySelector('.bb-i');
    if(icon && menuPaths[key]){icon.setAttribute('aria-hidden','true');icon.innerHTML=svgIcon(menuPaths[key]);}
  });

  const states = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // Exactly one compositor animation owns a sheet. Superseded exits must never hide a restored window.
  function cancelMotion(w, s) {
    if (s.motion) { s.motion.onfinish = null; s.motion.cancel(); s.motion = null; }
    w.style.willChange = '';
  }
  function moveSheet(w, s, showing, done = () => {}) {
    const current = s.motion ? getComputedStyle(w) : null;
    const from = current
      ? {translate:current.translate, opacity:current.opacity}
      : {translate:showing ? '0 64px' : '0 0', opacity:showing ? 0 : 1};
    cancelMotion(w,s);
    s.exiting = !showing;
    w.inert = !showing;
    if (showing) seat(w,s);
    if (reducedMotion.matches) { done(); return; }
    const style = getComputedStyle(w);
    const duration = parseFloat(style.getPropertyValue('--t-med')) || 220;
    w.style.willChange = 'translate, opacity';
    const animation = w.animate([from, {translate:showing ? '0 0' : '0 64px', opacity:showing ? 1 : 0}], {
      duration, easing:style.getPropertyValue(showing ? '--ease-out' : '--ease-soft').trim() || 'ease-out', fill:'both'
    });
    s.motion = animation;
    animation.onfinish = () => {
      if (s.motion !== animation) return;
      s.motion = null;
      w.style.willChange = '';
      // Hide/remove before releasing the transparent frame, so there is no one-frame flash.
      done();
      animation.cancel();
    };
  }
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) states.forEach(s => { if (s.motion) s.motion.finish(); });
  });
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
  function seat(w, s, animate = false, measuredBand) {
    if (!w.isConnected || w._closing || s.exiting || w.classList.contains('term-min-hidden') || !s.docked) return;
    const b = measuredBand || band(), available = Math.max(160,b.bottom-b.top);
    // Catalogs need room below their search/category controls on first open.
    // An explicit drag/keyboard height still wins, exactly as for every other sheet.
    const catalog = w.classList.contains('mkt-window') && w.querySelector('.mkt-stage');
    const preferred = catalog ? Math.max(available * .75, w.offsetHeight - catalog.offsetHeight + 260) : available * .56;
    const h = s.expanded ? available : Math.min(available, Math.max(220, s.height || preferred));
    w.style.animation = 'none'; w.style.transform = 'none';
    const geometry = {left:b.x+'px',top:(b.bottom-h)+'px',width:b.width+'px',height:h+'px',maxWidth:b.width+'px',maxHeight:available+'px'};
    Object.entries(geometry).forEach(([key,value]) => { if(w.style[key] !== value) w.style[key] = value; });
    w.classList.add('term-moved','gd-docked');
    paintWindowButton(s.expand, s.expanded ? 'restore' : 'maximize', s.expanded ? 'Restore window size' : 'Maximize window');
    s.expand.setAttribute('aria-expanded',String(s.expanded));
    s.dock.hidden = true;
    if (animate) moveSheet(w,s,true);
  }
  function attach(w) {
    if (states.has(w) || w.classList.contains('pw')) return;
    const head = w.querySelector('.term-head'); if (!head) return;
    const saved = w._readDockState ? w._readDockState() : {};
    const s = {docked:true,expanded:saved.expanded === true,height:Number.isFinite(saved.height) && saved.height > 0 ? saved.height : null}; states.set(w,s);
    const remember = () => { if (w._saveDockState) w._saveDockState(s); };
    w.classList.add('gd-sheet');
    w._fitDockedSheet = () => { if (!s.docked) return false; seat(w,s); return true; };
    w._animateSheet = (phase, done) => moveSheet(w,s,phase === 'restore',done);
    const controls = document.createElement('span'); controls.className = 'gd-controls';
    const button = (label, action) => {
      const b = document.createElement('button'); b.type='button'; b.textContent=label;
      b.addEventListener('mousedown', e=>e.stopPropagation());
      b.addEventListener('dblclick', e=>e.stopPropagation());
      b.addEventListener('click',e=>{e.stopPropagation();action();}); controls.append(b); return b;
    };
    s.dock = button('DOCK',()=>{s.docked=true;s.expanded=false;seat(w,s,true);remember();});
    paintWindowButton(button('MINIMIZE',()=>w._minimize()),'minimize','Minimize window');
    s.expand = button('EXPAND',()=>{
      if (!s.docked) s.docked=true;
      s.expanded=!s.expanded;seat(w,s);remember();
    });
    const close=head.querySelector('.term-x');
    if(close){
      paintWindowButton(close,'close',close.getAttribute('aria-label') || 'Close window');
      close.addEventListener('mousedown',e=>e.stopPropagation());
      close.addEventListener('dblclick',e=>e.stopPropagation());
    }
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
      e.preventDefault();e.stopPropagation();cancelMotion(w,s);s.docked=true;s.expanded=false;
      drag={y:e.clientY,h:w.getBoundingClientRect().height/zoom()};pull.setPointerCapture(e.pointerId);
    });
    pull.addEventListener('pointermove',e=>{
      if(!drag)return;s.height=drag.h+(drag.y-e.clientY)/zoom();seat(w,s);
    });
    const finish=()=>{if(drag)remember();drag=null;};pull.addEventListener('pointerup',finish);pull.addEventListener('pointercancel',finish);
    pull.addEventListener('keydown',e=>{
      if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
      e.preventDefault();e.stopPropagation();s.docked=true;
      if(e.key==='Home'){s.expanded=false;s.height=220;}
      else if(e.key==='End'){s.expanded=true;}
      else {s.expanded=false;s.height=w.getBoundingClientRect().height/zoom()+(e.key==='ArrowUp'?40:-40);}
      seat(w,s);remember();
    });
    head.addEventListener('mousedown',e=>{
      if(e.target.closest('button'))return;
      // Bake a partially entered sheet's visual position before the shared drag handler reads it.
      if(s.motion) {
        const r = w.getBoundingClientRect(), z = zoom();
        cancelMotion(w,s);w.style.left=r.left/z+'px';w.style.top=r.top/z+'px';
      }
      const startX=e.clientX, startY=e.clientY;
      let moved=false;
      const move=ev=>{
        if(moved || Math.hypot(ev.clientX-startX,ev.clientY-startY)<4)return;
        moved=true;s.docked=false;s.expanded=false;s.dock.hidden=false;paintWindowButton(s.expand,'maximize','Maximize window');
        s.expand.setAttribute('aria-expanded','false');w.classList.remove('gd-docked');
        w.style.maxWidth='calc(100vw * var(--sn-unzoom,1) - 24px)';
      };
      window.addEventListener('mousemove',move);
      window.addEventListener('mouseup',()=>{
        window.removeEventListener('mousemove',move);
        if(!moved){w._lastDragMoved=false;seat(w,s);}
      },{once:true});
    },true);
    // Mutation delivery happens before paint: no centered CRT frame before docking.
    seat(w,s,true);
  }
  const host=document.querySelector('#terms'); if(!host)return;
  const update=()=>{
    states.forEach((s,w)=>{if(!w.isConnected){cancelMotion(w,s);states.delete(w);}});
    host.querySelectorAll('.term').forEach(w=>{if(!states.has(w))attach(w);});
  };
  new MutationObserver(update).observe(host,{childList:true});
  let layoutFrame = 0;
  const queueLayout = () => {
    if(layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      const b = band();
      states.forEach((s,w)=>seat(w,s,false,b));
    });
  };
  const layout=new ResizeObserver(queueLayout);
  ['#topbar','#bottombar','#left','#chat-panel'].forEach(sel=>{const el=document.querySelector(sel);if(el)layout.observe(el);});
  window.addEventListener('resize',queueLayout);
  update();
})();
