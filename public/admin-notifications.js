/* global window */
(() => {
  const soundKey = 'kivo.admin.sound';
  const selectionKey = 'kivo.admin.sound.selection';
  const { sounds, synthesize } = window.KivoNotificationSounds;
  window.KivoNotifications = {
    create({ button, favicon, getUnread, onCount, soundSelect, previewButton, previewStatus }) {
      let enabled = true, active = false, audio, total = 0, generation = 0;
      let selection = sounds[0].id, source;
      const buffers = new Map();
      const loading = new Map();
      let timer, refreshing = false, dirty = false, lastTone = -Infinity;
      const seen = new Set();
      try { enabled = localStorage.getItem(soundKey) !== 'off'; } catch {}
      try { const saved = localStorage.getItem(selectionKey); if (sounds.some(s => s.id === saved)) selection = saved; } catch {}
      const supported = Boolean(window.AudioContext || window.webkitAudioContext);
      if (soundSelect) { soundSelect.value = selection; soundSelect.disabled = !supported; }
      if (previewButton) previewButton.disabled = !supported;
      function showPreviewStatus(message) { if (previewStatus) previewStatus.textContent = message; }
      function renderSound() {
        const ready = audio?.state === 'running';
        const label = !supported ? '浏览器不支持提示音' : !enabled ? '提示音已静音，点击开启' : ready ? '提示音已开启，点击静音' : '点击启用提示音';
        button.title = label; button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(enabled));
        button.dataset.state = !enabled ? 'muted' : ready ? 'ready' : 'pending';
        button.querySelector('.sound-label').textContent = !enabled ? '提示音已静音' : ready ? '提示音已开启' : '点击启用提示音';
        button.querySelector('.nav-icon').textContent = !enabled ? '🔕' : ready ? '🔔' : '♫';
        button.disabled = !supported;
      }
      function setCount(count) {
        total = Math.max(0, Number.isSafeInteger(count) ? count : 0);
        document.title = total ? `(${total} 条未读) Kivo · 客服工作台` : 'Kivo · 客服工作台';
        // Static PNG icons also work in Safari versions that reject SVG/data URL favicons.
        favicon.href = total ? '/favicon-unread.png' : '/favicon.png';
        onCount(total);
      }
      async function soundBuffer(id) {
        if (buffers.has(id)) return buffers.get(id);
        if (loading.has(id)) return loading.get(id);
        const sound = sounds.find(s => s.id === id), context = audio, current = generation;
        const pending = (async () => {
          let buffer;
          if (sound.source) {
            const response = await fetch(sound.source);
            if (!response.ok) throw new Error('Sound file unavailable');
            buffer = await context.decodeAudioData(await response.arrayBuffer());
          } else {
            const samples = synthesize(id, context.sampleRate);
            buffer = context.createBuffer(1, samples.length, context.sampleRate); buffer.copyToChannel(samples, 0);
          }
          if (current === generation && context === audio) buffers.set(id, buffer);
          return buffer;
        })();
        loading.set(id, pending);
        try { return await pending; }
        finally { if (loading.get(id) === pending) loading.delete(id); }
      }
      async function tone(preview = false) {
        if (!active || (!enabled && !preview) || audio?.state !== 'running' || (!preview && Date.now() - lastTone < 1600)) return false;
        if (!preview) lastTone = Date.now();
        const current = generation, id = selection;
        try {
          const buffer = await soundBuffer(id);
          if (!active || current !== generation || id !== selection || (!enabled && !preview) || audio?.state !== 'running') return false;
          if (source) { source.stop(); source.disconnect(); }
          const next = audio.createBufferSource(); source = next;
          next.buffer = buffer; next.connect(audio.destination);
          next.onended = () => { next.disconnect(); if (source === next) source = undefined; };
          next.start();
          return true;
        } catch { if (current === generation) renderSound(); return false; }
      }
      async function unlock(preview = false) {
        if (!active || (!enabled && !preview) || !supported) return;
        const current = generation;
        try {
          if (!audio) {
            audio = new (window.AudioContext || window.webkitAudioContext)();
            audio.onstatechange = renderSound;
          }
          await audio.resume();
          if (current !== generation) return;
          renderSound();
          if (preview) {
            const id = selection, played = await tone(true);
            if (current !== generation || id !== selection) return;
            showPreviewStatus(played ? `正在试听：${sounds.find(s => s.id === selection).name}${enabled ? '' : '（消息提示仍为静音）'}` : '未能播放，请再次点击试听');
          } else soundBuffer(selection).catch(() => {});
        } catch { if (current !== generation) return; renderSound(); if (preview) showPreviewStatus('浏览器未允许播放，请再次点击试听'); }
      }
      function refresh() {
        if (!active) return;
        dirty = true;
        if (timer || refreshing) return;
        const current = generation;
        timer = setTimeout(async () => {
          timer = undefined; dirty = false; refreshing = true;
          try {
            const result = await getUnread();
            if (current === generation && active && !dirty) setCount(result.total);
          } catch { /* The normal API handler handles expired sessions. Retry on the next update. */ }
          finally {
            if (current === generation) { refreshing = false; if (dirty) refresh(); }
          }
        }, 100);
      }
      button.onclick = () => {
        if (!active) return;
        if (enabled && audio?.state === 'running') enabled = false;
        else { enabled = true; unlock(true); }
        try { localStorage.setItem(soundKey, enabled ? 'on' : 'off'); } catch {}
        renderSound();
      };
      if (soundSelect) soundSelect.onchange = () => {
        if (!sounds.some(s => s.id === soundSelect.value)) { soundSelect.value = selection; return; }
        selection = soundSelect.value;
        try { localStorage.setItem(selectionKey, selection); } catch {}
        showPreviewStatus(`已选择：${sounds.find(s => s.id === selection).name}${enabled ? '' : '（消息提示仍为静音）'}`);
      };
      if (previewButton) previewButton.onclick = () => unlock(true);
      // A trusted click/key press also unlocks audio after login, including Safari.
      const gesture = event => { if (event.isTrusted && !button.contains(event.target) && audio?.state !== 'running') unlock(); };
      document.addEventListener('pointerdown', gesture);
      document.addEventListener('keydown', gesture);
      renderSound();
      return {
        start() { active = true; refresh(); renderSound(); },
        refresh,
        receive(message) {
          if (!active || message?.sender !== 'visitor' || !Number.isSafeInteger(message.id) || seen.has(message.id)) return;
          seen.add(message.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
          setCount(total + 1); void tone(); refresh();
        },
        reset() {
          active = false; generation++; clearTimeout(timer); timer = undefined; dirty = false; refreshing = false;
          seen.clear(); setCount(0); lastTone = -Infinity;
          if (source) { source.stop(); source.disconnect(); source = undefined; }
          buffers.clear(); loading.clear(); showPreviewStatus('');
          if (audio) { audio.onstatechange = null; audio.close().catch(() => {}); audio = undefined; }
          renderSound();
        }
      };
    }
  };
})();
