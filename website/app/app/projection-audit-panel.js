/* Local, explicitly requested visual diagnostics. Does not alter simulation. */
'use strict';
(async()=>{
 if(!['127.0.0.1','localhost'].includes(location.hostname)||new URLSearchParams(location.search).get('visualAudit')!=='1')return;
 const start=performance.now();
 await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);
 const panel=document.createElement('aside');panel.id='projection-audit';panel.setAttribute('aria-label','Projection verification');
 panel.style.cssText='position:fixed;z-index:999999;right:12px;bottom:44px;max-width:360px;padding:12px;background:#091214ef;border:1px solid #746546;color:#d7c89d;font:12px VT323, monospace';
 const report=document.createElement('output'),button=document.createElement('button');
 button.textContent='Measure frame cadence';button.className='bb';button.style.cssText='background:#172124;color:#ded5b6;border:1px solid #746546;padding:6px;margin-top:8px';
 const status=PropRemaster.status();
 const receipt={views:status.views.length,failures:status.failures,propCachePixels:status.pixels,propCacheMiB:+(status.pixels*4/1048576).toFixed(2),propCacheBudgetMiB:48,readyAfterMs:Math.round(performance.now()-start)};
 function render(){report.textContent=JSON.stringify(receipt,null,2);report.style.whiteSpace='pre-wrap';panel.dataset.receipt=JSON.stringify(receipt);}
 button.onclick=()=>{
  button.disabled=true;button.textContent='Measuring…';const samples=[];let previous=null;const begun=performance.now();let cancelled=false;
  function visibility(){if(document.hidden)cancelled=true;}document.addEventListener('visibilitychange',visibility);
  function frame(now){
   if(previous!==null)samples.push(now-previous);previous=now;
   if(samples.length<180&&now-begun<12000){requestAnimationFrame(frame);return;}
   document.removeEventListener('visibilitychange',visibility);
   const sorted=samples.slice().sort((a,b)=>a-b),quantile=q=>+(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]||0).toFixed(2);
   receipt.cadence={samples:samples.length,medianMs:quantile(.5),p95Ms:quantile(.95),maxMs:quantile(1),hiddenDuringSample:cancelled,label:'Visible-tab rAF cadence; not a GPU benchmark'};
   render();button.disabled=false;button.textContent='Measure frame cadence';
  }requestAnimationFrame(frame);
 };
 panel.append(report,button);document.body.append(panel);render();
})().catch(e=>console.warn('Projection audit unavailable',e));
