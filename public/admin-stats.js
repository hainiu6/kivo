(() => {
  const $ = selector => document.querySelector(selector);
  const number = value => Number(value || 0).toLocaleString('zh-CN');
  const el = (tag, className, text) => {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  window.KivoStats = {
    create({api,onChange}) {
      let active=false, revision=0, timer, polling, range='';
      const fields=[['newConversations','新增会话','所选时间内首次建立'],['chatConversations','咨询会话','所选时间内有消息的会话'],['visitorMessages','访客消息','文字、图片和表情'],['agentMessages','客服回复','不含自动回复'],['onlineVisitors','当前在线访客','实时状态，不受时间范围影响'],['unreadMessages','当前未读消息','实时状态，不受时间范围影响']];
      function render(data) {
        const cards=$('#stats-cards');cards.replaceChildren();
        fields.forEach(([key,label,help])=>{const card=el('article','stat-card');card.append(el('span','stat-label',label),el('strong','stat-number',number(data.summary[key])),el('small','',help));cards.append(card);});
        $('#stats-period').textContent=`${new Date(data.start+8*3600000).toISOString().slice(0,10)} — ${new Date(data.end+8*3600000).toISOString().slice(0,10)} · 北京时间 UTC+8`;
        $('#stats-updated').textContent='更新于 '+new Date(data.end).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        const trend=$('#stats-trend');trend.replaceChildren();trend.style.setProperty('--days',data.daily.length);
        const maximum=Math.max(1,...data.daily.flatMap(d=>[d.newConversations,d.visitorMessages,d.agentMessages]));
        for(const d of data.daily){const column=el('div','trend-day'),bars=el('div','trend-bars');column.title=`${d.date}：新增会话 ${d.newConversations}，访客消息 ${d.visitorMessages}，客服回复 ${d.agentMessages}`;
          for(const [key,name] of [['newConversations','new'],['visitorMessages','visitor'],['agentMessages','agent']]){const bar=el('span','trend-bar '+name);bar.style.height=(d[key]/maximum*100)+'%';bar.dataset.empty=String(!d[key]);bars.append(bar);}
          column.append(bars,el('small','',d.date.slice(5)));trend.append(column);
        }
        $('#stats-trend-scale').textContent='最高 '+number(maximum===1&&!data.daily.some(d=>d.newConversations||d.visitorMessages||d.agentMessages)?0:maximum)+' 条 / 天';
        const daily=$('#stats-daily');daily.replaceChildren();
        for(const d of data.daily){const row=el('tr');row.append(el('th','',d.date),...['newConversations','visitorMessages','agentMessages','autoMessages'].map(key=>el('td','',number(d[key]))));daily.append(row);}
        const sites=$('#stats-sites');sites.replaceChildren();
        for(const s of data.sites){const row=el('tr');row.append(el('th','',s.name),...['newConversations','chatConversations','visitorMessages','agentMessages','onlineVisitors'].map(key=>el('td','',number(s[key]))));sites.append(row);}
        $('#stats-sites-empty').hidden=Boolean(data.sites.length);
        const types=$('#stats-types');types.replaceChildren();
        const total=data.summary.textMessages+data.summary.imageMessages+data.summary.stickerMessages;
        for(const [key,label] of [['textMessages','文字'],['imageMessages','图片'],['stickerMessages','动态表情']]){const row=el('div','stat-type');const track=el('div','stat-type-track'),bar=el('span');bar.style.width=(total?data.summary[key]/total*100:0)+'%';track.append(bar);row.append(el('span','',label),track,el('strong','',number(data.summary[key])));types.append(row);}
        $('#stats-auto').textContent=number(data.summary.autoMessages);$('#stats-open').textContent=number(data.summary.openConversations);
        $('#stats-content').hidden=false;
        const nextRange=data.start+':'+data.site;if(range!==nextRange){range=nextRange;const scroller=$('.stats-trend-scroll');scroller.scrollLeft=scroller.scrollWidth;}
      }
      async function load(quiet=false) {
        if(!active)return;const current=++revision;$('#stats-refresh').disabled=true;$('#stats-error').textContent='';
        if(!quiet){$('#stats-content').hidden=true;$('#stats-loading').hidden=false;}
        try {const data=await api('/api/admin/stats?'+new URLSearchParams({days:$('#stats-days').value,site:$('#stats-site').value}));if(current===revision&&active)render(data);}
        catch(error){if(current===revision&&active)$('#stats-error').textContent='统计加载失败：'+error.message+'。可点击刷新重试。';}
        finally{if(current===revision){$('#stats-refresh').disabled=false;$('#stats-loading').hidden=true;}}
      }
      const filters=()=>({statsDays:Number($('#stats-days').value),statsSite:$('#stats-site').value});
      for(const selector of ['#stats-days','#stats-site'])$(selector).onchange=()=>{onChange();load();};
      $('#stats-refresh').onclick=()=>load();
      const stop=()=>{active=false;revision++;clearTimeout(timer);clearInterval(polling);timer=polling=undefined;$('#stats-refresh').disabled=false;$('#stats-loading').hidden=true;};
      return {
        activate(){if(active)return;active=true;load();polling=setInterval(()=>{if(!document.hidden)load(true);},30000);},
        deactivate:stop,
        schedule(){if(!active||document.hidden)return;clearTimeout(timer);timer=setTimeout(()=>load(true),600);},
        getFilters:filters,
        setFilters(saved){$('#stats-days').value=String([1,7,30,90].includes(saved.statsDays)?saved.statsDays:7);$('#stats-site').value=[...$('#stats-site').options].some(o=>o.value===saved.statsSite)?saved.statsSite:'';},
        setSites(sites){const selected=$('#stats-site').value;$('#stats-site').replaceChildren(el('option','','所有网站'));$('#stats-site').firstChild.value='';for(const site of sites){const option=el('option','',site.name);option.value=site.id;$('#stats-site').append(option);}$('#stats-site').value=sites.some(s=>s.id===selected)?selected:'';},
        reset(){stop();range='';$('#stats-content').hidden=true;$('#stats-error').textContent='';$('#stats-days').value='7';$('#stats-site').value='';}
      };
    }
  };
})();
