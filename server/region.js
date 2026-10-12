import { isIP } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { Reader } from 'maxmind';
import geoip from 'geoip-lite';

const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const bundled = new Reader(gunzipSync(readFileSync(new URL('./geo/dbip-country-lite.mmdb.gz', import.meta.url))));
const nameOf = entry => entry?.names?.['zh-CN'] || entry?.names?.en || entry?.iso_code || '';

export function createRegionLookup({ dataDir } = {}) {
  let reader = bundled;
  // A locally supplied, licensed Country/City MMDB survives image upgrades.
  const custom = dataDir && ['geoip.mmdb', 'geoip.mmdb.gz'].map(file => path.join(dataDir, file)).find(existsSync);
  if (custom) {
    try {
      const bytes = readFileSync(custom);
      const candidate = new Reader(custom.endsWith('.gz') ? gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }) : bytes);
      if (!/Country|City/i.test(candidate.metadata.databaseType)) throw new Error('需要 Country 或 City MMDB');
      reader = candidate;
    } catch { console.warn('自定义地区库无效，已使用随版本提供的地区库。'); }
  }
  return value => {
    const ip = typeof value === 'string' ? value.replace(/^::ffff:/i, '') : '';
    if (!isIP(ip)) return '未知 / 内网';
    let source = reader, record = source.get(ip);
    if (!/^[A-Z]{2}$/.test(record?.country?.iso_code || '') || record.country.iso_code === 'ZZ') { source = bundled; record = source.get(ip); }
    const code = record?.country?.iso_code;
    const legacy = geoip.lookup(ip);
    if (!code || !/^[A-Z]{2}$/.test(code) || code === 'ZZ') {
      return legacy?.country ? [names.of(legacy.country), legacy.region, legacy.city].filter(Boolean).join(' · ') : '未知 / 内网';
    }
    const country = names.of(code);
    if (/City/i.test(source.metadata.databaseType)) {
      return [country, nameOf(record.subdivisions?.[0]), nameOf(record.city)].filter(Boolean).join(' · ');
    }
    // Never combine a corrected country with a city from another country.
    return [country, ...(legacy?.country === code ? [legacy.region, legacy.city] : [])].filter(Boolean).join(' · ');
  };
}
