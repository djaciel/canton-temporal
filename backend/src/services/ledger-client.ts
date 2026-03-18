// =============================================================================
// Canton JSON Ledger API v2 Client
//
// Thin wrapper over Canton's HTTP JSON API. All methods receive an OIDC token
// and forward it as Bearer header — the backend acts as an authenticated proxy
// (it never generates its own tokens for user operations).
//
// Key design decisions:
//   - DEC-016: Party resolution via /v2/users/{id}, not /v2/parties
//   - DEC-003: Event polling via HTTP POST (no WebSocket in Canton 3.4.x)
//   - DEC-017: All endpoints require OIDC token when auth is enabled
//
// Template IDs use the #packageName:Module:Entity format, which is stable
// across DAR uploads with the same package name.
// =============================================================================

import { config } from '../config.js';

export const TEMPLATE_IDS = {
  ASSET: '#asset-swap-contracts:Asset:Asset',
  SWAP_PROPOSAL: '#asset-swap-contracts:SwapProposal:SwapProposal',
  SWAP_SETTLEMENT: '#asset-swap-contracts:SwapProposal:SwapSettlement',
} as const;

interface V2CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}

interface V2ExercisedEvent {
  contractId: string;
  templateId: string;
  choice: string;
  choiceArgument: Record<string, unknown>;
  consuming: boolean;
  exerciseResult: unknown;
}

interface V2TransactionResponse {
  transaction: {
    events: Array<
      | { CreatedEvent: V2CreatedEvent }
      | { ExercisedEvent: V2ExercisedEvent }
    >;
    offset: number;
  };
}

interface V2ActiveContractItem {
  contractEntry?: {
    JsActiveContract?: {
      createdEvent: V2CreatedEvent;
    };
  };
}

interface V2UpdateTransaction {
  update: {
    Transaction?: {
      value: {
        updateId: string;
        events: Array<
          | { CreatedEvent: V2CreatedEvent & { offset: number; acsDelta: boolean; createdAt: string } }
          | { ExercisedEvent: V2ExercisedEvent & { offset: number; acsDelta: boolean } }
        >;
        offset: number;
        effectiveAt: string;
        recordTime: string;
      };
    };
    OffsetCheckpoint?: {
      value: {
        offset: number;
      };
    };
  };
}

export interface CreateResult {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
}

export interface ExerciseResult {
  exerciseResult: unknown;
  events: Array<
    | { created: { contractId: string; templateId: string; payload: Record<string, unknown> } }
    | { archived: { contractId: string; templateId: string } }
  >;
}

export interface ActiveContract {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
}

export interface FlatUpdate {
  type: 'transaction' | 'checkpoint';
  offset: number;
  events?: Array<{
    type: 'created' | 'archived';
    contractId: string;
    templateId: string;
    choice?: string;
    consuming?: boolean;
    payload?: Record<string, unknown>;
    createdAt?: string;
  }>;
}

const baseUrl = config.participantUrl;

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

let commandCounter = 0;
function nextCommandId(): string {
  return `cmd-${Date.now()}-${++commandCounter}`;
}

/**
 * Resolves a user's primary party via /v2/users/{id}.
 * With auth enabled, /v2/parties requires admin rights (DEC-016),
 * but each user can read their own record.
 */
export async function getUserParty(token: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v2/users/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to get user ${userId}: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { user: { primaryParty: string } };
  if (!data.user.primaryParty) throw new Error(`User ${userId} has no primaryParty`);
  return data.user.primaryParty;
}

/**
 * Creates a contract on the ledger via submit-and-wait.
 * The userId must match the token's `sub` claim (Keycloak UUID).
 */
export async function create(
  token: string,
  userId: string,
  party: string,
  templateId: string,
  createArguments: Record<string, unknown>,
): Promise<CreateResult> {
  const res = await fetch(`${baseUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      commands: {
        commandId: nextCommandId(),
        userId,
        actAs: [party],
        readAs: [party],
        applicationId: 'canton-backend',
        commands: [{ CreateCommand: { templateId, createArguments } }],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LedgerError(res.status, body);
  }

  const data = (await res.json()) as V2TransactionResponse;
  const created = data.transaction.events.find(
    (e): e is { CreatedEvent: V2CreatedEvent } => 'CreatedEvent' in e,
  );
  if (!created) throw new Error('No CreatedEvent in response');

  return {
    contractId: created.CreatedEvent.contractId,
    templateId: created.CreatedEvent.templateId,
    payload: created.CreatedEvent.createArgument,
  };
}

/**
 * Exercises a choice on an existing contract.
 * Returns created/archived events and derives exerciseResult from created contract IDs.
 */
export async function exercise(
  token: string,
  userId: string,
  party: string,
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
): Promise<ExerciseResult> {
  const res = await fetch(`${baseUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      commands: {
        commandId: nextCommandId(),
        userId,
        actAs: [party],
        readAs: [party],
        applicationId: 'canton-backend',
        commands: [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LedgerError(res.status, body);
  }

  const data = (await res.json()) as V2TransactionResponse;
  const events: ExerciseResult['events'] = [];
  const createdIds: string[] = [];

  for (const e of data.transaction.events) {
    if ('CreatedEvent' in e) {
      events.push({
        created: {
          contractId: e.CreatedEvent.contractId,
          templateId: e.CreatedEvent.templateId,
          payload: e.CreatedEvent.createArgument,
        },
      });
      createdIds.push(e.CreatedEvent.contractId);
    } else if ('ExercisedEvent' in e && e.ExercisedEvent.consuming) {
      events.push({
        archived: {
          contractId: e.ExercisedEvent.contractId,
          templateId: e.ExercisedEvent.templateId,
        },
      });
    }
  }

  let exerciseResult: unknown;
  if (createdIds.length === 0) exerciseResult = null;
  else if (createdIds.length === 1) exerciseResult = createdIds[0];
  else exerciseResult = createdIds;

  return { exerciseResult, events };
}

/**
 * Queries active contracts of a given template visible to the party.
 * Fetches ledger-end offset first, then queries ACS at that snapshot point.
 */
export async function queryACS(
  token: string,
  party: string,
  templateId: string,
): Promise<ActiveContract[]> {
  const offset = await getLedgerEnd(token);

  const res = await fetch(`${baseUrl}/v2/state/active-contracts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [party]: {
            cumulative: [{
              identifierFilter: {
                TemplateFilter: {
                  value: { templateId, includeCreatedEventBlob: false },
                },
              },
            }],
          },
        },
      },
      verbose: true,
      activeAtOffset: offset,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LedgerError(res.status, body);
  }

  const items = (await res.json()) as V2ActiveContractItem[];
  return items
    .filter((item) => item.contractEntry?.JsActiveContract != null)
    .map((item) => {
      const ev = item.contractEntry!.JsActiveContract!.createdEvent;
      return {
        contractId: ev.contractId,
        templateId: ev.templateId,
        payload: ev.createArgument,
      };
    });
}

/** Returns the current ledger-end offset (monotonically increasing integer). */
export async function getLedgerEnd(token: string): Promise<number> {
  const res = await fetch(`${baseUrl}/v2/state/ledger-end`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new LedgerError(res.status, `Failed to get ledger-end: ${res.status}`);
  }
  const data = (await res.json()) as { offset: number };
  return data.offset;
}

/**
 * Polls for flat updates (transactions + checkpoints) since beginExclusive offset.
 * Filters for Asset, SwapProposal, and SwapSettlement templates.
 * Returns immediately with all available updates (no long-poll — DEC-003).
 */
export async function getUpdates(
  token: string,
  party: string,
  beginExclusive: number,
): Promise<FlatUpdate[]> {
  const res = await fetch(`${baseUrl}/v2/updates/flats`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      beginExclusive,
      filter: {
        filtersByParty: {
          [party]: {
            cumulative: [{
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: TEMPLATE_IDS.ASSET,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            }, {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: TEMPLATE_IDS.SWAP_PROPOSAL,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            }, {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: TEMPLATE_IDS.SWAP_SETTLEMENT,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            }],
          },
        },
      },
      verbose: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LedgerError(res.status, body);
  }

  const raw = (await res.json()) as V2UpdateTransaction[];
  const updates: FlatUpdate[] = [];

  for (const item of raw) {
    if (item.update.Transaction) {
      const tx = item.update.Transaction.value;
      const events: FlatUpdate['events'] = [];

      for (const e of tx.events) {
        if ('CreatedEvent' in e) {
          events.push({
            type: 'created',
            contractId: e.CreatedEvent.contractId,
            templateId: e.CreatedEvent.templateId,
            payload: e.CreatedEvent.createArgument,
            createdAt: e.CreatedEvent.createdAt,
          });
        } else if ('ExercisedEvent' in e) {
          events.push({
            type: 'archived',
            contractId: e.ExercisedEvent.contractId,
            templateId: e.ExercisedEvent.templateId,
            choice: e.ExercisedEvent.choice,
            consuming: e.ExercisedEvent.consuming,
          });
        }
      }

      updates.push({ type: 'transaction', offset: tx.offset, events });
    } else if (item.update.OffsetCheckpoint) {
      updates.push({
        type: 'checkpoint',
        offset: item.update.OffsetCheckpoint.value.offset,
      });
    }
  }

  return updates;
}

export class LedgerError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Ledger API error (HTTP ${status}): ${body.slice(0, 300)}`);
    this.name = 'LedgerError';
  }
}
