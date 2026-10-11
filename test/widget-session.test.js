import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/widget.js',import.meta.url),'utf8');
test('new replies open the visitor panel without stealing focus, reject spoofed notifications and respect deletion',async()=>{
  const nodes=[],listeners={},sent=[];let focused=0;
  const element=tag=>{const node={tag,dataset:{},style:{setProperty(){}},append(){},setAttribute(){},focus(){focused++;},attachShadow(){return{append(){}};},contentWindow:{postMessage:data=>sent.push(data)}};nodes.push(node);return node;};
  const context={URL,console,location:{href:'https://shop.example/account',origin:'https://shop.example'},window:{addEventListener:(name,handler)=>{listeners[name]=handler;}},document:{currentScript:{src:'https://chat.example/widget.js',getAttribute:key=>key==='data-site'?'site-id':null},body:{append(){}},createElement:element,addEventListener(){}},setInterval(){},localStorage:{getItem(){},setItem(){},removeItem(){}},fetch:async()=>({ok:true,json:async()=>({conversationId:'conversation-id',visitorToken:'token',identity:null,site:{id:'site-id',color:'#0f766e'}})})};
  vm.runInNewContext(source,context);await new Promise(resolve=>setImmediate(resolve));
  const frame=nodes.find(n=>n.tag==='iframe'),panel=nodes.find(n=>n.className==='panel'),launcher=nodes.find(n=>n.className==='launcher');
  const notify=(type,origin='https://chat.example',source=frame.contentWindow)=>listeners.message({source,origin,data:{kivo:true,type}});
  notify('unread','https://evil.example');notify('unread','https://chat.example',{});assert.equal(panel.hidden,true);
  notify('unread');assert.equal(panel.hidden,false);assert.equal(launcher.dataset.open,'true');assert.equal(focused,0);assert.equal(sent.at(-1).focus,false);
  const before=sent.length;notify('unread');assert.equal(sent.length,before,'already-open panel stays open');
  notify('close');assert.equal(panel.hidden,true);focused=0;
  launcher.onclick();assert.equal(focused,1,'manual open focuses the chat');
  notify('close');notify('conversation-deleted');notify('unread');assert.equal(panel.hidden,true,'deleted conversations cannot reopen');
});
test('session-name embed makes no identity request and isolates browser credentials for names and logout',async()=>{
  const storage=new Map(),requests=[];
  let counter=0;
  const element=()=>({style:{setProperty(){}},append(){},setAttribute(){},attachShadow(){return{append(){}};},contentWindow:{postMessage(){}}});
  const run=async name=>{
    const start=requests.length;
    const script={src:'https://chat.example/widget.js',getAttribute:key=>({'data-site':'site-id','data-visitor-name':name})[key]||null};
    const context={URL,console,location:{href:'https://shop.example/user',origin:'https://shop.example'},window:{addEventListener(){}},document:{currentScript:script,body:{append(){}},createElement:element,addEventListener(){}},setInterval(){},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},fetch:async(url,options)=>{
      requests.push({url,body:JSON.parse(options.body)});const body=requests.at(-1).body;
      return{ok:true,json:async()=>({conversationId:body.visitorToken||String(++counter),visitorToken:body.visitorToken||String(counter).padStart(64,'0'),identity:null,site:{id:'site-id',color:'#0f766e'}})};
    }};
    vm.runInNewContext(source,context);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(requests.length,start+1);assert.equal(requests.at(-1).url,'https://chat.example/api/widget/session');
    return requests.at(-1).body;
  };
  await run('');const anonymousToken=[...storage.values()][0];
  assert.equal((await run('Alice')).visitorName,'Alice');const aliceToken=[...storage.values()][1];
  assert.equal((await run('Bob')).visitorToken,undefined);
  assert.equal((await run('Alice')).visitorToken,aliceToken);
  assert.equal((await run('')).visitorToken,anonymousToken);
  assert.notEqual(aliceToken,anonymousToken);
  assert.equal((await run('x'.repeat(127)+'😊')).visitorName,'x'.repeat(127),'long Unicode names do not leave a split surrogate');
});

test('deleting a conversation invalidates anonymous credentials and suppresses background account refresh until visitor action',async()=>{
  for(const signed of [false,true]){
    const nodes=[],listeners={},documentListeners={},intervals=[],requests=[],key='kivo:https://chat.example:site-id',storage=new Map([[key,'old-visitor-token']]);
    const element=tag=>{const node={tag,dataset:{},style:{setProperty(){}},append(){},setAttribute(){},focus(){},attachShadow(){return{append(){}};},contentWindow:{postMessage(){}}};nodes.push(node);return node;};
    let sequence=0;
    const context={URL,console,location:{href:'https://shop.example/user',origin:'https://shop.example'},window:{addEventListener:(name,handler)=>{listeners[name]=handler;}},document:{currentScript:{src:'https://chat.example/widget.js',getAttribute:name=>({'data-site':'site-id','data-identity-url':signed?'/identity':null})[name]},body:{append(){}},createElement:element,addEventListener:(name,handler)=>{documentListeners[name]=handler;},hidden:false},setInterval:(handler,ms)=>intervals.push({handler,ms}),localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},fetch:async(url,options)=>{
      requests.push({url,body:options.body&&JSON.parse(options.body)});
      return{ok:true,json:async()=>url.endsWith('/identity')?{identityToken:'signed-identity'}:{conversationId:String(++sequence),visitorToken:signed?'signed-identity':'new-token-'+sequence,identity:signed?{verified:true}:null,site:{id:'site-id',color:'#0f766e'}}};
    }};
    vm.runInNewContext(source,context);await new Promise(resolve=>setImmediate(resolve));
    const frame=nodes.find(n=>n.tag==='iframe'),notify=type=>listeners.message({source:frame.contentWindow,origin:'https://chat.example',data:{kivo:true,type}}),before=requests.length;
    notify('conversation-deleted');
    assert.equal(storage.get(key),signed?'old-visitor-token':undefined,'only deleted anonymous credentials are discarded');
    if(signed){intervals.find(i=>i.ms===60000).handler();documentListeners.visibilitychange();}
    await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,before,'automatic refresh must not recreate a deleted conversation');
    notify('restart-conversation');await new Promise(resolve=>setImmediate(resolve));assert.ok(requests.length>before);
    assert.equal(requests.at(-1).body.visitorToken,undefined,'fresh conversation does not reuse a deleted visitor credential');
  }
});
