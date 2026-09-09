/* Progressive COMMS chrome for ?glass=1. The real controls keep owning roster, send and voice state. */
(() => {
  'use strict';
  if (!document.body.classList.contains('glass-demo')) return;
  const paths = {
    send:'M2 8h11M9 4l4 4-4 4',
    mic:'M6 2h4v7H6zM3 7v2a5 5 0 0 0 10 0V7M8 14v1M5 15h6',
    live:'M2 6v4M5 3v10M8 5v6M11 2v12M14 6v4',
    on:'M2 6h3l3-3v10l-3-3H2zM11 5v6M14 3v10',
    off:'M2 6h3l3-3v10l-3-3H2zM11 6l4 4M15 6l-4 4',
    chevron:'M4 6l4 4 4-4'
  };
  function icon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 16 16'); svg.setAttribute('aria-hidden','true');
    svg.setAttribute('focusable','false'); svg.setAttribute('fill','none');
    svg.setAttribute('stroke','currentColor'); svg.setAttribute('stroke-width','1.4');
    svg.dataset.gdIcon=kind;
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[kind]);svg.append(path);return svg;
  }
  function paint(button, kind) {
    if(!button || button.querySelector('svg')?.dataset.gdIcon === kind) return;
    const old=button.querySelector('svg'); if(old)old.replaceWith(icon(kind));else button.prepend(icon(kind));
  }
  paint(document.querySelector('#chat-send'),'send');
  paint(document.querySelector('#chat-mic'),'mic');
  paint(document.querySelector('#voice-live'),'live');
  const voice=document.querySelector('#voice-toggle');
  if(voice) {
    const sync=()=>paint(voice,voice.classList.contains('off')?'off':'on');
    new MutationObserver(sync).observe(voice,{attributes:true,attributeFilter:['class'],childList:true});
    sync();
  }
  const input=document.querySelector('#chat-input');
  if(input)input.placeholder='Message \u00b7 / commands';
  // Hidden popups become non-interactive immediately while their final frame fades out.
  ['#model-dock','#chat-slash'].forEach(selector=>{
    const popup=document.querySelector(selector);if(!popup)return;
    const sync=()=>{popup.inert=popup.hidden;};
    new MutationObserver(sync).observe(popup,{attributes:true,attributeFilter:['hidden']});sync();
  });
  // Return keyboard focus before the original Escape handler hides the model picker.
  document.querySelector('#model-dock')?.addEventListener('keydown', e => {
    if(e.key==='Escape') document.querySelector('#model-dock-toggle')?.focus();
  });
  // Mirror the existing roster select; changing an option uses its original change handler.
  const source=document.querySelector('#comms-agent-select');
  if(!source)return;
  const wrap=source.closest('.comms-agent-wrap'),bar=document.querySelector('#comms-idbar');
  const button=document.createElement('button');button.type='button';button.className='gd-agent-toggle';
  button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
  button.setAttribute('aria-controls','gd-agent-menu');
  const label=document.createElement('span');button.append(label,icon('chevron'));
  const menu=document.createElement('div');menu.id='gd-agent-menu';menu.className='gd-agent-menu';menu.hidden=true;menu.inert=true;
  menu.setAttribute('role','listbox');menu.setAttribute('aria-label','Agents on the line');
  wrap.append(button);bar.append(menu);wrap.classList.add('gd-agent-enhanced');
  source.setAttribute('data-gd-agent-source','');source.setAttribute('aria-hidden','true');source.tabIndex=-1;
  function close(focus=false) {
    menu.hidden=true;menu.inert=true;button.setAttribute('aria-expanded','false');
    if(focus)button.focus();
  }
  function rows(){return Array.from(menu.querySelectorAll('button:not(:disabled)'));}
  function render() {
    const selected=source.options[source.selectedIndex];
    label.textContent=selected?.textContent || 'Select agent';
    button.setAttribute('aria-label','Select agent on the line: '+label.textContent);
    button.disabled=source.disabled || source.options.length===0;
    const focusValue=menu.contains(document.activeElement)?document.activeElement.dataset.value:null;
    menu.replaceChildren();
    Array.from(source.options).forEach(option=>{
      const row=document.createElement('button');row.type='button';row.className='gd-agent-option';
      row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.selected));
      row.textContent=option.textContent;row.dataset.value=option.value;row.disabled=option.disabled;
      row.addEventListener('click',()=>choose(option.value));
      menu.append(row);
    });
    if(focusValue && !menu.hidden) rows().find(row=>row.dataset.value===focusValue)?.focus();
    if(button.disabled)close();
  }
  function choose(value) {
    // Native selects do not emit change for the already-selected item.
    if(source.value !== value) {
      source.value=value;
      source.dispatchEvent(new Event('change',{bubbles:true}));
    }
    close(true);render();
  }
  function open(last=false) {
    render();if(button.disabled)return;
    menu.hidden=false;menu.inert=false;button.setAttribute('aria-expanded','true');
    const items=rows();
    (last?items.at(-1):items.find(row=>row.getAttribute('aria-selected')==='true')||items[0])?.focus();
  }
  button.addEventListener('click',()=>{if(menu.hidden)open();else close();});
  button.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();open(e.key==='ArrowUp');}
    else if(e.key==='Escape'){e.preventDefault();close();}
  });
  menu.addEventListener('keydown',e=>{
    const items=rows(),i=items.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
      e.preventDefault();
      const next=e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items[next]?.focus();
    } else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}
    else if(e.key==='Tab')close(true);
  });
  document.addEventListener('click',e=>{if(!menu.contains(e.target)&&!button.contains(e.target))close();});
  window.addEventListener('resize',()=>close());
  source.addEventListener('change',render);
  new MutationObserver(render).observe(source,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','label','value']});
  render();
})();
