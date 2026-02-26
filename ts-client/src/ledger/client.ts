/**
 * Canton JSON Ledger API V2 client.
 *
 * Daml SDK 3.x / Canton 3.4+ replaced the legacy JSON API v1 (/v1/*) with
 * the new HTTP JSON Ledger API v2 (/v2/*). This client targets the v2 API.
 *
 * Reference:
 *   https://docs.digitalasset.com/build/3.4/explanations/json-api/index.html
 *   https://docs.digitalasset.com/build/3.4/tutorials/json-api/canton_and_the_json_ledger_api.html
 */

import type { Contract, ExerciseResult, LedgerEvent, PartyInfo } from '../types/contracts';

// ─── Error type ───────────────────────────────────────────────────────────────

/** Thrown when the Canton JSON Ledger API returns a non-2xx status. */
export class DamlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errors: string[],
  ) {
    super(`Daml API error (HTTP ${status}): ${errors.join(' | ')}`);
    this.name = 'DamlApiError';
  }
}

// ─── V2 API internal types ────────────────────────────────────────────────────

interface V2CreatedEventData {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}

interface V2ArchivedEventData {
  contractId: string;
  templateId: string;
}

type V2FlatEvent =
  | { CreatedEvent: V2CreatedEventData }
  | { ArchivedEvent: V2ArchivedEventData };

interface V2TransactionResponse {
  transaction: {
    events: V2FlatEvent[];
    offset: number;
  };
}

interface V2ActiveContractItem {
  contractEntry?: {
    JsActiveContract?: {
      createdEvent: V2CreatedEventData;
    };
  };
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around the Canton JSON Ledger API v2.
 *
 * Each instance is bound to a single party — instantiate one per party.
 * The `partyId` (full Canton ID, e.g. "Alice::1220...") is required to
 * populate the `actAs` / `readAs` fields in every command submission.
 *
 * The `token` is sent as `Authorization: Bearer <token>` on every request.
 * In the Canton sandbox (dev mode), any well-formed JWT is accepted.
 *
 * Uses native `fetch` available in Node ≥ 18.
 */
export class LedgerClient {
  private commandCounter = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    /** Full Canton party ID, e.g. "Alice::1220abc…" */
    private readonly partyId: string,
    /** Application / user ID sent in command submissions. Any string is fine in dev mode. */
    private readonly userId: string = 'canton-temporal-ai',
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private get authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  private nextCommandId(): string {
    return `cmd-${Date.now()}-${++this.commandCounter}`;
  }

  /** POST helper that throws DamlApiError on non-2xx responses. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let cause = text;
      try {
        const json = JSON.parse(text) as { cause?: string; message?: string };
        cause = json.cause ?? json.message ?? text;
      } catch {
        /* raw text */
      }
      throw new DamlApiError(response.status, [cause.slice(0, 500)]);
    }

    return response.json() as Promise<T>;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a new contract on the ledger.
   *
   * POST /v2/commands/submit-and-wait-for-transaction
   *
   * The Canton JSON Ledger API v2 uses the proto-gRPC transcoding format:
   * all command fields are nested inside a `commands` object (matching the
   * `SubmitAndWaitRequest.commands: Commands` proto field), NOT at the top level.
   *
   * Returns the created contract with its new `contractId`.
   */
  async create<T>(templateId: string, createArguments: T): Promise<Contract<T>> {
    const result = await this.post<V2TransactionResponse>(
      '/v2/commands/submit-and-wait-for-transaction',
      {
        commands: {
          commandId: this.nextCommandId(),
          userId: this.userId,
          actAs: [this.partyId],
          readAs: [this.partyId],
          applicationId: this.userId,
          commands: [{ CreateCommand: { templateId, createArguments } }],
        },
      },
    );

    const createdEvent = result.transaction.events
      .filter((e): e is { CreatedEvent: V2CreatedEventData } => 'CreatedEvent' in e)
      .map((e) => e.CreatedEvent)[0];

    if (!createdEvent) {
      throw new DamlApiError(500, ['No CreatedEvent in transaction response']);
    }

    return {
      contractId: createdEvent.contractId,
      payload: createdEvent.createArgument as T,
      templateId: createdEvent.templateId,
    };
  }

  /**
   * Exercise a choice on an existing contract.
   *
   * POST /v2/commands/submit-and-wait-for-transaction
   *
   * We use the flat transaction endpoint (same as `create`) because the
   * transaction-tree endpoint has a different body schema in dpm sandbox 3.4.x.
   *
   * The Daml `exerciseResult` is derived from the `CreatedEvent`s in the
   * transaction — all choices in this project return contract IDs:
   *   - 0 new contracts → null
   *   - 1 new contract  → the contractId (string)
   *   - N new contracts → [contractId, …]  (preserves Daml event order)
   *
   * This covers every return type used here:
   *   ContractId T         → 1 created  → string
   *   (ContractId T, ContractId T) → 2 created  → [id, id]
   *   [ContractId T]       → N created  → [id, …]
   *   ()                   → 0 created  → null
   */
  async exercise<A, R>(
    templateId: string,
    contractId: string,
    choice: string,
    choiceArgument: A,
  ): Promise<ExerciseResult<R>> {
    const result = await this.post<V2TransactionResponse>(
      '/v2/commands/submit-and-wait-for-transaction',
      {
        commands: {
          commandId: this.nextCommandId(),
          userId: this.userId,
          actAs: [this.partyId],
          readAs: [this.partyId],
          applicationId: this.userId,
          commands: [
            { ExerciseCommand: { templateId, contractId, choice, choiceArgument } },
          ],
        },
      },
    );

    // Collect created and archived events (preserving Daml execution order)
    const events: LedgerEvent[] = [];
    const createdIds: string[] = [];

    for (const e of result.transaction.events) {
      if ('CreatedEvent' in e) {
        events.push({
          created: {
            contractId: e.CreatedEvent.contractId,
            payload: e.CreatedEvent.createArgument,
            templateId: e.CreatedEvent.templateId,
          },
        });
        createdIds.push(e.CreatedEvent.contractId);
      } else if ('ArchivedEvent' in e) {
        events.push({
          archived: {
            contractId: e.ArchivedEvent.contractId,
            templateId: e.ArchivedEvent.templateId,
          },
        });
      }
    }

    // Derive exerciseResult from the created contract IDs
    let exerciseResult: unknown;
    if (createdIds.length === 0) exerciseResult = null;
    else if (createdIds.length === 1) exerciseResult = createdIds[0];
    else exerciseResult = createdIds;

    return { exerciseResult: exerciseResult as R, events };
  }

  /**
   * Query active contracts of a given template visible to this party,
   * with an optional client-side field filter.
   *
   * GET  /v2/state/ledger-end           (to get the current offset)
   * POST /v2/state/active-contracts     (to get contracts at that offset)
   *
   * The field `filter` is matched client-side against the contract's payload.
   */
  async query<T>(
    templateId: string,
    filter: Partial<Record<string, unknown>> = {},
  ): Promise<Contract<T>[]> {
    // 1. Fetch the current ledger-end offset (required by active-contracts)
    const ledgerEndRes = await fetch(`${this.baseUrl}/v2/state/ledger-end`, {
      headers: this.authHeaders,
    });
    if (!ledgerEndRes.ok) {
      throw new DamlApiError(ledgerEndRes.status, ['Failed to get ledger-end offset']);
    }
    const { offset } = (await ledgerEndRes.json()) as { offset: number };

    // 2. Fetch active contracts filtered by template for this party
    const contracts = await this.post<V2ActiveContractItem[]>('/v2/state/active-contracts', {
      filter: {
        filtersByParty: {
          [this.partyId]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId,
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              },
            ],
          },
        },
      },
      verbose: true,
      activeAtOffset: offset,
    });

    // 3. Map to Contract<T> and apply client-side field filter
    return contracts
      .filter((item) => item.contractEntry?.JsActiveContract != null)
      .map((item) => {
        const ev = item.contractEntry!.JsActiveContract!.createdEvent;
        return {
          contractId: ev.contractId,
          payload: ev.createArgument as T,
          templateId: ev.templateId,
        };
      })
      .filter((contract) =>
        Object.entries(filter).every(
          ([k, v]) => (contract.payload as Record<string, unknown>)[k] === v,
        ),
      );
  }

  /**
   * Retrieve all parties known to this participant node.
   *
   * GET /v2/parties
   */
  async getParties(): Promise<PartyInfo[]> {
    const response = await fetch(`${this.baseUrl}/v2/parties`, {
      headers: this.authHeaders,
    });
    if (!response.ok) {
      throw new DamlApiError(response.status, ['Failed to get parties']);
    }
    const json = (await response.json()) as {
      partyDetails: Array<{ party: string; isLocal: boolean }>;
    };
    return json.partyDetails.map((p) => ({
      identifier: p.party,
      displayName: p.party.split('::')[0],
      isLocal: p.isLocal,
    }));
  }

  // ─── Static helpers ────────────────────────────────────────────────────────

  /** Extract contractIds of all created contracts from an exercise result. */
  static createdContractIds(result: ExerciseResult<unknown>): string[] {
    return result.events
      .filter((e): e is { created: Contract<unknown> } => 'created' in e)
      .map((e) => e.created.contractId);
  }

  /** Extract all archived contractIds from an exercise result. */
  static archivedContractIds(result: ExerciseResult<unknown>): string[] {
    return result.events
      .filter(
        (e): e is { archived: { contractId: string; templateId: string } } =>
          'archived' in e,
      )
      .map((e) => e.archived.contractId);
  }
}
