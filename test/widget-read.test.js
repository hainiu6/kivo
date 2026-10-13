import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('read receipts require an open panel, foreground parent and visible message; unchanged history reuses nodes',async()=>{
  const nodes=new Map(),listeners={},events={},sent=[],windowListeners={};let viewportBottom=100;
  function node(){return {children:[],dataset:{},classList:{add(){}},style:{setProperty(){}},append(...children){for(const n of children){n.parentNode=this;this.children.push(n);}},replaceChildren(...children){this.children.forEach(n=>n.parentNode=null);this.children=[];this.append(...children);},remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}},insertBefore(n,b){n.remove();n.parentNode=this;this.children.splice(b?this.children.indexOf(b):this.children.length,0,n);},addEventListener(name,cb){this['on'+name]=cb;},getBoundingClientRect(){const id=Number(this.dataset.messageId);return id?{top:(id-1)*120,bottom:(id-1)*120+30}:{top:0,bottom:viewportBottom};},focus(){},scrollTop:0,scrollHeight:100,clientHeight:100,value:''};}
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const socket={connected:true,on:(name,cb)=>events[name]=cb,removeAllListeners(){},disconnect(){},auth:{},emit(){},timeout(){return{emit(name,data,cb){sent.push({name,data});cb(null,{ok:true});}};}};
  const parent={postMessage(){}},context={URL,URLSearchParams,Promise,Date,parent,location:{search:'?site=site'},window:{addEventListener:(name,cb)=>windowListeners[name]=cb},document:{hidden:false,createElement:node,getElementById:get,body:node(),documentElement:{style:{setProperty(){}}},addEventListener:(name,cb)=>listeners[name]=cb,querySelector(){return null;}},io:()=>socket};
  vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/chat-ui.js',import.meta.url),'utf8'),context);
  context.KivoChat={...context.window.KivoChat,composer:()=>({clear(){},closePicker(){},isUploading:()=>false}),renderMessage:m=>({body:m.body}),clearImages(){},forgetImages(){}};
  vm.runInContext(readFileSync(new URL('../public/widget-frame.js',import.meta.url),'utf8'),context);
  const notify=data=>windowListeners.message({source:parent,origin:'https://shop.example',data:{kivo:true,...data}}),flush=()=>new Promise(resolve=>setImmediate(resolve));
  notify({type:'init',site:{id:'site',color:'#0f766e'},parentOrigin:'https://shop.example',page:'https://shop.example/',visitorToken:'token',conversationId:'conv',opened:false});
  const history=[{id:1,sender:'agent',body:'one',created_at:1},{id:2,sender:'agent',body:'two',created_at:2}];events.history(history);await flush();assert.equal(sent.length,0);
  notify({type:'visibility',opened:true,focus:false});await flush();assert.equal(sent.length,1);assert.equal(sent[0].data.lastId,1,'below-viewport message is unread');
  const first=get('message-items').children[0];events.history(history);await flush();assert.equal(get('message-items').children[0],first);assert.equal(sent.length,1,'duplicate history sends no duplicate receipt');
  notify({type:'page-visibility',visible:false});viewportBottom=300;get('messages').onscroll();await flush();assert.equal(sent.length,1);
  notify({type:'page-visibility',visible:true});await flush();assert.equal(sent.at(-1).data.lastId,2);
  context.document.hidden=true;viewportBottom=500;events['message:new']({id:3,sender:'agent',body:'background',created_at:3});await flush();assert.equal(sent.length,2);
  context.document.hidden=false;listeners.visibilitychange();await flush();assert.equal(sent.at(-1).data.lastId,3);
});
