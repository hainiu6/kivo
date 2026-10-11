/* global KivoStickers */
(function () {
  const images = new Map();
  const el = (tag, cls, text) => { const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n; };
  function clearImages() { for(const entry of images.values())entry.then(url=>URL.revokeObjectURL(url)).catch(()=>{});images.clear(); }
  async function imageUrl(id, headers) {
    if (!images.has(id)) {
      const promise=fetch(`/api/media/${encodeURIComponent(id)}`,{headers,credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error('图片加载失败');return URL.createObjectURL(await r.blob());});
      images.set(id,promise);promise.catch(()=>images.delete(id));
      if(images.size>150){const key=images.keys().next().value;images.get(key).then(url=>URL.revokeObjectURL(url)).catch(()=>{});images.delete(key);}
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
  function composer({form,input,tools,preview,onError=()=>{},getContext,uploadUrl,headers=()=>({}),onSubmitLock=()=>{}}) {
    let attachment=null, uploading=false, revision=0;
    const picker=el('div','emoji-picker');picker.hidden=true;picker.setAttribute('role','group');picker.setAttribute('aria-label','表情选择');
    const emoji=el('button','chat-tool','☺');emoji.type='button';emoji.title='表情和动态表情';emoji.setAttribute('aria-label','打开表情选择');emoji.setAttribute('aria-expanded','false');
    const photo=el('button','chat-tool','＋');photo.type='button';photo.title='发送图片，也可以粘贴截图';photo.setAttribute('aria-label','选择图片');
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
      if(!['image/png','image/jpeg','image/gif','image/webp'].includes(image.type)||image.size>5*1024*1024){onError('请选择不超过 5 MB 的 PNG、JPEG、GIF 或 WebP 图片');return;}
      clear();const current=revision,context=getContext();uploading=true;onSubmitLock(true);renderPreview();onError('');
      try{const r=await fetch(uploadUrl(context),{method:'POST',credentials:'same-origin',headers:{...headers(),'Content-Type':image.type},body:image});const data=await r.json();if(!r.ok)throw new Error(data.error||'上传失败');if(current!==revision||context!==getContext())return;attachment={kind:'image',mediaId:data.id,name:image.name||'粘贴的图片',url:URL.createObjectURL(image)};}
      catch(e){if(current===revision)onError(e.message);}
      finally{if(current===revision){uploading=false;onSubmitLock(false);renderPreview();}}
    }
    file.onchange=()=>{if(file.files[0])attachImage(file.files[0]);file.value='';};
    input.addEventListener('paste',event=>{const files=[...(event.clipboardData?.items||[])].filter(i=>i.kind==='file'&&i.type.startsWith('image/'));if(!files.length)return;event.preventDefault();if(files.length>1){onError('请每次粘贴一张图片');return;}const image=files[0].getAsFile();if(image)attachImage(image);});
    form.addEventListener('keydown',event=>{if(event.key==='Escape'&&!picker.hidden){toggle(false);emoji.focus();event.stopPropagation();}});
    document.addEventListener('pointerdown',e=>{if(!tools.contains(e.target))toggle(false);});
    return { clear, payload:()=>attachment?{kind:attachment.kind,...(attachment.mediaId?{mediaId:attachment.mediaId}:{stickerId:attachment.stickerId})}:{kind:'text'}, hasAttachment:()=>!!attachment, isUploading:()=>uploading, closePicker:()=>toggle(false), destroy:()=>{clear();toggle(false);} };
  }
  const contrast = color => {const rgb=color.replace('#','').match(/../g)?.map(v=>parseInt(v,16))||[0,0,0];return rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>155?'#233238':'#fff';};
  window.KivoChat = { composer,renderMessage,clearImages,contrast };
})();
