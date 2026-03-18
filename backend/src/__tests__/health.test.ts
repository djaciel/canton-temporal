import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

// Set env before importing app (config reads at import time)
process.env.INSTITUTION_NAME = 'test-bank';

const { app } = await import('../app.js');

let server: http.Server;
const TEST_PORT = 4999;

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

describe('GET /health', () => {
  it('returns 200 with status ok and institution name', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', institution: 'test-bank' });
  });
});
