/**
 * Temporal Worker — the process that executes workflow and activity code.
 *
 * The worker connects to the Temporal server, registers this project's
 * workflows and activities, and continuously polls for tasks on the
 * 'canton-asset-swap' task queue.
 *
 * How it works:
 *   1. Worker connects to the Temporal server (default: localhost:7233)
 *   2. Worker registers workflows (bundled by esbuild into a sandboxed context)
 *   3. Worker registers activities (plain Node.js functions with full I/O access)
 *   4. Temporal server dispatches tasks → worker executes them → results returned
 *
 * Run:
 *   pnpm temporal:worker
 *
 * Prerequisites:
 *   - Temporal dev server running: `temporal server start-dev`
 *   - Canton sandbox running: `./scripts/setup.sh`
 *   - Environment variables set: `pnpm setup:env`
 */

import path from 'path';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as ledgerActivities from '../activities/ledger.activities';
import * as notifActivities from '../activities/notification.activities';

export const TASK_QUEUE = 'canton-asset-swap';

async function run(): Promise<void> {
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Canton Asset Swap — Temporal Worker             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`▶ Connecting to Temporal server at ${temporalAddress}`);

  const connection = await NativeConnection.connect({ address: temporalAddress });

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,

    // `workflowsPath` is bundled by Temporal's esbuild bundler into a
    // sandboxed V8 context. The bundler handles TypeScript natively.
    // Point to the workflows/index.ts file that re-exports all workflow functions.
    workflowsPath: require.resolve('../workflows'),

    // Activities run in normal Node.js — full access to network, file I/O, etc.
    activities: {
      ...ledgerActivities,
      ...notifActivities,
    },
  });

  console.log(`✓ Worker registered on task queue: "${TASK_QUEUE}"`);
  console.log('✓ Workflows: swapWorkflow, batchCollectorWorkflow, monitorWorkflow');
  console.log('✓ Activities: ledger (Canton JSON API) + notifications');
  console.log('\n⏳ Polling for tasks… (Ctrl+C to stop)\n');

  // worker.run() is a long-running promise — it resolves only on shutdown.
  await worker.run();
}

run().catch((err: unknown) => {
  console.error('❌ Worker crashed:', err);
  process.exit(1);
});
