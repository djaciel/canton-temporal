/**
 * Workflow registry — exports all workflow functions and their signals/queries.
 *
 * The Temporal worker's `workflowsPath` points to this file (or its parent
 * directory). The worker's bundler (esbuild) starts here and follows imports
 * to bundle all workflow code into a sandboxed V8 context.
 *
 * Only export workflow-safe code: no Node.js built-ins, no activity imports
 * (use proxyActivities inside each workflow file instead).
 */

// ── SwapWorkflow ──────────────────────────────────────────────────────────────
export { swapWorkflow, acceptSignal, rejectSignal, statusQuery } from './swap.workflow';

// ── BatchCollectorWorkflow ────────────────────────────────────────────────────
export {
  batchCollectorWorkflow,
  flushSignal,
  batchStatsQuery,
} from './batch-collector.workflow';

// ── MonitorWorkflow ───────────────────────────────────────────────────────────
export {
  monitorWorkflow,
  activeProposalsQuery,
  iterationCountQuery,
} from './monitor.workflow';
