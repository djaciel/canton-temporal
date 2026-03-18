/**
 * Temporal Workflow Starter — CLI for launching and interacting with workflows.
 *
 * Commands:
 *   start-swap        Create assets on Canton and start a SwapWorkflow
 *   accept-swap       Send the accept signal to a running SwapWorkflow
 *   reject-swap       Send the reject signal to a running SwapWorkflow
 *   status-swap       Query the current status of a SwapWorkflow
 *   start-batch       Start the BatchCollector bot (runs indefinitely)
 *   flush-batch       Send the flush signal to force immediate batch processing
 *   batch-stats       Query the current stats of the BatchCollector
 *   start-monitor     Start the Monitor workflow (watches active proposals)
 *   active-proposals  Query proposals seen by the Monitor workflow
 *
 * The starter also handles asset creation on Canton directly (via LedgerClient)
 * so `start-swap` is fully self-contained — no manual ledger setup needed.
 *
 * Run:
 *   pnpm temporal:start-swap
 *   pnpm temporal:start-batch
 *   pnpm temporal:flush-batch [workflowId]
 *   pnpm temporal:status [workflowId]
 */

import { Connection, Client } from '@temporalio/client';
import { loadConfig } from '../../config';
import { LedgerClient } from '../../ledger/client';
import { TEMPLATE_IDS, toDecimalString } from '../../types/contracts';
import {
  swapWorkflow,
  acceptSignal,
  rejectSignal,
  statusQuery,
} from '../workflows/swap.workflow';
import {
  batchCollectorWorkflow,
  flushSignal,
  batchStatsQuery,
} from '../workflows/batch-collector.workflow';
import {
  monitorWorkflow,
  activeProposalsQuery,
  iterationCountQuery,
} from '../workflows/monitor.workflow';
import type { SwapInput, BatchConfig } from '../types/swap.types';

export const TASK_QUEUE = 'canton-asset-swap';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getTemporalClient(): Promise<Client> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address });
  return new Client({ connection });
}

/** Generate a short unique workflow ID with an optional prefix. */
function workflowId(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

/** Build a LedgerClient for a specific party from the loaded config. */
function makeClient(partyConfig: { id: string; token: string }, baseUrl: string): LedgerClient {
  const displayName = partyConfig.id.split('::')[0];
  return new LedgerClient(baseUrl, partyConfig.token, partyConfig.id, displayName);
}

/** Parse a named CLI argument like `--asset-cid #0:0` from process.argv. */
function arg(name: string, fallback?: string): string {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: --${name}`);
}

/** Get a positional argument (argv[3], argv[4], etc.). */
function positional(index: number, name: string): string {
  const value = process.argv[index + 2]; // argv[0]=node, argv[1]=script, argv[2]=command
  if (!value) throw new Error(`Missing positional argument <${name}> at position ${index}`);
  return value;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * start-swap: create assets for Alice and Bob on Canton, then start a SwapWorkflow.
 *
 * This command is self-contained:
 *   1. Creates a TokenX asset for Alice (the proposer)
 *   2. Creates a TokenY asset for Bob (the counterparty)
 *   3. Starts a SwapWorkflow with Alice offering TokenX for TokenY
 *   4. Prints the workflow ID to use with `accept-swap`
 */
async function startSwap(): Promise<void> {
  const cfg = loadConfig();
  const temporal = await getTemporalClient();

  const offeredSymbol = arg('offered-symbol', 'TokenX');
  const offeredQty = parseFloat(arg('offered-quantity', '100'));
  const requestedSymbol = arg('requested-symbol', 'TokenY');
  const requestedQty = parseFloat(arg('requested-quantity', '50'));

  console.log('\n── Creating assets on Canton ledger ────────────────────────');

  // Create Alice's asset (the one she'll offer)
  const aliceClient = makeClient(cfg.parties.alice, cfg.ledger.baseUrl);
  const aliceAsset = await aliceClient.create(TEMPLATE_IDS.ASSET, {
    issuer: cfg.parties.alice.id,
    owner: cfg.parties.alice.id,
    symbol: offeredSymbol,
    quantity: toDecimalString(offeredQty),
    observers: [cfg.parties.bob.id, cfg.parties.operator.id],
  });
  console.log(`✓ Alice's ${offeredSymbol} asset:  ${aliceAsset.contractId}`);

  // Create Bob's asset (the one he'll offer in exchange)
  const bobClient = makeClient(cfg.parties.bob, cfg.ledger.baseUrl);
  const bobAsset = await bobClient.create(TEMPLATE_IDS.ASSET, {
    issuer: cfg.parties.bob.id,
    owner: cfg.parties.bob.id,
    symbol: requestedSymbol,
    quantity: toDecimalString(requestedQty),
    observers: [cfg.parties.alice.id, cfg.parties.operator.id],
  });
  console.log(`✓ Bob's ${requestedSymbol} asset: ${bobAsset.contractId}`);

  const input: SwapInput = {
    proposerPartyId: cfg.parties.alice.id,
    counterpartyPartyId: cfg.parties.bob.id,
    settlerPartyId: cfg.parties.operator.id,
    offeredAssetCid: aliceAsset.contractId,
    offeredSymbol,
    offeredQuantity: offeredQty,
    requestedSymbol,
    requestedQuantity: requestedQty,
  };

  const wfId = workflowId('swap');

  console.log('\n── Starting SwapWorkflow ─────────────────────────────────────');
  const handle = await temporal.workflow.start(swapWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: wfId,
    args: [input],
  });

  console.log(`✓ SwapWorkflow started!`);
  console.log(`  Workflow ID: ${handle.workflowId}`);
  console.log(`  Bob's asset: ${bobAsset.contractId}`);
  console.log('\nNext steps:');
  console.log(
    `  Accept:  pnpm temporal:accept-swap ${handle.workflowId} ${bobAsset.contractId}`,
  );
  console.log(`  Reject:  pnpm temporal:reject-swap ${handle.workflowId}`);
  console.log(`  Status:  pnpm temporal:status ${handle.workflowId}`);
}

/**
 * accept-swap <workflowId> <counterpartyAssetCid>
 * Send the accept signal to a running SwapWorkflow as the counterparty (Bob).
 */
async function acceptSwap(): Promise<void> {
  const wfId = positional(1, 'workflowId');
  const counterpartyAssetCid = positional(2, 'counterpartyAssetCid');

  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(wfId);

  await handle.signal(acceptSignal, { counterpartyAssetCid });
  console.log(`✓ Accept signal sent to workflow ${wfId}`);
  console.log(`  Counterparty asset CID: ${counterpartyAssetCid}`);
}

/**
 * reject-swap <workflowId>
 * Send the reject signal to a running SwapWorkflow as the counterparty.
 */
async function rejectSwap(): Promise<void> {
  const wfId = positional(1, 'workflowId');

  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(wfId);

  await handle.signal(rejectSignal);
  console.log(`✓ Reject signal sent to workflow ${wfId}`);
}

/**
 * status-swap <workflowId>
 * Query the current status of a SwapWorkflow without blocking.
 */
async function statusSwap(): Promise<void> {
  const wfId = positional(1, 'workflowId');

  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(wfId);

  const status = await handle.query(statusQuery);
  console.log(`Workflow ${wfId} status: ${status}`);
}

/**
 * start-batch: start the BatchCollector workflow (runs indefinitely).
 *
 * Creates a batch collector bot that watches for pending TransferRequests
 * and executes them in batches. The bot runs until manually terminated.
 */
async function startBatch(): Promise<void> {
  const cfg = loadConfig();
  const temporal = await getTemporalClient();

  const intervalMs = parseInt(arg('interval', '30000'), 10);
  const minBatch = parseInt(arg('min-size', '1'), 10);
  const maxBatch = parseInt(arg('max-size', '10'), 10);

  const config: BatchConfig = {
    operatorPartyId: cfg.parties.operator.id,
    batchIntervalMs: intervalMs,
    minBatchSize: minBatch,
    maxBatchSize: maxBatch,
  };

  const wfId = arg('workflow-id', workflowId('batch-collector'));

  const handle = await temporal.workflow.start(batchCollectorWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: wfId,
    args: [config],
  });

  console.log(`✓ BatchCollector started!`);
  console.log(`  Workflow ID:    ${handle.workflowId}`);
  console.log(`  Operator:       ${cfg.parties.operator.id.split('::')[0]}`);
  console.log(`  Interval:       ${intervalMs}ms`);
  console.log(`  Batch size:     ${minBatch}–${maxBatch} requests`);
  console.log('\nCommands:');
  console.log(`  Flush:  pnpm temporal:flush-batch ${handle.workflowId}`);
  console.log(`  Stats:  pnpm temporal:batch-stats ${handle.workflowId}`);
}

/**
 * flush-batch <workflowId>
 * Send the flush signal to force immediate batch processing.
 */
async function flushBatch(): Promise<void> {
  const wfId = positional(1, 'workflowId');

  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(wfId);

  await handle.signal(flushSignal);
  console.log(`✓ Flush signal sent to BatchCollector ${wfId}`);
  console.log('  The bot will process pending requests immediately.');
}

/**
 * batch-stats <workflowId>
 * Query the current statistics of a running BatchCollector workflow.
 */
async function batchStats(): Promise<void> {
  const wfId = positional(1, 'workflowId');

  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(wfId);

  const stats = await handle.query(batchStatsQuery);
  console.log(`\nBatchCollector stats for ${wfId}:`);
  console.log(`  Iteration:       ${stats.iteration}`);
  console.log(`  Total processed: ${stats.totalProcessed}`);
  console.log(`  Total failed:    ${stats.totalFailed}`);
  console.log(`  Last batch size: ${stats.lastBatchSize}`);
  console.log(`  Last batch time: ${stats.lastBatchTime ?? 'never'}`);
}

/**
 * start-monitor: start the Monitor workflow that watches active proposals.
 */
async function startMonitor(): Promise<void> {
  const cfg = loadConfig();
  const temporal = await getTemporalClient();

  const wfId = arg('workflow-id', workflowId('monitor'));

  const handle = await temporal.workflow.start(monitorWorkflow, {
    taskQueue: TASK_QUEUE,
    workflowId: wfId,
    args: [cfg.parties.operator.id, 0],
  });

  console.log(`✓ MonitorWorkflow started!`);
  console.log(`  Workflow ID: ${handle.workflowId}`);
  console.log(`  Checking every 5 minutes for active proposals.`);
  console.log(`\n  Active proposals: pnpm temporal:active-proposals ${handle.workflowId}`);
}

/**
 * active-proposals <workflowId>
 * Query the proposals seen in the last Monitor iteration.
 */
async function activeProposals(): Promise<void> {
  const wfId = positional(1, 'workflowId');

  const temporal = await getTemporalClient();
  const handle = temporal.workflow.getHandle(wfId);

  const [proposals, iteration] = await Promise.all([
    handle.query(activeProposalsQuery),
    handle.query(iterationCountQuery),
  ]);

  console.log(`\nMonitor ${wfId} — iteration ${iteration}`);
  if (proposals.length === 0) {
    console.log('  No active proposals.');
  } else {
    console.log(`  ${proposals.length} active proposal(s):`);
    for (const p of proposals) {
      console.log(
        `    • [${p.contractId.slice(0, 20)}…] ` +
          `${p.proposer.split('::')[0]} offers ${p.offeredSymbol} ` +
          `↔ ${p.counterparty.split('::')[0]} ${p.requestedSymbol}`,
      );
    }
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

const COMMANDS: Record<string, () => Promise<void>> = {
  'start-swap': startSwap,
  'accept-swap': acceptSwap,
  'reject-swap': rejectSwap,
  'status-swap': statusSwap,
  'start-batch': startBatch,
  'flush-batch': flushBatch,
  'batch-stats': batchStats,
  'start-monitor': startMonitor,
  'active-proposals': activeProposals,
};

function printUsage(): void {
  console.log('\nUsage: pnpm temporal:<command> [args]\n');
  console.log('Commands:');
  console.log('  temporal:start-swap               Create assets and start a SwapWorkflow');
  console.log('    --offered-symbol  <sym>          (default: TokenX)');
  console.log('    --offered-quantity <qty>         (default: 100)');
  console.log('    --requested-symbol <sym>         (default: TokenY)');
  console.log('    --requested-quantity <qty>       (default: 50)');
  console.log();
  console.log('  temporal:accept-swap <wfId> <assetCid>   Send accept signal to SwapWorkflow');
  console.log('  temporal:reject-swap <wfId>              Send reject signal to SwapWorkflow');
  console.log('  temporal:status <wfId>                   Query swap status');
  console.log();
  console.log('  temporal:start-batch                 Start the BatchCollector bot');
  console.log('    --interval <ms>                   (default: 30000)');
  console.log('    --min-size <n>                    (default: 1)');
  console.log('    --max-size <n>                    (default: 10)');
  console.log('    --workflow-id <id>                (optional, auto-generated)');
  console.log();
  console.log('  temporal:flush-batch <wfId>          Force immediate batch processing');
  console.log('  temporal:batch-stats <wfId>          Query batch statistics');
  console.log();
  console.log('  temporal:start-monitor               Start the Monitor workflow');
  console.log('  temporal:active-proposals <wfId>     Query proposals seen by monitor');
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`❌ Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  try {
    await handler();
  } catch (err: unknown) {
    console.error(`❌ Error:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
