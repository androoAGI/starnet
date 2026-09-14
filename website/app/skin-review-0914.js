'use strict';
const studies = [
  ['android','blank','Cadet / Android','Ivory ceramic over graphite joints. A compact head and clearer limb construction.'],
  ['astronaut','astronaut','Astronaut','Burnt-orange pressure fabric, smoked glass and a more practical suit silhouette.'],
  ['robot','robot','Robot','Brushed metal, recessed optics and articulated machinery with less toy-like bulk.'],
  ['crthead','crthead','CRT-head','A smaller phosphor monitor over navy workwear; familiar character, more station hardware.'],
  ['alien','alien','Alien','Muted sage skin and a fitted utility suit, with a more restrained head-to-body ratio.'],
  ['ultron','ultron','Ultron Overseer','Layered charcoal titanium and restrained red optics. A leaner, articulated armor silhouette.'],
  ['skeleton','skeleton','Skeleton','Aged ivory bone, a smaller skull and a more natural rib cage, pelvis and limb structure.'],
  ['plaguedoctor','plaguedoctor','Plague Doctor','Weathered leather and heavy cloth, with a compact beaked respirator for the quarantine deck.'],
  ['secretagent','secretagent','Secret Agent','Tailored charcoal wool, restrained proportions and clean tailoring. Sunglasses stay.'],
  ['voidwizard','voidwizard','Void Wizard','Muted aubergine robes, bronze fastenings and weighted folds beneath the familiar pointed hat.'],
  ['xenomorph','xenomorph','Xenomorph','Glossy carapace over matte biomechanical ribs, with a longer dome and a readable tail.'],
  ['robocop','robocop','Robocop','Brushed silver-blue armor, a narrow visor and more believable articulated joints.'],
  ['masterchief','masterchief','Master Chief','Worn olive armor over a graphite undersuit, retaining the distinctive gold visor.'],
  ['grimreaper','grimreaper','Grim Reaper','Heavy charcoal robes, aged bone and a weathered steel scythe. More cloth weight, less caricature.'],
  ['crewmate','crewmate','Crewmate','Red pressure fabric and curved cyan glass, with practical limbs and a compact life-support pack.'],
  ["bear","bear","Teddy Bear","Worn plush, stitched seams and more believable paws beneath the familiar teddy silhouette."],
  ["pepe","pepe","Pepe","Muted amphibian skin and worn blue knitwear, with a more grounded frog face."],
  ["capybara","capybara","Capybara","Coarse brown fur, a blunt muzzle and compact paws that retain the capybara shape."],
  ["vaultboy","vaultboy","Vault Boy","Blue-and-yellow workwear, swept blond hair and natural human proportions."],
  ["station_minion","station_minion","Station Minion","Graphite and bronze work plating with compact cyan optics and practical joints."],
  ["blank_blue","blank_blue","Blue Cadet","Cobalt ceramic over graphite articulation; a cooler Cadet variant."],
  ["blank_green","blank_green","Green Cadet","Sage ceramic shell with restrained highlights and exposed dark joints."],
  ["blank_red","blank_red","Red Cadet","Oxide-red plating, a compact visor and cleaner mechanical proportions."],
  ["blank_amber","blank_amber","Amber Cadet","Ochre ceramic, worn edges and natural limb proportions."],
  ["heisenberg","heisenberg","Heisenberg","Tan utility tailoring, dark glasses and the familiar porkpie hat and goatee."],
  ["endoskeleton","endoskeleton","Endoskeleton","Exposed steel ribs and pistons, with a compact skull and recessed red optics."],
  ["ultrondroid","ultrondroid","Ultron Droid","A lean gunmetal droid with red optics and a recessed chest core."],
  ["samaltman","samaltman","Sam","A restrained civilian silhouette with realistic cotton folds and casual dark trousers."],
  ["dario","dario","Dario","Layered researcher clothing, natural proportions and understated tailoring."],
  ["freddyfazbear","freddyfazbear","Freddy","Aged plush over articulated animatronic joints, retaining the hat and bow tie."],
  ["ghostface","ghostface","Ghostface","Weighted black robes around the iconic ivory mask."],
  ["morpheus","morpheus","Morpheus","A long leather coat, subtle surface highlights and a composed human silhouette."],
  ["ricksanchez","ricksanchez","Rick","Worn lab cotton and spiky pale-blue hair with more natural anatomy."],
  ["ninjaturtle","ninjaturtle","Ninja Turtle","Reptile musculature, layered shell and worn red wraps."],
  ["minionchar","minionchar","Minion","Brushed-metal goggles, stitched denim and plausible compact limbs."],
  ["pikachu","pikachu","Pikachu","Short golden fur, species-shaped anatomy and the distinctive lightning tail."],
  ["caseyjones","caseyjones","Casey Jones","Scuffed hockey mask, rugged workwear and practical athletic proportions."],
  ["finn","finn","Finn","Stitched white hood, blue cotton and a canvas pack on a more natural frame."]
];
const grid = document.getElementById('grid');
studies.forEach(([id,old,name,note],i) => {
  const card = document.createElement('article');
  card.dataset.batch = i < 5 ? 'first' : i < 10 ? 'second' : i < 15 ? 'third' : 'new';
  card.innerHTML = `<div class="name"><div class="num">0${i+1}</div><h2>${name}</h2></div><div class="pair"><div class="sprite"><img data-old="${old}" alt="Current ${name}" src="assets/sprites/${old}/rot_south.png"><span class="caption">CURRENT</span></div><div class="sprite"><img data-new="${id}" alt="Proposed ${name}" src="assets/skin-study-0914/${id}/south.png"><span class="caption">PROPOSED</span></div></div><div class="note">${note}</div><div class="scale"><img data-new="${id}" alt="${name} at 48 pixels" src="assets/skin-study-0914/${id}/south.png"><span>48PX CANVAS<br>SIZE STUDY</span></div>`;
  grid.appendChild(card);
});
document.querySelectorAll('.num').forEach((number,i) => {number.textContent=String(i+1).padStart(2,'0');});
function showBatch(batch) {
  const query=document.getElementById('skin-search').value.trim().toLowerCase();
  document.querySelectorAll('[data-batch]').forEach(card => {card.hidden=(batch!=='all'&&card.dataset.batch!==batch)||!card.querySelector('h2').textContent.toLowerCase().includes(query);});
  document.querySelectorAll('[data-show]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.show===batch)));
  document.getElementById('shown-count').textContent=`${document.querySelectorAll('article:not([hidden])').length} / ${studies.length} skins shown`;
}
document.getElementById('skin-search').addEventListener('input',()=>showBatch('all'));
document.querySelectorAll('[data-show]').forEach(button => button.addEventListener('click',()=>showBatch(button.dataset.show)));
showBatch('new');
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
