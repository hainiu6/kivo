import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('five distinct notification WAVs match browser previews, have stronger average loudness and do not clip', () => {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../public/notification-sounds.js', import.meta.url), 'utf8'), context);
  const { sounds, synthesize } = context.window.KivoNotificationSounds;
  assert.equal(sounds.length, 5); assert.equal(new Set(sounds.map(s => s.id)).size, 5);
  for (const sound of sounds) {
    const samples = synthesize(sound.id, 44100), wav = readFileSync(new URL(`../public/sounds/${sound.id}.wav`, import.meta.url));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.length, 44 + samples.length * 2);
    let power = 0, peak = 0;
    for (let i = 0; i < samples.length; i++) {
      assert.ok(Number.isFinite(samples[i]));
      peak = Math.max(peak, Math.abs(samples[i])); power += samples[i] ** 2;
      assert.ok(Math.abs(wav.readInt16LE(44 + i * 2) / 32767 - samples[i]) < 1 / 32767, 'WAV and browser use the same samples');
    }
    assert.ok(peak > 0.93 && peak < 0.95, sound.id + ' has headroom');
    assert.ok(Math.sqrt(power / samples.length) > 0.23, sound.id + ' is louder on average than the old fading ding');
    assert.ok(samples.length / 44100 < 1.6, 'short notifications');
    assert.equal(samples[0], 0); assert.equal(samples.at(-1), 0);
  }
});
