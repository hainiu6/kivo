const site = new URLSearchParams(location.search).get('site');
if (/^[\da-f-]{36}$/i.test(site || '')) {
  const script = document.createElement('script'); script.src='/widget.js';script.dataset.site=site;script.async=true;document.body.append(script);
  document.getElementById('note').textContent='测试页与真实网站使用同一套组件和聊天记录。';
} else document.getElementById('note').textContent='请先登录工作台，在「网站接入」中添加网站，然后点击「打开测试页面」。';
