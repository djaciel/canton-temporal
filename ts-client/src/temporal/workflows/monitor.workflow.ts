/**
 * Monitor Workflow — long-running observer that tracks active swap proposals.
 *
 * This workflow demonstrates:
 *   - continueAsNew:  the canonical pattern for infinite loops in Temporal
 *   - sleep():        pause between iterations without burning CPU
 *   - Queries:        expose monitoring state to external callers
 *
 * What it does:
 *   Every CHECK_INTERVAL, query all active SwapProposal contracts visible to
 *   the operator. Log their status and count. In a production system, you would
 *   add a `createdAt` timestamp field to the Daml SwapProposal template and
 *   cancel proposals that have been open longer than a configured TTL.
 *
 * Note: Our current Daml SwapProposal does not have an expiry/timestamp field,
 * so this monitor reports proposals without filtering by age.
 * The pattern is correct — the Daml contract is the only missing piece.
 */

import { proxyActivities, continueAsNew, sleep, defineQuery, setHandler } from '@temporalio/workflow';

import type * as ledgerActivities from '../activities/ledger.activities';
import type * as notifActivities from '../activities/notification.activities';
import type { ProposalRef } from '../types/swap.types';

// ─── Activity proxies ─────────────────────────────────────────────────────────

const { queryActiveProposals } = proxyActivities<typeof ledgerActivities>({
  startToCloseTimeout: '15s',
  retry: { maximumAttempts: 3 },
});

const { notifyParty } = proxyActivities<typeof notifActivities>({
  startToCloseTimeout: '5s',
  retry: { maximumAttempts: 2 },
});

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Query the list of proposals seen in the most recent monitoring iteration. */
export const activeProposalsQuery = defineQuery<ProposalRef[]>('activeProposals');

/** Query how many monitoring iterations have completed. */
export const iterationCountQuery = defineQuery<number>('iterationCount');

// ─── Config constants ──────────────────────────────────────────────────────────

/** How often to poll the ledger for active proposals (5 minutes). */
const CHECK_INTERVAL = '5m';

/**
 * After how many iterations to restart via continueAsNew.
 * Keeps event history bounded. Each iteration adds ~5 events.
 * At 100 iterations the history is ~500 events — well within Temporal limits,
 * but we restart early to keep things clean.
 */
const RESTART_AFTER_ITERATIONS = 100;

// ─── Workflow ─────────────────────────────────────────────────────────────────

/**
 * Monitor active swap proposals and report on their status.
 *
 * Runs indefinitely via continueAsNew. Each iteration:
 *   1. Query active SwapProposal contracts from the Canton ledger
 *   2. Log and expose them via query handler
 *   3. Notify operator if proposals have been accumulating
 *   4. Sleep CHECK_INTERVAL
 *   5. continueAsNew (or loop internally up to RESTART_AFTER_ITERATIONS)
 *
 * @param operatorPartyId  - Canton party ID of the operator (reads all proposals)
 * @param iterationCount   - Number of completed iterations (forwarded via continueAsNew)
 */
export async function monitorWorkflow(
  operatorPartyId: string,
  iterationCount: number = 0,
): Promise<void> {
  let latestProposals: ProposalRef[] = [];
  let currentIteration = iterationCount;

  // Register query handlers once per execution (they reset on continueAsNew)
  setHandler(activeProposalsQuery, () => latestProposals);
  setHandler(iterationCountQuery, () => currentIteration);

  // Run internally for RESTART_AFTER_ITERATIONS before continueAsNew
  while (currentIteration < iterationCount + RESTART_AFTER_ITERATIONS) {
    // ── Query ledger for active proposals ────────────────────────────────────
    latestProposals = await queryActiveProposals(operatorPartyId);

    const proposalCount = latestProposals.length;

    if (proposalCount > 0) {
      // Log summary of active proposals
      const summary = latestProposals
        .map(
          (p) =>
            `  • ${p.proposer.split('::')[0]} offers ${p.offeredSymbol} ` +
            `→ ${p.counterparty.split('::')[0]} wants ${p.requestedSymbol}`,
        )
        .join('\n');

      await notifyParty(
        operatorPartyId,
        `Monitor [iteration ${currentIteration}]: ${proposalCount} active proposal(s):\n${summary}`,
      );

      // In production, filter by age and cancel expired ones:
      // const expired = latestProposals.filter(p => isExpired(p, maxAgeMs));
      // for (const proposal of expired) { await cancelExpiredProposal(proposal, operatorPartyId); }
    } else {
      await notifyParty(
        operatorPartyId,
        `Monitor [iteration ${currentIteration}]: No active proposals — ledger is clean.`,
      );
    }

    currentIteration += 1;

    // ── Wait before next check ───────────────────────────────────────────────
    if (currentIteration < iterationCount + RESTART_AFTER_ITERATIONS) {
      await sleep(CHECK_INTERVAL);
    }
  }

  // ── Restart via continueAsNew to keep history bounded ────────────────────
  // Pass the updated iteration count so monitoring is truly continuous.
  await continueAsNew<typeof monitorWorkflow>(operatorPartyId, currentIteration);
}
