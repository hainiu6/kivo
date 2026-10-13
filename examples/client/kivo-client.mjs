// HTTPS helper for Node/Electron, WebView and fetch-compatible mobile runtimes.
// It accepts short-lived credentials only; never pass the site signing key here.
export class KivoClient {
  constructor({ baseUrl, siteId, fetchImpl = globalThis.fetch }) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('baseUrl must be an HTTP(S) origin');
    this.baseUrl = url.origin; this.siteId = siteId; this.fetch = fetchImpl; this.accessToken = ''; this.session = null;
  }
  async request(path, { method = 'GET', body, raw = false } = {}) {
    const headers = { 'X-Kivo-Site': this.siteId };
    if (this.accessToken) headers.Authorization = 'Bearer ' + this.accessToken;
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    const response = await this.fetch(this.baseUrl + '/api/client/v1' + path, { method, headers, credentials: 'omit', body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    if (raw && method === 'GET' && response.ok) return response.blob();
    let result; try { result = await response.json(); } catch { const error = new Error('接口未返回 JSON，请检查反向代理'); error.status = response.ok ? 502 : response.status; throw error; }
    if (!response.ok) { const error = new Error(result.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
    return result;
  }
  async start(identityToken, client, screen = '') {
    const session = await this.request('/sessions', { method: 'POST', body: { siteId: this.siteId, identityToken, client, screen } });
    this.session = session; this.accessToken = session.accessToken; return session;
  }
  async status() { return this.request('/session'); }
  async history(before) { return this.request('/messages' + (before === undefined ? '' : '?before=' + encodeURIComponent(before))); }
  async send(message) {
    const clientId = message.clientId || globalThis.crypto?.randomUUID?.();
    if (!clientId) throw new Error('Supply a UUID clientId from your platform');
    return this.request('/messages', { method: 'POST', body: { ...message, clientId } });
  }
  async upload(formData) { return this.request('/images', { method: 'POST', body: formData, raw: true }); }
  async image(mediaId) { return this.request('/images/' + encodeURIComponent(mediaId), { raw: true }); }
  async context(screen) { return this.request('/context', { method: 'POST', body: { screen } }); }
  socketAuth() { return { role: 'visitor', siteId: this.siteId, visitorToken: this.accessToken }; }
  async logout() {
    try { if (this.accessToken) await this.request('/session', { method: 'DELETE' }); }
    finally { this.accessToken = ''; this.session = null; }
  }
}
