import { env } from './config/env.js';
import { composeServer } from './compose.js';
import { services } from './core/services.js';
import { createLockTable } from './ws/lock.js';
import { attachWsServer } from './ws/server.js';
import { createMemoryGroups, DEV_GROUPS } from './dev/dev-groups.js';

// P2 store + control API (Swagger at /docs) + P1 Meta face + P3 WebSocket (/ws).
const { app, metaFace } = composeServer();

const server = app.listen(env.PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${env.PORT}  (API docs: /docs)`);
  console.log(`🔌 WebSocket on ws://localhost:${env.PORT}/ws`);
  console.log(`   webhooks → ${env.COMDOVE_WEBHOOK_URL}`);
  metaFace.start(); // resume webhooks left pending by a previous run
  void services.verify!().then((r) =>
    console.log(r.ok ? '🤝 webhook handshake ok' : `⚠️  webhook handshake failed: ${r.detail} (continuing)`),
  );
});

// WebSocket: group sessions + lock + heartbeat. Still on in-memory groups `alpha` and
// `beta` until P3 plugs P2's store in behind GroupDirectory (checkpoint ①).
attachWsServer(server, { lock: createLockTable(), groups: createMemoryGroups(DEV_GROUPS) });
