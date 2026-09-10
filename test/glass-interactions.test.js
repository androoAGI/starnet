/* Motion lifecycle regression: exercise the demo's actual animation controller with a controlled clock. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync('frontend/app/glass-demo.js','utf8');
const start = src.indexOf('  function cancelMotion(');
const end = src.indexOf("  reducedMotion.addEventListener(",start);
assert(start >= 0 && end > start);
let reduced = false, seats = 0, animations = [], events = [], completed = [];
const context = {
  reducedMotion: { get matches(){return reduced;} },
  getComputedStyle: w => ({translate:w.visual.translate, opacity:w.visual.opacity,
    getPropertyValue: key => key === '--t-med' ? '220ms' : 'cubic-bezier(0.4, 0, 0.2, 1)'}),
  seat: () => { seats++; }
};
vm.createContext(context);
vm.runInContext(src.slice(start,end),context);
function windowStub(){
  return {style:{}, inert:false, visual:{translate:'0px 21px',opacity:'.65'},
    animate(frames,options){
      const animation={frames,options,cancelled:false,onfinish:null,
        cancel(){this.cancelled=true;events.push('cancel');}};
      animations.push(animation);
      return animation;
    }};
}
const w=windowStub(), s={};
// Close during entrance continues from its current rendered state and cannot finish the old entrance.
context.moveSheet(w,s,true,()=>completed.push('open'));
const entrance=s.motion, staleEntrance=entrance.onfinish;
context.moveSheet(w,s,false,()=>completed.push('close'));
assert.equal(entrance.cancelled,true);
assert.equal(s.motion.frames[0].translate,'0px 21px');
assert.equal(s.motion.frames[0].opacity,'.65');
staleEntrance();
assert.deepEqual(completed,[]);
assert.equal(w.inert,true);
// Restore before minimize completes, then minimize again. No earlier completion may hide the current window.
const firstExit=s.motion, staleExit=firstExit.onfinish;
context.moveSheet(w,s,true,()=>completed.push('restore'));
assert.equal(w.inert,false);
assert.equal(s.exiting,false);
const restore=s.motion, staleRestore=restore.onfinish;
context.moveSheet(w,s,false,()=>{events.push('hide');completed.push('minimize');});
staleExit(); staleRestore();
assert.deepEqual(completed,[]);
assert.equal(firstExit.cancelled,true);
assert.equal(restore.cancelled,true);
const latest=s.motion;
events=[];
latest.onfinish();
assert.deepEqual(events,['hide','cancel']);
assert.deepEqual(completed,['minimize']);
assert.equal(s.motion,null);
assert.equal(w.style.willChange,'');
latest.onfinish();
assert.deepEqual(completed,['minimize']);
// Reduced motion settles immediately without leaving an animation or blocking restore interaction.
reduced=true;
const count=animations.length;
context.moveSheet(w,s,true,()=>completed.push('reduced restore'));
context.moveSheet(w,s,false,()=>completed.push('reduced close'));
assert.equal(animations.length,count);
assert.deepEqual(completed,['minimize','reduced restore','reduced close']);
assert.equal(s.motion,null);
assert.equal(w.style.willChange,'');
assert.equal(seats,3);
// Closing, minimizing, and detached sheets cannot be moved by resize/layout observers.
const seatStart=src.indexOf('  function seat('), seatEnd=src.indexOf('  function attach(',seatStart);
let reads=0;
const layoutContext={band:()=>{reads++;throw Error('exiting sheet was remeasured');}};
vm.createContext(layoutContext);
vm.runInContext(src.slice(seatStart,seatEnd),layoutContext);
layoutContext.seat({isConnected:true,_closing:true},{docked:true});
layoutContext.seat({isConnected:true},{docked:true,exiting:true});
layoutContext.seat({isConnected:false},{docked:true});
assert.equal(reads,0);
console.log('glass-motion: interrupted close, rapid restore/minimize, completion order, reduced motion, and exit layout guards passed');

// Re-minimizing during the dock chip's exit must leave an enabled replacement.
const stationSrc=fs.readFileSync('frontend/app/stationui.js','utf8');
const chipStart=stationSrc.indexOf('  function addChip('),chipEnd=stationSrc.indexOf('  function isMinimized(',chipStart);
const chips=[],timers=[];
function chipStub(){
  const classes=new Set(['term-chip']);
  return {dataset:{},disabled:false,isConnected:true,offsetWidth:50,
    classList:{add:(...a)=>a.forEach(v=>classes.add(v)),remove:(...a)=>a.forEach(v=>classes.delete(v)),contains:v=>classes.has(v)},
    setAttribute(){},addEventListener(){},
    remove(){this.isConnected=false;const i=chips.indexOf(this);if(i>=0)chips.splice(i,1);}
  };
}
const strip={querySelector:()=>chips[0],appendChild:c=>chips.push(c)};
const chipContext={ensureStrip:()=>strip,termStrip:()=>strip,chipTitle:()=> 'SETTINGS',
  CSS:{escape:v=>v},mkEl:chipStub,esc:v=>v,syncStripVisibility(){},setTimeout:f=>timers.push(f)};
vm.createContext(chipContext);vm.runInContext(stationSrc.slice(chipStart,chipEnd),chipContext);
chipContext.addChip('settings');
chipContext.removeChip('settings');
chipContext.addChip('settings');
assert.equal(chips.length,1);
assert.equal(chips[0].disabled,false,'rapid re-minimize must not reuse a disabled departing chip');
timers.forEach(f=>f());
assert.equal(chips.length,1,'the old removal callback must not remove the new chip');
console.log('glass-motion: rapid dock-chip replacement passed');


// Escape leaves a field without losing the dialog's keyboard boundary or its draft.
const keyStart=stationSrc.indexOf("    w.addEventListener('keydown', ev => {");
const keyEnd=stationSrc.indexOf('    /* BACKGROUND-POKE FORM PRESERVATION',keyStart);
assert(keyStart >= 0 && keyEnd > keyStart);
let keyHandler, closeRequests=0;
const field={value:'unsaved draft',matches:()=>true};
const doc={activeElement:field};
const dialog={
  addEventListener:(type,handler)=>{assert.equal(type,'keydown');keyHandler=handler;},
  contains:el=>el===field || el===dialog,
  focus:()=>{doc.activeElement=dialog;},
  matches:()=>false
};
vm.runInNewContext(stationSrc.slice(keyStart,keyEnd),{w:dialog,document:doc,key:'settings',
  requestCloseTerm:()=>{closeRequests++;},termFocusables:()=>[]});
const escape=()=>keyHandler({key:'Escape',preventDefault(){},stopPropagation(){}});
escape();
assert.equal(doc.activeElement,dialog,'first Escape keeps focus inside the live dialog');
assert.equal(field.value,'unsaved draft');
assert.equal(closeRequests,0,'first Escape cannot discard a field draft');
escape();
assert.equal(closeRequests,1,'second Escape reaches the existing guarded close action');

// The actual early boot script enables glass by default and honors the diagnostic fallback.
const boot=fs.readFileSync('frontend/app/glass-boot.js','utf8');
for(const [search,expected] of [['',true],['?glass=1',true],['?glass=0',false],['?room=1',true]]) {
  let enabled;
  vm.runInNewContext(boot,{URLSearchParams,location:{search},document:{body:{classList:{
    toggle:(name,value)=>{assert.equal(name,'glass-demo');enabled=value;}
  }}}});
  assert.equal(enabled,expected,search || 'ordinary station URL');
}
const html=fs.readFileSync('frontend/index.html','utf8');
assert(html.indexOf('css/glass-demo.css') < html.indexOf('</head>'));
assert(html.indexOf('css/glass-comms.css') < html.indexOf('</head>'));
assert(html.includes('<body class="theme-amber glass-demo">'),'default glass precedes first paint');
assert(html.indexOf('app/glass-boot.js') > html.indexOf('app/bootguard.js'),'boot diagnostics are installed before any other script');
assert(html.indexOf('app/glass-boot.js') < html.indexOf('app/app.js'),'fallback resolves before the station initializes');
assert(!src.includes('document.head.append(css)'),'material sheets cannot arrive after interface initialization');
assert(!src.includes("badge.textContent = 'GLASS DEMO'"),'default UI does not claim to be a preview');
console.log('glass-interactions: guarded Escape, default activation, fallback, and initial material load passed');

// Recreate a window and the settings store to exercise persisted normal/maximized state.
const preferenceStart = stationSrc.indexOf('    w._readDockState =');
const preferenceEnd = stationSrc.indexOf('    w._minimize =', preferenceStart);
assert(preferenceStart >= 0 && preferenceEnd > preferenceStart);
let savedPreferences = {};
function reopenDock(key) {
  const context = { w: {}, key, store: JSON.parse(JSON.stringify(savedPreferences)),
    save() { savedPreferences = JSON.parse(JSON.stringify(context.store)); } };
  vm.createContext(context); vm.runInContext(stationSrc.slice(preferenceStart, preferenceEnd), context);
  return context.w;
}
let settingsWindow = reopenDock('settings');
settingsWindow._saveDockState({ height: 512, expanded: false });
settingsWindow = reopenDock('settings');
assert.equal(settingsWindow._readDockState().height, 512);
settingsWindow._saveDockState({ height: 512, expanded: true });
settingsWindow = reopenDock('settings');
assert.equal(settingsWindow._readDockState().height, 512);
assert.equal(settingsWindow._readDockState().expanded, true);
assert.equal(reopenDock('tasks')._readDockState().height, undefined);
settingsWindow._saveDockState({ height: Infinity, expanded: false });
assert.equal(reopenDock('settings')._readDockState().height, null);
console.log('glass preferences: normal height, maximized state, panel isolation and invalid-size recovery passed');
