/* global window */
(() => {
  // All notes use the same envelope and are normalized as a complete alert,
  // keeping previews and real notifications equally loud without clipping.
  const sounds = [
    { id: 'bright', name: '清亮单叮', description: '一声清脆的叮，简洁直接', notes: [[0, 1046.5, 0.95]], harmonics: [1, 0.4, 0.18] },
    { id: 'double', name: '醒目双叮', description: '叮、叮两声，第二声更亮', notes: [[0, 880, 0.47], [0.53, 1318.5, 0.58]], harmonics: [1, 0.3, 0.2] },
    { id: 'rise', name: '欢快三音', description: '三个上扬音符，轻快又明显', notes: [[0, 784, 0.32], [0.36, 1046.5, 0.32], [0.72, 1568, 0.46]], harmonics: [1, 0.32, 0.12] },
    { id: 'call', name: '急促呼叫', description: '三次短促呼叫，节奏辨识度高', notes: [[0, 987.8, 0.28], [0.36, 987.8, 0.28], [0.72, 987.8, 0.4]], harmonics: [1, 0.55, 0.25] },
    { id: 'doorbell', name: '经典叮咚', description: '高低两声叮咚，声音饱满', notes: [[0, 1174.66, 0.57], [0.63, 784, 0.76]], harmonics: [1, 0.24, 0.13] },
    { id: 'wechat', name: '微信风格', description: '短促清脆的滴咚，轻快醒目', notes: [[0, 1568, 0.16], [0.18, 1046.5, 0.28]], harmonics: [1, 0.2, 0.07] }
  ];
  function synthesize(id, sampleRate) {
    const sound = sounds.find(s => s.id === id) || sounds[0];
    const duration = Math.max(...sound.notes.map(([start, , length]) => start + length)) + 0.03;
    const samples = new Float32Array(Math.ceil(duration * sampleRate));
    for (const [start, frequency, length] of sound.notes) {
      const offset = Math.round(start * sampleRate), count = Math.floor(length * sampleRate);
      for (let i = 0; i < count; i++) {
        const time = i / sampleRate;
        const attack = Math.min(1, time / 0.008);
        const release = Math.min(1, (length - time) / 0.1);
        const envelope = attack * release * Math.exp(-1.4 * time / length);
        const phase = 2 * Math.PI * frequency * time;
        const wave = sound.harmonics.reduce((sum, gain, h) => sum + gain * Math.sin((h + 1) * phase), 0);
        samples[offset + i] += wave * envelope;
      }
    }
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    for (let i = 0; i < samples.length; i++) samples[i] *= 0.94 / peak;
    return samples;
  }
  window.KivoNotificationSounds = { sounds, synthesize };
})();
