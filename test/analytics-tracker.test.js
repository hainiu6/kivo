import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../public/analytics.js',import.meta.url),'utf8'),site='11111111-1111-4111-8111-111111111111';
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function harness({storage=new Map(),blocked=false,loading=false,failures=0}={}){
  const events={},domEvents={},requests=[],timers=[],polls=[],url=new URL('https://shop.example/product?sku=1'),script={src:'https://analytics.example/analytics.js',getAttribute:()=>site};let failed=failures;
  const window={crypto:webcrypto,addEventListener:(name,handler)=>{events[name]=handler;}},document={currentScript:script,title:'商品页面',referrer:'https://search.example/',hidden:false,readyState:loading?'loading':'complete',addEventListener:(name,handler)=>{domEvents[name]=handler;}};
  const context=vm.createContext({window,document,URL,location:url,localStorage:{getItem:key=>{if(blocked)throw Error('blocked');return storage.get(key);},setItem:(key,value)=>{if(blocked)throw Error('blocked');storage.set(key,value);}},fetch:(endpoint,options)=>{requests.push({endpoint,options,data:JSON.parse(options.body)});if(failed-->0)return Promise.reject(Error('offline'));return Promise.resolve({status:204});},setInterval:handler=>polls.push(handler),setTimeout:handler=>timers.push(handler),Uint8Array,Math,Set,Promise});
  vm.runInContext(source,context);return{events,domEvents,requests,timers,polls,url,storage,document,again:()=>vm.runInContext(source,context)};
}

test('tracker counts initial loads, navigation and bfcache once with first-party UV identity and no credentials',async()=>{
  const h=harness();await flush();assert.equal(h.requests.length,1);const first=h.requests[0];assert.equal(first.endpoint,'https://analytics.example/api/analytics/collect');assert.equal(first.options.credentials,'omit');assert.equal(first.options.keepalive,true);assert.equal(first.options.headers['Content-Type'],'text/plain');assert.match(first.data.visitorId,/^[\da-f-]{36}$/);assert.equal(first.data.title,'商品页面');
  h.polls[0]();h.again();assert.equal(h.requests.length,1,'duplicate script tags and polling cannot duplicate PV');
  h.url.hash='#features';h.events.hashchange();assert.equal(h.requests.length,1,'ordinary anchor links are not page navigations');
  h.url.href='https://shop.example/cart';h.polls[0]();assert.equal(h.requests.length,2);assert.equal(h.requests[1].data.visitorId,first.data.visitorId);assert.notEqual(h.requests[1].data.eventId,first.data.eventId);
  h.url.hash='#/checkout?step=1';h.events.hashchange();assert.equal(h.requests.length,3);
  h.events.pageshow({persisted:false});assert.equal(h.requests.length,3);h.events.pageshow({persisted:true});assert.equal(h.requests.length,4);
  const reload=harness({storage:h.storage});assert.equal(reload.requests[0].data.visitorId,first.data.visitorId);assert.notEqual(reload.requests[0].data.eventId,first.data.eventId);
});

test('tracker waits for page metadata, survives blocked storage and retries transient failures with the same event identity',async()=>{
  const h=harness({loading:true,blocked:true,failures:1});assert.equal(h.requests.length,0);h.domEvents.DOMContentLoaded();await flush();assert.equal(h.requests.length,1);assert.equal(h.timers.length,1);h.timers.shift()();await flush();assert.equal(h.requests.length,2);assert.deepEqual(h.requests[0].data,h.requests[1].data,'retry is idempotent');
  h.url.pathname='/next';h.polls[0]();assert.equal(h.requests[2].data.visitorId,h.requests[0].data.visitorId);assert.equal(h.storage.size,0);
  const storage=new Map([['kivo.analytics:https://analytics.example:'+site,'-'.repeat(36)]]),fresh=harness({storage});assert.notEqual(fresh.requests[0].data.visitorId,'-'.repeat(36));
});
