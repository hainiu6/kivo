import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function setup(){
  const nodes=new Map(),requests=[],timers=new Map(),storage=new Map();let clock=0,changes=0;
  const node=()=>({value:'',children:[],hidden:false,textContent:'',dataset:{},style:{setProperty(){}},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},get firstChild(){return this.children[0];},get options(){return this.children;}});
  const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};get('#stats-days').value='7';
  const context={window:{},document:{querySelector:get,createElement:node,hidden:false},Date,URLSearchParams,setTimeout:handler=>{timers.set(++clock,handler);return clock;},clearTimeout:id=>timers.delete(id),setInterval:handler=>{timers.set(++clock,handler);return clock;},clearInterval:id=>timers.delete(id),sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
  vm.runInNewContext(readFileSync(new URL('../public/admin-stats.js',import.meta.url),'utf8'),context);vm.runInNewContext(readFileSync(new URL('../public/admin-state.js',import.meta.url),'utf8'),context);
  const stats=context.window.KivoStats.create({api:url=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})),onChange:()=>changes++});
  return{stats,get,requests,timers,state:context.window.KivoWorkspaceState,changes:()=>changes};
}
const data=count=>({start:Date.parse('2026-10-10T16:00:00Z'),end:Date.parse('2026-10-11T10:00:00Z'),summary:{newConversations:count,chatConversations:count,visitorMessages:count,agentMessages:0,autoMessages:0,textMessages:count,imageMessages:0,stickerMessages:0,onlineVisitors:0,unreadMessages:count,openConversations:count},daily:[{date:'2026-10-11',newConversations:count,visitorMessages:count,agentMessages:0,autoMessages:0}],sites:[]});

test('statistics filters restore, newest responses win, and late responses cannot reappear after logout',async()=>{
  const h=setup(),site='22222222-2222-4222-8222-222222222222';
  h.stats.setSites([{id:site,name:'商城'}]);h.state.save('admin',{view:'stats',statsDays:30,statsSite:site});h.stats.setFilters(h.state.load('admin'));
  assert.equal(h.state.load('admin').view,'stats');assert.equal(h.get('#stats-days').value,'30');assert.equal(h.get('#stats-site').value,site);
  h.stats.activate();assert.ok(h.requests[0].url.includes('days=30'));assert.ok(h.requests[0].url.includes(site));
  h.get('#stats-days').value='7';h.get('#stats-days').onchange();assert.equal(h.changes(),1);
  h.requests[1].resolve(data(2));await flush();assert.equal(h.get('#stats-cards').children[0].children[1].textContent,'2');
  h.requests[0].resolve(data(999));await flush();assert.equal(h.get('#stats-cards').children[0].children[1].textContent,'2');
  h.get('#stats-refresh').onclick();h.stats.reset();h.requests[2].resolve(data(99));await flush();assert.equal(h.get('#stats-content').hidden,true);assert.equal(h.get('#stats-refresh').disabled,false);assert.equal(h.timers.size,0);
});

test('empty statistics stay usable, a failed refresh can retry, and deleted website filters fall back to all sites',async()=>{
  const h=setup();h.stats.setSites([]);h.stats.setFilters({statsDays:7,statsSite:'22222222-2222-4222-8222-222222222222'});assert.equal(h.get('#stats-site').value,'');
  h.stats.activate();h.requests[0].reject(new Error('offline'));await flush();assert.match(h.get('#stats-error').textContent,/刷新重试/);assert.equal(h.get('#stats-loading').hidden,true);assert.equal(h.get('#stats-refresh').disabled,false);
  h.get('#stats-refresh').onclick();h.requests[1].resolve(data(0));await flush();assert.equal(h.get('#stats-content').hidden,false);assert.equal(h.get('#stats-sites-empty').hidden,false);assert.equal(h.get('#stats-error').textContent,'');assert.equal(h.get('#stats-trend').children[0].children[0].children[0].style.height,'0%');
  h.stats.deactivate();h.stats.schedule();assert.equal(h.requests.length,2);
});
