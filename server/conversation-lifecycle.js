// Track loss of the last browser tab or HTTP lease separately from message times.
export function conversationLifecycle({ db, visitors, updateConversation, clock = Date.now }) {
  db.exec('CREATE TABLE IF NOT EXISTS conversation_activity(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,offline_since INTEGER,auto_closed INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT OR IGNORE INTO conversation_activity SELECT id,?,0 FROM conversations').run(clock());
  // A process restart drops all in-memory connections. Start their offline clock now.
  db.prepare('UPDATE conversation_activity SET offline_since=? WHERE offline_since IS NULL').run(clock());
  function sync(id) {
    const c = db.prepare('SELECT status FROM conversations WHERE id=?').get(id);
    if (!c) return;
    const online = !!visitors.get(id)?.size;
    db.prepare('INSERT OR IGNORE INTO conversation_activity VALUES(?,?,0)').run(id, online ? null : clock());
    const state = db.prepare('SELECT * FROM conversation_activity WHERE conversation_id=?').get(id);
    if (online) {
      if (state.auto_closed && c.status === 'closed') db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(id);
      db.prepare('UPDATE conversation_activity SET offline_since=NULL,auto_closed=0 WHERE conversation_id=?').run(id);
    } else if (state.offline_since === null || (state.auto_closed && c.status === 'open')) {
      db.prepare('UPDATE conversation_activity SET offline_since=?,auto_closed=0 WHERE conversation_id=?').run(clock(), id);
    }
  }
  function sweep() {
    const rows = db.prepare("SELECT c.id FROM conversations c JOIN conversation_activity a ON a.conversation_id=c.id WHERE c.status='open' AND a.offline_since<=?").all(clock() - 600000);
    for (const { id } of rows) {
      if (visitors.get(id)?.size) { sync(id); continue; }
      db.prepare("UPDATE conversations SET status='closed' WHERE id=?").run(id);
      db.prepare('UPDATE conversation_activity SET auto_closed=1 WHERE conversation_id=?').run(id);
      updateConversation(id);
    }
  }
  return { sync, sweep, manual: id => db.prepare('UPDATE conversation_activity SET auto_closed=0 WHERE conversation_id=?').run(id) };
}
