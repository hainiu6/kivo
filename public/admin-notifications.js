/* global window */
(() => {
  const soundKey = 'kivo.admin.sound';
  window.KivoNotifications = {
    create({ button, favicon, getUnread, onCount }) {
      let enabled = true, active = false, audio, total = 0, generation = 0;
      let timer, refreshing = false, dirty = false, lastTone = -Infinity;
      const seen = new Set();
      try { enabled = localStorage.getItem(soundKey) !== 'off'; } catch {}
      const supported = Boolean(window.AudioContext || window.webkitAudioContext);
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
      function tone(force = false) {
        if (!active || !enabled || audio?.state !== 'running' || (!force && Date.now() - lastTone < 900)) return;
        lastTone = Date.now();
        try {
          const start = audio.currentTime;
          for (const [frequency, offset] of [[660, 0], [880, 0.13]]) {
            const oscillator = audio.createOscillator(), gain = audio.createGain();
            oscillator.type = 'sine'; oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0, start + offset);
            gain.gain.linearRampToValueAtTime(0.13, start + offset + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.19);
            oscillator.connect(gain); gain.connect(audio.destination);
            oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
            oscillator.start(start + offset); oscillator.stop(start + offset + 0.2);
          }
        } catch { renderSound(); }
      }
      async function unlock(preview = false) {
        if (!active || !enabled || !supported) return;
        const current = generation;
        try {
          if (!audio) {
            audio = new (window.AudioContext || window.webkitAudioContext)();
            audio.onstatechange = renderSound;
          }
          await audio.resume();
          if (current !== generation) return;
          renderSound(); if (preview) tone(true);
        } catch { renderSound(); }
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
          setCount(total + 1); tone(); refresh();
        },
        reset() {
          active = false; generation++; clearTimeout(timer); timer = undefined; dirty = false; refreshing = false;
          seen.clear(); setCount(0); lastTone = -Infinity;
          if (audio) { audio.onstatechange = null; audio.close().catch(() => {}); audio = undefined; }
          renderSound();
        }
      };
    }
  };
})();
