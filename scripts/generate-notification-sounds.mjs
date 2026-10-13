// Export the exact browser waveforms so users can also compare them as WAV files.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';
const context = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/notification-sounds.js', import.meta.url), 'utf8'), context);
const { sounds, synthesize } = context.window.KivoNotificationSounds;
const destination = new URL('../public/sounds/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const sound of sounds) {
  const rate = 44100, samples = synthesize(sound.id, rate), bytes = samples.length * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  writeFileSync(new URL(sound.id + '.wav', destination), wav);
  console.log(`${sound.id}: ${sound.name}, ${(samples.length / rate).toFixed(2)} s`);
}
