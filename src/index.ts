import { env } from './config/env.js';
import { composeServer } from './compose.js';
import { services } from './core/services.js';

// P2 store + control API (Swagger at /docs) + P1 Meta face. P3's WebSocket server
// (/ws: group sessions + admin feed) attaches to this http server at its integration.
const { app, metaFace } = composeServer();

app.listen(env.PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${env.PORT}  (API docs: /docs)`);
  console.log(`   webhooks → ${env.COMDOVE_WEBHOOK_URL}`);
  metaFace.start(); // resume webhooks left pending by a previous run
  void services.verify!().then((r) =>
    console.log(r.ok ? '🤝 webhook handshake ok' : `⚠️  webhook handshake failed: ${r.detail} (continuing)`),
  );
});
