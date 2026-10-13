import { unlink } from 'node:fs/promises';
import path from 'node:path';

const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const day = 86400000;

export function registerHistoryRoutes(app, { db, dataDir, io, conversation, updateConversation }) {
  const requireConversation = (req, res, next) => {
    if (!uuid(req.params.id) || !conversation(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    next();
  };
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const removeFiles = async ids => {
    for (const id of ids) {
      try { await unlink(path.resolve(dataDir, 'media', `${id}.webp`)); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Cannot remove deleted media file:', error.code); }
    }
  };
  const notify = (id, event, data) => io.to('admins').to(`conversation:${id}`).emit(event, { conversationId: id, ...data });
  const cleanupInput = (input, preview) => {
    const { scope, siteId = '' } = input;
    if (!['all', '7days', 'month'].includes(scope) || (siteId && (!uuid(siteId) || !db.prepare('SELECT id FROM sites WHERE id=?').get(siteId)))) throw new Error('删除范围无效');
    const latest = Date.now() - (scope === '7days' ? 7 * day : scope === 'month' ? 30 * day : 0);
    const cutoff = preview ? latest : input.cutoff;
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > latest) throw new Error('请重新预览删除范围');
    return { scope, siteId, cutoff };
  };
  const matching = ({ scope, siteId, cutoff }) => db.prepare(`SELECT id FROM conversations WHERE (?='' OR site_id=?) AND ${scope === 'all' ? 'created_at<=?' : 'updated_at<?'}`).all(siteId, siteId, cutoff);
  function removeConversations(rows) {
    const mediaIds = [];
    transaction(() => {
      for (const { id } of rows) {
        mediaIds.push(...db.prepare('SELECT id FROM media WHERE conversation_id=?').all(id).map(m => m.id));
        // Delete dependent rows first; avatar media and site configuration stay intact.
        for (const table of ['messages', 'media', 'auto_reply_state', 'visitor_devices', 'website_users', 'visitor_labels', 'client_profiles']) db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(id);
        db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      }
    });
    for (const { id } of rows) {
      notify(id, 'conversation:deleted', {});
      for (const socket of io.of('/').sockets.values()) if (socket.data.conversationId === id) socket.disconnect(true);
    }
    return mediaIds;
  }
  app.get('/api/admin/conversations/cleanup', (req, res) => {
    try { const input = cleanupInput(req.query, true); res.json({ ...input, count: matching(input).length }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/admin/conversations/cleanup', async (req, res) => {
    let input;
    try { input = cleanupInput(req.body || {}, false); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const rows = matching(input), mediaIds = removeConversations(rows);
    await removeFiles(mediaIds);
    res.json({ ok: true, count: rows.length, deletedIds: rows.map(r=>r.id) });
  });
  app.delete('/api/admin/conversations/:id/messages/:messageId', requireConversation, async (req, res) => {
    const id = req.params.id, messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return res.status(400).json({ error: '消息编号无效' });
    const message = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id=?').get(id, messageId);
    if (!message) return res.status(404).json({ error: '消息不存在' });
    const mediaIds = transaction(() => {
      const c = conversation(id);
      const unread = message.sender === 'visitor' && db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND sender='visitor' AND id>?").get(id, messageId).n < c.unread;
      db.prepare('DELETE FROM messages WHERE id=?').run(messageId);
      if (unread) db.prepare('UPDATE conversations SET unread=MAX(0,unread-1) WHERE id=?').run(id);
      if (message.media_id && !db.prepare('SELECT id FROM messages WHERE media_id=? LIMIT 1').get(message.media_id)) {
        db.prepare('DELETE FROM media WHERE id=?').run(message.media_id);
        return [message.media_id];
      }
      return [];
    });
    notify(id, 'message:deleted', { messageId, mediaIds }); updateConversation(id);
    await removeFiles(mediaIds); res.json({ ok: true, conversationId: id, messageId, mediaIds });
  });
  app.delete('/api/admin/conversations/:id/messages', requireConversation, async (req, res) => {
    const id = req.params.id;
    const { throughId, mediaIds } = transaction(() => {
      const throughId = db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM messages').get().n;
      const mediaIds = db.prepare('SELECT id FROM media WHERE conversation_id=?').all(id).map(m => m.id);
      db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
      db.prepare('DELETE FROM media WHERE conversation_id=?').run(id);
      db.prepare('DELETE FROM auto_reply_state WHERE conversation_id=?').run(id);
      db.prepare('UPDATE conversations SET unread=0 WHERE id=?').run(id);
      return { throughId, mediaIds };
    });
    notify(id, 'history:cleared', { throughId, mediaIds }); updateConversation(id);
    await removeFiles(mediaIds); res.json({ ok: true, conversationId: id, throughId, mediaIds });
  });
  app.delete('/api/admin/conversations/:id', requireConversation, async (req, res) => {
    await removeFiles(removeConversations([{ id: req.params.id }]));
    res.json({ ok: true, conversationId: req.params.id });
  });
}
