'use strict';
const assert=require('node:assert/strict');const {prepare,inspect,responseContract}=require('../sidecar/result-contract');
const cases=[
 [{type:'integer',minimum:0},'3','-1'],
 [{type:'string',pattern:'^[A-Z]{3}$'},'"ABC"','"abc"'],
 [{type:'array',minItems:2,items:{type:'string'}},'["a","b"]','["a"]'],
 [{oneOf:[{type:'string'},{type:'integer'}]},'2','false'],
 [{$defs:{score:{type:'integer',minimum:2}},$ref:'#/$defs/score'},'3','1'],
 [{type:'object',properties:{x:{type:'integer'}},required:['x'],additionalProperties:false},'{"x":1}','{"x":1,"extra":2}']
];
for(const [schema,valid,invalid]of cases){assert.equal(prepare(schema).ok,true,JSON.stringify(schema));assert.equal(inspect(schema,valid).ok,true);assert.equal(inspect(schema,invalid).ok,false);assert.equal(inspect(schema,'Here: '+valid).ok,false);}
for(const schema of [{$ref:'https://example.com/schema'},{$defs:{a:{$ref:'#/$defs/a'}},$ref:'#/$defs/a'},{type:'string',pattern:'(a+)+$'},{unknownKeyword:true}])assert.equal(prepare(schema).ok,false);
assert.equal(inspect(responseContract({type:'json_object'}).schema,'prose').ok,false);
assert.equal(responseContract({type:'made_up'}).ok,false);
console.log('result-contract: six positive/negative schema pairs, whole-JSON parsing, remote/cyclic refs, unsafe pattern and unsupported format checks passed');
