import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/widget.js',import.meta.url),'utf8');
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
