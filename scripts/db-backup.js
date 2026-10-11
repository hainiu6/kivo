import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';

const file = process.argv[2];
if (!file) throw new Error('Provide an absolute backup destination');
const db = new DatabaseSync(path.join(process.env.DATA_DIR || './data', 'kivo.sqlite'), { readOnly:true });
try { await backup(db, file); console.log('SQLite backup complete'); } finally { db.close(); }
