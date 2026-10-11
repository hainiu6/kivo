import { createKivo } from './app.js';

const service = createKivo();
const port = Number(process.env.PORT || 3000);
service.server.listen(port, '0.0.0.0', () => console.log(`Kivo listening on http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await service.close(); process.exit(0); });
}
