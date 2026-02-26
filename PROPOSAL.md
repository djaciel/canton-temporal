# Canton Network + Temporal: Asset Swap & Settlement System

## Overview

A full-stack project that demonstrates the integration of **Canton Network (Daml smart contracts)** with **Temporal (TypeScript workflows)** to build a decentralized asset swap and settlement system. The system models a scenario where multiple parties can propose, negotiate, and settle asset swaps — orchestrated through durable, fault-tolerant Temporal workflows.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Temporal Server                            │
│                  (Workflow Orchestration)                         │
└───────┬──────────────────┬──────────────────┬────────────────────┘
        │                  │                  │
  ┌─────▼──────┐    ┌─────▼──────┐    ┌──────▼───────┐
  │  Workflow:  │    │  Workflow:  │    │  Workflow:    │
  │  SwapDeal   │    │BatchCollect│    │   Monitor     │
  │  (1 swap)   │    │ (N swaps)  │    │ (long-run)    │
  └─────┬──────┘    └─────┬──────┘    └──────┬────────┘
        │                 │                   │
  ┌─────▼─────────────────▼───────────────────▼────────────────┐
  │              Activities Layer (TypeScript)                   │
  │  - createSwapProposal()     - collectPendingSettlements()  │
  │  - settleSwap()             - settleBatch()                │
  │  - compensateSwap()         - cancelExpiredProposals()     │
  │  - notifyParty()            - queryActiveContracts()       │
  └──────────────────────────┬─────────────────────────────────┘
                             │
                     ┌───────▼───────┐
                     │  JSON API /   │
                     │  Ledger API   │
                     │  (HTTP REST)  │
                     └───────┬───────┘
                             │
              ┌──────────────▼──────────────┐
              │        Canton Ledger        │
              │    (Daml Sandbox / Canton)  │
              │                             │
              │  ┌───────────────────────┐  │
              │  │  SwapProposal (N)     │  │  ← individual proposals
              │  └───────────────────────┘  │
              │  ┌───────────────────────┐  │
              │  │  SwapSettlement (N)   │  │  ← accepted, pending settle
              │  └───────────────────────┘  │
              │  ┌───────────────────────┐  │
              │  │  TransferRequest (N)  │  │  ← authorized transfer instructions
              │  └───────────────────────┘  │
              │  ┌───────────────────────┐  │
              │  │  TransferBatch        │  │  ← groups N transfers
              │  │  ExecuteTransfers     │  │     into 1 atomic tx
              │  └───────────────────────┘  │
              │                             │
              │  Participants:              │
              │    Alice, Bob, Operator     │
              └─────────────────────────────┘
```

---

## Business Domain

**Scenario: Tokenized Asset Swap Platform**

Imagine a simplified exchange platform where:
- **Party A** holds Token X and wants to acquire Token Y
- **Party B** holds Token Y and wants to acquire Token X
- An **Operator/Settler** oversees fair settlement of the trade
- The swap must be atomic — either both transfers happen or neither does

This covers real-world patterns from DeFi, securities settlement, and cross-border transfers.

### Scalability Patterns Demonstrated

This project demonstrates two complementary scalability patterns from the Canton Network curriculum:

**UTXO (Unspent Transaction Output)** — Instead of a single centralized balance, assets exist as independent contracts that can be split and merged. This eliminates contention: multiple transfers can happen in parallel because they operate on different contracts.

**Batching** — Instead of executing transfers one by one (each requiring a separate ledger roundtrip), a bot collects N pending transfer requests and processes them all in a single Daml transaction. This maximizes throughput per ledger roundtrip.

```
Without batching:                       With batching:
  Transfer(asset1) → 1 ledger tx          ┌─ transfer1 ─┐
  Transfer(asset2) → 1 ledger tx          │  transfer2  │──► TransferBatch → 1 ledger tx
  Transfer(asset3) → 1 ledger tx          └─ transfer3 ─┘
  = 3 roundtrips (~3 seconds)              = 1 roundtrip (~1 second)
```

**Why batch at the Transfer level and not at the Settlement level?**
The settlement (`SwapSettlement`) is business logic — it captures the *agreement* between parties. The transfer (`Asset.Transfer`) is the *execution* — it's the operation that archives and creates contracts on the ledger. The contention point is the transfer (the "cash register" from the Canton course), so that's what we optimize with batching. This separation keeps the business logic clean and the performance optimization focused where it matters.

The Temporal worker acts as the **bot** that collects transfer requests and dispatches batches — combining ledger automation with durable execution guarantees.

---

## Phase 1: Daml Smart Contracts

### Goal
Develop, test, and deploy smart contracts locally that model the asset swap lifecycle.

### 1.1 — Contract Design

#### `Asset` Template
Represents a tokenized asset held by a party.

```daml
template Asset
  with
    issuer : Party
    owner : Party
    symbol : Text
    quantity : Decimal
    observers : [Party]
  where
    signatory issuer, owner
    observer observers

    choice Transfer : ContractId Asset
      with newOwner : Party
      controller owner
      do create this with owner = newOwner

    choice Split : (ContractId Asset, ContractId Asset)
      with splitQuantity : Decimal
      controller owner
      do
        first <- create this with quantity = splitQuantity
        second <- create this with quantity = quantity - splitQuantity
        return (first, second)
```

#### `SwapProposal` Template
A proposal from one party to swap assets with another.

```daml
template SwapProposal
  with
    proposer : Party
    counterparty : Party
    offeredAssetCid : ContractId Asset
    requestedSymbol : Text
    requestedQuantity : Decimal
    settler : Party
  where
    signatory proposer
    observer counterparty, settler

    choice Accept : ContractId SwapSettlement
      with counterpartyAssetCid : ContractId Asset
      controller counterparty
      do create SwapSettlement with ..

    choice Reject : ()
      controller counterparty
      do return ()

    choice Cancel : ()
      controller proposer
      do return ()
```

#### `SwapSettlement` Template (Batch/UTXO Pattern)
Represents an accepted swap ready for atomic settlement.

```daml
template SwapSettlement
  with
    proposer : Party
    counterparty : Party
    offeredAssetCid : ContractId Asset
    counterpartyAssetCid : ContractId Asset
    settler : Party
  where
    signatory proposer, counterparty
    observer settler

    choice Settle : (ContractId Asset, ContractId Asset)
      controller settler
      do
        -- Atomic batch: both transfers happen in one transaction (UTXO)
        newAssetForCounterparty <- exercise offeredAssetCid Transfer
          with newOwner = counterparty
        newAssetForProposer <- exercise counterpartyAssetCid Transfer
          with newOwner = proposer
        return (newAssetForCounterparty, newAssetForProposer)

    choice Abort : ()
      controller settler
      do return ()
```

#### `TransferRequest` + `TransferBatch` Templates (Batching Pattern)

The key scalability optimization — separated from the business logic of settlements:

- **`TransferRequest`**: An authorized instruction to transfer an asset. Created when a swap is accepted, signed by the owner (giving the operator delegation to execute it later).
- **`TransferBatch`**: Groups N transfer requests and executes them all in **a single Daml transaction**.

This is the batching pattern from the Canton course. The separation of concerns is important:
- `SwapSettlement` = the business agreement (both parties consent)
- `TransferRequest` = an authorized transfer instruction (owner delegates execution)
- `TransferBatch` = the performance optimization (N transfers in 1 ledger roundtrip)

```daml
-- | An authorized transfer instruction.
-- The owner signs this contract, delegating the actual execution to the operator.
-- This allows the operator to batch multiple transfers into a single transaction.
template TransferRequest
  with
    operator : Party
    assetCid : ContractId Asset
    owner    : Party
    newOwner : Party
  where
    signatory owner
    observer operator

    -- | Operator executes this pre-authorized transfer.
    -- Authority flows from the owner (signatory) through the operator (controller).
    choice ExecuteTransfer : ContractId Asset
      controller operator
      do exercise assetCid Transfer with newOwner

    choice CancelTransfer : ()
      controller owner
      do return ()


-- | Batch multiple transfer requests into a single Daml transaction.
-- The operator creates this contract, then exercises ExecuteTransfers
-- to process all transfers atomically.
template TransferBatch
  with
    operator : Party
    requests : [ContractId TransferRequest]
  where
    signatory operator

    ensure length requests > 0

    -- | Execute all transfers in the batch within a single Daml transaction.
    -- If ANY transfer fails, the entire batch rolls back.
    choice ExecuteTransfers : [ContractId Asset]
      controller operator
      do
        mapA (\reqCid -> exercise reqCid ExecuteTransfer) requests

    -- | Cancel the entire batch without executing anything.
    choice CancelBatch : ()
      controller operator
      do return ()
```

**How it connects to the swap flow:**

```
Individual swap (no batching):
  SwapProposal → Accept → SwapSettlement → Settle
                                            └─ Transfer(assetA → Bob)
                                            └─ Transfer(assetB → Alice)
                                            = 1 tx per swap

Batched (high throughput):
  SwapProposal → Accept → creates 2 TransferRequests (one per leg)
                              ↓
  Bot collects N TransferRequests from multiple swaps
                              ↓
  TransferBatch.ExecuteTransfers → all transfers in 1 tx
```

**Why this matters for performance:**

| Approach | Ledger roundtrips for 10 swaps (20 transfers) | Latency (~1s per roundtrip) |
|----------|-----------------------------------------------|----------------------------|
| Individual settle | 10 | ~10 seconds |
| Batched transfers | 1 | ~1 second |

The trade-off: if one transfer in the batch fails, the entire batch rolls back. The Temporal workflow handles this by retrying failed transfers individually as a fallback.

### 1.2 — Unit Tests (Daml Script)

Write comprehensive test scripts covering:

| Test Case | Description |
|-----------|-------------|
| `happyPathSwap` | Full lifecycle: create assets → propose swap → accept → settle |
| `rejectSwap` | Counterparty rejects a proposal |
| `cancelSwap` | Proposer cancels before acceptance |
| `insufficientAssets` | Attempt swap with non-existent asset |
| `unauthorizedSettle` | Non-settler tries to execute settlement |
| `splitAndSwap` | Split an asset (UTXO pattern), then swap a portion |
| `mergeAssets` | Merge two holdings of the same symbol into one (UTXO) |
| `batchTransfers` | Multiple transfers executed in a single transaction via `TransferBatch` |
| `batchPartialFailure` | A batch where one transfer is invalid — verify entire batch rolls back |

```daml
happyPathSwap = script do
  alice <- allocateParty "Alice"
  bob <- allocateParty "Bob"
  operator <- allocateParty "Operator"

  -- Issue assets
  tokenX <- submit alice do
    createCmd Asset with
      issuer = alice, owner = alice, symbol = "TokenX"
      quantity = 100.0, observers = [bob, operator]

  tokenY <- submit bob do
    createCmd Asset with
      issuer = bob, owner = bob, symbol = "TokenY"
      quantity = 50.0, observers = [alice, operator]

  -- Propose swap
  proposal <- submit alice do
    createCmd SwapProposal with
      proposer = alice, counterparty = bob
      offeredAssetCid = tokenX
      requestedSymbol = "TokenY", requestedQuantity = 50.0
      settler = operator

  -- Accept
  settlement <- submit bob do
    exerciseCmd proposal Accept with counterpartyAssetCid = tokenY

  -- Settle
  (newTokenX, newTokenY) <- submit operator do
    exerciseCmd settlement Settle

  return ()
```

### 1.3 — Local Development Environment

| Option | Description | Best For |
|--------|-------------|----------|
| **Daml Sandbox** (`daml start`) | Lightweight in-memory ledger, fastest iteration | Rapid development & unit testing |
| **Canton local** | Multi-participant topology via Docker Compose | Testing multi-party interactions realistically |
| **CN Quickstart** | Full-featured starter project by Digital Asset | Production-like environment |

**Recommended approach:**
1. Start with **Daml Sandbox** for writing and testing contracts (`daml test`, `daml start`)
2. Graduate to **Canton local** for multi-party integration tests
3. Reference **CN Quickstart** if needed for production deployment patterns

```bash
# Quick start for development
daml build          # Compile .daml → .dar
daml test           # Run all Daml Script tests
daml start          # Launch sandbox + JSON API on localhost:7575
```

---

## Phase 2: TypeScript Integration Layer

### Goal
Build a TypeScript service that interacts with the Daml ledger via the JSON API, organized by roles (parties).

### 2.1 — Project Structure

```
ts-client/
├── src/
│   ├── ledger/
│   │   └── client.ts           # JSON API client wrapper
│   ├── roles/
│   │   ├── assetOwner.ts       # Functions for asset owner operations
│   │   ├── counterparty.ts     # Functions for counterparty operations
│   │   └── settler.ts          # Functions for settler/operator operations
│   ├── types/
│   │   └── contracts.ts        # Generated Daml type bindings
│   ├── scripts/
│   │   ├── demo-swap.ts        # End-to-end swap demo script
│   │   └── demo-batch.ts       # Batch settlement demo
│   └── index.ts
├── package.json
└── tsconfig.json
```

### 2.2 — Role-Based Architecture

Each file in `roles/` encapsulates actions for a specific party role:

```typescript
// roles/assetOwner.ts
export class AssetOwner {
  constructor(private client: LedgerClient, private party: string) {}

  async createAsset(symbol: string, quantity: number) {
    return this.client.create('Asset', {
      issuer: this.party,
      owner: this.party,
      symbol,
      quantity: quantity.toString(),
      observers: [],
    });
  }

  async proposeSwap(params: SwapProposalParams) {
    return this.client.create('SwapProposal', {
      proposer: this.party,
      ...params,
    });
  }

  async splitAsset(contractId: string, splitQuantity: number) {
    return this.client.exercise('Asset', contractId, 'Split', {
      splitQuantity: splitQuantity.toString(),
    });
  }
}
```

```typescript
// roles/settler.ts
export class Settler {
  constructor(private client: LedgerClient, private party: string) {}

  async settleSwap(settlementContractId: string) {
    return this.client.exercise(
      'SwapSettlement', settlementContractId, 'Settle', {}
    );
  }

  async abortSwap(settlementContractId: string) {
    return this.client.exercise(
      'SwapSettlement', settlementContractId, 'Abort', {}
    );
  }

  async queryPendingSettlements() {
    return this.client.query('SwapSettlement', { settler: this.party });
  }
}
```

### 2.3 — JSON API Client

```typescript
// ledger/client.ts
export class LedgerClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async create(templateId: string, payload: Record<string, unknown>) {
    return fetch(`${this.baseUrl}/v1/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ templateId, payload }),
    }).then(res => res.json());
  }

  async exercise(templateId: string, contractId: string, choice: string, argument: Record<string, unknown>) {
    return fetch(`${this.baseUrl}/v1/exercise`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ templateId, contractId, choice, argument }),
    }).then(res => res.json());
  }

  async query(templateId: string, filter: Record<string, unknown> = {}) {
    return fetch(`${this.baseUrl}/v1/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ templateId, query: filter }),
    }).then(res => res.json());
  }
}
```

---

## Phase 3: Temporal Workflows

### Goal
Orchestrate the asset swap lifecycle through Temporal workflows, demonstrating basic and advanced Temporal concepts.

### 3.1 — Project Structure

```
temporal-service/
├── src/
│   ├── activities/
│   │   ├── ledger.activities.ts     # Daml ledger interactions
│   │   └── notification.activities.ts # Simulated notifications
│   ├── workflows/
│   │   ├── swap.workflow.ts             # Main swap orchestration (1 swap)
│   │   ├── batch-collector.workflow.ts  # Bot: collects & batches N settlements
│   │   └── monitor.workflow.ts          # Long-running: cancel expired proposals
│   ├── workers/
│   │   └── worker.ts               # Temporal worker setup
│   ├── clients/
│   │   └── starter.ts              # Workflow starter / CLI
│   ├── types/
│   │   └── swap.types.ts
│   └── index.ts
├── package.json
└── tsconfig.json
```

### 3.2 — Temporal Concepts Covered

#### Basic Concepts

| Concept | Where It's Used |
|---------|-----------------|
| **Workflows** | `swap.workflow.ts` — orchestrates the full swap lifecycle |
| **Activities** | `ledger.activities.ts` — calls to Daml JSON API |
| **Activity Retry Policies** | Configured retries for ledger calls (network failures) |
| **Workflow Signals** | Counterparty sends `accept` / `reject` signal to pending swap |
| **Workflow Queries** | Query current swap status at any time |
| **Timeouts** | Schedule-to-close and start-to-close for activities |
| **Testing** | Unit tests with mocked activities using Temporal test framework |

#### Advanced Concepts

| Concept | Where It's Used |
|---------|-----------------|
| **Saga / Compensation** | If settlement fails, run compensation activities to revert state |
| **Cancellation Scopes** | Handle workflow cancellation gracefully (e.g., abort swap) |
| **Continue-As-New** | Batch collector + monitor restart themselves to avoid history buildup |
| **Signals (flush)** | Force immediate batch processing instead of waiting for the interval |
| **Heartbeats** | Long-running batch settlement activity heartbeats for progress |
| **Batch + Fallback** | Attempt N transfers in 1 tx; if batch fails, retry individually |
| **Versioning** | Demonstrate workflow patching for safe code evolution |

### 3.3 — Swap Workflow (Main)

```typescript
// workflows/swap.workflow.ts
import {
  proxyActivities, defineSignal, defineQuery,
  setHandler, condition, CancellationScope,
  ApplicationFailure
} from '@temporalio/workflow';
import type * as activities from '../activities/ledger.activities';

const {
  createSwapProposal, queryProposal, settleSwap,
  compensateSwap, notifyParty
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 3 },
});

interface SwapInput {
  proposer: string;
  counterparty: string;
  offeredAssetCid: string;
  requestedSymbol: string;
  requestedQuantity: number;
  settler: string;
}

// -- Signals & Queries --
export const acceptSignal = defineSignal<[{ counterpartyAssetCid: string }]>('accept');
export const rejectSignal = defineSignal('reject');
export const statusQuery = defineQuery<SwapStatus>('status');

type SwapStatus = 'PROPOSED' | 'ACCEPTED' | 'SETTLED' | 'REJECTED' | 'CANCELLED' | 'FAILED';

export async function swapWorkflow(input: SwapInput): Promise<SwapStatus> {
  let status: SwapStatus = 'PROPOSED';
  let counterpartyAssetCid: string | null = null;
  const compensations: Array<() => Promise<void>> = [];

  // Query handler
  setHandler(statusQuery, () => status);

  // Signal handlers
  setHandler(acceptSignal, (data) => {
    counterpartyAssetCid = data.counterpartyAssetCid;
  });

  setHandler(rejectSignal, () => {
    status = 'REJECTED';
  });

  // Step 1: Create proposal on ledger
  const proposalCid = await createSwapProposal(input);
  compensations.push(() => compensateSwap(proposalCid));

  await notifyParty(input.counterparty, `New swap proposal from ${input.proposer}`);

  // Step 2: Wait for counterparty response (timeout: 24h)
  const responded = await condition(
    () => counterpartyAssetCid !== null || status === 'REJECTED',
    '24h'
  );

  if (!responded) {
    status = 'CANCELLED';
    await notifyParty(input.proposer, 'Swap proposal expired');
    return status;
  }

  if (status === 'REJECTED') {
    await notifyParty(input.proposer, 'Swap proposal rejected');
    return status;
  }

  // Step 3: Settlement (Saga pattern)
  status = 'ACCEPTED';
  try {
    await settleSwap({
      proposalCid,
      counterpartyAssetCid: counterpartyAssetCid!,
      settler: input.settler,
    });
    status = 'SETTLED';
    await notifyParty(input.proposer, 'Swap settled successfully');
    await notifyParty(input.counterparty, 'Swap settled successfully');
  } catch (err) {
    status = 'FAILED';
    // Saga compensation: undo operations in reverse order
    for (const compensate of compensations.reverse()) {
      await CancellationScope.nonCancellable(async () => {
        await compensate();
      });
    }
    throw ApplicationFailure.nonRetryable('Settlement failed, compensations applied');
  }

  return status;
}
```

### 3.4 — Batch Collector Workflow (Batching Pattern)

This is the core of the batching pattern: a Temporal workflow that acts as the **bot** from the Canton course. It periodically queries the ledger for pending `TransferRequest` contracts, collects them into a batch, and executes them all in a single ledger transaction via the `TransferBatch` contract.

This demonstrates several Temporal concepts at once:
- **Continue-As-New** (long-running process without unbounded history)
- **Signals** (external trigger to force immediate batch processing)
- **Queries** (inspect current batch state)
- **Child Workflows** (fallback: retry failed swaps individually)
- **Activity Retry Policies** (resilience to transient ledger errors)

```
┌──────────────────────────────────────────────────────────┐
│  BatchCollector Workflow (runs continuously)              │
│                                                          │
│  1. Sleep for BATCH_INTERVAL (e.g. 30s)                  │
│     OR receive flushSignal to process immediately        │
│                                                          │
│  2. Query ledger: get all pending TransferRequests        │
│                                                          │
│  3. If count >= MIN_BATCH_SIZE or flush triggered:       │
│     ├─ Call executeTransferBatch() activity               │
│     │    └─ Creates TransferBatch on ledger               │
│     │    └─ Exercises ExecuteTransfers → 1 atomic tx      │
│     │                                                    │
│     ├─ If batch fails (1 bad transfer):                  │
│     │    └─ Fallback: execute individually                │
│     │    └─ Report which ones failed                      │
│     │                                                    │
│     └─ Update batch stats (total, settled, failed)       │
│                                                          │
│  4. continueAsNew() → repeat from step 1                 │
└──────────────────────────────────────────────────────────┘
```

```typescript
// workflows/batch-collector.workflow.ts
import {
  proxyActivities, defineSignal, defineQuery, setHandler,
  condition, continueAsNew, sleep
} from '@temporalio/workflow';
import type * as activities from '../activities/ledger.activities';

const {
  queryPendingTransferRequests, executeTransferBatch,
  executeTransferIndividually, notifyParty
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 3 },
});

interface BatchConfig {
  settler: string;
  batchIntervalMs: number;   // how often to check for pending settlements
  minBatchSize: number;       // minimum swaps to accumulate before processing
  maxBatchSize: number;       // maximum swaps per batch (ledger tx size limit)
}

interface BatchStats {
  iteration: number;
  totalProcessed: number;
  totalFailed: number;
  lastBatchSize: number;
  lastBatchTime: string | null;
}

// Signal: force immediate batch processing (don't wait for interval)
export const flushSignal = defineSignal('flush');

// Query: inspect current batch stats
export const batchStatsQuery = defineQuery<BatchStats>('batchStats');

export async function batchCollectorWorkflow(
  config: BatchConfig,
  stats: BatchStats = {
    iteration: 0, totalProcessed: 0, totalFailed: 0,
    lastBatchSize: 0, lastBatchTime: null
  }
): Promise<void> {
  let flushRequested = false;

  setHandler(flushSignal, () => { flushRequested = true; });
  setHandler(batchStatsQuery, () => stats);

  // Wait for batch interval OR flush signal
  await condition(() => flushRequested, config.batchIntervalMs);
  flushRequested = false;

  // Query ledger for pending transfer requests
  const pending = await queryPendingTransferRequests(config.settler);

  if (pending.length >= config.minBatchSize || pending.length > 0) {
    // Cap at max batch size
    const batch = pending.slice(0, config.maxBatchSize);

    try {
      // Attempt batch: 1 ledger transaction for N transfers
      await executeTransferBatch({
        operator: config.settler,
        requestCids: batch.map(r => r.contractId),
      });

      stats.totalProcessed += batch.length;
      stats.lastBatchSize = batch.length;
      stats.lastBatchTime = new Date().toISOString();

    } catch (batchError) {
      // Batch failed (one bad transfer poisoned it) → fallback to individual
      for (const request of batch) {
        try {
          await executeTransferIndividually(request.contractId, config.settler);
          stats.totalProcessed++;
        } catch {
          stats.totalFailed++;
          await notifyParty(config.settler,
            `Transfer failed for ${request.contractId}`);
        }
      }
      stats.lastBatchSize = batch.length;
      stats.lastBatchTime = new Date().toISOString();
    }
  }

  stats.iteration++;

  // Restart to keep event history bounded
  await continueAsNew<typeof batchCollectorWorkflow>(config, stats);
}
```

### 3.5 — Monitoring Workflow (Continue-As-New)

```typescript
// workflows/monitor.workflow.ts
import {
  continueAsNew, proxyActivities, sleep
} from '@temporalio/workflow';
import type * as activities from '../activities/ledger.activities';

const { queryExpiredProposals, cancelExpiredProposal, notifyParty } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '10s',
  });

export async function monitorWorkflow(iterationCount: number = 0): Promise<void> {
  const expired = await queryExpiredProposals();

  for (const proposal of expired) {
    await cancelExpiredProposal(proposal.contractId);
    await notifyParty(proposal.proposer, 'Your proposal has expired and was cancelled');
  }

  await sleep('5m');

  // Avoid unbounded event history
  await continueAsNew<typeof monitorWorkflow>(iterationCount + 1);
}
```

### 3.6 — Activities

```typescript
// activities/ledger.activities.ts
import { LedgerClient } from '../../ts-client/src/ledger/client';
import { heartbeat } from '@temporalio/activity';

const client = new LedgerClient(
  process.env.LEDGER_URL || 'http://localhost:7575',
  process.env.LEDGER_TOKEN || ''
);

export async function createSwapProposal(input: SwapInput): Promise<string> {
  const result = await client.create('SwapProposal', {
    proposer: input.proposer,
    counterparty: input.counterparty,
    offeredAssetCid: input.offeredAssetCid,
    requestedSymbol: input.requestedSymbol,
    requestedQuantity: input.requestedQuantity.toString(),
    settler: input.settler,
  });
  return result.contractId;
}

export async function settleSwap(params: SettleParams): Promise<void> {
  heartbeat('Starting settlement...');
  await client.exercise('SwapSettlement', params.proposalCid, 'Settle', {});
  heartbeat('Settlement complete');
}

// Batching: create a TransferBatch on ledger and exercise ExecuteTransfers
// to process N transfers in a single Daml transaction
export async function executeTransferBatch(params: {
  operator: string;
  requestCids: string[];
}): Promise<void> {
  heartbeat(`Executing batch of ${params.requestCids.length} transfers...`);

  // Step 1: Create the batch contract on the ledger
  const batchResult = await client.create('TransferBatch', {
    operator: params.operator,
    requests: params.requestCids,
  });

  // Step 2: Exercise ExecuteTransfers → all transfers in 1 atomic tx
  await client.exercise(
    'TransferBatch', batchResult.contractId, 'ExecuteTransfers', {}
  );

  heartbeat(`Batch of ${params.requestCids.length} transfers executed`);
}

// Fallback: execute a single transfer when the batch fails
export async function executeTransferIndividually(
  requestCid: string, operator: string
): Promise<void> {
  await client.exercise('TransferRequest', requestCid, 'ExecuteTransfer', {});
}

// Query pending transfer requests for the operator
export async function queryPendingTransferRequests(operator: string) {
  return client.query('TransferRequest', { operator });
}

export async function compensateSwap(proposalCid: string): Promise<void> {
  await client.exercise('SwapProposal', proposalCid, 'Cancel', {});
}

export async function queryPendingSettlements(settler: string) {
  return client.query('SwapSettlement', { settler: settler });
}

export async function queryExpiredProposals() {
  return client.query('SwapProposal', { expired: true });
}

export async function cancelExpiredProposal(contractId: string) {
  return client.exercise('SwapProposal', contractId, 'Cancel', {});
}

export async function notifyParty(party: string, message: string) {
  console.log(`[NOTIFICATION → ${party}]: ${message}`);
}
```

### 3.7 — Testing

```typescript
// __tests__/swap.workflow.test.ts
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { swapWorkflow, acceptSignal, statusQuery } from '../workflows/swap.workflow';

describe('Swap Workflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  });

  afterAll(async () => {
    await env.teardown();
  });

  it('completes a full swap lifecycle', async () => {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-swap',
      workflowsPath: require.resolve('../workflows/swap.workflow'),
      activities: {
        createSwapProposal: async () => 'proposal-123',
        settleSwap: async () => {},
        compensateSwap: async () => {},
        notifyParty: async () => {},
      },
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(swapWorkflow, {
        workflowId: 'test-swap-1',
        taskQueue: 'test-swap',
        args: [{ /* swap input */ }],
      });

      // Simulate counterparty acceptance
      await handle.signal(acceptSignal, { counterpartyAssetCid: 'asset-456' });

      const result = await handle.result();
      expect(result).toBe('SETTLED');
    });
  });

  it('handles rejection correctly', async () => { /* ... */ });
  it('times out after 24h with no response', async () => { /* ... */ });
  it('runs compensation on settlement failure', async () => { /* ... */ });
});
```

---

## Execution Roadmap

### Week 1 — Daml Smart Contracts ✅

| Day | Task | Pattern |
|-----|------|---------|
| 1 | Setup: Install Daml SDK, multi-package project structure | — |
| 2 | Implement `Asset` template (Transfer, Split, Merge, Disclose) | UTXO |
| 3 | Implement `SwapProposal` template (Accept/Reject/Cancel) | Propose-Accept |
| 4 | Implement `SwapSettlement` (atomic Settle) + `TransferRequest` / `TransferBatch` | Batching |
| 5 | Write Daml Script tests: happy path, edge cases, auth, batch | Testing |

### Week 2 — TypeScript Client + Temporal

| Day | Task | Pattern |
|-----|------|---------|
| 1 | Setup TypeScript project, create JSON API client wrapper | — |
| 2 | Implement role-based modules (AssetOwner, Counterparty, Settler) | Roles |
| 3 | Write and run demo scripts against local sandbox | — |
| 4 | Setup Temporal dev server, create worker | — |
| 5 | Implement `swapWorkflow` with signals, queries, and timeouts | Basics |

### Week 3 — Advanced Temporal + Batching

| Day | Task | Pattern |
|-----|------|---------|
| 1 | Implement saga/compensation pattern in swap workflow | Saga |
| 2 | Implement `batchCollectorWorkflow` (bot + batching + fallback) | Batching |
| 3 | Implement `monitorWorkflow` with continue-as-new | Monitoring |
| 4 | Write Temporal workflow tests with mocked activities | Testing |
| 5 | Integration testing: full flow from Temporal → TypeScript → Daml | E2E |

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Smart Contracts | Daml (Canton Network) |
| Local Ledger | Daml Sandbox / Canton local |
| Contract API | JSON Ledger API (`localhost:7575`) |
| Backend / Client | TypeScript (Node.js) |
| Workflow Engine | Temporal (TypeScript SDK) |
| Testing (Daml) | Daml Script |
| Testing (Temporal) | `@temporalio/testing` + Jest |
| Dev Server (Temporal) | `temporal server start-dev` |

---

## How to Run (Target)

```bash
# Terminal 1: Start Daml sandbox + JSON API
cd daml-contracts/
daml start

# Terminal 2: Start Temporal dev server
temporal server start-dev

# Terminal 3: Start Temporal worker
cd temporal-service/
npm run worker

# Terminal 4: Trigger a swap workflow
cd temporal-service/
npm run start-swap -- --proposer Alice --counterparty Bob --asset TokenX --quantity 100

# Terminal 5: Start the batch collector bot (runs continuously)
cd temporal-service/
npm run start-batch-collector -- --settler Operator --interval 30000 --min-batch 3

# Manual: force immediate batch processing
cd temporal-service/
npm run flush-batch
```

---

## Key Takeaways Demonstrated

1. **Canton/Daml**: Smart contract design, authorization model (signatories/observers), atomic transactions, UTXO-style splits/merges, multi-party workflows
2. **Scalability Patterns**: UTXO (eliminate contention via distributed contracts) + Batching at the transfer level (maximize throughput per ledger roundtrip) — both from the Canton Network curriculum
3. **Separation of Concerns**: Settlement = business agreement between parties; TransferRequest = authorized instruction; TransferBatch = execution optimization. Each concept has its own contract.
4. **Temporal**: Durable execution, signals/queries, saga compensation, continue-as-new, batch collection with fallback, long-running bots, testing
5. **Architecture**: Temporal as the automation/bot layer for Canton — collecting transfer requests, batching, and executing on behalf of the operator without human intervention
5. **AI-Assisted Development**: The entire project is built leveraging AI tools for code generation, debugging, and architecture decisions
