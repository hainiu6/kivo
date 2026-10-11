import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness({ muted = false, blocked = false } = {}) {
  const events = {}, timers = new Map(), counts = [], requests = [], stored = new Map();
  if (muted) stored.set('kivo.admin.sound', 'off');
  let now = 1000, nextTimer = 0, tones = 0, context;
  const label = {}, icon = {}, button = { dataset: {}, attributes: {}, querySelector: selector => selector === '.sound-label' ? label : icon, contains: node => node === button, setAttribute(key, value) { this.attributes[key] = value; } };
  class Audio {
    constructor() { context = this; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { if (blocked) throw new Error('gesture required'); this.state = 'running'; this.onstatechange?.(); }
    async close() { this.state = 'closed'; }
    createOscillator() { return { frequency: {}, connect() {}, disconnect() {}, start() { tones++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  const document = { title: '', addEventListener: (event, callback) => { events[event] = callback; } }, favicon = {}, window = { AudioContext: Audio };
  vm.runInNewContext(readFileSync(new URL('../public/admin-notifications.js', import.meta.url), 'utf8'), {
    window, document, localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    Date: { now: () => now }, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id)
  });
  const notifications = window.KivoNotifications.create({ button, favicon, onCount: count => counts.push(count), getUnread: () => new Promise(resolve => requests.push(resolve)) });
  return { notifications, button, document, favicon, events, counts, stored, requests, get context() { return context; }, get tones() { return tones; }, nextTone: () => { now += 1500; }, flush: async () => { const [id, callback] = timers.entries().next().value || []; if (callback) { timers.delete(id); callback(); } await Promise.resolve(); }, tick: async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); } };
}

test('new visitor messages play the single ding once; replies, history, bursts and duplicates stay quiet', async () => {
  const h = harness(); h.notifications.start(); await h.flush(); h.requests.shift()({ total: 7 }); await h.tick();
  assert.equal(h.tones, 0, 'loading unread history must not play sound');
  assert.match(h.document.title, /7 条未读/);
  assert.equal(h.favicon.href, '/favicon-unread.png');
  h.events.pointerdown({ isTrusted: false, target: {} }); await h.tick(); assert.equal(h.context, undefined);
  h.events.pointerdown({ isTrusted: true, target: {} }); await h.tick();
  assert.equal(h.context.state, 'running');
  h.notifications.receive({ id: 1, sender: 'visitor' }); assert.equal(h.tones, 1); assert.equal(h.counts.at(-1), 8);
  h.nextTone(); h.notifications.receive({ id: 1, sender: 'visitor' }); assert.equal(h.tones, 1, 'duplicate delivery must not ring twice');
  h.notifications.receive({ id: 2, sender: 'agent' }); h.notifications.receive({ id: 3, sender: 'auto' }); assert.equal(h.tones, 1);
  h.notifications.receive({ id: 4, sender: 'visitor', kind: 'image' }); assert.equal(h.tones, 2);
  h.notifications.receive({ id: 5, sender: 'visitor', kind: 'sticker' }); assert.equal(h.tones, 2, 'a burst uses one alert');
  h.button.onclick(); assert.equal(h.stored.get('kivo.admin.sound'), 'off'); h.nextTone();
  h.notifications.receive({ id: 6, sender: 'visitor' }); assert.equal(h.tones, 2); assert.equal(h.counts.at(-1), 11);
  h.button.onclick(); await h.tick(); assert.equal(h.tones, 3, 'enabling sound previews the alert');
  assert.equal(h.stored.get('kivo.admin.sound'), 'on');
});

test('global count reconciles after reads/deletions, drops stale responses and resets safely on logout', async () => {
  const h = harness(); h.notifications.start(); await h.flush();
  h.notifications.receive({ id: 1, sender: 'visitor' }); assert.equal(h.counts.at(-1), 1);
  h.requests.shift()({ total: 0 }); await h.tick(); assert.equal(h.counts.at(-1), 1, 'old snapshot cannot erase a new alert');
  await h.flush(); h.requests.shift()({ total: 203 }); await h.tick();
  assert.match(h.document.title, /203 条未读/); assert.equal(h.favicon.href, '/favicon-unread.png');
  h.notifications.refresh(); await h.flush(); h.requests.shift()({ total: 0 }); await h.tick();
  assert.equal(h.document.title, 'Kivo · 客服工作台'); assert.equal(h.favicon.href, '/favicon.png');
  h.notifications.refresh(); await h.flush(); const old = h.requests.shift(); h.notifications.reset();
  h.notifications.start(); await h.flush(); h.requests.shift()({ total: 2 }); await h.tick();
  old({ total: 99 }); await h.tick(); assert.equal(h.counts.at(-1), 2, 'previous login responses cannot restore its unread count');
  h.notifications.reset(); h.notifications.receive({ id: 3, sender: 'visitor' }); assert.equal(h.counts.at(-1), 0);
});

test('muted preference persists and blocked audio leaves an actionable enable button without losing unread alerts', async () => {
  const muted = harness({ muted: true }); muted.notifications.start(); muted.events.keydown({ isTrusted: true, target: {} }); await muted.tick();
  assert.equal(muted.context, undefined); assert.equal(muted.button.dataset.state, 'muted');
  const h = harness({ blocked: true }); h.notifications.start(); h.button.onclick(); await h.tick();
  assert.equal(h.button.dataset.state, 'pending'); assert.equal(h.button.title, '点击启用提示音');
  h.notifications.receive({ id: 1, sender: 'visitor' }); assert.equal(h.tones, 0); assert.equal(h.counts.at(-1), 1);
});
