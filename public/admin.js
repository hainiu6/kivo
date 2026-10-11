/* global io */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let socket, publicUrl, sites = [], conversations = [], activeId = null, activeMessages = [], status = 'open', view = 'inbox', selectionRevision = 0, listRevision = 0;
let loadingMessages = false, sending = false, toastTimer;
let pendingMessages = [];
const drafts = new Map();
const date = ms => new Date(ms).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
const clock = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false });
function element(tag, className, content) { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = content; return el; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4000); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && url !== '/api/login') showLogin(); throw new Error(data.error || '请求失败'); }
  return data;
}
const post = (url, data = {}) => api(url,{method:'POST',body:JSON.stringify(data)});
function showLogin() { socket?.disconnect(); $('#workspace').hidden = true; $('#login-screen').hidden = false; activeId = null; }
function switchView(next) {
  view = next; ['inbox','sites','settings'].forEach(v => $(`#view-${v}`).hidden = v !== next);
  $$('.nav-button').forEach(b => b.classList.toggle('active',b.dataset.view === next));
  $('#page-label').textContent = {inbox:'会话收件箱',sites:'网站接入',settings:'账号设置'}[next];
  if (next === 'inbox') loadConversations().catch(e => toast(e.message));
}
async function start() {
  const me = await api('/api/admin/me'); publicUrl = me.publicUrl;
  $('#account-name').textContent = me.username; $('#service-url').textContent = publicUrl;
  $('#today').textContent = new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
  await loadSites(); await loadConversations();
  $('#login-screen').hidden = true; $('#workspace').hidden = false;
  socket?.disconnect(); socket = io({ auth:{role:'admin'}, reconnection:true });
  socket.on('connect', () => {
    $('#connection-label').textContent = '在线接待中'; $('#connection-dot').classList.remove('offline'); $('#send-message').disabled = false;
    loadConversations().catch(e => toast(e.message));
    if (activeId) selectConversation(activeId).catch(e => toast(e.message));
  });
  socket.on('disconnect', () => { $('#connection-label').textContent = '连接已断开'; $('#connection-dot').classList.add('offline'); $('#send-message').disabled = true; });
  socket.on('connect_error', e => { $('#connection-label').textContent = '正在重新连接'; $('#connection-dot').classList.add('offline'); $('#send-message').disabled = true; if (e.message === '登录已过期') showLogin(); });
  socket.on('conversation:update', c => {
    if (!c) return;
    const index = conversations.findIndex(item => item.id === c.id);
    const matches = (!status || c.status === status) && (!$('#site-filter').value || c.site_id === $('#site-filter').value) && (!$('#search').value || [c.name,c.ip,c.page].some(s => s.toLowerCase().includes($('#search').value.toLowerCase())));
    if (matches) { if (index >= 0) conversations[index] = c; else conversations.unshift(c); }
    else if (index >= 0) conversations.splice(index,1);
    renderConversations(); if (activeId === c.id) renderDetails(c);
  });
  socket.on('message:new', message => {
    if (message.conversation_id === activeId) {
      if (loadingMessages) pendingMessages.push(message);
      else { addMessage(message); if (view === 'inbox' && !document.hidden) markRead(); }
    }
  });
}
async function loadSites() {
  sites = await api('/api/admin/sites');
  const selected = $('#site-filter').value;
  $('#site-filter').replaceChildren(element('option','','所有网站')); $('#site-filter').firstChild.value = '';
  sites.forEach(s => { const opt = element('option','',s.name); opt.value=s.id; $('#site-filter').append(opt); });
  $('#site-filter').value = sites.some(s=>s.id===selected) ? selected : '';
  renderSites();
}
async function loadConversations() {
  const revision = ++listRevision;
  const params = new URLSearchParams({status,q:$('#search').value,site:$('#site-filter').value});
  const rows = await api(`/api/admin/conversations?${params}`);
  if (revision !== listRevision) return;
  conversations=rows;renderConversations();
}
function renderConversations() {
  conversations.sort((a,b) => b.updated_at-a.updated_at); conversations=conversations.slice(0,200);
  $('#list-count').textContent = conversations.length;
  const total = conversations.reduce((sum,c)=>sum+c.unread,0);
  $('#nav-unread').textContent = total > 99 ? '99+' : total; $('#nav-unread').hidden = !total;
  document.title = total ? `(${total}) Kivo · 客服工作台` : 'Kivo · 客服工作台';
  const list = $('#conversations'); list.replaceChildren();
  if (!conversations.length) { list.append(element('div','list-empty',sites.length ? '暂无匹配会话。\n访客打开接入的网站后，会出现在这里。' : '还没有接入网站。\n点击「网站接入」开始设置。')); return; }
  conversations.forEach(c => {
    const row = element('button',`conversation-row${activeId===c.id?' selected':''}`); row.type='button';
    row.append(element('span','avatar',c.name.slice(-2)));
    const content = element('div','row-content'), title=element('div','row-title');
    title.append(element('strong','',c.name),element('time','',clock(c.updated_at)));
    const sub=element('div','row-site'); const dot=element('span','status-dot'+(c.online?'':' offline'));sub.append(dot,document.createTextNode(c.site_name));
    if(c.unread) sub.append(element('span','unread-badge',c.unread>99?'99+':c.unread));
    content.append(title,element('div','row-preview',c.last_message||'访客已打开页面'),sub);row.append(content);
    row.onclick=()=>selectConversation(c.id).catch(e=>toast(e.message));list.append(row);
  });
}
function renderDetails(c) {
  $('#chat-empty').hidden=true; $('#chat-active').hidden=false; $('#visitor-empty').hidden=true;$('#visitor-details').hidden=false;
  $('#chat-name').textContent=c.name;$('#chat-meta').textContent=`${c.online?'访客在线':'访客离线'} · ${c.site_name}`;
  $('#chat-avatar').textContent=c.name.slice(-2);$('#visitor-avatar').textContent=c.name.slice(-2);$('#visitor-name').textContent=c.name;
  $('#visitor-status').textContent=c.online?'● 在线':'● 离线';$('#visitor-status').classList.toggle('offline',!c.online);
  $('#visitor-ip').textContent=c.ip;$('#visitor-region').textContent=c.region;$('#visitor-site').textContent=c.site_name;
  $('#visitor-page').textContent=c.page;$('#visitor-page').href=c.page;
  $('#visitor-created').textContent=date(c.created_at);$('#visitor-updated').textContent=date(c.updated_at);
  $('#visitor-conversation-status').textContent=c.status==='closed'?'已结束':'进行中';
  $('#close-conversation').textContent=c.status==='closed'?'重新打开':'结束会话';$('#close-conversation').dataset.status=c.status;
}
async function selectConversation(id) {
  if (activeId) drafts.set(activeId,$('#message-input').value);
  activeId=id;const revision=++selectionRevision;loadingMessages=true;pendingMessages=[];
  renderConversations();const c=conversations.find(c=>c.id===id);if(c)renderDetails(c);
  $('.inbox-grid').classList.add('chat-selected');$('#message-items').replaceChildren(element('div','muted','正在加载对话…'));
  $('#message-input').value=drafts.get(id)||'';$('#send-error').textContent='';$('#send-message').disabled=true;
  try {
    const rows=await api(`/api/admin/conversations/${id}/messages`);
    if(revision!==selectionRevision)return;
    activeMessages=[...new Map([...rows,...pendingMessages].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id);pendingMessages=[];renderMessages();$('#messages').scrollTop=$('#messages').scrollHeight;$('#older-messages').hidden=rows.length<100;
    loadingMessages=false;$('#send-message').disabled=!socket?.connected;markRead();
  } catch(e) { if(revision===selectionRevision){loadingMessages=false;$('#message-items').replaceChildren(element('p','error',e.message));} throw e; }
}
function renderMessages() {
  const container=$('#message-items');container.replaceChildren();
  if(!activeMessages.length)container.append(element('p','muted','访客还没有发送消息。用一句问候开始对话吧。'));
  activeMessages.forEach(m=>{
    const row=element('div',`message-row ${m.sender}`);row.append(element('div','message-meta',`${m.sender==='agent'?'客服':'访客'} · ${date(m.created_at)}`),element('div','bubble',m.body));container.append(row);
  });
}
function addMessage(m) {
  if(activeMessages.some(item=>item.id===m.id))return;
  const bottom=$('#messages').scrollHeight-$('#messages').scrollTop-$('#messages').clientHeight<100;
  activeMessages.push(m);activeMessages.sort((a,b)=>a.id-b.id);renderMessages();if(bottom||m.sender==='agent')$('#messages').scrollTop=$('#messages').scrollHeight;
}
function markRead() {
  if(!activeId||loadingMessages||document.hidden||view!=='inbox')return;
  post(`/api/admin/conversations/${activeId}/read`,{lastId:activeMessages.at(-1)?.id||0}).catch(e=>toast(e.message));
}
function embedCode(s) { return `<script src="${publicUrl}/widget.js" data-site="${s.id}" async></script>`; }
function renderSites() {
  const list=$('#sites-list');list.replaceChildren();
  if(!sites.length){const empty=element('div','panel');empty.append(element('h2','','准备好接待第一位访客了吗？'),element('p','muted','添加网站后，复制生成的 JavaScript 代码到网页，即可启用右下角的客服窗口。'));list.append(empty);return;}
  sites.forEach(s=>{
    const card=element('article','site-card'),header=element('div','site-card-header');const edit=element('button','button secondary small','编辑设置');edit.onclick=()=>openSite(s);header.append(element('h2','',s.name),edit);
    const origins=element('div','site-origins');s.origins.forEach(o=>origins.append(element('span','',o)));
    const code=element('textarea','embed-code');code.value=embedCode(s);code.readOnly=true;code.setAttribute('aria-label',`${s.name} 的嵌入代码`);
    const actions=element('div','site-actions');const copy=element('button','button primary small','复制嵌入代码');copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.value);toast('嵌入代码已复制');}catch{code.select();toast('请按 Ctrl+C / ⌘C 复制选中的代码');}};
    const demo=element('a','text-link','打开测试页面 ↗');demo.href=`/demo?site=${encodeURIComponent(s.id)}`;demo.target='_blank';demo.rel='noopener';actions.append(copy,demo);
    card.append(header,origins,element('p','',s.greeting),code,actions);list.append(card);
  });
}
function openSite(s) {
  const f=$('#site-form');f.reset();f.elements.id.value=s?.id||'';f.elements.name.value=s?.name||'';f.elements.origins.value=s?.origins.join('\n')||'';f.elements.color.value=s?.color||'#0f766e';f.elements.greeting.value=s?.greeting||'你好，欢迎联系我们！有什么可以帮你？';$('#site-form-title').textContent=s?'编辑网站':'添加网站';$('#site-error').textContent='';$('#site-dialog').showModal();
}
$('#login-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button');b.disabled=true;$('#login-error').textContent='';try{await post('/api/login',Object.fromEntries(new FormData(f)));await start();f.elements.password.value='';}catch(e){$('#login-error').textContent=e.message;}finally{b.disabled=false;}};
$$('.nav-button').forEach(b=>b.onclick=()=>switchView(b.dataset.view));$('#guide-sites').onclick=$('#empty-sites').onclick=()=>switchView('sites');
$('#logout').onclick=$('#settings-logout').onclick=async()=>{try{await post('/api/admin/logout');showLogin();}catch(e){toast(e.message);}};
let searchTimer;$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadConversations().catch(e=>toast(e.message)),250);};
$('#refresh').onclick=()=>loadConversations().then(()=>toast('会话已刷新')).catch(e=>toast(e.message));$('#site-filter').onchange=()=>loadConversations().catch(e=>toast(e.message));
$$('[data-status]').forEach(b=>b.onclick=()=>{status=b.dataset.status;$$('[data-status]').forEach(x=>x.classList.toggle('active',x===b));loadConversations().catch(e=>toast(e.message));});
$('#back-list').onclick=()=>$('.inbox-grid').classList.remove('chat-selected');
$('#toggle-visitor').onclick=()=>{const open=$('.inbox-grid').classList.toggle('show-details');$('#toggle-visitor').setAttribute('aria-expanded',String(open));};
$('#close-visitor').onclick=()=>{$('.inbox-grid').classList.remove('show-details');$('#toggle-visitor').setAttribute('aria-expanded','false');$('#toggle-visitor').focus();};
$('#close-conversation').onclick=async()=>{try{await post(`/api/admin/conversations/${activeId}/status`,{status:$('#close-conversation').dataset.status==='closed'?'open':'closed'});}catch(e){toast(e.message);}};
$$('[data-reply]').forEach(b=>b.onclick=()=>{$('#message-input').value=b.dataset.reply;$('#message-input').focus();});
$('#message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#message-form').requestSubmit();}};
$('#message-form').onsubmit=e=>{
  e.preventDefault();if(!activeId||loadingMessages||sending)return;const body=$('#message-input').value.trim();if(!body)return;
  if(!socket?.connected){$('#send-error').textContent='连接已断开，请等待重新连接后发送';return;}
  const id=activeId;const clientId=window.kivoMessageId();sending=true;$('#send-message').disabled=true;$('#send-error').textContent='';
  socket.timeout(8000).emit('message:send',{conversationId:id,body,clientId},(error,result)=>{
    sending=false;$('#send-message').disabled=!socket.connected;
    if(error||!result?.ok){$('#send-error').textContent=error?'未收到发送确认，请刷新检查聊天记录后重试':result.error;return;}
    drafts.delete(id);if(activeId===id){addMessage(result.message);if($('#message-input').value.trim()===body)$('#message-input').value='';}
  });
};
$('#older-messages').onclick=async()=>{const id=activeId,button=$('#older-messages');button.disabled=true;try{const rows=await api(`/api/admin/conversations/${id}/messages?before=${activeMessages[0]?.id||0}`);if(id!==activeId)return;const height=$('#messages').scrollHeight;activeMessages=[...rows,...activeMessages];renderMessages();$('#messages').scrollTop+=$('#messages').scrollHeight-height;button.hidden=rows.length<100;}catch(e){toast(e.message);}finally{button.disabled=false;}};
$('#add-site').onclick=()=>openSite();$('#close-dialog').onclick=()=>$('#site-dialog').close();
$('#site-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('[type="submit"]');b.disabled=true;$('#site-error').textContent='';const fields=Object.fromEntries(new FormData(f));fields.origins=fields.origins.split(/\n|,/).map(v=>v.trim()).filter(Boolean);try{await api(fields.id?`/api/admin/sites/${fields.id}`:'/api/admin/sites',{method:fields.id?'PUT':'POST',body:JSON.stringify(fields)});await loadSites();$('#site-dialog').close();toast('网站设置已保存');}catch(e){$('#site-error').textContent=e.message;}finally{b.disabled=false;}};
$('#password-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,data=Object.fromEntries(new FormData(f));if(data.newPassword!==data.confirmPassword){toast('两次输入的新密码不一致');return;}const b=f.querySelector('button');b.disabled=true;try{await post('/api/admin/password',data);f.reset();showLogin();toast('密码已更新，请重新登录');}catch(e){toast(e.message);}finally{b.disabled=false;}};
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&socket?.connected){if(activeId)selectConversation(activeId).catch(e=>toast(e.message));loadConversations().catch(e=>toast(e.message));}});
start().catch(e=>{showLogin();if(!e.message.includes('先登录'))$('#login-error').textContent=e.message;});
