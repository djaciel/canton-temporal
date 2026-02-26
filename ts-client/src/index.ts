/**
 * Canton Asset Swap — TypeScript Client
 *
 * This package is the integration layer between TypeScript and the Daml
 * smart contracts running on a Canton participant node.
 *
 * It communicates via the Daml JSON Ledger API v1 (http://localhost:7575
 * when using `daml start`).
 */

const usage = `
Canton Asset Swap — TypeScript Client
======================================

Quick start:
  1. Start the Daml sandbox:
       cd ../daml-contracts && daml start

  2. Configure party IDs and tokens:
       cp .env.example .env
       # Fill in ALICE_PARTY, BOB_PARTY, OPERATOR_PARTY and their tokens
       # See .env.example for instructions on how to get them.

  3. Run a demo:
       npm run demo:swap    # Full swap lifecycle (propose → accept → settle)
       npm run demo:batch   # Batch transfers (N transfers in 1 ledger roundtrip)

Available scripts:
  pnpm build          # Compile TypeScript → dist/
  pnpm typecheck      # Type-check without emitting files
  pnpm demo:swap      # End-to-end swap demo
  pnpm demo:batch     # Batching pattern demo

Project structure:
  src/
  ├── ledger/         LedgerClient — thin wrapper for the JSON Ledger API
  ├── types/          TypeScript interfaces for all Daml templates
  ├── roles/          Role-based classes (AssetOwner, Counterparty, Settler)
  ├── scripts/        Runnable demo scripts
  └── config.ts       Environment-based configuration loader
`;

console.log(usage);
