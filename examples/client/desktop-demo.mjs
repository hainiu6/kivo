import { io } from 'socket.io-client';
import { KivoClient } from './kivo-client.mjs';
const { KIVO_URL, KIVO_SITE_ID, KIVO_CLIENT_TOKEN } = process.env;
if (!KIVO_URL || !KIVO_SITE_ID || !KIVO_CLIENT_TOKEN) throw new Error('Set KIVO_URL, KIVO_SITE_ID and KIVO_CLIENT_TOKEN (short-lived credential from your backend).');
const client = new KivoClient({ baseUrl: KIVO_URL, siteId: KIVO_SITE_ID });
await client.start(KIVO_CLIENT_TOKEN, { platform: process.env.KIVO_CLIENT_PLATFORM || ({win32:'Windows',darwin:'macOS',linux:'Linux'}[process.platform] || 'Other'), version:'demo-1.0', device:'客户端接入示例' }, '客服页面');
const socket = io(client.baseUrl, { path:'/socket.io', auth:client.socketAuth(), autoConnect:false, reconnection:true });
socket.on('history', messages => console.log('history', messages));
socket.on('message:new', message => console.log('message', message));
socket.on('agents:status', status => console.log('support', status));
for (const event of ['message:deleted','history:cleared']) socket.on(event, payload => console.log(event, payload));
socket.on('conversation:deleted', () => { console.log('会话已删除，请由用户主动重新开始'); socket.disconnect(); });
socket.on('connect_error', error => console.error(error.message));
socket.connect();
process.once('SIGINT', async () => { socket.disconnect(); try { await client.logout(); } catch(error) { console.error(error.message); } process.exit(0); });
// Before expiresAt, obtain a fresh credential from your authenticated backend,
// call client.start() again, then emit visitor:identity with client.accessToken.
