'use strict';
// Dedicated result contract validator: shared event schemas are deliberately untouched.
const Ajv = require('ajv');
const cache=new Map();
function prepare(schema) {
 if(schema==null)return {ok:true,schema:null};
 try {
  const raw=JSON.stringify(schema);
  if(!schema || typeof schema!=='object' || Array.isArray(schema) || raw.length>12000)throw Error('resultSchema must be a bounded JSON object');
  if(cache.has(raw))return {ok:true,schema:JSON.parse(raw),validate:cache.get(raw)};
  let nodes=0;
  const active=new Set();
  function walk(s,depth) {
   if(typeof s==='boolean')return;
   if(!s || typeof s!=='object' || Array.isArray(s))throw Error('Schema node must be an object');
   if(++nodes>120 || depth>16 || active.has(s))throw Error('resultSchema is too complex or recursive');
   active.add(s);
   if(s.$id || s.$async || s.$dynamicRef || s.$recursiveRef)throw Error('Dynamic or external schema resolution is unsupported');
   if(s.pattern!==undefined) {
    // Single variable repetition, no groups/alternation/backreferences: bounded linear
    // patterns cover identifiers without allowing user-supplied catastrophic regexes.
    const p=String(s.pattern);
    if(p.length>256 || /[()|]/.test(p) || /\\[1-9]/.test(p) || (p.match(/(?<!\\)[+*]|\{\d+,\d*\}/g)||[]).length>1)throw Error('pattern exceeds the supported safe pattern subset');
   }
   if(s.patternProperties)throw Error('patternProperties is unsupported');
   if(s.$ref) {
    if(!/^#\//.test(s.$ref))throw Error('Only local JSON Pointer references are supported');
    let target=schema;
    for(const part of s.$ref.slice(2).split('/')){const k=part.replace(/~1/g,'/').replace(/~0/g,'~');if(!target || !Object.prototype.hasOwnProperty.call(target,k))throw Error('Unresolved local reference');target=target[k];}
    walk(target,depth+1);
   }
   for(const k of ['properties','$defs','definitions'])if(s[k])for(const child of Object.values(s[k]))walk(child,depth+1);
   for(const k of ['items','additionalProperties','not','if','then','else','contains'])if(s[k]!==undefined)walk(s[k],depth+1);
   for(const k of ['oneOf','anyOf','allOf'])if(s[k])for(const child of s[k])walk(child,depth+1);
   active.delete(s);
  }
  walk(schema,0);
  const ajv=new Ajv({allErrors:false,strictSchema:true,strictTypes:false,strictTuples:false,strictRequired:false,allowUnionTypes:true,validateFormats:true,coerceTypes:false,useDefaults:false,removeAdditional:false,inlineRefs:false});
  const validate=ajv.compile(schema);
  if(cache.size>=32)cache.delete(cache.keys().next().value);
  cache.set(raw,validate);return {ok:true,schema:JSON.parse(raw),validate};
 }catch(e){return {ok:false,error:String(e.message)};}
}
function inspect(schema,text) {
 if(!schema)return {ok:true,value:null,errors:[]};
 const ready=prepare(schema);if(!ready.ok)return {ok:false,value:null,errors:[ready.error]};
 try {
  if(String(text).length>1048576)throw Error('Structured result exceeds 1 MiB validation limit');
  const value=JSON.parse(String(text).trim());
  if(ready.validate(value))return {ok:true,value,errors:[]};
  return {ok:false,value:null,errors:(ready.validate.errors||[]).slice(0,10).map(e=>(e.instancePath||'$')+' '+e.message)};
 }catch(e){return {ok:false,value:null,errors:['result is not strict JSON: '+e.message]};}
}
function responseContract(format) {
 if(format==null || format.type==='text')return {ok:true,schema:null};
 if(format.type==='json_object')return prepare({type:'object'});
 if(format.type==='json_schema' && format.json_schema && format.json_schema.schema)return prepare(format.json_schema.schema);
 return {ok:false,error:'Unsupported response_format; use text, json_object, or json_schema with a schema'};
}
module.exports={prepare,inspect,responseContract};
