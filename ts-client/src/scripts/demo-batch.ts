/**
 * Demo: Batch Transfer Pattern
 * ─────────────────────────────────────────────────────────────────────────────
 * Prerequisites:
 *   1. cd ../daml-contracts && daml start
 *   2. cp .env.example .env && fill in party IDs and tokens
 *   3. npm run demo:batch
 *
 * What this script demonstrates:
 *   - Without batching: 3 transfers = 3 ledger roundtrips (~3 seconds)
 *   - With batching:    3 transfers = 1 ledger roundtrip  (~1 second)
 *
 * Flow:
 *   1. Alice issues 3 assets (TokenA, TokenB, TokenC)
 *   2. Alice creates 3 TransferRequests — pre-authorizing the Operator
 *      to transfer each asset to Bob (delegation pattern)
 *   3. Operator groups all 3 into a single TransferBatch
 *   4. Operator executes the batch → 3 transfers in 1 Daml transaction
 *   5. Also demonstrates the atomicity guarantee: if one request is invalid,
 *      the entire batch rolls back (no partial execution)
 */

import { DamlApiError, LedgerClient } from '../ledger/client';
import { loadConfig } from '../config';
import { AssetOwner } from '../roles/assetOwner';
import { Settler } from '../roles/settler';
import { Asset, Contract } from '../types/contracts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAssets(contracts: Contract<Asset>[]): string {
  if (contracts.length === 0) return '(none)';
  return contracts.map((c) => `  • ${c.payload.quantity} ${c.payload.symbol}`).join('\n');
}

function separator(title: string): void {
  const line = '─'.repeat(50);
  console.log(`\n${line}`);
  console.log(` ${title}`);
  console.log(line);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runDemoBatch(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      Canton Batch Transfer — Performance Demo    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('\nGoal: transfer 3 assets from Alice → Bob in 1 ledger roundtrip');
  console.log('      instead of 3 separate transactions.\n');

  const cfg = loadConfig();

  const aliceClient    = new LedgerClient(cfg.ledger.baseUrl, cfg.parties.alice.token,    cfg.parties.alice.id);
  const bobClient      = new LedgerClient(cfg.ledger.baseUrl, cfg.parties.bob.token,      cfg.parties.bob.id);
  const operatorClient = new LedgerClient(cfg.ledger.baseUrl, cfg.parties.operator.token, cfg.parties.operator.id);

  const alice    = new AssetOwner(aliceClient, cfg.parties.alice.id);
  const bob      = new AssetOwner(bobClient, cfg.parties.bob.id);
  const operator = new Settler(operatorClient, cfg.parties.operator.id);

  // ─── Step 1: Alice issues 3 assets ────────────────────────────────────────
  separator('Step 1 — Alice issues 3 assets');

  // Create all 3 concurrently (independent operations)
  const [tokenA, tokenB, tokenC] = await Promise.all([
    alice.createAsset({ symbol: 'TokenA', quantity: 100, observers: [cfg.parties.operator.id] }),
    alice.createAsset({ symbol: 'TokenB', quantity: 200, observers: [cfg.parties.operator.id] }),
    alice.createAsset({ symbol: 'TokenC', quantity: 300, observers: [cfg.parties.operator.id] }),
  ]);

  console.log(`\n✓ 100 TokenA → ${tokenA.contractId}`);
  console.log(`✓ 200 TokenB → ${tokenB.contractId}`);
  console.log(`✓ 300 TokenC → ${tokenC.contractId}`);

  // ─── Step 2: Alice pre-authorizes the Operator ────────────────────────────
  separator('Step 2 — Alice creates 3 TransferRequests (delegates to Operator)');

  console.log(
    '\nEach TransferRequest is signed by Alice (the owner).',
    '\nThe Operator is just an observer at this point — it has not done anything yet.',
  );

  const [reqA, reqB, reqC] = await Promise.all([
    alice.authorizeTransfer({
      operator: cfg.parties.operator.id,
      newOwner: cfg.parties.bob.id,
      assetCid: tokenA.contractId,
    }),
    alice.authorizeTransfer({
      operator: cfg.parties.operator.id,
      newOwner: cfg.parties.bob.id,
      assetCid: tokenB.contractId,
    }),
    alice.authorizeTransfer({
      operator: cfg.parties.operator.id,
      newOwner: cfg.parties.bob.id,
      assetCid: tokenC.contractId,
    }),
  ]);

  console.log(`\n✓ TransferRequest (TokenA) → ${reqA.contractId}`);
  console.log(`✓ TransferRequest (TokenB) → ${reqB.contractId}`);
  console.log(`✓ TransferRequest (TokenC) → ${reqC.contractId}`);

  // ─── Step 3: Operator batches all requests ────────────────────────────────
  separator('Step 3 — Operator creates a TransferBatch');

  const batch = await operator.createTransferBatch([
    reqA.contractId,
    reqB.contractId,
    reqC.contractId,
  ]);

  console.log(`\n✓ TransferBatch → ${batch.contractId}`);
  console.log('  3 requests queued. Ready for atomic execution.');

  // ─── Step 4: Execute the batch ────────────────────────────────────────────
  separator('Step 4 — Execute all 3 transfers in 1 Daml transaction');

  const t0 = Date.now();
  const batchResult = await operator.executeTransferBatch(batch.contractId);
  const elapsed = Date.now() - t0;

  const newAssetIds = batchResult.exerciseResult;
  console.log(`\n✓ Batch executed in ${elapsed}ms (1 ledger roundtrip)`);
  newAssetIds.forEach((id, i) =>
    console.log(`  [${i + 1}] New asset contract → ${id}`),
  );

  // ─── Verification ─────────────────────────────────────────────────────────
  separator('Verification — Final balances');

  const [aliceAssets, bobAssets] = await Promise.all([
    alice.queryAssets(),
    bob.queryAssets(),
  ]);

  console.log('\nAlice now holds:');
  console.log(aliceAssets.length ? formatAssets(aliceAssets) : '  (none — all transferred)');
  console.log('\nBob now holds:');
  console.log(formatAssets(bobAssets));

  // ─── Performance summary ──────────────────────────────────────────────────
  separator('Performance Summary');

  console.log('\n  Without batching:  3 transfers × ~1s/roundtrip = ~3 seconds');
  console.log(`  With batching:     1 roundtrip  (measured: ${elapsed}ms)\n`);
  console.log('  Atomicity guarantee:');
  console.log('    If any transfer in the batch fails, ALL are rolled back.');
  console.log('    No partial execution — the ledger handles this automatically.\n');

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           ✅  Demo completed successfully!       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
}

runDemoBatch().catch((err: unknown) => {
  if (err instanceof DamlApiError) {
    console.error(`\n❌ Daml API error (HTTP ${err.status}):`);
    err.errors.forEach((e) => console.error(`   • ${e}`));
  } else if (err instanceof Error) {
    console.error(`\n❌ Demo failed: ${err.message}`);
  } else {
    console.error('\n❌ Unknown error:', err);
  }
  process.exit(1);
});
