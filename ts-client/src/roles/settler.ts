import { LedgerClient } from '../ledger/client';
import {
  Contract,
  EmptyArg,
  SwapSettlement,
  TransferRequest,
  TEMPLATE_IDS,
} from '../types/contracts';

/**
 * Encapsulates ledger actions available to the Operator / Settler.
 *
 * The Operator has two distinct responsibilities:
 *
 *   1. **Settlement** — Execute the atomic 2-leg transfer for accepted swaps
 *      (`SwapSettlement.Settle`). This is the business-logic layer.
 *
 *   2. **Batching** — Collect pending `TransferRequest` contracts from asset
 *      owners, group them into a `TransferBatch`, and execute all of them in
 *      a single Daml transaction. This is the performance layer — N transfers
 *      in 1 ledger roundtrip instead of N separate roundtrips.
 */
export class Settler {
  constructor(
    private readonly client: LedgerClient,
    private readonly party: string,
  ) {}

  // ─── Settlement ────────────────────────────────────────────────────────────

  /**
   * Execute an accepted swap atomically: both asset legs transfer in one tx.
   * Either both transfers succeed, or neither does.
   *
   * Returns `exerciseResult = [newContractIdForCounterparty, newContractIdForProposer]`.
   *
   * Daml: `choice Settle : (ContractId Asset, ContractId Asset)`
   */
  async settleSwap(settlementContractId: string) {
    console.log(
      `[Settler:${this.party}] Settling swap ${settlementContractId}...`,
    );
    return this.client.exercise<EmptyArg, [string, string]>(
      TEMPLATE_IDS.SWAP_SETTLEMENT,
      settlementContractId,
      'Settle',
      {},
    );
  }

  /**
   * Abort a settlement — e.g. on compliance failure, asset dispute, or timeout.
   * Both asset contracts remain with their original owners unchanged.
   *
   * Daml: `choice Abort : ()`
   */
  async abortSwap(settlementContractId: string) {
    console.log(
      `[Settler:${this.party}] Aborting settlement ${settlementContractId}...`,
    );
    return this.client.exercise<EmptyArg, null>(
      TEMPLATE_IDS.SWAP_SETTLEMENT,
      settlementContractId,
      'Abort',
      {},
    );
  }

  // ─── Batching ──────────────────────────────────────────────────────────────

  /**
   * Create a `TransferBatch` grouping N `TransferRequest` contract IDs.
   * The batch is signed by the operator (this.party).
   *
   * Note: this only *creates* the batch contract. Call `executeTransferBatch`
   * to actually run all the transfers.
   *
   * Daml: `createCmd TransferBatch`
   */
  async createTransferBatch(transferRequestCids: string[]) {
    console.log(
      `[Settler:${this.party}] Creating TransferBatch with ${transferRequestCids.length} requests...`,
    );
    return this.client.create(TEMPLATE_IDS.TRANSFER_BATCH, {
      operator: this.party,
      requests: transferRequestCids,
    });
  }

  /**
   * Execute all transfers in a `TransferBatch` in a single Daml transaction.
   *
   * Key guarantee: if *any* transfer fails (e.g. an asset was already consumed),
   * the entire batch rolls back — no partial execution.
   *
   * Returns `exerciseResult = [ContractId Asset]` — one new Asset per transfer.
   *
   * Daml: `choice ExecuteTransfers : [ContractId Asset]`
   */
  async executeTransferBatch(batchContractId: string) {
    console.log(
      `[Settler:${this.party}] Executing TransferBatch ${batchContractId}...`,
    );
    return this.client.exercise<EmptyArg, string[]>(
      TEMPLATE_IDS.TRANSFER_BATCH,
      batchContractId,
      'ExecuteTransfers',
      {},
    );
  }

  /**
   * Cancel a batch without executing anything.
   * The individual `TransferRequest` contracts remain active and can be re-batched.
   *
   * Daml: `choice CancelBatch : ()`
   */
  async cancelTransferBatch(batchContractId: string) {
    console.log(`[Settler:${this.party}] Cancelling TransferBatch...`);
    return this.client.exercise<EmptyArg, null>(
      TEMPLATE_IDS.TRANSFER_BATCH,
      batchContractId,
      'CancelBatch',
      {},
    );
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /** Return all SwapSettlement contracts where this party is the settler. */
  async queryPendingSettlements(): Promise<Contract<SwapSettlement>[]> {
    return this.client.query<SwapSettlement>(TEMPLATE_IDS.SWAP_SETTLEMENT, {
      settler: this.party,
    });
  }

  /** Return all TransferRequest contracts where this party is the operator. */
  async queryPendingTransferRequests(): Promise<Contract<TransferRequest>[]> {
    return this.client.query<TransferRequest>(TEMPLATE_IDS.TRANSFER_REQUEST, {
      operator: this.party,
    });
  }
}
