import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const conversationId='11111111-1111-4111-8111-111111111111';
const siteId='22222222-2222-4222-8222-222222222222';
const stateKey='kivo.admin.workspace';
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function harness({state,fail,delayMe=false,list=false}={}) {
  const nodes=new Map(),listeners={},socketListeners={},storage=new Map(),requests=[];
  if(state)storage.set(stateKey,JSON.stringify({username:'admin',...state}));
  function node(){const classes=new Set();return{value:'',textContent:'',hidden:false,children:[],dataset:{},focused:0,classList:{toggle(name,value){if(value??!classes.has(name))classes.add(name);else classes.delete(name);},add:name=>classes.add(name),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name)},attributes:{},elements:new Proxy({},{get:(_,name)=>get('field:'+name)}),append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},get firstChild(){return this.children[0];},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},addEventListener(name,callback){this['on'+name]=callback;},querySelector(){return node();},focus(){this.focused++;},close(){},scrollHeight:100,clientHeight:100,scrollTop:0};}
  const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
  const nav=['inbox','sites','replies','stats','settings'].map(view=>{const n=node();n.dataset.view=view;return n;});
  const tabs=['open','closed',''].map(status=>{const n=node();n.dataset.status=status;return n;});
  get('#login-screen').hidden=true;get('#workspace').hidden=true;
  const socket={connected:false,on:(name,handler)=>{socketListeners[name]=handler;},disconnect(){this.connected=false;},timeout(){return{emit(){}};}};
  const c={id:conversationId,name:'演示访客',site_id:siteId,site_name:'test',page:'https://shop.example/account',ip:'1.1.1.1',region:'test',status:'closed',unread:0,created_at:1,updated_at:1};
  let resolveMe;
  const context={console,Date,URL,URLSearchParams,Promise,Map,Set,setTimeout(){},clearTimeout(){},localStorage:{getItem(){return null;},setItem(){}},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},window:{matchMedia:()=>({matches:false}),addEventListener:(name,callback)=>{listeners[name]=callback;}},document:{hidden:false,querySelector:get,querySelectorAll:selector=>selector==='.nav-button'?nav:selector==='[data-status]'?tabs:[],createElement:node,createTextNode:text=>({textContent:text}),addEventListener(){}},KivoChat:{composer:()=>({isUploading:()=>false,clear(){},closePicker(){},destroy(){}}),renderMessage:m=>m,clearImages(){},forgetImages(){}},KivoNotifications:{create:()=>({start(){},reset(){},refresh(){},receive(){}})},KivoStats:{create:()=>({activate(){},deactivate(){},reset(){},schedule(){},setSites(){},setFilters(){},getFilters:()=>({statsDays:7,statsSite:''})})},io:()=>socket,fetch:async url=>{
    requests.push(url);if(url==='/api/admin/me'&&delayMe)await new Promise(resolve=>{resolveMe=resolve;});
    if(url==='/api/admin/me'&&fail){if(fail==='network')throw new Error('offline');return{ok:false,status:fail,json:async()=>({error:'请先登录'})};}
    let data=url==='/api/admin/me'?{username:'admin',publicUrl:'https://chat.example',presence:{availability:'offline',onlineVisitors:3}}:url==='/api/admin/sites'?[{id:siteId,name:'test',origins:['*'],greeting:'hello'}]:url.endsWith('/messages')?[{id:1,conversation_id:conversationId,sender:'agent',body:'你好',created_at:1}]:url===`/api/admin/conversations/${conversationId}`?c:list&&url.startsWith('/api/admin/conversations?')?[c]:[];
    return{ok:true,json:async()=>data};
  }};
  vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/admin-state.js',import.meta.url),'utf8'),context);context.KivoWorkspaceState=context.window.KivoWorkspaceState;
  vm.runInContext(readFileSync(new URL('../public/admin.js',import.meta.url),'utf8'),context);
  return{get,requests,storage,nav,tabs,listeners,socketListeners,socket,resolveMe:()=>resolveMe?.()};
}

test('refresh restores module, filters, selected visitor and draft without flashing the login form',async()=>{
  const h=harness({delayMe:true,state:{view:'replies',status:'closed',query:'访客',site:siteId,conversation:conversationId,draft:'未发送的回复'}});
  assert.equal(h.get('#login-screen').hidden,true);assert.equal(h.get('#workspace').hidden,true);
  h.resolveMe();await flush();
  assert.equal(h.get('#login-screen').hidden,true);assert.equal(h.get('#workspace').hidden,false);
  assert.equal(h.get('#view-replies').hidden,false);assert.equal(h.get('#view-inbox').hidden,true);
  assert.equal(h.get('#search').value,'访客');assert.equal(h.get('#site-filter').value,siteId);
  assert.ok(h.requests.some(url=>url.includes('status=closed')&&url.includes(`site=${siteId}`)));
  h.socket.connected=true;h.socketListeners.connect();await flush();
  assert.equal(h.get('#chat-name').textContent,'演示访客');assert.equal(h.get('#message-input').value,'未发送的回复');
  h.tabs[0].onclick();await flush();assert.equal(h.tabs[0].classList.contains('active'),true);
  h.listeners.pagehide();assert.equal(JSON.parse(h.storage.get(stateKey)).conversation,conversationId);
});

test('temporary network failures offer retry and keep the saved page instead of showing login',async()=>{
  const h=harness({fail:'network',state:{view:'settings'}});await flush();
  assert.equal(h.get('#login-screen').hidden,true);assert.equal(h.get('#retry-start').hidden,false);
  assert.equal(JSON.parse(h.storage.get(stateKey)).view,'settings');
});

test('only an expired session shows login and clears the previous tab state',async()=>{
  const h=harness({fail:401,state:{view:'replies',conversation:conversationId,draft:'private draft'}});await flush();
  assert.equal(h.get('#login-screen').hidden,false);assert.equal(h.get('#workspace').hidden,true);assert.equal(h.storage.has(stateKey),false);
});

test('clicking a conversation focuses its reply field; reconnects and hidden-module history reloads do not',async()=>{
  const h=harness({list:true});await flush();
  h.get('#conversations').children[0].onclick();assert.equal(h.get('#message-input').focused,1);await flush();
  h.socket.connected=true;h.socketListeners.connect();await flush();assert.equal(h.get('#message-input').focused,1);
  h.nav.find(n=>n.dataset.view==='stats').onclick();await flush();assert.equal(h.get('#view-stats').hidden,false);
  h.socketListeners.connect();await flush();assert.equal(h.get('#message-input').focused,1);
});

test('live presence stays global when the inbox is filtered and transport reconnection preserves the chosen support status',async()=>{
  const h=harness({list:true});await flush();
  assert.equal(h.get('#online-visitors').textContent,3);
  assert.equal(h.get('#support-availability').dataset.state,'offline');
  h.socket.connected=true;h.socketListeners.connect();await flush();
  assert.equal(h.get('#support-availability').dataset.state,'offline');
  h.socketListeners['presence:update']({availability:'online',onlineVisitors:21});
  assert.equal(h.get('#online-visitors').textContent,21);
  assert.equal(h.get('#support-availability').dataset.state,'online');
  h.socketListeners.disconnect();assert.equal(h.get('#support-availability').dataset.state,'online');
  const row=h.get('#conversations').children[0];assert.equal(row.children[1].children.length,2);
  assert.ok(row.children[1].children[0].children.some(n=>n.className==='row-presence offline'));
  h.socketListeners.connect_error({message:'登录已过期'});
  h.socketListeners['presence:update']({availability:'offline',onlineVisitors:999});
  assert.equal(h.get('#online-visitors').textContent,21,'late events cannot change a logged-out workspace');
});
