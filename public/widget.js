(function () {
  'use strict';
  const script = document.currentScript;
  if (!script || window.__kivoWidget) return;
  const siteId = script.getAttribute('data-site');
  if (!siteId) { console.error('[Kivo] Missing data-site'); return; }
  window.__kivoWidget = true;
  const service = new URL(script.src).origin;
  const key = `kivo:${service}:${siteId}`;
  const identityPath = script.getAttribute('data-identity-url');
  let anonymousToken;
  try { anonymousToken = localStorage.getItem(key); } catch { /* storage may be blocked */ }
  const host = document.createElement('div');
  host.id = 'kivo-support';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{all:initial;position:fixed;bottom:24px;right:24px;z-index:2147483000;--widget-accent:#0f766e;--widget-ink:#fff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}*{box-sizing:border-box}button{cursor:pointer}button:focus-visible{outline:3px solid #70b9ac;outline-offset:4px}.launcher{position:relative;border:5px solid white;width:66px;height:66px;border-radius:50%;background:var(--widget-accent);color:var(--widget-ink);display:flex;align-items:center;justify-content:center;box-shadow:0 5px 24px #0d443b40;transition:transform .25s,box-shadow .25s}.launcher::before{content:"";position:absolute;inset:-8px;border:2px solid var(--widget-accent);border-radius:50%;animation:kivo-breathe 2.8s ease-out infinite;pointer-events:none}.launcher:hover{transform:translateY(-4px) scale(1.08);box-shadow:0 9px 28px #0d443b40}.launcher:hover .bot-face{animation:kivo-wiggle .6s ease-in-out infinite alternate}.launcher[data-open="true"]::before{animation:none;opacity:0}.launcher .close-mark{position:absolute;opacity:0;transform:rotate(-90deg);transition:opacity .2s,transform .3s}.launcher .bot-mark{transition:opacity .2s,transform .3s}.launcher[data-open="true"] .bot-mark{opacity:0;transform:rotate(90deg) scale(.6)}.launcher[data-open="true"] .close-mark{opacity:1;transform:rotate(0)}@keyframes kivo-breathe{0%{transform:scale(.94);opacity:.45}75%,100%{transform:scale(1.35);opacity:0}}@keyframes kivo-wiggle{to{transform:translateY(-2px) rotate(8deg)}}@media(prefers-reduced-motion:reduce){.launcher::before,.launcher:hover .bot-face{animation:none}.launcher,.launcher svg{transition:none}}svg{width:26px;height:26px}.badge{position:absolute;right:-3px;top:-3px;width:13px;height:13px;border:3px solid #fff;border-radius:50%;background:#e19b5c}.panel{position:absolute;right:0;bottom:86px;width:min(460px,calc(100vw - 48px));height:min(760px,calc(100dvh - 136px));border:1px solid #e4ebe6;border-radius:24px;background:#fff;box-shadow:0 12px 60px #173e3026;overflow:hidden}.panel iframe{height:100%;width:100%;border:0;display:block;background:#fff}.error{position:absolute;bottom:76px;right:0;max-width:300px;background:#fff;color:#945342;padding:15px;border:1px solid #e8ded8;border-radius:10px;font-size:12px;line-height:1.8;box-shadow:0 6px 30px #0001}[hidden]{display:none!important}@media(max-width:480px){:host{bottom:16px;right:16px}.panel{width:calc(100vw - 32px);height:min(760px,calc(100dvh - 112px));bottom:78px}.launcher{width:60px;height:60px;border-radius:50%}}`;
  const launcher = document.createElement('button');
  launcher.className = 'launcher';launcher.type = 'button';launcher.setAttribute('aria-label', '打开在线客服');launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML = '<svg class="bot-mark" viewBox="0 0 28 28" fill="none" aria-hidden="true"><g class="bot-face" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14 5v3M4 13v7M24 13v7"/><rect x="7" y="9" width="14" height="15" rx="5"/><path d="M11 19q3 3 6 0"/></g><g fill="currentColor"><circle cx="14" cy="4" r="1.5"/><circle cx="11" cy="15" r="1.1"/><circle cx="17" cy="15" r="1.1"/></g></svg><svg class="close-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const badge = document.createElement('span');badge.className = 'badge';badge.hidden = true;launcher.append(badge);
  const panel = document.createElement('div');panel.className = 'panel';panel.hidden = true;panel.id = 'kivo-panel';launcher.setAttribute('aria-controls', 'kivo-panel');
  const frame = document.createElement('iframe');frame.title = 'Kivo 在线客服';frame.src = `${service}/widget?site=${encodeURIComponent(siteId)}`;frame.referrerPolicy = 'strict-origin-when-cross-origin';panel.append(frame);
  const error = document.createElement('div');error.className = 'error';error.hidden = true;error.setAttribute('role', 'alert');
  shadow.append(style, panel, error, launcher);
  let session, ready = false, opened = false, booting = false, bootstrapRevision = 0, lastPage = location.href;
  function tell(type, data = {}) { frame.contentWindow?.postMessage({ kivo:true, type, ...data }, service); }
  function initialize() { if (ready && session) tell('init', { ...session, page:location.href, parentOrigin:location.origin, opened }); }
  async function bootstrap(reset = false) {
    if (booting && !reset) return;
    const revision = ++bootstrapRevision;
    if (reset) { session = null; tell('reset'); }
    booting = true;
    try {
      let identityToken = null;
      if (identityPath) {
        const identityUrl = new URL(identityPath, location.href);
        if (identityUrl.origin !== location.origin) throw new Error('用户身份接口须位于当前网站');
        const identityResponse = await fetch(identityUrl.href, {credentials:'same-origin',cache:'no-store'});
        if (!identityResponse.ok) throw new Error(`网站用户身份接口不可用（HTTP ${identityResponse.status}）`);
        let result;
        try { result = await identityResponse.json(); } catch { throw new Error('网站用户身份接口须返回 JSON，请检查 PHP 登录配置'); }
        if (!result || !(result.identityToken === null || typeof result.identityToken === 'string' && result.identityToken.length > 0)) throw new Error('网站用户身份接口返回格式无效');
        identityToken = result.identityToken;
      }
      if (revision !== bootstrapRevision) return;
      const res = await fetch(`${service}/api/widget/session`, {method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',body:JSON.stringify({siteId,visitorToken:identityToken ? undefined : anonymousToken,identityToken,page:location.href})});
      const data = await res.json();
      if (revision !== bootstrapRevision) return;
      if (!res.ok) throw new Error(data.error || '客服暂时不可用');
      if (session && session.conversationId !== data.conversationId) tell('reset');
      session = data;
      if (!data.identity) { anonymousToken = data.visitorToken; try { localStorage.setItem(key,anonymousToken); } catch { /* works without persistence */ } }
      launcher.style.setProperty('--widget-accent',data.site.color);const rgb=data.site.color.slice(1).match(/../g).map(v=>parseInt(v,16));launcher.style.setProperty('--widget-ink',rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>155?'#233238':'#fff');error.hidden = true;initialize();
    } catch (e) {
      if (revision !== bootstrapRevision) return;
      if (identityPath) {session=null;tell('reset');}
      error.textContent = `客服连接失败：${e.message}。点击图标重试。`;if(opened)error.hidden=false;console.error('[Kivo]',e.message);
    } finally { if (revision === bootstrapRevision) booting = false; }
  }
  window.Kivo = {...window.Kivo,refreshIdentity:()=>bootstrap(true)};
  function setOpen(value) {
    opened = value;panel.hidden = !value;badge.hidden = true;error.hidden = true;
    launcher.dataset.open=String(value);launcher.setAttribute('aria-expanded', String(value));launcher.setAttribute('aria-label', value ? '关闭在线客服' : '打开在线客服');
    tell('visibility', { opened });if (value && !session) bootstrap();
    if (value) frame.focus();
  }
  launcher.onclick = () => setOpen(!opened);
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== service || !event.data?.kivo) return;
    if (event.data.type === 'identity-expired' && identityPath) bootstrap();
    if (event.data.type === 'ready') { ready = true;initialize(); }
    if (event.data.type === 'close') { setOpen(false);launcher.focus(); }
    if (event.data.type === 'unread' && !opened) badge.hidden = false;
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && opened) setOpen(false); });
  const mount = () => { document.body.append(host);bootstrap(); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once:true });
  if (identityPath) {
    setInterval(()=>bootstrap(),60000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)bootstrap();});
  }
  // Polling also catches SPA navigation without modifying the host's router.
  setInterval(() => { if (lastPage !== location.href) { lastPage = location.href;tell('page', { page:lastPage }); } }, 2000);
})();
