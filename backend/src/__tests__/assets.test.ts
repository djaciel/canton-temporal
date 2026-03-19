import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Mocks — must be set up before dynamic imports
// ---------------------------------------------------------------------------

// Mock ledger-client
const mockCreate = vi.fn();
const mockQueryACS = vi.fn();
const mockGetUserParty = vi.fn();
vi.mock('../services/ledger-client.js', () => ({
  create: mockCreate,
  queryACS: mockQueryACS,
  getUserParty: mockGetUserParty,
  TEMPLATE_IDS: {
    ASSET: '#asset-swap-contracts:Asset:Asset',
    SWAP_PROPOSAL: '#asset-swap-contracts:SwapProposal:SwapProposal',
    SWAP_SETTLEMENT: '#asset-swap-contracts:SwapProposal:SwapSettlement',
  },
  LedgerError: class LedgerError extends Error {
    constructor(public readonly status: number, public readonly body: string) {
      super(`Ledger API error (HTTP ${status}): ${body.slice(0, 300)}`);
      this.name = 'LedgerError';
    }
  },
}));

// Mock db queries (for GET /api/assets from projection)
const mockQueryActiveContractsByTemplate = vi.fn();
vi.mock('../db/queries.js', () => ({
  queryActiveContractsByTemplate: mockQueryActiveContractsByTemplate,
}));

// Mock db pool
vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

// Mock auth middleware — inject fake auth for testing route logic
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    // If test sets x-test-no-auth header, skip auth (simulate no token)
    if (req.headers['x-test-no-auth']) {
      return _res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    req.auth = {
      userId: 'test-user-uuid',
      party: 'TestParty::1220abc',
      token: 'test-token-123',
    };
    next();
  }),
}));

process.env.INSTITUTION_NAME = 'test-bank';

const { app } = await import('../app.js');

// Import and register the assets router
const { assetsRouter } = await import('../routes/assets.js');
app.use('/api/assets', assetsRouter);

let server: http.Server;
const TEST_PORT = 4996;

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

beforeEach(() => {
  vi.clearAllMocks();
});

const baseUrl = `http://localhost:${TEST_PORT}`;

// ---- AC: POST /api/assets con token canActAs crea asset y retorna 201 ----
describe('POST /api/assets', () => {
  it('creates an asset via Canton and returns 201 with contractId', async () => {
    mockCreate.mockResolvedValueOnce({
      contractId: 'contract-123',
      templateId: '#asset-swap-contracts:Asset:Asset',
      payload: { issuer: 'TestParty::1220abc', owner: 'TestParty::1220abc', symbol: 'TokenX', quantity: '100', observers: [] },
    });

    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'TokenX', quantity: '100', observers: [] }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contractId).toBe('contract-123');

    // Verify ledger client was called with correct args
    expect(mockCreate).toHaveBeenCalledWith(
      'test-token-123',
      'test-user-uuid',
      'TestParty::1220abc',
      '#asset-swap-contracts:Asset:Asset',
      {
        issuer: 'TestParty::1220abc',
        owner: 'TestParty::1220abc',
        symbol: 'TokenX',
        quantity: '100',
        observers: [],
      },
    );
  });

  // ---- AC: POST /api/assets sin token retorna 401 ----
  it('returns 401 when no token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-no-auth': 'true',
      },
      body: JSON.stringify({ symbol: 'TokenX', quantity: '100', observers: [] }),
    });

    expect(res.status).toBe(401);
  });

  // ---- AC: POST /api/assets con token canReadAs retorna 403 ----
  it('returns 403 when Canton rejects due to permissions (canReadAs)', async () => {
    const { LedgerError } = await import('../services/ledger-client.js');
    mockCreate.mockRejectedValueOnce(new LedgerError(403, 'PERMISSION_DENIED'));

    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'TokenX', quantity: '100', observers: [] }),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'TokenX' }), // missing quantity
    });

    expect(res.status).toBe(400);
  });

  it('returns 503 when Canton is unavailable', async () => {
    mockCreate.mockRejectedValueOnce(new Error('fetch failed'));

    const res = await fetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'TokenX', quantity: '100', observers: [] }),
    });

    expect(res.status).toBe(503);
  });
});

// ---- AC: GET /api/assets retorna lista de assets activos desde projection ----
describe('GET /api/assets', () => {
  it('returns active assets from projection DB filtered by Asset template', async () => {
    mockQueryActiveContractsByTemplate.mockResolvedValueOnce([
      {
        contract_id: 'c1',
        template_id: '#asset-swap-contracts:Asset:Asset',
        payload: { issuer: 'Alice', owner: 'Alice', symbol: 'TokenX', quantity: '100', observers: [] },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
    ]);

    const res = await fetch(`${baseUrl}/api/assets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].contract_id).toBe('c1');

    expect(mockQueryActiveContractsByTemplate).toHaveBeenCalledWith(
      '#asset-swap-contracts:Asset:Asset',
    );
  });

  // ---- AC: GET /api/assets sin token retorna 401 ----
  it('returns 401 when no token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/assets`, {
      headers: { 'x-test-no-auth': 'true' },
    });

    expect(res.status).toBe(401);
  });
});
