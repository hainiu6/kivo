import { randomUUID } from 'node:crypto';

const LIMIT = 50, MAX_DATE = 253402271999000;
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
function validate(input) {
  const data = {};
  for (const [key, label, max, required, singleLine] of [
    ['account', '账号', 200, true, true], ['nodeNumber', '节点编号', 100, true, true],
    ['note', '备注', 2000, false, false], ['node', '节点内容', 65536, true, false]
  ]) {
    const value = input?.[key];
    if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || (singleLine && /[\u0000-\u001f\u007f]/.test(value))) throw Error(`${label}格式无效，最多 ${max} 字`);
    const normalized = value.replace(/\r\n?/g, '\n');
    data[key] = key === 'node' ? normalized : normalized.trim();
    if (required && !data[key].trim()) throw Error(`请填写${label}`);
  }
  for (const key of ['startsAt', 'endsAt']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > MAX_DATE) throw Error('请填写有效的开始、结束时间');
    data[key] = input[key];
  }
  if (data.endsAt <= data.startsAt) throw Error('结束时间须晚于开始时间');
  return data;
}

export function registerCustomNodeRoutes(app, { db, io }) {
  db.exec(`CREATE TABLE IF NOT EXISTS custom_nodes (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, node_number TEXT NOT NULL,
    starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, note TEXT NOT NULL,
    node_text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS custom_nodes_updated ON custom_nodes(updated_at DESC, id DESC);`);
  const fields = 'id,account,node_number AS nodeNumber,starts_at AS startsAt,ends_at AS endsAt,note,created_at AS createdAt,updated_at AS updatedAt';
  const get = id => uuid(id) ? db.prepare(`SELECT ${fields},node_text AS node FROM custom_nodes WHERE id=?`).get(id) : null;
  app.get('/api/admin/custom-nodes', (req, res) => {
    const q = req.query.q ?? '', requested = req.query.page ?? '1';
    if (typeof q !== 'string' || q.length > 100 || typeof requested !== 'string' || !/^[1-9]\d{0,5}$/.test(requested)) return res.status(400).json({ error: '筛选条件无效' });
    const where = 'instr(lower(account),lower(?))>0 OR instr(lower(node_number),lower(?))>0';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM custom_nodes WHERE ${where}`).get(q.trim(), q.trim()).n;
    const pages = Math.max(1, Math.ceil(total / LIMIT)), page = Math.min(Number(requested), pages);
    const items = db.prepare(`SELECT ${fields},substr(node_text,1,160) AS nodePreview,length(node_text) AS nodeLength FROM custom_nodes WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(q.trim(), q.trim(), LIMIT, (page - 1) * LIMIT);
    res.json({ items, page, pages, total, limit: LIMIT });
  });
  app.get('/api/admin/custom-nodes/:id', (req, res) => {
    const row = get(req.params.id);
    if (!row) return res.status(404).json({ error: '节点记录不存在' });
    res.json(row);
  });
  app.post('/api/admin/custom-nodes', (req, res) => {
    let data; try { data = validate(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
    const id = randomUUID(), stamp = Date.now();
    db.prepare('INSERT INTO custom_nodes VALUES(?,?,?,?,?,?,?,?,?)').run(id, data.account, data.nodeNumber, data.startsAt, data.endsAt, data.note, data.node, stamp, stamp);
    io.to('admins').emit('custom-nodes:update', { id });
    res.status(201).json(get(id));
  });
  app.put('/api/admin/custom-nodes/:id', (req, res) => {
    const previous = get(req.params.id);
    if (!previous) return res.status(404).json({ error: '节点记录不存在' });
    let data; try { data = validate(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (!Number.isSafeInteger(req.body.updatedAt) || req.body.updatedAt < 0) return res.status(400).json({ error: '请重新打开记录后保存' });
    if (req.body.updatedAt !== previous.updatedAt) return res.status(409).json({ error: '其他客服已修改此记录，请载入最新记录后再编辑' });
    db.prepare('UPDATE custom_nodes SET account=?,node_number=?,starts_at=?,ends_at=?,note=?,node_text=?,updated_at=? WHERE id=?').run(data.account, data.nodeNumber, data.startsAt, data.endsAt, data.note, data.node, Math.max(Date.now(), previous.updatedAt + 1), previous.id);
    io.to('admins').emit('custom-nodes:update', { id: previous.id });
    res.json(get(previous.id));
  });
}
