const base='http://127.0.0.1:9236';
let token;
async function auth(){
 const page=await(await fetch(base)).text();
 if(!/window\.__STARNET_DEV__\s*=\s*\{/.test(page))throw Error('Audit probes require the disposable dev-seeded station on port 9236');
 token=JSON.parse(page.match(/window\.__STARNET_API_TOKEN__=("[^"]+")/)[1]);
}
async function api(path,b){const r=await fetch(base+path,{method:b?'POST':'GET',headers:{'x-starnet-token':token,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status,...await r.json()};}
async function mock(b){return await(await fetch('http://127.0.0.1:9237/control',{method:'POST',body:JSON.stringify(b)})).json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports={auth,api,mock,sleep};
