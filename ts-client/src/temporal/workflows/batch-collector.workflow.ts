/**
 * BatchCollector Workflow — the "bot" that continuously batches TransferRequests.
 *
 * This workflow implements the batching pattern from the Canton curriculum.
 * It runs indefinitely as a long-lived process and demonstrates:
 *
 *   - continueAsNew:   restart with fresh history to avoid unbounded event logs
 *   - Signals (flush): external trigger to process immediately without waiting
 *   - Queries:         expose batch statistics to external observers
 *   - Batch + Fallback: attempt N transfers in 1 tx; if batch fails, retry individually
 *   - Activity retries: resilience to transient Canton/network errors
 *
 * Architecture:
 * ┌──────────────────────────────────────────────────────────┐
 * │  BatchCollector (runs continuously via continueAsNew)    │
 * │                                                          │
 * │  1. Sleep for batchIntervalMs OR receive flushSignal     │
 * │  2. Query ledger: get pending TransferRequest contracts  │
 * │  3. If enough requests (≥ minBatchSize) OR flush:        │
 * │     ├─ Try: executeTransferBatch() → 1 atomic ledger tx  │
 * │     └─ Catch: retry individually (fallback loop)         │
 * │  4. continueAsNew(config, updatedStats) → back to step 1 │
 * └──────────────────────────────────────────────────────────┘
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  sleep,
} from '@temporalio/workflow';

import type * as ledgerActivities from '../activities/ledger.activities';
import type * as notifActivities from '../activities/notification.activities';
import type { BatchConfig, BatchStats, TransferRequestRef } from '../types/swap.types';

// ─── Activity proxies ─────────────────────────────────────────────────────────

const {
  queryPendingTransferRequests,
  executeTransferBatch,
  executeTransferIndividually,
} = proxyActivities<typeof ledgerActivities>({
  startToCloseTimeout: '60s',  // batch execution can take a while
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
  },
});

const { notifyParty } = proxyActivities<typeof notifActivities>({
  startToCloseTimeout: '5s',
  retry: { maximumAttempts: 2 },
});

// ─── Signals ──────────────────────────────────────────────────────────────────

/**
 * Force immediate batch processing without waiting for the interval.
 * Useful for testing or when an external system knows a batch is ready.
 *
 * Usage: `temporalClient.getHandle(workflowId).signal(flushSignal)`
 */
export const flushSignal = defineSignal('flush');

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get the current batch statistics (total processed, failed, iteration, etc.)
 * This query is synchronous — no activities are scheduled.
 */
export const batchStatsQuery = defineQuery<BatchStats>('batchStats');

// ─── Workflow ─────────────────────────────────────────────────────────────────

/**
 * Continuously collect and execute TransferRequest batches.
 *
 * The `stats` parameter carries state across `continueAsNew` restarts.
 * Default values are set for the first run; subsequent runs pass the
 * accumulated stats forward so metrics are never lost.
 *
 * @param config - Batch configuration (interval, min/max size, operator party)
 * @param stats  - Accumulated statistics, forwarded through continueAsNew
 */
export async function batchCollectorWorkflow(
  config: BatchConfig,
  stats: BatchStats = {
    iteration: 0,
    totalProcessed: 0,
    totalFailed: 0,
    lastBatchSize: 0,
    lastBatchTime: null,
  },
): Promise<void> {
  let flushRequested = false;

  setHandler(flushSignal, () => {
    flushRequested = true;
  });
  setHandler(batchStatsQuery, () => stats);

  // ── Step 1: Wait for interval OR flush signal ──────────────────────────────
  // `condition()` resolves with `true` when the predicate fires (flush received),
  // or with `false` when the timeout expires. Either way, we proceed.
  await condition(() => flushRequested, config.batchIntervalMs);
  const wasForced = flushRequested;
  flushRequested = false;

  // ── Step 2: Query pending TransferRequests ─────────────────────────────────
  const pending: TransferRequestRef[] = await queryPendingTransferRequests(
    config.operatorPartyId,
  );

  const shouldProcess = wasForced || pending.length >= config.minBatchSize;

  if (shouldProcess && pending.length > 0) {
    // Cap at maxBatchSize to stay within Daml transaction limits
    const batch = pending.slice(0, config.maxBatchSize);
    const requestCids = batch.map((r) => r.contractId);

    // ── Step 3a: Attempt batch (N transfers in 1 atomic ledger transaction) ──
    try {
      await executeTransferBatch(config.operatorPartyId, requestCids);

      stats.totalProcessed += batch.length;
      stats.lastBatchSize = batch.length;
      stats.lastBatchTime = new Date().toISOString();

    } catch {
      // ── Step 3b: Batch failed — fallback to individual transfers ───────────
      // One invalid TransferRequest can poison the entire batch because all
      // Daml operations in `mapA` run atomically. The fallback processes each
      // request individually so that valid ones still go through.
      let batchProcessed = 0;
      let batchFailed = 0;

      for (const request of batch) {
        try {
          await executeTransferIndividually(request.contractId, config.operatorPartyId);
          batchProcessed++;
        } catch {
          batchFailed++;
          await notifyParty(
            config.operatorPartyId,
            `Transfer failed for contract ${request.contractId} ` +
              `(owner: ${request.owner} → ${request.newOwner})`,
          );
        }
      }

      stats.totalProcessed += batchProcessed;
      stats.totalFailed += batchFailed;
      stats.lastBatchSize = batch.length;
      stats.lastBatchTime = new Date().toISOString();
    }
  }

  stats.iteration += 1;

  // ── Step 4: Restart via continueAsNew ─────────────────────────────────────
  // continueAsNew terminates the current execution and schedules a fresh one
  // with the same workflow function. This keeps the event history bounded
  // (critical for long-running bots that would otherwise grow indefinitely).
  // The updated `stats` object is forwarded so no data is lost.
  await continueAsNew<typeof batchCollectorWorkflow>(config, stats);
}
