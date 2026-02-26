/**
 * Demo: Full Asset Swap Lifecycle
 * ─────────────────────────────────────────────────────────────────────────────
 * Prerequisites:
 *   1. cd ../daml-contracts && daml start   (starts the sandbox + JSON API)
 *   2. cp .env.example .env && fill in party IDs and tokens
 *   3. npm run demo:swap
 *
 * What this script does:
 *   1. Alice issues 200 TokenX
 *   2. Bob   issues 100 TokenY
 *   3. Alice proposes a swap  (200 TokenX ↔ 100 TokenY)
 *   4. Bob   accepts the proposal (creates a SwapSettlement)
 *   5. Operator settles the swap atomically  (both legs in 1 tx)
 *   6. Verify final balances
 */

import { DamlApiError, LedgerClient } from '../ledger/client';
import { loadConfig } from '../config';
import { AssetOwner } from '../roles/assetOwner';
import { Counterparty } from '../roles/counterparty';
import { Settler } from '../roles/settler';
import { Asset, Contract } from '../types/contracts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAssets(contracts: Contract<Asset>[]): string {
  if (contracts.length === 0) return '(none)';
  return contracts.map((c) => `${c.payload.quantity} ${c.payload.symbol}`).join(', ');
}

function separator(title: string): void {
  const line = '─'.repeat(50);
  console.log(`\n${line}`);
  console.log(` ${title}`);
  console.log(line);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runDemoSwap(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        Canton Asset Swap — Full Demo             ║');
  console.log('╚══════════════════════════════════════════════════╝');

  const cfg = loadConfig();

  // Each party gets its own LedgerClient bound to its token + partyId.
  // The partyId is used in the actAs/readAs fields of every command submission.
  const aliceClient    = new LedgerClient(cfg.ledger.baseUrl, cfg.parties.alice.token,    cfg.parties.alice.id);
  const bobClient      = new LedgerClient(cfg.ledger.baseUrl, cfg.parties.bob.token,      cfg.parties.bob.id);
  const operatorClient = new LedgerClient(cfg.ledger.baseUrl, cfg.parties.operator.token, cfg.parties.operator.id);

  const alice        = new AssetOwner(aliceClient, cfg.parties.alice.id);
  const bob          = new AssetOwner(bobClient, cfg.parties.bob.id);
  const bobAsCounterparty = new Counterparty(bobClient, cfg.parties.bob.id);
  const operator     = new Settler(operatorClient, cfg.parties.operator.id);

  // ─── Step 1: Issue assets ──────────────────────────────────────────────────
  separator('Step 1 — Issue assets');

  const tokenX = await alice.createAsset({
    symbol: 'TokenX',
    quantity: 200,
    observers: [cfg.parties.bob.id, cfg.parties.operator.id],
  });

  const tokenY = await bob.createAsset({
    symbol: 'TokenY',
    quantity: 100,
    observers: [cfg.parties.alice.id, cfg.parties.operator.id],
  });

  console.log(`\n✓ Alice's TokenX → ${tokenX.contractId}`);
  console.log(`✓ Bob's   TokenY → ${tokenY.contractId}`);

  // ─── Step 2: Alice proposes a swap ────────────────────────────────────────
  separator('Step 2 — Alice proposes a swap');

  const proposal = await alice.proposeSwap({
    counterparty:      cfg.parties.bob.id,
    settler:           cfg.parties.operator.id,
    offeredAssetCid:   tokenX.contractId,
    offeredSymbol:     'TokenX',
    offeredQuantity:   200,
    requestedSymbol:   'TokenY',
    requestedQuantity: 100,
  });

  console.log(`\n✓ SwapProposal created → ${proposal.contractId}`);
  console.log('  Alice is now committed. Bob can Accept, Reject, or Alice can Cancel.');

  // ─── Step 3: Bob accepts ──────────────────────────────────────────────────
  separator('Step 3 — Bob accepts the proposal');

  const acceptResult = await bobAsCounterparty.acceptProposal(
    proposal.contractId,
    tokenY.contractId,
  );

  // Accept returns a ContractId SwapSettlement
  const settlementContractId = acceptResult.exerciseResult;
  console.log(`\n✓ SwapSettlement created → ${settlementContractId}`);
  console.log('  Both parties have committed. Awaiting the Operator to settle.');

  // ─── Step 4: Operator settles ─────────────────────────────────────────────
  separator('Step 4 — Operator settles (atomic 2-leg transfer)');

  const settleResult = await operator.settleSwap(settlementContractId);

  // Settle returns (ContractId Asset, ContractId Asset) → serialized as a 2-tuple array
  const [newTokenXId, newTokenYId] = settleResult.exerciseResult;
  console.log('\n✓ Swap settled in a single Daml transaction!');
  console.log(`  TokenX now owned by Bob   → ${newTokenXId}`);
  console.log(`  TokenY now owned by Alice → ${newTokenYId}`);

  // ─── Verification ─────────────────────────────────────────────────────────
  separator('Verification — Final balances');

  const [aliceAssets, bobAssets] = await Promise.all([
    alice.queryAssets(),
    bob.queryAssets(),
  ]);

  console.log(`\nAlice: ${formatAssets(aliceAssets)}`);
  console.log(`Bob:   ${formatAssets(bobAssets)}`);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           ✅  Demo completed successfully!       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
}

runDemoSwap().catch((err: unknown) => {
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
