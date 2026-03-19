import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockCreate = vi.fn();
const mockExercise = vi.fn();
vi.mock('../services/ledger-client.js', () => ({
  create: mockCreate,
  exercise: mockExercise,
  queryACS: vi.fn(),
  getUserParty: vi.fn(),
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

const mockQueryActiveContractsByTemplate = vi.fn();
vi.mock('../db/queries.js', () => ({
  queryActiveContractsByTemplate: mockQueryActiveContractsByTemplate,
}));

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
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
const { swapsRouter } = await import('../routes/swaps.js');
app.use('/api/swaps', swapsRouter);

let server: http.Server;
const TEST_PORT = 4995;

beforeAll(() => new Promise<void>((resolve) => { server = app.listen(TEST_PORT, resolve); }));
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
beforeEach(() => vi.clearAllMocks());

const baseUrl = `http://localhost:${TEST_PORT}`;

// ---- AC: POST /api/swaps/propose con token canActAs crea SwapProposal → 201 ----
describe('POST /api/swaps/propose', () => {
  it('creates a SwapProposal via Canton and returns 201', async () => {
    mockCreate.mockResolvedValueOnce({
      contractId: 'proposal-123',
      templateId: '#asset-swap-contracts:SwapProposal:SwapProposal',
      payload: {},
    });

    const res = await fetch(`${baseUrl}/api/swaps/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offeredAssetCid: 'asset-cid-1',
        offeredSymbol: 'TokenX',
        offeredQuantity: '100',
        requestedSymbol: 'TokenY',
        requestedQuantity: '50',
        counterpartyParty: 'CounterParty::1220def',
        settlerParty: 'Settler::1220ghi',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contractId).toBe('proposal-123');

    expect(mockCreate).toHaveBeenCalledWith(
      'test-token-123',
      'test-user-uuid',
      'TestParty::1220abc',
      '#asset-swap-contracts:SwapProposal:SwapProposal',
      expect.objectContaining({
        proposer: 'TestParty::1220abc',
        counterparty: 'CounterParty::1220def',
        settler: 'Settler::1220ghi',
        offeredAssetCid: 'asset-cid-1',
      }),
    );
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await fetch(`${baseUrl}/api/swaps/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offeredAssetCid: 'x' }), // missing fields
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/swaps/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-no-auth': 'true' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

// ---- AC: POST /api/swaps/:id/accept → 200 con SwapSettlement contractId ----
describe('POST /api/swaps/:id/accept', () => {
  it('exercises Accept choice and returns 200 with settlementContractId', async () => {
    mockExercise.mockResolvedValueOnce({
      exerciseResult: 'settlement-456',
      events: [
        { created: { contractId: 'settlement-456', templateId: 'SwapSettlement', payload: {} } },
        { archived: { contractId: 'proposal-123', templateId: 'SwapProposal' } },
      ],
    });

    const res = await fetch(`${baseUrl}/api/swaps/proposal-123/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ counterpartyAssetCid: 'asset-cid-2' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settlementContractId).toBe('settlement-456');

    expect(mockExercise).toHaveBeenCalledWith(
      'test-token-123',
      'test-user-uuid',
      'TestParty::1220abc',
      '#asset-swap-contracts:SwapProposal:SwapProposal',
      'proposal-123',
      'Accept',
      { counterpartyAssetCid: 'asset-cid-2' },
    );
  });

  it('returns 400 when counterpartyAssetCid is missing', async () => {
    const res = await fetch(`${baseUrl}/api/swaps/proposal-123/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ---- AC: POST /api/swaps/:id/settle → 200 ----
describe('POST /api/swaps/:id/settle', () => {
  it('exercises Settle choice and returns 200', async () => {
    mockExercise.mockResolvedValueOnce({
      exerciseResult: ['new-asset-1', 'new-asset-2'],
      events: [],
    });

    const res = await fetch(`${baseUrl}/api/swaps/settlement-456/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exerciseResult).toEqual(['new-asset-1', 'new-asset-2']);

    expect(mockExercise).toHaveBeenCalledWith(
      'test-token-123',
      'test-user-uuid',
      'TestParty::1220abc',
      '#asset-swap-contracts:SwapProposal:SwapSettlement',
      'settlement-456',
      'Settle',
      {},
    );
  });
});

// ---- AC: POST /api/swaps/:id/reject → 200 ----
describe('POST /api/swaps/:id/reject', () => {
  it('exercises Reject choice and returns 200', async () => {
    mockExercise.mockResolvedValueOnce({ exerciseResult: null, events: [] });

    const res = await fetch(`${baseUrl}/api/swaps/proposal-123/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(mockExercise).toHaveBeenCalledWith(
      'test-token-123',
      'test-user-uuid',
      'TestParty::1220abc',
      '#asset-swap-contracts:SwapProposal:SwapProposal',
      'proposal-123',
      'Reject',
      {},
    );
  });
});

// ---- AC: POST /api/swaps/:id/cancel → 200 ----
describe('POST /api/swaps/:id/cancel', () => {
  it('exercises Cancel choice and returns 200', async () => {
    mockExercise.mockResolvedValueOnce({ exerciseResult: null, events: [] });

    const res = await fetch(`${baseUrl}/api/swaps/proposal-123/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(mockExercise).toHaveBeenCalledWith(
      'test-token-123',
      'test-user-uuid',
      'TestParty::1220abc',
      '#asset-swap-contracts:SwapProposal:SwapProposal',
      'proposal-123',
      'Cancel',
      {},
    );
  });
});

// ---- AC: GET /api/swaps/pending → SwapProposals from projection ----
describe('GET /api/swaps/pending', () => {
  it('returns active SwapProposals from projection', async () => {
    mockQueryActiveContractsByTemplate.mockResolvedValueOnce([
      { contract_id: 'p1', template_id: 'SwapProposal', payload: { proposer: 'A' } },
    ]);

    const res = await fetch(`${baseUrl}/api/swaps/pending`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(mockQueryActiveContractsByTemplate).toHaveBeenCalledWith(
      '#asset-swap-contracts:SwapProposal:SwapProposal',
    );
  });
});

// ---- AC: GET /api/swaps/settlements → SwapSettlements from projection ----
describe('GET /api/swaps/settlements', () => {
  it('returns active SwapSettlements from projection', async () => {
    mockQueryActiveContractsByTemplate.mockResolvedValueOnce([
      { contract_id: 's1', template_id: 'SwapSettlement', payload: { settler: 'Bot' } },
    ]);

    const res = await fetch(`${baseUrl}/api/swaps/settlements`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(mockQueryActiveContractsByTemplate).toHaveBeenCalledWith(
      '#asset-swap-contracts:SwapProposal:SwapSettlement',
    );
  });
});

// ---- Error handling: Canton errors propagated correctly ----
describe('Error handling', () => {
  it('returns 403 when Canton rejects exercise due to permissions', async () => {
    const { LedgerError } = await import('../services/ledger-client.js');
    mockExercise.mockRejectedValueOnce(new LedgerError(403, 'PERMISSION_DENIED'));

    const res = await fetch(`${baseUrl}/api/swaps/proposal-123/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ counterpartyAssetCid: 'cid' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 503 when Canton is unavailable', async () => {
    mockCreate.mockRejectedValueOnce(new Error('fetch failed'));

    const res = await fetch(`${baseUrl}/api/swaps/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offeredAssetCid: 'a',
        offeredSymbol: 'X',
        offeredQuantity: '1',
        requestedSymbol: 'Y',
        requestedQuantity: '1',
        counterpartyParty: 'P',
        settlerParty: 'S',
      }),
    });
    expect(res.status).toBe(503);
  });
});
