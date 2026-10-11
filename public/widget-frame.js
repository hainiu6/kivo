/* global io */
const $ = id => document.getElementById(id);
let socket, parentOrigin, initialized = false, opened = false, rows = [], sending = false;
const siteId = new URLSearchParams(location.search).get('site');
function tell(type) { parent.postMessage({ kivo:true,type }, parentOrigin || '*'); }
function error(message) { $('error').textContent=message; $('error').hidden=!message; }
function render() {
  const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<80;
  $('message-items').replaceChildren();
  rows.forEach(m=>{
    const wrapper=document.createElement('div');wrapper.className=`message ${m.sender}`;
    const meta=document.createElement('div');meta.className='meta';meta.textContent=`${m.sender==='agent'?'客服':'你'} · ${new Date(m.created_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}`;
    const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=m.body;wrapper.append(meta,bubble);$('message-items').append(wrapper);
  });
  if(nearBottom)$('messages').scrollTop=$('messages').scrollHeight;
}
function add(m) { if(rows.some(r=>r.id===m.id))return;rows.push(m);rows.sort((a,b)=>a.id-b.id);render();if(m.sender==='agent'&&!opened)tell('unread'); }
function initialize(data, origin) {
  if(initialized||data.site?.id!==siteId||origin!==data.parentOrigin)return;
  const page=new URL(data.page);if(page.origin!==origin)return;
  initialized=true;parentOrigin=origin;opened=data.opened;
  document.documentElement.style.setProperty('--accent',data.site.color);$('site-name').textContent=data.site.name;$('greeting').textContent=data.site.greeting;
  socket=io({auth:{role:'visitor',siteId,visitorToken:data.visitorToken},reconnection:true});
  socket.on('connect',()=>{$('message-input').disabled=false;$('send').disabled=false;error('');socket.emit('visitor:page',{page:data.page});});
  socket.on('disconnect',()=>{$('agent-status').textContent='连接已断开，正在重连…';$('send').disabled=true;});
  socket.on('connect_error',()=>{$('agent-status').textContent='暂时无法连接';error('连接暂时不可用，正在自动重试。');$('send').disabled=true;});
  socket.on('agents:status',data=>$('agent-status').textContent=data.online?'● 客服在线，随时为你服务':'○ 客服暂时离线，请留言，我们会尽快回复');
  socket.on('history',messages=>{rows=messages;render();$('messages').scrollTop=$('messages').scrollHeight;});
  socket.on('message:new',add);
}
window.addEventListener('message',event=>{
  if(event.source!==parent||!event.data?.kivo)return;
  if(event.data.type==='init'){try{initialize(event.data,event.origin);}catch{error('初始化失败，请刷新页面重试。');}return;}
  if(event.origin!==parentOrigin)return;
  if(event.data.type==='page'){const page=event.data.page;if(typeof page==='string'&&new URL(page).origin===parentOrigin){socket?.emit('visitor:page',{page});}}
  if(event.data.type==='visibility'){opened=!!event.data.opened;if(opened){$('messages').scrollTop=$('messages').scrollHeight;$('message-input').focus();}}
});
$('close').onclick=()=>tell('close');document.addEventListener('keydown',e=>{if(e.key==='Escape')tell('close');});
$('message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('message-form').requestSubmit();}};
$('message-form').onsubmit=e=>{
  e.preventDefault();if(sending)return;const body=$('message-input').value.trim();if(!body)return;
  if(!socket?.connected){error('连接已断开，请稍后再试。');return;}
  sending=true;$('send').disabled=true;error('');
  socket.timeout(8000).emit('message:send',{body,clientId:window.kivoMessageId()},(err,result)=>{
    sending=false;$('send').disabled=!socket.connected;
    if(err||!result?.ok){error(err?'未收到发送确认，请查看聊天记录后重试。':result.error);return;}
    add(result.message);if($('message-input').value.trim()===body)$('message-input').value='';$('messages').scrollTop=$('messages').scrollHeight;
  });
};
tell('ready');
