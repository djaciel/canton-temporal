# Lesson: Smart Contract Architecture with Daml

> This document explains, step by step, how the smart contracts in the Asset Swap project are built. It is written as a review of what we learned, with focus on the _why_ behind each decision.

---

## Table of Contents

1. [What is a smart contract in Daml?](#1-what-is-a-smart-contract-in-daml)
2. [Key concepts before we start](#2-key-concepts-before-we-start)
3. [The `Asset` contract](#3-the-asset-contract)
4. [The Propose-Accept pattern: `SwapProposal`](#4-the-propose-accept-pattern-swapproposal)
5. [The atomic settlement: `SwapSettlement`](#5-the-atomic-settlement-swapsettlement)
6. [Full flow: from proposal to exchange](#6-full-flow-from-proposal-to-exchange)
7. [The UTXO pattern: Split and Merge](#7-the-utxo-pattern-split-and-merge)
8. [The Batching pattern: `TransferRequest` and `TransferBatch`](#8-the-batching-pattern-transferrequest-and-transferbatch)
9. [Important design decision: who signs what?](#9-important-design-decision-who-signs-what)
10. [The tests: what we check and why](#10-the-tests-what-we-check-and-why)
11. [Why the project is split into two packages](#11-why-the-project-is-split-into-two-packages)

---

## 1. What is a smart contract in Daml?

A smart contract in Daml is simply a **digital agreement between parties** that lives on the ledger (the shared record). It has three jobs:

1. **Store data** (the fields of the contract).
2. **Define who can see that data** (observers).
3. **Define what actions can be done with it and who can do them** (choices).

The most important thing: **the ledger makes sure the rules are followed**. It is not possible to do something the contract does not allow, no matter what the external code tries.

In Daml, a contract is defined with the keyword `template`:

```daml
template ContractName
  with
    field1 : Type
    field2 : Type
  where
    signatory ...  -- who signed this contract
    observer  ...  -- who can see it
    -- actions go here (choices)
```

---

## 2. Key concepts before we start

Before looking at the code, there are four concepts that appear everywhere in Daml. Understanding them well makes everything else clear.

### Signatory

The signatory is the party (or parties) that **must agree to create the contract**. By signing, they accept the responsibilities the contract brings. Nobody can create a contract in your name without your signature.

> Think of it like: the person who signs a legal contract. Without their signature, the document is not valid.

### Observer

An observer can **see the contract** on the ledger but has no responsibilities and cannot perform actions on their own. Observers are used to give visibility to interested parties.

> Think of it like: a witness at a notary office. They see what happens but do not sign.

### Controller

Inside each `choice` (action), the `controller` defines **who can run that action**. Only that party can call the choice.

> Think of it like: the person who has the key to open a specific safe.

### ContractId

Every contract lives on the ledger with a unique identifier called a `ContractId`. When one contract refers to another, it does so using the `ContractId`. It works like a pointer or a foreign key in a database.

---

## 3. The `Asset` contract

The `Asset` is the basic building block of the system. It represents **a digital asset**: it can be a coin, a token, a bond — anything with value.

```daml
template Asset
  with
    issuer   : Party    -- who created the asset
    owner    : Party    -- who currently holds it
    symbol   : Text     -- token name (e.g. "TokenX")
    quantity : Decimal  -- amount
    observers : [Party] -- parties who can see it
  where
    signatory issuer
    observer owner :: observers

    ensure quantity > 0.0
```

### What does each part do?

- `issuer` is who **created** the asset. It is the only signatory.
- `owner` is who **holds** it right now. They can run actions on it.
- `ensure quantity > 0.0` is a **rule**: the ledger will reject any attempt to create an Asset with zero or negative quantity. This validation is automatic and cannot be bypassed.

### The available actions (choices)

| Choice | Controller | What it does |
|--------|------------|--------------|
| `Transfer` | `owner` | Moves the asset to a new owner |
| `Split` | `owner` | Divides the asset into two (UTXO pattern) |
| `Merge` | `owner` | Combines two assets with the same symbol into one |
| `Disclose` | `owner` | Adds an observer to give visibility |

### How `Transfer` works

```daml
choice Transfer : ContractId Asset
  with
    newOwner : Party
  controller owner
  do
    create this with owner = newOwner
```

- The current contract is **consumed** (it disappears from the ledger).
- A **new contract** is created — identical but with `owner = newOwner`.
- This makes sure there is no double-spending: the original contract stops existing.

> Note: In Daml, all choices consume the contract by default. When a choice runs, the original contract is archived and any new contracts created by the choice are the new live assets on the ledger.

---

## 4. The Propose-Accept pattern: `SwapProposal`

For two parties to exchange assets, it is not enough for one party to decide to transfer. The other party also needs to **agree**. This pattern is called **Propose-Accept** and is one of the most common design patterns in Daml.

```
Alice ──[proposes swap]──► SwapProposal ──[Bob accepts]──► SwapSettlement
```

The `SwapProposal` contract models the offer:

```daml
template SwapProposal
  with
    proposer          : Party
    counterparty      : Party
    settler           : Party
    offeredAssetCid   : ContractId Asset  -- the asset the proposer offers
    offeredSymbol     : Text
    offeredQuantity   : Decimal
    requestedSymbol   : Text              -- what they ask for in return
    requestedQuantity : Decimal
  where
    signatory proposer        -- only Alice signs when creating the proposal
    observer counterparty, settler
```

### Why is only the proposer a signatory?

Because at this point **only Alice is committed**. Bob has not agreed to anything yet. By creating the `SwapProposal`, Alice is saying: "I commit to offering this." Bob can only see the proposal (he is an observer).

### The three possible responses

**1. Accept** — Bob agrees and commits his asset:

```daml
choice Accept : ContractId SwapSettlement
  with
    counterpartyAssetCid : ContractId Asset
  controller counterparty   -- only Bob can accept
  do
    -- Checks before accepting
    pledged <- fetch counterpartyAssetCid
    assertMsg "Symbol must match" (pledged.symbol == requestedSymbol)
    assertMsg "Quantity must be enough" (pledged.quantity >= requestedQuantity)
    assertMsg "Asset must belong to Bob" (pledged.owner == counterparty)

    create SwapSettlement with ...
```

Notice that before accepting, the ledger **automatically checks** that the asset Bob is offering is really the right one. If the conditions are not met, the whole transaction fails.

**2. Reject** — Bob says no:

```daml
choice Reject : ()
  controller counterparty
  do return ()
```

Simple: the contract is archived and nothing else happens.

**3. Cancel** — Alice changes her mind:

```daml
choice Cancel : ()
  controller proposer
  do return ()
```

Only Alice can cancel her own proposal. Bob cannot cancel Alice's proposal.

---

## 5. The atomic settlement: `SwapSettlement`

When Bob accepts, a `SwapSettlement` is created. This contract represents **an agreement that is ready to be executed**. Both parties have already said yes.

```daml
template SwapSettlement
  with
    proposer             : Party
    counterparty         : Party
    settler              : Party
    offeredAssetCid      : ContractId Asset
    counterpartyAssetCid : ContractId Asset
    ...
  where
    signatory proposer, counterparty  -- now BOTH sign
    observer settler
```

### The key difference from `SwapProposal`

| | `SwapProposal` | `SwapSettlement` |
|--|----------------|-----------------|
| Signatories | Only Alice | Alice AND Bob |
| State | Waiting for a response | Ready to execute |
| Who creates it | Alice | The ledger, when `Accept` runs |

Now that both signed, the `settler` (the Operator) can run the exchange.

### The atomic exchange: `Settle`

```daml
choice Settle : (ContractId Asset, ContractId Asset)
  controller settler
  do
    -- Leg 1: Alice's asset goes to Bob
    newAssetForCounterparty <- exercise offeredAssetCid Transfer
      with newOwner = counterparty

    -- Leg 2: Bob's asset goes to Alice
    newAssetForProposer <- exercise counterpartyAssetCid Transfer
      with newOwner = proposer

    return (newAssetForCounterparty, newAssetForProposer)
```

The key word here is **atomic**: both transfers happen inside **one single transaction** on the ledger. This means:

- Either both transfers complete → the swap happens.
- Or something fails → **neither** one happens.

There is no risk of Alice giving her asset but Bob not giving his.

### There is also `Abort`

If the Operator finds a problem (compliance issue, fraud, technical error), they can abort:

```daml
choice Abort : ()
  controller settler
  do return ()
```

The assets stay with their original owners, unchanged.

---

## 6. Full flow: from proposal to exchange

Here is the full flow step by step with Alice, Bob, and Operator:

```
Starting state:
  Alice has: Asset(symbol="TokenX", quantity=200, owner=Alice)
  Bob has:   Asset(symbol="TokenY", quantity=100, owner=Bob)

Step 1 — Alice creates a proposal:
  submit alice do
    createCmd SwapProposal with
      offeredAssetCid = tokenX
      requestedSymbol = "TokenY"
      requestedQuantity = 100.0
      settler = operator

  Ledger: SwapProposal(proposer=Alice, counterparty=Bob) ← lives here

Step 2 — Bob accepts, committing his TokenY:
  submit bob do
    exerciseCmd proposalCid Accept with
      counterpartyAssetCid = tokenY

  Ledger: SwapProposal is archived.
          SwapSettlement(proposer=Alice, counterparty=Bob) ← new contract

Step 3 — Operator runs the settlement:
  submit operator do
    exerciseCmd settlementCid Settle

  Inside Settle (in ONE single transaction):
    - TokenX(owner=Alice) is archived
    - TokenX(owner=Bob)   is created  ← Bob gets Alice's TokenX
    - TokenY(owner=Bob)   is archived
    - TokenY(owner=Alice) is created  ← Alice gets Bob's TokenY

Final state:
  Alice has: Asset(symbol="TokenY", quantity=100, owner=Alice)
  Bob has:   Asset(symbol="TokenX", quantity=200, owner=Bob)
```

---

## 7. The UTXO pattern: Split and Merge

UTXO stands for **Unspent Transaction Output**. It is the model used by Bitcoin, and Daml uses it too to handle assets that can be divided.

The idea is simple: **you do not modify an asset, you consume it and create new ones**.

### Split: dividing an asset

Imagine Alice has 500 TokenX but she only wants to exchange 200. She cannot "modify" her contract to change the amount (contracts cannot be changed once created). What she does is **consume it and create two new ones**:

```daml
choice Split : (ContractId Asset, ContractId Asset)
  with
    splitQuantity : Decimal
  controller owner
  do
    first  <- create this with quantity = splitQuantity         -- 200 TokenX
    second <- create this with quantity = quantity - splitQuantity -- 300 TokenX
    return (first, second)
```

```
Before:  [500 TokenX] (Alice)

After:   [200 TokenX] (Alice)   ← for the swap
         [300 TokenX] (Alice)   ← Alice keeps these
```

The original 500 contract is archived. Two new ones appear. No money is created out of nothing: 200 + 300 = 500.

### Merge: combining assets

The opposite: Alice has two TokenX contracts (for example, she received them at different times) and wants to join them into one:

```daml
choice Merge : ContractId Asset
  with
    otherCid : ContractId Asset
  controller owner
  do
    other <- fetch otherCid
    -- checks: same issuer, same symbol, same owner
    archive otherCid
    create this with quantity = quantity + other.quantity
```

```
Before:  [300 TokenX] (Alice)
         [200 TokenX] (Alice)

After:   [500 TokenX] (Alice)
```

---

## 8. The Batching pattern: `TransferRequest` and `TransferBatch`

So far we have seen how one individual swap works. But in a real system with many users at the same time, running each transfer separately is slow and expensive.

This section introduces two new contracts that solve that problem: **`TransferRequest`** and **`TransferBatch`**.

### The performance problem

Every time the Operator runs a `Settle`, they are doing **one transaction on the ledger**. One transaction takes about 1 second to confirm (the time for one "roundtrip" to the ledger). If there are 10 pending swaps:

```
Without batching:
  Settle(swap 1)  → 1 tx → ~1 second
  Settle(swap 2)  → 1 tx → ~1 second
  ...
  Settle(swap 10) → 1 tx → ~1 second
  Total: 10 transactions, ~10 seconds
```

The solution is to group multiple transfers into **one single transaction**. Instead of 10 roundtrips, we pay the cost of 1.

```
With batching:
  TransferBatch([transfer1, transfer2, ..., transfer10]) → 1 tx → ~1 second
  Total: 1 transaction, ~1 second
```

> Think of it like: the difference between making 10 separate trips to the supermarket (one item each time) versus going once with a list of 10 items.

### Separation of concerns (very important)

Before looking at the code, it is important to understand **why** batching lives in separate contracts from the settlement:

| Contract | Role | Who signs it | Level |
|----------|------|--------------|-------|
| `SwapSettlement` | The business agreement — "Alice and Bob want to exchange" | Alice + Bob | Business |
| `TransferRequest` | The execution permission — "Alice gives the Operator permission to move her asset" | Alice (or Bob) | Execution |
| `TransferBatch` | The performance tool — "Operator moves N assets in 1 transaction" | Operator | Performance |

The `SwapSettlement` represents the **agreement**. The `TransferBatch` represents the **optimized execution**. These are different things, and keeping them separate means each contract has one clear job.

### The `TransferRequest` contract

```daml
template TransferRequest
  with
    operator : Party            -- who will run the transfer
    owner    : Party            -- the current asset owner (who gives permission)
    newOwner : Party            -- the receiver
    assetCid : ContractId Asset -- the asset to transfer
  where
    signatory owner       -- ← the owner signs, giving the operator permission in advance
    observer operator, newOwner
```

The main idea: **the owner signs this contract when creating it**, giving the Operator permission to run the transfer later. Not now — later, possibly as part of a batch.

```daml
    choice ExecuteTransfer : ContractId Asset
      controller operator       -- the operator runs this whenever they want
      do
        exercise assetCid Transfer with newOwner
```

And if the owner changes their mind before the Operator runs it:

```daml
    choice CancelTransfer : ()
      controller owner
      do return ()
```

#### The permission chain (the most important technical detail)

Why can the Operator run `Asset.Transfer` if that choice has `controller owner`?

Here is the key — the permission **passes down** through the contracts:

```
Operator runs ExecuteTransfer (controller=operator)
    │
    │ ← We are now inside the TransferRequest context,
    │   which has signatory=owner (Alice).
    │   This puts Alice in the current permission context.
    ▼
exercise assetCid Transfer with newOwner
    │
    │ ← Asset.Transfer has controller=owner (Alice).
    │   Alice IS in the permission context (passed down from above).
    ▼
✅ Allowed
```

In simple words: when Alice signed the `TransferRequest`, she left her "signature in escrow". The Operator can "use" that signature inside the `ExecuteTransfer` context. This is Daml's **delegated authority model**.

### The `TransferBatch` contract

```daml
template TransferBatch
  with
    operator : Party
    requests : [ContractId TransferRequest]  -- list of transfers to run
  where
    signatory operator

    ensure length requests > 0  -- an empty batch makes no sense

    choice ExecuteTransfers : [ContractId Asset]
      controller operator
      do
        mapA (\reqCid -> exercise reqCid ExecuteTransfer) requests
```

`mapA` is the function that runs `ExecuteTransfer` on **each** `TransferRequest` in the list, inside the same transaction. It is like `Promise.all` in JavaScript, but on the ledger.

It also has an option to cancel without running:

```daml
    choice CancelBatch : ()
      controller operator
      do return ()
```

This is useful if the Operator finds a problem after creating the batch but before running it (for example, an asset was already consumed).

### The full flow with batching

```
Step 1 — The owner gives permission in advance:
  submit alice do
    createCmd TransferRequest with
      operator = operator
      owner    = alice
      newOwner = bob
      assetCid = tokenXCid

  submit bob do
    createCmd TransferRequest with
      operator = operator
      owner    = bob
      newOwner = charlie
      assetCid = tokenYCid

Step 2 — The Operator groups the requests:
  submit operator do
    createCmd TransferBatch with
      operator = operator
      requests = [reqAliceCid, reqBobCid]

Step 3 — The Operator runs everything in 1 single transaction:
  submit operator do
    exerciseCmd batchCid ExecuteTransfers

  Inside ExecuteTransfers (in 1 single tx):
    reqAliceCid.ExecuteTransfer → TokenX(owner=Alice) archived
                                   TokenX(owner=Bob)   created
    reqBobCid.ExecuteTransfer  → TokenY(owner=Bob)   archived
                                   TokenY(owner=Charlie) created

Final state: 2 transfers in 1 ledger roundtrip.
```

### The atomicity guarantee of the batch

Just like with individual settlement, the batch is also **atomic**. If any transfer in the batch fails, **none** of them run.

Example: if Bob's asset was already transferred before the batch runs (a race condition):

```
TransferBatch.ExecuteTransfers:
  ✅ ExecuteTransfer(reqAlice) → OK, TokenX transferred to Bob
  ❌ ExecuteTransfer(reqBob)   → FAILS, the asset was already consumed

Result: full ROLLBACK.
  - Alice's TokenX is still Alice's (not transferred)
  - The ledger is exactly as it was before the batch
```

The external system (the Temporal bot) is responsible for detecting this failure and handling the retry, for example by running each transfer individually as a fallback.

> **Golden rule**: The Daml ledger guarantees atomicity at the transaction level. The Operator does not need to write any rollback code — if something fails, the ledger undoes everything automatically.

### When to use `Settle` directly vs. `TransferBatch`?

| | `SwapSettlement.Settle` | `TransferBatch` |
|--|------------------------|-----------------|
| When to use | For 1 individual swap or during development | For high volumes of transfers |
| Ledger roundtrips | 1 per swap | 1 for N transfers |
| Failure scope | Only that swap fails | The whole batch fails |
| Use case | Tests, low-frequency scenarios | Production with bots and high load |

---

## 9. Important design decision: who signs what?

This is one of the most interesting design decisions in the project. It goes to the heart of how Daml handles permissions.

### The problem

In the `Asset` contract, the first idea would be to make **both the issuer and the owner signatories**:

```daml
-- ❌ First idea (NOT what we use)
signatory issuer, owner
```

This makes sense on the surface: both parties are involved. But it creates a problem when the Operator runs `Settle`.

When Settle calls `Transfer` to give Alice's TokenX to Bob, Daml needs to create a new contract with `owner = Bob`. If Bob were a signatory, the ledger would ask for Bob's signature at that moment. But Bob is not in the active transaction — he signed the `SwapSettlement` earlier.

The result: the transaction would fail with a permission error.

### The solution (the Daml Finance pattern)

The solution is to make **only the issuer a signatory** and keep the owner as an observer + controller:

```daml
-- ✅ What we use (Daml Finance pattern)
signatory issuer
observer owner :: observers
```

This works because:

1. When Settle runs, it is in the context of `SwapSettlement` (signed by Alice AND Bob).
2. When calling `Transfer` on Alice's TokenX, Alice's permission (as issuer) is already available in that context.
3. The new Asset only needs the `issuer`'s signature (Alice), which is already there.
4. Bob's signature as the new owner is not needed.

### What do we lose with this?

The owner has no formal obligations. In a more complex real system, you could use interfaces and accounts (the full Daml Finance model) to handle this. For our project, this decision is correct and is taken directly from how Daml Finance builds its `Holding` contracts.

> Conclusion: **The Daml permission model is strict and clear**. Every decision of "who signs what" has real consequences on what operations are possible. Understanding this is key to building correct contracts.

---

## 10. The tests: what we check and why

The tests are written using **Daml Script**, which is Daml's built-in testing tool. Each script is a scenario that simulates real transactions on a virtual ledger.

```bash
daml test   # runs all tests
```

### Structure of a test

```daml
test_happyPathSwap : Script ()
test_happyPathSwap = do
  -- 1. Set up: create parties and assets
  (alice, bob, operator) <- allocateParties
  tokenXCid <- issueAsset alice "TokenX" 200.0 [bob, operator]
  tokenYCid <- issueAsset bob   "TokenY" 100.0 [alice, operator]

  -- 2. Act: run the flow
  proposalCid   <- submit alice do createCmd SwapProposal with ...
  settlementCid <- submit bob do exerciseCmd proposalCid Accept with ...
  (xCid, yCid)  <- submit operator do exerciseCmd settlementCid Settle

  -- 3. Check: the final state is correct
  Some assetX <- queryContractId bob   xCid
  assertMsg "TokenX must belong to Bob" (assetX.owner == bob)
```

Each test follows the **Arrange → Act → Assert** pattern.

### The 14 tests and what they cover

| # | Test | Type | What it checks |
|---|------|------|----------------|
| 1 | `test_happyPathSwap` | Happy path | The full flow works and assets change owners |
| 2 | `test_rejectProposal` | Alternative | Bob can reject; the proposal disappears |
| 3 | `test_cancelProposal` | Alternative | Alice can cancel before Bob responds |
| 4 | `test_abortSettlement` | Alternative | The Operator can abort a pending settlement |
| 5 | `test_splitAndSwap` | UTXO | Alice can split an asset and only exchange part of it |
| 6 | `test_mergeAssets` | UTXO | Two assets with the same symbol can be combined |
| 7 | `test_unauthorizedAccept` | Permission | Eve cannot accept a proposal meant for Bob |
| 8 | `test_unauthorizedSettle` | Permission | Alice cannot run Settle (only the Operator can) |
| 9 | `test_unauthorizedCancel` | Permission | Bob cannot cancel Alice's proposal |
| 10 | `test_zeroQuantityAsset` | Rule check | You cannot create an asset with quantity 0 |
| 11 | `test_invalidSplit` | Rule check | You cannot split more than you have |
| 12 | `test_disclose` | Visibility | The owner can add observers to their asset |
| 13 | `test_batchTransfers` | Batching | N transfers in 1 single transaction; all assets reach their receivers |
| 14 | `test_batchPartialFailure` | Batching | If one transfer in the batch fails, the ledger rolls back everything — no asset moves |

### Why are the permission tests important?

Tests 7, 8, and 9 are especially important. They check that **nobody can do something that is not their role**. The ledger rejects these automatically, but it is good practice to write tests that confirm this behavior using `submitMustFail`:

```daml
-- This MUST fail. If it passes, the test fails.
submitMustFail eve do
  exerciseCmd proposalCid Accept with ...
```

This is equivalent to negative tests in any system: you do not just check that the right thing works, you also check that the wrong thing **does not** work.

### `allocateParties` and `issueAsset`: reusable helpers

Instead of repeating the setup in each test, the common logic was moved into helper functions:

```daml
allocateParties : Script (Party, Party, Party)
allocateParties = do
  alice    <- allocateParty "Alice"
  bob      <- allocateParty "Bob"
  operator <- allocateParty "Operator"
  return (alice, bob, operator)

issueAsset : Party -> Text -> Decimal -> [Party] -> Script (ContractId Asset)
issueAsset owner symbol qty obs =
  submit owner do
    createCmd Asset with
      issuer = owner, owner = owner, symbol = symbol
      quantity = qty, observers = obs
```

This is the same idea as in any programming language: do not repeat yourself, extract common logic into functions.

---

## 11. Why the project is split into two packages

This is an architecture decision that comes from a clear recommendation from the Daml compiler. Understanding it will help you structure real projects.

### The problem with mixing everything together

If you put contracts and tests in the same package, the `daml.yaml` needs `daml-script` as a dependency:

```yaml
# ❌ One single package (what we tried first)
dependencies:
  - daml-prim
  - daml-stdlib
  - daml-script   # ← needed for tests
```

The compiler warns:

> *"This package defines templates and depends on daml-script. Uploading this package to a ledger will also upload daml-script, which will bloat the package store on your participant."*

When you upload your contracts to a live ledger (in production), the ledger receives the DAR file (the compiled archive). If that DAR includes `daml-script`, you are uploading test code to the ledger that should never be there. It is like deploying your Jest test suite to the production server.

### The solution: two packages

```
daml-contracts/
├── multi-package.yaml           ← orchestrator
│
├── contracts/                   ← Package 1: pure contracts
│   ├── daml.yaml                (no daml-script)
│   └── daml/
│       ├── Asset.daml
│       ├── SwapProposal.daml
│       └── TransferBatch.daml
│
└── scripts/                     ← Package 2: tests and setup
    ├── daml.yaml                (with daml-script + depends on contracts DAR)
    └── daml/
        ├── Setup.daml
        └── Tests.daml
```

### How do they connect?

The `scripts` package lists the compiled DAR from `contracts` as a dependency:

```yaml
# scripts/daml.yaml
dependencies:
  - daml-prim
  - daml-stdlib
  - daml-script
  - ../contracts/.daml/dist/asset-swap-contracts-0.1.0.dar  ← imports the contracts
```

This means tests can use `Asset` and `SwapProposal` as if they were their own, but the contract code lives in a separate, clean package.

### The `multi-package.yaml`

This file tells Daml there are multiple related packages and what the build order should be:

```yaml
packages:
  - contracts   # compiled first
  - scripts     # compiled second (depends on the contracts DAR)
```

With this, one single command builds everything:

```bash
daml build --all   # compiles contracts, then scripts, in order
```

### Summary: what goes where in production

| File | Uploaded to the ledger in production | When it is used |
|------|--------------------------------------|-----------------|
| `asset-swap-contracts-0.1.0.dar` | ✅ Yes | Always; this is the code that lives on the ledger |
| `asset-swap-scripts-0.1.0.dar` | ❌ No | Only in development and CI/CD to run tests |

---

## Final recap

```
┌─────────────────────────────────────────────────────────┐
│  Asset                                                  │
│  ┌─────────────────────────────────────────────────┐   │
│  │  signatory: issuer                              │   │
│  │  observer:  owner, observers[]                  │   │
│  │                                                 │   │
│  │  choices: Transfer / Split / Merge / Disclose   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
     │ referenced by                 │ referenced by
     ▼                               ▼
┌───────────────────────┐   ┌─────────────────────────────────────────┐
│  SwapProposal         │   │  TransferRequest                        │
│  ─────────────────    │   │  ─────────────────────────────────────  │
│  signatory: proposer  │   │  signatory: owner  ← signature in escrow│
│  observer:            │   │  observer:  operator, newOwner          │
│    counterparty       │   │                                         │
│    settler            │   │  choices: ExecuteTransfer → operator    │
│                       │   │           CancelTransfer  → owner       │
│  choices: Accept →    │   └─────────────────────────────────────────┘
│    SwapSettlement     │            │ grouped into
│  Reject / Cancel      │            ▼
└───────────────────────┘   ┌─────────────────────────────────────────┐
     │ on accept, creates    │  TransferBatch                          │
     ▼                       │  ─────────────────────────────────────  │
┌───────────────────────┐   │  signatory: operator                    │
│  SwapSettlement       │   │                                         │
│  ─────────────────    │   │  choices: ExecuteTransfers →            │
│  signatory:           │   │    N transfers in 1 single tx           │
│    proposer           │   │  CancelBatch → drops the batch          │
│    counterparty       │   └─────────────────────────────────────────┘
│  observer: settler    │
│                       │   ┌─ Performance flow ──────────────────────┐
│  choices: Settle →    │   │                                         │
│    2 atomic legs      │   │  No batching:  N swaps = N roundtrips  │
│  Abort → no changes   │   │  With batching: N swaps = 1 roundtrip  │
└───────────────────────┘   └─────────────────────────────────────────┘
```

The four core patterns used in this project:

1. **Propose-Accept** — to get agreement from multiple parties before committing resources. Without the other party's signature, there is no deal.

2. **Atomic settlement** — to make sure a multi-leg exchange is all-or-nothing. There is no risk of only one party giving their asset.

3. **UTXO (Split/Merge)** — to work with partial amounts of an asset without changing existing contracts. Contracts cannot be changed; they are consumed and new ones are created.

4. **Batching** — to group N transfers into one single ledger transaction. The owner gives permission in advance with `TransferRequest`; the Operator groups and runs with `TransferBatch`. The ledger makes sure the batch is atomic: all transfers, or none.

These patterns are not invented for this project — they are the same ones used by Daml Finance, the official Digital Asset framework for financial systems in production.
