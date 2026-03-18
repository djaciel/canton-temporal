/**
 * Ledger activities — all Canton/Daml ledger interactions live here.
 *
 * Activities are regular async TypeScript functions. They run on the Temporal
 * worker (Node.js process) and can use any Node.js API including network calls,
 * file I/O, etc. They are the only place where side effects are allowed.
 *
 * Each activity uses the LedgerClient for the party that has authority to
 * perform that particular action (matching the `controller` in the Daml choice).
 *
 * Design: a `clientFor(partyId)` helper maps Canton party IDs to pre-built
 * LedgerClient instances loaded once from the .env file at module init time.
 */

import { heartbeat, log } from '@temporalio/activity';

import { loadConfig } from '../../config';
import { LedgerClient } from '../../ledger/client';
import { TEMPLATE_IDS, toDecimalString } from '../../types/contracts';
import type { TransferRequest, SwapProposal } from '../../types/contracts';
import type { SwapInput, TransferRequestRef, ProposalRef } from '../types/swap.types';

// ─── Client registry ──────────────────────────────────────────────────────────
// Built once per worker process from environment variables.
// Mapping: displayName (e.g. "Alice") → LedgerClient AND fullPartyId → same client.

function buildClientRegistry(): Map<string, LedgerClient> {
  const cfg = loadConfig();
  const registry = new Map<string, LedgerClient>();

  for (const party of Object.values(cfg.parties)) {
    const displayName = party.id.split('::')[0];
    const client = new LedgerClient(
      cfg.ledger.baseUrl,
      party.token,
      party.id,
      displayName,
    );
    registry.set(displayName, client);  // "Alice", "Bob", "Operator"
    registry.set(party.id, client);     // "Alice::1220abc…"
  }

  return registry;
}

// Initialized once when the module is first imported by the worker.
const _clients = buildClientRegistry();

/**
 * Resolve the LedgerClient for a given party.
 * Accepts both full Canton IDs ("Alice::1220abc…") and display names ("Alice").
 */
function clientFor(partyId: string): LedgerClient {
  const client = _clients.get(partyId) ?? _clients.get(partyId.split('::')[0]);
  if (!client) {
    const known = [..._clients.keys()].filter((k) => !k.includes('::')).join(', ');
    throw new Error(
      `No credentials configured for party "${partyId}". Known parties: ${known}`,
    );
  }
  return client;
}

// ─── Swap lifecycle activities ────────────────────────────────────────────────

/**
 * Create a SwapProposal on the ledger (proposer's action).
 *
 * Daml: proposer signs SwapProposal, counterparty + settler are observers.
 * Returns the created proposal's contract ID.
 */
export async function createSwapProposal(input: SwapInput): Promise<string> {
  log.info('Creating swap proposal on ledger', { proposer: input.proposerPartyId });

  const result = await clientFor(input.proposerPartyId).create(TEMPLATE_IDS.SWAP_PROPOSAL, {
    proposer: input.proposerPartyId,
    counterparty: input.counterpartyPartyId,
    settler: input.settlerPartyId,
    offeredAssetCid: input.offeredAssetCid,
    offeredSymbol: input.offeredSymbol,
    offeredQuantity: toDecimalString(input.offeredQuantity),
    requestedSymbol: input.requestedSymbol,
    requestedQuantity: toDecimalString(input.requestedQuantity),
  });

  log.info('SwapProposal created', { contractId: result.contractId });
  return result.contractId;
}

/**
 * Accept a SwapProposal (counterparty's action).
 *
 * Daml: counterparty exercises Accept, creating a SwapSettlement.
 * Returns the new SwapSettlement contract ID.
 */
export async function acceptProposal(
  proposalCid: string,
  counterpartyAssetCid: string,
  counterpartyPartyId: string,
): Promise<string> {
  log.info('Accepting swap proposal', { proposalCid, counterpartyPartyId });

  const result = await clientFor(counterpartyPartyId).exercise<
    { counterpartyAssetCid: string },
    string
  >(TEMPLATE_IDS.SWAP_PROPOSAL, proposalCid, 'Accept', { counterpartyAssetCid });

  const settlementCid =
    typeof result.exerciseResult === 'string' ? result.exerciseResult : null;

  if (!settlementCid) {
    throw new Error('Accept did not return a SwapSettlement contract ID');
  }

  log.info('SwapSettlement created', { settlementCid });
  return settlementCid;
}

/**
 * Settle a SwapSettlement atomically (settler's action).
 *
 * Daml: settler exercises Settle, transferring both assets in 1 transaction.
 * This is the UTXO atomic swap — both legs happen or neither does.
 */
export async function settleSwap(
  settlementCid: string,
  settlerPartyId: string,
): Promise<void> {
  heartbeat('Starting atomic settlement…');
  log.info('Settling swap', { settlementCid, settlerPartyId });

  await clientFor(settlerPartyId).exercise<Record<string, never>, unknown>(
    TEMPLATE_IDS.SWAP_SETTLEMENT,
    settlementCid,
    'Settle',
    {},
  );

  heartbeat('Settlement complete');
  log.info('Swap settled successfully', { settlementCid });
}

/**
 * Cancel a SwapProposal (proposer's action — used in Saga compensation).
 *
 * Called when the swap fails after the proposal was created, to clean up
 * the on-ledger state and release the offered asset from escrow.
 */
export async function cancelProposal(
  proposalCid: string,
  proposerPartyId: string,
): Promise<void> {
  log.info('Cancelling proposal (Saga compensation)', { proposalCid });

  await clientFor(proposerPartyId).exercise<Record<string, never>, null>(
    TEMPLATE_IDS.SWAP_PROPOSAL,
    proposalCid,
    'Cancel',
    {},
  );

  log.info('Proposal cancelled', { proposalCid });
}

// ─── Batch collector activities ───────────────────────────────────────────────

/**
 * Query all active TransferRequest contracts visible to the operator.
 *
 * The operator is an observer of every TransferRequest, so it can see
 * all pending transfer instructions waiting to be batched.
 */
export async function queryPendingTransferRequests(
  operatorPartyId: string,
): Promise<TransferRequestRef[]> {
  const contracts = await clientFor(operatorPartyId).query<TransferRequest>(
    TEMPLATE_IDS.TRANSFER_REQUEST,
    { operator: operatorPartyId },
  );

  log.info('Queried pending transfer requests', { count: contracts.length });

  return contracts.map((c) => ({
    contractId: c.contractId,
    operator: c.payload.operator,
    owner: c.payload.owner,
    newOwner: c.payload.newOwner,
  }));
}

/**
 * Create a TransferBatch and execute all transfers in a single ledger transaction.
 *
 * Daml: operator creates TransferBatch → exercises ExecuteTransfers.
 * All N transfers happen atomically — if one fails, the entire batch rolls back.
 *
 * This is the core of the batching pattern from the Canton curriculum.
 */
export async function executeTransferBatch(
  operatorPartyId: string,
  requestCids: string[],
): Promise<void> {
  heartbeat(`Creating batch with ${requestCids.length} transfer requests…`);
  log.info('Executing transfer batch', { count: requestCids.length, operatorPartyId });

  const client = clientFor(operatorPartyId);

  // Step 1: Create the TransferBatch contract on the ledger
  const batchContract = await client.create(TEMPLATE_IDS.TRANSFER_BATCH, {
    operator: operatorPartyId,
    requests: requestCids,
  });

  heartbeat(`Batch contract created (${batchContract.contractId}), executing transfers…`);

  // Step 2: Execute all transfers in one atomic Daml transaction
  await client.exercise<Record<string, never>, unknown>(
    TEMPLATE_IDS.TRANSFER_BATCH,
    batchContract.contractId,
    'ExecuteTransfers',
    {},
  );

  heartbeat(`Batch of ${requestCids.length} transfers executed`);
  log.info('Transfer batch executed successfully', { batchCid: batchContract.contractId });
}

/**
 * Execute a single TransferRequest individually (fallback when batch fails).
 *
 * Used by the batch collector's fallback loop: if the whole batch fails
 * (e.g. one invalid transfer), retry each request one by one so that valid
 * transfers still go through.
 */
export async function executeTransferIndividually(
  requestCid: string,
  operatorPartyId: string,
): Promise<void> {
  log.info('Executing transfer individually (fallback)', { requestCid });

  await clientFor(operatorPartyId).exercise<Record<string, never>, string>(
    TEMPLATE_IDS.TRANSFER_REQUEST,
    requestCid,
    'ExecuteTransfer',
    {},
  );

  log.info('Individual transfer executed', { requestCid });
}

// ─── Monitor activities ───────────────────────────────────────────────────────

/**
 * Query all active SwapProposal contracts visible to the given party.
 *
 * Used by the monitor workflow to detect proposals that might be stale
 * or have been open for too long (in a real system, you'd add a createdAt
 * timestamp to the Daml contract and filter by age).
 */
export async function queryActiveProposals(
  readerPartyId: string,
): Promise<ProposalRef[]> {
  const contracts = await clientFor(readerPartyId).query<SwapProposal>(
    TEMPLATE_IDS.SWAP_PROPOSAL,
  );

  log.info('Queried active swap proposals', { count: contracts.length });

  return contracts.map((c) => ({
    contractId: c.contractId,
    proposer: c.payload.proposer,
    counterparty: c.payload.counterparty,
    offeredSymbol: c.payload.offeredSymbol,
    requestedSymbol: c.payload.requestedSymbol,
  }));
}
