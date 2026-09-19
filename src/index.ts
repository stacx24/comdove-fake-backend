import { env } from './config/env.js';
import { composeServer } from './compose.js';
import { services } from './core/services.js';

// P2 store + control API (Swagger at /docs) + P1 Meta face + P3 live engine (/ws).
const { app, metaFace, live } = composeServer();

const server = app.listen(env.PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${env.PORT}  (API docs: /docs)`);
  console.log(`🔌 WebSocket on ws://localhost:${env.PORT}/ws`);
  console.log(`   webhooks → ${env.COMDOVE_WEBHOOK_URL}`);
  metaFace.start(); // resume webhooks left pending by a previous run
  void services.verify!().then((r) =>
    console.log(r.ok ? '🤝 webhook handshake ok' : `⚠️  webhook handshake failed: ${r.detail} (continuing)`),
  );
});

// /ws: group sessions on P2's store, the shared lock, heartbeat and live delivery.
live.attach(server, { heartbeatMs: env.WS_HEARTBEAT_MS });
