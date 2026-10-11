import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('widget removes deleted history and images, rejects late replies, and waits for visitor action after conversation deletion',()=>{
  const nodes=new Map(),listeners={},parentMessages=[],socketListeners={};let acknowledge,closed=0,cleared=0,forgotten=[];
  const node=()=>({children:[],textContent:'',value:'',hidden:false,disabled:false,scrollHeight:100,scrollTop:0,clientHeight:100,classList:{add(){}},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},focus(){},requestSubmit(){}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const socket={connected:true,auth:{},on(name,handler){socketListeners[name]=handler;},removeAllListeners(){for(const key of Object.keys(socketListeners))delete socketListeners[key];},disconnect(){this.connected=false;closed++;},emit(){},timeout(){return{emit(name,data,callback){acknowledge=callback;}};}};
  const parent={postMessage:data=>parentMessages.push(data)};
  vm.runInNewContext(readFileSync(new URL('../public/widget-frame.js',import.meta.url),'utf8'),{URL,URLSearchParams,Date,parent,location:{search:'?site=site-1'},window:{addEventListener:(name,handler)=>{listeners[name]=handler;},kivoMessageId:()=> 'message-1'},document:{getElementById:get,createElement:node,body:node(),documentElement:{style:{setProperty(){}}},addEventListener(){},querySelector(){return null;}},io:()=>socket,KivoChat:{composer:()=>({clear(){},closePicker(){},isUploading:()=>false,hasAttachment:()=>false,payload:()=>({kind:'text'})}),clearImages:()=>{cleared++;},forgetImages:ids=>{forgotten.push(...ids);},contrast:()=> '#fff',renderMessage:m=>({body:m.body})}});
  listeners.message({source:parent,origin:'https://shop.example',data:{kivo:true,type:'init',site:{id:'site-1',color:'#0f766e',greeting:'hello'},parentOrigin:'https://shop.example',page:'https://shop.example/account',visitorToken:'token',conversationId:'conversation-1'}});
  const one={id:1,sender:'visitor',created_at:1,body:'delete me'},two={id:2,sender:'agent',created_at:2,body:'keep me'};
  socketListeners.history([one,two]);assert.equal(get('message-items').children.length,2);
  socketListeners['message:deleted']({conversationId:'other',messageId:2,mediaIds:[]});assert.equal(get('message-items').children.length,2);
  socketListeners['message:deleted']({conversationId:'conversation-1',messageId:1,mediaIds:['image-1']});assert.equal(get('message-items').children.length,1);assert.deepEqual(forgotten,['image-1']);
  socketListeners.history([one,two]);assert.equal(get('message-items').children.length,1,'stale history cannot restore a deleted message');
  get('message-input').value='in flight';get('message-form').onsubmit({preventDefault(){}});
  socketListeners['history:cleared']({conversationId:'conversation-1',throughId:10,mediaIds:[]});assert.equal(get('message-items').children.length,0);
  acknowledge(null,{ok:true,message:{id:10,sender:'visitor',created_at:10,body:'late acknowledgement'}});assert.equal(get('message-items').children.length,0,'late send acknowledgement cannot restore cleared history');
  socketListeners['message:new']({id:11,sender:'visitor',created_at:11,body:'new conversation message'});assert.equal(get('message-items').children.length,1);
  socketListeners['conversation:deleted']({conversationId:'conversation-1'});assert.equal(get('message-items').children.length,0);assert.equal(get('message-input').disabled,true);assert.equal(get('restart-conversation').hidden,false);assert.ok(closed>0);assert.ok(cleared>1);
  assert.equal(parentMessages.at(-1).type,'conversation-deleted');get('restart-conversation').onclick();assert.equal(parentMessages.at(-1).type,'restart-conversation');
});
