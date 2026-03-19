// =============================================================================
// Projection DB Queries
//
// SQL functions for the event projection pipeline:
//   - contract_events: immutable log of all ledger events
//   - active_contracts: materialized view (insert on create, delete on archive)
//   - consumer_state: offset tracking for reconnection
//
// processTransactionEvents wraps all operations for a single Canton transaction
// in a SQL transaction to guarantee atomicity (AC: multiple events in one tx).
// =============================================================================

import { pool } from './pool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractEventInput {
  eventType: 'created' | 'exercised';
  contractId: string;
  templateId: string;
  choice?: string | null;
  consuming?: boolean;
  payload?: Record<string, unknown> | null;
  offsetValue: number;
  effectiveAt?: string | null;
}

export interface ActiveContractInput {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
  createdAt?: string | null;
}

export interface TransactionEvent {
  type: 'created' | 'archived';
  contractId: string;
  templateId: string;
  choice?: string;
  consuming?: boolean;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Consumer state
// ---------------------------------------------------------------------------

export async function getLastOffset(): Promise<number> {
  const result = await pool.query(
    'SELECT last_offset FROM consumer_state WHERE id = $1',
    ['main'],
  );
  if (result.rows.length === 0) return 0;
  return Number(result.rows[0].last_offset);
}

// ---------------------------------------------------------------------------
// Single-row operations (used standalone or within a transaction client)
// ---------------------------------------------------------------------------

export async function insertContractEvent(input: ContractEventInput): Promise<void> {
  await pool.query(
    `INSERT INTO contract_events
       (event_type, contract_id, template_id, choice, consuming, payload, offset_value, effective_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.eventType,
      input.contractId,
      input.templateId,
      input.choice ?? null,
      input.consuming ?? false,
      input.payload ? JSON.stringify(input.payload) : null,
      input.offsetValue,
      input.effectiveAt ?? null,
    ],
  );
}

export async function upsertActiveContract(input: ActiveContractInput): Promise<void> {
  await pool.query(
    `INSERT INTO active_contracts (contract_id, template_id, payload, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (contract_id) DO UPDATE SET
       template_id = EXCLUDED.template_id,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [input.contractId, input.templateId, JSON.stringify(input.payload), input.createdAt ?? null],
  );
}

export async function deleteActiveContract(contractId: string): Promise<void> {
  await pool.query(
    'DELETE FROM active_contracts WHERE contract_id = $1',
    [contractId],
  );
}

// ---------------------------------------------------------------------------
// Transactional batch processing (AC: single SQL tx per Canton transaction)
// ---------------------------------------------------------------------------

export async function processTransactionEvents(
  events: TransactionEvent[],
  offset: number,
  effectiveAt: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const event of events) {
      if (event.type === 'created') {
        await client.query(
          `INSERT INTO contract_events
             (event_type, contract_id, template_id, choice, consuming, payload, offset_value, effective_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            'created',
            event.contractId,
            event.templateId,
            null,
            false,
            event.payload ? JSON.stringify(event.payload) : null,
            offset,
            effectiveAt,
          ],
        );

        await client.query(
          `INSERT INTO active_contracts (contract_id, template_id, payload, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (contract_id) DO UPDATE SET
             template_id = EXCLUDED.template_id,
             payload = EXCLUDED.payload,
             updated_at = NOW()`,
          [event.contractId, event.templateId, JSON.stringify(event.payload ?? {}), event.createdAt ?? null],
        );
      } else if (event.type === 'archived') {
        await client.query(
          `INSERT INTO contract_events
             (event_type, contract_id, template_id, choice, consuming, payload, offset_value, effective_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            'exercised',
            event.contractId,
            event.templateId,
            event.choice ?? null,
            event.consuming ?? true,
            null,
            offset,
            effectiveAt,
          ],
        );

        if (event.consuming) {
          await client.query(
            'DELETE FROM active_contracts WHERE contract_id = $1',
            [event.contractId],
          );
        }
      }
    }

    // Persist offset within the same transaction
    await client.query(
      `INSERT INTO consumer_state (id, last_offset, updated_at)
       VALUES ('main', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_offset = $1, updated_at = NOW()`,
      [offset],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Query functions (for REST endpoints — used by T-05, T-06, T-07)
// ---------------------------------------------------------------------------

/**
 * Extracts the Module:Entity suffix from a template ID.
 * Input:  '#asset-swap-contracts:Asset:Asset' or 'hash:Asset:Asset'
 * Output: ':Asset:Asset'
 */
function templateSuffix(templateId: string): string {
  const parts = templateId.split(':');
  if (parts.length >= 3) {
    return ':' + parts.slice(-2).join(':');
  }
  return templateId;
}

/**
 * Queries active contracts by template suffix (Module:Entity).
 * Canton resolves #package-name:Module:Entity to hash:Module:Entity in events,
 * so we match on the Module:Entity suffix to handle both forms.
 */
export async function queryActiveContractsByTemplate(
  templateId: string,
): Promise<Array<{ contract_id: string; template_id: string; payload: Record<string, unknown>; created_at: string; updated_at: string }>> {
  const suffix = templateSuffix(templateId);
  const result = await pool.query(
    'SELECT contract_id, template_id, payload, created_at, updated_at FROM active_contracts WHERE template_id LIKE $1 ORDER BY created_at DESC',
    [`%${suffix}`],
  );
  return result.rows;
}

export async function queryAllActiveContracts(): Promise<
  Array<{ contract_id: string; template_id: string; payload: Record<string, unknown>; created_at: string; updated_at: string }>
> {
  const result = await pool.query(
    'SELECT contract_id, template_id, payload, created_at, updated_at FROM active_contracts ORDER BY created_at DESC',
  );
  return result.rows;
}

export async function queryContractEvents(
  params: { limit: number; offset: number; templateId?: string },
): Promise<Array<Record<string, unknown>>> {
  if (params.templateId) {
    const suffix = templateSuffix(params.templateId);
    const result = await pool.query(
      `SELECT * FROM contract_events WHERE template_id LIKE $1 ORDER BY offset_value DESC LIMIT $2 OFFSET $3`,
      [`%${suffix}`, params.limit, params.offset],
    );
    return result.rows;
  }

  const result = await pool.query(
    'SELECT * FROM contract_events ORDER BY offset_value DESC LIMIT $1 OFFSET $2',
    [params.limit, params.offset],
  );
  return result.rows;
}
