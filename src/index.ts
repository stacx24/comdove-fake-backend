import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4020);

// Health check — confirms the server is up.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'comdove-fake-backend' });
});

app.listen(PORT, () => {
  console.log(`🟢 comdove-fake-backend listening on http://localhost:${PORT}`);
});
