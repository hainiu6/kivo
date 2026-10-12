(() => {
  const $=selector=>document.querySelector(selector),number=value=>Number(value||0).toLocaleString('zh-CN');
  const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
  const link=(url,text)=>{const node=el('a','analytics-link',text||url);node.href=url;node.target='_blank';node.rel='noopener noreferrer';node.title=url;return node;};
  const cell=child=>{const node=el('td');typeof child==='object'?node.append(child):node.textContent=child;return node;};
  window.KivoAnalytics={
    create({api,publicUrl,onChange,onMessage}){
      let active=false,life=0,sitesRevision=0,revision=0,polling,timer,sites=[],days=7,site='',tab='pages',pagesPage=1,visitorsPage=1,saving=false,range='';
      const tables={pages:'页面排行',visitors:'访客明细',domains:'域名分布',sources:'来源网站'};
      const fields=[['pv','浏览量 PV','页面打开、刷新或路由切换'],['uv','访客数 UV','所选时间内按浏览器标识去重'],['ips','独立 IP','所选时间内访问的 IP 数'],['pages','访问页面','按域名、路径及哈希路由汇总']];
      const remember=()=>onChange();
      function chooseTab(next){tab=next;for(const name of Object.keys(tables)){$('#analytics-'+name+'-panel').hidden=name!==tab;$('#analytics-tab-'+name).classList.toggle('active',name===tab);}remember();}
      function renderSites(){
        const list=$('#analytics-site-list');list.replaceChildren();
        $('#analytics-site-count').textContent=sites.length;$('#analytics-sites-empty').hidden=Boolean(sites.length);
        const select=$('#analytics-site');select.replaceChildren(el('option','','所有统计站点'));select.firstChild.value='';
        for(const entry of sites){
          const option=el('option','',entry.name);option.value=entry.id;select.append(option);
          const card=el('article','analytics-site-card'),heading=el('div','analytics-site-heading');heading.append(el('strong','',entry.name),el('span','analytics-unrestricted','不限制域名'));
          const code=el('textarea','analytics-code');code.value=`<script src="${publicUrl()}/analytics.js" data-site="${entry.id}" async></script>`;code.readOnly=true;code.rows=2;code.setAttribute('aria-label',entry.name+'统计代码');code.spellcheck=false;
          const actions=el('div','site-actions'),copy=el('button','button primary small','复制统计代码');copy.type='button';copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.value);onMessage('统计代码已复制');}catch{code.focus();code.select();onMessage('请按 Ctrl+C / ⌘C 复制选中的统计代码');}};
          const view=el('button','button secondary small','查看统计');view.type='button';view.onclick=()=>{site=entry.id;select.value=site;pagesPage=visitorsPage=1;remember();$('#analytics-setup').open=false;load();};
          const edit=el('button','text-button','改名');edit.type='button';edit.onclick=()=>openSite(entry);actions.append(copy,view,edit);card.append(heading,code,actions);list.append(card);
        }
        if(site&&!sites.some(s=>s.id===site)){site='';pagesPage=visitorsPage=1;remember();}select.value=site;
        if(!sites.length)$('#analytics-setup').open=true;
      }
      async function loadSites(){const current=life,sequence=++sitesRevision;const rows=await api('/api/admin/analytics/sites');if(current!==life||sequence!==sitesRevision||!active)return false;sites=rows;renderSites();return true;}
      function renderPager(kind,data){
        $('#analytics-'+kind+'-count').textContent=`共 ${number(data.total)} ${kind==='pages'?'个页面':'位访客'} · 第 ${data.page} / ${data.pages} 页`;
        $('#analytics-'+kind+'-prev').disabled=data.page<=1;$('#analytics-'+kind+'-next').disabled=data.page>=data.pages;
      }
      function render(data){
        const cards=$('#analytics-cards');cards.replaceChildren();for(const [key,label,help] of fields){const card=el('article','stat-card');card.append(el('span','stat-label',label),el('strong','stat-number',number(data.summary[key])),el('small','',help));cards.append(card);}
        $('#analytics-period').textContent=`${new Date(data.start+8*3600000).toISOString().slice(0,10)} — ${new Date(data.end+8*3600000).toISOString().slice(0,10)} · 北京时间`;
        $('#analytics-updated').textContent='更新于 '+new Date(data.end).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit'});
        const trend=$('#analytics-trend');trend.replaceChildren();trend.style.setProperty('--days',data.daily.length);const maximum=Math.max(1,...data.daily.flatMap(d=>[d.pv,d.uv]));
        for(const d of data.daily){const column=el('div','trend-day'),bars=el('div','trend-bars');column.title=`${d.date}：PV ${d.pv}，UV ${d.uv}`;for(const key of ['pv','uv']){const bar=el('span','trend-bar '+key);bar.style.height=(d[key]/maximum*100)+'%';bar.dataset.empty=String(!d[key]);bars.append(bar);}column.append(bars,el('small','',d.date.slice(5)));trend.append(column);}
        const sitesBody=$('#analytics-site-summary');sitesBody.replaceChildren();for(const entry of data.sites){const row=el('tr');row.append(el('th','',entry.name),cell(number(entry.pv)),cell(number(entry.uv)),cell(time(entry.lastVisit)));sitesBody.append(row);}
        const pages=$('#analytics-pages');pages.replaceChildren();for(const entry of data.pages.items){const row=el('tr'),page=el('div','analytics-page-cell');page.append(link(entry.page,entry.title||entry.page),el('small','',entry.page));row.append(cell(page),cell(number(entry.pv)),cell(number(entry.uv)),cell(time(entry.lastVisit)));pages.append(row);}
        const visitors=$('#analytics-visitors');visitors.replaceChildren();for(const entry of data.visitors.items){const row=el('tr'),ip=el('div','analytics-visitor-ip');ip.append(el('strong','',entry.ip),el('small','',entry.siteName+' · '+entry.id.slice(0,8)));const device=el('div','analytics-device-cell');device.append(el('span','',entry.os),el('small','',entry.browser));const dates=el('div','analytics-device-cell');dates.append(el('span','',time(entry.lastVisit)),el('small','','首次 '+time(entry.firstVisit)));row.append(cell(ip),cell(entry.region),cell(number(entry.pv)),cell(link(entry.page)),cell(device),cell(dates));visitors.append(row);}
        for(const kind of ['domains','sources']){const body=$('#analytics-'+kind);body.replaceChildren();for(const entry of data[kind]){const row=el('tr');row.append(el('th','',entry.name||(kind==='sources'?'直接访问':'—')),cell(number(entry.pv)),cell(number(entry.uv)));body.append(row);}}
        pagesPage=data.pages.page;visitorsPage=data.visitors.page;renderPager('pages',data.pages);renderPager('visitors',data.visitors);
        for(const kind of Object.keys(tables))$('#analytics-'+kind+'-empty').hidden=Boolean(kind==='pages'||kind==='visitors'?data[kind].items.length:data[kind].length);
        $('#analytics-content').hidden=false;const nextRange=data.start+':'+site;if(range!==nextRange){range=nextRange;const scroller=$('#analytics-trend-scroll');scroller.scrollLeft=scroller.scrollWidth;}
      }
      async function load(quiet=false){
        if(!active)return;const current=++revision;$('#analytics-refresh').disabled=true;$('#analytics-error').textContent='';
        if(!quiet){$('#analytics-loading').hidden=false;$('#analytics-content').hidden=true;}
        try{const data=await api('/api/admin/analytics/stats?'+new URLSearchParams({days,site,pagesPage,visitorsPage}));if(current===revision&&active)render(data);}
        catch(error){if(current===revision&&active)$('#analytics-error').textContent='访问统计加载失败：'+error.message+'。点击刷新可重试。';}
        finally{if(current===revision){$('#analytics-refresh').disabled=false;$('#analytics-loading').hidden=true;}}
      }
      async function refresh(){const current=life;try{if(await loadSites())await load();}catch(error){if(current===life&&active)$('#analytics-error').textContent=error.message;}}
      function openSite(entry){const form=$('#analytics-site-form');form.reset();form.elements.id.value=entry?.id||'';form.elements.name.value=entry?.name||'';$('#analytics-site-title').textContent=entry?'修改统计站点名称':'添加统计站点';$('#analytics-site-error').textContent='';$('#analytics-site-save').disabled=false;$('#analytics-site-dialog').showModal();form.elements.name.focus();}
      $('#analytics-add-site').onclick=()=>openSite();$('#analytics-close-site').onclick=()=>$('#analytics-site-dialog').close();
      $('#analytics-site-form').onsubmit=async event=>{
        event.preventDefault();if(saving)return;saving=true;const current=life,form=event.currentTarget,id=form.elements.id.value;$('#analytics-site-save').disabled=true;$('#analytics-site-error').textContent='';
        try{const result=await api('/api/admin/analytics/sites'+(id?'/'+id:''),{method:id?'PUT':'POST',body:JSON.stringify({name:form.elements.name.value})});if(current!==life||!active)return;if(!id)site=result.id;$('#analytics-site-dialog').close();await loadSites();if(current!==life||!active)return;remember();$('#analytics-setup').open=true;await load();onMessage(id?'站点名称已更新':'统计站点已添加，复制代码即可接入');}
        catch(error){if(current===life&&active){$('#analytics-site-error').textContent=error.message;$('#analytics-error').textContent=error.message;}}
        finally{if(current===life){saving=false;$('#analytics-site-save').disabled=false;}}
      };
      $('#analytics-days').onchange=()=>{days=Number($('#analytics-days').value);pagesPage=visitorsPage=1;remember();load();};
      $('#analytics-site').onchange=()=>{site=$('#analytics-site').value;pagesPage=visitorsPage=1;remember();load();};
      $('#analytics-refresh').onclick=refresh;
      for(const name of Object.keys(tables))$('#analytics-tab-'+name).onclick=()=>chooseTab(name);
      for(const kind of ['pages','visitors'])for(const [direction,change] of [['prev',-1],['next',1]])$('#analytics-'+kind+'-'+direction).onclick=()=>{if(kind==='pages')pagesPage+=change;else visitorsPage+=change;load(true);};
      const stop=()=>{active=false;life++;sitesRevision++;revision++;saving=false;clearTimeout(timer);clearInterval(polling);timer=polling=undefined;$('#analytics-refresh').disabled=false;$('#analytics-loading').hidden=true;$('#analytics-site-dialog').close();};
      return{
        activate(){if(active)return;active=true;life++;refresh();polling=setInterval(()=>{if(!document.hidden)load(true);},30000);},deactivate:stop,
        schedule(){if(active&&!document.hidden){clearTimeout(timer);timer=setTimeout(()=>load(true),600);}},
        getFilters:()=>({analyticsDays:days,analyticsSite:site,analyticsTab:tab}),
        setFilters(saved){days=[1,7,30,90].includes(saved.analyticsDays)?saved.analyticsDays:7;site=saved.analyticsSite||'';tab=Object.hasOwn(tables,saved.analyticsTab)?saved.analyticsTab:'pages';$('#analytics-days').value=String(days);chooseTab(tab);},
        reset(){stop();days=7;site='';tab='pages';sites=[];pagesPage=visitorsPage=1;range='';$('#analytics-content').hidden=true;$('#analytics-error').textContent='';}
      };
    }
  };
})();
