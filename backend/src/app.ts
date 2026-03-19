import express from 'express';
import { config } from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { assetsRouter } from './routes/assets.js';
import { swapsRouter } from './routes/swaps.js';
import { eventsRouter } from './routes/events.js';

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', institution: config.institutionName });
});

// All /api/* routes require OIDC auth
app.use('/api', authMiddleware);

// Route registrations
app.use('/api/assets', assetsRouter);
app.use('/api/swaps', swapsRouter);
app.use('/api', eventsRouter);

export { app };
