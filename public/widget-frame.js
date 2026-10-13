/* global io, KivoChat */
const $ = id => document.getElementById(id);
let socket, parentOrigin, currentPage, initialized = false, opened = false, rows = [], sending = false;
let conversationId, generation=0, hasIdentity=false, pageVisible=true, lastReadSent=0, readQueued=false;
let visitorToken, supportName='在线客服', avatarUrl='/support-avatar.svg';
let deletedMessageIds=new Set(), clearedThroughId=0;
const visibleMessage=m=>m.id>clearedThroughId&&!deletedMessageIds.has(m.id);
const siteId = new URLSearchParams(location.search).get('site');
const authHeaders = () => ({Authorization:`Bearer ${visitorToken}`,'X-Kivo-Site':siteId});
const composer = KivoChat.composer({form:$('message-form'),input:$('message-input'),tools:$('chat-tools'),preview:$('attachment-preview'),dropTarget:document.body,getContext:()=>socket?.connected&&!sending?siteId:'',uploadUrl:()=>'/api/widget/images',headers:authHeaders,onError:error,onSubmitLock:locked=>$('send').disabled=locked||sending||!socket?.connected});
function tell(type) { parent.postMessage({ kivo:true,type }, parentOrigin || '*'); }
function error(message) { $('error').textContent=message; $('error').hidden=!message; }
function setAgentStatus(state, label, hint='') {
  $('agent-status').dataset.state=state;
  $('agent-status').textContent=label;
  $('agent-status-hint').textContent=hint;
  $('agent-status-hint').hidden=!hint;
}
function render() {
  const nearBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<80;
  KivoChat.reconcileMessages($('message-items'),rows,m=>{
    const wrapper=document.createElement('div');wrapper.className=`message ${m.sender==='auto'?'agent auto':m.sender}`;
    if(m.sender!=='visitor'){const avatar=document.createElement('img');avatar.className='message-avatar';avatar.src=m.sender==='auto'?'/support-avatar.svg':avatarUrl;avatar.alt=m.sender==='auto'?'自动回复':supportName;wrapper.append(avatar);}
    const content=document.createElement('div');content.className='message-content';
    const meta=document.createElement('div');meta.className='meta';meta.textContent=`${m.sender==='auto'?'自动回复':m.sender==='agent'?supportName:'你'} · ${new Date(m.created_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}`;
    content.append(meta,KivoChat.renderMessage(m,{headers:authHeaders(),onImageLoad:()=>{if(nearBottom)$('messages').scrollTop=$('messages').scrollHeight;queueRead();}}));wrapper.append(content);return wrapper;
  });
  if(nearBottom)$('messages').scrollTop=$('messages').scrollHeight;
  queueRead();
}
function queueRead(){if(readQueued)return;readQueued=true;Promise.resolve().then(()=>{readQueued=false;markVisibleRead();});}
function markVisibleRead(){
  if(!opened||!pageVisible||document.hidden||!socket?.connected)return;
  const panel=$('messages').getBoundingClientRect();let lastId=0;
  for(const node of $('message-items').children){
    const m=rows.find(m=>m.id===Number(node.dataset.messageId));if(!m||m.sender==='visitor')continue;
    if(m.kind==='image'&&!node.querySelector('.image-message img'))continue;
    const rect=node.getBoundingClientRect();if(rect.top<panel.bottom&&rect.bottom<=panel.bottom+1&&rect.bottom>panel.top)lastId=Math.max(lastId,m.id);
  }
  if(lastId<=lastReadSent)return;
  const id=conversationId,previous=lastReadSent;lastReadSent=lastId;
  socket.timeout(5000).emit('visitor:read',{lastId},(err,result)=>{if(id===conversationId&&(err||!result?.ok))lastReadSent=previous;});
}
function add(m) { if(!visibleMessage(m)||rows.some(r=>r.id===m.id))return;rows.push(m);rows.sort((a,b)=>a.id-b.id);render();if(m.sender!=='visitor'&&!opened)tell('unread'); }
function reset() {
  generation++;socket?.removeAllListeners();socket?.disconnect();socket=null;initialized=false;sending=false;rows=[];visitorToken=undefined;conversationId=null;hasIdentity=false;lastReadSent=0;
  deletedMessageIds=new Set();clearedThroughId=0;composer.clear();composer.closePicker();KivoChat.clearImages();$('message-items').replaceChildren();$('message-input').value='';$('message-input').disabled=true;$('send').disabled=true;$('restart-conversation').hidden=true;setAgentStatus('connecting','正在连接…');error('');
}
function initialize(data, origin) {
  if(data.site?.id!==siteId||origin!==data.parentOrigin)return;
  const page=new URL(data.page);if(page.origin!==origin)return;
  if(initialized&&conversationId===data.conversationId) {
    visitorToken=data.visitorToken;socket.auth={role:'visitor',siteId,visitorToken};
    if(socket.connected)socket.emit('visitor:identity',{visitorToken},result=>{if(!result?.ok)error('用户身份更新失败，请刷新页面');});
    else socket.connect();
    return;
  }
  reset();initialized=true;parentOrigin=origin;opened=data.opened;pageVisible=data.pageVisible!==false;currentPage=data.page;visitorToken=data.visitorToken;conversationId=data.conversationId;hasIdentity=!!data.identity;
  supportName=data.site.supportName||'在线客服';avatarUrl=/^\/avatars\/[\da-f-]{36}$/.test(data.site.avatarUrl||'')?data.site.avatarUrl:'/support-avatar.svg';
  document.documentElement.style.setProperty('--accent',data.site.color);document.documentElement.style.setProperty('--accent-ink',KivoChat.contrast(data.site.color));$('site-name').textContent=supportName;$('support-avatar').src=avatarUrl;$('greeting').textContent=data.site.greeting;
  socket=io({auth:{role:'visitor',siteId,visitorToken:data.visitorToken},reconnection:true});
  socket.on('connect',()=>{lastReadSent=0;queueRead();$('message-input').disabled=false;$('send').disabled=sending||composer.isUploading();error('');socket.emit('visitor:page',{page:currentPage});});
  socket.on('disconnect',reason=>{if(hasIdentity&&reason==='io server disconnect')tell('identity-expired');setAgentStatus('connecting','正在重新连接…');$('send').disabled=true;});
  socket.on('connect_error',()=>{if(hasIdentity)tell('identity-expired');setAgentStatus('error','暂时无法连接');error('连接暂时不可用，正在自动重试。');$('send').disabled=true;});
  socket.on('agents:status',data=>setAgentStatus(data.online?'online':'offline',data.online?'客服在线':'客服离线',data.online?'随时为你服务':'请留言，我们会尽快回复'));
  socket.on('history',messages=>{const first=!rows.length;rows=messages.filter(visibleMessage);render();if(first)$('messages').scrollTop=$('messages').scrollHeight;queueRead();});
  socket.on('message:new',add);
  socket.on('message:deleted',data=>{if(data.conversationId!==conversationId)return;deletedMessageIds.add(data.messageId);rows=rows.filter(visibleMessage);KivoChat.forgetImages(data.mediaIds);render();});
  socket.on('history:cleared',data=>{if(data.conversationId!==conversationId)return;clearedThroughId=Math.max(clearedThroughId,data.throughId);rows=rows.filter(visibleMessage);composer.clear();KivoChat.clearImages();$('message-input').value='';render();});
  socket.on('conversation:deleted',data=>{if(data.conversationId!==conversationId)return;reset();setAgentStatus('deleted','对话记录已删除');error('客服已删除这段会话记录。你可以开始新对话。');$('restart-conversation').hidden=false;tell('conversation-deleted');});
}
window.addEventListener('message',event=>{
  if(event.source!==parent||!event.data?.kivo)return;
  if(event.data.type==='init'){try{initialize(event.data,event.origin);}catch{error('初始化失败，请刷新页面重试。');}return;}
  if(event.origin!==parentOrigin)return;
  if(event.data.type==='reset'){reset();return;}
  if(event.data.type==='page'){const page=event.data.page;try{if(typeof page==='string'&&new URL(page).origin===parentOrigin){currentPage=page;if(socket?.connected)socket.emit('visitor:page',{page});}}catch{/* Ignore invalid host page notifications. */}}
  if(event.data.type==='page-visibility'){pageVisible=!!event.data.visible;queueRead();}
  if(event.data.type==='visibility'){opened=!!event.data.opened;if(opened){$('messages').scrollTop=$('messages').scrollHeight;if(event.data.focus!==false)$('message-input').focus();queueRead();}}
});
$('messages').addEventListener('scroll',queueRead,{passive:true});
document.addEventListener('visibilitychange',queueRead);window.addEventListener('focus',queueRead);
$('close').onclick=()=>tell('close');document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('dialog[open]'))tell('close');});
$('restart-conversation').onclick=()=>{$('restart-conversation').hidden=true;setAgentStatus('connecting','正在连接…');error('');tell('restart-conversation');};
$('message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('message-form').requestSubmit();}};
$('message-form').onsubmit=e=>{
  e.preventDefault();if(sending||composer.isUploading())return;const body=$('message-input').value.trim();if(!body&&!composer.hasAttachment())return;
  if(!socket?.connected){error('连接已断开，请稍后再试。');return;}
  sending=true;$('send').disabled=true;error('');
  const currentGeneration=generation;
  const attachment=composer.payload();
  socket.timeout(8000).emit('message:send',{...attachment,body,clientId:window.kivoMessageId()},(err,result)=>{
    if(currentGeneration!==generation)return;
    sending=false;$('send').disabled=!socket.connected;
    if(err||!result?.ok){error(err?'未收到发送确认，请查看聊天记录后重试。':result.error);return;}
    add(result.message);composer.clear();if($('message-input').value.trim()===body)$('message-input').value='';$('messages').scrollTop=$('messages').scrollHeight;
  });
};
tell('ready');
