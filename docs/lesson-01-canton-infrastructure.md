# Lesson 01: Canton Multi-Node Infrastructure

## What is Canton?

Canton is the synchronization protocol for Daml smart contracts. It ensures that multiple parties running separate ledger nodes can agree on the state of shared contracts — without trusting a single central authority.

Canton consists of four types of nodes:

- **Sequencer** — Orders transactions. All participants submit their transactions through the sequencer, which assigns a global ordering.
- **Mediator** — Confirms transactions. The mediator validates that all required parties have approved a transaction before it's committed.
- **Participant** — Hosts parties and their contracts. Each participant runs the Daml engine, stores its own ledger, and exposes APIs for interacting with contracts.
- **Sync Domain** — The logical grouping of a sequencer + mediator that participants connect to. A sync domain is what enables cross-participant transactions.

## Single-Process Multi-Node

Canton supports running all nodes in a single OS process. This is the approach used in this project for development:

```
┌─────────────────────────────────────────────────────┐
│                  Canton Process                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐                         │
│  │sequencer1│  │mediator1 │  ← sync domain nodes    │
│  └──────────┘  └──────────┘                         │
│                                                      │
│  ┌────────────────┐  ┌────────────────┐             │
│  │  participant1   │  │  participant2   │             │
│  │  (Banco Rojo)   │  │  (Banco Azul)   │             │
│  │  ports: 5011-13 │  │  ports: 5021-23 │             │
│  └────────────────┘  └────────────────┘             │
└─────────────────────────────────────────────────────┘
```

Each node gets its own PostgreSQL database, even though they share one process. This maintains data isolation while simplifying the Docker Compose setup to just two containers: PostgreSQL and Canton.

## How the Bootstrap Works

Canton startup is a two-phase process:

### Phase 1: Node startup
The Canton process reads `topology.conf` (HOCON format) which defines all four nodes — their storage connections, API ports, and configuration. Then `nodes.local.start()` initializes each node.

### Phase 2: Domain bootstrap
The bootstrap script (`init.canton`) runs after nodes start:

```scala
// 1. Start all nodes
nodes.local.start()

// 2. Create the sync domain (links sequencer + mediator)
bootstrap.synchronizer(
  synchronizerName = "mysynchronizer",
  sequencers = Seq(sequencer1),
  mediators = Seq(mediator1),
  ...
)

// 3. Connect participants to the domain
participant1.synchronizers.connect_local(sequencer1, alias = "mysynchronizer")
participant2.synchronizers.connect_local(sequencer1, alias = "mysynchronizer")

// 4. Verify connectivity
participant1.health.ping(participant2)
```

After this, both participants can see each other and exchange transactions.

## Application Bootstrap (Post-Startup)

Once Canton is running, a separate TypeScript script (`bootstrap.ts`) sets up the application layer:

1. **DAR Upload** — The compiled Daml contracts (`.dar` file) are uploaded to both participants via `POST /v2/packages`. Each participant needs its own copy.

2. **Party Allocation** — Parties are allocated on specific participants:
   - `BancoRojo` on participant1
   - `BancoAzul` on participant2

3. **User Creation** — Users are created with specific permissions:
   - `trader-rojo` (canActAs BancoRojo) — can submit transactions
   - `supervisor-rojo` (canReadAs BancoRojo) — can read but not write
   - `bot-rojo` (canActAs BancoRojo) — for automated workflows

## Cross-Participant Visibility

The key feature that makes Canton useful for multi-bank scenarios: when a contract lists a party as an observer or signatory, that party can see the contract — even if the party is hosted on a different participant.

```
participant1 (Banco Rojo)              participant2 (Banco Azul)
┌──────────────────────┐              ┌──────────────────────┐
│  Creates Asset:       │              │                      │
│  issuer: BancoRojo    │     sync     │  Can query and see   │
│  owner: BancoRojo     │ ──domain──→  │  this Asset because  │
│  observers: [BancoAzul]│             │  BancoAzul is an     │
│                       │              │  observer             │
└──────────────────────┘              └──────────────────────┘
```

The sync domain handles propagation automatically — no explicit "grant" or "share" API call is needed.

## Key API Endpoints (Canton HTTP JSON API v2)

All interactions use the HTTP JSON API on ports 5013 (participant1) and 5023 (participant2):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v2/version` | GET | Health check / version info |
| `/v2/packages` | POST | Upload DAR (binary body) |
| `/v2/parties` | GET | List known parties |
| `/v2/parties` | POST | Allocate a new party |
| `/v2/users` | GET | List users |
| `/v2/users` | POST | Create user with rights |
| `/v2/commands/submit-and-wait-for-transaction` | POST | Submit Daml command |
| `/v2/state/active-contracts` | POST | Query active contracts |
| `/v2/state/ledger-end` | GET | Get current ledger offset |

### Template ID Format

Template IDs use the format `#<package-name>:<module>:<template>`:
```
#asset-swap-contracts:Asset:Asset
```

The `#` prefix tells Canton to resolve the package by name rather than by hash.

## Important Gotchas

### 1. Sequencer needs two databases
The sequencer node requires its own database AND a separate "driver" database. Using the same database for both causes Flyway migration conflicts.

### 2. TTY is required for bootstrap
Canton's console uses Ammonite REPL which needs `tty: true` and `stdin_open: true` in Docker Compose. Without these, the bootstrap script fails.

### 3. First startup is slow
Canton compiles Scala scripts on first run (~3-5 minutes). Subsequent starts are much faster due to caching.

### 4. Bootstrap output goes to console, not logs
The bootstrap script output goes to the interactive console (TTY), not to `docker logs`. Use HTTP API health checks to verify startup instead of log grep.

### 5. DAR upload uses binary content type
Upload DARs with `Content-Type: application/octet-stream` and the raw binary body — not multipart form data.

### 6. Active contracts require offset
The `/v2/state/active-contracts` endpoint requires an `activeAtOffset` field. Get the current offset from `/v2/state/ledger-end` first.

### 7. User creation requires all fields
The user creation API requires `id`, `primaryParty`, `isDeactivated`, and `identityProviderId` (even if empty string). Rights use a nested structure:
```json
{"kind": {"CanActAs": {"value": {"party": "BancoRojo::1220..."}}}}
```

## How to Verify Everything Works

```bash
# Start infrastructure
docker compose -f infra/docker-compose.yml up -d

# Wait for Canton (check both participants)
curl -s http://localhost:5013/v2/version
curl -s http://localhost:5023/v2/version

# Run application bootstrap
cd infra/scripts && npx tsx bootstrap.ts

# Run smoke test (creates contract, verifies cross-participant visibility)
npx tsx smoke-test.ts

# Clean up
docker compose -f infra/docker-compose.yml down -v
```

## File Structure

```
infra/
├── docker-compose.yml              # PostgreSQL + Canton
├── init-db.sql                     # 5 databases
├── canton/
│   ├── Dockerfile                  # Canton 3.4.11 image
│   ├── topology.conf               # 4 nodes: sequencer, mediator, 2 participants
│   └── bootstrap/
│       └── init.canton             # Domain creation + participant connection
├── scripts/
│   ├── package.json                # tsx, typescript
│   ├── tsconfig.json
│   ├── bootstrap.ts                # DAR upload, party allocation, user creation
│   └── smoke-test.ts               # Cross-participant contract test
└── README.md                       # Quick start guide
```
