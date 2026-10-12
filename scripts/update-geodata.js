import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Reader } from 'maxmind';

const month = process.argv[2];
if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('用法：npm run geoip:update -- YYYY-MM');
const url = `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;
const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
if (!response.ok) throw new Error(`地区库下载失败：HTTP ${response.status}`);
let size = 0;
const chunks = [];
for await (const chunk of response.body) {
  size += chunk.length;
  if (size > 16 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('地区库下载超出大小限制'); }
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const metadata = new Reader(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 })).metadata;
if (metadata.databaseType !== 'DBIP-Country-Lite' || metadata.buildEpoch.toISOString().slice(0, 7) !== month) throw new Error('地区库类型或月份不符');
const directory = new URL('../server/geo/', import.meta.url);
mkdirSync(directory, { recursive: true });
const manifest = { source: 'DB-IP.com', edition: metadata.databaseType, month, builtAt: metadata.buildEpoch.toISOString(), download: url, license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', sha256: createHash('sha256').update(bytes).digest('hex') };
const database = new URL('dbip-country-lite.mmdb.gz', directory), index = new URL('manifest.json', directory);
const pending = new URL('dbip-country-lite.mmdb.gz.new', directory), pendingIndex = new URL('manifest.json.new', directory);
writeFileSync(pending, bytes); writeFileSync(pendingIndex, JSON.stringify(manifest, null, 2) + '\n');
renameSync(pending, database); renameSync(pendingIndex, index);
console.log(`地区库已更新：${month}，SHA-256 ${manifest.sha256}`);
