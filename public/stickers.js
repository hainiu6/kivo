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
  items.forEach(item => { item.pack='团团'; });
  items.push(
    {id:'cat-dance',pack:'奶猫',family:'cat',label:'奶猫 · 扭扭舞',color:'#ffd6a3',face:'happy',mark:'♪',motion:'dance'},
    {id:'cat-wow',pack:'奶猫',family:'cat',label:'奶猫 · 哇哦',color:'#ffd6a3',face:'happy',mark:'!',motion:'pop'},
    {id:'cat-love',pack:'奶猫',family:'cat',label:'奶猫 · 爱你喵',color:'#f8c8d8',face:'smile',mark:'♥',motion:'hearts'},
    {id:'cat-cheer',pack:'奶猫',family:'cat',label:'奶猫 · 冲鸭',color:'#ffd6a3',face:'happy',mark:'✦',motion:'jump'},
    {id:'cat-sleep',pack:'奶猫',family:'cat',label:'奶猫 · 困困',color:'#d4c6f5',face:'flat',mark:'Zz',motion:'sleep'},
    {id:'cat-zoom',pack:'奶猫',family:'cat',label:'奶猫 · 马上到',color:'#ffd6a3',face:'smile',mark:'➜',motion:'zoom'},
    {id:'capy-chill',pack:'水豚',family:'capy',label:'水豚 · 稳稳的',color:'#cfad86',face:'flat',mark:'✓',motion:'sway'},
    {id:'capy-bath',pack:'水豚',family:'capy',label:'水豚 · 泡汤啦',color:'#cfad86',face:'smile',mark:'♨',motion:'bath'},
    {id:'capy-snack',pack:'水豚',family:'capy',label:'水豚 · 吃一口',color:'#cfad86',face:'happy',mark:'🍉',motion:'munch'},
    {id:'capy-yay',pack:'水豚',family:'capy',label:'水豚 · 开心蹦',color:'#cfad86',face:'happy',mark:'✦',motion:'jump'},
    {id:'capy-thanks',pack:'水豚',family:'capy',label:'水豚 · 鞠躬啦',color:'#cfad86',face:'smile',mark:'✿',motion:'bow'},
    {id:'capy-spin',pack:'水豚',family:'capy',label:'水豚 · 转圈圈',color:'#cfad86',face:'happy',mark:'♪',motion:'spin'},
    {id:'bot-hi',pack:'机器人',family:'bot',label:'机器人 · 招招手',color:'#a6d8ff',face:'smile',mark:'✦',motion:'wave'},
    {id:'bot-loading',pack:'机器人',family:'bot',label:'机器人 · 努力思考',color:'#c6b7ff',face:'flat',mark:'⚙',motion:'think'},
    {id:'bot-ok',pack:'机器人',family:'bot',label:'机器人 · 搞定啦',color:'#94e0c3',face:'happy',mark:'✓',motion:'pop'},
    {id:'bot-party',pack:'机器人',family:'bot',label:'机器人 · 撒花花',color:'#a6d8ff',face:'happy',mark:'★',motion:'party'},
    {id:'bot-power',pack:'机器人',family:'bot',label:'机器人 · 满电出发',color:'#ffe28a',face:'happy',mark:'⚡',motion:'power'},
    {id:'bot-hug',pack:'机器人',family:'bot',label:'机器人 · 抱抱你',color:'#f7bad3',face:'smile',mark:'♥',motion:'hearts'}
  );
  function render(id) {
    const item = items.find(s => s.id === id); if (!item) return document.createTextNode('[表情]');
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 120 120'); svg.setAttribute('role','img'); svg.setAttribute('aria-label',item.label); svg.classList.add('kivo-sticker',`sticker-${id}`);
    if(item.family)svg.classList.add(`family-${item.family}`,`motion-${item.motion}`);
    const mouth = { smile:'M48 66 Q60 79 72 66', happy:'M46 65 Q60 90 74 65 Z', sad:'M49 73 Q60 62 71 73', flat:'M50 70 H70' }[item.face];
    let shape=`<path d="M20 69 C10 35 36 21 57 25 C85 10 111 40 101 73 C97 98 75 104 51 99 C27 103 16 89 20 69Z" fill="${item.color}"/>`;
    if(item.family==='cat')shape=`<path class="sticker-tail" d="M91 87 Q120 96 109 67" stroke="${item.color}" fill="none" stroke-width="11" stroke-linecap="round"/><path d="M25 44 L20 15 L45 29 Q60 23 77 29 L101 15 L95 46 Q108 91 80 100 H40 Q12 93 25 44Z" fill="${item.color}"/><path d="M26 23 L30 39 L40 31 M94 23 L90 39 L80 31" stroke="#e99f9f" stroke-width="5" fill="none"/><ellipse cx="60" cy="83" rx="19" ry="14" fill="#fff6e8"/><path d="M26 57 L12 53 M25 63 L11 65 M95 57 L109 53 M95 63 L109 65" stroke="#bb8868" stroke-width="2.5" stroke-linecap="round"/>`;
    if(item.family==='capy')shape=`<circle cx="29" cy="29" r="12" fill="${item.color}"/><circle cx="91" cy="29" r="12" fill="${item.color}"/><circle cx="29" cy="29" r="6" fill="#b88b68"/><circle cx="91" cy="29" r="6" fill="#b88b68"/><rect x="22" y="28" width="77" height="72" rx="28" fill="${item.color}"/><ellipse cx="60" cy="69" rx="26" ry="18" fill="#ecd2ad"/><path d="M50 64 H53 M67 64 H70" stroke="#755544" stroke-width="3" stroke-linecap="round"/><g class="sticker-orange"><circle cx="60" cy="19" r="12" fill="#ffad40"/><path d="M60 7 Q67 0 75 6 Q69 12 60 7" fill="#68a96b"/></g>`;
    if(item.family==='bot')shape=`<path d="M60 13 V25" stroke="#628daf" stroke-width="5"/><circle class="sticker-light" cx="60" cy="10" r="7" fill="#ffbd5d"/><rect x="18" y="29" width="84" height="56" rx="19" fill="${item.color}"/><rect x="30" y="40" width="60" height="35" rx="12" fill="#273e54"/><rect x="34" y="83" width="52" height="19" rx="9" fill="${item.color}"/><path d="M46 89 V96 M60 89 V96 M74 89 V96" stroke="#fff" stroke-width="4" stroke-linecap="round"/><rect x="10" y="46" width="9" height="22" rx="4" fill="#6f9cba"/><rect x="101" y="46" width="9" height="22" rx="4" fill="#6f9cba"/>`;
    const eyes=item.motion==='sleep'?'<path d="M39 54 H49 M71 54 H81" stroke="#283d46" stroke-width="4" stroke-linecap="round"/>':`<g class="sticker-eyes" fill="${item.family==='bot'?'#93f3df':'#283d46'}"><ellipse cx="45" cy="54" rx="4" ry="6"/><ellipse cx="76" cy="54" rx="4" ry="6"/></g>`;
    const extras=item.motion==='party'?'<g class="sticker-confetti"><path d="M9 27 L15 33 M103 14 L109 20 M10 83 L16 78" stroke="#ed97be" stroke-width="5"/><path d="M24 9 L27 17 M105 91 L110 84" stroke="#ffd064" stroke-width="5"/><circle cx="6" cy="54" r="4" fill="#71d8bb"/><circle cx="112" cy="43" r="4" fill="#9f99ee"/></g>':item.motion==='hearts'?'<g class="sticker-hearts" fill="#ef6e9f"><path d="M11 37 C0 24 15 20 17 29 C20 18 35 25 24 37 L17 44Z"/><path d="M96 78 C87 66 101 61 104 70 C110 59 120 68 113 78 L105 86Z"/></g>':item.motion==='bath'?'<g class="sticker-water"><ellipse cx="60" cy="98" rx="47" ry="12" fill="#a8e2eb" opacity=".85"/><path d="M20 97 Q31 92 41 97 T63 97 T85 97 T103 97" fill="none" stroke="white" stroke-width="3"/></g>':'';
    svg.innerHTML = `<ellipse class="sticker-shadow" cx="60" cy="107" rx="29" ry="5" fill="#17372a" opacity=".09"/><g class="sticker-body">${shape}<path class="sticker-hand left" d="M23 72 Q3 63 10 49" fill="none" stroke="${item.color}" stroke-width="9" stroke-linecap="round"/><path class="sticker-hand right" d="M97 72 Q116 59 110 43" fill="none" stroke="${item.color}" stroke-width="9" stroke-linecap="round"/>${eyes}<ellipse cx="35" cy="65" rx="7" ry="4" fill="#ff7289" opacity=".36"/><ellipse cx="85" cy="65" rx="7" ry="4" fill="#ff7289" opacity=".36"/><path d="${mouth}" fill="${item.face==='happy'?'#283d46':'none'}" stroke="${item.family==='bot'?'#93f3df':'#283d46'}" stroke-width="3.5" stroke-linecap="round"/><text class="sticker-mark" x="99" y="25" text-anchor="middle" font-size="23" fill="#d46785">${item.mark}</text></g>${extras}`;
    return svg;
  }
  window.KivoStickers = { items, render, packs:['团团','奶猫','水豚','机器人'] };
})();
