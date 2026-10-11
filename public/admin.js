/* global io, KivoChat */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let socket, publicUrl, sites = [], conversations = [], activeId = null, activeMessages = [], status = 'open', view = 'inbox', selectionRevision = 0, listRevision = 0;
let loadingMessages = false, sending = false, toastTimer;
let pendingMessages = [];
let replies = [];
let avatarUploading=false, avatarRevision=0;
const composer = KivoChat.composer({form:$('#message-form'),input:$('#message-input'),tools:$('#chat-tools'),preview:$('#attachment-preview'),dropTarget:$('#chat-active'),getContext:()=>socket?.connected&&!loadingMessages&&!sending?activeId:'',uploadUrl:id=>`/api/admin/conversations/${id}/images`,onError:message=>$('#send-error').textContent=message,onSubmitLock:locked=>$('#send-message').disabled=locked||sending||loadingMessages||!socket?.connected});
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
function showLogin() { socket?.disconnect(); composer.destroy(); KivoChat.clearImages(); $('#workspace').hidden = true; $('#login-screen').hidden = false; activeId = null; $('#chat-empty').hidden = false; $('#chat-active').hidden = true; $('#visitor-empty').hidden = false; $('#visitor-details').hidden = true; }
function switchView(next) {
  view = next; ['inbox','sites','replies','settings'].forEach(v => $(`#view-${v}`).hidden = v !== next);
  $('#workspace').classList.toggle('inbox-mode', next === 'inbox');
  $$('.nav-button').forEach(b => b.classList.toggle('active',b.dataset.view === next));
  $('#page-label').textContent = {inbox:'会话收件箱',sites:'网站接入',replies:'回复设置',settings:'账号设置'}[next];
  if (next === 'inbox') loadConversations().catch(e => toast(e.message));
}
async function start() {
  const me = await api('/api/admin/me'); publicUrl = me.publicUrl;
  $('#account-name').textContent = me.username; $('#service-url').textContent = publicUrl;
  $('#today').textContent = new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
  await loadSites(); await loadConversations(); await loadReplies();
  switchView(view);
  $('#login-screen').hidden = true; $('#workspace').hidden = false;
  socket?.disconnect(); socket = io({ auth:{role:'admin'}, reconnection:true });
  socket.on('connect', () => {
    $('#connection-label').textContent = '在线接待中'; $('#connection-dot').classList.remove('offline'); $('#send-message').disabled = sending||composer.isUploading();
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
  socket.on('replies:update', rows => { replies = rows; renderQuickReplies(); });
}
async function loadReplies() { replies = await api('/api/admin/replies'); renderQuickReplies(); renderReplyEditor(); }
function renderQuickReplies() {
  $('#quick-replies').replaceChildren();
  replies.forEach(r => { const b = element('button', '', r.label); b.type = 'button'; b.title = r.body; b.onclick = () => { $('#message-input').value = r.body; $('#message-input').focus(); }; $('#quick-replies').append(b); });
}
function updateReplyCount() { const n = $('#reply-editor').children.length; $('#reply-count').textContent = `(${n}/20)`; $('#add-reply').disabled = n >= 20; }
function appendReply(r = {label:'',body:''}) {
  const row = element('div', 'reply-row'), heading = element('div', 'reply-row-heading');
  const label = element('label', '', '话术名称'), input = element('input'); input.value = r.label; input.maxLength = 40; input.required = true; input.placeholder = '例如：配送时间'; input.dataset.field = 'label'; label.append(input);
  const remove = element('button', 'button small secondary', '删除'); remove.type = 'button'; remove.onclick = () => { row.remove(); updateReplyCount(); };
  heading.append(label, remove); const body = element('label', '', '话术内容'), area = element('textarea'); area.value = r.body; area.rows = 3; area.required = true; area.maxLength = 2000; area.dataset.field = 'body'; body.append(area);
  row.append(heading, body); $('#reply-editor').append(row); updateReplyCount(); return input;
}
function renderReplyEditor() { $('#reply-editor').replaceChildren(); replies.forEach(appendReply); updateReplyCount(); }
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
  $('#visitor-os').textContent=c.os||'未知系统';$('#visitor-browser').textContent=c.browser||'未知浏览器';
  $('#visitor-page').textContent=c.page;$('#visitor-page').href=c.page;
  $('#visitor-created').textContent=date(c.created_at);$('#visitor-updated').textContent=date(c.updated_at);
  $('#visitor-conversation-status').textContent=c.status==='closed'?'已结束':'进行中';
  $('#close-conversation').textContent=c.status==='closed'?'重新打开':'结束会话';$('#close-conversation').dataset.status=c.status;
}
async function selectConversation(id) {
  if (activeId) drafts.set(activeId,$('#message-input').value);
  if(activeId!==id){composer.clear();composer.closePicker();KivoChat.clearImages();}
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
    const row=element('div',`message-row ${m.sender}`);row.append(element('div','message-meta',`${m.sender==='auto'?'自动回复':m.sender==='agent'?'客服':'访客'} · ${date(m.created_at)}`),KivoChat.renderMessage(m,{onImageLoad:()=>{const panel=$('#messages');if(panel.scrollHeight-panel.scrollTop-panel.clientHeight<260)panel.scrollTop=panel.scrollHeight;}}));container.append(row);
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
    const origins=element('div','site-origins');s.origins.forEach(o=>origins.append(element('span','',o==='*'?'允许所有网站':o)));
    if(s.autoReply?.firstEnabled) origins.append(element('span','','首次留言自动回复'));
    if(s.autoReply?.offlineEnabled) origins.append(element('span','','离线自动回复'));
    const code=element('textarea','embed-code');code.value=embedCode(s);code.readOnly=true;code.setAttribute('aria-label',`${s.name} 的嵌入代码`);
    const actions=element('div','site-actions');const copy=element('button','button primary small','复制嵌入代码');copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.value);toast('嵌入代码已复制');}catch{code.select();toast('请按 Ctrl+C / ⌘C 复制选中的代码');}};
    const demo=element('a','text-link','打开测试页面 ↗');demo.href=`/demo?site=${encodeURIComponent(s.id)}`;demo.target='_blank';demo.rel='noopener';actions.append(copy,demo);
    card.append(header,origins,element('p','',s.greeting),code,actions);list.append(card);
  });
}
function openSite(s) {
  const f=$('#site-form');f.reset();f.elements.id.value=s?.id||'';f.elements.name.value=s?.name||'';f.elements.origins.value=s?.origins.join('\n')||'';f.elements.color.value=s?.color||'#0f766e';f.elements.greeting.value=s?.greeting||'你好，欢迎联系我们！有什么可以帮你？';$('#site-form-title').textContent=s?'编辑网站':'添加网站';$('#site-error').textContent='';$('#site-dialog').showModal();
  avatarRevision++;avatarUploading=false;f.elements.supportName.value=s?.supportName||'在线客服';f.elements.avatarId.value=s?.avatarId||'';$('#avatar-preview').src=s?.avatarUrl||'/support-avatar.svg';f.querySelector('[type="submit"]').disabled=false;
  f.elements.allowAll.checked = s?.origins.includes('*') || false;
  if(f.elements.allowAll.checked) f.elements.origins.value = '';
  for(const key of ['firstEnabled','offlineEnabled']) f.elements[key].checked = s?.autoReply?.[key] || false;
  for(const key of ['firstMessage','offlineMessage']) f.elements[key].value = s?.autoReply?.[key] || '';
  syncSiteFields();
}
function syncSiteFields() { const f = $('#site-form'); f.elements.origins.disabled = f.elements.allowAll.checked; f.elements.origins.required = !f.elements.allowAll.checked; $('#origins-field').hidden = f.elements.allowAll.checked; for(const prefix of ['first','offline']) { f.elements[prefix+'Message'].disabled = !f.elements[prefix+'Enabled'].checked; f.elements[prefix+'Message'].required = f.elements[prefix+'Enabled'].checked; } }
['allowAll','firstEnabled','offlineEnabled'].forEach(key => $('#site-form').elements[key].onchange = syncSiteFields);
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
$('#replies-sites').onclick=()=>switchView('sites');
$('#add-reply').onclick=()=>{if($('#reply-editor').children.length<20)appendReply().focus();};
$('#replies-form').onsubmit=async e=>{e.preventDefault();const b=e.currentTarget.querySelector('[type="submit"]');b.disabled=true;$('#replies-error').textContent='';const rows=[...$('#reply-editor').children].map(row=>({label:row.querySelector('[data-field="label"]').value,body:row.querySelector('[data-field="body"]').value}));try{await api('/api/admin/replies',{method:'PUT',body:JSON.stringify(rows)});await loadReplies();toast('常用话术已保存');}catch(e){$('#replies-error').textContent=e.message;}finally{b.disabled=false;}};
$('#message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#message-form').requestSubmit();}};
$('#message-form').onsubmit=e=>{
  e.preventDefault();if(!activeId||loadingMessages||sending||composer.isUploading())return;const body=$('#message-input').value.trim();if(!body&&!composer.hasAttachment())return;
  if(!socket?.connected){$('#send-error').textContent='连接已断开，请等待重新连接后发送';return;}
  const id=activeId;const clientId=window.kivoMessageId();sending=true;$('#send-message').disabled=true;$('#send-error').textContent='';
  const attachment=composer.payload();
  socket.timeout(8000).emit('message:send',{...attachment,conversationId:id,body,clientId},(error,result)=>{
    sending=false;$('#send-message').disabled=!socket.connected;
    if(error||!result?.ok){$('#send-error').textContent=error?'未收到发送确认，请刷新检查聊天记录后重试':result.error;return;}
    drafts.delete(id);if(activeId===id){addMessage(result.message);composer.clear();if($('#message-input').value.trim()===body)$('#message-input').value='';}
  });
};
$('#older-messages').onclick=async()=>{const id=activeId,button=$('#older-messages');button.disabled=true;try{const rows=await api(`/api/admin/conversations/${id}/messages?before=${activeMessages[0]?.id||0}`);if(id!==activeId)return;const height=$('#messages').scrollHeight;activeMessages=[...rows,...activeMessages];renderMessages();$('#messages').scrollTop+=$('#messages').scrollHeight-height;button.hidden=rows.length<100;}catch(e){toast(e.message);}finally{button.disabled=false;}};
$('#add-site').onclick=()=>openSite();$('#close-dialog').onclick=()=>$('#site-dialog').close();
$('#site-dialog').addEventListener('close',()=>{avatarRevision++;avatarUploading=false;});
$('#avatar-file').onchange=async e=>{
  const image=e.target.files[0];if(!image)return;
  const revision=++avatarRevision,b=$('#site-form').querySelector('[type="submit"]');avatarUploading=true;b.disabled=true;$('#site-error').textContent='正在上传头像…';
  try{const data=await KivoChat.uploadImage('/api/admin/avatar',image);if(revision!==avatarRevision)return;$('#site-form').elements.avatarId.value=data.id;$('#avatar-preview').src=data.avatarUrl;$('#site-error').textContent='';}
  catch(e){if(revision===avatarRevision)$('#site-error').textContent=e.message;}
  finally{e.target.value='';if(revision===avatarRevision){avatarUploading=false;b.disabled=false;}}
};
$('#reset-avatar').onclick=()=>{avatarRevision++;avatarUploading=false;$('#site-form').elements.avatarId.value='';$('#avatar-preview').src='/support-avatar.svg';$('#site-form').querySelector('[type="submit"]').disabled=false;$('#site-error').textContent='';};
$('#site-form').onsubmit=async e=>{e.preventDefault();if(avatarUploading)return;const f=e.currentTarget,b=f.querySelector('[type="submit"]');b.disabled=true;$('#site-error').textContent='';const fields=Object.fromEntries(new FormData(f));fields.origins=(fields.origins||'').split(/\n|,/).map(v=>v.trim()).filter(Boolean);fields.allowAll=f.elements.allowAll.checked;fields.autoReply={firstEnabled:f.elements.firstEnabled.checked,firstMessage:f.elements.firstMessage.value,offlineEnabled:f.elements.offlineEnabled.checked,offlineMessage:f.elements.offlineMessage.value};try{await api(fields.id?`/api/admin/sites/${fields.id}`:'/api/admin/sites',{method:fields.id?'PUT':'POST',body:JSON.stringify(fields)});await loadSites();$('#site-dialog').close();toast('网站设置已保存');}catch(e){$('#site-error').textContent=e.message;}finally{b.disabled=false;}};
$('#password-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,data=Object.fromEntries(new FormData(f));if(data.newPassword!==data.confirmPassword){toast('两次输入的新密码不一致');return;}const b=f.querySelector('button');b.disabled=true;try{await post('/api/admin/password',data);f.reset();showLogin();toast('密码已更新，请重新登录');}catch(e){toast(e.message);}finally{b.disabled=false;}};
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&socket?.connected){if(activeId)selectConversation(activeId).catch(e=>toast(e.message));loadConversations().catch(e=>toast(e.message));}});
start().catch(e=>{showLogin();if(!e.message.includes('先登录'))$('#login-error').textContent=e.message;});
