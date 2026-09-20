'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'starnet-staging-'));
const put=(name,body='')=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);};
try{
 for(const name of ['scripts/stage-voice-deps.mjs','scripts/lib/staged-native-packages.mjs'])put(name,fs.readFileSync(path.resolve(__dirname,'..',name)));
 put('package.json',JSON.stringify({dependencies:{'onnxruntime-node':'1'}}));
 const packages={'node_modules/@fixture/dev':{dev:true},'node_modules/onnxruntime-node':{},'node_modules/shared':{},'node_modules/optional':{devOptional:true},'node_modules/shared/node_modules/nested-dev':{dev:true}};
 put('package-lock.json',JSON.stringify({packages}));
 for(const prefix of ['node_modules','src-tauri/target/release/node_modules','src-tauri/target/x86_64-pc-windows-msvc/release/node_modules']){
  for(const name of ['@fixture/dev','shared','optional','shared/node_modules/nested-dev'])put(prefix+'/'+name+'/package.json','{}');
 }
 put('node_modules/onnxruntime-node/package.json','{}');put('node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node');
 execFileSync(process.execPath,[path.join(root,'scripts/stage-voice-deps.mjs'),'--target','win-x64'],{cwd:root,stdio:'pipe'});
 for(const prefix of ['src-tauri/voice-deps/node_modules','src-tauri/target/release/node_modules','src-tauri/target/x86_64-pc-windows-msvc/release/node_modules']){
  assert.equal(fs.existsSync(path.join(root,prefix,'@fixture/dev')),false,'development package removed from '+prefix);
  assert.equal(fs.existsSync(path.join(root,prefix,'shared/node_modules/nested-dev')),false);
  for(const name of ['shared','optional'])assert.equal(fs.existsSync(path.join(root,prefix,name,'package.json')),true);
 }
 assert.equal(fs.existsSync(path.join(root,'node_modules/@fixture/dev/package.json')),true,'source dependencies remain intact');
 console.log('staging closure: fresh, warm, architecture-specific, nested dev, shared and optional preservation PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});}
