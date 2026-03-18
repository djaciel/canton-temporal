/**
 * Shared types used by Temporal workflows and activities for the asset swap system.
 *
 * These types must be safe to import inside Temporal workflow code (no Node.js APIs).
 * They are plain TypeScript interfaces — no side effects, no imports from Node.js.
 */

// ─── Workflow inputs ──────────────────────────────────────────────────────────

/**
 * Input to the SwapWorkflow.
 * Encapsulates everything needed to orchestrate a full asset swap lifecycle.
 */
export interface SwapInput {
  /** Full Canton party ID of the proposer (e.g. "Alice::1220abc…") */
  proposerPartyId: string;
  /** Full Canton party ID of the counterparty (e.g. "Bob::1220def…") */
  counterpartyPartyId: string;
  /** Full Canton party ID of the settler/operator (e.g. "Operator::1220xyz…") */
  settlerPartyId: string;
  /** Contract ID of the asset the proposer is offering */
  offeredAssetCid: string;
  /** Symbol of the offered asset (e.g. "TokenX") */
  offeredSymbol: string;
  /** Quantity of the offered asset */
  offeredQuantity: number;
  /** Symbol the proposer wants in exchange (e.g. "TokenY") */
  requestedSymbol: string;
  /** Quantity the proposer wants in exchange */
  requestedQuantity: number;
}

/**
 * Configuration for the BatchCollector workflow.
 * Controls how the bot collects and batches TransferRequests.
 */
export interface BatchConfig {
  /** Full Canton party ID of the operator executing the batches */
  operatorPartyId: string;
  /** How often (in milliseconds) to check for pending transfer requests */
  batchIntervalMs: number;
  /** Minimum number of requests to accumulate before processing */
  minBatchSize: number;
  /** Maximum requests per batch (ledger transaction size limit) */
  maxBatchSize: number;
}

// ─── Workflow state ───────────────────────────────────────────────────────────

/**
 * The status of a swap at any point in its lifecycle.
 * Used by the `statusQuery` to expose internal state to external observers.
 */
export type SwapStatus =
  | 'PROPOSED'   // proposal created on ledger, waiting for counterparty
  | 'ACCEPTED'   // counterparty accepted, settlement in progress
  | 'SETTLED'    // both assets transferred atomically
  | 'REJECTED'   // counterparty rejected the proposal
  | 'CANCELLED'  // proposer cancelled or proposal timed out
  | 'FAILED';    // unexpected error during settlement

/**
 * Running statistics for the BatchCollector workflow.
 * Exposed via `batchStatsQuery` and passed to `continueAsNew` for persistence.
 */
export interface BatchStats {
  /** Number of times this workflow has restarted (via continueAsNew) */
  iteration: number;
  /** Total number of transfers successfully executed */
  totalProcessed: number;
  /** Total number of transfers that failed even after individual retry */
  totalFailed: number;
  /** Number of transfers in the last processed batch */
  lastBatchSize: number;
  /** ISO timestamp of the last batch execution (null if none yet) */
  lastBatchTime: string | null;
}

// ─── Activity result types ────────────────────────────────────────────────────

/**
 * A reference to a pending TransferRequest on the ledger.
 * Returned by `queryPendingTransferRequests`.
 */
export interface TransferRequestRef {
  contractId: string;
  operator: string;
  owner: string;
  newOwner: string;
}

/**
 * A reference to an active SwapProposal on the ledger.
 * Returned by `queryActiveProposals`.
 */
export interface ProposalRef {
  contractId: string;
  proposer: string;
  counterparty: string;
  offeredSymbol: string;
  requestedSymbol: string;
}
