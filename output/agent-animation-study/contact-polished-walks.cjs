const fs=require('fs'),sharp=require('sharp');
const base='output/agent-animation-study/approved-motion';
(async()=>{const jobs=JSON.parse(fs.readFileSync(base+'/polish-jobs.json'));
 for(const id of [...new Set(jobs.map(j=>j.id))]){
  const rows=jobs.filter(j=>j.id===id),layers=rows.map((j,i)=>({input:`${base}/walk-fixes/${id}-${j.dir}.png`,left:0,top:i*144}));
  await sharp({create:{width:1296,height:rows.length*144,channels:4,background:'#273237'}}).composite(layers).png().toFile(`${base}/walk-fixes/${id}-polished-contact.png`);
 }console.log('Packed five direction-review sheets');})();
