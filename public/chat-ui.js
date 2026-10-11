/* global KivoStickers */
(function () {
  const images = new Map();
  const el = (tag, cls, text) => { const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n; };
  function forgetImages(ids=[]) {
    for(const id of ids){const entry=images.get(id);images.delete(id);entry?.then(url=>{document.querySelectorAll?.('.image-viewer').forEach(dialog=>{if(dialog.querySelector('img')?.src===url)dialog.close();});URL.revokeObjectURL(url);}).catch(()=>{});}
  }
  function clearImages() { document.querySelectorAll?.('.image-viewer').forEach(dialog=>dialog.close());forgetImages([...images.keys()]); }
  async function imageUrl(id, headers) {
    if (!images.has(id)) {
      const promise=fetch(`/api/media/${encodeURIComponent(id)}`,{headers,credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error('图片加载失败');return URL.createObjectURL(await r.blob());});
      images.set(id,promise);promise.catch(()=>{if(images.get(id)===promise)images.delete(id);});
      // Keep URLs for the displayed conversation until it changes. Revoking
      // an evicted URL can race with its image load or break the zoom viewer.
      // Server-side image storage is capped at 50 MB per conversation.
    }
    return images.get(id);
  }
  function viewImage(url) {
    const dialog=el('dialog','image-viewer'),close=el('button','','关闭 ×'),img=el('img');img.src=url;img.alt='聊天图片大图';close.type='button';close.onclick=()=>dialog.close();dialog.append(close,img);dialog.onclose=()=>dialog.remove();dialog.onclick=e=>{if(e.target===dialog)dialog.close();};document.body.append(dialog);dialog.showModal();
  }
  function renderMessage(m, {headers={}, onImageLoad=()=>{}}={}) {
    const bubble=el('div','bubble');
    if(m.kind==='sticker'){bubble.classList.add('sticker-message');bubble.append(KivoStickers.render(m.sticker_id));if(m.body)bubble.append(el('p','',m.body));}
    else if(m.kind==='image'){
      bubble.classList.add('image-message');const state=el('button','image-state','正在加载图片…');state.type='button';bubble.append(state);
      const load=async()=>{state.textContent='正在加载图片…';try{const url=await imageUrl(m.media_id,headers);const img=el('img');img.alt='聊天图片，点击放大';img.src=url;img.onclick=()=>viewImage(url);img.onload=onImageLoad;state.replaceWith(img);}catch{state.textContent='图片加载失败，点击重试';state.onclick=load;}};load();
      if(m.body)bubble.append(el('p','',m.body));
    }else bubble.textContent=m.body;
    return bubble;
  }
  const imageTypes = new Set(['image/png','image/jpeg','image/gif','image/webp']);
  function imageType(image) {
    const original=(image.type||'').toLowerCase();
    const supplied={'image/jpg':'image/jpeg','image/x-png':'image/png'}[original]||original;
    if(imageTypes.has(supplied))return supplied;
    if(supplied&&supplied!=='application/octet-stream')return '';
    const extension=(image.name||'').split('.').at(-1).toLowerCase();
    return {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}[extension]||'';
  }
  function uploadError(status) {
    if(status===413)return '图片超过服务器上传限制，请缩小图片或调整服务器上传限制（HTTP 413）';
    if(status===401)return '登录已过期，请重新登录后上传图片（HTTP 401）';
    if(status===403)return '图片上传未获授权，请刷新页面重试（HTTP 403）';
    if(status===404)return '图片上传接口不存在，请升级客服服务并刷新页面（HTTP 404）';
    if(status===502||status===503||status===504)return `上传服务暂时不可用，请稍后重试（HTTP ${status}）`;
    return `上传接口返回异常内容，请检查客服地址或代理配置（HTTP ${status}）`;
  }
  async function uploadImage(url,image,headers={}) {
    const type=imageType(image);
    if(!type||!image.size||image.size>5*1024*1024)throw new Error('请选择不超过 5 MB 的 PNG、JPEG、GIF 或 WebP 图片');
    // Materialize the file before resetting the chooser; some browsers retain
    // a lazy reference to the selected local file. Send a neutral ASCII filename.
    let blob;
    try { blob=new Blob([await image.arrayBuffer()],{type}); }
    catch { throw new Error('无法读取此图片，请重新选择图片或再次粘贴截图'); }
    const body=new FormData();body.append('image',blob,`image.${type.split('/')[1]}`);
    let response;
    try { response=await fetch(url,{method:'POST',credentials:'same-origin',headers,body}); }
    catch { throw new Error('图片上传连接失败，请检查网络及客服服务地址后重试'); }
    let data;
    try { data=JSON.parse(await response.text()); }
    catch { throw new Error(uploadError(response.status)); }
    if(!response.ok)throw new Error(typeof data?.error==='string'?data.error:uploadError(response.status));
    if(!data||typeof data.id!=='string'||!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(data.id))throw new Error(uploadError(response.status));
    return {...data,blob};
  }
  function composer({form,input,tools,preview,dropTarget=form,onError=()=>{},getContext,uploadUrl,headers=()=>({}),onSubmitLock=()=>{}}) {
    let attachment=null, uploading=false, revision=0;
    const picker=el('div','emoji-picker');picker.hidden=true;picker.setAttribute('role','group');picker.setAttribute('aria-label','表情选择');
    const emoji=el('button','chat-tool','☺');emoji.type='button';emoji.title='表情和动态表情';emoji.setAttribute('aria-label','打开表情选择');emoji.setAttribute('aria-expanded','false');
    const photo=el('button','chat-tool','＋');photo.type='button';photo.title='选择图片，也可以粘贴或拖入图片';photo.setAttribute('aria-label','选择图片');
    const file=el('input');file.type='file';file.accept='image/png,image/jpeg,image/gif,image/webp';file.setAttribute('aria-label','上传聊天图片');
    function toggle(open){picker.hidden=!open;emoji.setAttribute('aria-expanded',String(open));}
    emoji.onclick=()=>toggle(picker.hidden);photo.onclick=()=>file.click();
    picker.append(el('p','emoji-picker-title','表情'));
    const grid=el('div','emoji-grid');
    for(const value of ['😊','😄','😉','🥰','😎','🤔','🥺','😭','👍','🙏','❤️','🎉','✨','☕','✅','👋']) {const b=el('button','',value);b.type='button';b.setAttribute('aria-label',`插入 ${value}`);b.onclick=()=>{const start=input.selectionStart,end=input.selectionEnd;input.setRangeText(value,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();toggle(false);};grid.append(b);}
    picker.append(grid,el('p','emoji-picker-title','团团 · 动态表情'));
    const stickers=el('div','sticker-grid');for(const s of KivoStickers.items){const b=el('button');b.type='button';b.setAttribute('aria-label',s.label);b.append(KivoStickers.render(s.id),el('small','',s.label.split(' · ')[1]));b.onclick=()=>{if(!getContext()){onError('请先选择会话并等待连接');return;}if(uploading){onError('图片正在上传，请稍候');return;}clear();attachment={kind:'sticker',stickerId:s.id};renderPreview();toggle(false);input.focus();};stickers.append(b);}picker.append(stickers);tools.append(photo,emoji,file,picker);
    function renderPreview() {
      preview.replaceChildren();preview.hidden=!attachment&&!uploading;if(preview.hidden)return;
      if(attachment?.kind==='image'){const img=el('img');img.src=attachment.url;img.alt='待发送图片';preview.append(img);}
      if(attachment?.kind==='sticker')preview.append(KivoStickers.render(attachment.stickerId));
      preview.append(el('span','attachment-label',uploading?'图片正在上传…':attachment?.kind==='sticker'?'动态表情 · 点击发送':attachment?.name||'待发送图片'));
      const remove=el('button','','×');remove.type='button';remove.setAttribute('aria-label','移除待发送附件');remove.onclick=clear;preview.append(remove);
    }
    function clear() {revision++;if(attachment?.url)URL.revokeObjectURL(attachment.url);attachment=null;uploading=false;onSubmitLock(false);renderPreview();}
    async function attachImage(image) {
      if(!getContext()){onError('请先选择会话并等待连接');return;}
      if(uploading){onError('图片正在上传，请稍候');return;}
      if(!imageType(image)||!image.size||image.size>5*1024*1024){onError('请选择不超过 5 MB 的 PNG、JPEG、GIF 或 WebP 图片');return;}
      clear();const current=revision,context=getContext();uploading=true;onSubmitLock(true);renderPreview();onError('');
      try{const data=await uploadImage(uploadUrl(context),image,headers());if(current!==revision||context!==getContext())return;attachment={kind:'image',mediaId:data.id,name:image.name||'粘贴的图片',url:URL.createObjectURL(data.blob)};}
      catch(e){if(current===revision)onError(e.message);}
      finally{if(current===revision){uploading=false;onSubmitLock(false);renderPreview();}}
    }
    file.onchange=async()=>{try{if(file.files[0])await attachImage(file.files[0]);}finally{file.value='';}};
    input.addEventListener('paste',event=>{const files=[...(event.clipboardData?.items||[])].filter(i=>i.kind==='file'&&i.type.startsWith('image/'));if(!files.length)return;event.preventDefault();if(files.length>1){onError('请每次粘贴一张图片');return;}const image=files[0].getAsFile();if(image)attachImage(image);});
    let dragDepth=0;
    dropTarget.classList.add('chat-drop-zone');
    const fileDrag=event=>[...(event.dataTransfer?.types||[])].includes('Files');
    const clearDrag=()=>{dragDepth=0;dropTarget.classList.remove('drag-over');};
    dropTarget.addEventListener('dragenter',event=>{if(fileDrag(event)){event.preventDefault();dragDepth++;dropTarget.classList.add('drag-over');}});
    dropTarget.addEventListener('dragover',event=>{if(fileDrag(event)){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
    dropTarget.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)clearDrag();});
    dropTarget.addEventListener('drop',event=>{
      if(!fileDrag(event)&&!event.dataTransfer?.files?.length)return;
      event.preventDefault();event.stopPropagation();clearDrag();
      const files=[...(event.dataTransfer?.files||[])];
      if(files.length!==1){onError('请每次拖入一张本地图片');return;}
      return attachImage(files[0]);
    });
    document.addEventListener('dragend',clearDrag);
    form.addEventListener('keydown',event=>{if(event.key==='Escape'&&!picker.hidden){toggle(false);emoji.focus();event.stopPropagation();}});
    document.addEventListener('pointerdown',e=>{if(!tools.contains(e.target))toggle(false);});
    return { clear, payload:()=>attachment?{kind:attachment.kind,...(attachment.mediaId?{mediaId:attachment.mediaId}:{stickerId:attachment.stickerId})}:{kind:'text'}, hasAttachment:()=>!!attachment, isUploading:()=>uploading, closePicker:()=>toggle(false), destroy:()=>{clear();clearDrag();toggle(false);} };
  }
  const contrast = color => {const rgb=color.replace('#','').match(/../g)?.map(v=>parseInt(v,16))||[0,0,0];return rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>155?'#233238':'#fff';};
  window.KivoChat = { composer,renderMessage,clearImages,forgetImages,contrast,uploadImage };
})();
