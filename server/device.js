// Used for visitor information only; never for feature or permission decisions.
export function deviceInfo(userAgent = '') {
  const ua = String(userAgent).slice(0, 512);
  const version = pattern => pattern.exec(ua)?.[1]?.replaceAll('_', '.') || '';
  let os = '未知系统';
  if (/iPhone|iPad|iPod/.test(ua)) os = `iOS ${version(/(?:CPU(?: iPhone)? OS|iPhone OS) ([\d_]+)/)}`.trim();
  else if (/Android/.test(ua)) os = `Android ${version(/Android ([\d.]+)/)}`.trim();
  else if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10 / 11';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = `macOS ${version(/Mac OS X ([\d_]+)/)}`.trim();
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let browser = '未知浏览器';
  for (const [name, pattern] of [['微信', /MicroMessenger\/([\d.]+)/], ['Edge', /(?:EdgA|EdgiOS|Edg)\/([\d.]+)/], ['Opera', /(?:OPR|OPT)\/([\d.]+)/], ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/], ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/]]) {
    const match = pattern.exec(ua); if (match) { browser = `${name} ${match[1].split('.').slice(0, 2).join('.')}`; break; }
  }
  return { os, browser, ua };
}
