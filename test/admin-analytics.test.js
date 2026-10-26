import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();},site='11111111-1111-4111-8111-111111111111';
function harness(){
  const nodes=new Map(),requests=[],timers=new Map(),storage=new Map();let next=0;
  const node=()=>{const classes=new Set();return{children:[],value:'',hidden:false,style:{setProperty(){}},dataset:{},classList:{toggle:(key,value)=>value?classes.add(key):classes.delete(key),contains:key=>classes.has(key)},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},get firstChild(){return this.children[0];},setAttribute(){},focus(){},select(){},showModal(){this.open=true;},close(){this.open=false;},reset(){},get options(){return this.children;},scrollWidth:300};};
  const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};get('#analytics-site-form').elements={id:node(),name:node()};
  const context={window:{},navigator:{clipboard:{writeText:async()=>{}}},document:{querySelector:get,createElement:node,hidden:false},Date,URLSearchParams,Promise,Map,Set,Object,setTimeout:handler=>{timers.set(++next,handler);return next;},clearTimeout:key=>timers.delete(key),setInterval:handler=>{timers.set(++next,handler);return next;},clearInterval:key=>timers.delete(key),sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
  vm.runInNewContext(readFileSync(new URL('../public/admin-analytics.js',import.meta.url),'utf8'),context);vm.runInNewContext(readFileSync(new URL('../public/admin-state.js',import.meta.url),'utf8'),context);
  const analytics=context.window.KivoAnalytics.create({api:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),publicUrl:()=> 'https://tracking.example',onChange(){},onMessage(){}});
  return{analytics,get,requests,timers,state:context.window.KivoWorkspaceState};
}
const data=pv=>({start:Date.parse('2026-10-11T16:00:00Z'),end:Date.parse('2026-10-12T01:00:00Z'),summary:{pv,uv:1,ips:1,pages:1},daily:[{date:'2026-10-12',pv,uv:1}],sites:[{id:site,name:'测试站点',pv,uv:1,lastVisit:1}],pages:{total:1,page:1,pages:1,items:[{page:'https://shop.example/product',title:'商品',pv,uv:1,lastVisit:1}]},visitors:{total:1,page:1,pages:1,items:[]},domains:[],sources:[]});

test('analytics restores its view and filters, generates domain-free embed code and rejects stale statistics after changes/logout',async()=>{
  const h=harness();h.state.save('admin',{view:'analytics',analyticsDays:30,analyticsSite:site,analyticsTab:'visitors'});h.analytics.setFilters(h.state.load('admin'));
  assert.equal(h.state.load('admin').view,'analytics');assert.equal(h.get('#analytics-visitors-panel').hidden,false);
  h.analytics.activate();h.requests[0].resolve([{id:site,name:'任意网站'}]);await flush();
  assert.match(h.get('#analytics-site-list').children[0].children[1].value,/https:\/\/tracking.example\/analytics.js/);assert.equal(h.requests[1].url.includes('days=30'),true);assert.equal(h.requests[1].url.includes(site),true);
  h.get('#analytics-days').value='7';h.get('#analytics-days').onchange();h.requests[2].resolve(data(2));await flush();assert.equal(h.get('#analytics-cards').children[0].children[1].textContent,'2');
  h.requests[1].resolve(data(999));await flush();assert.equal(h.get('#analytics-cards').children[0].children[1].textContent,'2');
  h.get('#analytics-pages-next').onclick();assert.match(h.requests[3].url,/pagesPage=2/);
  h.analytics.reset();h.requests[3].resolve(data(900));await flush();assert.equal(h.get('#analytics-content').hidden,true);assert.equal(h.timers.size,0);
});

test('site creation selects the new site and exposes code; empty and failed analytics can recover',async()=>{
  const h=harness();h.analytics.activate();h.requests[0].resolve([]);await flush();assert.equal(h.get('#analytics-setup').open,true);assert.equal(h.get('#analytics-sites-empty').hidden,false);
  h.requests[1].reject(Error('offline'));await flush();assert.match(h.get('#analytics-error').textContent,/刷新/);
  h.get('#analytics-add-site').onclick();const form=h.get('#analytics-site-form');form.elements.name.value='商城';const save=form.onsubmit({preventDefault(){},currentTarget:form});
  const create=h.requests[2];assert.equal(create.options.method,'POST');assert.deepEqual(JSON.parse(create.options.body),{name:'商城'});create.resolve({id:site});await flush();h.requests[3].resolve([{id:site,name:'商城'}]);await flush();h.requests[4].resolve(data(0));await save;
  assert.equal(h.analytics.getFilters().analyticsSite,site);assert.equal(h.get('#analytics-site-list').children.length,1);assert.equal(h.get('#analytics-site-dialog').open,false);assert.equal(h.get('#analytics-error').textContent,'');
  h.get('#analytics-pages-next').onclick();h.requests[5].resolve(data(3));await flush();assert.equal(h.get('#analytics-cards').children[0].children[1].textContent,'3');
});

test('daily chart exposes immediate PV/UV values, exact dates and keyboard/touch focus including zero traffic days',async()=>{
  const h=harness();h.analytics.activate();h.requests[0].resolve([]);await flush();
  const stats=data(12345);stats.daily.push({date:'2026-10-13',pv:0,uv:0});h.requests[1].resolve(stats);await flush();
  const columns=h.get('#analytics-trend').children;assert.equal(columns.length,2);
  for(const column of columns)assert.equal(column.tabIndex,0);
  assert.equal(columns[0].children[2].children[0].textContent,'2026-10-12');assert.match(columns[0].children[2].children[1].textContent,/12,345/);assert.match(columns[0].children[2].children[2].textContent,/UV  1/);
  assert.equal(columns[1].children[2].children[1].textContent,'浏览量 PV  0');assert.equal(columns[1].children[2].children[2].textContent,'访客数 UV  0');
  columns[0].onclick();
});
