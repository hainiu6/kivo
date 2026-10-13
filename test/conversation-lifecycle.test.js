import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { conversationLifecycle } from '../server/conversation-lifecycle.js';

test('offline closure waits ten minutes after the last connection, preserves history times and survives restart', () => {
  const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE conversations(id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER);INSERT INTO conversations VALUES('tabs','open',123),('rest','open',456),('manual','closed',789)");
  const visitors=new Map(),updates=[];let time=1000;
  const options={db,visitors,updateConversation:id=>updates.push(id),clock:()=>time};
  let lifecycle=conversationLifecycle(options);
  visitors.set('tabs',new Set(['tab1','tab2']));lifecycle.sync('tabs');
  visitors.set('rest',new Set(['http-lease']));lifecycle.sync('rest');
  time+=700000;visitors.get('tabs').delete('tab1');lifecycle.sync('tabs');lifecycle.sweep();
  assert.equal(db.prepare("SELECT status FROM conversations WHERE id='tabs'").get().status,'open');
  visitors.delete('tabs');lifecycle.sync('tabs');time+=599999;lifecycle.sweep();
  assert.equal(db.prepare("SELECT status FROM conversations WHERE id='tabs'").get().status,'open');
  time++;lifecycle.sweep();assert.deepEqual(updates,['tabs']);
  assert.deepEqual({...db.prepare("SELECT status,updated_at FROM conversations WHERE id='tabs'").get()},{status:'closed',updated_at:123});
  visitors.set('tabs',new Set(['new-tab']));lifecycle.sync('tabs');assert.equal(db.prepare("SELECT status FROM conversations WHERE id='tabs'").get().status,'open');
  visitors.set('manual',new Set(['tab']));lifecycle.sync('manual');assert.equal(db.prepare("SELECT status FROM conversations WHERE id='manual'").get().status,'closed');
  // Leases and sockets are treated alike, but reconnects cancel the offline timer.
  visitors.delete('rest');lifecycle.sync('rest');time+=300000;visitors.set('rest',new Set(['lease-new']));lifecycle.sync('rest');time+=300000;lifecycle.sweep();
  assert.equal(db.prepare("SELECT status FROM conversations WHERE id='rest'").get().status,'open');
  visitors.delete('rest');lifecycle.sync('rest');const offline=time;
  time+=100000;visitors.clear();lifecycle=conversationLifecycle(options);
  assert.equal(db.prepare("SELECT offline_since FROM conversation_activity WHERE conversation_id='rest'").get().offline_since,offline);
  time=offline+600000;lifecycle.sweep();assert.equal(db.prepare("SELECT status FROM conversations WHERE id='rest'").get().status,'closed');
  // Deliberately closed conversations never reopen just because a tab connects.
  lifecycle.manual('rest');visitors.set('rest',new Set(['tab']));lifecycle.sync('rest');assert.equal(db.prepare("SELECT status FROM conversations WHERE id='rest'").get().status,'closed');
  db.prepare("DELETE FROM conversations WHERE id='rest'").run();lifecycle.sync('rest');assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversation_activity WHERE conversation_id='rest'").get().n,0);
  db.close();
});
