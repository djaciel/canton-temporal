import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

process.env.INSTITUTION_NAME = 'test-bank';
process.env.KEYCLOAK_URL = 'http://localhost:8080';
process.env.KEYCLOAK_REALM = 'canton';

const { app } = await import('../app.js');

// Add a dummy /api/test route to test auth middleware
app.get('/api/test', (req, res) => {
  res.json({ userId: req.auth?.userId, party: req.auth?.party });
});

let server: http.Server;
const TEST_PORT = 4998;

beforeAll(() => {
  return new Promise<void>((resolve) => {
    server = app.listen(TEST_PORT, resolve);
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('Auth middleware', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/test`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Missing');
  });

  it('returns 401 when Authorization header has no Bearer prefix', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/test`, {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when token has invalid signature', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/test`, {
      headers: { Authorization: 'Bearer invalid-garbage-token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid');
  });

  it('health endpoint does not require auth', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
  });
});
