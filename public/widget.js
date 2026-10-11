(function () {
  'use strict';
  const script = document.currentScript;
  if (!script || window.__kivoWidget) return;
  const siteId = script.getAttribute('data-site');
  if (!siteId) { console.error('[Kivo] Missing data-site'); return; }
  window.__kivoWidget = true;
  const service = new URL(script.src).origin;
  const key = `kivo:${service}:${siteId}`;
  let visitorToken;
  try { visitorToken = localStorage.getItem(key); } catch { /* storage may be blocked */ }
  const host = document.createElement('div');
  host.id = 'kivo-support';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{all:initial;position:fixed;bottom:24px;right:24px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}*{box-sizing:border-box}button{cursor:pointer}button:focus-visible{outline:3px solid #70b9ac;outline-offset:4px}.launcher{border:0;width:58px;height:58px;border-radius:20px;background:#0f766e;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 5px 24px #0d443b40;transition:transform .2s}.launcher:hover{transform:translateY(-3px)}svg{width:26px;height:26px}.badge{position:absolute;right:-3px;top:-3px;width:13px;height:13px;border:3px solid #fff;border-radius:50%;background:#e19b5c}.panel{position:absolute;right:0;bottom:76px;width:365px;height:min(540px,calc(100dvh - 128px));border:1px solid #e4ebe6;border-radius:18px;background:#fff;box-shadow:0 12px 60px #173e3026;overflow:hidden}.panel iframe{height:100%;width:100%;border:0;display:block;background:#fff}.error{position:absolute;bottom:76px;right:0;max-width:300px;background:#fff;color:#945342;padding:15px;border:1px solid #e8ded8;border-radius:10px;font-size:12px;line-height:1.8;box-shadow:0 6px 30px #0001}[hidden]{display:none!important}@media(max-width:480px){:host{bottom:16px;right:16px}.panel{width:calc(100vw - 32px);height:min(540px,calc(100dvh - 112px));bottom:72px}.launcher{width:54px;height:54px;border-radius:18px}}`;
  const launcher = document.createElement('button');
  launcher.className = 'launcher';launcher.type = 'button';launcher.setAttribute('aria-label', '打开在线客服');launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H5l-3 3v-11a10 10 0 0 1 18 0Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 11h.01M12 11h.01M17 11h.01" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';
  const badge = document.createElement('span');badge.className = 'badge';badge.hidden = true;launcher.append(badge);
  const panel = document.createElement('div');panel.className = 'panel';panel.hidden = true;panel.id = 'kivo-panel';launcher.setAttribute('aria-controls', 'kivo-panel');
  const frame = document.createElement('iframe');frame.title = 'Kivo 在线客服';frame.src = `${service}/widget?site=${encodeURIComponent(siteId)}`;frame.referrerPolicy = 'strict-origin-when-cross-origin';panel.append(frame);
  const error = document.createElement('div');error.className = 'error';error.hidden = true;error.setAttribute('role', 'alert');
  shadow.append(style, panel, error, launcher);
  let session, ready = false, opened = false, booting = false, lastPage = location.href;
  function tell(type, data = {}) { frame.contentWindow?.postMessage({ kivo:true, type, ...data }, service); }
  function initialize() { if (ready && session) tell('init', { ...session, page:location.href, parentOrigin:location.origin, opened }); }
  async function bootstrap() {
    if (booting) return;
    booting = true;
    try {
      const res = await fetch(`${service}/api/widget/session`, { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'omit', body:JSON.stringify({ siteId, visitorToken, page:location.href }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '客服暂时不可用');
      session = data;visitorToken = data.visitorToken;
      try { localStorage.setItem(key, visitorToken); } catch { /* works without persistence */ }
      launcher.style.background = data.site.color;error.hidden = true;initialize();
    } catch (e) { error.textContent = `客服连接失败：${e.message}。点击图标重试。`; if (opened) error.hidden = false; console.error('[Kivo]', e.message); }
    finally { booting = false; }
  }
  function setOpen(value) {
    opened = value;panel.hidden = !value;badge.hidden = true;error.hidden = true;
    launcher.setAttribute('aria-expanded', String(value));launcher.setAttribute('aria-label', value ? '关闭在线客服' : '打开在线客服');
    tell('visibility', { opened });if (value && !session) bootstrap();
    if (value) frame.focus();
  }
  launcher.onclick = () => setOpen(!opened);
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== service || !event.data?.kivo) return;
    if (event.data.type === 'ready') { ready = true;initialize(); }
    if (event.data.type === 'close') { setOpen(false);launcher.focus(); }
    if (event.data.type === 'unread' && !opened) badge.hidden = false;
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && opened) setOpen(false); });
  const mount = () => { document.body.append(host);bootstrap(); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once:true });
  // Polling also catches SPA navigation without modifying the host's router.
  setInterval(() => { if (lastPage !== location.href) { lastPage = location.href;tell('page', { page:lastPage }); } }, 2000);
})();
