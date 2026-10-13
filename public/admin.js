/* global io, KivoChat, KivoNotifications, KivoWorkspaceState, KivoStats, KivoAnalytics */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let socket, publicUrl, sites = [], conversations = [], activeId = null, activeMessages = [], status = 'open', view = 'inbox', selectionRevision = 0, listRevision = 0;
let loadingMessages = false, sending = false, toastTimer;
let pendingMessages = [], pendingReceipts = [];
let authenticated=false, accountUsername='', starting=false;
let supportAvailability='online', presenceRevision=0, presenceSaving=false;
function renderAvailability() {
  const online=supportAvailability==='online',button=$('#support-availability');
  button.dataset.state=online?'online':'offline';button.setAttribute('aria-pressed',String(online));
  button.title=`客服${online?'在线':'离线'}，点击设为${online?'离线':'在线'}（所有客服同步）`;button.setAttribute('aria-label',button.title);
  button.querySelector('.availability-label').textContent=`客服${online?'在线':'离线'}`;
  button.disabled=presenceSaving;
}
function applyPresence(data) {
  if(!authenticated||!['online','offline'].includes(data?.availability))return;
  presenceRevision++;supportAvailability=data.availability;renderAvailability();
  $('#online-visitors').textContent=Number.isSafeInteger(data.onlineVisitors)?Math.max(0,data.onlineVisitors):0;
}
async function refreshPresence() {
  const revision=presenceRevision;
  try{const data=await api('/api/admin/presence');if(revision===presenceRevision)applyPresence(data);}catch(e){if(authenticated)toast(e.message);}
}
$('#support-availability').onclick=async()=>{
  if(!authenticated||presenceSaving)return;
  presenceSaving=true;renderAvailability();const revision=presenceRevision;
  try{
    const data=await api('/api/admin/presence',{method:'PUT',body:JSON.stringify({availability:supportAvailability==='online'?'offline':'online'})});
    if(revision===presenceRevision)applyPresence(data);
    if(authenticated)toast(supportAvailability==='online'?'已设为在线接待':'已设为离线，访客可留言');
  }catch(e){if(authenticated)toast(e.message);}
  finally{presenceSaving=false;renderAvailability();}
};
let replies = [];
let avatarUploading=false, avatarRevision=0;
let clearedThroughId=0, deletedMessageIds=new Set(), deletePlan, deleteRevision=0, deleting=false;
const visibleMessage = m => m.id>clearedThroughId&&!deletedMessageIds.has(m.id);
const composer = KivoChat.composer({form:$('#message-form'),input:$('#message-input'),tools:$('#chat-tools'),preview:$('#attachment-preview'),dropTarget:$('#chat-active'),getContext:()=>socket?.connected&&!loadingMessages&&!sending?activeId:'',uploadUrl:id=>`/api/admin/conversations/${id}/images`,onError:message=>$('#send-error').textContent=message,onSubmitLock:locked=>$('#send-message').disabled=locked||sending||loadingMessages||!socket?.connected});
const drafts = new Map();
const notifications = KivoNotifications.create({button:$('#notification-sound'),soundSelect:$('#notification-sound-choice'),previewButton:$('#notification-sound-preview'),previewStatus:$('#notification-sound-status'),favicon:$('#admin-favicon'),getUnread:()=>api('/api/admin/unread'),onCount:total=>{
  $('#nav-unread').textContent=total>99?'99+':total;$('#nav-unread').hidden=!total;
}});
const stats = KivoStats.create({api,onChange:()=>rememberWorkspace()});
const analytics = KivoAnalytics.create({api,publicUrl:()=>publicUrl,onChange:()=>rememberWorkspace(),onMessage:toast});
function setSidebar(collapsed) {
  $('#workspace').classList.toggle('sidebar-collapsed',collapsed);
  const button=$('#sidebar-toggle');button.setAttribute('aria-expanded',String(!collapsed));
  button.title=collapsed?'展开菜单':'折叠菜单';button.setAttribute('aria-label',button.title);button.textContent=collapsed?'☰':'‹';
}
let sidebarCollapsed=true;
try { sidebarCollapsed=localStorage.getItem('kivo.admin.sidebar')!=='expanded'; } catch {}
setSidebar(sidebarCollapsed);
$('#sidebar-toggle').onclick=()=>{
  const collapsed=!$('#workspace').classList.contains('sidebar-collapsed');setSidebar(collapsed);
  try { localStorage.setItem('kivo.admin.sidebar',collapsed?'collapsed':'expanded'); } catch {}
};
const date = ms => new Date(ms).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
const clock = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false });
function element(tag, className, content) { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = content; return el; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4000); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && url !== '/api/login') showLogin(); const error=new Error(data.error || '请求失败');error.status=response.status;throw error; }
  return data;
}
const post = (url, data = {}) => api(url,{method:'POST',body:JSON.stringify(data)});
function showLogin() { presenceRevision++; authenticated=false;accountUsername='';KivoWorkspaceState.clear();view='inbox';status='open';selectionRevision++;listRevision++;loadingMessages=false;drafts.clear();$('#loading-screen').hidden=true; stats.reset();analytics.reset();notifications.reset(); $('#delete-dialog').close(); $('#identity-dialog').close(); $('#identity-secret').value=''; $('#site-dialog').close(); socket?.disconnect(); composer.destroy(); KivoChat.clearImages(); $('#workspace').hidden = true; $('#login-screen').hidden = false; activeId = null; $('#chat-empty').hidden = false; $('#chat-active').hidden = true; $('#visitor-empty').hidden = false; $('#visitor-details').hidden = true; }
function rememberWorkspace() { if(authenticated)KivoWorkspaceState.save(accountUsername,{view,status,site:$('#site-filter').value,query:$('#search').value,conversation:activeId||'',draft:$('#message-input').value,...stats.getFilters(),...analytics.getFilters()}); }
function switchView(next,load=true) {
  view = next; ['inbox','sites','replies','stats','analytics','settings'].forEach(v => $(`#view-${v}`).hidden = v !== next);
  $('#workspace').classList.toggle('inbox-mode', next === 'inbox');
  $$('.nav-button').forEach(b => b.classList.toggle('active',b.dataset.view === next));
  $('#page-label').textContent = {inbox:'会话收件箱',sites:'网站接入',replies:'回复设置',stats:'数据统计',analytics:'访问统计',settings:'账号设置'}[next];
  if(window.matchMedia('(max-width:850px)').matches)setSidebar(true);
  if(load)rememberWorkspace();
  if (next === 'inbox'&&load) loadConversations().catch(e => toast(e.message));
  if(load){if(next==='stats')stats.activate();else stats.deactivate();if(next==='analytics')analytics.activate();else analytics.deactivate();}
}
async function start() {
  const me = await api('/api/admin/me'); publicUrl = me.publicUrl;
  const saved=KivoWorkspaceState.load(me.username);accountUsername=me.username;authenticated=true;
  applyPresence(me.presence);
  view=saved.view;status=saved.status;activeId=saved.conversation||null;$('#search').value=saved.query;
  drafts.clear();if(activeId&&saved.draft)drafts.set(activeId,saved.draft);$('#message-input').value=saved.draft;
  $$('[data-status]').forEach(b=>b.classList.toggle('active',b.dataset.status===status));
  switchView(view,false);$('#loading-screen').hidden=true;$('#login-screen').hidden=true;$('#workspace').hidden=false;
  $('#account-name').textContent = me.username; $('#service-url').textContent = publicUrl;
  $('#today').textContent = new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
  await loadSites();$('#site-filter').value=sites.some(s=>s.id===saved.site)?saved.site:'';stats.setFilters(saved);analytics.setFilters(saved);
  await loadConversations(); await loadReplies();
  $('#login-screen').hidden = true; $('#workspace').hidden = false;
  notifications.start();
  if(view==='stats')stats.activate();if(view==='analytics')analytics.activate();
  socket?.disconnect(); socket = io({ auth:{role:'admin'}, reconnection:true });
  socket.on('connect', () => {
    notifications.refresh();
    stats.schedule();
    refreshPresence();
    $('#connection-label').textContent = '工作台已连接'; $('#connection-dot').classList.remove('offline'); $('#send-message').disabled = sending||composer.isUploading();
    loadConversations().catch(e => toast(e.message));
    if (activeId) selectConversation(activeId).catch(e => toast(e.message));
  });
  socket.on('disconnect', () => { $('#connection-label').textContent = '连接已断开'; $('#connection-dot').classList.add('offline'); $('#send-message').disabled = true; });
  socket.on('connect_error', e => { $('#connection-label').textContent = '正在重新连接'; $('#connection-dot').classList.add('offline'); $('#send-message').disabled = true; if (e.message === '登录已过期') showLogin(); });
  socket.on('presence:update', applyPresence);
  socket.on('conversation:update', c => {
    notifications.refresh();
    stats.schedule();
    if (!c) return;
    const index = conversations.findIndex(item => item.id === c.id);
    const matches = (!status || c.status === status) && (!$('#site-filter').value || c.site_id === $('#site-filter').value) && (!$('#search').value || [c.name,c.ip,c.page,c.user_id||'',c.account||'',c.nickname||''].some(s => s.toLowerCase().includes($('#search').value.toLowerCase())));
    if (matches) { if (index >= 0) conversations[index] = c; else conversations.unshift(c); }
    else if (index >= 0) conversations.splice(index,1);
    renderConversations(); if (activeId === c.id) renderDetails(c);
  });
  socket.on('message:new', message => {
    notifications.receive(message);
    stats.schedule();
    if (message.conversation_id === activeId) {
      if (loadingMessages) pendingMessages.push(message);
      else { addMessage(message); if (view === 'inbox' && !document.hidden) markRead(); }
    }
  });
  socket.on('replies:update', rows => { replies = rows; renderQuickReplies(); });
  socket.on('message:read', data => {
    if(data.conversationId!==activeId)return;
    if(loadingMessages)pendingReceipts.push(data);
    for(const m of [...activeMessages,...pendingMessages])if(m.sender!=='visitor'&&m.id<=data.throughId)m.read_at=m.read_at||data.readAt;
    renderMessages();
  });
  socket.on('message:deleted', applyMessageDeletion);
  socket.on('history:cleared', applyHistoryClear);
  socket.on('conversation:deleted', applyConversationDeletion);
}
function applyMessageDeletion(data) {
  notifications.refresh();
  stats.schedule();
  if(data.conversationId!==activeId)return;
  deletedMessageIds.add(data.messageId);activeMessages=activeMessages.filter(visibleMessage);pendingMessages=pendingMessages.filter(visibleMessage);KivoChat.forgetImages(data.mediaIds);renderMessages();
}
function applyHistoryClear(data) {
  notifications.refresh();
  stats.schedule();
  drafts.delete(data.conversationId);if(data.conversationId!==activeId)return;
  clearedThroughId=Math.max(clearedThroughId,data.throughId);activeMessages=activeMessages.filter(visibleMessage);pendingMessages=pendingMessages.filter(visibleMessage);composer.clear();KivoChat.clearImages();$('#message-input').value='';$('#older-messages').hidden=true;renderMessages();
}
function applyConversationDeletion(data) {
  notifications.refresh();
  stats.schedule();
  listRevision++;conversations=conversations.filter(c=>c.id!==data.conversationId);drafts.delete(data.conversationId);
  if(activeId===data.conversationId){selectionRevision++;activeId=null;activeMessages=[];pendingMessages=[];loadingMessages=false;composer.clear();composer.closePicker();KivoChat.clearImages();$('#message-input').value='';$('#chat-active').hidden=true;$('#chat-empty').hidden=false;$('#visitor-details').hidden=true;$('#visitor-empty').hidden=false;$('.inbox-grid').classList.remove('chat-selected','show-details');}
  rememberWorkspace();renderConversations();
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
  stats.setSites(sites);
}
async function loadConversations() {
  const revision = ++listRevision;
  const params = new URLSearchParams({status,q:$('#search').value,site:$('#site-filter').value});
  const rows = await api(`/api/admin/conversations?${params}`);
  if (revision !== listRevision) return;
  conversations=rows;renderConversations();
  notifications.refresh();
}
function renderConversations() {
  conversations.sort((a,b) => Number(!!b.online)-Number(!!a.online) || b.updated_at-a.updated_at || b.id.localeCompare(a.id)); conversations=conversations.slice(0,200);
  $('#list-count').textContent = conversations.length;
  const list = $('#conversations'); list.replaceChildren();
  if (!conversations.length) { list.append(element('div','list-empty',sites.length ? '暂无匹配会话。\n访客打开接入的网站后，会出现在这里。' : '还没有接入网站。\n点击「网站接入」开始设置。')); return; }
  conversations.forEach(c => {
    const row = element('button',`conversation-row${activeId===c.id?' selected':''}`); row.type='button';
    row.append(element('span','avatar',c.name.slice(-2)));
    const content = element('div','row-content'), title=element('div','row-title');
    const presence=element('span','row-presence'+(c.online?'':' offline'));
    presence.append(element('span','status-dot'+(c.online?'':' offline')),document.createTextNode(c.online?'在线':'离线'));
    title.append(element('strong','',c.name),presence,element('time','',clock(c.updated_at)));
    const sub=element('div','row-summary'),site=element('span','row-site',c.site_name);site.title=c.site_name;
    sub.append(element('div','row-preview',c.last_message||'访客已打开页面'),site);
    if(c.unread) sub.append(element('span','unread-badge',c.unread>99?'99+':c.unread));
    content.append(title,sub);row.append(content);
    row.onclick=()=>selectConversation(c.id,true).catch(e=>toast(e.message));list.append(row);
  });
}
function renderDetails(c) {
  $('#chat-empty').hidden=true; $('#chat-active').hidden=false; $('#visitor-empty').hidden=true;$('#visitor-details').hidden=false;
  $('#chat-name').textContent=c.name;$('#chat-meta').textContent=`${c.online?'访客在线':'访客离线'} · ${c.site_name}`;
  $('#chat-avatar').textContent=c.name.slice(-2);$('#visitor-avatar').textContent=c.name.slice(-2);$('#visitor-name').textContent=c.name;
  $('#visitor-name').title=c.name;
  $('#visitor-status').textContent=c.online?'● 在线':'● 离线';$('#visitor-status').classList.toggle('offline',!c.online);
  $('#visitor-identity').textContent=c.user_id?'已验证的用户':c.visitor_name?'网站提供的名称':'匿名访客';$('#visitor-user-id').textContent=c.user_id||'—';$('#visitor-account').textContent=c.account||c.visitor_name||'—';$('#visitor-nickname').textContent=c.nickname||'—';
  $('#visitor-user-id-field').hidden=!c.user_id;$('#visitor-account-field').hidden=!(c.account||c.visitor_name);$('#visitor-nickname-field').hidden=!c.nickname;
  $('#visitor-user-group').hidden=!(c.user_id||c.account||c.visitor_name||c.nickname);
  const clientFacts=$('#visitor-client-facts');clientFacts.replaceChildren();$('#visitor-client-group').hidden=!c.client;
  if(c.client){for(const [label,value] of [['平台',c.client.platform],['客户端版本',c.client.version],['设备',c.client.device],['当前页面',c.client.screen],...Object.entries(c.client.attributes||{})]){if(!value)continue;const row=element('div');row.append(element('dt','',label),element('dd','',value));clientFacts.append(row);}}
  $('#visitor-ip').textContent=c.ip;$('#visitor-region').textContent=c.region;$('#visitor-site').textContent=c.site_name;
  $('#visitor-os').textContent=c.os||'未知系统';$('#visitor-browser').textContent=c.browser||'未知浏览器';
  $('#visitor-location-label').textContent='当前访问域名';
  $('#visitor-page').textContent=c.page;$('#visitor-page').href=c.page;$('#visitor-page').title=c.page;
  if(c.client&&c.page===publicUrl+'/client'){$('#visitor-location-label').textContent='当前客户端页面';$('#visitor-domain').textContent=c.client.screen||'客服页面';$('#visitor-domain').removeAttribute('href');$('#visitor-page').textContent=c.client.platform+(c.client.version?' · '+c.client.version:'');$('#visitor-page').removeAttribute('href');}
  else try{const page=new URL(c.page);$('#visitor-domain').textContent=page.host;$('#visitor-domain').href=page.origin;$('#visitor-page').textContent=page.pathname+page.search+page.hash;}catch{$('#visitor-domain').textContent='未知域名';$('#visitor-domain').removeAttribute('href');}
  $('#visitor-created').textContent=date(c.created_at);$('#visitor-updated').textContent=date(c.updated_at);
  $('#visitor-conversation-status').textContent=c.status==='closed'?'已结束':'进行中';
  $('#close-conversation').textContent=c.status==='closed'?'重新打开':'结束会话';$('#close-conversation').dataset.status=c.status;
}
async function selectConversation(id,focus=false) {
  const same=activeId===id&&$('#message-items').children.length>0;
  if(same&&focus&&!loadingMessages){$('#message-input').focus({preventScroll:true});markRead();return;}
  if (activeId) drafts.set(activeId,$('#message-input').value);
  if(activeId!==id){composer.clear();composer.closePicker();KivoChat.clearImages();clearedThroughId=0;deletedMessageIds=new Set();activeMessages=[];}
  const panel=$('#messages'),scroll=panel.scrollTop,bottom=panel.scrollHeight-panel.scrollTop-panel.clientHeight<100;
  const oldest=same?activeMessages[0]?.id:null;
  activeId=id;const revision=++selectionRevision;loadingMessages=true;pendingMessages=[];pendingReceipts=[];
  renderConversations();const c=conversations.find(c=>c.id===id);if(c)renderDetails(c);
  $('.inbox-grid').classList.add('chat-selected');if(!same)$('#message-items').replaceChildren(element('div','muted','正在加载对话…'));
  if(!same)$('#message-input').value=drafts.get(id)||'';$('#send-error').textContent='';$('#send-message').disabled=true;
  if(focus&&c&&view==='inbox')$('#message-input').focus({preventScroll:true});
  rememberWorkspace();
  try {
    const [rows,detail]=await Promise.all([api(`/api/admin/conversations/${id}/messages`),c?Promise.resolve(c):api(`/api/admin/conversations/${id}`)]);
    let page=rows;
    while(oldest&&page.length===100&&page[0].id>oldest&&revision===selectionRevision){
      page=await api(`/api/admin/conversations/${id}/messages?before=${page[0].id}`);rows.unshift(...page);
    }
    if(revision!==selectionRevision)return;
    renderDetails(detail);
    if(focus&&!c&&view==='inbox')$('#message-input').focus({preventScroll:true});
    const reads=new Map(activeMessages.map(m=>[m.id,m.read_at]));
    activeMessages=[...new Map([...rows,...pendingMessages].filter(visibleMessage).map(m=>[m.id,{...m,read_at:m.read_at||reads.get(m.id)||null}])).values()].sort((a,b)=>a.id-b.id);pendingMessages=[];
    for(const receipt of pendingReceipts)for(const m of activeMessages)if(m.sender!=='visitor'&&m.id<=receipt.throughId)m.read_at=m.read_at||receipt.readAt;
    pendingReceipts=[];renderMessages();
    panel.scrollTop=!same||bottom?panel.scrollHeight:scroll;$('#older-messages').hidden=page.length<100||!activeMessages.length;
    loadingMessages=false;$('#send-message').disabled=!socket?.connected||composer.isUploading();markRead();
  } catch(e) { if(revision===selectionRevision){loadingMessages=false;$('#send-message').disabled=!socket?.connected;if(e.status===404)applyConversationDeletion({conversationId:id});else if(!same)$('#message-items').replaceChildren(element('p','error',e.message));} throw e; }
}
function renderMessages() {
  const container=$('#message-items');
  if(!activeMessages.length){if(container.children.length!==1||container.firstChild.dataset?.empty!=='true'){const empty=element('p','muted','访客还没有发送消息。用一句问候开始对话吧。');empty.dataset.empty='true';container.replaceChildren(empty);}return;}
  KivoChat.reconcileMessages(container,activeMessages,m=>{
    const row=element('div',`message-row ${m.sender}`),meta=element('div','message-meta',`${m.sender==='auto'?'自动回复':m.sender==='agent'?'客服':'访客'} · ${date(m.created_at)}`),remove=element('button','message-delete','删除');
    if(m.sender!=='visitor')meta.append(element('span','message-receipt','未读'));
    remove.type='button';remove.setAttribute('aria-label',`删除消息 ${m.id}`);const id=activeId;remove.onclick=()=>openDelete({kind:'message',url:`/api/admin/conversations/${id}/messages/${m.id}`,summary:`删除这条${m.kind==='image'?'图片':m.kind==='sticker'?'表情':'消息'}：${m.body?.slice(0,80)||'（无文字）'}`});meta.append(remove);row.append(meta,KivoChat.renderMessage(m,{onImageLoad:()=>{const panel=$('#messages');if(panel.scrollHeight-panel.scrollTop-panel.clientHeight<260)panel.scrollTop=panel.scrollHeight;}}));return row;
  },(row,m)=>{
    const receipt=row.querySelector('.message-receipt');if(m.sender==='visitor'||!receipt)return;
    receipt.textContent=m.read_at?'已读':'未读';receipt.classList.toggle('is-read',!!m.read_at);receipt.title=m.read_at?'用户已查看 · '+date(m.read_at):'用户尚未查看这条消息';
  });
  if(!activeMessages.length&&!container.children.length)container.append(element('p','muted','访客还没有发送消息。用一句问候开始对话吧。'));
}
function addMessage(m) {
  if(!visibleMessage(m)||activeMessages.some(item=>item.id===m.id))return;
  const bottom=$('#messages').scrollHeight-$('#messages').scrollTop-$('#messages').clientHeight<100;
  activeMessages.push(m);activeMessages.sort((a,b)=>a.id-b.id);renderMessages();if(bottom||m.sender==='agent')$('#messages').scrollTop=$('#messages').scrollHeight;
}
function markRead() {
  if(!activeId||loadingMessages||document.hidden||view!=='inbox')return;
  post(`/api/admin/conversations/${activeId}/read`,{lastId:activeMessages.at(-1)?.id||0}).catch(e=>toast(e.message));
}
function embedCode(s) { return `<script src="${publicUrl}/widget.js" data-site="${s.id}" async></script>`; }
function openDelete(plan) {
  deletePlan=plan;deleteRevision++;$('#delete-title').textContent={bulk:'批量删除对话',message:'删除单条消息',clear:'清空当前记录',conversation:'删除当前会话'}[plan.kind];
  $('#cleanup-scope-field').hidden=plan.kind!=='bulk';$('#delete-summary').textContent=plan.summary||'';$('#delete-error').textContent='';$('#confirm-delete').disabled=false;$('#delete-dialog').showModal();
  if(plan.kind==='bulk')previewCleanup();
}
async function previewCleanup() {
  const revision=++deleteRevision,scope=$('#cleanup-scope').value,siteId=$('#site-filter').value;$('#confirm-delete').disabled=true;$('#delete-summary').textContent='正在统计对话…';$('#delete-error').textContent='';
  try{
    const result=await api(`/api/admin/conversations/cleanup?${new URLSearchParams({scope,siteId})}`);
    if(revision!==deleteRevision)return;
    deletePlan={kind:'bulk',url:'/api/admin/conversations/cleanup',body:{scope,siteId,cutoff:result.cutoff}};
    const website=siteId?sites.find(s=>s.id===siteId)?.name:'所有网站';
    $('#delete-summary').textContent=`${website}：将删除 ${result.count} 段会话及全部聊天记录。${scope==='all'?'包括进行中和已结束会话。':`最近消息早于 ${date(result.cutoff)} 的会话才会删除。`}不受列表搜索或状态筛选影响。`;
    $('#confirm-delete').disabled=!result.count;
  }catch(e){if(revision===deleteRevision)$('#delete-error').textContent=e.message;}
}
$('#cleanup-conversations').onclick=()=>openDelete({kind:'bulk'});$('#cleanup-scope').onchange=previewCleanup;
$('#clear-history').onclick=()=>{if(activeId)openDelete({kind:'clear',url:`/api/admin/conversations/${activeId}/messages`,summary:`清空「${$('#chat-name').textContent}」的全部聊天记录及图片，保留该访客会话。`});};
$('#delete-conversation').onclick=()=>{if(activeId)openDelete({kind:'conversation',url:`/api/admin/conversations/${activeId}`,summary:`删除「${$('#chat-name').textContent}」的会话及全部聊天记录、图片。访客可重新开始新对话。`});};
for(const id of ['#close-delete','#cancel-delete'])$(id).onclick=()=>{if(!deleting)$('#delete-dialog').close();};
$('#delete-dialog').addEventListener('cancel',e=>{if(deleting)e.preventDefault();});$('#delete-dialog').addEventListener('close',()=>{deleteRevision++;deletePlan=null;});
$('#confirm-delete').onclick=async()=>{
  if(!deletePlan||deleting)return;const plan=deletePlan;deleting=true;$('#confirm-delete').disabled=true;$('#close-delete').disabled=true;$('#cancel-delete').disabled=true;$('#cleanup-scope').disabled=true;
  try{const result=await api(plan.url,{method:plan.kind==='bulk'?'POST':'DELETE',...(plan.body?{body:JSON.stringify(plan.body)}:{})});if(plan.kind==='message')applyMessageDeletion(result);if(plan.kind==='clear')applyHistoryClear(result);if(plan.kind==='conversation')applyConversationDeletion(result);if(plan.kind==='bulk')result.deletedIds.forEach(conversationId=>applyConversationDeletion({conversationId}));$('#delete-dialog').close();toast(plan.kind==='bulk'?`已删除 ${result.count} 段会话`:'已删除，访客端同步更新');await loadConversations();}
  catch(e){$('#delete-error').textContent=e.message;}
  finally{deleting=false;$('#confirm-delete').disabled=false;$('#close-delete').disabled=false;$('#cancel-delete').disabled=false;$('#cleanup-scope').disabled=false;}
};
function renderSites() {
  const list=$('#sites-list');list.replaceChildren();
  if(!sites.length){const empty=element('div','panel');empty.append(element('h2','','准备好接待第一位访客了吗？'),element('p','muted','添加网站后，复制生成的 JavaScript 代码到网页，即可启用右下角的客服窗口。'));list.append(empty);return;}
  sites.forEach(s=>{
    const card=element('article','site-card'),header=element('div','site-card-header');const edit=element('button','button secondary small','编辑设置');edit.onclick=()=>openSite(s);header.append(element('h2','',s.name),edit);
    const origins=element('div','site-origins');s.origins.forEach(o=>origins.append(element('span','',o==='*'?'允许所有网站':o)));
    if(s.autoReply?.firstEnabled) origins.append(element('span','','首次留言自动回复'));
    if(s.autoReply?.offlineEnabled) origins.append(element('span','','离线自动回复'));
    const code=element('textarea','embed-code');code.value=embedCode(s);code.readOnly=true;code.setAttribute('aria-label',`${s.name} 的嵌入代码`);
    const actions=element('div','site-actions');
    const copyCode=async value=>{code.value=value;try{await navigator.clipboard.writeText(value);toast('代码已复制，请放入对应网页模板');}catch{code.focus();code.select();toast('请按 Ctrl+C / ⌘C 复制选中的代码');}};
    const copy=element('button','button primary small','复制嵌入代码');copy.onclick=()=>copyCode(embedCode(s));
    const session=element('button','button secondary small','复制 PHP Session 代码');session.type='button';session.onclick=()=>copyCode(`<script src="${publicUrl}/widget.js" data-site="${s.id}" data-visitor-name="{{ Session::get('user.username', Session::get('username', '')) }}" async></script>`);
    const demo=element('a','text-link','打开测试页面 ↗');demo.href=`/demo?site=${encodeURIComponent(s.id)}`;demo.target='_blank';demo.rel='noopener';const identity=element('button','button secondary small','用户对接');identity.type='button';identity.onclick=()=>openIdentity(s);actions.append(copy,demo,identity);
    actions.append(session);card.append(header,origins,element('p','',s.greeting),code,actions);list.append(card);
  });
}
let identitySiteId, identityRevision=0;
function renderIdentity(data) {
  $('#identity-status').textContent=data.enabled?'已启用：将站点 ID 和密钥填入业务后端配置。':'尚未启用：先生成密钥，再按网站或客户端文档接入。';
  $('#identity-site-id').value=data.siteId;$('#identity-secret').value=data.secret;$('#identity-secret').type='password';$('#identity-show').textContent='显示密钥';
  $('#identity-rotate').textContent=data.enabled?'重置密钥':'生成密钥';$('#identity-disable').disabled=!data.enabled;$('#identity-copy').disabled=!data.enabled;
}
async function openIdentity(s) {
  identitySiteId=s.id;const revision=++identityRevision;$('#identity-title').textContent=s.name+' · 用户对接';$('#identity-error').textContent='';$('#identity-secret').value='';$('#identity-site-id').value=s.id;
  $('#identity-code').value=`<script src="${publicUrl}/widget.js" data-site="${s.id}" data-identity-url="/kivo/identity" async></script>`;
  $('#identity-status').textContent='正在读取配置…';$('#identity-rotate').disabled=true;$('#identity-disable').disabled=true;$('#identity-copy').disabled=true;$('#identity-dialog').showModal();
  try {const data=await api(`/api/admin/sites/${s.id}/identity`);if(revision===identityRevision){renderIdentity(data);$('#identity-rotate').disabled=false;}}catch(e){if(revision===identityRevision)$('#identity-error').textContent=e.message;}
}
$('#close-identity').onclick=()=>$('#identity-dialog').close();$('#identity-dialog').addEventListener('close',()=>{identityRevision++;$('#identity-secret').value='';});
$('#identity-show').onclick=()=>{const show=$('#identity-secret').type==='password';$('#identity-secret').type=show?'text':'password';$('#identity-show').textContent=show?'隐藏密钥':'显示密钥';};
async function identityAction(action) {
  if(action==='rotate'&&$('#identity-secret').value&&!confirm('重置后旧 PHP 密钥立即失效，需要同步修改网站配置。继续重置？'))return;
  const revision=identityRevision;$('#identity-rotate').disabled=true;$('#identity-disable').disabled=true;
  try{const data=await post(`/api/admin/sites/${identitySiteId}/identity`,{action});if(revision===identityRevision){renderIdentity(data);$('#identity-error').textContent='';}}
  catch(e){if(revision===identityRevision)$('#identity-error').textContent=e.message;}
  finally{if(revision===identityRevision){$('#identity-rotate').disabled=false;$('#identity-disable').disabled=!$('#identity-secret').value;}}
}
$('#identity-rotate').onclick=()=>identityAction('rotate');$('#identity-disable').onclick=()=>identityAction('disable');
for(const [button,field] of [['#identity-copy','#identity-secret'],['#identity-copy-code','#identity-code']])$(button).onclick=async()=>{try{await navigator.clipboard.writeText($(field).value);toast('已复制');}catch{$(field).focus();$(field).select();toast('请按 Ctrl+C / ⌘C 复制选中的内容');}};
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
let searchTimer;$('#search').oninput=()=>{rememberWorkspace();clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadConversations().catch(e=>toast(e.message)),250);};
$('#refresh').onclick=()=>loadConversations().then(()=>toast('会话已刷新')).catch(e=>toast(e.message));$('#site-filter').onchange=()=>{rememberWorkspace();loadConversations().catch(e=>toast(e.message));};
$$('[data-status]').forEach(b=>b.onclick=()=>{status=b.dataset.status;rememberWorkspace();$$('[data-status]').forEach(x=>x.classList.toggle('active',x===b));loadConversations().catch(e=>toast(e.message));});
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
$('#older-messages').onclick=async()=>{const id=activeId,button=$('#older-messages');button.disabled=true;try{const rows=await api(`/api/admin/conversations/${id}/messages?before=${activeMessages[0]?.id||0}`);if(id!==activeId)return;const height=$('#messages').scrollHeight;activeMessages=[...rows,...activeMessages].filter(visibleMessage);renderMessages();$('#messages').scrollTop+=$('#messages').scrollHeight-height;button.hidden=rows.length<100||!activeMessages.length;}catch(e){toast(e.message);}finally{button.disabled=false;}};
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
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&socket?.connected){notifications.refresh();stats.schedule();analytics.schedule();if(activeId)selectConversation(activeId).catch(e=>toast(e.message));loadConversations().catch(e=>toast(e.message));}});
async function restoreWorkspace() {
  if(starting)return;starting=true;$('#retry-start').disabled=true;
  try { await start(); }
  catch(e) { if(e.status!==401){if(authenticated)toast('工作台加载失败：'+e.message);else{$('#loading-message').textContent='暂时无法连接工作台，请检查网络后重试。';$('#retry-start').hidden=false;}} }
  finally { starting=false;$('#retry-start').disabled=false; }
}
$('#retry-start').onclick=restoreWorkspace;
window.addEventListener('pagehide',rememberWorkspace);
$('#message-input').addEventListener('input',rememberWorkspace);
restoreWorkspace();
