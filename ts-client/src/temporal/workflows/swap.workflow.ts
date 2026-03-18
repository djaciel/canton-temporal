/**
 * SwapWorkflow — orchestrates the full asset swap lifecycle.
 *
 * This is the main Temporal workflow that coordinates a single swap between
 * two parties. It demonstrates several key Temporal concepts:
 *
 *   - Signals:  counterparty sends `accept` or `reject` from outside the workflow
 *   - Queries:  any caller can ask "what is the current status?" at any time
 *   - Timeouts: `condition(..., '1h')` cancels the proposal if no response arrives
 *   - Saga:     if settlement fails, compensations run in reverse order to undo
 *   - CancellationScope.nonCancellable: compensations run even if workflow is cancelled
 *
 * IMPORTANT — Temporal workflow rules:
 *   Workflows run in a sandboxed, deterministic V8 context. They CANNOT:
 *     - Call Node.js built-ins (fs, net, Date.now, Math.random, etc.)
 *     - Import activities directly — use proxyActivities() instead
 *     - Perform any I/O — delegate all side effects to activities
 *   Use workflow.now() instead of Date.now(), workflow.sleep() instead of setTimeout.
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  CancellationScope,
  ApplicationFailure,
} from '@temporalio/workflow';

// Activity imports MUST use `import type` — the actual implementation runs on
// the worker. Only the type signature is needed here for proxyActivities().
import type * as ledgerActivities from '../activities/ledger.activities';
import type * as notifActivities from '../activities/notification.activities';

import type { SwapInput, SwapStatus } from '../types/swap.types';

// ─── Activity proxies ─────────────────────────────────────────────────────────
// proxyActivities() returns stub functions that, when called inside a workflow,
// schedule the actual activity on the task queue and wait for its result.

const { createSwapProposal, acceptProposal, settleSwap, cancelProposal } =
  proxyActivities<typeof ledgerActivities>({
    startToCloseTimeout: '30s',
    retry: {
      maximumAttempts: 3,
      initialInterval: '1s',
      backoffCoefficient: 2,
    },
  });

const { notifyParty } = proxyActivities<typeof notifActivities>({
  startToCloseTimeout: '5s',
  retry: { maximumAttempts: 2 },
});

// ─── Signals ──────────────────────────────────────────────────────────────────
// Signals are fire-and-forget messages sent into a running workflow from outside.
// The counterparty uses these to respond to the swap proposal.

/** Counterparty accepts the proposal and provides their asset contract ID. */
export const acceptSignal = defineSignal<[{ counterpartyAssetCid: string }]>('accept');

/** Counterparty rejects the proposal. */
export const rejectSignal = defineSignal('reject');

// ─── Queries ──────────────────────────────────────────────────────────────────
// Queries are synchronous read-only handlers — they return a value immediately
// without scheduling any activities or changing workflow state.

/** Query the current lifecycle status of this swap. */
export const statusQuery = defineQuery<SwapStatus>('status');

// ─── Workflow ─────────────────────────────────────────────────────────────────

/**
 * Orchestrate a single asset swap from proposal to settlement.
 *
 * Flow:
 *   1. Create SwapProposal on ledger (proposer's action)
 *   2. Register Saga compensation: cancel proposal if anything goes wrong
 *   3. Notify counterparty
 *   4. Wait up to 1h for accept/reject signal
 *   5a. REJECTED → notify proposer, return 'REJECTED'
 *   5b. TIMEOUT  → run compensations, notify proposer, return 'CANCELLED'
 *   5c. ACCEPTED → proceed to settlement
 *   6. Accept proposal on ledger (counterparty's action) → SwapSettlement
 *   7. Settle atomically (settler's action) → both assets transferred
 *   8. On any failure → run Saga compensations
 */
export async function swapWorkflow(input: SwapInput): Promise<SwapStatus> {
  let status: SwapStatus = 'PROPOSED';
  let counterpartyAssetCid: string | null = null;
  // Track rejection separately to avoid TypeScript narrowing issues on `status`.
  // Signal handlers run asynchronously (between await points), so TypeScript
  // cannot narrow `status` through `condition()` boundaries.
  let wasRejected = false;

  // Saga compensation stack — populated as irreversible actions are taken.
  // Compensations are run in reverse order (LIFO) to undo operations cleanly.
  const compensations: Array<() => Promise<void>> = [];

  // ── Register query handler ─────────────────────────────────────────────────
  setHandler(statusQuery, () => status);

  // ── Register signal handlers ───────────────────────────────────────────────
  // Signal handlers update local state synchronously. The workflow unblocks
  // from `condition()` on the next event loop iteration.
  setHandler(acceptSignal, ({ counterpartyAssetCid: cid }) => {
    counterpartyAssetCid = cid;
  });
  setHandler(rejectSignal, () => {
    status = 'REJECTED';
    wasRejected = true;
  });

  // ── Step 1: Create the proposal on the ledger ──────────────────────────────
  const proposalCid = await createSwapProposal(input);

  // Register compensation: if we fail later, cancel this proposal
  // to release the offered asset from "escrow" state.
  compensations.push(() => cancelProposal(proposalCid, input.proposerPartyId));

  await notifyParty(
    input.counterpartyPartyId,
    `New swap proposal from ${input.proposerPartyId.split('::')[0]}: ` +
      `offer ${input.offeredQuantity} ${input.offeredSymbol} ` +
      `for ${input.requestedQuantity} ${input.requestedSymbol}`,
  );

  // ── Step 2: Wait for counterparty response ─────────────────────────────────
  // `condition()` blocks the workflow until the predicate returns true OR
  // the timeout expires. Returns true if predicate fired, false if timed out.
  // Note: use '24h' for production; '1h' is set here for reasonable demos.
  const responded = await condition(
    () => counterpartyAssetCid !== null || wasRejected,
    '1h',
  );

  if (!responded) {
    // Timeout: proposal expired, clean up and exit
    status = 'CANCELLED';
    await CancellationScope.nonCancellable(async () => {
      for (const compensate of [...compensations].reverse()) {
        await compensate();
      }
    });
    await notifyParty(input.proposerPartyId, 'Swap proposal timed out and was cancelled');
    return status;
  }

  if (wasRejected) {
    // Counterparty sent rejectSignal — proposal is archived by the cancel
    await CancellationScope.nonCancellable(async () => {
      for (const compensate of [...compensations].reverse()) {
        await compensate();
      }
    });
    await notifyParty(input.proposerPartyId, 'Swap proposal was rejected by counterparty');
    return status;
  }

  // ── Step 3: Accept the proposal (creates SwapSettlement on ledger) ─────────
  status = 'ACCEPTED';
  let settlementCid: string;

  try {
    settlementCid = await acceptProposal(
      proposalCid,
      counterpartyAssetCid!,
      input.counterpartyPartyId,
    );
    // Note: once accepted, we cannot cancel the proposal anymore
    // (it's been archived). The only compensation now is SwapSettlement.Abort.
    compensations.pop(); // remove the cancelProposal compensation
  } catch (err) {
    status = 'FAILED';
    await CancellationScope.nonCancellable(async () => {
      for (const compensate of [...compensations].reverse()) {
        await compensate();
      }
    });
    throw ApplicationFailure.nonRetryable(
      'Failed to accept proposal; compensations applied',
    );
  }

  // ── Step 4: Atomic settlement ──────────────────────────────────────────────
  // The settler exercises SwapSettlement.Settle — both assets transfer atomically.
  // If this fails, we've already consumed the proposal, so we can only abort
  // the settlement (not undo the acceptance).
  try {
    await settleSwap(settlementCid, input.settlerPartyId);
    status = 'SETTLED';
    await notifyParty(input.proposerPartyId, '✓ Swap settled successfully!');
    await notifyParty(input.counterpartyPartyId, '✓ Swap settled successfully!');
  } catch (err) {
    status = 'FAILED';
    // In a full implementation, exercise SwapSettlement.Abort here
    throw ApplicationFailure.nonRetryable(
      'Settlement failed after acceptance — manual intervention required',
    );
  }

  return status;
}
