import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pg.Pool — queries.ts uses pool.query() and pool.connect() for txns
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockClientQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({
  query: mockClientQuery,
  release: mockRelease,
});

vi.mock('../db/pool.js', () => ({
  pool: { query: mockQuery, connect: mockConnect },
}));

const {
  getLastOffset,
  updateOffset,
  insertContractEvent,
  upsertActiveContract,
  deleteActiveContract,
  queryActiveContractsByTemplate,
  queryContractEvents,
  processTransactionEvents,
} = await import('../db/queries.js');

beforeEach(() => {
  vi.clearAllMocks();
  // Re-set default resolved values after clearAllMocks
  mockConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockRelease,
  });
});

// ---- AC: Offset persisted in consumer_state after each batch ----
describe('getLastOffset', () => {
  it('returns the stored offset from consumer_state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ last_offset: '42' }] });
    const offset = await getLastOffset();
    expect(offset).toBe(42);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('consumer_state'),
      ['main'],
    );
  });

  it('returns 0 when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const offset = await getLastOffset();
    expect(offset).toBe(0);
  });
});

describe('updateOffset', () => {
  it('upserts the offset in consumer_state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateOffset(100);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('consumer_state'),
      [100, 'main'],
    );
  });
});

// ---- AC: CreatedEvent → INSERT contract_events + INSERT active_contracts ----
describe('insertContractEvent', () => {
  it('inserts a created event row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await insertContractEvent({
      eventType: 'created',
      contractId: 'cid-1',
      templateId: 'pkg:Mod:T',
      payload: { foo: 1 },
      offsetValue: 10,
      effectiveAt: '2026-01-01T00:00:00Z',
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('contract_events'),
      ['created', 'cid-1', 'pkg:Mod:T', null, false, JSON.stringify({ foo: 1 }), 10, '2026-01-01T00:00:00Z'],
    );
  });

  it('inserts an exercised event row with choice and consuming', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await insertContractEvent({
      eventType: 'exercised',
      contractId: 'cid-2',
      templateId: 'pkg:Mod:T',
      choice: 'Accept',
      consuming: true,
      offsetValue: 20,
      effectiveAt: '2026-01-01T00:00:00Z',
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('contract_events'),
      ['exercised', 'cid-2', 'pkg:Mod:T', 'Accept', true, null, 20, '2026-01-01T00:00:00Z'],
    );
  });
});

describe('upsertActiveContract', () => {
  it('inserts or updates an active contract', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await upsertActiveContract({
      contractId: 'cid-1',
      templateId: 'pkg:Mod:T',
      payload: { owner: 'Alice' },
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('active_contracts'),
      ['cid-1', 'pkg:Mod:T', JSON.stringify({ owner: 'Alice' }), '2026-01-01T00:00:00Z'],
    );
  });
});

// ---- AC: ExercisedEvent consuming=true → DELETE active_contracts ----
describe('deleteActiveContract', () => {
  it('deletes the contract by contractId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await deleteActiveContract('cid-1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      ['cid-1'],
    );
  });
});

// ---- AC: Multiple events in a transaction processed in a single SQL transaction ----
describe('processTransactionEvents', () => {
  it('processes created events within a SQL transaction', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });

    await processTransactionEvents(
      [
        {
          type: 'created' as const,
          contractId: 'cid-1',
          templateId: 'pkg:Mod:T',
          payload: { owner: 'Alice' },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      10,
      '2026-01-01T00:00:00Z',
    );

    // BEGIN, insert event, upsert active, update offset, COMMIT
    expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('contract_events'),
      expect.any(Array),
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('active_contracts'),
      expect.any(Array),
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('consumer_state'),
      expect.any(Array),
    );
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('processes exercised consuming events (delete from active_contracts)', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });

    await processTransactionEvents(
      [
        {
          type: 'archived' as const,
          contractId: 'cid-2',
          templateId: 'pkg:Mod:T',
          choice: 'Accept',
          consuming: true,
        },
      ],
      20,
      '2026-01-01T00:00:00Z',
    );

    expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
    // Should have DELETE for active_contracts
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      ['cid-2'],
    );
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back on error', async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('DB error')); // first insert fails

    await expect(
      processTransactionEvents(
        [{ type: 'created' as const, contractId: 'c', templateId: 't', payload: {} }],
        1,
        '2026-01-01T00:00:00Z',
      ),
    ).rejects.toThrow('DB error');

    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});

// ---- Query functions for REST endpoints (T-07 will use these) ----
describe('queryActiveContractsByTemplate', () => {
  it('queries active_contracts filtered by template_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { contract_id: 'c1', template_id: 't1', payload: { x: 1 }, created_at: '2026-01-01', updated_at: '2026-01-02' },
      ],
    });
    const result = await queryActiveContractsByTemplate('t1');
    expect(result).toHaveLength(1);
    expect(result[0].contract_id).toBe('c1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('template_id'),
      ['t1'],
    );
  });
});

describe('queryContractEvents', () => {
  it('queries contract_events with pagination', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await queryContractEvents({ limit: 10, offset: 0 });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('contract_events'),
      expect.arrayContaining([10, 0]),
    );
  });

  it('filters by templateId when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryContractEvents({ limit: 10, offset: 0, templateId: 'pkg:Mod:T' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('template_id'),
      expect.arrayContaining(['pkg:Mod:T']),
    );
  });
});
