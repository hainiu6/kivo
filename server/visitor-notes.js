// Notes stay on authenticated admin routes and in the private admin socket room.
export function registerVisitorNoteRoutes(app, { db, io }) {
  db.exec(`CREATE TABLE IF NOT EXISTS visitor_notes (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    note TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const get = id => {
    const row = db.prepare('SELECT note, updated_at FROM visitor_notes WHERE conversation_id=?').get(id);
    return { note: row?.note || '', updatedAt: row?.updated_at || 0 };
  };
  const exists = (req, res, next) => {
    if (!db.prepare('SELECT id FROM conversations WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    next();
  };
  app.get('/api/admin/conversations/:id/note', exists, (req, res) => res.json(get(req.params.id)));
  app.put('/api/admin/conversations/:id/note', exists, (req, res) => {
    const { note, updatedAt } = req.body || {};
    if (typeof note !== 'string' || note.length > 2000 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) return res.status(400).json({ error: '备注最多 2000 字，请重新载入后保存' });
    const previous = get(req.params.id);
    if (previous.updatedAt !== updatedAt) return res.status(409).json({ error: '其他客服已修改备注，请载入最新备注后重试', ...previous });
    const result = { note: note.replace(/\r\n?/g, '\n').trim(), updatedAt: Math.max(Date.now(), previous.updatedAt + 1) };
    db.prepare('INSERT INTO visitor_notes(conversation_id,note,updated_at) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at').run(req.params.id, result.note, result.updatedAt);
    io.to('admins').emit('conversation:note', { conversationId: req.params.id, ...result });
    res.json(result);
  });
}
