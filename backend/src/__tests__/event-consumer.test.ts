import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for dependencies
// ---------------------------------------------------------------------------
const mockGetToken = vi.fn().mockResolvedValue('bot-token-123');
vi.mock('../services/token-provider.js', () => ({
  TokenProvider: vi.fn().mockImplementation(() => ({
    getToken: mockGetToken,
  })),
}));

const mockGetLedgerEnd = vi.fn();
const mockGetUpdates = vi.fn();
vi.mock('../services/ledger-client.js', () => ({
  getLedgerEnd: mockGetLedgerEnd,
  getUpdates: mockGetUpdates,
  TEMPLATE_IDS: {
    ASSET: '#asset-swap-contracts:Asset:Asset',
    SWAP_PROPOSAL: '#asset-swap-contracts:SwapProposal:SwapProposal',
    SWAP_SETTLEMENT: '#asset-swap-contracts:SwapProposal:SwapSettlement',
  },
}));

const mockGetLastOffset = vi.fn();
const mockProcessTransactionEvents = vi.fn();
const mockUpdateOffset = vi.fn();
vi.mock('../db/queries.js', () => ({
  getLastOffset: mockGetLastOffset,
  processTransactionEvents: mockProcessTransactionEvents,
  updateOffset: mockUpdateOffset,
}));

vi.mock('../config.js', () => ({
  config: {
    institutionName: 'test-bank',
    participantUrl: 'http://localhost:5013',
    botUsername: 'bot-test',
    botPassword: 'bot123',
    keycloakUrl: 'http://localhost:8080',
    keycloakRealm: 'canton',
    pollingIntervalMs: 100, // fast for tests
  },
}));

// Mock getUserParty (needed by event consumer to know which party to poll for)
const mockGetUserParty = vi.fn().mockResolvedValue('TestParty::1220abc');

// We need to mock the pool for getUserParty resolution
vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

const { EventConsumer } = await import('../services/event-consumer.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue('bot-token-123');
  mockGetLastOffset.mockResolvedValue(0);
  mockGetLedgerEnd.mockResolvedValue(10);
  mockGetUpdates.mockResolvedValue([]);
  mockProcessTransactionEvents.mockResolvedValue(undefined);
  mockUpdateOffset.mockResolvedValue(undefined);
});

// ---- AC: Event consumer starts with backend and begins polling ----
describe('EventConsumer', () => {
  it('can be instantiated with bot credentials and party resolver', () => {
    const consumer = new EventConsumer(mockGetUserParty);
    expect(consumer).toBeDefined();
  });

  // ---- AC: Consumer survives restart — reads last_offset and continues ----
  it('reads last_offset from DB on first poll cycle', async () => {
    mockGetLastOffset.mockResolvedValue(42);
    mockGetUpdates.mockResolvedValue([]);

    const consumer = new EventConsumer(mockGetUserParty);
    await consumer.pollOnce();

    expect(mockGetLastOffset).toHaveBeenCalled();
    expect(mockGetUpdates).toHaveBeenCalledWith(
      'bot-token-123',
      'TestParty::1220abc',
      42,
    );
  });

  // ---- AC: CreatedEvent → INSERT contract_events + INSERT active_contracts ----
  it('processes CreatedEvent from transaction updates', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates.mockResolvedValue([
      {
        type: 'transaction',
        offset: 10,
        events: [
          {
            type: 'created',
            contractId: 'cid-1',
            templateId: 'pkg:Asset:Asset',
            payload: { owner: 'Alice', symbol: 'TokenX' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    ]);

    const consumer = new EventConsumer(mockGetUserParty);
    await consumer.pollOnce();

    expect(mockProcessTransactionEvents).toHaveBeenCalledWith(
      [
        {
          type: 'created',
          contractId: 'cid-1',
          templateId: 'pkg:Asset:Asset',
          payload: { owner: 'Alice', symbol: 'TokenX' },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      10,
      expect.any(String),
    );
  });

  // ---- AC: ExercisedEvent consuming=true → INSERT contract_events + DELETE active_contracts ----
  it('processes ExercisedEvent with consuming=true', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates.mockResolvedValue([
      {
        type: 'transaction',
        offset: 20,
        events: [
          {
            type: 'archived',
            contractId: 'cid-2',
            templateId: 'pkg:SwapProposal:SwapProposal',
            choice: 'Accept',
            consuming: true,
          },
        ],
      },
    ]);

    const consumer = new EventConsumer(mockGetUserParty);
    await consumer.pollOnce();

    expect(mockProcessTransactionEvents).toHaveBeenCalledWith(
      [
        {
          type: 'archived',
          contractId: 'cid-2',
          templateId: 'pkg:SwapProposal:SwapProposal',
          choice: 'Accept',
          consuming: true,
        },
      ],
      20,
      expect.any(String),
    );
  });

  // ---- AC: Offset persisted after each batch ----
  it('updates internal offset after processing a transaction', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates
      .mockResolvedValueOnce([
        {
          type: 'transaction',
          offset: 15,
          events: [{ type: 'created', contractId: 'c1', templateId: 't', payload: {} }],
        },
      ])
      .mockResolvedValueOnce([]); // second poll

    const consumer = new EventConsumer(mockGetUserParty);
    await consumer.pollOnce();

    // Second poll should use the updated offset
    await consumer.pollOnce();
    expect(mockGetUpdates).toHaveBeenLastCalledWith(
      'bot-token-123',
      'TestParty::1220abc',
      15,
    );
  });

  // ---- AC: OffsetCheckpoint ignored for contract logic ----
  it('ignores OffsetCheckpoint updates (no processTransactionEvents call)', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates.mockResolvedValue([
      { type: 'checkpoint', offset: 50 },
    ]);

    const consumer = new EventConsumer(mockGetUserParty);
    await consumer.pollOnce();

    expect(mockProcessTransactionEvents).not.toHaveBeenCalled();
  });

  // ---- AC: Consumer renews bot token before expiry (delegated to TokenProvider) ----
  it('calls TokenProvider.getToken() on each poll cycle', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates.mockResolvedValue([]);

    const consumer = new EventConsumer(mockGetUserParty);
    await consumer.pollOnce();
    await consumer.pollOnce();

    // Token requested each cycle — TokenProvider handles caching/refresh internally
    expect(mockGetToken).toHaveBeenCalledTimes(2);
  });

  // ---- AC: Multiple events in a transaction processed together ----
  it('passes all events from a single transaction to processTransactionEvents', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates.mockResolvedValue([
      {
        type: 'transaction',
        offset: 30,
        events: [
          { type: 'archived', contractId: 'c1', templateId: 't1', choice: 'Settle', consuming: true },
          { type: 'created', contractId: 'c2', templateId: 't2', payload: { owner: 'Bob' }, createdAt: '2026-01-01T00:00:00Z' },
          { type: 'created', contractId: 'c3', templateId: 't3', payload: { owner: 'Alice' }, createdAt: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);

    const consumer = new EventConsumer(mockGetUserParty);
    await consumer.pollOnce();

    expect(mockProcessTransactionEvents).toHaveBeenCalledTimes(1);
    expect(mockProcessTransactionEvents).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ contractId: 'c1' }),
        expect.objectContaining({ contractId: 'c2' }),
        expect.objectContaining({ contractId: 'c3' }),
      ]),
      30,
      expect.any(String),
    );
  });

  // ---- Error resilience: does not crash on polling error ----
  it('does not throw when getUpdates fails — logs and continues', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates.mockRejectedValue(new Error('Canton unavailable'));

    const consumer = new EventConsumer(mockGetUserParty);
    // Should not throw
    await expect(consumer.pollOnce()).resolves.toBeUndefined();
  });

  it('does not throw when processTransactionEvents fails', async () => {
    mockGetLastOffset.mockResolvedValue(0);
    mockGetUpdates.mockResolvedValue([
      {
        type: 'transaction',
        offset: 10,
        events: [{ type: 'created', contractId: 'c1', templateId: 't', payload: {} }],
      },
    ]);
    mockProcessTransactionEvents.mockRejectedValue(new Error('DB error'));

    const consumer = new EventConsumer(mockGetUserParty);
    await expect(consumer.pollOnce()).resolves.toBeUndefined();
  });
});
