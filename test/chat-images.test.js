import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('a long image history keeps displayed and zoomed images valid until conversation change',async()=>{
  const live=new Set(), bubbles=[], loaded=[], requests=[];let sequence=0;
  function element(tag){return {tag,children:[],classList:{add(){}},append(...nodes){this.children.push(...nodes);},replaceWith(node){loaded.push(node);},showModal(){},close(){},remove(){}};}
  const document={createElement:element,body:element('body')};
  const window={};
  vm.runInNewContext(readFileSync(new URL('../public/chat-ui.js',import.meta.url),'utf8'),{window,document,URL:{createObjectURL:()=>{const url='blob:test/'+(++sequence);live.add(url);return url;},revokeObjectURL:url=>live.delete(url)},fetch:url=>new Promise(resolve=>requests.push({url,resolve}))});
  for(let i=0;i<170;i++)bubbles.push(window.KivoChat.renderMessage({kind:'image',media_id:String(i),body:''}));
  assert.equal(requests.length,170);
  // Resolve all network responses together to exercise asynchronous load races.
  for(const request of requests)request.resolve({ok:true,blob:async()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(loaded.length,170);
  for(const image of loaded)assert.ok(live.has(image.src),'every displayed image URL remains readable');
  loaded[0].onclick();
  const dialog=document.body.children[0];assert.ok(live.has(dialog.children[1].src),'oldest image remains available in the zoom viewer');
  window.KivoChat.renderMessage({kind:'image',media_id:'0',body:''});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,170,'history re-render reuses existing images');
  window.KivoChat.clearImages();await new Promise(resolve=>setImmediate(resolve));assert.equal(live.size,0,'changing conversation frees cached image URLs');
});
