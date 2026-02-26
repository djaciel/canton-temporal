# Canton Asset Swap — TypeScript Client

TypeScript integration layer for the Canton Asset Swap Daml smart contracts.
Communicates with the Canton participant node via the **Canton JSON Ledger API v2** (`/v2/*`).

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 18.0.0 | Required for native `fetch` |
| pnpm | ≥ 9.0.0 | Package manager |
| dpm | 3.4.x | Digital Asset Package Manager — replaces the deprecated `daml` CLI |

Install `dpm`: https://docs.digitalasset.com/build/3.4/dpm/dpm.html

Install Node dependencies:

```bash
pnpm install
```

---

## Quick Start

### Step 1 — Start the Canton sandbox

```bash
# From the ts-client directory:
./scripts/setup.sh
```

This script:
1. Compiles the Daml contracts with `dpm build`
2. Starts the Canton sandbox with `dpm sandbox` (JSON Ledger API v2 on `http://localhost:7575`)
3. Waits for the API to be ready (health check at `/docs/openapi`)
4. Allocates parties Alice, Bob, and Operator via `POST /v2/parties`

> Keep this terminal open — the sandbox runs in the foreground. Press `Ctrl+C` to stop it.

### Step 2 — Generate `.env`

In a **second terminal**:

```bash
cd ts-client
pnpm setup:env
```

This script:
1. Calls `GET /v2/parties` to discover Alice, Bob, and Operator on the running sandbox
2. If any party is missing, creates it automatically via `POST /v2/parties`
3. Generates HS256 JWT tokens for each party (Canton JSON Ledger API v2 format)
4. Writes everything to `ts-client/.env`

> Re-run `pnpm setup:env` after every sandbox restart — party IDs change on each fresh start.

### Step 3 — Run a demo

```bash
pnpm demo:swap    # Full swap lifecycle: issue → propose → accept → settle
pnpm demo:batch   # Batch transfer: N transfers in 1 ledger roundtrip
```

---

## About Credentials

> **Can we hardcode the party IDs and tokens?**

| Credential | Hardcodeable? | Why |
|------------|--------------|-----|
| `ALICE_PARTY` (party ID) | ⚠️ No | Party IDs include a hash generated at registration time. They change on every fresh sandbox restart. |
| `ALICE_TOKEN` (JWT) | ⚠️ No | Tokens are generated from the party ID — if the party ID changes, so does the token. |
| `LEDGER_JSON_API_URL` | ✅ Yes | Fixed for local development (`http://localhost:7575`). |

**Practical workflow:**
- Run `pnpm setup:env` once after each sandbox start
- The generated `.env` is stable for the entire session
- If you restart the sandbox, re-run `pnpm setup:env`

To make party IDs stable across restarts, configure Canton with persistent storage. See the [Canton persistence docs](https://docs.digitalasset.com/build/3.4/explanations/canton/index.html) for details.

---

## Project Structure

```
ts-client/
├── scripts/
│   └── setup.sh              # Builds contracts and starts the Canton sandbox (dpm)
├── src/
│   ├── config.ts             # Loads and validates environment variables
│   ├── ledger/
│   │   └── client.ts         # LedgerClient — thin wrapper for Canton JSON Ledger API v2
│   ├── types/
│   │   └── contracts.ts      # TypeScript interfaces for all Daml templates + Template IDs
│   ├── roles/
│   │   ├── assetOwner.ts     # AssetOwner — issue, split, merge, propose swap, authorize transfer
│   │   ├── counterparty.ts   # Counterparty — accept / reject proposals
│   │   └── settler.ts        # Settler — settle/abort swaps, create/execute batches
│   └── scripts/
│       ├── setup-env.ts      # Discovers parties and writes .env with party IDs and JWT tokens
│       ├── demo-swap.ts      # End-to-end swap lifecycle demo
│       └── demo-batch.ts     # Batch transfer demo
├── .env.example              # Template for .env
├── package.json
└── tsconfig.json
```

---

## Architecture

### Role-based design

Each class in `roles/` maps to a Daml party role and only exposes choices that
the party controls in the Daml contracts:

```
AssetOwner   → createAsset, split, merge, disclose, proposeSwap, authorizeTransfer
Counterparty → acceptProposal, rejectProposal
Settler      → settleSwap, abortSwap, createTransferBatch, executeTransferBatch
```

### One `LedgerClient` per party

```typescript
const aliceClient    = new LedgerClient(baseUrl, aliceToken, alicePartyId);
const bobClient      = new LedgerClient(baseUrl, bobToken,   bobPartyId);
const operatorClient = new LedgerClient(baseUrl, operatorToken, operatorPartyId);

const alice    = new AssetOwner(aliceClient, alicePartyId);
const bob      = new AssetOwner(bobClient,   bobPartyId);
const operator = new Settler(operatorClient, operatorPartyId);
```

Each client sends its party's JWT token and party ID (`actAs`) on every command.
Using the wrong token produces a Daml authorization error from the ledger.

### Canton JSON Ledger API v2

Commands use the proto-gRPC transcoding format — fields are nested inside a `commands` object:

```json
{
  "commands": {
    "commandId":     "cmd-123",
    "userId":        "canton-temporal-ai",
    "actAs":         ["Alice::1220..."],
    "readAs":        ["Alice::1220..."],
    "applicationId": "canton-temporal-ai",
    "commands":      [{ "CreateCommand": { "templateId": "...", "createArguments": { ... } } }]
  }
}
```

### Template IDs

Canton JSON Ledger API v2 uses package-name-based template IDs:

```typescript
export const TEMPLATE_IDS = {
  ASSET:            '#asset-swap-contracts:Asset:Asset',
  SWAP_PROPOSAL:    '#asset-swap-contracts:SwapProposal:SwapProposal',
  SWAP_SETTLEMENT:  '#asset-swap-contracts:SwapProposal:SwapSettlement',
  TRANSFER_REQUEST: '#asset-swap-contracts:TransferBatch:TransferRequest',
  TRANSFER_BATCH:   '#asset-swap-contracts:TransferBatch:TransferBatch',
};
```

Format: `#<package-name>:<ModuleName>:<TemplateName>`
The `#` prefix means "resolve by package name" — stable across DAR upgrades with the same package name.

---

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm build` | Compile TypeScript → `dist/` |
| `pnpm typecheck` | Type-check without emitting files |
| `pnpm setup:env` | Discover parties on the running sandbox and generate `.env` |
| `pnpm demo:swap` | End-to-end asset swap demo |
| `pnpm demo:batch` | Batch transfer demo |

---

## Environment Variables

Copy `.env.example` to `.env`, or generate it automatically with `pnpm setup:env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LEDGER_JSON_API_URL` | No | `http://localhost:7575` | Canton JSON Ledger API v2 base URL |
| `ALICE_PARTY` | Yes | — | Full Canton party ID for Alice |
| `ALICE_TOKEN` | Yes | — | JWT token for Alice |
| `BOB_PARTY` | Yes | — | Full Canton party ID for Bob |
| `BOB_TOKEN` | Yes | — | JWT token for Bob |
| `OPERATOR_PARTY` | Yes | — | Full Canton party ID for Operator |
| `OPERATOR_TOKEN` | Yes | — | JWT token for Operator |

Canton party IDs have the format `DisplayName::hexhash`, e.g.:

```
Alice::1220f1ad80bda06e78b0c19668831445245d0424ae5b9756f7b229ec6f0bdf3d1674
```
