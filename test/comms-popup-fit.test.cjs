'use strict';
/* COMMS popup FIT LAW (10-15, a user's shot: on a short COMMS the model picker ran up under the agent header and its
   + and globe painted through REASONING MAX). Runs glass-comms.js's real fitPopup against fake geometry. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const text=fs.readFileSync('frontend/app/glass-comms.js','utf8');
const start=text.indexOf('  const fitPanel='),end=text.indexOf('  function watchFit(',start);
assert(start>=0 && end>start,'glass-comms.js keeps the fit block');

const box=(top,bottom)=>({top,bottom,height:bottom-top});
function node(rect,extra={}) {
  return Object.assign({hidden:false,offsetHeight:rect.height,attrs:new Set(),vars:{},contains:()=>false,
    getBoundingClientRect:()=>rect,
    style:{setProperty(k,v){this.owner.vars[k]=v;}},
    toggleAttribute(name,on){if(on)this.attrs.add(name);else this.attrs.delete(name);},
    hasAttribute(name){return this.attrs.has(name);}},extra);
}
function station({rowTop,popup,drops=false}) {
  const panelClass=new Set();
  const panel=node(box(100,rowTop+120),{classList:{toggle:(c,on)=>{if(on)panelClass.add(c);else panelClass.delete(c);}}});
  const row=node(box(rowTop,rowTop+120)),topbar=node(box(0,40)),idbar=node(box(110,160));
  const pop=node(popup);pop.style.owner=pop;
  if(drops)idbar.contains=n=>n===pop;
  const nodes={'#chat-panel':panel,'#chat-inputrow':row,'#comms-idbar':idbar,'#topbar':topbar};
  const context={document:{querySelector:s=>nodes[s]||null},getComputedStyle:()=>({transform:'none'}),
    DOMMatrixReadOnly:class{},Math,Boolean};
  vm.createContext(context);vm.runInContext(text.slice(start,end)+';this.fitPopup=fitPopup;this.fitting=fitting;',context);
  context.fitting.add(pop);
  return {fit:()=>context.fitPopup(pop),pop,panelClass};
}

// Room enough: the riser is capped to the space between the header (bottom 160) and its own bottom edge.
let s=station({rowTop:600,popup:box(200,592)});s.fit();
assert.equal(s.pop.vars['--comms-fit'],'426px','picker max-height = room under the agent header');
assert(!s.pop.hasAttribute('data-fit-over')&&!s.panelClass.has('comms-pop-over'),'a fitting picker never lifts over the header');

// A slit (room < 220): the riser covers the header cleanly — up to the top bar, its row lifted above the header.
s=station({rowTop:330,popup:box(200,322)});s.fit();
assert.equal(s.pop.vars['--comms-fit'],'270px','tight picker rises to the top bar (322-40-6-6)');
assert(s.pop.hasAttribute('data-fit-over')&&s.panelClass.has('comms-pop-over'),'tight picker paints ABOVE the header, never under it');
s.pop.hidden=true;s.fit();
assert(!s.panelClass.has('comms-pop-over'),'closing the picker drops the lift');

// The agent menu drops DOWN from the header: capped to the composer's top edge.
s=station({rowTop:600,popup:box(165,300),drops:true});s.fit();
assert.equal(s.pop.vars['--comms-fit'],'429px','agent menu stops at the composer');
assert(!s.panelClass.has('comms-pop-over'),'the agent menu never lifts the composer row');

// Every popup's max-height reads the measured room, and the picker scrolls inside it.
const app=fs.readFileSync('frontend/css/app.css','utf8'),glass=fs.readFileSync('frontend/css/glass-comms.css','utf8');
assert.match(app,/\.model-dock \{[^}]*max-height: min\(70vh, 414px, var\(--comms-fit[^}]*overflow-y: auto/,'base picker');
assert.match(app,/\.chat-slash \{[^}]*max-height: min\(244px, var\(--comms-fit/,'slash palette');
assert.match(glass,/body\.glass-demo #model-dock \{[^}]*max-height: min\(65vh,480px,var\(--comms-fit[^}]*background: var\(--gd-pop\)/,'glass picker: fitted + opaque');
assert.match(glass,/\.gd-agent-menu \{[^}]*max-height: min\(260px,var\(--comms-fit/,'agent menu');
assert.match(glass,/#chat-panel\.comms-pop-over #chat-inputrow \{ z-index: 7; \}/,'lifted row clears the header z 6');
/* WIDTH (11-18, a user's shot: with COMMS dragged narrow the picker hung out of its left edge, under the seam, its labels
   cut). COMMS goes down to 300px (chatresize.js MIN) and both picker widths are fixed, so the base rule caps the picker at
   the composer it rises from, and no later rule may lift that cap. The footer wraps instead of pushing a key out. */
const resize=fs.readFileSync('frontend/app/chatresize.js','utf8');
const commsMin=Number((resize.match(/\bMIN = (\d+)\b/)||[])[1]);
assert(commsMin>0,'chatresize.js names the narrowest COMMS');
const widths=[app.match(/\.model-dock \{[^}]*?\bwidth: min\((\d+)px/),glass.match(/body\.glass-demo #model-dock \{[^}]*?\bwidth: min\((\d+)px/)].map(m=>Number(m&&m[1]));
assert(widths.every(w=>w>0),'both picker widths are still fixed px widths (if not, re-think this pin)');
assert(widths.some(w=>w>commsMin-16),'the pin is live: a picker width is wider than the narrowest COMMS allows');
assert.match(app,/\.model-dock \{[^}]*max-width: calc\(100% - 16px\);/,'the picker is never wider than its composer');
for(const f of fs.readdirSync('frontend/css').filter(n=>n.endsWith('.css'))){
  const css=fs.readFileSync('frontend/css/'+f,'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  for(const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)){
    if(!/(#model-dock|\.model-dock)(?![\w-])\s*(,|$)/.test(m[1].trim().split(',').map(s=>s.trim()).filter(s=>/(#model-dock|\.model-dock)$/.test(s)).join(',')))continue;
    const mw=m[2].match(/(?:^|[;\s])max-width:\s*([^;]+)/);
    if(mw)assert.equal(mw[1].trim(),'calc(100% - 16px)',f+': no rule may lift the picker\'s width cap ('+m[1].trim().slice(0,60)+')');
  }
}
assert.match(glass,/body\.glass-demo #model-dock \.model-dock-foot \{ display: flex; flex-wrap: wrap;/,'the picker footer wraps in a narrow COMMS');
assert.doesNotMatch(app,/\.model-dock \{ position: fixed/,'a fixed picker resolves against the blurred panel, not the composer');
console.log('comms-popup-fit: popups fit under the header, a tight riser covers it cleanly, menu stops at the composer');
