// Original vector characters: no external fonts, GIFs or image services required.
(function () {
  const items = [
    { id:'hello', label:'团团 · 嗨', color:'#8bd8c2', face:'smile', mark:'👋' },
    { id:'love', label:'团团 · 比心', color:'#f5a8ba', face:'smile', mark:'♥' },
    { id:'yay', label:'团团 · 好耶', color:'#ffd875', face:'happy', mark:'✦' },
    { id:'laugh', label:'团团 · 哈哈哈', color:'#ffbb83', face:'happy', mark:'♪' },
    { id:'cry', label:'团团 · 委屈', color:'#a6cbf7', face:'sad', mark:'💧' },
    { id:'wait', label:'团团 · 等一下', color:'#c5b4ed', face:'flat', mark:'···' },
    { id:'coffee', label:'团团 · 喝杯咖啡', color:'#d8c1a3', face:'smile', mark:'☕' },
    { id:'thanks', label:'团团 · 谢谢啦', color:'#a9dca3', face:'happy', mark:'✿' }
  ];
  function render(id) {
    const item = items.find(s => s.id === id); if (!item) return document.createTextNode('[表情]');
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 120 120'); svg.setAttribute('role','img'); svg.setAttribute('aria-label',item.label); svg.classList.add('kivo-sticker',`sticker-${id}`);
    const mouth = { smile:'M48 66 Q60 79 72 66', happy:'M46 65 Q60 90 74 65 Z', sad:'M49 73 Q60 62 71 73', flat:'M50 70 H70' }[item.face];
    svg.innerHTML = `<ellipse class="sticker-shadow" cx="60" cy="105" rx="29" ry="5" fill="#17372a" opacity=".09"/><g class="sticker-body"><path d="M20 69 C10 35 36 21 57 25 C85 10 111 40 101 73 C97 98 75 104 51 99 C27 103 16 89 20 69Z" fill="${item.color}"/><path class="sticker-hand left" d="M23 64 Q2 56 10 43" fill="none" stroke="${item.color}" stroke-width="10" stroke-linecap="round"/><path class="sticker-hand right" d="M97 64 Q116 52 110 39" fill="none" stroke="${item.color}" stroke-width="10" stroke-linecap="round"/><g class="sticker-eyes" fill="#283d46"><ellipse cx="45" cy="54" rx="4" ry="6"/><ellipse cx="76" cy="54" rx="4" ry="6"/></g><ellipse cx="35" cy="65" rx="7" ry="4" fill="#ff7289" opacity=".36"/><ellipse cx="85" cy="65" rx="7" ry="4" fill="#ff7289" opacity=".36"/><path d="${mouth}" fill="${item.face==='happy'?'#283d46':'none'}" stroke="#283d46" stroke-width="3.5" stroke-linecap="round"/><text class="sticker-mark" x="91" y="24" text-anchor="middle" font-size="23" fill="#d46785">${item.mark}</text></g>`;
    return svg;
  }
  window.KivoStickers = { items, render };
})();
