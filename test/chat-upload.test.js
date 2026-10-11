import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/chat-ui.js',import.meta.url),'utf8');
const id='12345678-abcd-abcd-abcd-123456789abc';
const file=(name='中文截图📸.PNG',type='')=>new File([new Uint8Array([1,2,3])],name,{type});
function setup(fetch){
  const classes=()=>({values:new Set(),add(value){this.values.add(value);},remove(value){this.values.delete(value);},toggle(value,enabled){enabled?this.add(value):this.remove(value);}});
  function element(tag){return {tag,children:[],listeners:{},classList:classes(),append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(){},addEventListener(name,handler){this.listeners[name]=handler;},contains(){return false;},focus(){},files:[]};}
  const document={createElement:element,body:element('body'),addEventListener(){}};
  const window={};vm.runInNewContext(source,{window,document,Blob,File,FormData,fetch,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},KivoStickers:{items:[]}});
  return {chat:window.KivoChat,element};
}

test('upload sends materialized multipart with an ASCII filename and keeps authorization',async()=>{
  let request;
  const {chat}=setup(async(url,options)=>{request={url,...options};return new Response(JSON.stringify({id}),{status:201});});
  const data=await chat.uploadImage('/api/widget/images',file(),{Authorization:'Bearer token','X-Kivo-Site':'site'});
  assert.equal(data.id,id);assert.equal(data.blob.type,'image/png');
  assert.equal(request.headers.Authorization,'Bearer token');assert.equal(request.headers['Content-Type'],undefined,'browser generates multipart boundary');
  assert.ok(request.body instanceof FormData);assert.equal(request.body.get('image').name,'image.png');
  assert.deepEqual(new Uint8Array(await request.body.get('image').arrayBuffer()),new Uint8Array([1,2,3]));
});

test('proxy HTML, empty responses and native upload errors become clear actionable errors',async()=>{
  for(const status of [413,502,200]){
    const {chat}=setup(async()=>new Response('<html>proxy error</html>',{status}));
    await assert.rejects(chat.uploadImage('/upload',file()),new RegExp(`HTTP ${status}`));
  }
  const empty=setup(async()=>new Response('',{status:200}));await assert.rejects(empty.chat.uploadImage('/upload',file()),/HTTP 200/);
  const network=setup(async()=>{throw new SyntaxError('The string did not match the expected pattern.');});
  await assert.rejects(network.chat.uploadImage('/upload',file()),/上传连接失败/);
  const unreadable=setup(()=>assert.fail('must not send unreadable file'));
  await assert.rejects(unreadable.chat.uploadImage('/upload',{name:'a.png',type:'image/png',size:1,arrayBuffer:async()=>{throw new SyntaxError('The string did not match the expected pattern.');}}),/无法读取/);
  const server=setup(async()=>new Response(JSON.stringify({error:'图片存储空间已满'}),{status:400}));
  await assert.rejects(server.chat.uploadImage('/upload',file()),/图片存储空间已满/);
});

test('dropped images preview before send; multiple files and conversation changes are handled',async()=>{
  let requests=0,context='conversation-a',resolveUpload;const errors=[],locks=[];
  const {chat,element}=setup(()=>{requests++;return new Promise(resolve=>{resolveUpload=resolve;});});
  const form=element('form'),input=element('textarea'),tools=element('div'),preview=element('div'),dropTarget=element('section');
  const composer=chat.composer({form,input,tools,preview,dropTarget,getContext:()=>context,uploadUrl:()=>'/upload',onError:message=>errors.push(message),onSubmitLock:value=>locks.push(value)});
  const event=files=>({dataTransfer:{files,types:['Files']},preventDefault(){this.prevented=true;},stopPropagation(){}});
  const drag=event([file()]);dropTarget.listeners.dragenter(drag);assert.equal(drag.prevented,true);assert.equal(dropTarget.classList.values.has('drag-over'),true);
  const dropped=event([file()]),pending=dropTarget.listeners.drop(dropped);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(dropped.prevented,true);assert.equal(dropTarget.classList.values.has('drag-over'),false);assert.equal(composer.isUploading(),true);
  assert.equal(composer.hasAttachment(),false,'upload does not send a chat message');
  resolveUpload(new Response(JSON.stringify({id}),{status:201}));await pending;
  assert.equal(composer.hasAttachment(),true);assert.equal(composer.payload().mediaId,id);assert.equal(preview.hidden,false);
  const multiple=event([file(),file()]);dropTarget.listeners.drop(multiple);assert.match(errors.at(-1),/每次拖入一张/);assert.equal(requests,1);
  const second=dropTarget.listeners.drop(event([file()]));await new Promise(resolve=>setImmediate(resolve));
  context='conversation-b';composer.clear();resolveUpload(new Response(JSON.stringify({id}),{status:201}));await second;
  assert.equal(composer.hasAttachment(),false,'in-flight upload cannot attach to a different conversation');assert.equal(locks.at(-1),false);
  dropTarget.listeners.drop(event([new File(['bad'],'document.pdf',{type:'application/pdf'})]));assert.equal(requests,2);assert.match(errors.at(-1),/PNG/);
});
