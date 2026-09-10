'use strict';
// One sidecar owns the workspace. Reserve durably BEFORE dispatch; an orphaned
// reservation is uncertain work, never permission to repeat its side effects.
const crypto = require('node:crypto');
const { note: failNote } = require('./failopen');
const { makeDurableJsonStore, makeKeyedMutex } = require('./durable-store');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function makeRequestReservations(d) {
  const store = makeDurableJsonStore({ fs:d.fs, path:d.path, fileFor:()=>d.path.join(d.workspaces,'api-requests.json'), writeDurable:d.writeDurable });
  const lock=makeKeyedMutex(), active=new Map();
  const failure=(code,message)=>Object.assign(new Error(message),{code});
  function read() {
    const r=store.readKey('requests');
    // A backup can predate a reservation: using it could replay a mutation.
    if (!['ok','absent'].includes(r.status)) throw failure('reservation_store_unavailable','Request reservation store needs recovery; no run was dispatched');
    if (r.status==='absent') return [];
    if (!Array.isArray(r.value)) throw failure('reservation_store_unavailable','Invalid request reservation store');
    return r.value;
  }
  async function run({scope,key,body,runId,onProgress}, execute) {
    const id=digest(scope+'\n'+key), fingerprint=digest(canonical(body));
    const reservation=await lock.run('requests',()=>{
      const rows=read(); const row=rows.find(r=>r.id===id);
      if(row) {
        if(row.fingerprint!==fingerprint) throw failure('idempotency_conflict','Idempotency-Key already belongs to a different request');
        if(active.has(id)) {
          const live=active.get(id);
          if(onProgress) { for(const item of live.progress) {try {onProgress(item);} catch (error) { failNote('api.request.progress', error); }} live.listeners.add(onProgress); }
          return {promise:live.promise};
        }
        if(row.response) return {promise:Promise.resolve(row.response)};
        throw failure('request_interrupted','The reserved run '+row.runId+' has no durable result. Inspect that run before starting new work.');
      }
      const next=rows.filter(r=>!r.finishedAt || d.now()-r.finishedAt<86400000);
      next.push({id,fingerprint,runId,createdAt:d.now()});
      store.set('requests',next);
      const live={progress:[],listeners:new Set(onProgress?[onProgress]:[]),promise:null};
      const emit=item=>{ live.progress.push(item); for(const listener of live.listeners) { try { listener(item); } catch (error) { failNote('api.request.progress', error); } } };
      const promise=Promise.resolve().then(()=>execute(runId,emit)).then(async response=>{
        await lock.run('requests',()=>{
          const saved=read(); const current=saved.find(r=>r.id===id);
          if(!current) throw failure('reservation_store_unavailable','Reserved request disappeared');
          // The HTTP handler emits 429 only before run dispatch. A capacity rejection
          // must remain retryable, not become this key's permanently cached answer.
          if(response.status===429) {store.set('requests',saved.filter(r=>r.id!==id));return;}
          current.response=response; current.finishedAt=d.now(); store.set('requests',saved);
        });
        return response;
      }).finally(()=>active.delete(id));
      live.promise=promise; active.set(id,live);
      return {promise};
    });
    return reservation.promise;
  }
  return {run};
}
module.exports={makeRequestReservations,canonical};
