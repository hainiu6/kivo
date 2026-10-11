import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const formats = new Set(['png', 'jpeg', 'gif', 'webp']);
export async function storeImage(db, dataDir, input, { kind, conversationId = null }) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_IMAGE_BYTES) throw new Error('图片大小须小于 5 MB');
  let output;
  try {
    const image = sharp(input, { limitInputPixels: 25000000, animated: kind === 'chat' });
    const metadata = await image.metadata();
    if (!formats.has(metadata.format) || (metadata.pages || 1) > 80) throw new Error('format');
    output = await image.rotate().resize(kind === 'avatar' ? { width: 160, height: 160, fit: 'cover' } : { width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (output.data.length > MAX_IMAGE_BYTES) throw new Error('size');
  } catch { throw new Error('图片无效或过大，请使用 PNG、JPEG、GIF 或 WebP（最多 2500 万像素 / 80 帧）'); }
  const id = randomUUID(), directory = path.resolve(dataDir, 'media'), file = path.join(directory, `${id}.webp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(file, output.data, { flag: 'wx', mode: 0o600 });
  try {
    // Files and quota reservation are committed before publishing the upload ID.
    db.exec('BEGIN IMMEDIATE');
    if (db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM media').get().n + output.data.length > 1024 * 1024 * 1024) throw new Error('图片存储空间已满（1 GB），请联系管理员清理或归档数据');
    if (conversationId && db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM media WHERE conversation_id=?').get(conversationId).n + output.data.length > 50 * 1024 * 1024) throw new Error('此会话的图片已达到 50 MB 上限');
    db.prepare('INSERT INTO media(id,kind,conversation_id,bytes,width,height,created_at) VALUES(?,?,?,?,?,?,?)').run(id, kind, conversationId, output.data.length, output.info.width, output.info.pageHeight || output.info.height, Date.now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); await unlink(file); throw e; }
  return { id, width: output.info.width, height: output.info.pageHeight || output.info.height, bytes: output.data.length };
}
