// Track loss of the last browser tab or HTTP lease separately from message times.
export function conversationLifecycle({ db, visitors, updateConversation, clock = Date.now }) {
  // Read receipts and automated replies do not answer a visitor's question.
  const unanswered = "(SELECT sender FROM messages WHERE conversation_id=c.id AND sender IN ('visitor','agent') ORDER BY id DESC LIMIT 1)='visitor'";
  db.exec('CREATE TABLE IF NOT EXISTS conversation_activity(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,offline_since INTEGER,auto_closed INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT OR IGNORE INTO conversation_activity SELECT id,?,0 FROM conversations').run(clock());
  // A process restart drops all in-memory connections. Start their offline clock now.
  db.prepare('UPDATE conversation_activity SET offline_since=? WHERE offline_since IS NULL').run(clock());
  // Restore unanswered conversations closed by the previous automatic rule only.
  db.exec('BEGIN IMMEDIATE');
  try {
    const restore = db.prepare(`SELECT c.id FROM conversations c JOIN conversation_activity a ON a.conversation_id=c.id WHERE c.status='closed' AND a.auto_closed=1 AND ${unanswered}`).all();
    for (const { id } of restore) {
      db.prepare("UPDATE conversations SET status='open' WHERE id=?").run(id);
      db.prepare('UPDATE conversation_activity SET auto_closed=0 WHERE conversation_id=?').run(id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
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
    const rows = db.prepare(`SELECT c.id FROM conversations c JOIN conversation_activity a ON a.conversation_id=c.id WHERE c.status='open' AND a.offline_since<=? AND COALESCE(${unanswered},0)=0`).all(clock() - 600000);
    for (const { id } of rows) {
      if (visitors.get(id)?.size) { sync(id); continue; }
      db.prepare("UPDATE conversations SET status='closed' WHERE id=?").run(id);
      db.prepare('UPDATE conversation_activity SET auto_closed=1 WHERE conversation_id=?').run(id);
      updateConversation(id);
    }
  }
  return { sync, sweep, manual: id => db.prepare('UPDATE conversation_activity SET auto_closed=0 WHERE conversation_id=?').run(id) };
}
