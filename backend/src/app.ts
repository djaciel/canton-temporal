import express from 'express';
import { config } from './config.js';
import { authMiddleware } from './middleware/auth.js';

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', institution: config.institutionName });
});

// All /api/* routes require OIDC auth
app.use('/api', authMiddleware);

export { app };
