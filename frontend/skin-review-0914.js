'use strict';
const studies = [
  ['android','blank','Default android','Ivory ceramic over graphite joints. A compact head and clearer limb construction.'],
  ['astronaut','astronaut','Astronaut','Burnt-orange pressure fabric, smoked glass and a more practical suit silhouette.'],
  ['robot','robot','Robot','Brushed metal, recessed optics and articulated machinery with less toy-like bulk.'],
  ['crthead','crthead','CRT-head','A smaller phosphor monitor over navy workwear; familiar character, more station hardware.'],
  ['alien','alien','Alien','Muted sage skin and a fitted utility suit, with a more restrained head-to-body ratio.']
];
const grid = document.getElementById('grid');
studies.forEach(([id,old,name,note],i) => {
  const card = document.createElement('article');
  card.innerHTML = `<div class="name"><div class="num">0${i+1}</div><h2>${name}</h2></div><div class="pair"><div class="sprite"><img data-old="${old}" alt="Current ${name}" src="assets/sprites/${old}/rot_south.png"><span class="caption">CURRENT</span></div><div class="sprite"><img data-new="${id}" alt="Proposed ${name}" src="assets/skin-study-0914/${id}/south.png"><span class="caption">PROPOSED</span></div></div><div class="note">${note}</div><div class="scale"><img data-new="${id}" alt="${name} at 48 pixels" src="assets/skin-study-0914/${id}/south.png"><span>48PX CANVAS<br>SIZE STUDY</span></div>`;
  grid.appendChild(card);
});
// Compare actual silhouettes at equal height; generated files have different padding.
document.querySelectorAll('img').forEach(im => {
  const frame = document.createElement('span');
  const height = im.closest('.scale') ? 48 : 112;
  Object.assign(frame.style,{position:'relative',display:'block',height:`${height}px`,width:im.closest('.scale')?'48px':'100%',flexShrink:'0',overflow:'hidden'});
  im.before(frame); frame.appendChild(im);
  const fit = () => {
    const canvas = document.createElement('canvas');
    canvas.width=im.naturalWidth; canvas.height=im.naturalHeight;
    const ctx=canvas.getContext('2d'); ctx.drawImage(im,0,0);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let left=canvas.width,right=0,top=canvas.height,bottom=0;
    for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
      if(pixels[(y*canvas.width+x)*4+3]>0){left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1);}
    }
    if(bottom<=top)return;
    const scale=height/(bottom-top);
    Object.assign(im.style,{position:'absolute',maxWidth:'none',width:`${canvas.width*scale}px`,height:`${canvas.height*scale}px`,left:`calc(50% - ${(left+right)/2*scale}px)`,top:`${-top*scale}px`});
  };
  im.addEventListener('load',fit); if(im.complete&&im.naturalWidth)fit();
});
document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => {
  const direction = button.dataset.dir;
  document.querySelectorAll('[data-dir]').forEach(b => b.setAttribute('aria-pressed',String(b === button)));
  document.querySelectorAll('[data-old]').forEach(im => { im.src = `assets/sprites/${im.dataset.old}/rot_${direction}.png`; });
  document.querySelectorAll('[data-new]').forEach(im => { im.src = `assets/skin-study-0914/${im.dataset.new}/${direction}.png`; });
}));
document.getElementById('light').addEventListener('click', event => {
  event.currentTarget.setAttribute('aria-pressed',String(document.body.classList.toggle('light')));
});
