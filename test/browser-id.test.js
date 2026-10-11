import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('message IDs work on an HTTP IP address without crypto.randomUUID', () => {
  const browser = { window:{}, crypto:{ getRandomValues:bytes=>webcrypto.getRandomValues(bytes) } };
  runInNewContext(readFileSync(new URL('../public/message-id.js',import.meta.url),'utf8'),browser);
  const ids = Array.from({length:100},()=>browser.window.kivoMessageId());
  ids.forEach(id=>assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/));
  assert.equal(new Set(ids).size,100);
});
