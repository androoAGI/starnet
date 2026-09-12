/* Rehearsal scene only. The imported Arrival renderer is the production renderer. */
const cv=document.getElementById('scene'),ctx=cv.getContext('2d'),seek=document.getElementById('seek'),play=document.getElementById('play'),reduced=document.getElementById('reduce');
let elapsed=0,playing=false,last=0,raf=0,sound=false,audio=null,voices=[];
const images={};const stamp=document.createElement('canvas');stamp.width=128;stamp.height=128;
for(const dir of ['north','east','south']){const im=new Image();im.onload=render;im.src='/assets/sprites/minion/walk_'+dir+'_0.png';images[dir]=im;}
const phases=[['01 SIGNAL',0],['02 CONVERGENCE',3500],['03 EMBODIMENT',10500],['04 ARRIVAL',16000],['05 CONTACT',19000],['06 FIRST LIGHT',23000]];
const nav=document.getElementById('chapters');for(const [name,at]of phases){const b=document.createElement('button');b.textContent=name;b.onclick=()=>{playing=false;play.textContent='Play arrival';elapsed=at;stopAudio();render();};nav.appendChild(b);}
function stopAudio(){voices.forEach(n=>{try{n.stop()}catch{}});voices=[];}
function beginAudio(){stopAudio();if(!sound)return;audio=audio||new AudioContext();audio.resume();for(let i=0;i<3;i++){const o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.setValueAtTime([38,76,114][i],audio.currentTime);o.frequency.exponentialRampToValueAtTime([58,116,232][i],audio.currentTime+15);g.gain.setValueAtTime(0,audio.currentTime);g.gain.linearRampToValueAtTime(.028/(i+1),audio.currentTime+5);g.gain.linearRampToValueAtTime(.045/(i+1),audio.currentTime+15);g.gain.linearRampToValueAtTime(0,audio.currentTime+17.5);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+24);voices.push(o);}}
function resize(){cv.width=innerWidth;cv.height=innerHeight;render();}window.addEventListener('resize',resize);
function room(w,h,f){ctx.fillStyle='#050b12';ctx.fillRect(0,0,w,h);const x=w*.5,y=h*.54,s=Math.min(w/1000,h/760);ctx.save();ctx.translate(x,y);ctx.scale(s,s);
 const glow=ctx.createRadialGradient(0,0,20,0,0,550);glow.addColorStop(0,'#142633');glow.addColorStop(1,'#03080e');ctx.fillStyle=glow;ctx.fillRect(-600,-350,1200,700);
 ctx.strokeStyle='#233544';ctx.lineWidth=1;ctx.fillStyle='#0c1721';ctx.beginPath();ctx.moveTo(-470,-90);ctx.lineTo(0,-300);ctx.lineTo(470,-90);ctx.lineTo(0,170);ctx.closePath();ctx.fill();ctx.stroke();
 for(let i=0;i<17;i++){const a=i/16;ctx.beginPath();ctx.moveTo(-470+470*a,-90-210*a);ctx.lineTo(470*a,170-260*a);ctx.stroke();ctx.beginPath();ctx.moveTo(470-470*a,-90-210*a);ctx.lineTo(-470*a,170-260*a);ctx.stroke();}
 // Window banks, consoles, structural ribs, and floor-cable routes ground the abstract effect.
 for(const side of [-1,1])for(let i=0;i<5;i++){const px=side*(110+i*65),py=-230+i*29;ctx.fillStyle='#091019';ctx.fillRect(px-26,py-55,52,55);ctx.strokeStyle='#40505c';ctx.strokeRect(px-26,py-55,52,55);ctx.fillStyle='#132c3e';ctx.fillRect(px-21,py-48,42,31);ctx.fillStyle='#527485';for(let j=0;j<4;j++)ctx.fillRect(px-17,py-44+j*6,12+((i+j)%3)*8,1);ctx.fillStyle='#be9261';ctx.fillRect(px+12,py-8,4,2);}
 ctx.strokeStyle='#46535c';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-470,-90);ctx.lineTo(0,170);ctx.lineTo(470,-90);ctx.stroke();ctx.strokeStyle='#ac7c48';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(-463,-81);ctx.lineTo(0,179);ctx.lineTo(463,-81);ctx.stroke();
 ctx.restore();ctx.fillStyle=`rgba(1,4,9,${f.darkness*.75})`;ctx.fillRect(0,0,w,h);
 return{x,y:y+15*s,scale:2.6*s};}
function render(){if(!cv.width)return;const f=Arrival.frame(elapsed,false),loc=room(cv.width,cv.height,f);const im=images[f.t<18.5?'north':f.t<19.6?'east':'south'];const sc=stamp.getContext('2d');sc.clearRect(0,0,128,128);if(im&&im.complete&&im.naturalWidth){const ratio=Math.min(64/im.naturalWidth,80/im.naturalHeight);sc.drawImage(im,64-im.naturalWidth*ratio/2,100-im.naturalHeight*ratio,im.naturalWidth*ratio,im.naturalHeight*ratio);}
 if(f.body){ctx.save();ctx.globalAlpha=f.body;ctx.drawImage(stamp,loc.x-64*loc.scale,loc.y-100*loc.scale,128*loc.scale,128*loc.scale);ctx.restore();}
 Arrival.draw(ctx,{width:cv.width,height:cv.height,...loc,elapsed:reduced.checked?elapsed/4:elapsed,reduced:reduced.checked,sprite:stamp,color:'#cfa373'});
 // A subtle monitor surface treatment, stable under pause and scrubbing.
 ctx.fillStyle='rgba(0,0,0,.08)';for(let y=0;y<cv.height;y+=3)ctx.fillRect(0,y,cv.width,1);
 seek.value=elapsed;document.getElementById('phase').textContent=f.phase;document.getElementById('time').textContent=(elapsed/1000).toFixed(1).padStart(4,'0')+' / 24';cv.dataset.phase=f.phase;cv.dataset.elapsed=elapsed.toFixed(0);
 [...nav.children].forEach((b,i)=>b.classList.toggle('active',elapsed>=phases[i][1]&&(i===5||elapsed<phases[i+1][1])));
}
function tick(now){if(!playing)return;elapsed=Math.min(24000,elapsed+(now-last));last=now;render();if(elapsed>=24000){playing=false;play.textContent='Replay arrival';stopAudio();return;}raf=requestAnimationFrame(tick);}
play.onclick=()=>{playing=!playing;if(playing){if(elapsed>=24000)elapsed=0;last=performance.now();play.textContent='Pause';beginAudio();raf=requestAnimationFrame(tick);}else{cancelAnimationFrame(raf);stopAudio();play.textContent='Play arrival';}};
seek.oninput=()=>{playing=false;play.textContent='Play arrival';elapsed=Number(seek.value);stopAudio();render();};reduced.onchange=render;
document.getElementById('sound').onclick=e=>{sound=!sound;e.currentTarget.textContent=sound?'Sound on':'Sound off';e.currentTarget.setAttribute('aria-pressed',String(sound));if(playing)beginAudio();else stopAudio();};
resize();
