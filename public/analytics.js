(function(){
  'use strict';
  const script=document.currentScript,siteId=script?.getAttribute('data-site');
  if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(siteId||''))return;
  const service=new URL(script.src).origin,key='kivo.analytics:'+service+':'+siteId;
  const loaded=window.__kivoAnalyticsSites||(window.__kivoAnalyticsSites=new Set());if(loaded.has(key))return;loaded.add(key);
  const uuid=()=>{
    const bytes=new Uint8Array(16);if(window.crypto?.getRandomValues)window.crypto.getRandomValues(bytes);else for(let i=0;i<16;i++)bytes[i]=Math.floor(Math.random()*256);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  };
  let visitorId;
  try{visitorId=localStorage.getItem(key);}catch{}
  if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(visitorId||'')){visitorId=uuid();try{localStorage.setItem(key,visitorId);}catch{}}
  let lastPage='',started=false;
  const route=()=>{const u=new URL(location.href);return u.origin+u.pathname+u.search+(u.hash.startsWith('#/')?u.hash:'');};
  function track(force=false){
    if(!['http:','https:'].includes(location.protocol))return;
    const current=route();if(!force&&current===lastPage)return;
    const previous=lastPage;lastPage=current;
    const body=JSON.stringify({siteId,eventId:uuid(),visitorId,page:location.href.slice(0,2048),title:document.title.slice(0,200),referrer:(previous||document.referrer||'').slice(0,2048)});
    const send=retry=>{
      try{Promise.resolve(fetch(service+'/api/analytics/collect',{method:'POST',mode:'cors',credentials:'omit',keepalive:true,headers:{'Content-Type':'text/plain'},body})).then(response=>{if(response.status>=500)throw Error('retry');}).catch(()=>{if(retry)setTimeout(()=>send(false),3000);});}catch{if(retry)setTimeout(()=>send(false),3000);}
    };send(true);
  }
  function start(){if(started)return;started=true;track();setInterval(()=>{if(!document.hidden)track();},1000);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.addEventListener('popstate',()=>{if(started)track();});
  window.addEventListener('hashchange',()=>{if(started)track();});
  window.addEventListener('pageshow',event=>{if(started&&event.persisted)track(true);});
})();
