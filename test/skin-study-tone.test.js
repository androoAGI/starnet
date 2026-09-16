'use strict';
const assert=require('node:assert/strict'),tone=require('../frontend/app/skin-study-tone.js');
assert.deepEqual(tone.pixel(0,0,0),[0,0,0]);
let prior=0;
for(let n=0;n<256;n++){
 const [r,g,b]=tone.pixel(n,n,n);assert.equal(r,g);assert.equal(r,b);assert.ok(r>=prior);prior=r;
}
assert.ok(tone.pixel(36,36,36)[0]>36,'dark planes gain separation');
assert.ok(tone.pixel(240,240,240)[0]<240,'bright planes stay below clipped white');
assert.ok(tone.pixel(240,210,40)[0]>tone.pixel(240,210,40)[1]);
let output,builds=0;const source={width:2,height:1};
global.document={createElement(){builds++;return {width:0,height:0,getContext(){return {drawImage(){},getImageData(){return {data:new Uint8ClampedArray([240,210,40,73,30,40,50,255])};},putImageData(d){output=d.data;}};}};}};
const frame=tone.frame(source);assert.equal(output[3],73);assert.equal(output[7],255);assert.equal(tone.frame(source),frame);assert.equal(builds,1);
delete global.document;
console.log('PASS: study tone preserves alpha, black outlines, luminance order, hue order and cached frames.');
