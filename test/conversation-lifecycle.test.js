import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { conversationLifecycle } from '../server/conversation-lifecycle.js';

test('offline closure waits ten minutes after the last connection, preserves history times and survives restart', () => {
  const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE conversations(id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER);CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id TEXT,sender TEXT);INSERT INTO conversations VALUES('tabs','open',123),('rest','open',456),('manual','closed',789)");
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

test('unanswered visitor text/images/stickers survive offline sweeps even when read or automatically replied to', () => {
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER,unread INTEGER);CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id TEXT,sender TEXT,kind TEXT);CREATE INDEX messages_conversation ON messages(conversation_id,id)");
  const visitors=new Map(),updates=[];let time=1000;
  const lifecycle=conversationLifecycle({db,visitors,updateConversation:id=>updates.push(id),clock:()=>time});
  const add=db.prepare('INSERT INTO conversations VALUES(?,?,123,0)'),message=db.prepare('INSERT INTO messages(conversation_id,sender,kind) VALUES(?,?,?)');
  for(const kind of ['text','image','sticker']) {
    add.run(kind,'open');message.run(kind,'agent','text');message.run(kind,'visitor',kind);message.run(kind,'auto','text');lifecycle.sync(kind);
  }
  add.run('answered','open');message.run('answered','visitor','text');message.run('answered','agent','image');lifecycle.sync('answered');
  time+=600000;lifecycle.sweep();
  assert.deepEqual(updates,['answered']);
  time+=86400000;lifecycle.sweep();
  for(const kind of ['text','image','sticker'])assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(kind).status,'open',kind+' remains unanswered despite unread=0 and auto reply');
  // A real agent reply makes the already-ten-minute-offline conversation eligible.
  message.run('text','agent','text');lifecycle.sweep();assert.equal(db.prepare("SELECT status FROM conversations WHERE id='text'").get().status,'closed');
  assert.equal(db.prepare("SELECT updated_at FROM conversations WHERE id='text'").get().updated_at,123);
  db.close();
});

test('upgrade restores only automatically closed unanswered conversations and keeps their offline timer', () => {
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER);CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_id TEXT,sender TEXT);INSERT INTO conversations VALUES('unanswered','closed',123),('manual','closed',123),('answered','closed',123);INSERT INTO messages VALUES(1,'unanswered','visitor'),(2,'unanswered','auto'),(3,'manual','visitor'),(4,'answered','visitor'),(5,'answered','agent');CREATE TABLE conversation_activity(conversation_id TEXT PRIMARY KEY,offline_since INTEGER,auto_closed INTEGER);INSERT INTO conversation_activity VALUES('unanswered',1000,1),('manual',1000,0),('answered',1000,1)");
  const lifecycle=conversationLifecycle({db,visitors:new Map(),updateConversation:()=>{},clock:()=>900000});lifecycle.sweep();
  assert.deepEqual(db.prepare('SELECT id,status FROM conversations ORDER BY id').all().map(row=>[row.id,row.status]),[['answered','closed'],['manual','closed'],['unanswered','open']]);
  assert.equal(db.prepare("SELECT offline_since FROM conversation_activity WHERE conversation_id='unanswered'").get().offline_since,1000);
  db.close();
});
